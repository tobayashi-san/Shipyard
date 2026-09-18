import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUrlTab } from '@/lib/use-url-tab';
import { isActiveRunStatus, runActionLabel, runStatusLabel, runDurationLabel, runIsolationLabel } from "@/features/deployments/run-status";
import { driftResultLabel, parsePlanSummary as parseSummary, planSummaryLabel as summaryLabel, type PlanSummary } from "@/features/deployments/plan-summary";
import { RunDetailsDialog } from '@/features/deployments/RunDetailsDialog';
import { Timestamp } from '@/components/ui/timestamp';
import { platformInventoryId } from '@/lib/platform-inventory-id';
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, History, Pencil, Play, RefreshCw, RotateCcw, Server, ShieldCheck, Trash2, TriangleAlert, Unlink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, type PageHeaderProps } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { VmFormDialog } from "@/features/deployments/VmFormDialog";
import { hasCap, useProfile } from "@/lib/queries";
import { formatDateTime } from "@/lib/utils";


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
interface RunsResponse { items?: Run[]; pagination?: { total?: number; page?: number; total_pages?: number; has_next?: boolean; has_prev?: boolean } }
interface ActualResource { address?: string; status?: string; vm_id?: number; ip_addresses?: string[]; node_name?: string }
interface Overview { actual?: { available?: boolean; reason?: string; resources?: ActualResource[] } }
interface StateResponse { resources?: Array<{ address: string; type: string; name: string }>; error?: string }
interface StateBackup { name: string; created_at: string; size: number }
interface StateBackupsResponse { items?: StateBackup[] }
interface StateSafety { backend?: string; mode?: 'remote' | 'encrypted-backup' | 'unsafe'; locking?: boolean; backups?: number | null }
interface PostDeployEntry { playbook: string; position: number; status?: string; output?: string; completed_at?: string | null }
interface LiveVm { available?: boolean; reason?: string; observed_at?: string; node_name?: string; vm_id?: number; cpu_cores?: number; memory_mb?: number; disk_size_gb?: number | null; bridge?: string | null; vlan_id?: number | null; ipv4_address?: string | null }

function planValidationError(run?: Run) {
  if (!run?.plan_validation) return null;
  try { return (JSON.parse(run.plan_validation) as { error?: string }).error || null; } catch { return null; }
}
function statusTone(status?: string): StatusTone {
  if (status === "success") return "success";
  if (isActiveRunStatus(status)) return "info";
  if (status === "failed" || status === "interrupted") return "danger";
  return "muted";
}
function formatDate(value?: string | null) {
  return formatDateTime(value);
}

function DefinitionHeader({embedded, ...props}: PageHeaderProps & {embedded: boolean}) {
  if (!embedded) return <PageHeader {...props} />;
  return <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{props.title}</h2><div className="flex flex-wrap gap-2">{props.actions}</div></div>;
}

export function DeploymentDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <DeploymentDefinition id={id} />;
}

