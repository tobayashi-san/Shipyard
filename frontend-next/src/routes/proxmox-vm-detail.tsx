import { useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Camera,
  ClipboardList,
  Cpu,
  Database,
  HardDrive,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  OverflowItem,
  OverflowMenu,
  OverflowSep,
} from "@/components/ui/overflow-menu";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";

interface Vm {
  name: string;
  node_name: string;
  vm_id: number;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  fleet_server_id?: string | null;
  fleet_connection_id?: string | null;
}
interface Cluster {
  id: string;
  endpoint: string;
  connections?: Array<{ id: string; name: string }>;
  vms: Vm[];
}
interface InfrastructureResponse {
  clusters?: Cluster[];
}
interface Snapshot {
  name: string;
  description?: string;
  snaptime?: number;
  vmstate?: number | boolean;
}
interface SnapshotResponse {
  snapshots?: Snapshot[];
}
interface VmContext {
  adopted_server?: { id: string; name: string } | null;
  deployments?: Array<{
    workspace_id: string;
    workspace_name: string;
    vm_name: string;
    fleet_server_id?: string | null;
    last_run?: {
      id: string;
      action: string;
      status: string;
      started_at?: string;
      completed_at?: string;
    } | null;
  }>;
}
interface AuditEvent {
  action?: string;
  detail?: string;
  success?: boolean | 0 | 1;
  created_at?: string;
  user?: string;
}
interface VmConfiguration {
  hardware?: {
    sockets?: number;
    cores?: number;
    memory_mb?: number;
    os_type?: string | null;
    bios?: string | null;
    machine?: string | null;
    scsi_controller?: string | null;
    agent_enabled?: boolean;
    boot_order?: string | null;
  };
  disks?: Array<{
    bus: string;
    storage: string;
    size?: string | null;
    format?: string | null;
    discard?: boolean;
  }>;
  networks?: Array<{
    interface: string;
    model: string;
    bridge?: string | null;
    vlan_id?: string | null;
    mac_address?: string | null;
    firewall?: boolean;
  }>;
  guest?: {
    username?: string | null;
    ip_config?: Array<{
      interface: string;
      ipv4?: string | null;
      gateway?: string | null;
    }>;
  };
}

