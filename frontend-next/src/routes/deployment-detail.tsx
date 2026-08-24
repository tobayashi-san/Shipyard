import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, History, Pencil, Play, RefreshCw, Server, ShieldCheck, Trash2, TriangleAlert, Unlink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { VmFormDialog } from "@/features/deployments/VmFormDialog";
import { hasCap, useProfile } from "@/lib/queries";

interface PlanSummary { create?: number; update?: number; delete?: number; replace?: number; read?: number }
interface Run {
  id: string;
  action: string;
  status: string;
  plan_summary?: string | PlanSummary | null;
  plan_safe?: number | null;
  plan_validation?: string | null;
  started_at?: string;
  completed_at?: string;
}
interface Vm {
  id: string;
  name: string;
  environment_id: string;
  connection_id: string;
  node_name: string;
  vm_id?: number | null;
  started: boolean;
  cpu_cores: number;
  memory_mb: number;
  disk_size_gb: number;
  disk_datastore: string;
  bridge: string;
  vlan_id?: number | null;
  ipv4_address: string;
  platform?: { id: string; name: string; endpoint: string } | null;
  post_deploy?: { entries?: PostDeployEntry[]; counts?: Record<string, number> };
  pre_deploy_playbooks?: string[];
  pre_deploy_target_server_id?: string;
  [key: string]: unknown;
}
interface RunsResponse { items?: Run[]; pagination?: { total?: number } }
interface ActualResource { address?: string; status?: string; vm_id?: number; ip_addresses?: string[]; node_name?: string }
interface Overview { actual?: { available?: boolean; reason?: string; resources?: ActualResource[] } }
interface StateResponse { resources?: Array<{ address: string; type: string; name: string }>; error?: string }
interface PostDeployEntry { playbook: string; position: number; status?: string; output?: string; completed_at?: string | null }
interface LiveVm { available?: boolean; reason?: string; observed_at?: string; node_name?: string; vm_id?: number; cpu_cores?: number; memory_mb?: number; disk_size_gb?: number | null; bridge?: string | null; vlan_id?: number | null; ipv4_address?: string | null }

