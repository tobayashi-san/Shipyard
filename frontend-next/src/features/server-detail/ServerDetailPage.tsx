import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  RefreshCw,
  CircleDot,
  Cpu,
  HardDrive,
  Clock,
  HeartPulse,
  Box,
  Satellite,
  Boxes,
  ExternalLink,
  Info,
  Terminal,
  Pencil,
  ArrowUp,
  Key,
  Power,
  Play,
  Square,
  CloudDownload,
  FileText,
  RotateCw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Layers,
  Settings2,
  StickyNote,
  Eye,
  Bot,
  Download,
  Shield,
  Sliders,
  History,
  Code2,
  Bell,
  Workflow,
  X,
  Network,
} from "lucide-react";
import { api, apiFetch, ApiError } from "@/lib/api";
import { ws } from "@/lib/ws";
import { useProfile, useSettings, hasCap } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { actionLabel, statusLabel } from "@/lib/history-labels";
import { CreateServerDialog } from "@/components/CreateServerDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, LiveDot } from "@/components/ui/status-badge";
import { Skeleton, SkeletonRow } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  OverflowMenu,
  OverflowItem,
  OverflowSep,
} from "@/components/ui/overflow-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { metricTextClass } from "@/components/ui/metric-bar";
import {
  ActionRunDialog,
  type OutputLine,
  type RunStatus,
} from "@/components/ui/action-run-dialog";
import { CopyButton, StatCard, ThresholdBar } from "./components/summary-cards";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  type AgentStatus,
  type ContainerRow,
  type CustomTask,
  type HistoryRow,
  type IpamReservation,
  type ManagedDeploymentResponse,
  type ServerDetail,
  type ServerInfo,
  CapacitySummary,
  formatBytes,
  formatDate,
  formatUptime,
  HostStorageInventory,
  RecentHostTasks,
  SummaryField,
} from "./server-detail-model";
import { useServerDetailController } from "./useServerDetailController";
import { ServerOverviewTabs } from "./ServerOverviewTabs";
import { ServerDockerTab } from "./ServerDockerTab";
import { ServerUpdatesTab } from "./ServerUpdatesTab";
import { ServerOperationsTabs } from "./ServerOperationsTabs";
import { ServerFilesTab } from "./ServerFilesTab";
import { useUrlTab } from "@/lib/use-url-tab";

const SshTerminal = lazy(() =>
  import("@/components/SshTerminal").then((module) => ({
    default: module.SshTerminal,
  })),
);

