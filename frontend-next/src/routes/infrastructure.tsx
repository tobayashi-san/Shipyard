import { CreateServerDialog } from '@/components/CreateServerDialog';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { OverflowItem, OverflowLink, OverflowMenu, OverflowSep } from "@/components/ui/overflow-menu";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Timestamp } from '@/components/ui/timestamp';
import { VmFormDialog } from '@/features/deployments/VmFormDialog';
import { ConfirmDeleteConnection } from '@/features/infrastructure/ConfirmDeleteConnection';
import { statusLabel } from '@/features/infrastructure/detail-model';
import { PlatformConnectionsDialog } from '@/features/infrastructure/PlatformConnectionsDialog';
import {
  ProxmoxConnectionDialog,
  type ProxmoxConnection,
} from "@/features/infrastructure/ProxmoxConnectionDialog";
import { api, apiFetch } from "@/lib/api";
import { platformInventoryId } from '@/lib/platform-inventory-id';
import { canAccessDeployments, canAccessInfrastructure, hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { cn, parseApiDate } from "@/lib/utils";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
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
import { useEffect, useMemo, useState } from "react";

interface DatastoreInfo {
  active?: boolean | null;
  enabled?: boolean | null;
  capacity_reported?: boolean;
  id: string;
  node_name: string;
  type: string;
  used: number;
  total: number;
  available: number;
}
interface NodeInfo {
  fleet_server_id?: string | null;
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
  collected_at?: string | null;
  stale?: boolean;
  id: string;
  endpoint: string;
  status: string;
  connections?: Array<{ id: string; name: string }>;
  nodes: NodeInfo[];
  vms: VmInfo[];
  datastores?: DatastoreInfo[];
}
interface InfrastructureResponse {
  refreshing?: boolean;
  cached?: boolean;
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

export function InfrastructurePage() {
  const routeSearch = useSearch({ from: "/_protected/infrastructure" });
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const [hostOpen, setHostOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<{connectionId: string; node: string} | null>(null);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(routeSearch.section === "platforms");
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
    enabled: canAccessInfrastructure(profile),
    staleTime: 15_000,
    refetchInterval: (query) => query.state.status !== 'error' && query.state.data?.refreshing ? 2_000 : 30_000,
  });
  const connectionsQuery = useQuery({
    queryKey: ["opentofu", "proxmox-connections", environmentId],
    queryFn: () =>
      apiFetch<ProxmoxConnection[]>(
        `/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    enabled: isAdmin,
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
    enabled: hasCap(profile, "canViewServers"),
    staleTime: 30_000,
  });
  const hosts = useMemo(
    () =>
      (Array.isArray(hostsQuery.data) ? hostsQuery.data : []).filter(
        (host) => String(host.environment_id || "default") === environmentId,
      ),
    [environmentId, hostsQuery.data],
  );
  const definitionsQuery = useQuery({
    queryKey: ['opentofu', 'vms', environmentId],
    queryFn: () => apiFetch<Array<{id: string; name: string; node_name?: string; vm_id?: number | string; platform?: {endpoint: string}}>>(`/opentofu/vms?environment_id=${encodeURIComponent(environmentId)}`),
    enabled: canAccessDeployments(profile),
    staleTime: 15_000,
  });
  const missingDefinitions = (definitionsQuery.data || []).filter(definition => !clusters.some(cluster => cluster.id === platformInventoryId(definition.platform?.endpoint) && cluster.vms.some(vm => vm.node_name === definition.node_name && String(vm.vm_id) === String(definition.vm_id))));
  const unplacedDefinitions = missingDefinitions.filter(definition => !clusters.some(cluster => cluster.id === platformInventoryId(definition.platform?.endpoint) && cluster.nodes.some(node => node.name === definition.node_name)));
  const serverRefreshing = !inventoryQuery.isError && inventoryQuery.data?.refreshing === true;
  const refreshing =
    inventoryQuery.isFetching || serverRefreshing ||
    hostsQuery.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "infrastructure", environmentId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["opentofu", "proxmox-connections", environmentId],
    });
    void queryClient.invalidateQueries({ queryKey: ["servers"] });
    void queryClient.invalidateQueries({ queryKey: ["opentofu", "vms", environmentId] });
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
        actions={
          <>
            {hasCap(profile, "canEditServers") && <Button onClick={() => setHostOpen(true)}><Plus />Add host</Button>}
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
                Manage connections
              </Button>
            )}
            <OverflowMenu title="Infrastructure actions">
              {hasCap(profile, 'canViewServers') && <OverflowLink to="/servers">Host groups and bulk actions</OverflowLink>}
              {canAccessDeployments(profile) && <OverflowLink to="/deployments">VM templates and legacy definitions</OverflowLink>}
            </OverflowMenu>
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
          {serverRefreshing && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />Refreshing platform data; showing the last collected values.</p>}
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
          {(inventoryQuery.isSuccess || !canAccessInfrastructure(profile)) && (hostsQuery.isSuccess || !hasCap(profile, "canViewServers")) && (definitionsQuery.isSuccess || !canAccessDeployments(profile)) && clusters.length === 0 && hosts.length === 0 && missingDefinitions.length === 0 ? (
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
                  ) : hasCap(profile, "canEditServers") ? <Button onClick={() => setHostOpen(true)}>Add host</Button> : undefined
                }
              />
            </Card>
          ) : null}
          {clusters.flatMap(cluster => cluster.nodes.map(node => {
            const guests = cluster.vms.filter(vm => vm.node_name === node.name);
            const drafts = missingDefinitions.filter(definition => definition.node_name === node.name && platformInventoryId(definition.platform?.endpoint) === cluster.id);
            const guestCount = guests.length + drafts.length;
            return <Card key={`${cluster.id}:${node.name}`}>
              <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0">
                <Server className="h-5 w-5 text-muted-foreground" />
                <Link to="/infrastructure/$clusterId/nodes/$nodeName" params={{clusterId: cluster.id, nodeName: node.name}} className="flex-1 font-semibold hover:underline">{node.name}</Link>
                <StatusBadge tone={tone(node.status)} dot>{statusLabel(node.status)}</StatusBadge>
                {hasCap(profile, 'canEditDeployments') && cluster.connections?.[0]?.id && <Button variant="outline" size="sm" onClick={() => setCreateTarget({connectionId: cluster.connections![0].id, node: node.name})}><Plus />Create VM</Button>}
              </CardHeader>
              <CardContent>
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground">{guestCount} {guestCount === 1 ? 'virtual machine' : 'virtual machines'}</summary>
                  <div className="mt-2 divide-y">{guests.map(vm => <Link key={vm.vm_id} to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId" params={{clusterId: cluster.id, nodeName: node.name, vmId: String(vm.vm_id)}} aria-label={vm.name || `VM ${vm.vm_id}`} className="flex items-center gap-3 py-3 pl-5 hover:bg-muted/30">
                    <span className="flex-1 font-medium">{vm.name || `VM ${vm.vm_id}`}</span><StatusBadge tone={tone(vm.status)} dot>{statusLabel(vm.status)}</StatusBadge>
                  </Link>)}{drafts.map(definition => <Link key={definition.id} to="/deployments/$id" params={{id:definition.id}} className="flex items-center gap-3 py-3 pl-5 hover:bg-muted/30"><span className="flex-1 font-medium">{definition.name}</span><StatusBadge tone="muted">Defined</StatusBadge></Link>)}{guestCount === 0 && <p className="py-3 text-sm text-muted-foreground">Create a VM on this host to get started.</p>}</div>
                </details>
              </CardContent>
            </Card>;
          }))}
          {hosts.filter(host => !clusters.some(cluster => cluster.nodes.some(node => node.fleet_server_id === host.id) || cluster.vms.some(vm => vm.fleet_server_id === host.id))).map(host => <Card key={host.id}>
            <CardContent className="flex items-center gap-3 p-5"><Server className="h-5 w-5 text-muted-foreground" /><Link to="/servers/$id" params={{id:host.id}} className="flex-1 font-semibold hover:underline">{host.name}</Link><span className="text-sm text-muted-foreground">{host.ip_address}</span><StatusBadge tone={tone(host.status || 'unknown')} dot>{statusLabel(host.status || 'unknown')}</StatusBadge></CardContent>
          </Card>)}

        </>
      )}
      <CreateServerDialog open={hostOpen} onOpenChange={setHostOpen} />
      {definitionsQuery.isError && <QueryErrorState error={definitionsQuery.error} title="VM definitions could not be loaded" onRetry={() => void definitionsQuery.refetch()} />}
      {unplacedDefinitions.length > 0 && <Card><CardHeader><CardTitle>VM definitions without host inventory</CardTitle></CardHeader><CardContent className="divide-y">{unplacedDefinitions.map(definition => <Link key={definition.id} to="/deployments/$id" params={{id:definition.id}} className="flex items-center gap-3 py-3 hover:underline"><span className="flex-1 font-medium">{definition.name}</span><span className="text-sm text-muted-foreground">{definition.node_name}</span></Link>)}</CardContent></Card>}
      {createTarget && <VmFormDialog environmentId={environmentId} connectionId={createTarget.connectionId} initialVm={{node_name: createTarget.node}} open onOpenChange={open => !open && setCreateTarget(null)} />}
      <PlatformConnectionsDialog open={connectionsOpen && !connectionDialogOpen && !connectionToDelete} onOpenChange={setConnectionsOpen}>
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
      </PlatformConnectionsDialog>
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
    const value = parseApiDate(connection.last_ipam_synced_at);
    return Number.isNaN(value.getTime())
      ? "Last synchronization unknown"
      : <span>Last synchronized: <Timestamp value={value} /></span>;
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
    <Card className="min-w-0 w-full">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b bg-muted/15 py-3">
        <div className="min-w-0 flex-1 basis-64">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Proxmox platforms
          </CardTitle>
          <p className="mt-1 break-words text-xs text-muted-foreground">
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
      <CardContent className="min-w-0 p-0">
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
                    <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={connection.api_token_configured ? "success" : "danger"} dot>{connection.api_token_configured ? "Token stored" : "Token missing"}</StatusBadge>
                        {connection.insecure ? <button type="button" onClick={() => onEdit(connection)} className="inline-flex items-center gap-1 text-xs font-medium text-warning underline underline-offset-2" title="Edit connection certificate verification"><TriangleAlert className="h-3.5 w-3.5" />Certificate verification off</button> : <StatusBadge tone="muted">{connection.ca_certificate_configured ? "Private CA configured" : "Certificate verification on"}</StatusBadge>}
                      </div>
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
            <div className="table-scroll hidden min-w-0 max-w-full md:block" role="region" aria-label="Proxmox platform connections" tabIndex={0}>
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
                        <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={connection.api_token_configured ? "success" : "danger"} dot>{connection.api_token_configured ? "Token stored" : "Token missing"}</StatusBadge>
                        {connection.insecure ? <button type="button" onClick={() => onEdit(connection)} className="inline-flex items-center gap-1 text-xs font-medium text-warning underline underline-offset-2" title="Edit connection certificate verification"><TriangleAlert className="h-3.5 w-3.5" />Certificate verification off</button> : <StatusBadge tone="muted">{connection.ca_certificate_configured ? "Private CA configured" : "Certificate verification on"}</StatusBadge>}
                      </div>
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
