import { EmptyState } from '@/components/ui/empty-state';
import { Timestamp } from "@/components/ui/timestamp";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  OverflowItem,
  OverflowMenu,
  OverflowSep,
} from "@/components/ui/overflow-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TabsContent } from "@/components/ui/tabs";
import { hasCap } from "@/lib/queries";
import { formatDateTime } from '@/lib/utils';
import {
  AlertTriangle,
  ArrowUp,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";
import { OsUpdatePreview } from './components/OsUpdatePreview';
import { PackageVersionChange } from './components/PackageVersionChange';
import { imageCatalogFreshness as catalogFreshness } from './image-catalog-freshness';


import type { ServerDetailController } from "./useServerDetailController";

type ServerUpdatesTabController = Pick<ServerDetailController,
    "checkSystemUpdatesMut"
  | "checkTaskMut"
  | "customTaskList"
  | "customTasksFailed"
  | "customTasksLoading"
  | "id"
  | "info"
  | "phasedList"
  | "profile"
  | "rawUpdates"
  | "refetchCustomTasks"
  | "runTaskMut"
  | "runUpdateMut"
  | "setConfirmDeleteTask"
  | "setConfirmRunUpdate"
  | "setTaskDialog"
  | "t"
  | "updatesList"
>;

export function ServerUpdatesTab({ controller }: { controller: ServerUpdatesTabController }) {
  const {
    t,
    id,
    setConfirmRunUpdate,
    setConfirmDeleteTask,
    profile,
    info,
    rawUpdates,
    customTaskList,
    customTasksLoading,
    customTasksFailed,
    refetchCustomTasks,
    runUpdateMut,
    setTaskDialog,
    checkTaskMut,
    runTaskMut,
    checkSystemUpdatesMut,
    updatesList,
    phasedList,
  } = controller;
  // Package managers and community update scripts need headroom; many refuse to start above 80 %.
  const diskPercent = info?.disk_total_gb ? Math.round(((info.disk_used_gb || 0) / info.disk_total_gb) * 100) : null;

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
            {diskPercent !== null && diskPercent >= 80 && (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>The root disk is {diskPercent}% full ({info?.disk_total_gb && Math.round(info.disk_total_gb - (info.disk_used_gb || 0))} GB free). Updates can fail or refuse to start; free up space or enlarge the disk first.</AlertDescription>
              </Alert>
            )}
            {hasCap(profile, "canViewUpdates") && (
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <CardTitle className="text-sm">System packages</CardTitle>
                    {/* One status line; source and interval stay available on hover. */}
                    <p className="mt-0.5 text-xs text-muted-foreground" title={rawUpdates && !Array.isArray(rawUpdates) ? `${rawUpdates.source} · refresh interval ${Math.round(rawUpdates.stale_after_seconds / 60)} min${rawUpdates.cached ? ' · cached result' : ''}` : undefined}>
                      {rawUpdates && !Array.isArray(rawUpdates) ? <>Last check <Timestamp value={rawUpdates.updated_at} />{rawUpdates.stale && <span className="text-warning"> · outdated</span>}</> : "Not checked yet"}
                      {Boolean(info?.reboot_required) && <span className="text-warning"> · reboot required</span>}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => checkSystemUpdatesMut.mutate()}
                      disabled={checkSystemUpdatesMut.isPending}
                    >
                      <RefreshCw className={checkSystemUpdatesMut.isPending ? "animate-spin" : undefined} />
                      {checkSystemUpdatesMut.isPending ? t("det.checkingSystemUpdates") : t("det.checkUpdates")}
                    </Button>
                    {hasCap(profile, "canRunUpdates") && updatesList.length > 0 && (
                      <Button size="sm" onClick={() => setConfirmRunUpdate(true)} disabled={runUpdateMut.isPending}>
                        <ArrowUp />Install updates ({updatesList.length})
                      </Button>
                    )}
                  </div>
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
                  {rawUpdates == null ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">OS update catalog unavailable. Refresh to retry.</p>
                  ) : updatesList.length === 0 && phasedList.length > 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">All available updates are deferred. See packages below.</p>
                  ) : updatesList.length === 0 && !Array.isArray(rawUpdates) && rawUpdates.stale ? (
                    // A stale empty result is not evidence that the host is current.
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                      <span aria-hidden="true">⚠</span> {t("det.noUpdatesStale")}
                    </div>
                  ) : updatesList.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm [color:hsl(var(--success))]">
                      <span aria-hidden="true">✓</span> {t("det.allUpToDate")}
                    </div>
                  ) : (
                    <>
                      <div className="border-y bg-[hsl(var(--warning)/0.08)] px-4 py-2 text-xs font-medium text-[hsl(var(--warning))]">
                        {t("det.updatesAvail", { count: updatesList.length })}
                      </div>
                      <div className="divide-y max-h-64 overflow-auto">
                        {updatesList.map((u, i) => (
                          <div
                            key={i}
                            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm"
                          >
                            <span className="font-mono text-xs">
                              {u.package}
                            </span>
                            <PackageVersionChange installed={u.current_version} candidate={u.version} />
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
                            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm"
                          >
                            <span className="font-mono text-xs">
                              {u.package}
                            </span>
                            <PackageVersionChange installed={u.current_version} candidate={u.version} />
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <OsUpdatePreview serverId={id} />
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
                      variant="outline"
                      onClick={() => setTaskDialog({ open: true, task: null })}
                    >
                      <Plus /> {t("det.addTask")}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  {!hasCap(profile, "canViewCustomUpdates") ? (
                    <p role="status" className="p-4 text-sm text-muted-foreground">Your role cannot view custom update checks.</p>
                  ) : customTasksFailed ? (
                    <div role="alert" className="p-4 text-sm"><p>Custom update checks could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void refetchCustomTasks()}>Retry</Button></div>
                  ) : customTasksLoading ? (
                    <p role="status" className="p-4 text-sm text-muted-foreground">Loading custom update checks…</p>
                  ) : customTaskList.length === 0 ? (
                    <EmptyState inline title={t("det.noCustomTasks")} />
                  ) : (
                    <div className="table-scroll">
                      <table
                        className="w-full min-w-[760px] table-fixed text-sm"
                        data-density="compact"
                      >
                        <colgroup>
                          <col className="w-[21%]" />
                          <col className="w-[10%]" />
                          <col className="w-[14%]" />
                          <col className="w-[14%]" />
                          <col className="w-[29%]" />
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
                                {task.last_check_error ? (
                                  <div className="space-y-1"><StatusBadge tone="danger">Check failed</StatusBadge><p className="text-xs text-muted-foreground">{task.last_check_error}</p><p className="text-xs text-muted-foreground">Attempt: {formatDateTime(task.last_attempted_at)}</p></div>
                                ) : task.has_update ? (
                                  <StatusBadge tone="warning">
                                    {t("det.imageUpdateAvail")}
                                  </StatusBadge>
                                ) : !catalogFreshness({ updated_at: task.last_checked_at, stale: task.stale }).fresh ? (
                                  <StatusBadge tone="warning">Check missing or stale</StatusBadge>
                                ) : task.last_checked_at ? (
                                  <span className="text-xs text-emerald-500">
                                    ✓ {t("det.imageUpToDate")}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                                <p className="mt-1 text-xs text-muted-foreground">{task.last_checked_at ? `Last successful check: ${formatDateTime(task.last_checked_at)}` : 'Not checked yet'}</p>
                                <p className="text-xs text-muted-foreground">{task.source}{task.snapshot_before_run ? ' · Snapshot before update' : ''}{!catalogFreshness({ updated_at: task.last_checked_at, stale: task.stale }).fresh && task.has_update ? ' · Stale result; verify before updating' : ''}</p>
                              </td>
                              <td className="px-4 py-2 text-right">
                                <div className="flex justify-end">
                                  {(hasCap(profile, "canRunCustomUpdates") || hasCap(profile, "canEditCustomUpdates") || hasCap(profile, "canDeleteCustomUpdates")) && (
                                  <OverflowMenu title={`Actions for ${task.name}`} width="w-44">
                                  {hasCap(profile, "canRunCustomUpdates") && (
                                    <OverflowItem icon={RefreshCw} onClick={() => checkTaskMut.mutate(task.id)}>{t("common.refresh")}</OverflowItem>
                                  )}
                                  {hasCap(profile, "canRunCustomUpdates") &&
                                    task.update_command && (
                                      <OverflowItem icon={Play} onClick={() => runTaskMut.mutate(task.id)}>{t("common.run")}</OverflowItem>
                                    )}
                                  {hasCap(profile, "canEditCustomUpdates") && (
                                    <OverflowItem icon={Pencil} onClick={() => setTaskDialog({ open: true, task })}>{t("common.edit")}</OverflowItem>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canDeleteCustomUpdates",
                                  ) && (
                                    <><OverflowSep /><OverflowItem icon={Trash2} danger onClick={() => setConfirmDeleteTask(task)}>{t("common.delete")}</OverflowItem></>
                                  )}
                                  </OverflowMenu>
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
