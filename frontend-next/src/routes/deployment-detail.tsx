import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  Workflow,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VmFormDialog } from "@/features/deployments/VmFormDialog";
import { DeploymentConnectionDialog } from "@/features/deployments/DeploymentConnectionDialog";
import { RunDetailsDialog } from "@/features/deployments/RunDetailsDialog";
import { DeploymentSettingsDialog } from "@/features/deployments/DeploymentSettingsDialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { useUrlTab } from "@/lib/use-url-tab";

const DEPLOYMENT_TABS = [
  "overview",
  "vms",
  "resources",
  "runs",
  "workflows",
  "templates",
] as const;

interface Workspace {
  id: string;
  name: string;
  path?: string;
  description?: string;
}
interface Run {
  id: string;
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  plan_summary?: string | PlanSummary | null;
  approved_plan_id?: string | null;
}
interface PlanSummary { create?: number; update?: number; delete?: number; replace?: number; read?: number }
interface RunsResponse {
  items?: Run[];
  pagination?: { page: number; total: number; total_pages: number; has_prev: boolean; has_next: boolean };
}
interface Vm {
  id: string;
  name: string;
  node_name?: string;
  vm_id?: string | number;
  started?: boolean;
  cpu_cores?: number;
  memory_mb?: number;
  disk_size_gb?: number;
  post_deploy_playbooks?: string[];
  [key: string]: unknown;
}
interface VmsResponse {
  vms?: Vm[];
}
interface VmTemplateConfig {
  cpu_cores?: string | number;
  memory_mb?: string | number;
  disk_size_gb?: string | number;
  clone_vm_id?: string | number;
}
interface VmTemplate {
  id: string;
  name: string;
  config?: VmTemplateConfig;
}
interface VmTemplatesResponse {
  templates?: VmTemplate[];
}
interface ActualResource {
  address?: string;
  name?: string;
  node_name?: string;
  vm_id?: string | number;
  status?: string;
  ip_addresses?: string[];
  fleet_server_id?: string | null;
  fleet_server_name?: string | null;
}
interface ResourceOverview {
  desired?: {
    vm_count?: number;
    cpu_cores?: number;
    memory_mb?: number;
    disk_gb?: number;
    nodes?: Array<{ name?: string; vm_count?: number }>;
  };
  actual?: {
    available?: boolean;
    reason?: string;
    vm_count?: number;
    resources?: ActualResource[];
  };
}
interface PostDeployEntry {
  vm_id: string;
  vm_name: string;
  playbook: string;
  position: number;
  status?: string;
  output?: string;
  completed_at?: string | null;
  updated_at?: string | null;
}
interface DeploymentSummary {
  post_deploy?: {
    entries?: PostDeployEntry[];
    counts?: Record<string, number>;
  };
}
interface StateSafety { backend?: string; mode?: "remote" | "encrypted-backup" | "unsafe"; locking?: boolean; backups?: number | null }
interface StateBackupsResponse { items?: Array<{ name: string; created_at?: string; size?: number }> }

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function tone(status?: string): StatusTone {
  if (status === "success" || status === "completed") return "success";
  if (status === "failed" || status === "error" || status === "interrupted") return "danger";
  if (status === "running" || status === "queued" || status === "cancelling") return "info";
  return "muted";
}

function planSummary(value?: string | PlanSummary | null): PlanSummary | null {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value) as PlanSummary; } catch { return null; }
}

function planSummaryLabel(value?: string | PlanSummary | null) {
  const summary = planSummary(value);
  if (!summary) return "No summary";
  return `${summary.create || 0} create · ${summary.update || 0} update · ${summary.delete || 0} delete · ${summary.replace || 0} replace`;
}

function total(vms: Vm[], field: "cpu_cores" | "memory_mb" | "disk_size_gb") {
  return vms.reduce((sum, vm) => sum + (Number(vm[field]) || 0), 0);
}

