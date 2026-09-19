import { platformCapacity } from './platform-capacity';
import {guestAuditPresentation, parseAuditDetail} from '@/lib/audit-display';
import { Activity, Server } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { formatDateTime } from "@/lib/utils";

export interface Datastore {
  content?: string[] | null;
  shared?: boolean | null;
  active?: boolean | null;
  enabled?: boolean | null;
  capacity_reported?: boolean;
  id: string;
  node_name: string;
  type?: string;
  used: number;
  total: number;
  available?: number;
}
export function datastoreContent(store: Datastore): string {
  if (!store.content?.length) return 'Content types not reported';
  const labels: Record<string, string> = {images:'VM disks',rootdir:'Container filesystems',iso:'ISO images',vztmpl:'Container templates',backup:'Backups',snippets:'Snippets'};
  return store.content.map(type => labels[type] || type).join(', ');
}

export function filterDatastores(stores: Datastore[], query: string, status = 'all'): Datastore[] {
  const text = query.trim().toLowerCase();
  return stores.filter(store => (status === 'all' || datastoreStatus(store) === status) &&
    (!text || [store.id, store.node_name, store.type || '', datastoreContent(store)].join(' ').toLowerCase().includes(text)));
}

export function datastoreStatus(store: Datastore): string {
  if (store.enabled === false) return 'Disabled';
  if (store.active === false) return 'Inactive';
  if (store.active === true) return 'Active';
  return 'Status not reported';
}

export function datastoreCapacityState(store: Datastore): 'unknown' | 'high' | 'normal' {
  if (store.active === false || store.active === null || store.enabled === false || store.capacity_reported === false || !Number.isFinite(store.used) || !Number.isFinite(store.total) || store.total <= 0 || store.used < 0 || store.used > store.total) return 'unknown';
  return store.used / store.total >= 0.85 ? 'high' : 'normal';
}

export interface Bridge {
  address6?: string | null;
  cidr6?: number | null;
  gateway6?: string | null;
  name: string;
  type?: string;
  active?: boolean | null;
  address?: string | null;
  cidr?: number | null;
  gateway?: string | null;
}
export function interfaceAddress(address?: string | null, prefix?: number | null, version: 4 | 6 = 4): string {
  if (!address) return 'Not reported';
  const valid = Number.isInteger(prefix) && Number(prefix) >= 0 && Number(prefix) <= (version === 6 ? 128 : 32);
  return `${address}${valid ? `/${prefix}` : ''}`;
}

export interface Node {
  network_interfaces?: Bridge[];
  network_status?: "available" | "unavailable";
  network_checked_at?: string;
  datastores_status?: "available" | "unavailable";
  datastores_checked_at?: string;
  name: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  uptime: number;
  datastores?: Datastore[];
  bridges?: Bridge[];
  platform_version?: string | null;
  kernel_version?: string | null;
  cpu_model?: string | null;
  cpu_sockets?: number | null;
  available_updates?: PackageUpdate[];
  update_count?: number;
  update_status?: "available" | "current" | "unavailable";
  update_error?: string | null;
  fleet_server_id?: string | null;
}
export interface PackageUpdate {
  package: string;
  title: string;
  description: string;
  origin: string;
  current_version: string;
  available_version: string;
  priority: string;
  section: string;
}
export interface Vm {
  name: string;
  node_name: string;
  vm_id: number;
  guest_type?: "qemu" | "lxc";
  status: string;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number | null;
  maxdisk: number;
  fleet_server_id?: string | null;
}
export function guestKind(vm: Pick<Vm, "guest_type">) {
  return vm.guest_type === "lxc" ? "CT" : "VM";
}
export interface Cluster {
  id: string;
  endpoint: string;
  status: string;
  connections?: Array<{ id: string; name: string }>;
  nodes: Node[];
  vms: Vm[];
  datastores?: Datastore[];
}
export interface InfrastructureResponse {
  warnings?: string[];
  clusters?: Cluster[];
  updated_at?: string;
  cached?: boolean;
  refreshing?: boolean;
}
export interface AuditTask {
  action?: string;
  detail?: string;
  user?: string;
  success?: 0 | 1 | boolean;
  created_at?: string;
  grouped_count?: number;
}

export function taskLabel(task: AuditTask) {
  const raw = String(task.action || "Action");
  const normalized = raw === "ipam.proxmox_sync"
    ? "IPAM sync"
    : guestAuditPresentation(task).label;
  return task.grouped_count && task.grouped_count > 1
    ? `${normalized} ×${task.grouped_count}`
    : normalized;
}
export interface Folder {
  id: string;
  name: string;
  environment_id?: string;
}

