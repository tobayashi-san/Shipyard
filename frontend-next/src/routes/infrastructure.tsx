import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api, apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { OverflowItem, OverflowMenu, OverflowSep } from "@/components/ui/overflow-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { cn, formatDateTime } from "@/lib/utils";
import {
  ProxmoxConnectionDialog,
  type ProxmoxConnection,
} from "@/features/infrastructure/ProxmoxConnectionDialog";

interface DatastoreInfo {
  id: string;
  node_name: string;
  type: string;
  used: number;
  total: number;
  available: number;
}
interface NodeInfo {
  name: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
}
interface VmInfo {
  name: string;
  node_name: string;
  vm_id: number;
  guest_type?: "qemu" | "lxc";
  status: string;
  mem: number;
  maxmem: number;
  fleet_server_id?: string | null;
}
interface Cluster {
  id: string;
  endpoint: string;
  status: string;
  connections?: Array<{ id: string; name: string }>;
  nodes: NodeInfo[];
  vms: VmInfo[];
  datastores?: DatastoreInfo[];
}
interface InfrastructureResponse {
  clusters?: Cluster[];
  warnings?: string[];
}
interface FleetHost {
  id: string;
  name: string;
  ip_address?: string;
  status?: string;
  environment_id?: string;
}
interface FleetHostInfo {
  cpu_usage_pct?: number;
  ram_total_mb?: number;
  ram_used_mb?: number;
  disk_total_gb?: number;
  disk_used_gb?: number;
  uptime_seconds?: number;
}

function tone(status: string): StatusTone {
  if (status === "online" || status === "running") return "success";
  // A stopped VM is frequently intentional. Reserve red for an unreachable
  // platform/node; an operator should not read a normal lifecycle state as
  // an incident in the inventory tree or table.
  if (status === "offline") return "danger";
  return "muted";
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

function percent(value: number, maximum: number) {
  if (!maximum) return "—";
  return `${Math.round((value / maximum) * 100)} %`;
}

function uptime(seconds: number) {
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86400);
  if (days) return `${days} d`;
  return `${Math.floor(seconds / 3600)} h`;
}

// Proxmox does not guarantee an order for storage records.  Choosing the
// first response made a directory/ISO store occasionally appear as the
// platform's primary datastore.  Prefer actual ZFS pools and use capacity as
// a stable, operator-readable tie breaker.
function preferredDatastores(stores: DatastoreInfo[] = []) {
  const usable = stores.filter(
    (store) => Number.isFinite(store.total) && store.total > 0,
  );
  const zfs = usable.filter((store) => /zfs/i.test(String(store.type || "")));
  return (zfs.length ? zfs : usable)
    .slice()
    .sort((left, right) => (right.total || 0) - (left.total || 0));
}