function DeploymentProperty({
  label,
  value,
  action,
}: {
  label: string;
  value: string | number;
  action?: ReactNode;
}) {
  return (
    <div className="console-property">
      <dt>{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-2">
        <span className="truncate">{value}</span>
        {action}
      </dd>
    </div>
  );
}

function DeploymentObjectInfo({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: "success" | "warning" | "danger";
}) {
  return (
    <div className="console-object-info">
      <div>{label}</div>
      <div data-summary-tone={tone} title={String(value)}>
        {value}
      </div>
      {detail && (
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={detail}
        >
          {detail}
        </p>
      )}
    </div>
  );
}

export function DeploymentDetailPage() {
  const deploymentTabs = useUrlTab("overview", DEPLOYMENT_TABS);
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id || "";
  const environmentId = useUi((state) => state.environmentId);
  const queryClient = useQueryClient();
  const profileQuery = useProfile();
  const canEdit = hasCap(profileQuery.data, "canEditDeployments");
  const canPlan = hasCap(profileQuery.data, "canPlanDeployments");
  const canApply = hasCap(profileQuery.data, "canApplyDeployments");
  const canDestroy = hasCap(profileQuery.data, "canDestroyDeployments");
  const canManagePlatforms = hasCap(profileQuery.data, "canManageDeploymentPlatforms");
  const [runsPage, setRunsPage] = useState(1);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmRestoreState, setConfirmRestoreState] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [vmDialogOpen, setVmDialogOpen] = useState(false);
  const [editingVm, setEditingVm] = useState<Vm | null>(null);
  const [vmToDelete, setVmToDelete] = useState<Vm | null>(null);
  const [vmToDestroy, setVmToDestroy] = useState<Vm | null>(null);
  const [selectedVmIds, setSelectedVmIds] = useState<Set<string>>(new Set());
  const [confirmSelectedVmDelete, setConfirmSelectedVmDelete] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<VmTemplate | null>(
    null,
  );
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(
    new Set(),
  );
  const [confirmSelectedTemplateDelete, setConfirmSelectedTemplateDelete] =
    useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const workspacesQuery = useQuery({
    queryKey: ["opentofu", "workspaces", environmentId],
    queryFn: () =>
      apiFetch<Workspace[]>(
        `/opentofu/workspaces?environment_id=${encodeURIComponent(environmentId)}`,
      ),
  });
  const workspace = (
    Array.isArray(workspacesQuery.data) ? workspacesQuery.data : []
  ).find((item) => item.id === id);
  const runsQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "runs", runsPage],
    queryFn: () =>
      apiFetch<RunsResponse>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/runs?page_size=8&page=${runsPage}`,
      ),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.items?.some((run) => run.status === "running")
        ? 2_500
        : false,
  });
  const runControlsQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "run-controls"],
    queryFn: () => apiFetch<RunsResponse>(`/opentofu/workspaces/${encodeURIComponent(id)}/runs?page_size=20&page=1`),
    enabled: Boolean(id),
    refetchInterval: (query) => query.state.data?.items?.some((run) => ["running", "cancelling", "queued"].includes(String(run.status || ""))) ? 2_000 : false,
  });
  const vmsQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "vms"],
    queryFn: () =>
      apiFetch<VmsResponse>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vms`,
      ),
    enabled: Boolean(id),
  });
  const templatesQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "vm-templates"],
    queryFn: () =>
      apiFetch<VmTemplatesResponse>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vm-templates`,
      ),
    enabled: Boolean(id),
  });
  const resourceOverviewQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "resources-overview"],
    queryFn: () =>
      apiFetch<ResourceOverview>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/resources-overview`,
      ),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
  const deploymentSummaryQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "deployment-summary"],
    queryFn: () =>
      apiFetch<DeploymentSummary>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/deployment-summary`,
      ),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      (query.state.data?.post_deploy?.entries || []).some(
        (entry) => entry.status === "running",
      )
        ? 2_500
        : false,
  });
  const stateSafetyQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "state-safety"],
    queryFn: () => apiFetch<StateSafety>(`/opentofu/workspaces/${encodeURIComponent(id)}/state-safety`),
    enabled: Boolean(id),
    retry: false,
  });
  const stateBackupsQuery = useQuery({
    queryKey: ["opentofu", "workspace", id, "state-backups"],
    queryFn: () => apiFetch<StateBackupsResponse>(`/opentofu/workspaces/${encodeURIComponent(id)}/state-backups`),
    enabled: Boolean(id) && stateSafetyQuery.data?.mode === "encrypted-backup",
  });
  const vms = Array.isArray(vmsQuery.data?.vms) ? vmsQuery.data!.vms! : [];
  const vmTemplates = Array.isArray(templatesQuery.data?.templates)
    ? templatesQuery.data!.templates!
    : [];
  const runs = Array.isArray(runsQuery.data?.items)
    ? runsQuery.data!.items!
    : [];
  const controlRuns = Array.isArray(runControlsQuery.data?.items) ? runControlsQuery.data!.items! : runs;
  const latestRun = controlRuns[0];
  const activeRun = controlRuns.find((run) => ["running", "cancelling", "queued"].includes(String(run.status || "")));
  const consumedPlanIds = new Set(controlRuns.filter((run) => run.action === "apply" && ["running", "cancelling", "success"].includes(String(run.status || ""))).map((run) => run.approved_plan_id).filter(Boolean));
  const approvedPlan = controlRuns.find((run) => run.action === "plan" && run.status === "success" && !consumedPlanIds.has(run.id));
  const managedResourceByVm = useMemo(
    () =>
      new Map(
        (resourceOverviewQuery.data?.actual?.resources || [])
          .filter(
            (resource) =>
              resource.node_name &&
              resource.vm_id !== undefined &&
              resource.fleet_server_id,
          )
          .map((resource) => [
            `${resource.node_name}:${resource.vm_id}`,
            resource,
          ]),
      ),
    [resourceOverviewQuery.data?.actual?.resources],
  );
  const postDeployEntries = Array.isArray(
    deploymentSummaryQuery.data?.post_deploy?.entries,
  )
    ? deploymentSummaryQuery.data!.post_deploy!.entries!
    : [];

  const runMutation = useMutation({
    mutationFn: (action: "init" | "validate" | "plan" | "drift" | "apply") =>
      apiFetch<{ dbRunId?: string }>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/run`,
        { method: "POST", body: { action, ...(action === "apply" ? { plan_id: approvedPlan?.id } : {}) } },
      ),
    onSuccess: (_result, action) => {
      showToast(`${action} started.`, "success");
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const destroyMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ dbRunId?: string }>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/run`,
        {
          method: "POST",
          body: {
            action: "destroy",
            confirm_destroy: `DESTROY ${workspace?.name || ""}`,
          },
        },
      ),
    onSuccess: () => {
      showToast(
        "Destroy started. The run remains traceable in history.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "resources-overview"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const destroyVmMutation = useMutation({
    mutationFn: (vm: Vm) =>
      apiFetch<{ dbRunId?: string }>(
        `/opentofu/workspaces/${encodeURIComponent(id)}/run`,
        {
          method: "POST",
          body: {
            action: "destroy_vm",
            vm_id: vm.id,
            confirm_destroy: `DESTROY ${workspace?.name || ""}/${vm.name}`,
          },
        },
      ),
    onSuccess: () => {
      showToast(
        "VM destroy started. The Fleet host remains as an independent inventory record.",
        "success",
      );
      setVmToDestroy(null);
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "vms"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "resources-overview"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const retryPostDeployMutation = useMutation({
    mutationFn: (entry: PostDeployEntry) =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(id)}/post-deploy/retry`,
        {
          method: "POST",
          body: { vm_id: entry.vm_id, playbook: entry.playbook },
        },
      ),
    onSuccess: () => {
      showToast("Post-deploy step is running again.", "success");
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "deployment-summary"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const restoreStateMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/workspaces/${encodeURIComponent(id)}/state-backups/restore`, {
      method: "POST",
      body: { backup: stateBackupsQuery.data?.items?.[0]?.name, confirmation: `RESTORE STATE ${workspace?.name || ""}` },
    }),
    onSuccess: () => {
      setConfirmRestoreState(false);
      showToast("The latest encrypted state backup was restored.", "success");
      void queryClient.invalidateQueries({ queryKey: ["opentofu", "workspace", id] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "workspace", id],
    });
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "workspaces"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "workspace", id, "deployment-summary"],
    });
  };
  const deleteTemplateMutation = useMutation({
    mutationFn: (templateId: string) =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vm-templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      showToast("VM template deleted.", "success");
      setTemplateToDelete(null);
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "vm-templates"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const deleteSelectedTemplatesMutation = useMutation({
    mutationFn: async () =>
      Promise.all(
        [...selectedTemplateIds].map((templateId) =>
          apiFetch(
            `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vm-templates/${encodeURIComponent(templateId)}`,
            { method: "DELETE" },
          ),
        ),
      ),
    onSuccess: () => {
      const count = selectedTemplateIds.size;
      setSelectedTemplateIds(new Set());
      setConfirmSelectedTemplateDelete(false);
      showToast(
        `${count} VM template${count === 1 ? "" : "s"} deleted. Existing VM definitions remain unchanged.`,
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "vm-templates"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const deleteVmMutation = useMutation({
    mutationFn: (vmId: string) =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vms/${encodeURIComponent(vmId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      showToast(
        "VM definition removed. The existing VM remains unchanged; use Destroy on the VM to delete it from Proxmox.",
        "success",
      );
      setVmToDelete(null);
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "vms"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const deleteSelectedVmsMutation = useMutation({
    mutationFn: async () =>
      Promise.all(
        [...selectedVmIds].map((vmId) =>
          apiFetch(
            `/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vms/${encodeURIComponent(vmId)}`,
            { method: "DELETE" },
          ),
        ),
      ),
    onSuccess: () => {
      const count = selectedVmIds.size;
      setSelectedVmIds(new Set());
      setConfirmSelectedVmDelete(false);
      showToast(
        `${count} VM definition${count === 1 ? "" : "s"} removed. Existing VMs remain unchanged.`,
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", id, "vms"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const openNewVmDialog = () => {
    setEditingVm(null);
    setVmDialogOpen(true);
  };
  const openEditVmDialog = (vm: Vm) => {
    setEditingVm(vm);
    setVmDialogOpen(true);
  };
  const toggleVmSelection = (vmId: string) =>
    setSelectedVmIds((current) => {
      const next = new Set(current);
      if (next.has(vmId)) next.delete(vmId);
      else next.add(vmId);
      return next;
    });
  const allVmsSelected =
    vms.length > 0 && vms.every((vm) => selectedVmIds.has(vm.id));
  const someVmsSelected = vms.some((vm) => selectedVmIds.has(vm.id));
  const toggleAllVmSelection = () =>
    setSelectedVmIds(
      allVmsSelected ? new Set() : new Set(vms.map((vm) => vm.id)),
    );
  const allTemplatesSelected =
    vmTemplates.length > 0 &&
    vmTemplates.every((template) => selectedTemplateIds.has(template.id));
  const someTemplatesSelected = vmTemplates.some((template) =>
    selectedTemplateIds.has(template.id),
  );
  const toggleTemplateSelection = (templateId: string) =>
    setSelectedTemplateIds((current) => {
      const next = new Set(current);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  const toggleAllTemplateSelection = () =>
    setSelectedTemplateIds(
      allTemplatesSelected
        ? new Set()
        : new Set(vmTemplates.map((template) => template.id)),
    );

  if (workspacesQuery.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  if (!workspace)
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("deploy.title")}
          back={
            <Button asChild size="icon" variant="ghost">
              <Link to="/deployments">
                <ArrowLeft />
              </Link>
            </Button>
          }
        />
        <Card>
          <EmptyState
            icon={<Workflow className="h-5 w-5" />}
            title="Deployment not found"
            description="The workspace was deleted or is not available to your role."
            action={
              <Button asChild variant="outline">
                <Link to="/deployments">{t("deploy.title")}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );

  const actualResources = resourceOverviewQuery.data?.actual?.resources || [];
  const runningResources = actualResources.filter(
    (resource) => resource.status === "managed",
  ).length;
  const postDeployCounts =
    deploymentSummaryQuery.data?.post_deploy?.counts || {};
  const postDeployOpen =
    (postDeployCounts.pending || 0) +
    (postDeployCounts.running || 0) +
    (postDeployCounts.failed || 0);
  const desiredVmCount =
    resourceOverviewQuery.data?.desired?.vm_count ?? vms.length;
  const latestRunLabel =
    latestRun?.status === "success"
      ? "Ready"
      : latestRun?.status === "failed"
        ? "Review required"
        : latestRun?.status === "running"
          ? "Running"
          : latestRun?.status || "Not run yet";

  return (
    <div className="space-y-5">
      <PageHeader
        title={workspace.name}
        description={
          workspace.description || workspace.path || t("deploy.description")
        }
        back={
          <Button
            asChild
            size="icon"
            variant="ghost"
            aria-label={t("deploy.title")}
          >
            <Link to="/deployments">
              <ArrowLeft />
            </Link>
          </Button>
        }
        actions={
          <>
            <Button type="button" variant="outline" onClick={refresh}>
              <RefreshCw />
              {t("deploy.refresh")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSettingsDialogOpen(true)}
              disabled={!canEdit}
            >
              <Pencil />
              Edit deployment
            </Button>
          </>
        }
      />

      <Tabs
        value={deploymentTabs.value}
        onValueChange={deploymentTabs.onValueChange}
        className="space-y-4"
      >
        <TabsList aria-label="Deployment sections" className="console-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="vms">
            VM definitions{" "}
            <span className="ml-1 text-muted-foreground">{vms.length}</span>
          </TabsTrigger>
          <TabsTrigger value="resources">OpenTofu state</TabsTrigger>
          <TabsTrigger value="runs">
            Runs{" "}
            <span className="ml-1 text-muted-foreground">{runsQuery.data?.pagination?.total ?? runs.length}</span>
          </TabsTrigger>
          <TabsTrigger value="workflows">
            Post-deployment{" "}
            <span className="ml-1 text-muted-foreground">
              {postDeployEntries.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="templates">
            Templates{" "}
            <span className="ml-1 text-muted-foreground">
              {vmTemplates.length}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          <section className="console-object-summary">
            <div>
              <div className="console-object-summary-main">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div>
                      <div className="text-sm font-semibold">
                        Deployment status
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Desired state, OpenTofu state, and post-deployment status
                        at a glance.
                      </p>
                    </div>
                  </div>
                  <StatusBadge tone={tone(latestRun?.status)} dot>
                    {latestRunLabel}
                  </StatusBadge>
                </div>
                <div className="console-object-info-grid grid-cols-2 lg:grid-cols-4">
                  <DeploymentObjectInfo
                    label="Defined VMs"
                    value={desiredVmCount}
                    detail={
                      resourceOverviewQuery.data?.actual?.available
                        ? `${actualResources.length} detected in state`
                        : "Not applied yet"
                    }
                  />
                  <DeploymentObjectInfo
                    label="Managed resources"
                    value={runningResources}
                    detail={
                      runningResources
                        ? "Tracked in OpenTofu state"
                        : "No managed resources"
                    }
                    tone={runningResources ? "success" : undefined}
                  />
                  <DeploymentObjectInfo
                    label="Last run"
                    value={latestRun?.action || "—"}
                    detail={formatDate(
                      latestRun?.completed_at || latestRun?.started_at,
                    )}
                    tone={
                      latestRun?.status === "failed"
                        ? "danger"
                        : latestRun?.status === "success"
                          ? "success"
                          : undefined
                    }
                  />
                  <DeploymentObjectInfo
                    label="Post-deployment"
                    value={
                      postDeployEntries.length
                        ? `${postDeployEntries.length} steps`
                        : "None"
                    }
                    detail={
                      postDeployOpen
                        ? `${postDeployOpen} need attention`
                        : "No pending steps"
                    }
                    tone={postDeployOpen ? "warning" : undefined}
                  />
                </div>
              </div>
            </div>
          </section>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(21rem,.75fr)]">
            <Card>
              <CardHeader className="border-b bg-muted/15 py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Workflow className="h-4 w-4" />
                  Provisioning
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <dl className="console-properties">
                  <DeploymentProperty
                    label="OpenTofu state"
                    value={
                      resourceOverviewQuery.data?.actual?.available
                        ? `${actualResources.length} resources available`
                        : "No state yet"
                    }
                  />
                  <DeploymentProperty
                    label="Platform connection"
                    value="Through deployment configuration"
                    action={
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConnectionDialogOpen(true)}
                        disabled={!canManagePlatforms}
                      >
                        <Settings2 />
                        Open
                      </Button>
                    }
                  />
                  <DeploymentProperty
                    label="Last change"
                    value={formatDate(
                      latestRun?.completed_at || latestRun?.started_at,
                    )}
                  />
                  <DeploymentProperty
                    label="State protection"
                    value={stateSafetyQuery.data?.mode === "remote"
                      ? `Remote backend (${stateSafetyQuery.data.backend}) with locking`
                      : stateSafetyQuery.data?.mode === "encrypted-backup"
                        ? `Encrypted · ${stateSafetyQuery.data.backups || 0} backups`
                        : "Not safely configured"}
                    action={stateBackupsQuery.data?.items?.length ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRestoreState(true)} disabled={!canDestroy || Boolean(activeRun)}>
                        Restore latest
                      </Button>
                    ) : undefined}
                  />
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b bg-muted/15 py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Play className="h-4 w-4" />
                  Controlled workflow
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <p className="text-sm text-muted-foreground">
                  Create a plan, review its summary, then apply that exact saved plan artifact.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => runMutation.mutate("plan")}
                    disabled={
                      !canPlan || Boolean(activeRun) || runMutation.isPending || destroyMutation.isPending
                    }
                  >
                    <Play />
                    Create plan
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setConfirmApply(true)}
                    disabled={
                      !canApply || !approvedPlan || Boolean(activeRun) || runMutation.isPending || destroyMutation.isPending
                    }
                  >
                    <ArrowRight />
                    Apply reviewed plan
                  </Button>
                </div>
                {approvedPlan ? (
                  <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                    <div className="font-medium">Reviewed plan</div>
                    <div className="mt-1 text-muted-foreground">{planSummaryLabel(approvedPlan.plan_summary)}</div>
                  </div>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">Create and review a successful plan before applying.</p>
                )}
                <details className="rounded-md border border-border bg-muted/10 px-3 py-2">
                  <summary
                    aria-label="Open advanced actions"
                    className="cursor-pointer text-xs font-medium text-muted-foreground"
                  >
                    Preparation and advanced actions
                  </summary>
                  <div className="mt-2 grid gap-3 border-t pt-3">
                    <div>
                      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                        Initialization loads providers and modules. Validation
                        checks the configuration without changing resources.
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => runMutation.mutate("init")}
                          disabled={!canPlan || Boolean(activeRun) || runMutation.isPending || destroyMutation.isPending}
                        >
                          Initialize
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => runMutation.mutate("validate")}
                          disabled={!canPlan || Boolean(activeRun) || runMutation.isPending || destroyMutation.isPending}
                        >
                          <CheckCircle2 />
                          Validate
                        </Button>
                      </div>
                    </div>
                    <div className="border-t pt-3">
                      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                        Destroy removes only resources from this deployment. The
                        confirmation requires exact text input.
                      </p>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmDestroy(true)}
                        disabled={!canDestroy || Boolean(activeRun) || runMutation.isPending || destroyMutation.isPending}
                      >
                        <Trash2 />
                        Prepare destroy
                      </Button>
                    </div>
                  </div>
                </details>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="vms" className="mt-0">
          <div className="grid gap-6">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Server className="h-4 w-4" />
                  Proxmox VMs
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="neutral">{vms.length}</StatusBadge>
                  {selectedVmIds.size > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirmSelectedVmDelete(true)}
                      disabled={!canEdit}
                    >
                      <Trash2 />
                      Remove {selectedVmIds.size}
                    </Button>
                  )}
                  <Button type="button" size="sm" onClick={openNewVmDialog} disabled={!canEdit}>
                    <Plus />
                    Add VM
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {vmsQuery.isLoading ? (
                  <div className="space-y-3 p-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : vms.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<Server className="h-5 w-5" />}
                    title="No VM definitions"
                    description="Define your first VM directly in Fleet."
                    action={
                      <Button size="sm" onClick={openNewVmDialog} disabled={!canEdit}>
                        <Plus />
                        Add VM
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <div className="divide-y md:hidden">
                      {vms.map((vm) => {
                        const managed = managedResourceByVm.get(
                          `${vm.node_name}:${vm.vm_id}`,
                        );
                        return (
                          <div
                            key={vm.id}
                            className="flex gap-3 p-3.5"
                            data-selected={
                              selectedVmIds.has(vm.id) || undefined
                            }
                          >
                            <input
                              className="mt-1"
                              type="checkbox"
                              aria-label={`Select ${vm.name}`}
                              checked={selectedVmIds.has(vm.id)}
                              onChange={() => toggleVmSelection(vm.id)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate font-medium">
                                    {managed?.fleet_server_id ? (
                                      <Link
                                        to="/servers/$id"
                                        params={{ id: managed.fleet_server_id }}
                                        className="hover:underline"
                                      >
                                        {vm.name}
                                      </Link>
                                    ) : (
                                      vm.name
                                    )}
                                  </div>
                                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                                    {vm.node_name || "—"} · VM-ID{" "}
                                    {vm.vm_id ?? "automatisch"}
                                  </div>
                                </div>
                                <StatusBadge
                                  tone={vm.started ? "success" : "muted"}
                                  dot
                                >
                                  {vm.started ? "Running" : "Off"}
                                </StatusBadge>
                              </div>
                              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                                <div>
                                  <span className="block text-muted-foreground">
                                    vCPU
                                  </span>
                                  <span className="font-mono">
                                    {vm.cpu_cores || "—"}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-muted-foreground">
                                    RAM
                                  </span>
                                  <span className="font-mono">
                                    {vm.memory_mb ? `${vm.memory_mb} MB` : "—"}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-muted-foreground">
                                    Disk
                                  </span>
                                  <span className="font-mono">
                                    {vm.disk_size_gb
                                      ? `${vm.disk_size_gb} GB`
                                      : "—"}
                                  </span>
                                </div>
                              </div>
                              <div className="mt-2 flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">
                                  {vm.post_deploy_playbooks?.length
                                    ? `${vm.post_deploy_playbooks.length} post-deploy steps`
                                    : "No post-deploy steps"}
                                </span>
                                <div className="flex gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditVmDialog(vm)}
                                    disabled={!canEdit}
                                    aria-label={`Edit ${vm.name}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setVmToDestroy(vm)}
                                    disabled={!canDestroy || destroyVmMutation.isPending}
                                    aria-label={`Destroy ${vm.name} in Proxmox`}
                                  >
                                    Destroy
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setVmToDelete(vm)}
                                    disabled={!canEdit}
                                    aria-label={`Remove ${vm.name} definition`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="table-scroll hidden md:block">
                      <table
                        className="w-full min-w-[800px] text-sm"
                        data-density="compact"
                      >
                        <thead>
                          <tr>
                            <th className="w-11 px-3">
                              <input
                                type="checkbox"
                                aria-label="Select all VM definitions"
                                checked={allVmsSelected}
                                ref={(input) => {
                                  if (input)
                                    input.indeterminate =
                                      someVmsSelected && !allVmsSelected;
                                }}
                                onChange={toggleAllVmSelection}
                              />
                            </th>
                            <th className="px-3">VM</th>
                            <th className="px-3">Node</th>
                            <th className="px-3">VM-ID</th>
                            <th className="px-3">vCPU</th>
                            <th className="px-3">RAM</th>
                            <th className="px-3">Disk</th>
                            <th className="px-3">Status</th>
                            <th className="w-44 px-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vms.map((vm) => (
                            <tr
                              key={vm.id}
                              data-selected={
                                selectedVmIds.has(vm.id) || undefined
                              }
                              className={
                                selectedVmIds.has(vm.id)
                                  ? "is-selected"
                                  : undefined
                              }
                            >
                              <td className="px-3">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${vm.name}`}
                                  checked={selectedVmIds.has(vm.id)}
                                  onChange={() => toggleVmSelection(vm.id)}
                                />
                              </td>
                              <td className="px-3 font-medium">
                                {managedResourceByVm.get(
                                  `${vm.node_name}:${vm.vm_id}`,
                                )?.fleet_server_id ? (
                                  <Link
                                    to="/servers/$id"
                                    params={{
                                      id: managedResourceByVm.get(
                                        `${vm.node_name}:${vm.vm_id}`,
                                      )!.fleet_server_id!,
                                    }}
                                    className="hover:underline"
                                  >
                                    {vm.name}
                                  </Link>
                                ) : (
                                  vm.name
                                )}
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {vm.post_deploy_playbooks?.length
                                    ? `${vm.post_deploy_playbooks.length} post-deploy steps`
                                    : "No post-deploy steps"}
                                </div>
                              </td>
                              <td className="px-3 font-mono text-xs">
                                {vm.node_name || "—"}
                              </td>
                              <td className="px-3 font-mono text-xs">
                                {vm.vm_id ?? "Automatic"}
                              </td>
                              <td className="px-3 tabular-nums">
                                {vm.cpu_cores || "—"}
                              </td>
                              <td className="px-3 tabular-nums">
                                {vm.memory_mb ? `${vm.memory_mb} MB` : "—"}
                              </td>
                              <td className="px-3 tabular-nums">
                                {vm.disk_size_gb
                                  ? `${vm.disk_size_gb} GB`
                                  : "—"}
                              </td>
                              <td className="px-3">
                                <StatusBadge
                                  tone={vm.started ? "success" : "muted"}
                                  dot
                                >
                                  {vm.started ? "Running" : "Off"}
                                </StatusBadge>
                              </td>
                              <td className="px-3">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditVmDialog(vm)}
                                    disabled={!canEdit}
                                    aria-label={`Edit ${vm.name}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setVmToDestroy(vm)}
                                    disabled={!canDestroy || destroyVmMutation.isPending}
                                  >
                                    Destroy
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setVmToDelete(vm)}
                                    disabled={!canEdit}
                                    aria-label={`Remove ${vm.name} definition`}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="border-t bg-muted/20 text-sm">
                          <tr>
                            <td />
                            <td className="px-3 font-medium">Capacity</td>
                            <td />
                            <td />
                            <td className="px-3 font-mono">
                              {total(vms, "cpu_cores")}
                            </td>
                            <td className="px-3 font-mono">
                              {total(vms, "memory_mb")} MB
                            </td>
                            <td className="px-3 font-mono">
                              {total(vms, "disk_size_gb")} GB
                            </td>
                            <td />
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="resources" className="mt-0">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
              <div>
                <CardTitle className="text-base">
                  Stored OpenTofu state
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Shows the last stored OpenTofu state. This is not a live or drift check of the Proxmox platform.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge
                  tone={
                    resourceOverviewQuery.data?.actual?.available
                      ? "success"
                      : "muted"
                  }
                  dot
                >
                  {resourceOverviewQuery.data?.actual?.available
                    ? "State available"
                    : "No state yet"}
                </StatusBadge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => runMutation.mutate("drift")}
                  disabled={!canPlan || Boolean(activeRun) || runMutation.isPending}
                >
                  <RefreshCw />
                  Check drift
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: [
                        "opentofu",
                        "workspace",
                        id,
                        "resources-overview",
                      ],
                    })
                  }
                  aria-label="Refresh resources"
                >
                  <RefreshCw
                    className={
                      resourceOverviewQuery.isFetching
                        ? "h-4 w-4 animate-spin"
                        : "h-4 w-4"
                    }
                  />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {resourceOverviewQuery.isLoading ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : resourceOverviewQuery.data?.actual?.available ? (
                <>
                  <div className="divide-y md:hidden">
                    {(resourceOverviewQuery.data.actual.resources || []).map(
                      (resource) => (
                        <div
                          key={
                            resource.address ||
                            `${resource.name}-${resource.vm_id}`
                          }
                          className="space-y-2 p-3.5"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {resource.name || "—"}
                              </div>
                              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                                {resource.address || "—"}
                              </div>
                            </div>
                            <StatusBadge
                              tone={
                                resource.status === "managed"
                                  ? "success"
                                  : "muted"
                              }
                              dot
                            >
                              {resource.status === "managed"
                                ? "Managed"
                                : resource.status || "—"}
                            </StatusBadge>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                            <span className="text-muted-foreground">
                              Node{" "}
                              <b className="ml-1 font-mono text-foreground">
                                {resource.node_name || "—"}
                              </b>
                            </span>
                            <span className="text-muted-foreground">
                              VM-ID{" "}
                              <b className="ml-1 font-mono text-foreground">
                                {resource.vm_id ?? "—"}
                              </b>
                            </span>
                            <span className="col-span-2 truncate font-mono text-muted-foreground">
                              {resource.ip_addresses?.length
                                ? resource.ip_addresses.join(", ")
                                : "Detecting IP…"}
                            </span>
                          </div>
                          {resource.fleet_server_id ? (
                            <Button asChild size="sm" variant="outline">
                              <Link
                                to="/servers/$id"
                                params={{ id: resource.fleet_server_id }}
                              >
                                {resource.fleet_server_name ||
                                  "Open Fleet host"}
                              </Link>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Not imported as a Fleet host
                            </span>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                  <div className="table-scroll hidden md:block">
                    <table
                      className="w-full min-w-[760px] text-sm"
                      data-density="compact"
                    >
                      <thead>
                        <tr>
                          <th className="px-3">Resource</th>
                          <th className="px-3">Node</th>
                          <th className="px-3">VM-ID</th>
                          <th className="px-3">IP address</th>
                          <th className="px-3">Fleet-Host</th>
                          <th className="px-3">State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          resourceOverviewQuery.data.actual.resources || []
                        ).map((resource) => (
                          <tr
                            key={
                              resource.address ||
                              `${resource.name}-${resource.vm_id}`
                            }
                          >
                            <td className="px-3">
                              <div className="font-medium">
                                {resource.name || "—"}
                              </div>
                              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                                {resource.address || "—"}
                              </div>
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {resource.node_name || "—"}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {resource.vm_id ?? "—"}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {resource.ip_addresses?.length
                                ? resource.ip_addresses.join(", ")
                                : "Detecting…"}
                            </td>
                            <td className="px-3">
                              {resource.fleet_server_id ? (
                                <Button asChild size="sm" variant="outline">
                                  <Link
                                    to="/servers/$id"
                                    params={{ id: resource.fleet_server_id }}
                                  >
                                    {resource.fleet_server_name ||
                                      "Open Fleet host"}
                                  </Link>
                                </Button>
                              ) : (
                                <span className="text-muted-foreground">
                                  Not imported
                                </span>
                              )}
                            </td>
                            <td className="px-3">
                              <StatusBadge
                                tone={
                                  resource.status === "managed"
                                    ? "success"
                                    : "muted"
                                }
                                dot
                              >
                                {resource.status === "managed"
                                  ? "Managed"
                                  : resource.status || "—"}
                              </StatusBadge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <EmptyState
                  compact
                  icon={<Boxes className="h-5 w-5" />}
                  title="No resources from state yet"
                  description={
                    resourceOverviewQuery.data?.actual?.reason ||
                    "Run Apply after creating a plan so Fleet can display the actual state."
                  }
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="runs" className="mt-0">
          <Card>
            <CardHeader className="flex-row items-center justify-between border-b">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" />
                Run history
              </CardTitle>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={refresh}
                aria-label={t("deploy.refresh")}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {runsQuery.isLoading ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : runs.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Clock3 className="h-5 w-5" />}
                  title={t("deploy.noRun")}
                />
              ) : (
                <>
                  <div className="divide-y md:hidden">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => setSelectedRunId(run.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
                      >
                        <StatusBadge tone={tone(run.status)} dot>
                          {run.status || "—"}
                        </StatusBadge>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-sm font-medium">
                            {run.action || "tofu"}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {formatDate(run.completed_at || run.started_at)}
                          </div>
                          {run.action === "plan" && <div className="mt-1 text-xs text-muted-foreground">{planSummaryLabel(run.plan_summary)}</div>}
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="sr-only">Open run details</span>
                      </button>
                    ))}
                  </div>
                  <div className="table-scroll hidden md:block">
                    <table data-density="compact">
                      <thead>
                        <tr>
                          <th>Run</th>
                          <th>Status</th>
                          <th>Changes</th>
                          <th>Started</th>
                          <th>Completed</th>
                          <th className="text-right">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr
                            key={run.id}
                            className="cursor-pointer"
                            onClick={() => setSelectedRunId(run.id)}
                          >
                            <td className="font-mono text-sm font-medium">
                              {run.action || "tofu"}
                            </td>
                            <td>
                              <StatusBadge tone={tone(run.status)} dot>
                                {run.status || "—"}
                              </StatusBadge>
                            </td>
                            <td className="text-xs text-muted-foreground">
                              {run.action === "plan" ? planSummaryLabel(run.plan_summary) : "—"}
                            </td>
                            <td className="text-muted-foreground">
                              {formatDate(run.started_at)}
                            </td>
                            <td className="text-muted-foreground">
                              {run.completed_at
                                ? formatDate(run.completed_at)
                                : "—"}
                            </td>
                            <td className="text-right">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedRunId(run.id);
                                }}
                              >
                                <span>Open</span>
                                <ArrowRight className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {(runsQuery.data?.pagination?.total_pages || 1) > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    Page {runsQuery.data?.pagination?.page || runsPage} of {runsQuery.data?.pagination?.total_pages || 1}
                  </span>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={!runsQuery.data?.pagination?.has_prev} onClick={() => setRunsPage(page => Math.max(1, page - 1))}>Previous</Button>
                    <Button type="button" size="sm" variant="outline" disabled={!runsQuery.data?.pagination?.has_next} onClick={() => setRunsPage(page => page + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="workflows" className="mt-0">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Workflow className="h-4 w-4" />
                  Post-deployment automation
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Diese Playbooks laufen nach einem erfolgreichen Apply pro VM in der angezeigten Reihenfolge.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge tone="neutral">
                  {postDeployEntries.length}
                </StatusBadge>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: [
                        "opentofu",
                        "workspace",
                        id,
                        "deployment-summary",
                      ],
                    })
                  }
                  aria-label="Refresh post-deploy status"
                >
                  <RefreshCw
                    className={
                      deploymentSummaryQuery.isFetching
                        ? "h-4 w-4 animate-spin"
                        : "h-4 w-4"
                    }
                  />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {deploymentSummaryQuery.isLoading ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : postDeployEntries.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Workflow className="h-5 w-5" />}
                  title="No post-deploy steps"
                  description="Open a VM definition and select playbooks for automation after provisioning."
                />
              ) : (
                <>
                  <div className="divide-y md:hidden">
                    {postDeployEntries.map((entry) => (
                      <div
                        key={`${entry.vm_id}:${entry.playbook}`}
                        className="space-y-2 p-3.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium">{entry.vm_name}</div>
                            <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                              {entry.position}. {entry.playbook}
                            </div>
                          </div>
                          <StatusBadge tone={tone(entry.status)} dot>
                            {entry.status === "pending"
                              ? "Pending"
                              : entry.status === "success"
                                ? "Successful"
                                : entry.status === "failed"
                                  ? "Failed"
                                  : entry.status || "—"}
                          </StatusBadge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(
                            entry.completed_at || entry.updated_at || undefined,
                          )}
                        </div>
                        {entry.output && (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                              Show output
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">
                              {entry.output}
                            </pre>
                          </details>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            !canApply || retryPostDeployMutation.isPending ||
                            entry.status === "running"
                          }
                          onClick={() => retryPostDeployMutation.mutate(entry)}
                        >
                          <RefreshCw
                            className={
                              retryPostDeployMutation.isPending
                                ? "animate-spin"
                                : undefined
                            }
                          />
                          Run again
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="table-scroll hidden md:block">
                    <table
                      className="w-full min-w-[760px] text-sm"
                      data-density="compact"
                    >
                      <thead>
                        <tr>
                          <th className="w-16 px-3">Order</th>
                          <th className="px-3">VM</th>
                          <th className="px-3">Playbook</th>
                          <th className="px-3">Status</th>
                          <th className="px-3">Last run</th>
                          <th className="w-36 px-3 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {postDeployEntries.map((entry) => (
                          <tr key={`${entry.vm_id}:${entry.playbook}`}>
                            <td className="px-3 font-mono text-xs text-muted-foreground">
                              {entry.position}
                            </td>
                            <td className="px-3 font-medium">
                              {entry.vm_name}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {entry.playbook}
                            </td>
                            <td className="px-3">
                              <StatusBadge tone={tone(entry.status)} dot>
                                {entry.status === "pending"
                                  ? "Pending"
                                  : entry.status === "success"
                                    ? "Successful"
                                    : entry.status === "failed"
                                      ? "Failed"
                                      : entry.status || "—"}
                              </StatusBadge>
                              {entry.output && (
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                                    Show output
                                  </summary>
                                  <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">
                                    {entry.output}
                                  </pre>
                                </details>
                              )}
                            </td>
                            <td className="px-3 text-xs text-muted-foreground">
                              {formatDate(
                                entry.completed_at ||
                                  entry.updated_at ||
                                  undefined,
                              )}
                            </td>
                            <td className="px-3 text-right">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={
                                  !canApply || retryPostDeployMutation.isPending ||
                                  entry.status === "running"
                                }
                                onClick={() =>
                                  retryPostDeployMutation.mutate(entry)
                                }
                              >
                                <RefreshCw
                                  className={
                                    retryPostDeployMutation.isPending
                                      ? "animate-spin"
                                      : undefined
                                  }
                                />
                                Run again
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="templates" className="mt-0">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
              <div>
                <CardTitle className="text-base">VM templates</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Reusable defaults for new Proxmox VMs in this
                  Deployment.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedTemplateIds.size > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirmSelectedTemplateDelete(true)}
                    disabled={!canEdit}
                  >
                    <Trash2 />
                    Remove {selectedTemplateIds.size}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openNewVmDialog}
                  disabled={!canEdit}
                >
                  <Plus />
                  Create template
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {templatesQuery.isLoading ? (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : vmTemplates.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Server className="h-5 w-5" />}
                  title="No VM templates"
                  description="Configure a VM in the form and save its values as a template."
                />
              ) : (
                <>
                  <div className="divide-y md:hidden">
                    {vmTemplates.map((template) => (
                      <div
                        key={template.id}
                        className="flex items-start gap-3 p-3.5"
                        data-selected={
                          selectedTemplateIds.has(template.id) || undefined
                        }
                      >
                        <input
                          className="mt-1"
                          type="checkbox"
                          aria-label={`Select ${template.name}`}
                          checked={selectedTemplateIds.has(template.id)}
                          onChange={() => toggleTemplateSelection(template.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{template.name}</div>
                          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {template.config?.cpu_cores || "—"} vCPU
                            </span>
                            <span>
                              {template.config?.memory_mb || "—"} MB RAM
                            </span>
                            <span>
                              {template.config?.disk_size_gb || "—"} GB Disk
                            </span>
                            <span>
                              {template.config?.clone_vm_id
                                ? `Clone ${template.config.clone_vm_id}`
                                : "No clone"}
                            </span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setTemplateToDelete(template)}
                          disabled={!canEdit}
                          aria-label={`Delete template ${template.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="table-scroll hidden md:block">
                    <table
                      className="w-full min-w-[760px] text-sm"
                      data-density="compact"
                    >
                      <thead>
                        <tr>
                          <th className="w-11 px-3">
                            <input
                              type="checkbox"
                              aria-label="Select all VM templates"
                              checked={allTemplatesSelected}
                              ref={(input) => {
                                if (input)
                                  input.indeterminate =
                                    someTemplatesSelected &&
                                    !allTemplatesSelected;
                              }}
                              onChange={toggleAllTemplateSelection}
                            />
                          </th>
                          <th className="px-3">Template</th>
                          <th className="px-3">vCPU</th>
                          <th className="px-3">Memory</th>
                          <th className="px-3">Disk</th>
                          <th className="px-3">Clone-Template</th>
                          <th className="w-16 px-3 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vmTemplates.map((template) => (
                          <tr
                            key={template.id}
                            data-selected={
                              selectedTemplateIds.has(template.id) || undefined
                            }
                          >
                            <td className="px-3">
                              <input
                                type="checkbox"
                                aria-label={`Select ${template.name}`}
                                checked={selectedTemplateIds.has(template.id)}
                                onChange={() =>
                                  toggleTemplateSelection(template.id)
                                }
                              />
                            </td>
                            <td className="px-3 font-medium">
                              {template.name}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {template.config?.cpu_cores || "—"}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {template.config?.memory_mb
                                ? `${template.config.memory_mb} MB`
                                : "—"}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {template.config?.disk_size_gb
                                ? `${template.config.disk_size_gb} GB`
                                : "—"}
                            </td>
                            <td className="px-3 font-mono text-xs">
                              {template.config?.clone_vm_id
                                ? String(template.config.clone_vm_id)
                                : "—"}
                            </td>
                            <td className="px-3 text-right">
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setTemplateToDelete(template)}
                                disabled={!canEdit}
                                aria-label={`Delete template ${template.name}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmRestoreState}
        onOpenChange={setConfirmRestoreState}
        title="Restore latest state backup?"
        description={`This replaces the local OpenTofu state with the encrypted backup from ${formatDate(stateBackupsQuery.data?.items?.[0]?.created_at)}. The current state is backed up first. Infrastructure is not changed automatically.`}
        confirmLabel="Restore state"
        cancelLabel="Cancel"
        variant="destructive"
        confirmTextValue={`RESTORE STATE ${workspace.name}`}
        confirmInputLabel="Enter to confirm"
        confirmInputHelp={<>Enter exactly <code className="font-mono text-foreground">RESTORE STATE {workspace.name}</code>.</>}
        onConfirm={() => restoreStateMutation.mutate()}
        isPending={restoreStateMutation.isPending}
      />

      <ConfirmDialog
        open={confirmApply}
        onOpenChange={setConfirmApply}
        title="Apply reviewed plan?"
        description={approvedPlan ? `OpenTofu will apply this exact saved plan artifact: ${planSummaryLabel(approvedPlan.plan_summary)}.` : "No successful plan is available."}
        confirmLabel="Apply plan"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => runMutation.mutate("apply")}
        isPending={runMutation.isPending}
      />
      <ConfirmDialog
        open={confirmDestroy}
        onOpenChange={setConfirmDestroy}
        title="Really destroy deployment?"
        description={
          <>
            This starts <code>tofu destroy</code> for{" "}
            <strong>{workspace.name}</strong>. All resources managed by this
            deployment—including VMs, disks, and network configurations—will be
            removed. This action cannot be undone.
          </>
        }
        confirmLabel="Start destroy"
        cancelLabel="Cancel"
        variant="destructive"
        confirmTextValue={`DESTROY ${workspace.name}`}
        confirmInputLabel="Enter to confirm"
        confirmInputHelp={
          <>
            Enter exactly{" "}
            <code className="font-mono text-foreground">
              DESTROY {workspace.name}
            </code>{" "}
            .
          </>
        }
        onConfirm={() => destroyMutation.mutate()}
        isPending={destroyMutation.isPending}
      />
      <ConfirmDialog
        open={Boolean(templateToDelete)}
        onOpenChange={(open) => !open && setTemplateToDelete(null)}
        title="Delete VM template?"
        description={
          templateToDelete
            ? `The template “${templateToDelete.name}” will be deleted. Existing VM definitions remain unchanged.`
            : ""
        }
        confirmLabel="Delete template"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() =>
          templateToDelete && deleteTemplateMutation.mutate(templateToDelete.id)
        }
        isPending={deleteTemplateMutation.isPending}
      />
      <ConfirmDialog
        open={confirmSelectedTemplateDelete}
        onOpenChange={setConfirmSelectedTemplateDelete}
        title="Delete selected VM templates?"
        description={
          <>
            You are deleting <strong>{selectedTemplateIds.size}</strong> VM template
            {selectedTemplateIds.size === 1 ? "" : "s"}. Existing VM definitions
            remain unchanged.
          </>
        }
        confirmLabel="Delete selection"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => deleteSelectedTemplatesMutation.mutate()}
        isPending={deleteSelectedTemplatesMutation.isPending}
      />
      <ConfirmDialog
        open={Boolean(vmToDestroy)}
        onOpenChange={(open) => !open && setVmToDestroy(null)}
        title="Really destroy VM in Proxmox?"
        description={
          vmToDestroy ? (
            <>
              OpenTofu will destroy <strong>{vmToDestroy.name}</strong> specifically
              in Proxmox and then remove only this VM from the deployment. Any
              Fleet host remains as an inventory record.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Destroy VM"
        cancelLabel="Cancel"
        variant="destructive"
        confirmTextValue={
          vmToDestroy
            ? `DESTROY ${workspace.name}/${vmToDestroy.name}`
            : undefined
        }
        confirmInputLabel="Enter to confirm"
        confirmInputHelp={
          vmToDestroy ? (
            <>
              Enter exactly{" "}
              <code className="font-mono text-foreground">
                DESTROY {workspace.name}/{vmToDestroy.name}
              </code>{" "}
              .
            </>
          ) : undefined
        }
        onConfirm={() => vmToDestroy && destroyVmMutation.mutate(vmToDestroy)}
        isPending={destroyVmMutation.isPending}
      />
      <ConfirmDialog
        open={Boolean(vmToDelete)}
        onOpenChange={(open) => !open && setVmToDelete(null)}
        title="Remove VM definition?"
        description={
          vmToDelete
            ? `The desired configuration for “${vmToDelete.name}” will be removed. The existing Proxmox VM remains unchanged.`
            : ""
        }
        confirmLabel="Remove definition"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => vmToDelete && deleteVmMutation.mutate(vmToDelete.id)}
        isPending={deleteVmMutation.isPending}
      />
      <ConfirmDialog
        open={confirmSelectedVmDelete}
        onOpenChange={setConfirmSelectedVmDelete}
        title="Remove selected VM definitions?"
        description={
          <>
            You are removing <strong>{selectedVmIds.size}</strong> VM definition
            {selectedVmIds.size === 1 ? "" : "s"} from this deployment.
            Existing Proxmox VMs remain unchanged.
          </>
        }
        confirmLabel="Remove selection"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => deleteSelectedVmsMutation.mutate()}
        isPending={deleteSelectedVmsMutation.isPending}
      />
      <VmFormDialog
        workspaceId={workspace.id}
        open={vmDialogOpen}
        onOpenChange={(open) => {
          setVmDialogOpen(open);
          if (!open) setEditingVm(null);
        }}
        initialVm={editingVm}
      />
      <DeploymentConnectionDialog
        workspaceId={workspace.id}
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
      />
      <RunDetailsDialog
        workspaceId={workspace.id}
        runId={selectedRunId}
        open={Boolean(selectedRunId)}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
      />
      <DeploymentSettingsDialog
        workspace={workspace}
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
      />
    </div>
  );
}