export function tone(value: string): StatusTone {
  return value === "online" || value === "running"
    ? "success"
    : value === "offline"
      ? "danger"
      : "muted";
}
export function statusLabel(value: string) {
  const labels: Record<string, string> = {
    online: "Online",
    offline: "Offline",
    running: "Running",
    stopped: "Stopped",
    unknown: "Unknown",
  };
  return labels[value.toLowerCase()] || value || "Unknown";
}
export function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}
export function pct(value: number, total: number) {
  return Number.isFinite(value) && value >= 0 && Number.isFinite(total) && total > 0 ? `${Math.round((value / total) * 100)} %` : "—";
}
export function uptime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 60)} min`;
}
export function taskDate(value?: string) {
  return formatDateTime(value);
}

export function capacityToneForPercentage(percentage: number) {
  return percentage >= 95
    ? "critical"
    : percentage >= 85
      ? "warning"
      : "healthy";
}

// Inventory APIs may return directory, ISO and ZFS stores in arbitrary order.
// Object summaries should identify the actual VM-capable ZFS pool first,
// rather than exposing an incidental first response as "primary" storage.
export function preferredDatastores(stores: Datastore[] = []) {
  const usable = stores.filter(
    (store) => datastoreCapacityState(store) !== "unknown",
  );
  const zfs = usable.filter((store) => /zfs/i.test(String(store.type || "")));
  return (zfs.length ? zfs : usable)
    .slice()
    .sort((left, right) => (right.total || 0) - (left.total || 0));
}

export function tasksForObject(
  rows: AuditTask[],
  cluster: Cluster,
  nodeName?: string,
) {
  const connectionIds = new Set((cluster.connections ?? []).map(connection => connection.id));
  const matching = rows.filter(row => {
    const fields = parseAuditDetail(row.detail).fields;
    const sources = fields.filter(field => field.key === 'source_id');
    // Display names and free text cannot establish which platform owns an event.
    if (sources.length !== 1 || !connectionIds.has(sources[0].value)) return false;
    if (!nodeName) return true;
    const nodes = fields.filter(field => field.key === 'node');
    return nodes.length === 1 && nodes[0].value === nodeName;
  });

  const grouped = new Map<string, AuditTask[]>();
  const visible: AuditTask[] = [];
  for (const row of matching) {
    const periodic = /(?:^|[._\s-])(sync|synchronize|refresh|inventory|gather)(?:$|[._\s-])/i.test(String(row.action || ""));
    const succeeded = row.success === true || row.success === 1;
    if (!periodic || !succeeded) {
      visible.push(row);
      continue;
    }
    const key = `${row.action || "sync"}\u0000${row.user || "System"}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  for (const entries of grouped.values()) {
    visible.push(entries.length === 1 ? entries[0] : {
      ...entries[0],
      grouped_count: entries.length,
      detail: `${entries.length} successful periodic runs. Latest: ${entries[0].detail || "No further details"}`,
    });
  }
  return visible
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))
    .slice(0, 50);
}

export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="console-metric">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="console-metric-value mt-1">{value}</div>
    </div>
  );
}

export function CapacityLine({
  label,
  used,
  total,
  unit = "bytes",
}: {
  label: string;
  used: number;
  total: number;
  unit?: "bytes" | "cores";
}) {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(total) || total <= 0) {
    return <div className="console-capacity-line"><div className="console-capacity-heading"><span>{label}</span><span>Unavailable</span></div><p className="mt-1 text-xs text-muted-foreground">Usage or capacity was not reported for every included resource.</p></div>;
  }
  const percentage = Math.min(100, Math.round((used / total) * 100));
  const display =
    unit === "cores"
      ? `${used.toFixed(2)} / ${Math.round(total)} cores`
      : `${bytes(used)} / ${bytes(total)}`;
  const capacityTone = capacityToneForPercentage(percentage);
  return (
    <div className="console-capacity-line">
      <div className="console-capacity-heading">
        <span>{label}</span>
        <span className="font-mono">
          {total > 0 ? `${display} · ${percentage} %` : "—"}
        </span>
      </div>
      <div className="console-capacity-track">
        <span
          data-capacity-tone={capacityTone}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export function CapacityCell({
  used,
  total,
  format = bytes,
  empty = "—",
}: {
  used: number | null;
  total: number;
  format?: (value: number) => string;
  empty?: string;
}) {
  if (used === null || !Number.isFinite(used))
    return (
      <span className="text-xs text-muted-foreground">Not reported</span>
    );
  if (!Number.isFinite(total) || total <= 0)
    return (
      <span className="font-mono text-xs text-muted-foreground">{empty}</span>
    );
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((used / total) * 100)),
  );
  const capacityTone = capacityToneForPercentage(percentage);
  return (
    <div className="min-w-[10.5rem]">
      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
        <span className="font-mono text-foreground">
          {format(used)} / {format(total)}
        </span>
        <span className="text-muted-foreground">{percentage} %</span>
      </div>
      <div className="console-capacity-track mt-1">
        <span
          data-capacity-tone={capacityTone}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

// Tables are for comparison, not miniature dashboards. Keep the detailed
// capacity bars in the object summary and use one dense, tabular value per
// row here — the same reading pattern operators know from vCenter.
export function CompactUsage({
  used,
  total,
  format = bytes,
  empty = "—",
}: {
  used: number | null;
  total: number;
  format?: (value: number) => string;
  empty?: string;
}) {
  if (used === null || !Number.isFinite(used))
    return (
      <span className="text-xs text-muted-foreground">Not reported</span>
    );
  if (!Number.isFinite(total) || total <= 0)
    return (
      <span className="font-mono text-xs text-muted-foreground">{empty}</span>
    );
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((used / total) * 100)),
  );
  return (
    <span className="whitespace-nowrap font-mono text-xs tabular-nums">
      {format(used)} / {format(total)}{" "}
      <span className="text-muted-foreground">· {percentage} %</span>
    </span>
  );
}