export function InfrastructurePage() {
  const routeSearch = useSearch({ from: "/_protected/infrastructure" });
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionToEdit, setConnectionToEdit] =
    useState<ProxmoxConnection | null>(null);
  const [connectionToDelete, setConnectionToDelete] =
    useState<ProxmoxConnection | null>(null);
  const isAdmin = hasCap(profile, "canManageDeploymentPlatforms");
  const canSyncIpam = hasCap(profile, "canEditServers");
  const inventoryQuery = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId],
    queryFn: () =>
      apiFetch<InfrastructureResponse>(
        `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    staleTime: 15_000,
  });
  const connectionsQuery = useQuery({
    queryKey: ["opentofu", "proxmox-connections", environmentId],
    queryFn: () =>
      apiFetch<ProxmoxConnection[]>(
        `/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    staleTime: 15_000,
  });
  const connections = Array.isArray(connectionsQuery.data)
    ? connectionsQuery.data
    : [];
  const clusters = Array.isArray(inventoryQuery.data?.clusters)
    ? inventoryQuery.data!.clusters!
    : [];
  const hostsQuery = useQuery({
    queryKey: ["servers", environmentId],
    queryFn: () => api.getServers(environmentId) as unknown as Promise<FleetHost[]>,
    staleTime: 30_000,
  });
  const hosts = useMemo(
    () =>
      (Array.isArray(hostsQuery.data) ? hostsQuery.data : []).filter(
        (host) => String(host.environment_id || "default") === environmentId,
      ),
    [environmentId, hostsQuery.data],
  );
  // An adopted VM already belongs to the Proxmox inventory below. Rendering it
  // again as a host makes the console look as if it contained two
  // resources. Keep this section exclusively for standalone VPS/bare-metal
  // hosts, just as vCenter separates inventory objects from external hosts.
  const adoptedFleetHostIds = useMemo(
    () =>
      new Set(
        clusters
          .flatMap((cluster) => cluster.vms.map((vm) => vm.fleet_server_id))
          .filter((id): id is string => Boolean(id)),
      ),
    [clusters],
  );
  const standaloneHosts = useMemo(
    () => hosts.filter((host) => !adoptedFleetHostIds.has(host.id)),
    [adoptedFleetHostIds, hosts],
  );
  const totals = useMemo(
    () =>
      clusters.reduce(
        (result, cluster) => ({
          clusters: result.clusters + 1,
          nodes: result.nodes + cluster.nodes.length,
          vms: result.vms + cluster.vms.length,
          online:
            result.online +
            cluster.vms.filter((vm) => vm.status === "running").length,
          onlineNodes:
            result.onlineNodes +
            cluster.nodes.filter((node) => node.status === "online").length,
        }),
        { clusters: 0, nodes: 0, vms: 0, online: 0, onlineNodes: 0 },
      ),
    [clusters],
  );
  const refreshing =
    inventoryQuery.isFetching ||
    hostsQuery.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "infrastructure", environmentId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "proxmox-connections", environmentId],
    });
    void queryClient.invalidateQueries({ queryKey: ["servers"] });
  };
  useEffect(() => {
    if (!routeSearch.section || inventoryQuery.isLoading) return;
    const target = document.getElementById(`infrastructure-${routeSearch.section}`);
    window.requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [clusters.length, inventoryQuery.isLoading, routeSearch.section]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Infrastructure"
        description={
          clusters.length
            ? `${totals.clusters} platform${totals.clusters === 1 ? "" : "s"} · ${totals.onlineNodes} / ${totals.nodes} nodes reachable · ${totals.online} / ${totals.vms} virtual machines running${standaloneHosts.length ? ` · ${standaloneHosts.length} external hosts` : ""}`
            : "Read-only platform inventory for connected clusters, nodes, datastores, VMs, and LXC containers."
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
            {isAdmin && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setConnectionsOpen(true)}
              >
                <Settings2 />
                Platform connections
              </Button>
            )}
          </>
        }
      />

      {inventoryQuery.isLoading || hostsQuery.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          {inventoryQuery.data?.warnings?.length ? (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" />
                Not all Proxmox connections are reachable
              </div>
              <ul className="mt-1 list-disc pl-6 text-xs">
                {inventoryQuery.data.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {inventoryQuery.isError && (
            <Card>
              <QueryErrorState
                error={inventoryQuery.error}
                title="Infrastructure could not be loaded"
                onRetry={() => void inventoryQuery.refetch()}
              />
            </Card>
          )}
          {hostsQuery.isError && (
            <Card>
              <QueryErrorState
                error={hostsQuery.error}
                title="Managed hosts could not be loaded"
                onRetry={() => void hostsQuery.refetch()}
              />
            </Card>
          )}
          {inventoryQuery.isSuccess && hostsQuery.isSuccess && clusters.length === 0 && hosts.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Database className="h-5 w-5" />}
                title="No infrastructure connected yet"
                description="Add a host or create a Proxmox connection in this environment."
                action={
                  isAdmin ? (
                    <Button
                      type="button"
                      onClick={() => {
                        setConnectionToEdit(null);
                        setConnectionDialogOpen(true);
                      }}
                    >
                      <Plus />
                      Connect Proxmox
                    </Button>
                  ) : (
                    <Button asChild>
                      <Link to="/servers">Add host</Link>
                    </Button>
                  )
                }
              />
            </Card>
          ) : null}
          {clusters.length > 0 && <PlatformInventory clusters={clusters} />}
          {standaloneHosts.length > 0 && <ManagedHostsReference count={standaloneHosts.length} />}
        </>
      )}
      <Dialog open={connectionsOpen} onOpenChange={setConnectionsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto p-0">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Platform connections</DialogTitle>
            <DialogDescription>
              These connections provide the current environment inventory.
              Deployments can then select them as their infrastructure source.
            </DialogDescription>
          </DialogHeader>
          <div className="p-4">
            {connectionsQuery.isError ? (
              <QueryErrorState
                compact
                error={connectionsQuery.error}
                title="Platform connections could not be loaded"
                onRetry={() => void connectionsQuery.refetch()}
              />
            ) : <ProxmoxConnectionsCard
              connections={connections}
              isAdmin={isAdmin}
              canSyncIpam={canSyncIpam}
              onAdd={() => {
                setConnectionToEdit(null);
                setConnectionDialogOpen(true);
              }}
              onEdit={(connection) => {
                setConnectionToEdit(connection);
                setConnectionDialogOpen(true);
              }}
              onDelete={setConnectionToDelete}
            />}
          </div>
        </DialogContent>
      </Dialog>
      <ProxmoxConnectionDialog
        environmentId={environmentId}
        connection={connectionToEdit}
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
      />
      <ConfirmDeleteConnection
        connection={connectionToDelete}
        onOpenChange={(open) => !open && setConnectionToDelete(null)}
        onDeleted={() => {
          setConnectionToDelete(null);
          refresh();
        }}
      />
    </div>
  );
}

