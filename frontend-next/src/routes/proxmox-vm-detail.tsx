import { DeploymentDefinition } from '@/routes/deployment-detail';
import { guestOsLabel, bootOrderLabel } from '@/features/infrastructure/vm-display';
import { guestMetricPercent, guestMetricExplanation } from '@/features/infrastructure/guest-metrics';
import type { ReactNode } from 'react';
import { Timestamp } from '@/components/ui/timestamp';
import {guestAuditPresentation} from '@/lib/audit-display';
import {RestoreSnapshotDialog} from '@/features/infrastructure/RestoreSnapshotDialog';
import {GuestPowerDialog} from '@/features/infrastructure/GuestPowerDialog';
import {DeleteSnapshotDialog} from '@/features/infrastructure/DeleteSnapshotDialog';
import { GuestTaskHistory } from '@/features/infrastructure/GuestTaskHistory';
import { CreateSnapshotDialog } from '@/features/infrastructure/CreateSnapshotDialog';
import { OverflowMenu, OverflowItem } from '@/components/ui/overflow-menu';
import { managementLabel } from '@/lib/resource-model';
import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "@tanstack/react-router";
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
import { PageHeader, type PageHeaderProps } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { canAccessDeployments, hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { useUrlTab } from "@/lib/use-url-tab";
import { formatDateTime } from "@/lib/utils";

interface Vm {
  name: string;
  node_name: string;
  vm_id: number;
  guest_type?: "qemu" | "lxc";
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number | null;
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
  updated_at?: string;
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
    definition_id?: string | null;
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
  guest_type?: "qemu" | "lxc";
  hardware?: {
    sockets?: number;
    cores?: number;
    memory_mb?: number;
    os_type?: string | null;
    bios?: string | null;
    machine?: string | null;
    scsi_controller?: string | null;
    agent_enabled?: boolean | null;
    boot_order?: string | null;
  };
  container?: { architecture?: string | null; unprivileged?: boolean | null; swap_mb?: number | null; cpu_limit?: number | null };
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
function date(value?: number) {
  return <Timestamp value={value == null ? undefined : value * 1000} />;
}
function auditTime(value?: string) {
  return formatDateTime(value);
}

export function VmConfigurationOverview({
  configuration,
  guestType,
  loading,
  error,
  onRetry,
  unavailable,
}: {
  configuration?: VmConfiguration;
  guestType?: "qemu" | "lxc";
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  unavailable: boolean;
}) {
  const isContainer = (guestType ?? configuration?.guest_type) === "lxc";
  const resourceLabel = isContainer ? "Container" : "Virtual machine";
  if (unavailable)
    return (
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hardware & network
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 text-sm text-muted-foreground">
          This inventory resource has no direct platform connection configured.
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
  if (error)
    return (
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hardware & network
          </CardTitle>
        </CardHeader>
        <QueryErrorState
          compact
          error={error}
          title={`${resourceLabel} configuration could not be loaded`}
          onRetry={onRetry}
        />
      </Card>
    );
  const hardware = configuration?.hardware;
  const disks = configuration?.disks || [];
  const networks = configuration?.networks || [];
  const ips = configuration?.guest?.ip_config || [];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(23rem,.85fr)]">
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            {isContainer ? "Container configuration" : "Hardware & virtual machine"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="console-properties">
            <VmProperty
              label="CPU"
              value={
                hardware?.cores
                  ? isContainer ? `${hardware.cores} cores` : `${hardware.sockets || 1} socket · ${hardware.cores} cores`
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
              value={guestOsLabel(hardware?.os_type)}
              mono
            />
            {isContainer ? <>
              <VmProperty label="Architecture" value={configuration?.container?.architecture || "Not reported"} />
              <VmProperty label="Privilege mode" value={configuration?.container?.unprivileged == null ? "Not reported" : configuration.container.unprivileged ? "Unprivileged" : "Privileged"} />
              <VmProperty label="Swap limit" value={configuration?.container?.swap_mb == null ? "Not reported" : `${configuration.container.swap_mb.toLocaleString("en-US")} MB`} />
              <VmProperty label="CPU limit" value={configuration?.container?.cpu_limit == null ? "Not reported" : configuration.container.cpu_limit === 0 ? "No CPU time limit" : `${configuration.container.cpu_limit} CPU cores`} />
            </> : <>
            <VmProperty
              label="QEMU agent configuration"
              value={
                hardware?.agent_enabled == null
                  ? 'Not applicable or configuration unavailable'
                  : hardware.agent_enabled
                    ? 'Enabled in Proxmox · guest reachability not checked'
                    : 'Disabled in Proxmox'
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
              value={bootOrderLabel(hardware?.boot_order)}
              mono
            />
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Raw Proxmox configuration values</summary><p className="mt-2 break-all font-mono">OS: {hardware?.os_type || '—'} · Boot: {hardware?.boot_order || 'default'}</p></details>
            <VmProperty
              label="Cloud-Init user"
              value={configuration?.guest?.username || "Not set"}
              mono
            />
            </>}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            {isContainer ? "Root filesystem & mount points" : "Virtual disks"}
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
              {isContainer ? "No root filesystem or mount points reported." : "No virtual disks reported."}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader className="border-b py-3">
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
  managementState,
  hostName,
  vm,
  cluster,
  configuration,
  loading,
}: {
  managementState: string;
  hostName?: string;
  vm: Vm;
  cluster: Cluster;
  configuration?: VmConfiguration;
  loading: boolean;
}) {
  const primaryNetwork = (configuration?.networks || [])[0];
  const primaryIp =
    (configuration?.guest?.ip_config || []).find(
      (item) => item.interface === primaryNetwork?.interface,
    ) || configuration?.guest?.ip_config?.[0];

  const platformName =
    cluster.connections
      ?.map((connection) => connection.name)
      .filter(Boolean)
      .join(", ") || "Proxmox";
  const kind = vm.guest_type === "lxc" ? "CT" : "VM";
  const cpuSample = vm.maxcpu > 0 ? guestMetricPercent(vm.cpu, 1, true) : null;
  const memorySample = guestMetricPercent(vm.mem, vm.maxmem);
  const diskSample = guestMetricPercent(vm.disk, vm.maxdisk);

  return (
    <Card className="console-object-summary">
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span>{vm.guest_type === "lxc" ? "LXC container" : "Virtual machine"}</span>
            <StatusBadge tone={vm.status === "running" ? "success" : "muted"} dot>{statusLabel(vm.status || "unknown")}</StatusBadge>
            {loading && <span className="text-xs font-normal text-muted-foreground">Refreshing…</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Node <strong className="font-mono font-medium text-foreground">{vm.node_name}</strong></span>
            <span>{kind}-ID <strong className="font-mono font-medium text-foreground">{vm.vm_id}</strong></span>
            <span>Platform <strong className="font-medium text-foreground">{platformName}</strong></span>
            <span>Configured IPv4 <strong className="font-mono font-medium text-foreground">{primaryIp?.ipv4 || (configuration ? "No address in Proxmox configuration" : "Configuration not loaded")}</strong></span>
            <span>{managementState}</span>
            {hostName && <span>Host <strong className="font-medium text-foreground">{hostName}</strong></span>}
          </div>
          <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Data source: Proxmox · {(!cpuSample || !memorySample || !diskSample) ? 'some measurements unavailable' : 'inventory measurements'}</summary>
            <p className="mt-2">Configured addresses and the guest's current addresses may differ. Agent configuration does not confirm a running agent. Host measurements are collected separately and can have a different timestamp.</p>
            {(vm.status === "stopped" || !cpuSample || !memorySample || !diskSample) && <p className="mt-1">{guestMetricExplanation(vm.status)}</p>}
            {!diskSample && <p className="mt-1">Filesystem usage was not supplied by Proxmox. Inspect the guest agent or the linked host's System view for host-collected storage data.</p>}
          </details>
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-4 border-t pt-3 text-xs lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0" aria-label="Proxmox inventory usage">
          <div><span className="block text-muted-foreground">CPU</span><strong className="font-mono">{cpuSample ?? "No sample"}</strong></div>
          <div><span className="block text-muted-foreground">Memory</span><strong className="font-mono">{memorySample ?? "No sample"}</strong></div>
          <div><span className="block text-muted-foreground">Disk</span><strong className="font-mono">{diskSample ?? "No sample"}</strong></div>
        </div>
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
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="console-property console-property-wrap">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
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
                  {guestAuditPresentation(event).label}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {auditTime(event.created_at)} · {event.user || "System"}
                </div>
              </div>
              <StatusBadge
                tone={guestAuditPresentation(event).tone}
                dot
              >
                {guestAuditPresentation(event).outcome}
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
              <th>Time</th>
              <th>Task</th>
              <th>Details</th>
              <th>Run by</th>
              <th>Audit result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event, index) => (
              <tr key={`${event.created_at || "event"}-${index}`}>
                <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {auditTime(event.created_at)}
                </td>
                <td className="font-medium">{guestAuditPresentation(event).label}</td>
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
                    tone={guestAuditPresentation(event).tone}
                    dot
                  >
                    {guestAuditPresentation(event).outcome}
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

function RecentVmTasks({
  events,
  loading,
  error,
  onRetry,
}: {
  events: AuditEvent[];
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b py-3">
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
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading audit activity…</div>
        ) : error ? (
          <QueryErrorState compact error={error} title="Guest audit activity could not be loaded" onRetry={onRetry} />
        ) : (
          <VmTaskRows events={events} limit={4} />
        )}
      </CardContent>
    </Card>
  );
}

function VmProtectionSummary({
  snapshots,
  available,
  loading,
  error,
  onRetry,
  canManage,
  onCreate,
}: {
  snapshots: Snapshot[];
  available: boolean;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
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
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" />
            Protection & snapshots
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
        ) : loading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading snapshots…</div>
        ) : error ? (
          <QueryErrorState compact error={error} title="Snapshots could not be loaded" onRetry={onRetry} />
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
                  ? <><span className="block">{latest.name}</span><span className="block font-normal">{date(latest.snaptime)}</span></>
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

function VmHeader({ embedded, ...props }: PageHeaderProps & { embedded: boolean }) {
  if (!embedded) return <PageHeader {...props} />;
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{props.badge}{props.description}</div>
    <div className="flex flex-wrap items-center gap-2">{props.actions}</div>
  </div>;
}

export function ProxmoxVmDetailPage() {
  const { clusterId, nodeName, vmId } = useParams({ strict: false }) as {
    clusterId: string;
    nodeName: string;
    vmId: string;
  };
  return <VmDetailContent clusterId={clusterId} nodeName={nodeName} vmId={vmId} />;
}

export function VmDetailContent({ clusterId, nodeName, vmId, embedded = false, section }: {
  clusterId: string; nodeName: string; vmId: string; embedded?: boolean; section?: string;
}) {
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [auditPage, setAuditPage] = useState({scope:"",offset:0});
  const [restoreSnapshot, setRestoreSnapshot] = useState<Snapshot|null>(null);
  const [powerAction, setPowerAction] = useState<
    "start" | "shutdown" | "reboot" | "stop" | null
  >(null);
  const [deleteSnapshot, setDeleteSnapshot] = useState<Snapshot | null>(null);
  const availableTabs = useMemo(
    () => ["overview", "configuration", "snapshots", "tasks"],
    [],
  );
  const vmTabs = useUrlTab("overview", availableTabs, embedded ? "vmTab" : "tab");
  const activeVmSection = section || vmTabs.value;
  const inventory = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId],
    queryFn: () =>
      apiFetch<InfrastructureResponse>(
        `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`, {environmentId},
    ),
    staleTime: 15_000,
    refetchInterval: 2_500,
  });
  const summaryInventory = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId, "summary"],
    queryFn: () => apiFetch<InfrastructureResponse>(
      `/opentofu/infrastructure-summary?environment_id=${encodeURIComponent(environmentId)}`, {environmentId},
    ),
    staleTime: 30_000,
  });
  const refreshInventory = async () => {
    const data = await apiFetch<InfrastructureResponse>(
      `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}&refresh=1`, {environmentId},
    );
    qc.setQueryData(["opentofu", "infrastructure", environmentId], data);
  };
  const cluster = useMemo(() => {
    const full = (Array.isArray(inventory.data?.clusters) ? inventory.data!.clusters! : []).find((item) => item.id === clusterId);
    if (full) return full;
    if (!inventory.isError) return undefined;
    return (Array.isArray(summaryInventory.data?.clusters) ? summaryInventory.data!.clusters! : []).find((item) => item.id === clusterId);
  }, [clusterId, inventory.data, inventory.isError, summaryInventory.data]);
  const vm = cluster?.vms.find(
    (item) => item.node_name === nodeName && item.vm_id === Number(vmId),
  );
  const connectionId = vm?.fleet_connection_id || cluster?.connections?.[0]?.id;
  const apiRoot =
    connectionId && vm
      ? `/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/vms/${encodeURIComponent(vm.node_name)}/${encodeURIComponent(String(vm.vm_id))}`
      : null;
  const auditScope = `${environmentId}:${apiRoot}`;
  const auditOffset = activeVmSection === "tasks" && auditPage.scope===auditScope ? auditPage.offset : 0;
  const setAuditOffset = (offset:number) => setAuditPage({scope:auditScope,offset});
  const snapshots = useQuery({
    queryKey: ["proxmox-vm-snapshots", environmentId, connectionId, nodeName, vmId],
    queryFn: () => apiFetch<SnapshotResponse>(`${apiRoot}/snapshots`, {environmentId}),
    enabled: Boolean(apiRoot) && (activeVmSection === "overview" || activeVmSection === "snapshots"),
    staleTime: 10_000,
  });
  const context = useQuery({
    queryKey: ["proxmox-vm-context", environmentId, connectionId, nodeName, vmId],
    queryFn: () => apiFetch<VmContext>(`${apiRoot}/context`, {environmentId}),
    enabled: Boolean(apiRoot),
    staleTime: 10_000,
  });
  // The inventory already carries the authoritative adopted-host ID. Use it
  // as an immediate fallback while the richer context request is refreshed.
  const adoptedServer =
    context.data?.adopted_server ||
    (vm?.fleet_server_id
      ? { id: vm.fleet_server_id, name: `Linked host ${vm.fleet_server_id}` }
      : null);
  const linkedHost = useQuery({
    queryKey: ['vm-linked-host', environmentId, adoptedServer?.id],
    queryFn: () => apiFetch<{id:string}>(`/servers/${encodeURIComponent(adoptedServer!.id)}`, {environmentId}),
    enabled: !embedded && Boolean(adoptedServer?.id) && hasCap(profile, 'canViewServers'),
    retry: false,
  });
  const configuration = useQuery({
    queryKey: ["proxmox-vm-configuration", environmentId, connectionId, nodeName, vmId],
    queryFn: () => apiFetch<VmConfiguration>(`${apiRoot}/configuration`, {environmentId}),
    enabled: Boolean(apiRoot) && (activeVmSection === "overview" || activeVmSection === "configuration"),
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
    queryKey: ["audit-log", "proxmox-vm", environmentId, apiRoot, auditOffset],
    queryFn: () => apiFetch<{events:AuditEvent[];total:number}>(`${apiRoot}/audit?offset=${auditOffset}`, {environmentId}),
    enabled: Boolean(apiRoot) && canViewAudit && (activeVmSection === "overview" || activeVmSection === "tasks"),
    staleTime: 15_000,
  });
  const vmEvents = audit.data?.events || [];
  const invalidate = () => {
    void qc.invalidateQueries({queryKey:["proxmox-guest-tasks",environmentId,apiRoot]});
    void qc.invalidateQueries({
      queryKey: ["opentofu", "infrastructure", environmentId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-snapshots", environmentId, connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-context", environmentId, connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["proxmox-vm-configuration", environmentId, connectionId, nodeName, vmId],
    });
    void qc.invalidateQueries({
      queryKey: ["audit-log", "proxmox-vm", environmentId, apiRoot],
    });
  };

  if (!embedded && adoptedServer && linkedHost.isSuccess) {
    return <Navigate to="/servers/$id" params={{id:String(adoptedServer.id)}} hash={vmTabs.value === "tasks" ? "tab=history" : vmTabs.value === "configuration" ? "tab=configuration" : vmTabs.value === "overview" ? "tab=overview" : `tab=vm&vmTab=${vmTabs.value}`} replace />;
  }
  const vmMissing = !cluster || !vm;
  if (vmMissing && (inventory.isLoading || summaryInventory.isLoading))
    return (
      <div className="space-y-5">
        <div className="h-8 w-72 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />
      </div>
    );
  if (vmMissing && inventory.isError && summaryInventory.isError)
    return (
      <QueryErrorState
        error={inventory.error || summaryInventory.error}
        title="Virtual machine inventory could not be loaded"
        onRetry={() => void Promise.all([inventory.refetch(), summaryInventory.refetch()])}
      />
    );
  if (!cluster || !vm)
    return (
      <EmptyState
        icon={<Database className="h-5 w-5" />}
        title="Proxmox virtual machine not found"
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
  const platformName = cluster.connections?.[0]?.name || "Proxmox";
  const platformConsoleUrl = (() => {
    try { const url = new URL(cluster.endpoint); return ['https:', 'http:'].includes(url.protocol) ? url.origin : null; }
    catch { return null; }
  })();

  const kind = vm.guest_type === "lxc" ? "CT" : "VM";
  const isRunning = vm.status === "running";
  const isStopped = vm.status === "stopped";
  return (
    <div className="space-y-5">
      <VmHeader embedded={embedded}
        title={embedded ? "Virtual machine" : vm.name}
        eyebrow={vm.guest_type === "lxc" ? "LXC container" : "Virtual machine"}
        badge={
          <StatusBadge tone={tone(vm.status)} dot>
            {statusLabel(vm.status)}
          </StatusBadge>
        }
        description={`${platformName} · ${vm.node_name} · ${kind}-ID ${vm.vm_id}`}
        breadcrumbs={embedded ? undefined : (
          <>
            <Link
              to="/infrastructure"
              className="hover:text-foreground hover:underline"
            >
              Infrastructure
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
            <span aria-hidden="true">/</span><span>{activeVmSection === "configuration" ? "Configuration" : activeVmSection === "tasks" ? "Jobs" : activeVmSection === "snapshots" ? "Snapshots" : "Overview"}</span>
          </>
        )}
        back={embedded ? undefined : (
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label={`Back to node ${vm.node_name}`}
          >
            <Link
              to="/infrastructure/$clusterId/nodes/$nodeName"
              params={{ clusterId, nodeName: vm.node_name }}
            >
              <ArrowLeft />
            </Link>
          </Button>
        )}
        actions={
          <>
            {canViewAudit && (
              <Button asChild size="sm" variant="outline">
                <Link to="/operations">
                  <ClipboardList />
                  All activity
                </Link>
              </Button>
            )}
            {canControl && isStopped && (
              <Button
                size="sm"
                onClick={() => setPowerAction("start")}
                disabled={Boolean(powerAction)}
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
                disabled={Boolean(powerAction)}
              >
                <RotateCw />
                Restart
              </Button>
            )}
            {canControl && isRunning && (
              <Button size="sm" variant="outline" onClick={() => setPowerAction("shutdown")} disabled={Boolean(powerAction)}>
                <Square />Shut down
              </Button>
            )}
            {canControl && isRunning && (
              <OverflowMenu title="Advanced power actions">
                <OverflowItem icon={Square} danger onClick={() => setPowerAction("stop")} disabled={Boolean(powerAction)}>Force stop</OverflowItem>
              </OverflowMenu>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Refresh inventory"
              onClick={() => void refreshInventory()}
              disabled={inventory.isFetching}
            >
              <RefreshCw
                className={inventory.isFetching ? "animate-spin" : undefined}
              />
            </Button>
          </>
        }
      />
      {inventory.isError && <QueryErrorState
        compact
        error={inventory.error}
        title="Full inventory could not be refreshed; showing previously loaded or summary data"
        onRetry={() => void inventory.refetch()}
      />}
      {!embedded && activeVmSection === "overview" && <VmObjectSummary
        managementState={context.isSuccess ? managementLabel(adoptedServer?.id, Boolean(context.data?.deployments?.length)) : context.isError ? "Management context unavailable" : "Loading management context…"}
        hostName={adoptedServer?.name}
        vm={vm}
        cluster={cluster}
        configuration={configuration.data}
        loading={configuration.isLoading}
      />}
      <Tabs value={section || vmTabs.value} onValueChange={vmTabs.onValueChange} className="space-y-4">
        {!section && <div className="flex items-center justify-between gap-2"><TabsList aria-label={`${kind} sections`} className="console-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configuration">
            <Server className="h-4 w-4" />
            Configuration
          </TabsTrigger>
          <TabsTrigger value="tasks">
              <ClipboardList className="h-4 w-4" />
              Jobs
          </TabsTrigger>
        </TabsList>
        <OverflowMenu title="More VM sections"><OverflowItem onClick={() => vmTabs.onValueChange("snapshots")}>Snapshots</OverflowItem></OverflowMenu></div>}
        <TabsContent value="overview" className="mt-0 space-y-4">
          {embedded && <VmObjectSummary managementState="Managed host" vm={vm} cluster={cluster} configuration={configuration.data} loading={configuration.isLoading} />}
          {!embedded && <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,.55fr)]">
            <Card>
              <CardHeader className="border-b py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ClipboardList className="h-4 w-4" />
                  Management & provisioning
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Connections, declaration, and management for this virtual
                  machine. {context.isSuccess && managementLabel(adoptedServer?.id, Boolean(context.data?.deployments?.length))}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {context.isLoading && !adoptedServer ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Loading connections…
                  </div>
                ) : context.isError ? (
                  <QueryErrorState compact error={context.error} title="VM management context could not be loaded" onRetry={() => void context.refetch()} />
                ) : (
                  <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                    <section className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Host operations
                      </div>
                      <div className="mt-2 text-sm font-medium">
                        {adoptedServer
                          ? adoptedServer.name
                          : "Not adopted as a host"}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {adoptedServer
                          ? "SSH, updates, and playbooks are available through Shipyard."
                          : `The ${kind} remains in platform inventory until it is explicitly adopted.`}
                      </p>
                      {adoptedServer && !embedded && (
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
                            Open host
                          </Link>
                        </Button>
                      )}
                    </section>
                    <section className="p-4">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        VM definition
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
                                  <p className="text-xs text-muted-foreground">Defined VM: {deployment.vm_name}</p>
                                  <div className="text-xs text-muted-foreground">
                                    {deployment.last_run
                                      ? `${deployment.last_run.action} · ${deployment.last_run.status}`
                                      : "No runs yet"}
                                  </div>
                                </div>
                                <Button asChild size="sm" variant="outline">
                                  <Link
                                    to="/deployments/$id"
                                    params={{ id: deployment.definition_id || deployment.workspace_id }}
                                    aria-label={`Open VM definition ${deployment.vm_name} in ${deployment.workspace_name}`}
                                  >
                                    Open definition
                                  </Link>
                                </Button>
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {vm.guest_type === "lxc" ? "LXC containers are inventory-managed and are not OpenTofu VM deployments." : "No OpenTofu deployment defines this VM."}
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
              loading={snapshots.isLoading}
              error={snapshots.error}
              onRetry={() => void snapshots.refetch()}
              canManage={canManageSnapshots}
              onCreate={() => setSnapshotOpen(true)}
            />
          </div>}
          {canViewAudit && (
            <RecentVmTasks
              events={vmEvents}
              loading={audit.isLoading}
              error={audit.error}
              onRetry={() => void audit.refetch()}
            />
          )}
        </TabsContent>
        <TabsContent value="configuration" className="mt-0 space-y-4">
          {(canAccessDeployments(profile) ? context.data?.deployments || [] : []).filter(deployment => deployment.definition_id).map(deployment => <DeploymentDefinition key={deployment.definition_id} id={deployment.definition_id!} embedded />)}
          {context.isError && <QueryErrorState error={context.error} title="VM definition context could not be loaded" onRetry={() => void context.refetch()} />}
          {!(canAccessDeployments(profile) && context.data?.deployments?.some(deployment => deployment.definition_id)) && <VmConfigurationOverview
            configuration={configuration.data}
            guestType={vm.guest_type}
            loading={configuration.isLoading}
            error={configuration.error}
            onRetry={() => void configuration.refetch()}
            unavailable={!apiRoot}
          />}
        </TabsContent>
        <TabsContent value="snapshots" className="mt-0">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Camera className="h-4 w-4" />
                  Snapshots
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Create recovery points or restore a selected snapshot. Restoration discards subsequent guest changes and may interrupt services.
                  {platformConsoleUrl && <a href={platformConsoleUrl} target="_blank" rel="noopener noreferrer" className="ml-1 underline">Open Proxmox console</a>}
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
              ) : snapshots.isError ? (
                <QueryErrorState compact error={snapshots.error} title="Snapshots could not be loaded" onRetry={() => void snapshots.refetch()} />
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
                      {canControl && <Button size="sm" variant="outline" onClick={()=>setRestoreSnapshot(snapshot)}>Restore</Button>}
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
          <TabsContent value="tasks" className="mt-0 space-y-4">
            {(canAccessDeployments(profile) ? context.data?.deployments || [] : []).filter(deployment => deployment.definition_id).map(deployment => <DeploymentDefinition key={deployment.definition_id} id={deployment.definition_id!} embedded section="jobs" />)}
            {apiRoot && hasCap(profile,"canViewServers") ? <GuestTaskHistory apiRoot={apiRoot} environmentId={environmentId} /> : <Card><CardContent className="p-4 text-sm text-muted-foreground">{apiRoot ? "Viewing guest requests requires permission to view servers." : "Connect this guest to a Proxmox platform to track its requests."}</CardContent></Card>}
            {canViewAudit && (
            <Card>
              <CardHeader className="border-b py-3">
                <CardTitle className="text-base">Audit activity</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Actions recorded with this guest’s stable identity. Older entries remain in Operations → Audit. An audit entry confirms a request was recorded; check Guest requests above for its Proxmox outcome.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {audit.isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    Loading audit activity…
                  </div>
                ) : audit.isError ? (
                  <QueryErrorState compact error={audit.error} title="Guest audit activity could not be loaded" onRetry={() => void audit.refetch()} />
                ) : (
                  <><VmTaskRows events={vmEvents} /><div className="flex items-center justify-between gap-2 border-t p-3 text-sm"><Button variant="outline" size="sm" disabled={auditOffset===0} onClick={()=>setAuditOffset(Math.max(0,auditOffset-20))}>Previous audit events</Button><span>{audit.data?.total || 0} events</span><Button variant="outline" size="sm" disabled={auditOffset+20 >= (audit.data?.total || 0)} onClick={()=>setAuditOffset(auditOffset+20)}>Next audit events</Button></div></>
                )}
              </CardContent>
            </Card>
            )}
          </TabsContent>
      </Tabs>
      <CreateSnapshotDialog open={snapshotOpen} onOpenChange={setSnapshotOpen} apiRoot={apiRoot} environmentId={environmentId} guestName={vm.name} guestType={vm.guest_type} onAccepted={invalidate} />
      <GuestPowerDialog action={powerAction} apiRoot={apiRoot} environmentId={environmentId} guestName={vm.name} onClose={()=>setPowerAction(null)} onAccepted={invalidate} />
      <RestoreSnapshotDialog snapshotName={restoreSnapshot?.name ?? null} snapshotTime={restoreSnapshot?.snaptime ?? null} apiRoot={apiRoot} environmentId={environmentId} guestName={vm.name} onClose={()=>setRestoreSnapshot(null)} onAccepted={invalidate} />
      <DeleteSnapshotDialog snapshotName={deleteSnapshot?.name ?? null} apiRoot={apiRoot} environmentId={environmentId} guestName={vm.name} onClose={()=>setDeleteSnapshot(null)} onAccepted={invalidate} />
    </div>
  );
}