// ─── Types ────────────────────────────────────────────────────
export function ServerDetailPage() {
  const controller = useServerDetailController();
  const {
    t,
    qc,
    params,
    id,
    navigate,
    terminalOpen,
    setTerminalOpen,
    editOpen,
    setEditOpen,
    confirmRunUpdate,
    setConfirmRunUpdate,
    confirmResetHostKey,
    setConfirmResetHostKey,
    confirmReboot,
    setConfirmReboot,
    confirmDelete,
    setConfirmDelete,
    confirmDeleteTask,
    setConfirmDeleteTask,
    confirmComposeDown,
    setConfirmComposeDown,
    confirmAgentInstall,
    setConfirmAgentInstall,
    confirmAgentRemove,
    setConfirmAgentRemove,
    confirmRestartContainer,
    setConfirmRestartContainer,
    actionRun,
    setActionRun,
    profile,
    settings,
    agentEnabled,
    timeFormat,
    hour12,
    serverKnown,
    openTofuAvailable,
    deploymentData,
    managedDeployments,
    managedProxmoxDeployment,
    startActionRun,
    rawServer,
    isLoading,
    server,
    info,
    refetchInfo,
    fetchingInfo,
    infoFailed,
    infoError,
    ipamReservationData,
    ipamReservations,
    dockerContainers,
    fetchingDocker,
    rawUpdates,
    history,
    notesData,
    customTasks,
    customTaskList,
    agentStatus,
    refetchAgent,
    imageUpdates,
    setImageUpdates,
    notes,
    setNotes,
    notesEditing,
    setNotesEditing,
    renderedNotes,
    notesTimer,
    saveNotesMut,
    autoSaveNotes,
    runUpdateMut,
    runRebootMut,
    proxmoxRebootMut,
    testConnMut,
    resetHostKeyMut,
    deleteServerMut,
    restartContainerMut,
    logsContainer,
    setLogsContainer,
    logsContent,
    setLogsContent,
    logsTail,
    setLogsTail,
    logsLoading,
    setLogsLoading,
    logsError,
    setLogsError,
    logsRequestRef,
    loadLogs,
    taskDialog,
    setTaskDialog,
    taskForm,
    setTaskForm,
    saveTaskMut,
    deleteTaskMut,
    checkTaskMut,
    runTaskMut,
    checkImageMut,
    checkSystemUpdatesMut,
    composeActionMut,
    composeDialog,
    setComposeDialog,
    confirmDeleteStack,
    setConfirmDeleteStack,
    deleteStackMut,
    openEditCompose,
    saveComposeMut,
    latencyMs,
    setLatencyMs,
    agentUrl,
    setAgentUrl,
    agentCa,
    setAgentCa,
    agentInstallMut,
    agentUpdateMut,
    agentConfigMut,
    agentRotateMut,
    agentRemoveMut,
    agentBusy,
    HIST_PAGE_SIZE,
    histPage,
    setHistPage,
    histItems,
    histTotal,
    histSafe,
    histPage_,
    ramPct,
    diskPct,
    cpuPct,
    healthThresholds,
    updatesList,
    phasedList,
    containers,
    activeLogContainer,
    stacks,
  } = controller;

  const availableTabs = useMemo(() => {
    const values = ["overview", "configuration"];
    if (hasCap(profile, "canViewDocker") && server?.docker_enabled)
      values.push("docker");
    if (
      hasCap(profile, "canViewUpdates") ||
      hasCap(profile, "canRunUpdates") ||
      hasCap(profile, "canRebootServers") ||
      hasCap(profile, "canViewCustomUpdates") ||
      hasCap(profile, "canRunCustomUpdates") ||
      hasCap(profile, "canEditCustomUpdates") ||
      hasCap(profile, "canDeleteCustomUpdates")
    )
      values.push("updates");
    if (hasCap(profile, "canViewServerHistory")) values.push("history");
    if (agentEnabled && profile?.role === "admin") values.push("agent");
    if (hasCap(profile, "canViewNotes")) values.push("notes");
    if (hasCap(profile, "canViewFiles")) values.push("files");
    return values;
  }, [agentEnabled, profile, server?.docker_enabled]);
  const serverTabs = useUrlTab("overview", availableTabs);

  // ── Loading / not found ─────────────────────────────────────
  if (isLoading)
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  if (!server)
    return (
      <EmptyState
        icon={<ArrowLeft className="h-6 w-6" />}
        title={t("det.notFound")}
        action={
          <Button variant="secondary" size="sm" asChild>
            <Link to="/servers">
              <ArrowLeft className="h-4 w-4 mr-1" />
              {t("common.back")}
            </Link>
          </Button>
        }
      />
    );

  // ═══════════════════════════════════════════════════════════
  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <PageHeader
        back={
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              navigate({
                to:
                  (sessionStorage.getItem("shipyard.lastNonDetailRoute") as
                    | "/"
                    | "/servers"
                    | "/playbooks"
                    | "/settings"
                    | "/profile"
                    | null) ?? "/servers",
              })
            }
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        }
        breadcrumbs={
          <>
            <Link
              to="/servers"
              className="transition-colors hover:text-foreground"
            >
              Managed hosts
            </Link>
            <span aria-hidden="true">/</span>
            {server.group_name && (
              <>
                <span>{server.group_name}</span>
                <span aria-hidden="true">/</span>
              </>
            )}
            <span className="font-medium text-foreground" aria-current="page">
              {server.name}
            </span>
          </>
        }
        title={server.name}
        badge={
          server.status === "online" ? (
            <StatusBadge tone="success">
              <LiveDot tone="success" />
              {t("common.online")}
            </StatusBadge>
          ) : server.status === "offline" ? (
            <StatusBadge tone="danger">{t("common.offline")}</StatusBadge>
          ) : (
            <StatusBadge tone="muted">{t("common.unknown")}</StatusBadge>
          )
        }
        description={`${server.ip_address}${server.hostname && server.hostname !== server.ip_address ? ` · ${server.hostname}` : ""}`}
        actions={
          <>
            {server.status !== "online" &&
              hasCap(profile, "canEditServers") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => testConnMut.mutate()}
                  disabled={testConnMut.isPending}
                >
                  <Satellite
                    className={`h-3.5 w-3.5 ${testConnMut.isPending ? "animate-pulse" : ""}`}
                  />
                  Test connection
                </Button>
              )}
            {hasCap(profile, "canUseTerminal") && (
              <Button size="sm" onClick={() => setTerminalOpen(true)}>
                <Terminal className="h-3.5 w-3.5 mr-1" />
                {t("common.terminal")}
              </Button>
            )}
            <OverflowMenu width="w-52">
              {hasCap(profile, "canEditServers") && (
                <>
                  <OverflowItem icon={Pencil} onClick={() => setEditOpen(true)}>
                    {t("common.edit")}
                  </OverflowItem>
                  <OverflowSep />
                </>
              )}
              {hasCap(profile, "canRunUpdates") && (
                <OverflowItem
                  icon={ArrowUp}
                  onClick={() => setConfirmRunUpdate(true)}
                >
                  {t("det.updates")}
                </OverflowItem>
              )}
              {hasCap(profile, "canUseTerminal") && (
                <OverflowItem
                  icon={Key}
                  onClick={() => setConfirmResetHostKey(true)}
                >
                  {t("srv.resetHostKey")}
                </OverflowItem>
              )}
              {hasCap(profile, "canRebootServers") && (
                <>
                  <OverflowSep />
                  <OverflowItem
                    icon={Power}
                    warning
                    onClick={() => setConfirmReboot(true)}
                  >
                    {t("det.reboot")}
                  </OverflowItem>
                </>
              )}
              {hasCap(profile, "canDeleteServers") && (
                <>
                  <OverflowSep />
                  <OverflowItem
                    icon={Trash2}
                    danger
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("common.delete")}
                  </OverflowItem>
                </>
              )}
            </OverflowMenu>
            {hasCap(profile, "canEditServers") && (
              <CreateServerDialog
                editServer={server}
                open={editOpen}
                onOpenChange={setEditOpen}
                onSuccess={() => {
                  qc.invalidateQueries({ queryKey: ["server", id] });
                }}
              />
            )}
            <ConfirmDialog
              open={confirmRunUpdate}
              onOpenChange={setConfirmRunUpdate}
              title={t("det.updates")}
              description={t("det.confirmUpdate", { name: server.name })}
              confirmLabel={t("det.updates")}
              onConfirm={() => runUpdateMut.mutate()}
              isPending={runUpdateMut.isPending}
            />
            <ConfirmDialog
              open={confirmResetHostKey}
              onOpenChange={setConfirmResetHostKey}
              title={t("srv.resetHostKeyConfirmTitle")}
              description={t("srv.resetHostKeyConfirmBody")}
              confirmLabel={t("srv.resetHostKeyConfirmText")}
              variant="destructive"
              onConfirm={() => resetHostKeyMut.mutate()}
              isPending={resetHostKeyMut.isPending}
            />
            <ConfirmDialog
              open={confirmReboot}
              onOpenChange={setConfirmReboot}
              title={t("det.reboot")}
              description={
                managedProxmoxDeployment
                  ? `Fleet restarts “${server.name}” directly through the linked Proxmox platform. SSH access is not required.`
                  : t("det.confirmReboot", { name: server.name })
              }
              confirmLabel={t("det.reboot")}
              variant="warning"
              onConfirm={() =>
                managedProxmoxDeployment
                  ? proxmoxRebootMut.mutate()
                  : runRebootMut.mutate()
              }
              isPending={
                managedProxmoxDeployment
                  ? proxmoxRebootMut.isPending
                  : runRebootMut.isPending
              }
            />
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={t("common.delete")}
              description={t("det.confirmDeleteServer", { name: server.name })}
              confirmLabel={t("common.delete")}
              variant="destructive"
              confirmTextValue={server.name}
              confirmInputLabel="Confirm managed host name"
              onConfirm={() => deleteServerMut.mutate()}
              isPending={deleteServerMut.isPending}
            />
            <ConfirmDialog
              open={confirmAgentInstall}
              onOpenChange={setConfirmAgentInstall}
              title={t("det.agentInstall")}
              description={t("det.agentInstallConfirm")}
              confirmLabel={t("det.agentInstall")}
              onConfirm={() => agentInstallMut.mutate()}
              isPending={agentInstallMut.isPending}
            />
            <ConfirmDialog
              open={confirmAgentRemove}
              onOpenChange={setConfirmAgentRemove}
              title={t("det.agentRemove")}
              description={t("det.agentRemoveConfirm")}
              confirmLabel={t("det.agentRemove")}
              variant="destructive"
              confirmTextValue={server.name}
              confirmInputLabel="Confirm managed host name"
              onConfirm={() => agentRemoveMut.mutate()}
              isPending={agentRemoveMut.isPending}
            />
            <ConfirmDialog
              open={!!confirmRestartContainer}
              onOpenChange={(open) => {
                if (!open) setConfirmRestartContainer(null);
              }}
              title={t("common.restart")}
              description={
                confirmRestartContainer
                  ? t("det.confirmRestartContainer", {
                      name: confirmRestartContainer,
                    })
                  : ""
              }
              confirmLabel={t("common.restart")}
              variant="warning"
              onConfirm={() => {
                if (confirmRestartContainer)
                  restartContainerMut.mutate(confirmRestartContainer);
                setConfirmRestartContainer(null);
              }}
              isPending={restartContainerMut.isPending}
            />
          </>
        }
      />

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <Tabs
        value={serverTabs.value}
        onValueChange={serverTabs.onValueChange}
        className="space-y-4"
      >
        <TabsList aria-label="Host sections" className="console-tabs">
          <TabsTrigger value="overview">{t("det.tabOverview")}</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          {hasCap(profile, "canViewDocker") && !!server.docker_enabled && (
            <TabsTrigger value="docker">{t("det.tabDocker")}</TabsTrigger>
          )}
          {(hasCap(profile, "canViewUpdates") ||
            hasCap(profile, "canRunUpdates") ||
            hasCap(profile, "canRebootServers") ||
            hasCap(profile, "canViewCustomUpdates") ||
            hasCap(profile, "canRunCustomUpdates") ||
            hasCap(profile, "canEditCustomUpdates") ||
            hasCap(profile, "canDeleteCustomUpdates")) && (
            <TabsTrigger value="updates">{t("det.tabUpdates")}</TabsTrigger>
          )}
          {hasCap(profile, "canViewFiles") && (
            <TabsTrigger value="files">Files</TabsTrigger>
          )}
          {hasCap(profile, "canViewServerHistory") && (
            <TabsTrigger value="history">{t("det.tabHistory")}</TabsTrigger>
          )}
          {agentEnabled && profile?.role === "admin" && (
            <TabsTrigger value="agent">{t("det.tabAgent")}</TabsTrigger>
          )}
          {hasCap(profile, "canViewNotes") && (
            <TabsTrigger value="notes" className="gap-1">
              <StickyNote className="h-3 w-3" />
              {t("det.tabNotes")}
              {server.notes?.trim() && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </TabsTrigger>
          )}
        </TabsList>

        <ServerOverviewTabs controller={controller} />
        <ServerDockerTab controller={controller} />
        <ServerUpdatesTab controller={controller} />
        {hasCap(profile, "canViewFiles") && (
          <TabsContent value="files" className="space-y-4">
            <ServerFilesTab serverId={id} profile={profile} />
          </TabsContent>
        )}
        <ServerOperationsTabs controller={controller} />
      </Tabs>

      {/* Custom task dialog */}
      <Dialog
        open={taskDialog.open}
        onOpenChange={(v) => {
          if (!v) setTaskDialog({ open: false, task: null });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {taskDialog.task ? t("det.editTask") : t("det.addTask")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("det.taskName")}</Label>
              <Input
                value={taskForm.name}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>{t("det.taskType")}</Label>
              <select
                value={taskForm.type}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, type: e.target.value }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="script">{t("det.taskTypeScript")}</option>
                <option value="github">{t("det.taskTypeGithub")}</option>
                <option value="trigger">{t("det.taskTypeTrigger")}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {taskForm.type === "github"
                  ? t("det.taskTypeGithubDesc")
                  : taskForm.type === "trigger"
                    ? t("det.taskTypeTriggerDesc")
                    : t("det.taskTypeScriptDesc")}
              </p>
            </div>
            {taskForm.type === "github" && (
              <div className="space-y-1">
                <Label>{t("det.taskGithubRepo")}</Label>
                <Input
                  value={taskForm.github_repo}
                  onChange={(e) =>
                    setTaskForm((f) => ({ ...f, github_repo: e.target.value }))
                  }
                  placeholder="owner/repo"
                  className="font-mono"
                />
              </div>
            )}
            {taskForm.type === "trigger" && (
              <div className="space-y-1">
                <Label>{t("det.taskTriggerOutput")}</Label>
                <Input
                  value={taskForm.trigger_output}
                  onChange={(e) =>
                    setTaskForm((f) => ({
                      ...f,
                      trigger_output: e.target.value,
                    }))
                  }
                  placeholder="AVAILABLE"
                  className="font-mono"
                />
              </div>
            )}
            {taskForm.type === "script" && (
              <div className="space-y-1">
                <Label>{t("det.taskLatestCommand")}</Label>
                <Input
                  value={taskForm.latest_command}
                  onChange={(e) =>
                    setTaskForm((f) => ({
                      ...f,
                      latest_command: e.target.value,
                    }))
                  }
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t("det.taskLatestCommandHint")}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t("det.taskCheckCommand")}</Label>
              <Input
                value={taskForm.check_command}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, check_command: e.target.value }))
                }
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label>{t("det.taskUpdateCommand")}</Label>
              <Input
                value={taskForm.update_command}
                onChange={(e) =>
                  setTaskForm((f) => ({ ...f, update_command: e.target.value }))
                }
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setTaskDialog({ open: false, task: null })}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!taskForm.name.trim()) {
                  showToast(t("det.taskNameRequired"), "error");
                  return;
                }
                saveTaskMut.mutate();
              }}
              disabled={saveTaskMut.isPending}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Compose editor dialog */}
      <Dialog
        open={composeDialog.open}
        onOpenChange={(v) => {
          if (!v) setComposeDialog((prev) => ({ ...prev, open: false }));
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {composeDialog.mode === "edit"
                ? t("det.editCompose")
                : t("det.addComposeStack")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {composeDialog.mode === "add" && (
              <div className="space-y-1">
                <Label>{t("det.composePath")}</Label>
                <Input
                  value={composeDialog.dir}
                  onChange={(e) =>
                    setComposeDialog((prev) => ({
                      ...prev,
                      dir: e.target.value,
                    }))
                  }
                  placeholder="/opt/myapp"
                  className="font-mono"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>docker-compose.yml</Label>
              {composeDialog.loading ? (
                <div className="space-y-1 py-2">
                  <SkeletonRow cols={3} />
                  <SkeletonRow cols={3} />
                  <SkeletonRow cols={3} />
                </div>
              ) : (
                <Textarea
                  value={composeDialog.content}
                  onChange={(e) =>
                    setComposeDialog((prev) => ({
                      ...prev,
                      content: e.target.value,
                    }))
                  }
                  rows={20}
                  className="font-mono text-xs"
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() =>
                setComposeDialog((prev) => ({ ...prev, open: false }))
              }
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (!composeDialog.dir.trim()) {
                  showToast(t("det.composePathRequired"), "error");
                  return;
                }
                saveComposeMut.mutate();
              }}
              disabled={saveComposeMut.isPending || composeDialog.loading}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SSH Terminal overlay */}
      {terminalOpen && (
        <Suspense
          fallback={
            <div className="p-4 text-sm text-muted-foreground">
              {t("common.loading")}
            </div>
          }
        >
          <SshTerminal server={server} onClose={() => setTerminalOpen(false)} />
        </Suspense>
      )}
      <ActionRunDialog
        open={!!actionRun}
        title={actionRun?.title || t("det.output")}
        status={actionRun?.status || "running"}
        lines={actionRun?.lines || []}
        onClose={() => setActionRun(null)}
      />
      <ConfirmDialog
        open={!!confirmDeleteTask}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteTask(null);
        }}
        title={t("common.delete")}
        description={t("det.confirmDeleteTask", {
          name: confirmDeleteTask?.name || "",
        })}
        confirmLabel={t("common.delete")}
        variant="destructive"
        confirmTextValue={confirmDeleteTask?.name || ""}
        confirmInputLabel="Confirm task name"
        onConfirm={() => {
          if (confirmDeleteTask) deleteTaskMut.mutate(confirmDeleteTask.id);
        }}
        isPending={deleteTaskMut.isPending}
      />
      <ConfirmDialog
        open={!!confirmComposeDown}
        onOpenChange={(open) => {
          if (!open) setConfirmComposeDown(null);
        }}
        title="Compose down"
        description={`Stop and remove containers for "${confirmComposeDown?.proj || ""}".`}
        confirmLabel="Down"
        variant="destructive"
        confirmTextValue={confirmComposeDown?.proj || ""}
        confirmInputLabel="Confirm stack name"
        onConfirm={() => {
          if (confirmComposeDown)
            composeActionMut.mutate({
              dir: confirmComposeDown.dir,
              action: "down",
            });
        }}
        isPending={composeActionMut.isPending}
      />
      <ConfirmDialog
        open={!!confirmDeleteStack}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteStack(null);
        }}
        title={t("det.removeStack")}
        description={t("det.confirmRemoveStack", {
          name: confirmDeleteStack?.proj || "",
        })}
        confirmLabel={t("common.delete")}
        variant="destructive"
        confirmTextValue={confirmDeleteStack?.proj || ""}
        confirmInputLabel="Confirm stack name"
        onConfirm={() => {
          if (confirmDeleteStack) deleteStackMut.mutate(confirmDeleteStack.dir);
        }}
        isPending={deleteStackMut.isPending}
      />
    </div>
  );

}
