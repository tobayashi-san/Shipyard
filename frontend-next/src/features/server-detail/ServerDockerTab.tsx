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

export function ServerDockerTab({ controller }: { controller: ServerDetailController }) {
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

  // ── Container row helper ────────────────────────────────────
    function renderContainerRow(c: ContainerRow) {
      const isUp = c.status?.startsWith("Up");
      const upd =
        imageUpdates[c.container_name] ||
        imageUpdates[c.image] ||
        imageUpdates[c.image + ":latest"];
      return (
        <tr key={c.container_name}>
          <td className="px-3 py-2 pl-6">
            {isUp ? (
              <LiveDot tone="success" />
            ) : (
              <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
            )}
          </td>
          <td className="px-3 py-2 font-mono text-xs">{c.container_name}</td>
          <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {c.image}
          </td>
          <td className="px-3 py-2">
            <span
              className={`text-xs ${isUp ? "text-emerald-500" : "text-rose-500"}`}
            >
              {c.status || c.state}
            </span>
          </td>
          <td className="px-3 py-2">
            {upd === "update_available" ? (
              <StatusBadge tone="warning">
                {t("det.imageUpdateAvail")}
              </StatusBadge>
            ) : upd === "up_to_date" ? (
              <span className="text-xs text-muted-foreground">
                ✓ {t("det.imageUpToDate")}
              </span>
            ) : upd === "updated" ? (
              <StatusBadge tone="success">{t("det.imageUpdated")}</StatusBadge>
            ) : upd === "not_checkable" ? (
              <span className="text-xs text-muted-foreground">
                {t("det.imageNotCheckable")}
              </span>
            ) : upd === "unknown" ? (
              <span className="text-xs text-muted-foreground">
                {t("det.imageCheckFailed")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("det.imageNotChecked")}
              </span>
            )}
          </td>
          <td className="px-3 py-2">
            <div className="flex items-center gap-0.5">
              {hasCap(profile, "canViewDocker") && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title={t("det.showLogs")}
                  onClick={() => loadLogs(c.container_name, logsTail)}
                >
                  <FileText className="h-3 w-3" />
                </Button>
              )}
              {hasCap(profile, "canRestartDocker") && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title={t("common.restart")}
                  onClick={() => setConfirmRestartContainer(c.container_name)}
                >
                  <RotateCw className="h-3 w-3" />
                </Button>
              )}
            </div>
          </td>
        </tr>
      );
    }

  return (
    <>
        {/* ════ DOCKER ════ */}
        {hasCap(profile, "canViewDocker") && !!server.docker_enabled && (
          <TabsContent value="docker" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Boxes className="h-4 w-4" />
                  {t("det.docker")}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() =>
                      qc.invalidateQueries({
                        queryKey: ["server", id, "docker"],
                      })
                    }
                    disabled={fetchingDocker}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${fetchingDocker ? "animate-spin" : ""}`}
                    />
                  </Button>
                  {hasCap(profile, "canManageDockerCompose") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setComposeDialog({
                          open: true,
                          mode: "add",
                          dir: "",
                          content: "",
                          loading: false,
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />{" "}
                      {t("det.addComposeStack")}
                    </Button>
                  )}
                  {hasCap(profile, "canPullDocker") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={checkImageMut.isPending}
                      onClick={() => checkImageMut.mutate()}
                    >
                      {checkImageMut.isPending ? (
                        <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <CloudDownload className="h-3.5 w-3.5 mr-1" />
                      )}
                      {checkImageMut.isPending
                        ? t("det.checkingUpdates")
                        : t("det.checkUpdates")}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {checkImageMut.isPending && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-3 border-y border-primary/20 bg-primary/5 px-4 py-3 text-sm"
                  >
                    <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {t("det.checkingUpdates")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("det.checkingUpdatesHint")}
                      </p>
                    </div>
                  </div>
                )}
                {containers.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<Boxes className="h-5 w-5" />}
                    title={t("det.noContainers")}
                    description={t("det.noContainersHint")}
                  />
                ) : (
                  <div className="table-scroll">
                    <table
                      className="w-full min-w-[720px] text-sm"
                      data-density="compact"
                    >
                      <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 w-2"></th>
                          <th className="px-3 py-2">{t("common.name")}</th>
                          <th className="px-3 py-2">{t("common.image")}</th>
                          <th className="px-3 py-2">{t("common.status")}</th>
                          <th className="px-3 py-2">{t("det.checkUpdates")}</th>
                          <th className="px-3 py-2">{t("common.actions")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {/* Stacks */}
                        {Object.entries(stacks.map).map(([proj, data]) => {
                          const allDown = data.containers.every(
                            (c) => !c.status?.startsWith("Up"),
                          );
                          return [
                            <tr key={`stack-${proj}`} className="bg-muted/20">
                              <td colSpan={5} className="px-3 py-2">
                                <span className="inline-flex items-center gap-2">
                                  <Layers className="h-3.5 w-3.5 text-primary" />
                                  <strong className="text-sm">{proj}</strong>
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {data.dir}
                                  </span>
                                  {allDown && (
                                    <StatusBadge tone="danger">
                                      {t("common.offline")}
                                    </StatusBadge>
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-0.5">
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      title={t("det.editCompose")}
                                      onClick={() => openEditCompose(data.dir)}
                                    >
                                      <FileText className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {hasCap(profile, "canPullDocker") && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      title="pull"
                                      onClick={() =>
                                        composeActionMut.mutate({
                                          dir: data.dir,
                                          action: "pull",
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      <CloudDownload className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      title="up -d"
                                      onClick={() =>
                                        composeActionMut.mutate({
                                          dir: data.dir,
                                          action: "up",
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      <Play className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-destructive"
                                      title="down"
                                      onClick={() =>
                                        setConfirmComposeDown({
                                          proj,
                                          dir: data.dir,
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      <Square className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-destructive"
                                      title={t("det.removeStack")}
                                      onClick={() =>
                                        setConfirmDeleteStack({
                                          proj,
                                          dir: data.dir,
                                        })
                                      }
                                      disabled={deleteStackMut.isPending}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>,
                            ...data.containers
                              .filter(
                                (c) => c.container_name !== "[Stack Offline]",
                              )
                              .map((c) => renderContainerRow(c)),
                          ];
                        })}
                        {/* Standalone */}
                        {stacks.standalone.length > 0 && (
                          <tr className="bg-muted/20">
                            <td colSpan={6} className="px-3 py-2">
                              <span className="inline-flex items-center gap-2">
                                <Box className="h-3.5 w-3.5 text-muted-foreground" />
                                <strong className="text-sm">
                                  {t("det.standalone")}
                                </strong>
                              </span>
                            </td>
                          </tr>
                        )}
                        {stacks.standalone.map((c) => renderContainerRow(c))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Logs panel */}
                {logsContainer && (
                  <section
                    className="console-log-viewer"
                    aria-labelledby="container-log-title"
                  >
                    <div className="console-log-header">
                      <div className="console-log-title">
                        <span className="console-log-icon">
                          <FileText className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 id="container-log-title">
                            {t("det.logViewerTitle")}
                          </h3>
                          <div className="console-log-meta">
                            <span className="font-mono">{logsContainer}</span>
                            {activeLogContainer?.image && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span
                                  className="truncate"
                                  title={activeLogContainer.image}
                                >
                                  {activeLogContainer.image}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="console-log-controls">
                        <label className="console-log-tail-select">
                          <span className="sr-only">
                            {t("det.logTailLabel")}
                          </span>
                          <select
                            value={logsTail}
                            disabled={logsLoading}
                            onChange={(e) => {
                              const tail = Number(e.target.value);
                              setLogsTail(tail);
                              loadLogs(logsContainer, tail);
                            }}
                          >
                            <option value={100}>100</option>
                            <option value={200}>200</option>
                            <option value={500}>500</option>
                            <option value={1000}>1000</option>
                          </select>
                          <span>{t("det.logTail", { count: logsTail })}</span>
                        </label>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={t("common.refresh")}
                          aria-label={t("common.refresh")}
                          disabled={logsLoading}
                          onClick={() => loadLogs(logsContainer, logsTail)}
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${logsLoading ? "animate-spin" : ""}`}
                          />
                        </Button>
                        <CopyButton value={logsContent} label={t("det.logs")} />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={t("common.close")}
                          aria-label={t("common.close")}
                          onClick={() => setLogsContainer(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    {logsError ? (
                      <div role="alert" className="console-log-error">
                        <strong>{t("det.logLoadFailed")}</strong>
                        <span>{logsError}</span>
                      </div>
                    ) : (
                      <div
                        className="console-log-output"
                        aria-live="polite"
                        aria-busy={logsLoading}
                      >
                        {logsLoading ? (
                          <div className="console-log-empty">
                            <RefreshCw className="h-4 w-4 animate-spin" />
                            <span>{t("det.logLoading")}</span>
                          </div>
                        ) : logsContent ? (
                          <pre tabIndex={0} aria-label={t("det.logs")}>
                            {logsContent}
                          </pre>
                        ) : (
                          <div className="console-log-empty">
                            <FileText className="h-4 w-4" />
                            <span>{t("det.logEmpty")}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

    </>
  );
}