export function ObjectOverview({ cluster, node }: { cluster: Cluster; node?: Node }) {
  const nodes = node ? [node] : cluster.nodes;
  const objectVms = node
    ? cluster.vms.filter((vm) => vm.node_name === node.name)
    : cluster.vms;
  const nodeVmCount = objectVms.length;
  const runningVmCount = objectVms.filter(
    (vm) => vm.status === "running",
  ).length;
  const managedVmCount = objectVms.filter((vm) =>
    Boolean(vm.fleet_server_id),
  ).length;
  const onlineNodeCount = nodes.filter(
    (item) => item.status === "online",
  ).length;
  const { cpuTotal, cpuUsed, memTotal, memUsed } = platformCapacity(nodes);
  const stores = preferredDatastores(
    node?.datastores ?? cluster.datastores ?? [],
  );
  const storageTotal = stores.reduce(
    (sum, store) => sum + (store.total || 0),
    0,
  );
  const storageUsed = stores.reduce((sum, store) => sum + (store.used || 0), 0);
  const primaryStore = stores[0];
  const isNode = Boolean(node);
  return (
    <Card className="console-object-summary">
      <CardContent className="grid p-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(21rem,0.65fr)]">
        <section className="console-object-summary-main">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <Server className="h-4 w-4 text-muted-foreground" />
            {isNode ? "Host summary" : "Platform summary"}
          </div>
          <div className="console-object-info-grid xl:grid-cols-3">
            <ObjectInfo
              label={isNode ? "Platform" : "Connection"}
              value={cluster.connections?.[0]?.name || "Proxmox"}
            />
            <ObjectInfo
              label="Node status"
              value={
                isNode
                  ? statusLabel(node!.status)
                  : `${onlineNodeCount} online / ${nodes.length}`
              }
            />
            <ObjectInfo
              label="VM operation"
              value={`${runningVmCount} running / ${nodeVmCount}`}
            />
            <ObjectInfo label="Host operations enabled" value={managedVmCount} />
            <ObjectInfo
              label={isNode ? "Uptime" : "Endpoint"}
              value={
                isNode
                  ? uptime(node!.uptime)
                  : cluster.endpoint.replace(/^https?:\/\//, "")
              }
              mono
            />
            <ObjectInfo
              label="Primary datastore"
              value={
                primaryStore
                  ? `${primaryStore.id}${primaryStore.node_name ? ` · ${primaryStore.node_name}` : ""}`
                  : "—"
              }
              mono
            />
          </div>
        </section>
        <section className="console-object-capacity border-t lg:border-l lg:border-t-0" aria-label="Capacity">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Capacity
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Source: Proxmox inventory. CPU and memory totals require every included node.</p>
          <div className="mt-3 space-y-3">
            <CapacityLine
              label="CPU"
              used={cpuUsed}
              total={cpuTotal}
              unit="cores"
            />
            <CapacityLine
              label="Memory"
              used={memUsed}
              total={memTotal}
            />
            <CapacityLine
              label={stores.some(store => /zfs/i.test(store.type || "")) ? "ZFS pool capacity" : "Selected datastore capacity"}
              used={storageUsed}
              total={storageTotal}
            />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

export function ObjectInfo({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <div className="console-object-info">
      <div>{label}</div>
      <div className={mono ? "font-mono" : ""}>{value === "" || value == null ? "—" : value}</div>
    </div>
  );
}