export function ProxmoxConnectionsCard({
  connections,
  isAdmin,
  canSyncIpam,
  onAdd,
  onEdit,
  onDelete,
}: {
  connections: ProxmoxConnection[];
  isAdmin: boolean;
  canSyncIpam: boolean;
  onAdd: () => void;
  onEdit: (connection: ProxmoxConnection) => void;
  onDelete: (connection: ProxmoxConnection) => void;
}) {
  const queryClient = useQueryClient();
  const syncIpam = useMutation({
    mutationFn: (connection: ProxmoxConnection) =>
      apiFetch<{
        prefixes: number;
        discovered: number;
        created: number;
        updated: number;
        conflicts: number;
      }>(
        `/opentofu/proxmox-connections/${encodeURIComponent(connection.id)}/sync-ipam`,
        { method: "POST", body: {} },
      ),
    onSuccess: (result, connection) => {
      showToast(
        `${connection.name}: ${result.prefixes} network${result.prefixes === 1 ? "" : "s"} synchronized, ${result.created} added, ${result.updated} updated, ${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"}.`,
        result.conflicts ? "warning" : "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
      void queryClient.invalidateQueries({
        queryKey: [
          "opentofu",
          "proxmox-connections",
          connection.environment_id,
        ],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const syncLabel = (connection: ProxmoxConnection) =>
    connection.auto_sync_ipam
      ? `Automatic · every ${connection.sync_interval_min} min`
      : "Manual only";
  const lastSyncLabel = (connection: ProxmoxConnection) => {
    if (!connection.last_ipam_synced_at) return "Not synchronized yet";
    const value = new Date(connection.last_ipam_synced_at);
    return Number.isNaN(value.getTime())
      ? "Last synchronization unknown"
      : `Last ${formatDateTime(value)}`;
  };
  const inventoryId = (connection: ProxmoxConnection) => {
    try {
      const endpoint = new URL(connection.endpoint);
      return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
    } catch {
      return connection.endpoint.replace(/\/+$/, "");
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b bg-muted/15 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Proxmox platforms
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Inventory sources for this environment. A connection can be assigned
            to multiple deployments.
          </p>
        </div>
        {isAdmin && (
          <Button type="button" size="sm" onClick={onAdd}>
            <Plus />
            Connect Proxmox
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {connections.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            No Proxmox platform connected yet.
          </div>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {connections.map((connection) => (
                <div key={connection.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        className="flex items-center gap-2 font-medium hover:text-primary hover:underline"
                        to="/infrastructure/$clusterId"
                        params={{ clusterId: inventoryId(connection) }}
                      >
                        <Database className="h-4 w-4 text-brand" />
                        {connection.name}
                      </Link>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {connection.endpoint}
                      </div>
                    </div>
                    <StatusBadge
                      tone={
                        connection.api_token_configured ? "success" : "danger"
                      }
                      dot
                    >
                      {connection.api_token_configured
                        ? "Ready"
                        : "Token missing"}
                    </StatusBadge>
                  </div>
                  <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>IPAM schedule</span>
                    <span className="text-right">{syncLabel(connection)}</span>
                    <span>Last sync</span>
                    <span
                      className={cn("text-right", connection.last_ipam_status === "failed" && "text-destructive")}
                      title={connection.last_ipam_error || undefined}
                    >
                      {connection.last_ipam_status === "failed"
                        ? "Synchronization failed"
                        : lastSyncLabel(connection)}
                    </span>
                  </div>
                  {(isAdmin || canSyncIpam) && (
                    <div className="flex justify-end gap-1">
                      {canSyncIpam && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={syncIpam.isPending}
                          onClick={() => syncIpam.mutate(connection)}
                        >
                          <RefreshCw
                            className={
                              syncIpam.isPending &&
                              syncIpam.variables?.id === connection.id
                                ? "animate-spin"
                                : ""
                            }
                          />
                          Sync now
                        </Button>
                      )}
                      {isAdmin && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onEdit(connection)}
                          >
                            <Pencil />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onDelete(connection)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Remove
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                data-density="compact"
                className="w-full min-w-[840px] text-sm"
              >
                <thead>
                  <tr>
                    <th className="px-3">Platform</th>
                    <th className="px-3">Endpoint</th>
                    <th className="px-3">Access status</th>
                    <th className="w-48 px-3">IPAM schedule</th>
                    <th className="w-56 px-3">Last sync</th>
                    <th className="w-32 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((connection) => (
                    <tr key={connection.id}>
                      <td className="px-3">
                        <Link
                          className="flex items-center gap-2 font-medium hover:text-primary hover:underline"
                          to="/infrastructure/$clusterId"
                          params={{ clusterId: inventoryId(connection) }}
                        >
                          <Database className="h-4 w-4 text-brand" />
                          {connection.name}
                        </Link>
                      </td>
                      <td className="px-3 font-mono text-xs text-muted-foreground">
                        {connection.endpoint}
                      </td>
                      <td className="px-3">
                        <StatusBadge
                          tone={
                            connection.api_token_configured
                              ? "success"
                              : "danger"
                          }
                          dot
                        >
                          {connection.api_token_configured
                            ? "Access configured"
                            : "Token missing"}
                        </StatusBadge>
                      </td>
                      <td className="px-3 text-xs text-muted-foreground">
                        {syncLabel(connection)}
                      </td>
                      <td
                        className={cn(
                          "px-3 text-xs text-muted-foreground",
                          connection.last_ipam_status === "failed" && "text-destructive",
                        )}
                        title={connection.last_ipam_error || undefined}
                      >
                        {connection.last_ipam_status === "failed"
                          ? "Last synchronization failed"
                          : lastSyncLabel(connection)}
                      </td>
                      <td className="px-3 text-right">
                        {isAdmin || canSyncIpam ? (
                          <div className="flex justify-end">
                            <OverflowMenu title={`Actions for ${connection.name}`}>
                            {canSyncIpam && (
                              <OverflowItem
                                icon={RefreshCw}
                                disabled={syncIpam.isPending}
                                onClick={() => syncIpam.mutate(connection)}
                              >
                                Sync with IPAM
                              </OverflowItem>
                            )}
                            {canSyncIpam && isAdmin && <OverflowSep />}
                            {isAdmin && (
                              <OverflowItem
                                icon={Pencil}
                                onClick={() => onEdit(connection)}
                              >
                                Edit connection
                              </OverflowItem>
                            )}
                            {isAdmin && (
                              <OverflowItem
                                icon={Trash2}
                                danger
                                onClick={() => onDelete(connection)}
                              >
                                Remove connection
                              </OverflowItem>
                            )}
                            </OverflowMenu>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ConfirmDeleteConnection({
  connection,
  onOpenChange,
  onDeleted,
}: {
  connection: ProxmoxConnection | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const deletion = useMutation({
    mutationFn: () =>
      apiFetch(
        `/opentofu/proxmox-connections/${encodeURIComponent(connection?.id || "")}`,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      if (!connection) return;
      showToast("Platform connection removed.", "success");
      await queryClient.invalidateQueries({
        queryKey: [
          "opentofu",
          "proxmox-connections",
          connection.environment_id,
        ],
      });
      await queryClient.invalidateQueries({
        queryKey: ["opentofu", "infrastructure", connection.environment_id],
      });
      onDeleted();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  return (
    <ConfirmDialog
      open={Boolean(connection)}
      onOpenChange={onOpenChange}
      title="Remove platform connection?"
      description={
        connection ? (
          <>
            The connection <strong>{connection.name}</strong> will be removed.
            If deployments still use it, Shipyard protects the connection and
            requires reassignment first.
          </>
        ) : (
          ""
        )
      }
      confirmLabel="Remove connection"
      cancelLabel="Cancel"
      variant="destructive"
      onConfirm={() => deletion.mutate()}
      isPending={deletion.isPending}
    />
  );
}

function ManagedHostsReference({ count }: { count: number }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <Server className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{count} external host{count === 1 ? "" : "s"}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">Host health, updates, access, and bulk administration live in Hosts.</p>
        </div>
        <Button asChild size="sm" variant="outline"><Link to="/servers">Open hosts</Link></Button>
      </CardContent>
    </Card>
  );
}

function FleetHostsCard({
  hosts,
  infos,
}: {
  hosts: FleetHost[];
  infos: Array<FleetHostInfo | undefined>;
}) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Hosts
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Individual VPS instances, bare-metal servers, and hosts managed by
            agent or SSH.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/servers">All hosts</Link>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {hosts.map((host, index) => {
            const info = infos[index];
            return (
              <Link
                key={host.id}
                to="/servers/$id"
                params={{ id: host.id }}
                className="block p-3.5 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{host.name}</div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {host.ip_address || "—"}
                    </div>
                  </div>
                  <StatusBadge tone={tone(host.status || "unknown")} dot>
                    {host.status || "unknown"}
                  </StatusBadge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <InventoryValue
                    label="CPU"
                    value={
                      Number.isFinite(info?.cpu_usage_pct)
                        ? `${Math.round(Number(info?.cpu_usage_pct))} %`
                        : "—"
                    }
                  />
                  <InventoryValue
                    label="RAM"
                    value={
                      info?.ram_total_mb
                        ? percent(
                            Number(info.ram_used_mb || 0),
                            Number(info.ram_total_mb),
                          )
                        : "—"
                    }
                  />
                  <InventoryValue
                    label="Disk"
                    value={
                      info?.disk_total_gb
                        ? percent(
                            Number(info.disk_used_gb || 0),
                            Number(info.disk_total_gb),
                          )
                        : "—"
                    }
                  />
                </div>
              </Link>
            );
          })}
        </div>
        <div className="table-scroll hidden md:block">
          <table
            data-density="compact"
            className="w-full min-w-[900px] text-sm"
          >
            <thead>
              <tr>
                <th>Host</th>
                <th>Status</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Disk</th>
                <th>Uptime</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host, index) => {
                const info = infos[index];
                const cpu = Number(info?.cpu_usage_pct);
                const cpuKnown = Number.isFinite(cpu);
                const ramUsed = Number(info?.ram_used_mb || 0);
                const ramTotal = Number(info?.ram_total_mb || 0);
                const diskUsed = Number(info?.disk_used_gb || 0);
                const diskTotal = Number(info?.disk_total_gb || 0);
                return (
                  <tr key={host.id}>
                    <td>
                      <Link
                        to="/servers/$id"
                        params={{ id: host.id }}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {host.name}
                      </Link>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {host.ip_address || "—"}
                      </div>
                    </td>
                    <td>
                      <StatusBadge tone={tone(host.status || "unknown")} dot>
                        {host.status || "unknown"}
                      </StatusBadge>
                    </td>
                    <td>
                      {cpuKnown ? (
                        <CapacityValue
                          used={cpu}
                          total={100}
                          format={(value) => `${Math.round(value)} %`}
                        />
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </td>
                    <td>
                      {ramTotal ? (
                        <CapacityValue
                          used={ramUsed}
                          total={ramTotal}
                          format={(value) => `${Math.round(value)} MB`}
                        />
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </td>
                    <td>
                      {diskTotal ? (
                        <CapacityValue
                          used={diskUsed}
                          total={diskTotal}
                          format={(value) => `${value.toFixed(1)} GB`}
                        />
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {uptime(Number(info?.uptime_seconds || 0))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function InventoryValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

// Capacity bars belong in the platform header. Inventory rows use a dense
// textual value so a long list remains scannable instead of becoming a stack
// of tiny dashboards.
function CapacityValue({
  used,
  total,
  detail,
  format = bytes,
}: {
  used: number;
  total: number;
  detail?: string;
  format?: (value: number) => string;
}) {
  if (!Number.isFinite(total) || total <= 0)
    return <span className="font-mono text-xs text-muted-foreground">—</span>;
  const value = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return (
    <div className="min-w-[9rem]">
      <div className="whitespace-nowrap font-mono text-xs tabular-nums">
        {format(used)} / {format(total)}{" "}
        <span className="text-muted-foreground">· {value} %</span>
      </div>
      {detail && (
        <div
          className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
          title={detail}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

function PlatformInventory({ clusters }: { clusters: Cluster[] }) {
  const [selectedId, setSelectedId] = useState(clusters[0]?.id || "");
  const selected = clusters.find((cluster) => cluster.id === selectedId) || clusters[0];
  useEffect(() => {
    if (!clusters.some((cluster) => cluster.id === selectedId)) {
      setSelectedId(clusters[0]?.id || "");
    }
  }, [clusters, selectedId]);

  return (
    <section id="infrastructure-platforms" className="console-panel scroll-mt-16 overflow-hidden" aria-labelledby="platform-inventory-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 id="platform-inventory-heading" className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4" />
            Platforms
          </h2>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {clusters.length}{" "}
          {clusters.length === 1 ? "Platform" : "Platforms"}
        </span>
      </div>
      <div className="divide-y lg:hidden">
          {clusters.map((cluster) => {
            const metrics = platformMetrics(cluster);
            return (
              <Link
                key={cluster.id}
                to="/infrastructure/$clusterId"
                params={{ clusterId: cluster.id }}
                className="block p-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      {metrics.name}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {cluster.endpoint.replace(/^https?:\/\//, "")}
                    </div>
                  </div>
                  <StatusBadge tone={tone(cluster.status)} dot>
                    {cluster.status === "online" ? "Connected" : "Offline"}
                  </StatusBadge>
                </div>
                <div className="mt-2 text-[13px] text-muted-foreground">{metrics.onlineNodes} / {cluster.nodes.length} nodes reachable · {metrics.running} / {cluster.vms.length} virtual machines running</div>
              </Link>
            );
          })}
      </div>
      <div className="hidden min-h-[24rem] lg:grid lg:grid-cols-[minmax(15rem,.7fr)_minmax(0,1.3fr)]">
        <div className="border-r bg-muted/10 p-2" aria-label="Platform list">
          {clusters.map((cluster) => {
            const metrics = platformMetrics(cluster);
            const active = cluster.id === selected?.id;
            return (
              <button
                key={cluster.id}
                type="button"
                onClick={() => setSelectedId(cluster.id)}
                className={`flex w-full min-w-0 items-start gap-3 rounded-sm px-3 py-2.5 text-left transition-colors ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
                aria-pressed={active}
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${cluster.status === "online" ? "bg-success" : "bg-destructive"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{metrics.name}</span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{cluster.endpoint.replace(/^https?:\/\//, "")}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{metrics.onlineNodes}/{cluster.nodes.length} nodes · {metrics.running}/{cluster.vms.length} virtual machines</span>
                </span>
              </button>
            );
          })}
        </div>
        {selected && <PlatformPreview cluster={selected} />}
      </div>
    </section>
  );
}

function PlatformPreview({ cluster }: { cluster: Cluster }) {
  const metrics = platformMetrics(cluster);
  const store = metrics.datastores[0];
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">
              <Link className="hover:text-primary hover:underline" to="/infrastructure/$clusterId" params={{ clusterId: cluster.id }}>{metrics.name}</Link>
            </h3>
            <StatusBadge tone={tone(cluster.status)} dot>{cluster.status === "online" ? "Connected" : "Offline"}</StatusBadge>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{cluster.endpoint.replace(/^https?:\/\//, "")}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 border-b xl:grid-cols-4">
        <PreviewFact label="Nodes" value={`${metrics.onlineNodes} / ${cluster.nodes.length}`} />
        <PreviewFact label="Virtual machines" value={`${metrics.running} / ${cluster.vms.length}`} />
        <PreviewFact label="CPU" value={metrics.cpuTotal ? `${Math.round((metrics.cpuUsed / metrics.cpuTotal) * 100)} %` : "—"} />
        <PreviewFact label="Memory" value={metrics.memTotal ? `${Math.round((metrics.memUsed / metrics.memTotal) * 100)} %` : "—"} />
      </div>
      <div className="grid gap-5 p-5 xl:grid-cols-2">
        <div>
          <h4 className="text-[13px] font-semibold">Capacity</h4>
          <div className="mt-3 space-y-3">
            <CapacityValue used={metrics.cpuUsed} total={metrics.cpuTotal} format={(value) => `${value.toFixed(value < 10 ? 1 : 0)} Cores`} />
            <CapacityValue used={metrics.memUsed} total={metrics.memTotal} />
            {store && <CapacityValue used={store.used} total={store.total} detail={store.id} />}
          </div>
        </div>
        <div id="infrastructure-nodes" className="scroll-mt-16">
          <h4 className="text-[13px] font-semibold">Nodes</h4>
          <div className="mt-2 divide-y border-y">
            {cluster.nodes.map((node) => (
              <div key={node.name} className="flex items-center gap-2 py-2 text-[13px]">
                <span className={`h-1.5 w-1.5 rounded-full ${node.status === "online" ? "bg-success" : "bg-destructive"}`} />
                <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
                <span className="text-muted-foreground">{percent(node.mem, node.maxmem)} RAM</span>
              </div>
            ))}
          </div>
        </div>
        <div id="infrastructure-guests" className="scroll-mt-16">
          <h4 className="text-[13px] font-semibold">Virtual machines / containers</h4>
          <div className="mt-2 divide-y border-y">
            {cluster.vms.slice(0, 8).map((vm) => (
              <Link
                key={`${vm.node_name}:${vm.vm_id}`}
                to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                params={{ clusterId: cluster.id, nodeName: vm.node_name, vmId: String(vm.vm_id) }}
                className="flex items-center gap-2 py-2 text-[13px] hover:text-primary"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${vm.status === "running" ? "bg-success" : "bg-muted-foreground/50"}`} />
                <span className="min-w-0 flex-1 truncate">{vm.name || `${vm.guest_type === "lxc" ? "CT" : "VM"} ${vm.vm_id}`}</span>
                <span className="font-mono text-xs text-muted-foreground">{vm.node_name}</span>
              </Link>
            ))}
            {cluster.vms.length === 0 && <p className="py-3 text-xs text-muted-foreground">No virtual machines or containers.</p>}
          </div>
        </div>
        <div id="infrastructure-datastores" className="scroll-mt-16">
          <h4 className="text-[13px] font-semibold">Datastores</h4>
          <div className="mt-2 divide-y border-y">
            {metrics.datastores.map((datastore) => (
              <div key={`${datastore.node_name}:${datastore.id}`} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono">{datastore.id}</span>
                <span className="text-xs text-muted-foreground">{bytes(datastore.used)} / {bytes(datastore.total)}</span>
              </div>
            ))}
            {metrics.datastores.length === 0 && <p className="py-3 text-xs text-muted-foreground">No datastore capacity reported.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewFact({ label, value }: { label: string; value: string }) {
  return <div className="border-r border-t px-4 py-3 first:border-t-0 lg:first:border-t"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-lg font-semibold">{value}</div></div>;
}

function platformMetrics(cluster: Cluster) {
  const nodes = Array.isArray(cluster.nodes) ? cluster.nodes : [];
  const datastores = preferredDatastores(
    Array.isArray(cluster.datastores) ? cluster.datastores : [],
  );
  return {
    // A platform card represents one inventory root. Multiple configured
    // aliases must not read like multiple clusters in the console.
    name:
      cluster.connections?.find((connection) => connection.name)?.name ||
      cluster.endpoint.replace(/^https?:\/\//, "") ||
      "Proxmox platform",
    onlineNodes: nodes.filter((node) => node.status === "online").length,
    running: cluster.vms.filter((vm) => vm.status === "running").length,
    cpuUsed: nodes.reduce(
      (sum, node) => sum + (node.cpu || 0) * (node.maxcpu || 0),
      0,
    ),
    cpuTotal: nodes.reduce((sum, node) => sum + (node.maxcpu || 0), 0),
    memUsed: nodes.reduce((sum, node) => sum + (node.mem || 0), 0),
    memTotal: nodes.reduce((sum, node) => sum + (node.maxmem || 0), 0),
    datastores,
  };
}