export function DeploymentDefinition({id, embedded = false, section}: {id: string; embedded?: boolean; section?: "overview" | "configuration" | "jobs"}) {
  const definitionTabs = useUrlTab("overview", ["overview", "configuration", "jobs"], "definitionTab");
  const activeSection = section || (embedded ? "configuration" : definitionTabs.value);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profileQuery = useProfile();
  const canEdit = hasCap(profileQuery.data, "canEditDeployments");
  const canPlan = hasCap(profileQuery.data, "canPlanDeployments");
  const canApply = hasCap(profileQuery.data, "canApplyDeployments");
  const canDestroy = hasCap(profileQuery.data, "canDestroyDeployments");
  const [historyPosition, setHistoryPosition] = useState({ vmId: id, page: 1 });
  const historyPage = historyPosition.vmId === id ? historyPosition.page : 1;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState("");

  const vmQuery = useQuery({ queryKey: ["opentofu", "vm", id], queryFn: () => apiFetch<Vm>(`/opentofu/vms/${encodeURIComponent(id)}`), refetchInterval: 5_000 });
  const runsQuery = useQuery({ queryKey: ["opentofu", "vm", id, "runs"], queryFn: () => apiFetch<RunsResponse>(`/opentofu/vms/${encodeURIComponent(id)}/runs?page_size=50`), refetchInterval: 3_000 });
  const olderRunsQuery = useQuery({
    queryKey: ["opentofu", "vm", id, "runs", historyPage],
    queryFn: () => apiFetch<RunsResponse>(`/opentofu/vms/${encodeURIComponent(id)}/runs?page_size=50&page=${historyPage}`),
    enabled: historyPage > 1,
  });
  const historyQuery = historyPage === 1 ? runsQuery : olderRunsQuery;
  const historyRuns = Array.isArray(historyQuery.data?.items) ? historyQuery.data.items : [];
  const actualQuery = useQuery({ queryKey: ["opentofu", "vm", id, "actual"], queryFn: () => apiFetch<Overview>(`/opentofu/vms/${encodeURIComponent(id)}/actual`), refetchInterval: 15_000 });
  const liveQuery = useQuery({ queryKey: ["opentofu", "vm", id, "live"], queryFn: () => apiFetch<LiveVm>(`/opentofu/vms/${encodeURIComponent(id)}/live`), refetchInterval: 15_000 });
  const stateQuery = useQuery({ queryKey: ["opentofu", "vm", id, "state"], queryFn: () => apiFetch<StateResponse>(`/opentofu/vms/${encodeURIComponent(id)}/state`), retry: false });
  const stateSafetyQuery = useQuery({ queryKey: ["opentofu", "vm", id, "state-safety"], queryFn: () => apiFetch<StateSafety>(`/opentofu/vms/${encodeURIComponent(id)}/state-safety`), retry: false });
  const stateBackupsQuery = useQuery({ queryKey: ["opentofu", "vm", id, "state-backups"], queryFn: () => apiFetch<StateBackupsResponse>(`/opentofu/vms/${encodeURIComponent(id)}/state-backups`), retry: false });
  const vm = vmQuery.data;
  const runs = Array.isArray(runsQuery.data?.items) ? runsQuery.data!.items! : [];
  const activeRun = runs.find((run) => isActiveRunStatus(run.status));
  const latestFinishedRun = runs.find(run => !isActiveRunStatus(run.status));
  useEffect(() => {
    if (!latestFinishedRun?.id) return;
    for (const section of ['state', 'state-safety', 'state-backups', 'actual', 'live']) {
      void queryClient.invalidateQueries({queryKey:['opentofu','vm',id,section]});
    }
  }, [id, latestFinishedRun?.id, latestFinishedRun?.status, queryClient]);
  const runStateUnavailable = runsQuery.isPending || runsQuery.isError;
  const latestPlan = runs.find((run) => run.action === "plan" && run.status === "success");
  const approvedPlan = latestPlan?.plan_safe === 1 && parseSummary(latestPlan.plan_summary) ? latestPlan : undefined;
  const actual = actualQuery.data?.actual?.resources?.[0];
  const live = liveQuery.data;
  const differences = vm && live?.available ? [
    live.cpu_cores != null && vm.cpu_cores !== live.cpu_cores ? `CPU: desired ${vm.cpu_cores}, live ${live.cpu_cores ?? "—"}` : null,
    live.memory_mb != null && vm.memory_mb !== live.memory_mb ? `Memory: desired ${vm.memory_mb} MB, live ${live.memory_mb ?? "—"} MB` : null,
    live.disk_size_gb != null && vm.disk_size_gb !== live.disk_size_gb ? `Disk: desired ${vm.disk_size_gb} GB, live ${live.disk_size_gb} GB` : null,
    live.bridge != null && vm.bridge !== live.bridge ? `Bridge: desired ${vm.bridge}, live ${live.bridge || "—"}` : null,
    live.vlan_id !== undefined && (vm.vlan_id || null) !== (live.vlan_id || null) ? `VLAN: desired ${vm.vlan_id || "none"}, live ${live.vlan_id || "none"}` : null,
    vm.ipv4_address !== "dhcp" && live.ipv4_address && vm.ipv4_address !== live.ipv4_address ? `IPv4: desired ${vm.ipv4_address}, live ${live.ipv4_address}` : null,
  ].filter((item): item is string => Boolean(item)) : [];

  const incompleteLiveComparison = Boolean(live?.available && (live.cpu_cores == null || live.memory_mb == null || live.disk_size_gb == null || live.bridge == null || live.vlan_id === undefined || (vm?.ipv4_address !== "dhcp" && !live.ipv4_address)));

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
  const restoreStateMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/vms/${encodeURIComponent(id)}/state-backups/restore`, { method: 'POST', body: { backup: selectedBackup, confirmation: `RESTORE STATE ${vm?.name}` } }),
    onSuccess: () => { setConfirmRestore(false); showToast('OpenTofu state restored. Create a new plan and compare it with Proxmox before applying.', 'success'); refresh(); void stateBackupsQuery.refetch(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  if (vmQuery.isLoading) return <div className="space-y-2">{[0, 1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded bg-muted/40" />)}</div>;
  if (vmQuery.isError) return <Card><QueryErrorState error={vmQuery.error} title="Managed VM could not be loaded" onRetry={() => void vmQuery.refetch()} /></Card>;
  if (!vm) return <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="VM definition not found" description="It may have been destroyed, unmanaged, or moved during a legacy migration." action={<Button asChild><Link to="/deployments">Back to VM definitions</Link></Button>} /></Card>;

  const inventoryClusterId = platformInventoryId(vm.platform?.endpoint);
  const inventoryNode = live?.node_name || vm.node_name;
  const inventoryVmId = live?.vm_id || actual?.vm_id;

  if (!embedded && live?.available && inventoryClusterId && inventoryNode && inventoryVmId && hasCap(profileQuery.data, 'canViewInfrastructure')) return <Navigate to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId" params={{clusterId: inventoryClusterId, nodeName: inventoryNode, vmId: String(inventoryVmId)}} hash="tab=configuration" replace />;
  return <div className="space-y-5">
    <RunDetailsDialog vmId={id} runId={selectedRunId} open={Boolean(selectedRunId)} onOpenChange={open => { if (!open) setSelectedRunId(null); }} />
    {activeSection !== "jobs" && <DefinitionHeader embedded={embedded} title={embedded ? "Deployment definition" : vm.name} description={embedded ? undefined : vm.node_name} actions={<>
      {!embedded && live?.available && inventoryClusterId && inventoryNode && inventoryVmId && hasCap(profileQuery.data, "canViewInfrastructure") && <Button asChild variant="outline"><Link to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId" params={{clusterId:inventoryClusterId,nodeName:inventoryNode,vmId:String(inventoryVmId)}}>Open inventory VM</Link></Button>}
      {!embedded && <Button asChild variant="outline"><Link to="/infrastructure"><ArrowLeft />Infrastructure</Link></Button>}
      <Button variant="outline" onClick={refresh}><RefreshCw />Refresh</Button>
      <Button variant="outline" onClick={() => setEditOpen(true)} disabled={!canEdit || Boolean(activeRun) || runStateUnavailable}><Pencil />Edit</Button>
    </>} />}
    {!embedded && <Tabs value={activeSection} onValueChange={definitionTabs.onValueChange}><TabsList className="console-tabs"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="configuration">Configuration</TabsTrigger><TabsTrigger value="jobs">Jobs</TabsTrigger></TabsList></Tabs>}

    {activeSection !== "jobs" && <section className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" />Desired configuration</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-3 text-sm">
        <Fact label="Node" value={vm.node_name} /><Fact label="VM ID" value={vm.vm_id || "Automatic"} /><Fact label="CPU" value={`${vm.cpu_cores} cores`} /><Fact label="Memory" value={`${vm.memory_mb} MB`} /><Fact label="Disk" value={`${vm.disk_size_gb} GB`} /><Fact label="Network" value={`${vm.bridge}${vm.vlan_id ? ` · VLAN ${vm.vlan_id}` : ""}`} /><Fact label="IPv4" value={vm.ipv4_address} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" />Current Proxmox state</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        {liveQuery.isError || actualQuery.isError ? <QueryErrorState compact error={liveQuery.error || actualQuery.error} title="Current Proxmox state could not be loaded" onRetry={() => void Promise.all([liveQuery.refetch(), actualQuery.refetch()])} /> : live?.available ? <><Fact label="Node / VM ID" value={`${live.node_name || vm.node_name} · ${live.vm_id || vm.vm_id || "—"}`} /><Fact label="CPU / memory" value={`${live.cpu_cores ?? "—"} cores · ${live.memory_mb ?? "—"} MB`} /><Fact label="Disk" value={live.disk_size_gb ? `${live.disk_size_gb} GB` : "Not reported"} /><Fact label="Network" value={`${live.bridge || "—"}${live.vlan_id ? ` · VLAN ${live.vlan_id}` : ""}`} /><Fact label="IP addresses" value={actual?.ip_addresses?.join(", ") || live.ipv4_address || "Not reported"} /><Fact label="Observed" value={formatDate(live.observed_at)} /></> : <p className="text-muted-foreground">{live?.reason || (liveQuery.isLoading ? "Loading live configuration…" : actualQuery.data?.actual?.reason || "No deployed resource found.")}</p>}
      </CardContent></Card>
    </section>}

    {activeSection === "configuration" && <>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Play className="h-4 w-4" />Plan and deploy</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant={approvedPlan ? "outline" : "default"} onClick={() => runMutation.mutate("plan")} disabled={!canPlan || Boolean(activeRun) || runStateUnavailable || runMutation.isPending}><Play />Plan changes</Button>
        <Button onClick={() => setConfirmApply(true)} disabled={!canApply || !approvedPlan || Boolean(activeRun) || runStateUnavailable || runMutation.isPending}><CheckCircle2 />Apply reviewed plan</Button>
        <Button variant="outline" onClick={() => runMutation.mutate("check-drift")} disabled={!canPlan || Boolean(activeRun) || runStateUnavailable || runMutation.isPending}><RefreshCw />Check drift</Button>
      </div>
      {activeRun && <p className="rounded-md border bg-muted/20 p-3 text-sm">{runActionLabel(activeRun.action)}: {runStatusLabel(activeRun.status)}. Editing and lifecycle actions are unavailable until this run finishes. <Button variant="link" size="sm" onClick={() => setSelectedRunId(activeRun.id)}>View active run</Button></p>}
      {approvedPlan ? <div className="rounded-md border bg-muted/20 p-3 text-sm"><div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-emerald-600" />Isolation check passed</div><p className="mt-1 text-muted-foreground">{summaryLabel(approvedPlan.plan_summary)}</p></div> : latestPlan?.plan_safe === 0 ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><div className="font-medium">Apply blocked by isolation check</div><p className="mt-1">{planValidationError(latestPlan) || "The plan affects resources outside this VM."}</p></div> : latestPlan?.plan_safe === 1 ? <p className="text-sm text-destructive">Apply blocked: the saved plan summary is missing or invalid. Review the run logs and create a new plan.</p> : <p className="text-sm text-muted-foreground">Create a plan. Review the result before applying changes.</p>}
    </CardContent></Card>

    <details className="space-y-4 rounded-md border p-4"><summary className="cursor-pointer font-medium">Advanced</summary>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Isolation & drift</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        {stateQuery.isPending ? <p role="status" className="text-muted-foreground">Loading independent VM state…</p> : stateQuery.isError || stateQuery.data?.error ? <QueryErrorState compact error={stateQuery.error || new Error(stateQuery.data?.error)} title="Independent VM state could not be loaded" onRetry={() => void stateQuery.refetch()} /> : <><div><StatusBadge tone="success" dot>Independent state</StatusBadge><p className="mt-2 text-xs text-muted-foreground">Plans for this VM are rejected if they mutate any other resource address.</p></div>
        <Fact label="State resources" value={stateQuery.data?.resources?.length ?? "—"} />
        <Fact label="Live differences" value={liveQuery.isError ? "Live check failed" : liveQuery.isPending ? "Loading live configuration…" : !live?.available ? "Live configuration unavailable" : differences.length ? `${differences.length}${incompleteLiveComparison ? " · incomplete data" : ""}` : incompleteLiveComparison ? "Incomplete live data; comparison partial" : "None observed"} />
        {!liveQuery.isError && live?.available && differences.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-700 dark:text-amber-300">{differences.map((difference) => <li key={difference}>{difference}</li>)}</ul>}
        <Fact label="Drift plan" value={runsQuery.isError ? "Run history unavailable" : runsQuery.isPending ? "Loading run history…" : driftResultLabel(runs)} /></>}
      </CardContent></Card>

    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><RotateCcw className="h-4 w-4" />OpenTofu state recovery</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
      {stateSafetyQuery.isError || stateBackupsQuery.isError ? <QueryErrorState compact error={stateSafetyQuery.error || stateBackupsQuery.error} title="State recovery information could not be loaded" onRetry={() => void Promise.all([stateSafetyQuery.refetch(), stateBackupsQuery.refetch()])} /> : <>
        <div className="flex flex-wrap gap-2"><StatusBadge tone={stateSafetyQuery.data?.mode === 'encrypted-backup' ? 'success' : stateSafetyQuery.data?.mode === 'remote' ? 'info' : 'muted'}>{stateSafetyQuery.data?.mode === 'remote' ? `Remote ${stateSafetyQuery.data.backend || ''} backend` : stateSafetyQuery.data?.mode === 'encrypted-backup' ? 'Encrypted local backups' : stateSafetyQuery.isPending ? 'Loading recovery status…' : 'Recovery status unavailable'}</StatusBadge>{stateSafetyQuery.data?.mode === 'remote' && <span className="text-xs text-muted-foreground">Restore state through the configured backend.</span>}</div>
        <details><summary className="cursor-pointer py-2 font-medium">Recovery options</summary>
      <p className="text-muted-foreground">Encrypted state backups protect Shipyard's management state. Restoring one does not roll back the VM in Proxmox; create a new plan afterwards and review the difference before applying.</p>
        {stateSafetyQuery.data?.mode === 'encrypted-backup' && <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 w-full flex-1"><span className="mb-1 block text-xs font-medium">Recovery point</span><select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedBackup} onChange={event => setSelectedBackup(event.target.value)}><option value="">Select an encrypted backup</option>{(stateBackupsQuery.data?.items || []).map(backup => <option key={backup.name} value={backup.name}>{formatDate(backup.created_at)} · {(backup.size / 1024).toFixed(1)} KiB</option>)}</select></label><Button variant="outline" disabled={!canDestroy || !selectedBackup || Boolean(activeRun) || runStateUnavailable} onClick={() => setConfirmRestore(true)}><RotateCcw />Restore state</Button></div>}
        {stateSafetyQuery.data?.mode === 'encrypted-backup' && !stateBackupsQuery.isPending && (stateBackupsQuery.data?.items || []).length === 0 && <p className="text-xs text-muted-foreground">No state backup exists yet. Shipyard creates one before a state-changing apply when local state is present.</p>}
        </details>
      </>}
    </CardContent></Card>

    </details>
    </>}
    {activeSection === "jobs" && <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" />Run history</CardTitle></CardHeader><CardContent className="p-0">
      {historyQuery.isPending ? <div className="p-4 text-sm text-muted-foreground">Loading run history…</div> : historyQuery.isError ? <QueryErrorState compact error={historyQuery.error} title="VM run history could not be loaded" onRetry={() => void historyQuery.refetch()} /> : historyRuns.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No runs yet.</div>  : <><div className="divide-y md:hidden">{historyRuns.map(run => <article key={run.id} className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3"><span className="font-medium">{runActionLabel(run.action)}</span><StatusBadge tone={statusTone(run.status)} dot>{runStatusLabel(run.status)}</StatusBadge></div>
        <dl className="space-y-2 text-xs"><div><dt className="text-muted-foreground">Started</dt><dd><Timestamp value={run.started_at} /></dd></div><div><dt className="text-muted-foreground">Completed</dt><dd><Timestamp value={run.completed_at} /></dd></div><div><dt className="text-muted-foreground">Duration</dt><dd>{runDurationLabel(run)}</dd></div>
        {run.plan_summary && <div><dt className="text-muted-foreground">Plan</dt><dd>{summaryLabel(run.plan_summary)}</dd></div>}
        {run.action === "plan" && <div><dt className="text-muted-foreground">Isolation check</dt><dd>{runIsolationLabel(run)}</dd></div>}</dl>
        <Button variant="outline" size="sm" onClick={() => setSelectedRunId(run.id)}>View logs</Button>
      </article>)}</div><div className="table-scroll hidden md:block"><table data-density="compact" className="w-full min-w-[700px] text-sm"><thead><tr><th className="px-3">Action</th><th className="px-3">Status</th><th className="px-3">Plan</th><th className="px-3">Isolation check</th><th className="px-3">Started</th><th className="px-3">Completed</th><th className="px-3">Duration</th><th className="px-3">Details</th></tr></thead><tbody>{historyRuns.map((run) => <tr key={run.id}><td className="px-3 font-medium">{runActionLabel(run.action)}</td><td className="px-3"><StatusBadge tone={statusTone(run.status)} dot>{runStatusLabel(run.status)}</StatusBadge></td><td className="px-3 text-xs">{run.plan_summary ? summaryLabel(run.plan_summary) : "—"}</td><td className="px-3">{run.action === "plan" ? <StatusBadge tone={run.plan_safe === 1 ? "success" : run.plan_safe === 0 ? "danger" : "muted"}>{runIsolationLabel(run)}</StatusBadge> : "—"}</td><td className="px-3 text-xs text-muted-foreground"><Timestamp value={run.started_at} /></td><td className="px-3 text-xs text-muted-foreground"><Timestamp value={run.completed_at} /></td><td className="px-3 text-xs text-muted-foreground">{runDurationLabel(run)}</td><td className="px-3"><Button variant="outline" size="sm" onClick={() => setSelectedRunId(run.id)}>View logs</Button></td></tr>)}</tbody></table></div></>}
    </CardContent>{(historyRuns.length > 0 || historyPage > 1) && <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
      <span>Page {historyQuery.data?.pagination?.page || historyPage} of {historyQuery.data?.pagination?.total_pages || "—"} · {historyQuery.data?.pagination?.total ?? "—"} runs</span>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={historyPage <= 1} onClick={() => setHistoryPosition({vmId:id,page:historyPage-1})}>Newer runs</Button><Button variant="outline" size="sm" disabled={historyQuery.isPending || historyQuery.isError || !historyQuery.data?.pagination?.has_next} onClick={() => setHistoryPosition({vmId:id,page:historyPage+1})}>Older runs</Button></div>
    </div>}</Card>}

    {activeSection === "configuration" && <>
    <Card><CardHeader><CardTitle className="text-base">Deployment automation</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><div className="text-sm font-medium">Before OpenTofu</div>{(vm.pre_deploy_playbooks || []).length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No pre-deploy workflows configured.</p> : <div className="mt-2 space-y-2">{vm.pre_deploy_playbooks!.map((playbook, index) => <div key={playbook} className="rounded-md border p-3 text-sm"><div className="font-medium">{index + 1}. {playbook}</div><div className="mt-0.5 text-xs text-muted-foreground">Target host: {vm.pre_deploy_target_server_id}</div></div>)}</div>}</div>
      <div className="border-t pt-4"><div className="text-sm font-medium">After deployment</div>
      {(vm.post_deploy?.entries || []).length === 0 ? <p className="text-sm text-muted-foreground">No post-deployment steps configured.</p> : <div className="space-y-2">{vm.post_deploy!.entries!.map((entry) => <div key={`${entry.position}-${entry.playbook}`} className="flex items-center justify-between rounded-md border p-3 text-sm"><div><div className="font-medium">{entry.position}. {entry.playbook}</div><div className="text-xs text-muted-foreground">{formatDate(entry.completed_at)}</div></div><StatusBadge tone={statusTone(entry.status)}>{entry.status || "pending"}</StatusBadge></div>)}</div>}
      </div>
    </CardContent></Card>

    <details className="rounded-md border p-4"><summary className="cursor-pointer text-sm">More actions</summary><Card className="border-destructive/30"><CardHeader><CardTitle className="text-base">Lifecycle</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setConfirmForget(true)} disabled={!canEdit || Boolean(activeRun) || runStateUnavailable}><Unlink />Stop managing</Button>
      <Button variant="destructive" onClick={() => setConfirmDestroy(true)} disabled={!canDestroy || Boolean(activeRun) || runStateUnavailable}><Trash2 />Destroy VM</Button>
    </CardContent></Card>

    </details>
    </>}
    <VmFormDialog vmId={vm.id} environmentId={vm.environment_id} connectionId={vm.connection_id} initialVm={vm} open={editOpen} onOpenChange={setEditOpen} />
    <ConfirmDialog open={confirmApply} onOpenChange={setConfirmApply} title="Apply reviewed VM plan?" description={approvedPlan ? `OpenTofu will apply only the saved, isolation-checked plan for ${vm.name}: ${summaryLabel(approvedPlan.plan_summary)}.` : "No safe reviewed plan is available."} confirmLabel="Apply plan" onConfirm={() => { setConfirmApply(false); runMutation.mutate("apply"); }} isPending={runMutation.isPending} />
    <ConfirmDialog open={confirmDestroy} onOpenChange={setConfirmDestroy} title="Destroy VM in Proxmox?" description="OpenTofu will destroy only this VM from its independent state. Other VMs cannot be part of this plan." confirmLabel="Destroy VM" variant="destructive" confirmTextValue={`DESTROY ${vm.name}`} confirmInputHelp={<>Enter <code className="font-mono">DESTROY {vm.name}</code>.</>} onConfirm={() => destroyMutation.mutate()} isPending={destroyMutation.isPending} />
    <ConfirmDialog open={confirmForget} onOpenChange={setConfirmForget} title="Stop managing this VM?" description="Shipyard removes the VM from OpenTofu state and management. The existing VM remains unchanged in Proxmox." confirmLabel="Stop managing" variant="warning" confirmTextValue={`FORGET ${vm.name}`} confirmInputHelp={<>Enter <code className="font-mono">FORGET {vm.name}</code>.</>} onConfirm={() => forgetMutation.mutate()} isPending={forgetMutation.isPending} />
    <ConfirmDialog open={confirmRestore} onOpenChange={setConfirmRestore} title="Restore OpenTofu state?" description="This replaces Shipyard's current management state with the selected encrypted backup. It does not change the VM in Proxmox. Create and review a new plan immediately afterwards." confirmLabel="Restore state" variant="warning" confirmTextValue={`RESTORE STATE ${vm.name}`} confirmInputHelp={<>Enter <code className="font-mono">RESTORE STATE {vm.name}</code>.</>} onConfirm={() => restoreStateMutation.mutate()} isPending={restoreStateMutation.isPending} />
  </div>;
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 font-medium">{value}</div></div>;
}
