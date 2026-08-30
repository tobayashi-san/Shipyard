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
  TriangleAlert,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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


import type { ServerDetailController } from "./useServerDetailController";

export function ServerOverviewTabs({ controller }: { controller: ServerDetailController }) {
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

  if (!server) return null;

  return (
    <>
        {/* ════ OVERVIEW ════ */}
        <TabsContent value="overview" className="space-y-4">
          {server.attention?.requiresAttention && (
            <Alert variant={server.attention.severity === "critical" ? "destructive" : "warning"}>
              <TriangleAlert className="h-4 w-4" />
              <AlertTitle>Host needs attention</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {server.attention.reasons.map((reason) => (
                    <li key={reason.code}>
                      {reason.code === "reboot_required" && "A reboot is required to finish applying system changes."}
                      {reason.code === "failed_operations" && `${reason.count} of the four most recent operations ${reason.count === 1 ? "has" : "have"} failed.`}
                      {reason.code === "offline" && "The host is not reachable."}
                      {reason.code === "active_alerts" && `${reason.count} active resource ${reason.count === 1 ? "alert requires" : "alerts require"} review.`}
                      {reason.code === "os_updates" && `${reason.count} operating system ${reason.count === 1 ? "update is" : "updates are"} available.`}
                      {reason.code === "image_updates" && `${reason.count} container image ${reason.count === 1 ? "update is" : "updates are"} available.`}
                      {reason.code === "custom_updates" && `${reason.count} custom ${reason.count === 1 ? "update is" : "updates are"} available.`}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {/* Host-client summary: operator identity and live capacity share a
              single object header instead of scattered statistic tiles. */}
          <section className="console-object-summary">
            <div className="grid xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)]">
              <div className="console-object-summary-main">
                <div className="flex items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <HeartPulse className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">
                      Host summary
                    </h2>
                  </div>
                  <StatusBadge
                    tone={
                      server.status === "online"
                        ? "success"
                        : server.status === "offline"
                          ? "danger"
                          : "muted"
                    }
                    dot
                  >
                    {server.status === "online"
                      ? t("common.online")
                      : server.status === "offline"
                        ? t("common.offline")
                        : t("common.unknown")}
                  </StatusBadge>
                </div>
                <dl className="console-object-info-grid xl:grid-cols-3">
                  <SummaryField
                    label="Connection"
                    value={
                      server.status === "online"
                        ? "Reachable"
                        : server.status === "offline"
                          ? "Not reachable"
                          : "Status unknown"
                    }
                    tone={
                      server.status === "online"
                        ? "success"
                        : server.status === "offline"
                          ? "danger"
                          : "info"
                    }
                  />
                  <SummaryField
                    label={t("det.tabUpdates")}
                    value={
                      server.status === "offline"
                        ? "Not checked"
                        : server.attention?.reasons.some((reason) => reason.code === "reboot_required")
                          ? "Reboot required"
                        : updatesList.length === 0
                          ? t("det.statusHealthy")
                          : `${updatesList.length} ${t("det.statusAttention")}`
                    }
                    tone={
                      server.status === "offline"
                        ? "info"
                        : server.attention?.reasons.some((reason) => reason.code === "reboot_required")
                          ? "warning"
                        : updatesList.length > 0
                          ? "warning"
                          : "success"
                    }
                  />
                  <SummaryField
                    label={t("det.latency")}
                    value={
                      server.status === "offline"
                        ? "Not measurable"
                        : latencyMs !== null
                          ? `${latencyMs} ms`
                          : "—"
                    }
                    mono
                    tone={
                      server.status === "online" && latencyMs !== null
                        ? latencyMs >= 250
                          ? "warning"
                          : "success"
                        : undefined
                    }
                  />
                  <SummaryField
                    label="Management"
                    value={
                      managedProxmoxDeployment
                        ? `Shipyard + Proxmox · ${managedProxmoxDeployment.vm?.node_name || "—"}`
                        : "Shipyard via SSH"
                    }
                    tone="info"
                  />
                  <SummaryField label={t("det.os")} value={info?.os || "—"} />
                  <SummaryField label={t("det.cpu")} value={info?.cpu || "—"} />
                  <SummaryField
                    label={t("det.uptime")}
                    value={
                      info?.uptime_seconds
                        ? formatUptime(info.uptime_seconds)
                        : "—"
                    }
                    mono
                  />
                </dl>
              </div>
              <div className="console-object-capacity border-t xl:border-l xl:border-t-0">
                <div className="flex items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">
                      {t("det.resources")}
                    </h2>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => refetchInfo()}
                    disabled={fetchingInfo}
                    aria-label={t("common.refresh")}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${fetchingInfo ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
                <div className="mt-3 space-y-3">
                  <CapacitySummary
                    label={t("det.cpu")}
                    value={cpuPct === null ? "—" : `${cpuPct}%`}
                    pct={cpuPct}
                    warningAt={healthThresholds.cpu}
                  />
                  <CapacitySummary
                    label={t("det.ram")}
                    value={`${formatBytes(info?.ram_used_mb)} / ${formatBytes(info?.ram_total_mb)}${ramPct !== null ? ` · ${ramPct}%` : ""}`}
                    pct={ramPct}
                    warningAt={healthThresholds.ram}
                  />
                  <CapacitySummary
                    label={t("det.disk")}
                    value={`${info?.disk_used_gb?.toFixed(1) ?? "—"} / ${info?.disk_total_gb?.toFixed(1) ?? "—"} GB${diskPct !== null ? ` · ${diskPct}%` : ""}`}
                    pct={diskPct}
                    warningAt={healthThresholds.disk}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Quick links */}
          {(server.links || []).length > 0 && (
            <Card>
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm">{t("det.quickLinks")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2 px-4 py-3">
                {server.links!.map((l, i) => (
                  <a
                    key={i}
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    {l.name} <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </CardContent>
            </Card>
          )}

          <RecentHostTasks history={histItems} hour12={hour12} />
        </TabsContent>

        {/* ════ CONFIGURATION ════
            Static access, provisioning and storage facts deliberately live
            outside the operational overview. This keeps the first tab useful
            during an incident and mirrors the VM / Node object structure. */}
        <TabsContent value="configuration" className="space-y-4">
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {/* The summary above is the live hardware view.  Keep this pane
                deliberately to static operating-system and access facts so
                CPU, uptime and capacity do not appear twice on one object page. */}
            <Card>
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Settings2 className="h-4 w-4" />
                  System & access
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {infoFailed && (
                  <div className="m-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
                    <span>{t("det.infoUnavailable")}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2"
                      onClick={() => refetchInfo()}
                      disabled={fetchingInfo}
                    >
                      {t("common.retry")}
                    </Button>
                  </div>
                )}
                <dl className="console-properties">
                  <div className="console-property">
                    <dt>Verwaltungsmodus</dt>
                    <dd>
                      {managedProxmoxDeployment
                        ? "Shipyard + Proxmox"
                        : "Shipyard via SSH"}
                      {agentEnabled && agentStatus?.installed
                        ? " · Agent active"
                        : ""}
                    </dd>
                  </div>
                  {server.group_name && (
                    <div className="console-property">
                      <dt>Folder</dt>
                      <dd>{server.group_name}</dd>
                    </div>
                  )}
                  {(
                    [
                      [t("det.os"), info?.os],
                      [t("det.kernel"), info?.kernel],
                      [t("det.loadAvg"), info?.load_avg],
                    ] as [string, string | number | null | undefined][]
                  ).map(([k, v]) => (
                    <div key={k} className="console-property">
                      <dt>{k}</dt>
                      <dd className="font-medium tabular-nums">{v ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
                <div className="border-t">
                  <div className="console-section-title">
                    <Network className="h-4 w-4" />
                    {t("det.network")}
                  </div>
                  <dl className="console-properties">
                    <div className="console-property">
                      <dt>{t("det.ipAddress")}</dt>
                      <dd className="flex items-center justify-end gap-1 font-mono text-xs">
                        {server.ip_address || "—"}
                        <CopyButton
                          value={server.ip_address || ""}
                          label={t("det.ipAddress")}
                        />
                      </dd>
                    </div>
                    {ipamReservations.map((reservation) => (
                      <div key={reservation.id} className="console-property">
                        <dt>IPAM</dt>
                        <dd className="min-w-0 text-right text-xs">
                          <Link
                            to="/networks/$id"
                            params={{ id: reservation.subnet_id }}
                            className="font-mono text-primary hover:underline"
                          >
                            {reservation.address}
                          </Link>
                          <span className="ml-1 text-muted-foreground">
                            ·{" "}
                            {reservation.subnet_name ||
                              reservation.subnet_cidr ||
                              "Prefix"}
                          </span>
                        </dd>
                      </div>
                    ))}
                    {server.hostname && (
                      <div className="console-property">
                        <dt>{t("det.hostname")}</dt>
                        <dd className="flex items-center justify-end gap-1 font-mono text-xs">
                          {server.hostname}
                          <CopyButton
                            value={server.hostname}
                            label={t("det.hostname")}
                          />
                        </dd>
                      </div>
                    )}
                    <div className="console-property">
                      <dt>{t("det.sshPort")}</dt>
                      <dd className="font-mono text-xs">
                        {server.ssh_port || 22}
                      </dd>
                    </div>
                    <div className="console-property">
                      <dt>{t("det.sshUser")}</dt>
                      <dd className="font-mono text-xs">
                        {server.ssh_user || "root"}
                      </dd>
                    </div>
                  </dl>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Workflow className="h-4 w-4" />
                  Management & provisioning
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {managedDeployments.length === 0 ? (
                  <div className="px-4 py-5 text-sm text-muted-foreground">
                    This host is not linked to a platform VM or declarative
                    deployment.
                  </div>
                ) : (
                  <div className="divide-y">
                    {managedDeployments.map((deployment) => {
                      const hasVmRoute = Boolean(
                        deployment.connection_id &&
                          deployment.cluster_id &&
                          deployment.vm?.node_name &&
                          deployment.vm?.vm_id != null,
                      );
                      const source =
                        deployment.kind === "inventory"
                          ? "Adopted Proxmox VM"
                          : "OpenTofu deployment";
                      return (
                        <div
                          key={`${deployment.workspace_id || "inventory"}:${deployment.resource_key}`}
                          className="px-4 py-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {source}
                              </div>
                              <div className="mt-1 font-medium">
                                {deployment.kind === "inventory"
                                  ? `Proxmox · ${deployment.workspace_name}`
                                  : deployment.workspace_name}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
                                {deployment.vm?.node_name && (
                                  <span>
                                    {t("det.node")}: {deployment.vm.node_name}
                                  </span>
                                )}
                                {deployment.vm?.vm_id != null && (
                                  <span>VM-ID: {deployment.vm.vm_id}</span>
                                )}
                                {deployment.vm?.post_deploy_playbooks
                                  ?.length ? (
                                  <span>
                                    {t("det.postDeploySteps", {
                                      count:
                                        deployment.vm.post_deploy_playbooks
                                          .length,
                                    })}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {hasVmRoute ? (
                              <Button variant="outline" size="sm" asChild>
                                <Link
                                  to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                                  params={{
                                    clusterId: deployment.cluster_id!,
                                    nodeName: deployment.vm!.node_name!,
                                    vmId: String(deployment.vm!.vm_id),
                                  }}
                                >
                                  Open Proxmox VM
                                </Link>
                              </Button>
                            ) : (
                              <Button variant="outline" size="sm" asChild>
                                <Link
                                  to={
                                    deployment.kind === "inventory"
                                      ? "/infrastructure"
                                      : "/deployments"
                                  }
                                >
                                  {deployment.kind === "inventory"
                                    ? "Open infrastructure"
                                    : t("det.openDeployment")}
                                </Link>
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* VMware-style detail pane: capacity is intentionally shown once
              in the overview. This full-width section only exposes individual
              storage objects that an operator can inspect; it must not leave
              an empty second grid column beneath the access/configuration cards. */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <HardDrive className="h-4 w-4" />
                Storage
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => refetchInfo()}
                disabled={fetchingInfo}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${fetchingInfo ? "animate-spin" : ""}`}
                />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {infoFailed ? (
                <div className="m-4 flex min-h-28 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                  <span>{t("det.infoUnavailable")}</span>
                  <span className="max-w-sm text-xs">
                    {infoError instanceof ApiError
                      ? infoError.message
                      : t("det.offlineHint")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchInfo()}
                    disabled={fetchingInfo}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${fetchingInfo ? "animate-spin" : ""}`}
                    />
                    {t("common.retry")}
                  </Button>
                </div>
              ) : !info ? (
                <p className="p-5 text-center text-sm text-muted-foreground">
                  {t("det.offline")}
                </p>
              ) : (
                <HostStorageInventory
                  info={info}
                  warningAt={healthThresholds.storage}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

    </>
  );
}
