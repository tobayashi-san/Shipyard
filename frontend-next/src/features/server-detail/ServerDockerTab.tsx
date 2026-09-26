import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  OverflowItem,
  OverflowMenu
} from "@/components/ui/overflow-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { TabsContent } from "@/components/ui/tabs";
import { Timestamp } from "@/components/ui/timestamp";
import { hasCap } from "@/lib/queries";
import {
  Box,
  Boxes,
  CloudDownload,
  FileText,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  X
} from "lucide-react";
import { CopyButton } from "./components/summary-cards";
import { containerStateTone } from './container-state';
import { imageCatalogFreshness } from './image-catalog-freshness';
import {
  type ContainerRow
} from "./server-detail-model";


import type { ServerDetailController } from "./useServerDetailController";

type ServerDockerTabController = Pick<ServerDetailController,
    "activeLogContainer"
  | "checkImageMut"
  | "composeActionMut"
  | "containers"
  | "deleteStackMut"
  | "fetchingDocker"
  | "id"
  | "imageCatalog"
  | "imageUpdates"
  | "checkedImages"
  | "imageExclusionMut"
  | "loadLogs"
  | "logsContainer"
  | "logsContent"
  | "logsError"
  | "logsLoading"
  | "logsTail"
  | "openEditCompose"
  | "profile"
  | "qc"
  | "server"
  | "setComposeDialog"
  | "setConfirmComposeDown"
  | "setConfirmDeleteStack"
  | "setConfirmRestartContainer"
  | "setLogsContainer"
  | "setLogsTail"
  | "stacks"
  | "t"
>;

