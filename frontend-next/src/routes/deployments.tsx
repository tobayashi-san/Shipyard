import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowUpCircle,
  ArrowRight,
  Boxes,
  Database,
  FolderPlus,
  Layers3,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  Workflow,
  Download,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateDeploymentDialog } from "@/features/deployments/CreateDeploymentDialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";

interface OpenTofuStatus {
  installed?: boolean;
  version?: string | null;
  installing?: boolean;
}

interface OpenTofuReleases {
  releases?: string[];
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

interface Run {
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

interface Workspace {
  id: string;
  name: string;
  path?: string;
  description?: string;
  last_run?: Run | null;
  proxmox_connection?: { id: string; name: string; endpoint: string } | null;
}

interface DeploymentSummary {
  vm_count: number;
  started_vm_count: number;
  post_deploy?: {
    counts?: {
      success?: number;
      running?: number;
      failed?: number;
      pending?: number;
    };
  };
  resources?: Array<{
    id: string;
    name: string;
    node_name?: string;
    vm_id?: number | string;
    cpu_cores?: number;
    memory_mb?: number;
    disk_size_gb?: number;
  }>;
}

function runTone(status?: string): StatusTone {
  switch (String(status || "").toLowerCase()) {
    case "success":
    case "completed":
      return "success";
    case "failed":
    case "error":
      return "danger";
    case "running":
    case "queued":
      return "info";
    default:
      return "muted";
  }
}

function formatDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function DeploymentFact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Workflow;
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div className="console-object-info">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="font-mono">{value}</div>
      <p>{detail}</p>
    </div>
  );
}

function runLabel(run?: Run | null) {
  if (!run) return "No runs yet";
  const action =
    {
      init: "Initialization",
      validate: "Validation",
      plan: "Plan",
      apply: "Apply",
      destroy: "Destroy",
    }[String(run.action || "").toLowerCase()] ||
    run.action ||
    "Run";
  const status =
    {
      success: "successful",
      completed: "successful",
      failed: "failed",
      error: "failed",
      running: "running",
      queued: "queued",
    }[String(run.status || "").toLowerCase()] || run.status;
  return status ? `${action} · ${status}` : action;
}

function postDeployOpen(summary?: DeploymentSummary) {
  const counts = summary?.post_deploy?.counts;
  return (
    (counts?.pending || 0) + (counts?.running || 0) + (counts?.failed || 0)
  );
}

