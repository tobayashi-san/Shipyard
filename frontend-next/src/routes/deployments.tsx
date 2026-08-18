import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Server, TriangleAlert, Workflow } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { CreateDeploymentDialog } from "@/features/deployments/CreateDeploymentDialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";

interface Run {
  id: string;
  action?: string;
  status?: string;
  plan_summary?: string | null;
  started_at?: string;
  completed_at?: string;
}
interface ManagedVm {
  id: string;
  name: string;
  node_name?: string;
  vm_id?: number | string | null;
  started?: boolean;
  platform?: { id: string; name: string; endpoint: string } | null;
  last_run?: Run | null;
}
interface LegacyWorkspace { id: string; name: string; vm_count: number; migration_status?: string }
interface VmTemplate { id: string; name: string; connection_id?: string | null; config?: { cpu_cores?: number; memory_mb?: number; disk_size_gb?: number } }

function vmStatus(vm: ManagedVm) {
  const run = vm.last_run;
  if (!run) return { label: "Draft", tone: "muted" as StatusTone };
  if (run.status === "running" || run.status === "cancelling") return { label: "Running operation", tone: "info" as StatusTone };
  if (run.status === "failed" || run.status === "interrupted") return { label: "Needs attention", tone: "danger" as StatusTone };
  if (run.action === "drift" && run.plan_summary) {
    try {
      const summary = JSON.parse(run.plan_summary) as Record<string, number>;
      if ((summary.create || 0) + (summary.update || 0) + (summary.delete || 0) + (summary.replace || 0) > 0) return { label: "Drift", tone: "warning" as StatusTone };
    } catch { /* keep the normal status */ }
  }
  return { label: vm.started ? "Managed" : "Stopped", tone: "success" as StatusTone };
}
function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function DeploymentsPage() {
  const environmentId = useUi((state) => state.environmentId);
  const queryClient = useQueryClient();
  const profileQuery = useProfile();
  const canEdit = hasCap(profileQuery.data, "canEditDeployments");
  const [createOpen, setCreateOpen] = useState(false);
  const [legacyToMigrate, setLegacyToMigrate] = useState<LegacyWorkspace | null>(null);
  const vmsQuery = useQuery({
    queryKey: ["opentofu", "vms", environmentId],
    queryFn: () => apiFetch<ManagedVm[]>(`/opentofu/vms?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const vms = Array.isArray(vmsQuery.data) ? vmsQuery.data : [];
  const legacyQuery = useQuery({
    queryKey: ["opentofu", "legacy-workspaces", environmentId],
    queryFn: () => apiFetch<LegacyWorkspace[]>(`/opentofu/legacy-workspaces?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const legacy = Array.isArray(legacyQuery.data) ? legacyQuery.data : [];
  const templatesQuery = useQuery({
    queryKey: ["opentofu", "vm-templates", environmentId],
    queryFn: () => apiFetch<{ templates?: VmTemplate[] }>(`/opentofu/vm-templates?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const templates = Array.isArray(templatesQuery.data?.templates) ? templatesQuery.data!.templates! : [];
  const migrateMutation = useMutation({
    mutationFn: (workspace: LegacyWorkspace) => apiFetch(`/opentofu/legacy-workspaces/${encodeURIComponent(workspace.id)}/migrate-vms`, { method: "POST", body: { confirmation: `MIGRATE ${workspace.name}` } }),
    onSuccess: () => { setLegacyToMigrate(null); showToast("VM states were isolated successfully.", "success"); refresh(); },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["opentofu"] });

  return <div className="space-y-5">
    <PageHeader
      title="Virtual machines"
      description="Each VM is managed independently with its own OpenTofu state, plans, and run history."
      actions={<>
        <Button type="button" variant="outline" onClick={refresh} disabled={vmsQuery.isFetching}><RefreshCw className={vmsQuery.isFetching ? "animate-spin" : undefined} />Refresh</Button>
        <Button type="button" onClick={() => setCreateOpen(true)} disabled={!canEdit}><Server />New VM</Button>
      </>}
    />

    {legacyQuery.isError && <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Legacy VM deployments could not be checked" description="No migration has been started." action={<Button variant="outline" onClick={() => void legacyQuery.refetch()}><RefreshCw />Try again</Button>} /></Card>}

    {!legacyQuery.isError && legacy.length > 0 && <Card className="border-amber-500/40">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TriangleAlert className="h-4 w-4 text-amber-600" />Legacy VM state migration required</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">These older deployments still share an OpenTofu state. Migration is explicit, creates an encrypted backup, validates every resulting VM plan, and never applies infrastructure changes.</p>
        {legacy.map((workspace) => <div key={workspace.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><div className="font-medium">{workspace.name}</div><div className="text-xs text-muted-foreground">{workspace.vm_count} VM{workspace.vm_count === 1 ? "" : "s"} · {workspace.migration_status || "not migrated"}</div></div><Button size="sm" variant="outline" disabled={!canEdit || migrateMutation.isPending} onClick={() => setLegacyToMigrate(workspace)}>Migrate to isolated VM states</Button></div>)}
      </CardContent>
    </Card>}

    {vmsQuery.isLoading ? <div className="space-y-1 rounded-md border p-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-11 animate-pulse rounded bg-muted/40" />)}</div>
      : vmsQuery.isError ? <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Virtual machines could not be loaded" description="No infrastructure has been changed." action={<Button variant="outline" onClick={() => void vmsQuery.refetch()}><RefreshCw />Try again</Button>} /></Card>
      : vms.length === 0 ? <Card><EmptyState icon={<Server className="h-5 w-5" />} title="No managed virtual machines" description="Create a VM. Shipyard will isolate it in its own OpenTofu state." action={canEdit ? <Button onClick={() => setCreateOpen(true)}><Server />New VM</Button> : undefined} /></Card>
      : <Card>
        <CardHeader className="border-b bg-muted/15 py-3"><CardTitle className="flex items-center gap-2 text-base"><Workflow className="h-4 w-4" />Managed virtual machines</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="table-scroll">
            <table data-density="compact" className="w-full min-w-[850px] text-sm">
              <thead><tr><th className="px-3">Name</th><th className="px-3">Status</th><th className="px-3">Platform</th><th className="px-3">Proxmox</th><th className="px-3">Last run</th><th className="w-28 px-3 text-right">Actions</th></tr></thead>
              <tbody>{vms.map((vm) => {
                const status = vmStatus(vm);
                return <tr key={vm.id}>
                  <td className="px-3"><div className="font-medium">{vm.name}</div><div className="text-xs text-muted-foreground">Independent state</div></td>
                  <td className="px-3"><StatusBadge tone={status.tone} dot>{status.label}</StatusBadge></td>
                  <td className="px-3"><div className="font-medium">{vm.platform?.name || "—"}</div><div className="max-w-[14rem] truncate text-xs text-muted-foreground">{vm.platform?.endpoint?.replace(/^https?:\/\//, "") || "Platform unavailable"}</div></td>
                  <td className="px-3"><span className="font-mono text-xs">{vm.node_name || "—"} · {vm.vm_id || "auto"}</span></td>
                  <td className="px-3"><div className="text-xs">{vm.last_run ? `${vm.last_run.action || "Run"} · ${vm.last_run.status || "unknown"}` : "No runs yet"}</div><div className="text-xs text-muted-foreground">{formatDate(vm.last_run?.completed_at || vm.last_run?.started_at)}</div></td>
                  <td className="px-3 text-right"><Button asChild size="sm" variant="outline"><Link to="/deployments/$id" params={{ id: vm.id }}>Open<ArrowRight /></Link></Button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </CardContent>
      </Card>}

    <Card>
      <CardHeader><CardTitle className="text-base">VM templates</CardTitle></CardHeader>
      <CardContent>{templatesQuery.isError
        ? <EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="VM templates could not be loaded" description="No template data is being shown." action={<Button variant="outline" onClick={() => void templatesQuery.refetch()}><RefreshCw />Try again</Button>} />
        : templates.length === 0 ? <p className="text-sm text-muted-foreground">No templates yet. Save the current values as a template while creating or editing a VM.</p> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{templates.map((template) => <div key={template.id} className="rounded-md border p-3"><div className="font-medium">{template.name}</div><div className="mt-1 text-xs text-muted-foreground">{template.config?.cpu_cores || "—"} CPU · {template.config?.memory_mb || "—"} MB · {template.config?.disk_size_gb || "—"} GB</div></div>)}</div>}</CardContent>
    </Card>
    <CreateDeploymentDialog environmentId={environmentId} open={createOpen} onOpenChange={setCreateOpen} />
    <ConfirmDialog open={Boolean(legacyToMigrate)} onOpenChange={(next) => !next && setLegacyToMigrate(null)} title="Split legacy state by VM?" description="Shipyard locks the legacy deployment, backs up its local state, moves each VM resource to an independent state, and validates that no VM would be created or destroyed. Remote backends are rejected and require a backend-specific migration." confirmLabel="Migrate VM states" variant="warning" confirmTextValue={legacyToMigrate ? `MIGRATE ${legacyToMigrate.name}` : undefined} confirmInputHelp={legacyToMigrate ? <>Enter <code className="font-mono">MIGRATE {legacyToMigrate.name}</code>.</> : undefined} onConfirm={() => legacyToMigrate && migrateMutation.mutate(legacyToMigrate)} isPending={migrateMutation.isPending} />
  </div>;
}
