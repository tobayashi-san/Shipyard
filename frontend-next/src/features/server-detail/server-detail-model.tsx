import { History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { metricTextClass } from "@/components/ui/metric-bar";
import { ThresholdBar } from "./components/summary-cards";

export interface ServerDetail {
  id: string;
  name: string;
  ip_address?: string;
  hostname?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: string;
  group_name?: string;
  tags?: string[];
  services?: string[];
  links?: { name: string; url: string }[];
  storage_mounts?: { name: string; path: string }[];
  notes?: string;
  docker_enabled?: number;
  [k: string]: unknown;
}

export interface ServerInfo {
  os?: string;
  kernel?: string;
  cpu?: string;
  cpu_cores?: number;
  cpu_usage_pct?: number | null;
  uptime_seconds?: number;
  ram_used_mb?: number | null;
  ram_total_mb?: number | null;
  disk_used_gb?: number;
  disk_total_gb?: number;
  load_avg?: string;
  updates_count?: number;
  _cached?: boolean;
  storage_mount_metrics?: StorageMount[];
  zfs_pools?: ZfsPool[];
}

export interface StorageMount {
  name?: string;
  path: string;
  filesystem?: string;
  used_gb?: number;
  total_gb?: number;
  usage_pct?: number;
}

export interface ZfsPool {
  name: string;
  health: string;
  alloc_gb?: number;
  size_gb?: number;
  scrub?: string;
}

export interface HistoryRow {
  id: string;
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  triggered_by?: string;
  playbook_name?: string;
  _type?: string;
}

export interface ContainerRow {
  container_name: string;
  image: string;
  status?: string;
  state?: string;
  compose_project?: string;
  compose_working_dir?: string;
  cpu_percent?: number | null;
  memory_usage?: string | null;
  memory_percent?: number | null;
}

export interface CustomTask {
  id: string;
  name: string;
  type?: string;
  github_repo?: string;
  check_command?: string;
  update_command?: string;
  trigger_output?: string;
  latest_command?: string;
  current_version?: string;
  last_version?: string;
  has_update?: boolean;
  last_checked_at?: string;
}

export interface AgentStatus {
  installed?: boolean;
  mode?: string;
  lastSeen?: string;
  runnerVersion?: string;
  manifestVersion?: number;
  latestManifestVersion?: number;
  interval?: number;
  shipyardUrl?: string;
}

export interface ManagedDeployment {
  workspace_id: string | null;
  workspace_name: string;
  resource_key: string;
  cluster_id?: string | null;
  connection_id?: string | null;
  kind?: "inventory" | "deployment";
  vm?: {
    id?: string;
    name?: string;
    node_name?: string;
    vm_id?: number | string | null;
    post_deploy_playbooks?: string[];
  } | null;
}

export interface ManagedDeploymentResponse {
  resources?: ManagedDeployment[];
}

export interface IpamReservation {
  id: string;
  subnet_id: string;
  subnet_cidr?: string;
  subnet_name?: string;
  address: string;
  status?: string;
  role?: string;
}

// ─── Helpers ──────────────────────────────────────────────────
export function parseArrayValue<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function formatUptime(s: number): string {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatBytes(mb: number | null | undefined): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatDate(d?: string, hour12?: boolean): string {
  if (!d) return "—";
  const utc = !d.endsWith("Z") ? d.replace(" ", "T") + "Z" : d;
  try {
    return new Date(utc).toLocaleString(
      undefined,
      hour12 !== undefined ? { hour12 } : undefined,
    );
  } catch {
    return d;
  }
}

export function SummaryField({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  tone?: "success" | "info" | "warning" | "danger";
}) {
  return (
    <div className="console-object-info">
      <dt>{label}</dt>
      <dd data-summary-tone={tone} className={mono ? "font-mono" : ""}>
        {value}
      </dd>
    </div>
  );
}

export function CapacitySummary({
  label,
  value,
  pct,
  warningAt,
}: {
  label: string;
  value: string;
  pct: number | null;
  warningAt?: number;
}) {
  const capacityTone =
    pct !== null && warningAt !== undefined && pct >= warningAt
      ? pct >= 90
        ? "critical"
        : "warning"
      : "healthy";
  return (
    <div className="console-capacity-line">
      <div className="console-capacity-heading">
        <span>{label}</span>
        <span className={`tabular-nums ${metricTextClass(pct, warningAt)}`}>
          {value}
        </span>
      </div>
      <div className="console-capacity-track">
        <span
          data-capacity-tone={capacityTone}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

export function RecentHostTasks({
  history,
  hour12,
}: {
  history: HistoryRow[];
  hour12: boolean;
}) {
  const recent = history.slice(0, 4);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4" />
            Recent tasks
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Recent changes and executions for this host.
          </p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {history.length}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {recent.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            No tasks recorded for this host yet.
          </div>
        ) : (
          <div className="divide-y">
            {recent.map((item) => (
              <div
                key={item.id}
                className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(10rem,.7fr)_minmax(12rem,1fr)_auto] sm:items-center"
              >
                <div className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {formatDate(item.started_at, hour12)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {item.action
                      ? item.action.replace(/[_-]+/g, " ")
                      : item.playbook_name || "Task"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {item._type === "schedule" ? "Scheduled" : "Manual"} ·{" "}
                    {item.triggered_by || "System"}
                  </div>
                </div>
                <StatusBadge
                  tone={
                    item.status === "success"
                      ? "success"
                      : item.status === "failed"
                        ? "danger"
                        : "muted"
                  }
                  dot
                >
                  {item.status === "success"
                    ? "Successful"
                    : item.status === "failed"
                      ? "Failed"
                      : item.status || "Executed"}
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export type StorageInventoryRow = {
  id: string;
  name: string;
  kind: "Mount" | "ZFS-Pool";
  location?: string;
  used?: number;
  total?: number;
  pct: number | null;
  health?: string;
  detail?: string;
};

export function HostStorageInventory({
  info,
  warningAt,
}: {
  info?: ServerInfo;
  warningAt: number;
}) {
  const rows: StorageInventoryRow[] = [
    ...(info?.storage_mount_metrics ?? []).map((mount, index) => ({
      id: `mount-${index}-${mount.path}`,
      name: mount.name || mount.path,
      kind: "Mount" as const,
      location: mount.filesystem || mount.path,
      used: mount.used_gb,
      total: mount.total_gb,
      pct:
        mount.usage_pct ??
        (mount.total_gb
          ? Math.round(((mount.used_gb || 0) / mount.total_gb) * 100)
          : null),
    })),
    ...(info?.zfs_pools ?? []).map((pool, index) => ({
      id: `zfs-${index}-${pool.name}`,
      name: pool.name,
      kind: "ZFS-Pool" as const,
      used: pool.alloc_gb,
      total: pool.size_gb,
      pct: pool.size_gb
        ? Math.round(((pool.alloc_gb || 0) / pool.size_gb) * 100)
        : null,
      health: pool.health,
      detail: pool.scrub ? `Last scrub: ${pool.scrub}` : undefined,
    })),
  ];
  if (!rows.length)
    return (
      <div className="px-4 py-4 text-sm text-muted-foreground">
        No additional mounts or ZFS pools reported by the host. Overall usage is
        shown in the overview.
      </div>
    );
  const usageLabel = (row: StorageInventoryRow) =>
    row.total
      ? `${row.used?.toFixed(1) ?? "—"} / ${row.total.toFixed(1)} GB${row.pct !== null ? ` · ${row.pct} %` : ""}`
      : "—";
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map((row) => (
          <div key={row.id} className="space-y-2 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm font-medium">
                  {row.name}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {row.kind}
                  {row.location ? ` · ${row.location}` : ""}
                </div>
              </div>
              {row.health && (
                <StatusBadge
                  tone={row.health === "ONLINE" ? "success" : "danger"}
                  dot
                >
                  {row.health}
                </StatusBadge>
              )}
            </div>
            <div className="text-xs font-mono tabular-nums text-muted-foreground">
              {usageLabel(row)}
            </div>
            <ThresholdBar pct={row.pct} warningAt={warningAt} />
            {row.detail && (
              <div className="text-[11px] text-muted-foreground">
                {row.detail}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="table-scroll hidden md:block">
        <table data-density="compact" className="w-full min-w-[680px] text-sm">
          <thead>
            <tr>
              <th>Storage</th>
              <th>Type</th>
              <th>Health</th>
              <th>Usage</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="font-mono font-medium">{row.name}</div>
                  {row.location && (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {row.location}
                    </div>
                  )}
                </td>
                <td className="text-xs text-muted-foreground">{row.kind}</td>
                <td>
                  {row.health ? (
                    <StatusBadge
                      tone={row.health === "ONLINE" ? "success" : "danger"}
                      dot
                    >
                      {row.health}
                    </StatusBadge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="min-w-[15rem]">
                  <div className="mb-1 font-mono text-xs tabular-nums">
                    {usageLabel(row)}
                  </div>
                  <ThresholdBar pct={row.pct} warningAt={warningAt} />
                </td>
                <td
                  className="max-w-[16rem] truncate text-xs text-muted-foreground"
                  title={row.detail}
                >
                  {row.detail || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