function parseSummary(value?: string | PlanSummary | null): PlanSummary {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value) as PlanSummary; } catch { return {}; }
}
function summaryLabel(value?: string | PlanSummary | null) {
  const summary = parseSummary(value);
  return `${summary.create || 0} create · ${summary.update || 0} update · ${summary.delete || 0} delete · ${summary.replace || 0} replace`;
}
function planValidationError(run?: Run) {
  if (!run?.plan_validation) return null;
  try { return (JSON.parse(run.plan_validation) as { error?: string }).error || null; } catch { return null; }
}
function statusTone(status?: string): StatusTone {
  if (status === "success") return "success";
  if (status === "running" || status === "cancelling") return "info";
  if (status === "failed" || status === "interrupted") return "danger";
  return "muted";
}
function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function DeploymentDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profileQuery = useProfile();
  const canEdit = hasCap(profileQuery.data, "canEditDeployments");
  const canPlan = hasCap(profileQuery.data, "canPlanDeployments");
  const canApply = hasCap(profileQuery.data, "canApplyDeployments");
  const canDestroy = hasCap(profileQuery.data, "canDestroyDeployments");
  const [editOpen, setEditOpen] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  const vmQuery = useQuery({ queryKey: ["opentofu", "vm", id], queryFn: () => apiFetch<Vm>(`/opentofu/vms/${encodeURIComponent(id)}`), refetchInterval: 5_000 });
  const runsQuery = useQuery({ queryKey: ["opentofu", "vm", id, "runs"], queryFn: () => apiFetch<RunsResponse>(`/opentofu/vms/${encodeURIComponent(id)}/runs?page_size=50`), refetchInterval: 3_000 });
  const actualQuery = useQuery({ queryKey: ["opentofu", "vm", id, "actual"], queryFn: () => apiFetch<Overview>(`/opentofu/vms/${encodeURIComponent(id)}/actual`), refetchInterval: 15_000 });
  const liveQuery = useQuery({ queryKey: ["opentofu", "vm", id, "live"], queryFn: () => apiFetch<LiveVm>(`/opentofu/vms/${encodeURIComponent(id)}/live`), refetchInterval: 15_000 });
  const stateQuery = useQuery({ queryKey: ["opentofu", "vm", id, "state"], queryFn: () => apiFetch<StateResponse>(`/opentofu/vms/${encodeURIComponent(id)}/state`), retry: false });
  const vm = vmQuery.data;
  const runs = Array.isArray(runsQuery.data?.items) ? runsQuery.data!.items! : [];
  const activeRun = runs.find((run) => run.status === "running" || run.status === "cancelling");
  const latestPlan = runs.find((run) => run.action === "plan" && run.status === "success");
  const approvedPlan = latestPlan?.plan_safe === 1 ? latestPlan : undefined;
  const actual = actualQuery.data?.actual?.resources?.[0];
  const live = liveQuery.data;
  const differences = vm && live?.available ? [
    vm.cpu_cores !== live.cpu_cores ? `CPU: desired ${vm.cpu_cores}, live ${live.cpu_cores ?? "—"}` : null,
    vm.memory_mb !== live.memory_mb ? `Memory: desired ${vm.memory_mb} MB, live ${live.memory_mb ?? "—"} MB` : null,
    live.disk_size_gb != null && vm.disk_size_gb !== live.disk_size_gb ? `Disk: desired ${vm.disk_size_gb} GB, live ${live.disk_size_gb} GB` : null,
    vm.bridge !== live.bridge ? `Bridge: desired ${vm.bridge}, live ${live.bridge || "—"}` : null,
    (vm.vlan_id || null) !== (live.vlan_id || null) ? `VLAN: desired ${vm.vlan_id || "none"}, live ${live.vlan_id || "none"}` : null,
    vm.ipv4_address !== "dhcp" && live.ipv4_address && vm.ipv4_address !== live.ipv4_address ? `IPv4: desired ${vm.ipv4_address}, live ${live.ipv4_address}` : null,
  ].filter((item): item is string => Boolean(item)) : [];

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["opentofu", "vm", id] });
  const runMutation = useMutation({
    mutationFn: (action: "plan" | "apply" | "check-drift") => apiFetch(`/opentofu/vms/${encodeURIComponent(id)}/${action}`, { method: "POST", body: action === "apply" ? { plan_id: approvedPlan?.id } : {} }),
    onSuccess: (_result, action) => { showToast(`${action === "check-drift" ? "Drift check" : action} started.`, "success"); refresh(); },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const destroyMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/vms/${encodeURIComponent(id)}/destroy`, { method: "POST", body: { confirmation: `DESTROY ${vm?.name}` } }),
    onSuccess: () => { setConfirmDestroy(false); showToast("VM destroy started.", "success"); refresh(); },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const forgetMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/vms/${encodeURIComponent(id)}/forget`, { method: "POST", body: { confirmation: `FORGET ${vm?.name}` } }),
    onSuccess: () => { showToast("VM removed from management. Proxmox infrastructure was kept.", "success"); void queryClient.invalidateQueries({ queryKey: ["opentofu", "vms"] }); void navigate({ to: "/deployments" }); },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const drift = useMemo(() => {
    const last = runs.find((run) => run.action === "drift" && run.status === "success");
    if (!last) return null;
    const summary = parseSummary(last.plan_summary);
    return (summary.create || 0) + (summary.update || 0) + (summary.delete || 0) + (summary.replace || 0) > 0;
  }, [runs]);

  if (vmQuery.isLoading) return <div className="space-y-2">{[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded bg-muted/40" />)}</div>;
  if (!vm) return <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Virtual machine not found" description="It may have been destroyed, unmanaged, or moved during a legacy migration." action={<Button asChild><Link to="/deployments">Back to VMs</Link></Button>} /></Card>;

  return <div className="space-y-5">
    <PageHeader title={vm.name} description={`Independent VM on ${vm.platform?.name || "Proxmox"}`} actions={<>
      <Button asChild variant="outline"><Link to="/deployments"><ArrowLeft />All VMs</Link></Button>
      <Button variant="outline" onClick={refresh}><RefreshCw />Refresh</Button>
      <Button variant="outline" onClick={() => setEditOpen(true)} disabled={!canEdit || Boolean(activeRun)}><Pencil />Edit</Button>
    </>} />

    <section className="grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" />Desired configuration</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-3 text-sm">
        <Fact label="Node" value={vm.node_name} /><Fact label="VM ID" value={vm.vm_id || "Automatic"} /><Fact label="CPU" value={`${vm.cpu_cores} cores`} /><Fact label="Memory" value={`${vm.memory_mb} MB`} /><Fact label="Disk" value={`${vm.disk_size_gb} GB`} /><Fact label="Network" value={`${vm.bridge}${vm.vlan_id ? ` · VLAN ${vm.vlan_id}` : ""}`} /><Fact label="IPv4" value={vm.ipv4_address} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" />Current Proxmox state</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        {live?.available ? <><Fact label="Node / VM ID" value={`${live.node_name || vm.node_name} · ${live.vm_id || vm.vm_id || "—"}`} /><Fact label="CPU / memory" value={`${live.cpu_cores ?? "—"} cores · ${live.memory_mb ?? "—"} MB`} /><Fact label="Disk" value={live.disk_size_gb ? `${live.disk_size_gb} GB` : "Not reported"} /><Fact label="Network" value={`${live.bridge || "—"}${live.vlan_id ? ` · VLAN ${live.vlan_id}` : ""}`} /><Fact label="IP addresses" value={actual?.ip_addresses?.join(", ") || live.ipv4_address || "Not reported"} /><Fact label="Observed" value={formatDate(live.observed_at)} /></> : <p className="text-muted-foreground">{live?.reason || (liveQuery.isLoading ? "Loading live configuration…" : actualQuery.data?.actual?.reason || "No deployed resource found.")}</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Isolation & drift</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <div><StatusBadge tone="success" dot>Independent state</StatusBadge><p className="mt-2 text-xs text-muted-foreground">Plans for this VM are rejected if they mutate any other resource address.</p></div>
        <Fact label="State resources" value={stateQuery.data?.resources?.length ?? "—"} />
        <Fact label="Live differences" value={differences.length ? differences.length : "None observed"} />
        {differences.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-700 dark:text-amber-300">{differences.map((difference) => <li key={difference}>{difference}</li>)}</ul>}
        <Fact label="Drift plan" value={drift === null ? "Not checked" : drift ? "Detected" : "None detected"} />
      </CardContent></Card>
    </section>

    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Play className="h-4 w-4" />Plan and deploy</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => runMutation.mutate("plan")} disabled={!canPlan || Boolean(activeRun) || runMutation.isPending}><Play />Plan changes</Button>
        <Button onClick={() => setConfirmApply(true)} disabled={!canApply || !approvedPlan || Boolean(activeRun) || runMutation.isPending}><CheckCircle2 />Apply reviewed plan</Button>
        <Button variant="outline" onClick={() => runMutation.mutate("check-drift")} disabled={!canPlan || Boolean(activeRun) || runMutation.isPending}><RefreshCw />Check drift</Button>
      </div>
      {approvedPlan ? <div className="rounded-md border bg-muted/20 p-3 text-sm"><div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-emerald-600" />Isolation check passed</div><p className="mt-1 text-muted-foreground">{summaryLabel(approvedPlan.plan_summary)}</p></div> : latestPlan?.plan_safe === 0 ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><div className="font-medium">Apply blocked by isolation check</div><p className="mt-1">{planValidationError(latestPlan) || "The plan affects resources outside this VM."}</p></div> : <p className="text-sm text-muted-foreground">Create a plan. Apply is enabled only after the saved plan passes the single-VM resource-address check.</p>}
    </CardContent></Card>

    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" />Run history</CardTitle></CardHeader><CardContent className="p-0">
      {runs.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No runs yet.</div> : <div className="table-scroll"><table data-density="compact" className="w-full min-w-[700px] text-sm"><thead><tr><th className="px-3">Action</th><th className="px-3">Status</th><th className="px-3">Plan</th><th className="px-3">Safety</th><th className="px-3">Completed</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td className="px-3 font-medium">{run.action}</td><td className="px-3"><StatusBadge tone={statusTone(run.status)} dot>{run.status}</StatusBadge></td><td className="px-3 text-xs">{run.plan_summary ? summaryLabel(run.plan_summary) : "—"}</td><td className="px-3">{run.action === "plan" ? <StatusBadge tone={run.plan_safe === 1 ? "success" : run.plan_safe === 0 ? "danger" : "muted"}>{run.plan_safe === 1 ? "Isolated" : run.plan_safe === 0 ? "Blocked" : "Pending"}</StatusBadge> : "—"}</td><td className="px-3 text-xs text-muted-foreground">{formatDate(run.completed_at || run.started_at)}</td></tr>)}</tbody></table></div>}
    </CardContent></Card>

    <Card><CardHeader><CardTitle className="text-base">Deployment automation</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><div className="text-sm font-medium">Before OpenTofu</div>{(vm.pre_deploy_playbooks || []).length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No pre-deploy workflows configured.</p> : <div className="mt-2 space-y-2">{vm.pre_deploy_playbooks!.map((playbook, index) => <div key={playbook} className="rounded-md border p-3 text-sm"><div className="font-medium">{index + 1}. {playbook}</div><div className="mt-0.5 text-xs text-muted-foreground">Target host: {vm.pre_deploy_target_server_id}</div></div>)}</div>}</div>
      <div className="border-t pt-4"><div className="text-sm font-medium">After deployment</div>
      {(vm.post_deploy?.entries || []).length === 0 ? <p className="text-sm text-muted-foreground">No post-deployment steps configured.</p> : <div className="space-y-2">{vm.post_deploy!.entries!.map((entry) => <div key={`${entry.position}-${entry.playbook}`} className="flex items-center justify-between rounded-md border p-3 text-sm"><div><div className="font-medium">{entry.position}. {entry.playbook}</div><div className="text-xs text-muted-foreground">{formatDate(entry.completed_at)}</div></div><StatusBadge tone={statusTone(entry.status)}>{entry.status || "pending"}</StatusBadge></div>)}</div>}
      </div>
    </CardContent></Card>

    <Card className="border-destructive/30"><CardHeader><CardTitle className="text-base">Lifecycle</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setConfirmForget(true)} disabled={!canEdit || Boolean(activeRun)}><Unlink />Stop managing</Button>
      <Button variant="destructive" onClick={() => setConfirmDestroy(true)} disabled={!canDestroy || Boolean(activeRun)}><Trash2 />Destroy VM</Button>
    </CardContent></Card>

    <VmFormDialog vmId={vm.id} environmentId={vm.environment_id} connectionId={vm.connection_id} initialVm={vm} open={editOpen} onOpenChange={setEditOpen} />
    <ConfirmDialog open={confirmApply} onOpenChange={setConfirmApply} title="Apply reviewed VM plan?" description={approvedPlan ? `OpenTofu will apply only the saved, isolation-checked plan for ${vm.name}: ${summaryLabel(approvedPlan.plan_summary)}.` : "No safe reviewed plan is available."} confirmLabel="Apply plan" onConfirm={() => { setConfirmApply(false); runMutation.mutate("apply"); }} isPending={runMutation.isPending} />
    <ConfirmDialog open={confirmDestroy} onOpenChange={setConfirmDestroy} title="Destroy VM in Proxmox?" description="OpenTofu will destroy only this VM from its independent state. Other VMs cannot be part of this plan." confirmLabel="Destroy VM" variant="destructive" confirmTextValue={`DESTROY ${vm.name}`} confirmInputHelp={<>Enter <code className="font-mono">DESTROY {vm.name}</code>.</>} onConfirm={() => destroyMutation.mutate()} isPending={destroyMutation.isPending} />
    <ConfirmDialog open={confirmForget} onOpenChange={setConfirmForget} title="Stop managing this VM?" description="Shipyard removes the VM from OpenTofu state and management. The existing VM remains unchanged in Proxmox." confirmLabel="Stop managing" variant="warning" confirmTextValue={`FORGET ${vm.name}`} confirmInputHelp={<>Enter <code className="font-mono">FORGET {vm.name}</code>.</>} onConfirm={() => forgetMutation.mutate()} isPending={forgetMutation.isPending} />
  </div>;
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 font-medium">{value}</div></div>;
}