function tone(value: string): StatusTone {
  return value === "running"
    ? "success"
    : value === "stopped"
      ? "muted"
      : "danger";
}
function statusLabel(value: string) {
  const labels: Record<string, string> = {
    running: "Running",
    stopped: "Stopped",
    online: "Online",
    offline: "Offline",
    unknown: "Unknown",
  };
  return labels[value.toLowerCase()] || value || "Unknown";
}
function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}
function date(value?: number) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value * 1000))
    : "—";
}
function percent(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
}
function auditTime(value?: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function CapacityLine({
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
  const value = percent(used, total);
  const display =
    unit === "cores"
      ? `${used.toFixed(1)} / ${total} cores`
      : `${bytes(used)} / ${bytes(total)}`;
  const capacityTone =
    value >= 90 ? "critical" : value >= 75 ? "warning" : "healthy";
  return (
    <div className="console-capacity-line">
      <div className="console-capacity-heading">
        <span>{label}</span>
        <span className="font-mono">
          {total ? `${display} · ${value} %` : "—"}
        </span>
      </div>
      <div className="console-capacity-track">
        <span
          data-capacity-tone={capacityTone}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function VmConfigurationOverview({
  configuration,
  loading,
  unavailable,
}: {
  configuration?: VmConfiguration;
  loading: boolean;
  unavailable: boolean;
}) {
  if (unavailable)
    return (
      <Card>
        <CardHeader className="border-b bg-muted/15 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hardware & network
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 text-sm text-muted-foreground">
          This inventory VM has no direct platform connection configured.
        </CardContent>
      </Card>
    );
  if (loading)
    return (
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="h-16 animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  const hardware = configuration?.hardware;
  const disks = configuration?.disks || [];
  const networks = configuration?.networks || [];
  const ips = configuration?.guest?.ip_config || [];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,.85fr)]">
      <Card>
        <CardHeader className="border-b bg-muted/15 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            Hardware & guest
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="console-properties">
            <VmProperty
              label="CPU"
              value={
                hardware?.cores
                  ? `${hardware.sockets || 1} socket · ${hardware.cores} cores`
                  : "—"
              }
            />
            <VmProperty
              label="Memory"
              value={
                hardware?.memory_mb
                  ? `${hardware.memory_mb.toLocaleString("en-US")} MB`
                  : "—"
              }
              mono
            />
            <VmProperty
              label="Operating system"
              value={hardware?.os_type || "—"}
              mono
            />
            <VmProperty
              label="QEMU agent"
              value={
                hardware
                  ? hardware.agent_enabled
                    ? "Enabled"
                    : "Disabled"
                  : "—"
              }
            />
            <VmProperty
              label="BIOS / machine"
              value={
                hardware
                  ? [hardware.bios, hardware.machine]
                      .filter(Boolean)
                      .join(" · ") || "Proxmox default"
                  : "—"
              }
              mono
            />
            <VmProperty
              label="Boot order"
              value={hardware?.boot_order || "Proxmox default"}
              mono
            />
            <VmProperty
              label="Cloud-Init user"
              value={configuration?.guest?.username || "Not set"}
              mono
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b bg-muted/15 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            Virtual disks
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {disks.length ? (
            <div className="divide-y">
              {disks.map((disk) => (
                <div
                  key={disk.bus}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <span className="w-12 font-mono text-xs font-medium">
                    {disk.bus}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {disk.storage}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {disk.size || "—"}
                  </span>
                  {disk.discard ? (
                    <span className="text-xs text-muted-foreground">TRIM</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              No virtual disks reported.
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader className="border-b bg-muted/15 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            Network
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {networks.length ? (
            <div className="divide-y">
              {networks.map((network) => {
                const ip = ips.find(
                  (item) => item.interface === network.interface,
                );
                return (
                  <div
                    key={network.interface}
                    className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[5rem_minmax(8rem,1fr)_minmax(10rem,1fr)_minmax(12rem,1fr)] sm:items-center"
                  >
                    <span className="font-mono text-xs font-medium">
                      {network.interface}
                    </span>
                    <span className="text-sm">
                      {network.bridge || "No bridge"}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {network.vlan_id
                        ? `VLAN ${network.vlan_id}`
                        : "No VLAN"}{" "}
                      · {network.model}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {ip?.ipv4 || "DHCP / not configured"}
                      {ip?.gateway ? ` · GW ${ip.gateway}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              No network interfaces reported.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * VMware-style object header: the operational identity and the live capacity
 * belong to one surface.  Configuration remains a separate tab, so the
 * overview answers "what is this VM and can it run?" without a second,
 * nearly identical resource card lower on the page.
 */
function VmObjectSummary({
  vm,
  cluster,
  configuration,
  loading,
}: {
  vm: Vm;
  cluster: Cluster;
  configuration?: VmConfiguration;
  loading: boolean;
}) {
  const hardware = configuration?.hardware;
  const primaryNetwork = (configuration?.networks || [])[0];
  const primaryIp =
    (configuration?.guest?.ip_config || []).find(
      (item) => item.interface === primaryNetwork?.interface,
    ) || configuration?.guest?.ip_config?.[0];
  const primaryDisk = (configuration?.disks || [])[0];
  const cpuUsed = (vm.cpu || 0) * (vm.maxcpu || 0);
  const platformName =
    cluster.connections
      ?.map((connection) => connection.name)
      .filter(Boolean)
      .join(", ") || "Proxmox";
  const network = primaryNetwork
    ? `${primaryNetwork.bridge || "No bridge"}${primaryNetwork.vlan_id ? ` · VLAN ${primaryNetwork.vlan_id}` : ""}`
    : "Not reported";

  return (
    <Card className="console-object-summary">
      <CardContent className="grid p-0 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,.65fr)]">
        <section className="console-object-summary-main">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Server className="h-4 w-4 text-muted-foreground" />
              Virtual machine
            </div>
            {loading && (
              <span className="text-xs text-muted-foreground">
                Loading guest data…
              </span>
            )}
          </div>
          <div className="console-object-info-grid">
            <ObjectInfo label="Node" value={vm.node_name} mono />
            <ObjectInfo label="VM-ID" value={vm.vm_id} mono />
            <ObjectInfo label="Platform" value={platformName} />
            <ObjectInfo
              label="Management"
              value={vm.fleet_server_id ? "Fleet host" : "Inventory only"}
            />
            <ObjectInfo
              label="Operating system"
              value={hardware?.os_type || "Not reported"}
              mono
            />
            <ObjectInfo
              label="QEMU-Agent"
              value={
                hardware
                  ? hardware.agent_enabled
                    ? "Enabled"
                    : "Not enabled"
                  : "Not reported"
              }
            />
            <ObjectInfo
              label="IP address"
              value={primaryIp?.ipv4 || "DHCP / not reported"}
              mono
            />
            <ObjectInfo label="Network" value={network} mono />
            <ObjectInfo
              label="Datastore"
              value={primaryDisk?.storage || "Not reported"}
              mono
            />
            <ObjectInfo
              label="Gastbenutzer"
              value={configuration?.guest?.username || "Not set"}
              mono
            />
          </div>
        </section>
        <section
          className="console-object-capacity"
          aria-label="Live usage"
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Live usage
          </div>
          <div className="mt-4 space-y-3">
            <CapacityLine
              label="CPU"
              used={cpuUsed}
              total={vm.maxcpu || 0}
              unit="cores"
            />
            <CapacityLine
              label="Memory"
              used={vm.mem}
              total={vm.maxmem}
            />
            <CapacityLine label="Disk" used={vm.disk} total={vm.maxdisk} />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function VmProperty({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="console-property">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}

function actionLabel(action?: string) {
  return String(action || "Proxmox action")
    .replace(/^infrastructure\./, "")
    .replace(/_/g, " ");
}

// Keep VM task rows in the same order as platform/node task tables. Operators
// scan a task chronologically first, then need its action, context and actor.
function VmTaskRows({
  events,
  limit,
}: {
  events: AuditEvent[];
  limit?: number;
}) {
  const rows = limit ? events.slice(0, limit) : events;
  if (rows.length === 0)
    return (
      <div className="px-4 py-5 text-sm text-muted-foreground">
        No direct Proxmox actions have been recorded for this VM yet.
      </div>
    );
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map((event, index) => (
          <div
            key={`${event.created_at || "event"}-${index}`}
            className="space-y-1.5 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {actionLabel(event.action)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {auditTime(event.created_at)} · {event.user || "System"}
                </div>
              </div>
              <StatusBadge
                tone={
                  event.success === false || event.success === 0
                    ? "danger"
                    : "success"
                }
                dot
              >
                {event.success === false || event.success === 0
                  ? "Failed"
                  : "Successful"}
              </StatusBadge>
            </div>
            {event.detail && (
              <p
                className="truncate text-xs text-muted-foreground"
                title={event.detail}
              >
                {event.detail}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="table-scroll hidden md:block">
        <table data-density="compact" className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Task</th>
              <th>Details</th>
              <th>Run by</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event, index) => (
              <tr key={`${event.created_at || "event"}-${index}`}>
                <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {auditTime(event.created_at)}
                </td>
                <td className="font-medium">{actionLabel(event.action)}</td>
                <td className="max-w-[24rem]">
                  <span
                    className="block truncate text-muted-foreground"
                    title={event.detail}
                  >
                    {event.detail || "—"}
                  </span>
                </td>
                <td className="text-muted-foreground">
                  {event.user || "System"}
                </td>
                <td>
                  <StatusBadge
                    tone={
                      event.success === false || event.success === 0
                        ? "danger"
                        : "success"
                    }
                    dot
                  >
                    {event.success === false || event.success === 0
                      ? "Failed"
                      : "Successful"}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RecentVmTasks({ events }: { events: AuditEvent[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/15 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" />
            Recent tasks
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The most recent actions sent directly to Proxmox for this VM.
          </p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {events.length}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        <VmTaskRows events={events} limit={4} />
      </CardContent>
    </Card>
  );
}

function VmProtectionSummary({
  snapshots,
  available,
  canManage,
  onCreate,
}: {
  snapshots: Snapshot[];
  available: boolean;
  canManage: boolean;
  onCreate: () => void;
}) {
  const latest = snapshots.reduce<Snapshot | undefined>(
    (current, snapshot) =>
      !current || (snapshot.snaptime || 0) > (current.snaptime || 0)
        ? snapshot
        : current,
    undefined,
  );
  const withMemory = snapshots.filter((snapshot) =>
    Boolean(snapshot.vmstate),
  ).length;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b bg-muted/15 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" />
            Schutz & Snapshots
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Restore points managed directly through Proxmox.
          </p>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            <Camera />
            Create snapshot
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {!available ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            No direct platform connection configured.
          </div>
        ) : (
          <dl className="console-properties">
            <VmProperty
              label="Snapshots"
              value={`${snapshots.length} available`}
              mono
            />
            <VmProperty
              label="Last snapshot"
              value={
                latest
                  ? `${latest.name} · ${date(latest.snaptime)}`
                  : "No snapshots yet"
              }
              mono
            />
            <VmProperty
              label="RAM state"
              value={
                withMemory
                  ? `${withMemory} snapshot${withMemory === 1 ? "" : "s"} with RAM`
                  : "No RAM state saved"
              }
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function ProxmoxVmDetailPage() {
  const { clusterId, nodeName, vmId } = useParams({ strict: false }) as {
    clusterId: string;
    nodeName: string;
    vmId: string;
  };
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotDescription, setSnapshotDescription] = useState("");
  const [powerAction, setPowerAction] = useState<
    "start" | "shutdown" | "reboot" | "stop" | null
  >(null);
  const [deleteSnapshot, setDeleteSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState("overview");
  const inventory = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId],
    queryFn: () =>
      apiFetch<InfrastructureResponse>(
        `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    staleTime: 15_000,
  });
  const cluster = useMemo(
    () =>
      (Array.isArray(inventory.data?.clusters)
        ? inventory.data!.clusters!
        : []
      ).find((item) => item.id === clusterId),
    [clusterId, inventory.data],
  );
  const vm = cluster?.vms.find(
    (item) => item.node_name === nodeName && item.vm_id === Number(vmId),
  );
  const connectionId = vm?.fleet_connection_id || cluster?.connections?.[0]?.id;
  const apiRoot =
    connectionId && vm
      ? `/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/vms/${encodeURIComponent(vm.node_name)}/${encodeURIComponent(String(vm.vm_id))}`
      : null;
  const snapshots = useQuery({
    queryKey: ["proxmox-vm-snapshots", connectionId, nodeName, vmId],
    queryFn: () => apiFetch<SnapshotResponse>(`${apiRoot}/snapshots`),
    enabled: Boolean(apiRoot),
    staleTime: 10_000,
  });
  const context = useQuery({
    queryKey: ["proxmox-vm-context", connectionId, nodeName, vmId],
    queryFn: () => apiFetch<VmContext>(`${apiRoot}/context`),
    enabled: Boolean(apiRoot),
    staleTime: 10_000,
  });
  // The inventory already carries the authoritative adopted-host ID. Use it
  // as an immediate fallback while the richer context request is refreshed.
  const adoptedServer =
    context.data?.adopted_server ||
    (vm?.fleet_server_id
      ? { id: vm.fleet_server_id, name: "Fleet host adopted" }
      : null);
  const configuration = useQuery({
    queryKey: ["proxmox-vm-configuration", connectionId, nodeName, vmId],
    queryFn: () => apiFetch<VmConfiguration>(`${apiRoot}/configuration`),
    enabled: Boolean(apiRoot),
    staleTime: 15_000,
  });
  const canEdit = hasCap(profile, "canEditServers");
  // Keep the VM's "Tasks" tab aligned with platform/node pages and the
  // backend capability model.  An operations role with audit access should
  // not need to be made an administrator just to inspect VM changes.
  const canViewAudit = hasCap(profile, "canViewAudit");
  const canPower = hasCap(profile, "canRebootServers") && canEdit;
  const canControl = Boolean(apiRoot) && canPower;
  const canManageSnapshots = Boolean(apiRoot) && canEdit;
  const audit = useQuery({
    queryKey: ["audit-log", "proxmox-vm", vmId, nodeName],
    queryFn: () => apiFetch<AuditEvent[]>("/system/audit?limit=100"),
    enabled: canViewAudit,
    staleTime: 15_000,
  });
  const vmEvents = useMemo(
    () =>
      (Array.isArray(audit.data) ? audit.data : [])
        .filter((event) => {
          const detail = String(event.detail || "");
          return (
            detail.includes(`vm=${vm?.name}`) ||
            detail.includes(`vm_id=${vm?.vm_id}`)
          );
        })
        .slice(0, 8),
    [audit.data, vm?.name, vm?.vm_id],
  );
  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: ["opentofu", "infrastructure", environmentId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-snapshots", connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-context", connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-configuration", connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["audit-log", "proxmox-vm", vmId, nodeName],
    });
  };
  const power = useMutation({
    mutationFn: (action: string) => {
      if (!apiRoot)
        throw new Error(
          "No platform connection is configured for this VM.",
        );
      return apiFetch(`${apiRoot}/power`, { method: "POST", body: { action } });
    },
    onSuccess: (_data, action) => {
      showToast(`VM action “${action}” was sent to Proxmox.`, "success");
      setPowerAction(null);
      invalidate();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const createSnapshot = useMutation({
    mutationFn: () => {
      if (!apiRoot)
        throw new Error(
          "No platform connection is configured for this VM.",
        );
      return apiFetch(`${apiRoot}/snapshots`, {
        method: "POST",
        body: { name: snapshotName, description: snapshotDescription },
      });
    },
    onSuccess: () => {
      showToast("Snapshot was sent to Proxmox.", "success");
      setSnapshotOpen(false);
      setSnapshotName("");
      setSnapshotDescription("");
      invalidate();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const removeSnapshot = useMutation({
    mutationFn: (snapshot: Snapshot) => {
      if (!apiRoot)
        throw new Error(
          "No platform connection is configured for this VM.",
        );
      return apiFetch(
        `${apiRoot}/snapshots/${encodeURIComponent(snapshot.name)}`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      showToast("Snapshot is being deleted in Proxmox.", "success");
      setDeleteSnapshot(null);
      invalidate();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  if (inventory.isLoading)
    return (
      <div className="space-y-5">
        <div className="h-8 w-72 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />
      </div>
    );
  if (!cluster || !vm)
    return (
      <EmptyState
        icon={<Database className="h-5 w-5" />}
        title="Proxmox VM not found"
        description="The inventory changed or the virtual machine is no longer present on this platform."
        action={
          <Button asChild variant="outline">
            <Link to="/infrastructure">
              <ArrowLeft />
              Back to infrastructure
            </Link>
          </Button>
        }
      />
    );

  const snapshotItems = (snapshots.data?.snapshots || []).filter(
    (snapshot) => snapshot.name !== "current",
  );
  const powerLabel: Record<string, string> = {
    start: "Start",
    shutdown: "Shut down",
    reboot: "Restart",
    stop: "Stop immediately",
  };
  const platformName = cluster.connections?.[0]?.name || "Proxmox";
  const isRunning = vm.status === "running";
  const isStopped = vm.status === "stopped";
  return (
    <div className="space-y-5">
      <PageHeader
        title={vm.name}
        eyebrow="Virtual machine"
        badge={
          <StatusBadge tone={tone(vm.status)} dot>
            {statusLabel(vm.status)}
          </StatusBadge>
        }
        description={`${platformName} · ${vm.node_name} · VM-ID ${vm.vm_id}`}
        breadcrumbs={
          <>
            <Link
              to="/infrastructure"
              className="hover:text-foreground hover:underline"
            >
              Infrastructure
            </Link>
            <span aria-hidden="true">/</span>
            <Link
              to="/infrastructure/$clusterId"
              params={{ clusterId }}
              className="hover:text-foreground hover:underline"
            >
              {platformName}
            </Link>
            <span aria-hidden="true">/</span>
            <Link
              to="/infrastructure/$clusterId/nodes/$nodeName"
              params={{ clusterId, nodeName: vm.node_name }}
              className="font-mono hover:text-foreground hover:underline"
            >
              {vm.node_name}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">{vm.name}</span>
          </>
        }
        back={
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label={`Zu Node ${vm.node_name}`}
          >
            <Link
              to="/infrastructure/$clusterId/nodes/$nodeName"
              params={{ clusterId, nodeName: vm.node_name }}
            >
              <ArrowLeft />
            </Link>
          </Button>
        }
        actions={
          <>
            {canViewAudit && (
              <Button asChild size="sm" variant="outline">
                <Link to="/operations">
                  <ClipboardList />
                  Tasks
                </Link>
              </Button>
            )}
            {canControl && isStopped && (
              <Button
                size="sm"
                onClick={() => setPowerAction("start")}
                disabled={power.isPending}
              >
                <Play />
                Start
              </Button>
            )}
            {canControl && isRunning && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPowerAction("reboot")}
                disabled={power.isPending}
              >
                <RotateCw />
                Restart
              </Button>
            )}
            {canControl && (
              <OverflowMenu title="More VM actions" width="w-64">
                <OverflowItem
                  icon={Square}
                  disabled={power.isPending || !isRunning}
                  onClick={() => setPowerAction("shutdown")}
                >
                  Shut down
                </OverflowItem>
                <OverflowItem
                  icon={RotateCw}
                  disabled={power.isPending || !isRunning}
                  onClick={() => setPowerAction("reboot")}
                >
                  Restart
                </OverflowItem>
                <OverflowSep />
                <OverflowItem
                  icon={Square}
                  danger
                  disabled={power.isPending || !isRunning}
                  onClick={() => setPowerAction("stop")}
                >
                  Stop immediately…
                </OverflowItem>
              </OverflowMenu>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Refresh inventory"
              onClick={() => void inventory.refetch()}
              disabled={inventory.isFetching}
            >
              <RefreshCw
                className={inventory.isFetching ? "animate-spin" : undefined}
              />
            </Button>
          </>
        }
      />
      <VmObjectSummary
        vm={vm}
        cluster={cluster}
        configuration={configuration.data}
        loading={configuration.isLoading}
      />
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList aria-label="VM sections" className="console-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configuration">
            <Server className="h-4 w-4" />
            Configuration
          </TabsTrigger>
          <TabsTrigger value="snapshots">
            <Camera className="h-4 w-4" />
            Snapshots{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {snapshotItems.length}
            </span>
          </TabsTrigger>
          {canViewAudit && (
            <TabsTrigger value="tasks">
              <ClipboardList className="h-4 w-4" />
              Tasks{" "}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {vmEvents.length}
              </span>
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview" className="mt-0 space-y-4">
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,.55fr)]">
            <Card>
              <CardHeader className="border-b bg-muted/15 py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ClipboardList className="h-4 w-4" />
                  Management & provisioning
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Connections, declaration, and management for this virtual
                  machine.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {context.isLoading && !adoptedServer ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Loading connections…
                  </div>
                ) : (
                  <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                    <section className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Fleet management
                      </div>
                      <div className="mt-2 text-sm font-medium">
                        {adoptedServer
                          ? adoptedServer.name
                          : "Not adopted as a Fleet host"}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {adoptedServer
                          ? "SSH, updates, and playbooks are available through Fleet."
                          : "The VM remains in platform inventory until it is explicitly adopted."}
                      </p>
                      {adoptedServer && (
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                          className="mt-3"
                        >
                          <Link
                            to="/servers/$id"
                            params={{ id: adoptedServer.id }}
                          >
                            Open Fleet host
                          </Link>
                        </Button>
                      )}
                    </section>
                    <section className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Declarative provisioning
                      </div>
                      {(context.data?.deployments || []).length ? (
                        <div className="mt-2 space-y-2">
                          {(context.data?.deployments || []).map(
                            (deployment) => (
                              <div
                                key={`${deployment.workspace_id}:${deployment.vm_name}`}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <div>
                                  <div className="text-sm font-medium">
                                    {deployment.workspace_name}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {deployment.last_run
                                      ? `${deployment.last_run.action} · ${deployment.last_run.status}`
                                      : "No runs yet"}
                                  </div>
                                </div>
                                <Button asChild size="sm" variant="outline">
                                  <Link
                                    to="/deployments/$id"
                                    params={{ id: deployment.workspace_id }}
                                  >
                                    Open
                                  </Link>
                                </Button>
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          No OpenTofu deployment defines this VM.
                        </p>
                      )}
                    </section>
                  </div>
                )}
              </CardContent>
            </Card>
            <VmProtectionSummary
              snapshots={snapshotItems}
              available={Boolean(apiRoot)}
              canManage={canManageSnapshots}
              onCreate={() => setSnapshotOpen(true)}
            />
          </div>
          {canViewAudit && <RecentVmTasks events={vmEvents} />}
        </TabsContent>
        <TabsContent value="configuration" className="mt-0">
          <VmConfigurationOverview
            configuration={configuration.data}
            loading={configuration.isLoading}
            unavailable={!apiRoot}
          />
        </TabsContent>
        <TabsContent value="snapshots" className="mt-0">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/15 py-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Camera className="h-4 w-4" />
                  Snapshots
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Snapshots are created and managed directly through the
                  Proxmox API.
                </p>
              </div>
              {canManageSnapshots && (
                <Button size="sm" onClick={() => setSnapshotOpen(true)}>
                  <Camera />
                  Create snapshot
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {!apiRoot ? (
                <div className="p-5 text-sm text-muted-foreground">
                  No direct platform connection is configured. Assign a Proxmox
                  platform to the deployment to manage snapshots centrally.
                </div>
              ) : snapshots.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Loading snapshots…
                </div>
              ) : snapshotItems.length === 0 ? (
                <div className="p-5 text-sm text-muted-foreground">
                  No snapshots available.
                </div>
              ) : (
                <div className="divide-y">
                  {snapshotItems.map((snapshot) => (
                    <div
                      key={snapshot.name}
                      className="flex flex-wrap items-center gap-3 p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono font-medium">
                          {snapshot.name}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {snapshot.description || "No description"} ·{" "}
                          {date(snapshot.snaptime)}
                        </div>
                      </div>
                      {snapshot.vmstate ? (
                        <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                          Includes RAM
                        </span>
                      ) : null}
                      {canManageSnapshots && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteSnapshot(snapshot)}
                        >
                          <Trash2 />
                          Delete
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        {canViewAudit && (
          <TabsContent value="tasks" className="mt-0">
            <Card>
              <CardHeader className="border-b bg-muted/15 py-3">
                <CardTitle className="text-base">Tasks</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Direct Proxmox actions for this VM, traceable through the
                  audit log.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {audit.isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Loading tasks…
                  </div>
                ) : (
                  <VmTaskRows events={vmEvents} />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create snapshot</DialogTitle>
            <DialogDescription>
              The VM is captured with its current RAM state. Processing then
              continues in Proxmox.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="snapshot-name">Name</Label>
              <Input
                id="snapshot-name"
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
                placeholder="before-update"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snapshot-description">Description</Label>
              <Input
                id="snapshot-description"
                value={snapshotDescription}
                onChange={(event) => setSnapshotDescription(event.target.value)}
                placeholder="Before the update"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnapshotOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createSnapshot.mutate()}
              disabled={!snapshotName.trim() || createSnapshot.isPending}
            >
              <Camera />
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(powerAction)}
        onOpenChange={(open) => !open && setPowerAction(null)}
        title={`${powerAction ? powerLabel[powerAction] : "VM action"}?`}
        description={
          powerAction === "stop" ? (
            <>
              The VM <strong>{vm.name}</strong> will be powered off immediately.
              Unsaved guest data may be lost.
            </>
          ) : (
            <>
              The action is sent directly to Proxmox for{" "}
              <strong>{vm.name}</strong>.
            </>
          )
        }
        confirmLabel={powerAction ? powerLabel[powerAction] : "Run action"}
        cancelLabel="Cancel"
        variant={powerAction === "stop" ? "destructive" : "warning"}
        confirmTextValue={
          powerAction === "stop" ? `STOP ${vm.name}` : undefined
        }
        confirmInputLabel="Enter to confirm"
        confirmInputHelp={
          <>
            Enter <strong className="font-mono">STOP {vm.name}</strong>.
          </>
        }
        onConfirm={() => powerAction && power.mutate(powerAction)}
        isPending={power.isPending}
      />
      <ConfirmDialog
        open={Boolean(deleteSnapshot)}
        onOpenChange={(open) => !open && setDeleteSnapshot(null)}
        title="Delete snapshot?"
        description={
          <>
            The snapshot{" "}
            <strong className="font-mono">{deleteSnapshot?.name}</strong> will
            be deleted in Proxmox and cannot be restored.
          </>
        }
        confirmLabel="Delete snapshot"
        cancelLabel="Cancel"
        variant="destructive"
        confirmTextValue={deleteSnapshot?.name || ""}
        confirmInputLabel="Enter the snapshot name to confirm"
        onConfirm={() =>
          deleteSnapshot && removeSnapshot.mutate(deleteSnapshot)
        }
        isPending={removeSnapshot.isPending}
      />
    </div>
  );
}

function ObjectInfo({
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
      <div className={mono ? "font-mono" : ""}>{value || "—"}</div>
    </div>
  );
}
