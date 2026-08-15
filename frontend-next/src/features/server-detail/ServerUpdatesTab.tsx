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


import type { ServerDetailController } from "./useServerDetailController";

export function ServerUpdatesTab({ controller }: { controller: ServerDetailController }) {
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

  return (
    <>
        {/* ════ UPDATES ════ */}
        {(hasCap(profile, "canViewUpdates") ||
          hasCap(profile, "canRunUpdates") ||
          hasCap(profile, "canRebootServers") ||
          hasCap(profile, "canViewCustomUpdates") ||
          hasCap(profile, "canRunCustomUpdates") ||
          hasCap(profile, "canEditCustomUpdates") ||
          hasCap(profile, "canDeleteCustomUpdates")) && (
          <TabsContent value="updates" className="space-y-4">
            {hasCap(profile, "canViewUpdates") && (
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <CardTitle className="text-sm">
                    {t("det.tabUpdates")}
                  </CardTitle>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => checkSystemUpdatesMut.mutate()}
                    disabled={checkSystemUpdatesMut.isPending}
                  >
                    <RefreshCw
                      className={`mr-1 h-3.5 w-3.5 ${checkSystemUpdatesMut.isPending ? "animate-spin" : ""}`}
                    />
                    {checkSystemUpdatesMut.isPending
                      ? t("det.checkingSystemUpdates")
                      : t("det.checkUpdates")}
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  {checkSystemUpdatesMut.isPending && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="flex items-center gap-3 border-y border-primary/20 bg-primary/5 px-4 py-3 text-sm"
                    >
                      <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">
                          {t("det.checkingSystemUpdates")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("det.checkingSystemUpdatesHint")}
                        </p>
                      </div>
                    </div>
                  )}
                  {updatesList.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-emerald-500">
                      <span>✓</span> {t("det.allUpToDate")}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-600 text-xs border-b">
                        <span>⚠</span>{" "}
                        {t("det.updatesAvail", { count: updatesList.length })}
                      </div>
                      <div className="divide-y max-h-64 overflow-auto">
                        {updatesList.map((u, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between px-4 py-1.5 text-sm"
                          >
                            <span className="font-mono text-xs">
                              {u.package}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {u.version || ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {phasedList.length > 0 && (
                    <>
                      <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 text-muted-foreground text-xs border-t">
                        <span>⏸</span>{" "}
                        {t("det.phasedCount", { count: phasedList.length })}
                      </div>
                      <div className="divide-y opacity-50 max-h-40 overflow-auto">
                        {phasedList.map((u, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between px-4 py-1.5 text-sm"
                          >
                            <span className="font-mono text-xs">
                              {u.package}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {u.version || ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {hasCap(profile, "canRunUpdates") &&
                    updatesList.length > 0 && (
                      <div className="p-3 border-t">
                        <Button
                          size="sm"
                          onClick={() => setConfirmRunUpdate(true)}
                          disabled={runUpdateMut.isPending}
                        >
                          <ArrowUp className="h-3.5 w-3.5 mr-1" />{" "}
                          {t("det.runUpdate")}
                        </Button>
                      </div>
                    )}
                </CardContent>
              </Card>
            )}

            {/* Custom tasks */}
            {(hasCap(profile, "canViewCustomUpdates") ||
              hasCap(profile, "canRunCustomUpdates") ||
              hasCap(profile, "canEditCustomUpdates") ||
              hasCap(profile, "canDeleteCustomUpdates")) && (
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <CardTitle className="text-sm">
                    {t("det.customUpdates")}
                  </CardTitle>
                  {hasCap(profile, "canEditCustomUpdates") && (
                    <Button
                      size="sm"
                      onClick={() => setTaskDialog({ open: true, task: null })}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> {t("det.addTask")}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  {customTaskList.length === 0 ? (
                    <div className="flex min-h-12 items-center px-4 py-3 text-sm text-muted-foreground">
                      {t("det.noCustomTasks")}
                    </div>
                  ) : (
                    <div className="table-scroll">
                      <table
                        className="w-full min-w-[760px] table-fixed text-sm"
                        data-density="compact"
                      >
                        <colgroup>
                          <col className="w-[21%]" />
                          <col className="w-[12%]" />
                          <col className="w-[19%]" />
                          <col className="w-[19%]" />
                          <col className="w-[17%]" />
                          <col className="w-[12%]" />
                        </colgroup>
                        <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2.5">{t("common.name")}</th>
                            <th className="px-3 py-2.5">{t("det.taskType")}</th>
                            <th className="px-3 py-2.5">
                              {t("det.currentVersion")}
                            </th>
                            <th className="px-3 py-2.5">
                              {t("det.latestVersion")}
                            </th>
                            <th className="px-3 py-2.5">
                              {t("common.status")}
                            </th>
                            <th className="px-4 py-2.5 text-right">
                              {t("common.actions")}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {customTaskList.map((task) => (
                            <tr key={task.id}>
                              <td
                                className="px-4 py-3 font-medium truncate"
                                title={task.name}
                              >
                                {task.name}
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">
                                {task.type === "github"
                                  ? "GitHub"
                                  : task.type === "trigger"
                                    ? t("det.taskTypeTriggerShort")
                                    : "Script"}
                              </td>
                              <td
                                className="px-3 py-3 font-mono text-xs truncate"
                                title={task.current_version || undefined}
                              >
                                {task.current_version || "—"}
                              </td>
                              <td
                                className="px-3 py-3 font-mono text-xs truncate"
                                title={
                                  task.type === "trigger"
                                    ? task.trigger_output ||
                                      task.last_version ||
                                      undefined
                                    : task.last_version || undefined
                                }
                              >
                                {task.type === "trigger"
                                  ? task.trigger_output ||
                                    task.last_version ||
                                    "—"
                                  : task.last_version || "—"}
                              </td>
                              <td className="px-3 py-2">
                                {task.has_update ? (
                                  <StatusBadge tone="warning">
                                    {t("det.imageUpdateAvail")}
                                  </StatusBadge>
                                ) : task.last_checked_at ? (
                                  <span className="text-xs text-emerald-500">
                                    ✓ {t("det.imageUpToDate")}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {hasCap(profile, "canRunCustomUpdates") && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      title={t("common.refresh")}
                                      aria-label={t("common.refresh")}
                                      onClick={() =>
                                        checkTaskMut.mutate(task.id)
                                      }
                                    >
                                      <RefreshCw className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  {hasCap(profile, "canRunCustomUpdates") &&
                                    task.update_command && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        title={t("common.run")}
                                        aria-label={t("common.run")}
                                        onClick={() =>
                                          runTaskMut.mutate(task.id)
                                        }
                                      >
                                        <Play className="h-3.5 w-3.5" />
                                      </Button>
                                    )}
                                  {hasCap(profile, "canEditCustomUpdates") && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      title={t("common.edit")}
                                      aria-label={t("common.edit")}
                                      onClick={() =>
                                        setTaskDialog({ open: true, task })
                                      }
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canDeleteCustomUpdates",
                                  ) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-destructive"
                                      title={t("common.delete")}
                                      aria-label={t("common.delete")}
                                      onClick={() => setConfirmDeleteTask(task)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

    </>
  );
}
