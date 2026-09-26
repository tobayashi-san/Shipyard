import { Timestamp } from "@/components/ui/timestamp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { hasCap, useProfile } from "@/lib/queries";
import { managementLabel } from '@/lib/resource-model';
import { Link } from "@tanstack/react-router";
import {
  Cpu,
  ExternalLink,
  HardDrive,
  HeartPulse,
  Network,
  RefreshCw,
  Settings2,
  TriangleAlert
} from "lucide-react";
import { CopyButton } from "./components/summary-cards";
import {
  CapacitySummary,
  formatBytes,
  formatUptime,
  HostStorageInventory,
  RecentHostTasks,
  SummaryField
} from "./server-detail-model";


import type { ServerDetailController } from "./useServerDetailController";

type ServerOverviewTabsController = Pick<ServerDetailController,
    "canViewManagementRelationships"
  | "cpuPct"
  | "deploymentContextFailed"
  | "deploymentContextLoading"
  | "diskPct"
  | "fetchingInfo"
  | "healthThresholds"
  | "histItems"
  | "hour12"
  | "info"
  | "infoError"
  | "infoFailed"
  | "ipamReservations"
  | "latencyMs"
  | "managedDeployments"
  | "ramPct"
  | "refetchInfo"
  | "server"
  | "setEditOpen"
  | "t"
>;

export function ServerOverviewTabs({ controller }: { controller: ServerOverviewTabsController }) {
  const {
    t,
    hour12,
    canViewManagementRelationships,
    managedDeployments,
    deploymentContextLoading,
    deploymentContextFailed,
    server,
    info,
    refetchInfo,
    fetchingInfo,
    infoFailed,
    infoError,
    ipamReservations,
    latencyMs,
    histItems,
    ramPct,
    diskPct,
    cpuPct,
    healthThresholds,
    setEditOpen,
  } = controller;
  const { data: profile } = useProfile();

  if (!server) return null;
  const managementSummary = !canViewManagementRelationships ? "Management relationships unavailable for this role"
    : deploymentContextFailed ? "Management context unavailable"
    : deploymentContextLoading ? "Loading management context…"
    : managementLabel(server.id, managedDeployments.some(deployment => deployment.kind !== "inventory"));

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
                      {reason.code === "custom_check_failed" && `${reason.count} custom update checks failed. Review the last attempt in Updates.`}
                      {reason.code === "reboot_required" && "A reboot is required to finish applying system changes."}
                      {reason.code === "failed_operations" && `${reason.count} of the four most recent operations ${reason.count === 1 ? "has" : "have"} failed.`}
                      {reason.code === "offline" && "The host is not reachable."}
                      {reason.code === "active_alerts" && `${reason.count} active resource ${reason.count === 1 ? "alert requires" : "alerts require"} review.`}
                      {reason.code === "os_updates" && `${reason.count} operating system ${reason.count === 1 ? "update is" : "updates are"} available.`}
                      {reason.code === "image_updates" && `${reason.count} container image ${reason.count === 1 ? "update is" : "updates are"} available.`}
                      {reason.code === "custom_updates" && `${reason.count} custom ${reason.count === 1 ? "update is" : "updates are"} available.`}
                      {reason.code === "cpu_capacity" && `CPU usage is ${reason.value}% (warning at ${reason.threshold}%).`}
                      {reason.code === "ram_capacity" && `Memory usage is ${reason.value}% (warning at ${reason.threshold}%).`}
                      {reason.code === "disk_capacity" && `Disk usage is ${reason.value}% (warning at ${reason.threshold}%).`}
                      {reason.code === "storage_capacity" && `${reason.count} storage ${reason.count === 1 ? "mount is" : "mounts are"} above ${reason.threshold}%${reason.targets?.length ? `: ${reason.targets.join(", ")}` : "."}`}
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
                <div className="flex items-center gap-2 border-b pb-3">
                  <div className="flex items-center gap-2">
                    <HeartPulse className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">
                      Host summary
                    </h2>
                  </div>
                </div>
                <dl className="console-object-info-grid xl:grid-cols-2">
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
                  {Boolean(server.owner) && <SummaryField label="Owner" value={String(server.owner)} />}
                  <SummaryField label="Tags" value={Array.isArray(server.tags) && server.tags.length ? server.tags.join(", ") : "—"} />
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
                  <p className="text-[11px] text-muted-foreground">
                    Measured <Timestamp value={info?.updated_at} hour12={hour12} /> via SSH{server.status !== "offline" && latencyMs !== null ? <> · <span className={latencyMs >= 250 ? "text-warning" : undefined}>{latencyMs} ms</span></> : null}{info?._refreshing ? " · refreshing" : ""}
                  </p>
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

          {/* The summary above is the live hardware view. These panes hold
              static system and access facts, so capacity does not appear twice. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Settings2 className="h-4 w-4" />
                  System
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
                      <dt>Management mode</dt>
                    <dd
                      className="!overflow-visible !whitespace-normal !break-words"
                      title={managementSummary}
                    >
                      {managementSummary}

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
                      [t("det.kernel"), info?.kernel],
                      [t("det.loadAvg"), info?.load_avg],
                    ] as [string, string | number | null | undefined][]
                  ).map(([k, v]) => (
                    <div key={k} className="console-property">
                      <dt>{k}</dt>
                      <dd
                        className="font-medium tabular-nums !overflow-visible !whitespace-normal !break-words"
                        title={String(v ?? "—")}
                      >
                        {v ?? "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  Network & access
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
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
              </CardContent>
            </Card>
          </div>

          {/* Individual storage objects: configured mounts, detected network
              shares and ZFS pools. Overall disk usage stays in the summary. */}
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
                aria-label={t("common.refresh")}
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
                  onEditMounts={hasCap(profile, "canEditServers") ? () => setEditOpen(true) : undefined}
                  configuredMounts={Array.isArray(server.storage_mounts) ? server.storage_mounts : undefined}
                />
              )}
            </CardContent>
          </Card>

          {/* History is reference material; it closes the page. */}
          <RecentHostTasks history={histItems} hour12={hour12} />
        </TabsContent>

    </>
  );
}
