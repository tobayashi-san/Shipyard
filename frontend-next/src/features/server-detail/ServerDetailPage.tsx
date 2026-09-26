import { CreateServerDialog } from "@/components/CreateServerDialog";
import {
  ActionRunDialog
} from "@/components/ui/action-run-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OverflowItem,
  OverflowMenu,
  OverflowSep,
} from "@/components/ui/overflow-menu";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton, SkeletonRow } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { hasCap } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { useUrlTab } from "@/lib/use-url-tab";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUp,
  Key,
  Pencil,
  Power,
  Satellite,
  Terminal,
  Trash2
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo
} from "react";
import { HostSnapshots } from './HostSnapshots';
import { ServerDockerTab } from "./ServerDockerTab";
import { ServerFilesTab } from "./ServerFilesTab";
import { ServerOperationsTabs } from "./ServerOperationsTabs";
import { ServerOverviewTabs } from "./ServerOverviewTabs";
import { ServerUpdatesTab } from "./ServerUpdatesTab";
import { ComposeTemplateButton } from './components/ComposeTemplateButton';
import { ComposeValidation } from "./components/ComposeValidation";
import { CustomUpdateDialog } from './components/CustomUpdateDialog';
import { OsUpdateImpact } from './components/OsUpdateImpact';
import { useServerDetailController } from "./useServerDetailController";

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
    confirmRestartContainer,
    setConfirmRestartContainer,
    actionRun,
    setActionRun,
    profile,
    managedDeployments,
    managedProxmoxDeployment,
    isLoading,
    server,
    info,
    runUpdateMut,
    runRebootMut,
    proxmoxRebootMut,
    testConnMut,
    resetHostKeyMut,
    deleteServerMut,
    restartContainerMut,
    deleteTaskMut,
    composeActionMut,
    composeDialog,
    setComposeDialog,
    confirmDeleteStack,
    setConfirmDeleteStack,
    deleteStackMut,
    openEditCompose,
    saveComposeMut,
    updatesList,
    phasedList,
  } = controller;

  const linkedVm = managedDeployments.find(deployment => deployment.cluster_id && deployment.vm?.node_name && deployment.vm.vm_id != null);
  const availableTabs = useMemo(() => {
    const values = ["overview", "snapshots"];
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
    if (hasCap(profile, "canViewNotes")) values.push("notes");
    if (hasCap(profile, "canViewFiles")) values.push("files");
    if (hasCap(profile, "canUseTerminal")) values.push("terminal");
    return values;
  }, [profile, server?.docker_enabled]);
  const serverTabs = useUrlTab("overview", availableTabs);
  useEffect(() => {
    if (serverTabs.value === 'terminal') setTerminalOpen(true);
  }, [serverTabs.value, setTerminalOpen]);

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
            aria-label={t("common.back")}
            onClick={() =>
              navigate({
                to:
                  (sessionStorage.getItem("fleet.lastNonDetailRoute") as
                    | "/"
                    | "/infrastructure"
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
              Hosts
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
          server.deployment && server.deployment.deployment_phase !== 'ready' ? (
            <StatusBadge tone={server.deployment.status === 'failed' ? 'danger' : 'muted'}>{!server.ip_address ? 'Waiting for IP' : server.deployment.status === 'failed' ? 'Connection or deployment failed' : server.deployment.deployment_phase === 'connect_host' ? 'Checking connection' : 'Finishing deployment'}</StatusBadge>
          ) : server.status === "online" ? (
            <StatusBadge tone="success" dot>
              {t("common.online")}
            </StatusBadge>
          ) : server.status === "offline" ? (
            <StatusBadge tone="danger">{t("common.offline")}</StatusBadge>
          ) : (
            <StatusBadge tone="muted">{t("common.unknown")}</StatusBadge>
          )
        }
        description={[server.ip_address, server.hostname !== server.ip_address && server.hostname !== server.name ? server.hostname : null].filter(Boolean).join(" · ") || "Host address not reported"}
        actions={
          <>
            {server.deployment && <Button asChild variant="outline"><Link to="/deployments/$id" params={{id:server.deployment.id}}>Open deployment</Link></Button>}
            {/* The primary action follows what is pending; editing lives in the overflow menu. */}
            {availableTabs.includes("terminal") && serverTabs.value !== "terminal" && server.status === "online" && <Button variant="outline" aria-label="Terminal" onClick={() => serverTabs.onValueChange("terminal")}><Terminal /><span className="hidden sm:inline">Terminal</span></Button>}
            {hasCap(profile, "canRunUpdates") && updatesList.length > 0 && server.status === "online" && serverTabs.value !== "updates" && <Button onClick={() => setConfirmRunUpdate(true)}><ArrowUp />Install updates ({updatesList.length})</Button>}
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
                  {t("det.testConn")}
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
              description={<div className="space-y-3"><p>{t("det.confirmUpdate", { name: server.name })}</p><OsUpdateImpact available={updatesList.length} deferred={phasedList.length} rebootRequired={info?.reboot_required} /><p className="text-xs">Counts reflect the last check. The package manager resolves the actual changes when the update runs.</p></div>}
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
              confirmInputLabel={t("det.confirmHostName")}
              onConfirm={() => deleteServerMut.mutate()}
              isPending={deleteServerMut.isPending}
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
          <TabsList aria-label="Host sections">
            <TabsTrigger value="overview">{t("det.tabOverview")}</TabsTrigger>
            {availableTabs.includes("updates") && <TabsTrigger value="updates">Updates</TabsTrigger>}
            {availableTabs.includes("docker") && <TabsTrigger value="docker">Workloads</TabsTrigger>}
            {availableTabs.includes("terminal") && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
            {availableTabs.includes("files") && <TabsTrigger value="files">Files</TabsTrigger>}
            <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
            {availableTabs.includes("history") && <TabsTrigger value="history">Jobs</TabsTrigger>}
            {availableTabs.includes("notes") && <TabsTrigger value="notes">Notes</TabsTrigger>}
          </TabsList>

        <TabsContent value="snapshots">{controller.deploymentContextLoading ? <p role="status">Loading snapshot connection…</p> : controller.deploymentContextFailed ? <div role="alert"><p>Snapshot connection could not be loaded.</p><Button variant="outline" onClick={() => void controller.refetchDeploymentContext()}>Try again</Button></div> : <HostSnapshots mapping={linkedVm} />}</TabsContent>
        <ServerOverviewTabs controller={controller} />
        <ServerDockerTab controller={controller} />
        <ServerUpdatesTab controller={controller} />
        {hasCap(profile, "canUseTerminal") && <TabsContent value="terminal" forceMount className="space-y-3 data-[state=inactive]:hidden">
          <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setConfirmResetHostKey(true)}><Key />{t('srv.resetHostKey')}</Button></div>
          {terminalOpen ? <Suspense fallback={<p role="status">{t("common.loading")}</p>}><SshTerminal key={id} embedded server={server} onClose={() => setTerminalOpen(false)} /></Suspense> : <Button onClick={() => setTerminalOpen(true)}><Terminal />{t("det.openTerminal")}</Button>}
        </TabsContent>}
        {hasCap(profile, "canViewFiles") && <TabsContent value="files"><ServerFilesTab serverId={id} profile={profile} /></TabsContent>}
        <ServerOperationsTabs controller={controller} />
      </Tabs>

      <CustomUpdateDialog controller={controller} />

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
            <p className="break-words text-sm">Target host: <strong>{server.name}</strong>{composeDialog.mode === "edit" && <><br /><span className="font-mono text-xs">{composeDialog.dir.replace(/\/$/, "")}/docker-compose.yml</span></>}</p>
            <p className="text-sm text-muted-foreground">Save writes docker-compose.yml to this host after local YAML and basic structure validation. It does not start, restart or recreate containers. Use the stack's Start / apply changes action separately; this may recreate containers. Runtime checks cover environment variables, referenced files and Compose compatibility.</p>
            {composeDialog.mode === "add" && <ComposeTemplateButton content={composeDialog.content} disabled={composeDialog.loading || saveComposeMut.isPending} onInsert={content => setComposeDialog(previous => previous.content.trim() ? previous : {...previous, content})} />}
            <ComposeValidation hostId={id} content={composeDialog.content} disabled={composeDialog.loading || saveComposeMut.isPending} />
            {saveComposeMut.isError && <p role="alert" className="text-sm text-destructive">{saveComposeMut.error.message}</p>}
            {composeDialog.mode === "add" && (
              <div className="space-y-1">
                <Label htmlFor="compose-directory">{t("det.composePath")}</Label>
                <Input
                  id="compose-directory"
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
              <Label htmlFor="compose-content">docker-compose.yml</Label>
              {composeDialog.loading ? (
                <div className="space-y-1 py-2">
                  <SkeletonRow cols={3} />
                  <SkeletonRow cols={3} />
                  <SkeletonRow cols={3} />
                </div>
              ) : composeDialog.loadError ? (
                <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
                  <p className="text-destructive">{composeDialog.loadError}</p>
                  <p className="text-muted-foreground">The file was not loaded. Retry before editing or saving.</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void openEditCompose(composeDialog.dir)}>Retry loading</Button>
                </div>
              ) : (
                <Textarea
                  id="compose-content"
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
              disabled={saveComposeMut.isPending || composeDialog.loading || Boolean(composeDialog.loadError)}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