export function DeploymentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const profileQuery = useProfile();
  const canEdit = hasCap(profileQuery.data, "canEditDeployments");
  const canManagePlatforms = hasCap(profileQuery.data, "canManageDeploymentPlatforms");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [confirmWorkspaceRemoval, setConfirmWorkspaceRemoval] = useState(false);
  const statusQuery = useQuery({
    queryKey: ["opentofu", "status"],
    queryFn: () => apiFetch<OpenTofuStatus>("/opentofu/status"),
    staleTime: 30_000,
  });
  const releasesQuery = useQuery({
    queryKey: ["opentofu", "releases"],
    queryFn: () => apiFetch<OpenTofuReleases>("/opentofu/releases"),
    enabled: statusQuery.isSuccess,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const latestVersion = useMemo(
    () => [...(releasesQuery.data?.releases || [])].sort((left, right) => compareVersions(right, left))[0] || null,
    [releasesQuery.data?.releases],
  );
  const updateAvailable = Boolean(
    statusQuery.data?.installed &&
    statusQuery.data.version &&
    latestVersion &&
    compareVersions(latestVersion, statusQuery.data.version) > 0,
  );
  const installMutation = useMutation({
    mutationFn: () => {
      if (!latestVersion) throw new Error("No stable OpenTofu release is available.");
      return apiFetch<{ version: string }>("/opentofu/install", {
        method: "POST",
        body: { version: latestVersion },
      });
    },
    onSuccess: (result) => {
      setConfirmInstall(false);
      showToast(`OpenTofu ${result.version} is ready.`, "success");
      void queryClient.invalidateQueries({ queryKey: ["opentofu"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const workspaceQuery = useQuery({
    queryKey: ["opentofu", "workspaces", environmentId],
    queryFn: () =>
      apiFetch<Workspace[]>(
        `/opentofu/workspaces?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    staleTime: 15_000,
  });
  const workspaces = Array.isArray(workspaceQuery.data)
    ? workspaceQuery.data
    : [];
  const removeWorkspaces = useMutation({
    mutationFn: async (workspaceIds: string[]) =>
      Promise.all(
        workspaceIds.map((workspaceId) =>
          apiFetch(`/opentofu/workspaces/${encodeURIComponent(workspaceId)}`, {
            method: "DELETE",
          }),
        ),
      ),
    onSuccess: (_result, workspaceIds) => {
      setSelectedWorkspaceIds(new Set());
      setConfirmWorkspaceRemoval(false);
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspaces", environmentId],
      });
      void queryClient.invalidateQueries({ queryKey: ["opentofu"] });
    },
  });
  const summaryQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ["opentofu", "workspace", workspace.id, "deployment-summary"],
      queryFn: () =>
        apiFetch<DeploymentSummary>(
          `/opentofu/workspaces/${encodeURIComponent(workspace.id)}/deployment-summary`,
        ),
      staleTime: 15_000,
    })),
  });
  const summaries = useMemo(
    () =>
      new Map(
        workspaces.map((workspace, index) => [
          workspace.id,
          summaryQueries[index]?.data,
        ]),
      ),
    [summaryQueries, workspaces],
  );
  const isRefreshing =
    statusQuery.isFetching ||
    workspaceQuery.isFetching ||
    summaryQueries.some((query) => query.isFetching);
  const inventory = useMemo(() => {
    const resources = workspaces.flatMap(
      (workspace) => summaries.get(workspace.id)?.resources || [],
    );
    const postDeploy = workspaces.reduce(
      (total, workspace) => total + postDeployOpen(summaries.get(workspace.id)),
      0,
    );
    return {
      deployments: workspaces.length,
      platforms: new Set(
        workspaces
          .map((workspace) => workspace.proxmox_connection?.id)
          .filter(Boolean),
      ).size,
      vms: resources.length,
      started: workspaces.reduce(
        (total, workspace) =>
          total + (summaries.get(workspace.id)?.started_vm_count || 0),
        0,
      ),
      postDeploy,
    };
  }, [summaries, workspaces]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["opentofu"] });
  };
  const selectedWorkspaceCount = selectedWorkspaceIds.size;
  const allWorkspacesSelected =
    workspaces.length > 0 &&
    workspaces.every((workspace) => selectedWorkspaceIds.has(workspace.id));
  const someWorkspacesSelected = workspaces.some((workspace) =>
    selectedWorkspaceIds.has(workspace.id),
  );
  const toggleWorkspace = (workspaceId: string) =>
    setSelectedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  const toggleAllWorkspaces = () =>
    setSelectedWorkspaceIds(
      allWorkspacesSelected
        ? new Set()
        : new Set(workspaces.map((workspace) => workspace.id)),
    );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("deploy.title")}
        description={t("deploy.description")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={refresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={isRefreshing ? "animate-spin" : undefined}
              />
              {t("deploy.refresh")}
            </Button>
            <Button type="button" onClick={() => setCreateOpen(true)} disabled={!canEdit}>
              <FolderPlus />
              Create deployment
            </Button>
          </>
        }
      />

      {statusQuery.isError && (
        <Card>
          <EmptyState
            compact
            icon={<TriangleAlert className="h-5 w-5" />}
            title="OpenTofu status could not be loaded"
            description="Deployment availability is currently unknown. No data has been changed."
            action={
              <Button variant="outline" onClick={() => void statusQuery.refetch()}>
                <RefreshCw />
                Try again
              </Button>
            }
          />
        </Card>
      )}

      {statusQuery.isSuccess && (
        <Card className={statusQuery.data.installed ? undefined : "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.035)]"}>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            {statusQuery.data.installed
              ? <Workflow className="h-5 w-5 text-primary" />
              : <TriangleAlert className="h-5 w-5 [color:hsl(var(--warning))]" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{t("deploy.status")}</div>
              <div className="text-xs text-muted-foreground">
                {statusQuery.data.installed
                  ? `Installed version ${statusQuery.data.version || "unknown"}${latestVersion ? ` · Latest stable ${latestVersion}` : ""}`
                  : `${t("deploy.unavailable")} Install it into Shipyard's persistent Docker data volume.`}
              </div>
            </div>
            {releasesQuery.isError ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void releasesQuery.refetch()}>
                <RefreshCw />
                Check releases again
              </Button>
            ) : canManagePlatforms && latestVersion && (!statusQuery.data.installed || updateAvailable) ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setConfirmInstall(true)}
                disabled={installMutation.isPending || statusQuery.data.installing}
              >
                {statusQuery.data.installed ? <ArrowUpCircle /> : <Download />}
                {statusQuery.data.installed ? `Update to ${latestVersion}` : `Install ${latestVersion}`}
              </Button>
            ) : releasesQuery.isLoading ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" /> Checking releases…
              </span>
            ) : null}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmInstall}
        onOpenChange={setConfirmInstall}
        title={statusQuery.data?.installed ? "Update OpenTofu?" : "Install OpenTofu?"}
        description={statusQuery.data?.installed
          ? `Shipyard will verify and replace the current OpenTofu binary with version ${latestVersion}. Workspaces and state are unchanged.`
          : `Shipyard will download and verify OpenTofu ${latestVersion} inside the container. The binary is stored in the persistent Shipyard data volume.`}
        confirmLabel={statusQuery.data?.installed ? "Update" : "Install"}
        variant="warning"
        isPending={installMutation.isPending}
        onConfirm={() => installMutation.mutate()}
      />

      {workspaceQuery.isLoading ? (
        <div className="space-y-1 rounded-md border p-4">
          {[0, 1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-11 animate-pulse rounded bg-muted/40"
            />
          ))}
        </div>
      ) : workspaceQuery.isError ? (
        <Card>
          <EmptyState
            icon={<TriangleAlert className="h-5 w-5" />}
            title="Deployments could not be loaded"
            description="The deployment inventory is currently unavailable. Your existing deployments have not been changed."
            action={
              <Button variant="outline" onClick={() => void workspaceQuery.refetch()}>
                <RefreshCw />
                Try again
              </Button>
            }
          />
        </Card>
      ) : workspaces.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers3 className="h-5 w-5" />}
            title={t("deploy.noWorkspaces")}
            description={`${t("deploy.noWorkspacesHint")} Use the primary action in the top-right corner.`}
          />
        </Card>
      ) : (
        <>
          <section
            className="console-object-summary"
            aria-label="Deployment inventory"
          >
            <div className="console-object-summary-main">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <Boxes className="h-4 w-4 text-muted-foreground" />
                  Provisioning capacity
                </div>
                <div className="console-object-info-grid grid-cols-1 sm:grid-cols-3">
                  <DeploymentFact
                    icon={Workflow}
                    label="Deployments"
                    value={inventory.deployments}
                    detail={`${inventory.platforms} platform${inventory.platforms === 1 ? "" : "s"} connected`}
                  />
                  <DeploymentFact
                    icon={Server}
                    label={t("deploy.vms")}
                    value={inventory.vms}
                    detail={`${inventory.started} started`}
                  />
                  <DeploymentFact
                    icon={TriangleAlert}
                    label="Post-deployment"
                    value={inventory.postDeploy}
                    detail={
                      inventory.postDeploy
                        ? "Steps pending"
                        : "No pending steps"
                    }
                  />
                </div>
            </div>
          </section>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/15 py-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Workflow className="h-4 w-4" />
                  Deployments
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Desired-state definitions, managed VM capacity, and current run status.
                </p>
              </div>
              {selectedWorkspaceCount > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">
                    {selectedWorkspaceCount} selected
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedWorkspaceIds(new Set())}
                  >
                    Clear selection
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirmWorkspaceRemoval(true)}
                  >
                    <Trash2 />
                    Remove
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y md:hidden">
                {workspaces.map((workspace) => {
                  const summary = summaries.get(workspace.id);
                  const lastRun = workspace.last_run;
                  const pending = postDeployOpen(summary);
                  return (
                    <div
                      key={workspace.id}
                      className="flex gap-3 p-3.5 transition-colors hover:bg-muted/30"
                      data-selected={
                        selectedWorkspaceIds.has(workspace.id) || undefined
                      }
                    >
                      <input
                        className="mt-1"
                        type="checkbox"
                        aria-label={`Select ${workspace.name}`}
                        checked={selectedWorkspaceIds.has(workspace.id)}
                        disabled={!canEdit}
                        onChange={() => toggleWorkspace(workspace.id)}
                      />
                      <Link
                        to="/deployments/$id"
                        params={{ id: workspace.id }}
                        className="min-w-0 flex-1"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {workspace.name}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                              {workspace.path || "—"}
                            </div>
                          </div>
                          {lastRun ? (
                            <StatusBadge tone={runTone(lastRun.status)} dot>
                              {lastRun.status || lastRun.action || "—"}
                            </StatusBadge>
                          ) : (
                            <StatusBadge tone="muted">
                              {t("deploy.noRun")}
                            </StatusBadge>
                          )}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                          <div>
                            <div className="text-muted-foreground">
                              Platform
                            </div>
                            <div className="mt-0.5 truncate font-medium text-foreground">
                              {workspace.proxmox_connection?.name ||
                                "Not assigned"}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">
                              Provisioning
                            </div>
                            <div className="mt-0.5 font-mono text-foreground">
                              {summary
                                ? `${summary.started_vm_count}/${summary.vm_count} started`
                                : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">
                              Last run
                            </div>
                            <div className="mt-0.5 truncate text-foreground">
                              {runLabel(lastRun)}
                            </div>
                          </div>
                        </div>
                        {pending > 0 && (
                          <div className="mt-3 text-xs [color:hsl(var(--warning))]">
                            {pending} post-deployment step{pending === 1 ? "" : "s"}{" "}
                            open
                          </div>
                        )}
                      </Link>
                    </div>
                  );
                })}
              </div>
              <div className="table-scroll hidden md:block">
                <table
                  data-density="compact"
                  className="w-full min-w-[980px] text-sm"
                >
                  <thead>
                    <tr>
                      <th className="w-11 px-3">
                        <input
                          type="checkbox"
                          aria-label="Select all deployments"
                          checked={allWorkspacesSelected}
                          disabled={!canEdit}
                          ref={(input) => {
                            if (input)
                              input.indeterminate =
                                someWorkspacesSelected &&
                                !allWorkspacesSelected;
                          }}
                          onChange={toggleAllWorkspaces}
                        />
                      </th>
                      <th className="px-3">Deployment</th>
                      <th className="px-3">Platform</th>
                      <th className="px-3">Provisioning</th>
                      <th className="px-3">Last run</th>
                      <th className="px-3">Status</th>
                      <th className="w-32 px-3 text-right">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspaces.map((workspace) => {
                      const summary = summaries.get(workspace.id);
                      const lastRun = workspace.last_run;
                      const pending = postDeployOpen(summary);
                      return (
                        <tr
                          key={workspace.id}
                          data-selected={
                            selectedWorkspaceIds.has(workspace.id) || undefined
                          }
                        >
                          <td className="px-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${workspace.name}`}
                              checked={selectedWorkspaceIds.has(workspace.id)}
                              disabled={!canEdit}
                              onChange={() => toggleWorkspace(workspace.id)}
                            />
                          </td>
                          <td className="px-3">
                            <div className="font-medium">{workspace.name}</div>
                            <div className="mt-0.5 max-w-[22rem] truncate font-mono text-xs text-muted-foreground">
                              {workspace.path || "—"}
                            </div>
                          </td>
                          <td className="px-3">
                            <div className="flex items-center gap-1.5 font-medium">
                              <Database className="h-3.5 w-3.5 text-muted-foreground" />
                              {workspace.proxmox_connection?.name ||
                                "Not assigned"}
                            </div>
                            <div className="mt-0.5 max-w-[15rem] truncate font-mono text-xs text-muted-foreground">
                              {workspace.proxmox_connection?.endpoint?.replace(
                                /^https?:\/\//,
                                "",
                              ) || "Select a platform in the configuration"}
                            </div>
                          </td>
                          <td className="px-3">
                            <div className="font-mono text-xs tabular-nums">
                              {summary
                                ? `${summary.started_vm_count}/${summary.vm_count} started`
                                : "—"}
                            </div>
                            {pending > 0 && (
                              <div className="mt-0.5 text-xs [color:hsl(var(--warning))]">
                                {pending} steps pending
                              </div>
                            )}
                          </td>
                          <td className="px-3">
                            <div className="text-xs text-foreground">
                              {runLabel(lastRun)}
                            </div>
                            <div className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">
                              {formatDate(
                                lastRun?.completed_at || lastRun?.started_at,
                              ) || "—"}
                            </div>
                          </td>
                          <td className="px-3">
                            {lastRun ? (
                              <StatusBadge tone={runTone(lastRun.status)} dot>
                                {lastRun.status || lastRun.action || "—"}
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="muted">
                                {t("deploy.noRun")}
                              </StatusBadge>
                            )}
                          </td>
                          <td className="px-3 text-right">
                            <Button asChild size="sm" variant="outline">
                              <Link
                                to="/deployments/$id"
                                params={{ id: workspace.id }}
                              >
                                {t("deploy.open")}
                                <ArrowRight />
                              </Link>
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <CreateDeploymentDialog
        environmentId={environmentId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <ConfirmDialog
        open={confirmWorkspaceRemoval}
        onOpenChange={setConfirmWorkspaceRemoval}
        title={
          selectedWorkspaceCount === 1
            ? "Remove deployment from Fleet"
            : `Remove ${selectedWorkspaceCount} deployments from Fleet`
        }
        description="Only the deployment registration and run history are removed. OpenTofu files and provisioned infrastructure remain unchanged."
        confirmLabel="Remove from Fleet"
        confirmTextValue={
          selectedWorkspaceCount > 0
            ? `REMOVE ${selectedWorkspaceCount}`
            : undefined
        }
        confirmInputLabel="Confirmation"
        confirmInputHelp={
          <>
            To confirm, enter{" "}
            <span className="font-mono text-foreground">
              REMOVE {selectedWorkspaceCount}
            </span>.
          </>
        }
        onConfirm={() => removeWorkspaces.mutate([...selectedWorkspaceIds])}
        isPending={removeWorkspaces.isPending}
      />
    </div>
  );
}