export function ServerDockerTab({ controller }: { controller: ServerDockerTabController }) {
  const {
    t,
    qc,
    id,
    setConfirmComposeDown,
    setConfirmRestartContainer,
    profile,
    server,
    fetchingDocker,
    imageUpdates,
    checkedImages,
    imageExclusionMut,
    imageCatalog,
    logsContainer,
    setLogsContainer,
    logsContent,
    logsTail,
    setLogsTail,
    logsLoading,
    logsError,
    loadLogs,
    checkImageMut,
    composeActionMut,
    setComposeDialog,
    setConfirmDeleteStack,
    deleteStackMut,
    openEditCompose,
    containers,
    activeLogContainer,
    stacks,
  } = controller;
  const catalogFreshness = imageCatalogFreshness(imageCatalog);

  if (!server) return null;

  // ── Container row helper ────────────────────────────────────
    function renderContainerRow(c: ContainerRow) {
      const stateTone = containerStateTone(c.status, c.state);
      const upd =
        imageUpdates[c.container_name] ||
        imageUpdates[c.image] ||
        imageUpdates[c.image + ":latest"];
      const checkedImage = checkedImages[c.container_name] || checkedImages[c.image] || checkedImages[c.image + ":latest"];
      const canExclude = Boolean(checkedImage) && hasCap(profile, "canEditServers");
      const exclusionAction = canExclude && (upd === "ignored" || upd === "not_checkable" || upd === "unknown") ? (
        <button
          type="button"
          className="mt-0.5 block text-[11px] text-primary hover:underline disabled:opacity-50"
          disabled={imageExclusionMut.isPending}
          onClick={() => imageExclusionMut.mutate({ image: checkedImage!, excluded: upd !== "ignored" })}
        >
          {upd === "ignored" ? "Check again" : "Exclude from checks"}
        </button>
      ) : null;
      return (
        <tr key={c.container_name}>
          <td className="px-3 py-2 pl-6">
            <span className={`inline-block h-2 w-2 rounded-full ${stateTone === "success" ? "bg-success" : stateTone === "warning" ? "bg-warning" : stateTone === "danger" ? "bg-destructive" : "bg-muted-foreground/50"}`} />
          </td>
          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{c.container_name}</td>
          <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {c.image}
          </td>
          <td className="px-3 py-2">
            <StatusBadge tone={stateTone}>{c.status || c.state || "Status not reported"}</StatusBadge>
          </td>
          <td className="px-3 py-2 whitespace-nowrap text-xs tabular-nums">
            {c.cpu_percent == null ? <span className="text-muted-foreground" title="Docker did not return a CPU sample in the latest collection.">—</span> : `${c.cpu_percent.toFixed(2)} %`}
          </td>
          <td className="px-3 py-2 text-xs tabular-nums">
            {c.memory_usage ? <span>{c.memory_usage}</span> : <span className="text-muted-foreground" title="Docker did not return a memory sample in the latest collection.">—</span>}
            {c.memory_percent != null && <span className="ml-1 text-muted-foreground">({c.memory_percent.toFixed(1)} %)</span>}
          </td>
          <td className="min-w-[10rem] max-w-[20rem] px-3 py-2">
            {upd === "update_available" ? (
              <StatusBadge tone="warning">
                {t("det.imageUpdateAvail")}
              </StatusBadge>
            ) : (upd === "up_to_date" || upd === "updated") && !catalogFreshness.fresh ? (
              <span className="text-xs text-muted-foreground" title={`The last image check is outdated. ${hasCap(profile, "canPullDocker") ? "Check for updates to verify the current state." : "Ask an authorized operator to refresh image checks."}`}>
                {upd === "up_to_date" ? "Up to date" : "Updated"} · check outdated
              </span>
            ) : upd === "up_to_date" ? (
              <span className="text-xs text-muted-foreground">
                ✓ {t("det.imageUpToDate")}
              </span>
            ) : upd === "updated" ? (
              <StatusBadge tone="success">{t("det.imageUpdated")}</StatusBadge>
            ) : upd === "ignored" ? (
              <span className="text-xs text-muted-foreground" title="This image is excluded from update checks on this host.">
                Excluded from checks{exclusionAction}
              </span>
            ) : upd === "not_checkable" ? (
              <span className="text-xs text-muted-foreground">
                {t("det.imageNotCheckable")}{exclusionAction}
              </span>
            ) : upd === "unknown" ? (
              <span className="text-xs text-muted-foreground">
                {t("det.imageCheckFailed")}{exclusionAction}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t("det.imageNotChecked")}<span className="block text-[11px]">{hasCap(profile, "canPullDocker") ? "Run image checks to compare the local image with its registry." : "Ask an authorized operator to run image checks."}</span>
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
                  title={t("det.showLogs")} aria-label={t("det.showLogs")}
                  onClick={() => loadLogs(c.container_name, logsTail)}
                >
                  <FileText className="h-3 w-3" />
                </Button>
              )}
              {hasCap(profile, "canRestartDocker") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  title={t("common.restart")}
                  onClick={() => setConfirmRestartContainer(c.container_name)}
                >
                  <RotateCw className="h-3 w-3" /> {t("common.restart")}
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
                <div className="min-w-0">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Boxes className="h-4 w-4" />
                    {t("det.docker")}
                  </CardTitle>
                  {/* One status line instead of separate explanation boxes; details live in tooltips. */}
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground" role="status">
                    {hasCap(profile, "canViewUpdates") && <span>Image check: {catalogFreshness.hasCollectionTime ? <Timestamp value={imageCatalog?.updated_at} /> : "never"}{!catalogFreshness.fresh && <span className="text-warning"> · outdated</span>}</span>}
                    {containers.some(c => c.cpu_percent == null || !c.memory_usage) && <span title="Missing metrics are unknown, not zero. Stopped containers may have no samples.">Metrics: {containers.filter(c => c.cpu_percent != null && !!c.memory_usage).length} of {containers.length} containers</span>}
                    {Object.values(imageUpdates).some(status => ['not_checkable', 'unknown'].includes(status)) && <span title="Local images without a registry digest cannot be compared. For unknown results, check registry access and the image tag, then refresh.">Some images cannot be compared</span>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={t("common.refresh")}
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
                      className="w-full min-w-[900px] text-sm"
                      data-density="compact"
                    >
                      <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 w-2"></th>
                          <th className="px-3 py-2">{t("common.name")}</th>
                          <th className="px-3 py-2">{t("common.image")}</th>
                          <th className="px-3 py-2">{t("common.status")}</th>
                          <th className="px-3 py-2">CPU</th>
                          <th className="px-3 py-2">Memory</th>
                          <th className="px-3 py-2">Update status</th>
                          <th className="px-3 py-2">{t("common.actions")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {/* Stacks */}
                        {Object.entries(stacks.map).map(([proj, data]) => {
                          const allDown = data.containers.every(
                            (c) => !/^(up\b|running$)/i.test(c.status || c.state || ""),
                          );
                          return [
                            <tr key={`stack-${proj}`} className="bg-muted/20">
                              <td colSpan={7} className="px-3 py-2">
                                <span className="inline-flex items-center gap-2">
                                  <Layers className="h-3.5 w-3.5 text-primary" />
                                  <strong className="text-sm">{proj}</strong>
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {data.dir}
                                  </span>
                                  {allDown && (
                                    <StatusBadge tone={data.containers.some(c => containerStateTone(c.status, c.state) === "danger") ? "danger" : data.containers.some(c => containerStateTone(c.status, c.state) === "warning") ? "warning" : "muted"}>
                                      No running containers reported
                                    </StatusBadge>
                                  )}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                {(hasCap(profile, "canManageDockerCompose") || hasCap(profile, "canPullDocker")) && (
                                  <OverflowMenu title={`Actions for ${proj}`}>
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <OverflowItem
                                      icon={FileText}
                                      onClick={() => openEditCompose(data.dir)}
                                    >
                                      {t("det.editCompose")}
                                    </OverflowItem>
                                  )}
                                  {hasCap(profile, "canPullDocker") && (
                                    <OverflowItem
                                      icon={CloudDownload}
                                      onClick={() =>
                                        composeActionMut.mutate({
                                          dir: data.dir,
                                          action: "pull",
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      Pull images
                                    </OverflowItem>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <OverflowItem
                                      icon={Play}
                                      onClick={() =>
                                        composeActionMut.mutate({
                                          dir: data.dir,
                                          action: "up",
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      <span><span className="block">Start / apply changes</span><span className="block max-w-56 text-xs text-muted-foreground">May recreate containers using the saved configuration.</span></span>
                                    </OverflowItem>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <OverflowItem
                                      icon={Square}
                                      onClick={() =>
                                        setConfirmComposeDown({
                                          proj,
                                          dir: data.dir,
                                        })
                                      }
                                      disabled={composeActionMut.isPending}
                                    >
                                      Stop stack
                                    </OverflowItem>
                                  )}
                                  {hasCap(
                                    profile,
                                    "canManageDockerCompose",
                                  ) && (
                                    <OverflowItem
                                      icon={Trash2}
                                      onClick={() =>
                                        setConfirmDeleteStack({
                                          proj,
                                          dir: data.dir,
                                        })
                                      }
                                      disabled={deleteStackMut.isPending}
                                    >
                                      {t("det.removeStack")}
                                    </OverflowItem>
                                  )}
                                  </OverflowMenu>
                                )}
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
                            <td colSpan={8} className="px-3 py-2">
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
