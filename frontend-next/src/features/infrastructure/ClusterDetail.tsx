import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Boxes,
  ClipboardList,
  Download,
  HardDrive,
  RefreshCw,
  Server,
  ServerCog,
} from "lucide-react";
import { api, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreateServerDialog } from "@/components/CreateServerDialog";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { useUrlTab } from "@/lib/use-url-tab";
import {
  type AuditTask,
  type Cluster,
  type Node,
  type Vm,
  CapacityLine,
  CompactUsage,
  ObjectOverview,
  pct,
  preferredDatastores,
  statusLabel,
  tone,
  uptime,
} from "./detail-model";
import {
  DatastoresCard,
  ObjectInventoryPreview,
  ObjectTasksCard,
  Property,
  RecentObjectTasks,
  VmTable,
} from "./DetailPanels";

export function ClusterPage({
  cluster,
  onImportVm,
  onImportVms,
  canImportVm,
  canRunUpdates,
  onRefresh,
  refreshing,
  showAudit,
  auditTasks,
  auditLoading,
  auditError,
  onRetryAudit,
}: {
  cluster: Cluster;
  onImportVm: (vm: Vm) => void;
  onImportVms: (vms: Vm[]) => void;
  canImportVm: boolean;
  canRunUpdates: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  showAudit: boolean;
  auditTasks?: AuditTask[];
  auditLoading?: boolean;
  auditError?: unknown;
  onRetryAudit?: () => void;
}) {
  const stores = preferredDatastores(
    Array.isArray(cluster.datastores) ? cluster.datastores : [],
  );
  // A cluster is one navigation object. Multiple API connection aliases must
  // not turn its title into a comma-separated duplicate in breadcrumbs,
  // headings and the infrastructure tree.
  const title = cluster.connections?.[0]?.name || "Proxmox platform";
  const availableTabs = useMemo(
    () => ["overview", "configuration", "nodes", "vms", "datastores", "updates", ...(showAudit ? ["tasks"] : [])],
    [showAudit],
  );
  const clusterTabs = useUrlTab("overview", availableTabs);
  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        eyebrow="Infrastructure platform"
        badge={
          <StatusBadge tone={tone(cluster.status)} dot>
            {cluster.status === "online" ? "Connected" : "Not reachable"}
          </StatusBadge>
        }
        description={cluster.endpoint.replace(/^https?:\/\//, "")}
        breadcrumbs={
          <>
            <Link
              to="/infrastructure"
              className="hover:text-foreground hover:underline"
            >
              Infrastructure
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">{title}</span>
          </>
        }
        back={
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Back to infrastructure"
          >
            <Link to="/infrastructure">
              <ArrowLeft />
            </Link>
          </Button>
        }
        actions={
          <>
            <Button asChild type="button" size="sm" variant="outline">
              <Link to="/operations">
                <ClipboardList />
                All activity
              </Link>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </>
        }
      />
      <Tabs value={clusterTabs.value} onValueChange={clusterTabs.onValueChange} className="space-y-4">
        <TabsList aria-label="Platform sections" className="console-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configuration">
            <ServerCog className="h-4 w-4" />
            Configuration
          </TabsTrigger>
          <TabsTrigger value="nodes">
            <Server className="h-4 w-4" />
            Nodes{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {cluster.nodes.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="vms">
            <Boxes className="h-4 w-4" />
            Virtual machines{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {cluster.vms.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="datastores">
            <HardDrive className="h-4 w-4" />
            Datastores{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {stores.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="updates">
            <Download className="h-4 w-4" />
            Updates{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {cluster.nodes.reduce((sum, item) => sum + (item.update_count || 0), 0)}
            </span>
          </TabsTrigger>
          {showAudit && (
            <TabsTrigger value="tasks">
              <ClipboardList className="h-4 w-4" />
              Tasks
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          <ClusterOverview
            cluster={cluster}
            showAudit={showAudit}
            auditTasks={auditTasks}
            auditLoading={auditLoading}
            auditError={auditError}
            onRetryAudit={onRetryAudit}
            onOpenNodes={() => clusterTabs.onValueChange("nodes")}
            onOpenVms={() => clusterTabs.onValueChange("vms")}
            onOpenDatastores={() => clusterTabs.onValueChange("datastores")}
          />
        </TabsContent>
        <TabsContent value="configuration" className="mt-0">
          <ClusterConfiguration cluster={cluster} />
        </TabsContent>
        <TabsContent value="nodes" className="mt-0">
          <NodesCard cluster={cluster} />
        </TabsContent>
        <TabsContent value="vms" className="mt-0">
          <VmTable
            cluster={cluster}
            vms={cluster.vms}
            onImportVm={onImportVm}
            onImportVms={onImportVms}
            canImportVm={canImportVm}
          />
        </TabsContent>
        <TabsContent value="datastores" className="mt-0">
          <DatastoresCard
            stores={stores}
            emptyText="No datastores reported for this platform."
          />
        </TabsContent>
        <TabsContent value="updates" className="mt-0">
          <PlatformUpdatesCard cluster={cluster} canRunUpdates={canRunUpdates} canAddFleetHost={canImportVm} />
        </TabsContent>
        {showAudit && (
          <TabsContent value="tasks" className="mt-0">
            <ObjectTasksCard tasks={auditTasks} loading={auditLoading} error={auditError} onRetry={onRetryAudit} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function ClusterOverview({
  cluster,
  showAudit,
  auditTasks,
  auditLoading,
  auditError,
  onRetryAudit,
  onOpenNodes,
  onOpenVms,
  onOpenDatastores,
}: {
  cluster: Cluster;
  showAudit: boolean;
  auditTasks?: AuditTask[];
  auditLoading?: boolean;
  auditError?: unknown;
  onRetryAudit?: () => void;
  onOpenNodes: () => void;
  onOpenVms: () => void;
  onOpenDatastores: () => void;
}) {
  return (
    <div className="space-y-4">
      <ObjectOverview cluster={cluster} />
      <PlatformOperatingState
        cluster={cluster}
        onOpenNodes={onOpenNodes}
        onOpenVms={onOpenVms}
        onOpenDatastores={onOpenDatastores}
      />
      <ObjectInventoryPreview cluster={cluster} onOpenInventory={onOpenNodes} />
      {showAudit && <RecentObjectTasks tasks={auditTasks} loading={auditLoading} error={auditError} onRetry={onRetryAudit} />}
    </div>
  );
}

// A vCenter-style object overview leads with the current operational state,
// not another copy of the inventory table. Values here are deliberately
// phrases operators can act on; the detailed numbers stay in Capacity and in
// the dedicated Nodes/VMs tabs.
export function PlatformOperatingState({
  cluster,
  onOpenNodes,
  onOpenVms,
  onOpenDatastores,
}: {
  cluster: Cluster;
  onOpenNodes: () => void;
  onOpenVms: () => void;
  onOpenDatastores: () => void;
}) {
  const nodes = cluster.nodes ?? [];
  const vms = cluster.vms ?? [];
  const offlineNodes = nodes.filter((node) => node.status !== "online");
  const stoppedVms = vms.filter((vm) => vm.status === "stopped");
  const unknownVms = vms.filter(
    (vm) => !["running", "stopped"].includes(vm.status),
  );
  const stores = cluster.datastores ?? [];
  const constrainedStores = stores.filter(
    (store) => store.total > 0 && store.used / store.total >= 0.85,
  );
  const healthy =
    offlineNodes.length === 0 &&
    unknownVms.length === 0 &&
    constrainedStores.length === 0;
  const statusTone: StatusTone = healthy
    ? "success"
    : offlineNodes.length || constrainedStores.length
      ? "danger"
      : "muted";
  const statusText = healthy
    ? "Ready for operation"
    : `${offlineNodes.length + constrainedStores.length + unknownVms.length} review${offlineNodes.length + constrainedStores.length + unknownVms.length === 1 ? "" : "s"} required`;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Operational status
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deviations and immediate inventory status for this platform.
          </p>
        </div>
        <StatusBadge tone={statusTone} dot>
          {statusText}
        </StatusBadge>
      </CardHeader>
      <CardContent className="grid p-0 md:grid-cols-3">
        <div className="border-b p-4 md:border-b-0 md:border-r">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Nodes
          </div>
          <div className="mt-1 text-sm font-medium">
            {offlineNodes.length
              ? `${offlineNodes.length} unreachable`
              : `${nodes.length} reachable`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {offlineNodes.length
              ? offlineNodes.map((node) => node.name).join(", ")
              : "No node issues reported."}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-2 h-auto px-0"
            onClick={onOpenNodes}
          >
            Review nodes
          </Button>
        </div>
        <div className="border-b p-4 md:border-b-0 md:border-r">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Virtual machines
          </div>
          <div className="mt-1 text-sm font-medium">
            {vms.filter((vm) => vm.status === "running").length} running ·{" "}
            {stoppedVms.length} stopped
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {unknownVms.length
              ? `${unknownVms.length} VM(s) with unknown status.`
              : "Stopped virtual machines are not automatically an error."}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-2 h-auto px-0"
            onClick={onOpenVms}
          >
            Open VM inventory
          </Button>
        </div>
        <div className="p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            ZFS datastores
          </div>
          <div className="mt-1 text-sm font-medium">
            {constrainedStores.length
              ? `${constrainedStores.length} with high utilization`
              : `${stores.length} healthy`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {constrainedStores.length
              ? constrainedStores.map((store) => store.id).join(", ")
              : "Threshold: 85% utilization."}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-2 h-auto px-0"
            onClick={onOpenDatastores}
          >
            Show datastores
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ClusterConfiguration({ cluster }: { cluster: Cluster }) {
  const stores = preferredDatastores(
    Array.isArray(cluster.datastores) ? cluster.datastores : [],
  );
  const running = cluster.vms.filter((vm) => vm.status === "running").length;
  const onlineNodes = cluster.nodes.filter(
    (node) => node.status === "online",
  ).length;

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,.8fr)]">
        <Card>
          <CardHeader className="border-b py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ServerCog className="h-4 w-4" />
              Platform & inventory
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <dl className="console-properties">
              <Property label="Platform" value="Proxmox" />
              <Property
                label="Endpoint"
                value={cluster.endpoint.replace(/^https?:\/\//, "")}
                mono
              />
              <Property
                label="Nodes"
                value={`${onlineNodes} online · ${cluster.nodes.length} insgesamt`}
              />
              <Property
                label="Virtual machines"
                value={`${running} running · ${Math.max(0, cluster.vms.length - running)} stopped`}
              />
              <Property
                label="Datastores"
                value={`${stores.length} available`}
              />
              <Property
                label="Connection"
                value={
                  cluster.connections?.[0]?.name || "No named connection"
                }
              />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="border-b py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4" />
              Storage overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            {stores.length ? (
              stores.slice(0, 4).map((store) => (
                <div key={`${store.node_name}-${store.id}`}>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-sm font-medium">
                      {store.id}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {store.node_name || "—"}
                    </span>
                  </div>
                  <CapacityLine
                    label="Used"
                    used={store.used}
                    total={store.total}
                  />
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No datastores reported for this platform.
              </p>
            )}
            {stores.length > 4 && (
              <p className="border-t pt-3 text-xs text-muted-foreground">
                {stores.length - 4} more datastores are available in the Datastores tab.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function NodesCard({ cluster }: { cluster: Cluster }) {
  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" />
          Nodes
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {cluster.nodes.length ? (
            cluster.nodes.map((node) => (
              <Link
                key={node.name}
                to="/infrastructure/$clusterId/nodes/$nodeName"
                params={{ clusterId: cluster.id, nodeName: node.name }}
                className="block p-4 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono font-medium">{node.name}</span>
                  <StatusBadge tone={tone(node.status)} dot>
                    {statusLabel(node.status)}
                  </StatusBadge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <span className="text-muted-foreground">
                    CPU{" "}
                    <b className="ml-1 text-foreground">
                      {pct(node.cpu, 1)} · {node.maxcpu}
                    </b>
                  </span>
                  <span className="text-muted-foreground">
                    RAM{" "}
                    <b className="ml-1 text-foreground">
                      {pct(node.mem, node.maxmem)}
                    </b>
                  </span>
                  <span className="text-muted-foreground">
                    Virtual machines{" "}
                    <b className="ml-1 text-foreground">
                      {
                        cluster.vms.filter((vm) => vm.node_name === node.name)
                          .length
                      }
                    </b>
                  </span>
                  <span className="text-muted-foreground">
                    Uptime{" "}
                    <b className="ml-1 text-foreground">
                      {uptime(node.uptime)}
                    </b>
                  </span>
                </div>
              </Link>
            ))
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No nodes reported.
            </div>
          )}
        </div>
        <div className="table-scroll hidden md:block">
          <table
            data-density="compact"
            className="w-full min-w-[820px] text-sm"
          >
            <thead>
              <tr>
                <th>Node</th>
                <th>Status</th>
                <th>CPU</th>
                <th>Memory</th>
                <th>Virtual machines</th>
                <th>Uptime</th>
              </tr>
            </thead>
            <tbody>
              {cluster.nodes.length ? (
                cluster.nodes.map((node) => {
                  const cpuUsed = (node.cpu || 0) * (node.maxcpu || 0);
                  return (
                    <tr key={node.name}>
                      <td className="font-mono font-medium">
                        <Link
                          className="hover:text-primary hover:underline"
                          to="/infrastructure/$clusterId/nodes/$nodeName"
                          params={{
                            clusterId: cluster.id,
                            nodeName: node.name,
                          }}
                        >
                          {node.name}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge tone={tone(node.status)} dot>
                          {statusLabel(node.status)}
                        </StatusBadge>
                      </td>
                      <td>
                        <CompactUsage
                          used={cpuUsed}
                          total={node.maxcpu}
                          format={(value) =>
                            `${value.toFixed(value < 10 ? 1 : 0)} Cores`
                          }
                        />
                      </td>
                      <td>
                        <CompactUsage used={node.mem} total={node.maxmem} />
                      </td>
                      <td className="font-mono tabular-nums">
                        {
                          cluster.vms.filter((vm) => vm.node_name === node.name)
                            .length
                        }
                      </td>
                      <td className="font-mono text-xs">
                        {uptime(node.uptime)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="py-7 text-center text-muted-foreground"
                  >
                    No nodes reported.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function fleetDefaults(cluster: Cluster, node: Node, environmentId: string) {
  const bridgeAddress = (node.bridges || []).find((bridge) => bridge.active && bridge.address)?.address
    || (node.bridges || []).find((bridge) => bridge.address)?.address
    || "";
  let endpointAddress = "";
  try {
    endpointAddress = new URL(cluster.endpoint).hostname;
  } catch {
    // The hostname remains useful even when an older connection has no URL-shaped endpoint.
  }
  return {
    name: node.name,
    hostname: node.name,
    ip_address: bridgeAddress || (cluster.nodes.length === 1 ? endpointAddress : ""),
    ssh_user: "root",
    ssh_port: 22,
    tags: ["proxmox-node", `proxmox:${cluster.connections?.[0]?.name || "platform"}`],
    environment_id: environmentId,
  };
}

export function PlatformUpdatesCard({
  cluster,
  canRunUpdates,
  canAddFleetHost,
}: {
  cluster: Cluster;
  canRunUpdates: boolean;
  canAddFleetHost: boolean;
}) {
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const [fleetNode, setFleetNode] = useState<Node | null>(null);
  const initialValues = useMemo(
    () => fleetNode ? fleetDefaults(cluster, fleetNode, environmentId) : null,
    [cluster, environmentId, fleetNode],
  );
  const total = cluster.nodes.reduce(
    (sum, node) => sum + (node.update_count || 0),
    0,
  );
  const unavailable = cluster.nodes.filter(
    (node) => node.update_status === "unavailable",
  ).length;
  return (
    <>
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4" />
            Proxmox updates
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Packages reported by each Proxmox node. Installation uses the
            audited Shipyard update workflow.
          </p>
        </div>
        <StatusBadge tone={total ? "warning" : unavailable ? "muted" : "success"} dot>
          {total
            ? `${total} update${total === 1 ? "" : "s"} available`
            : unavailable
              ? `Catalog unavailable on ${unavailable} node${unavailable === 1 ? "" : "s"}`
              : "Platform current"}
        </StatusBadge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {cluster.nodes.map((node) => (
            <Link
              key={node.name}
              to="/infrastructure/$clusterId/nodes/$nodeName"
              params={{ clusterId: cluster.id, nodeName: node.name }}
              className="flex items-center justify-between gap-3 p-3 hover:bg-muted/30"
            >
              <div className="min-w-0">
                <div className="truncate font-mono font-medium">{node.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {node.update_status === "unavailable"
                    ? "Catalog unavailable"
                    : `${node.update_count || 0} package updates`}
                </div>
              </div>
              <StatusBadge
                tone={node.update_status === "available" ? "warning" : node.update_status === "current" ? "success" : "muted"}
              >
                {node.update_status === "available" ? "Updates" : node.update_status === "current" ? "Current" : "Unknown"}
              </StatusBadge>
            </Link>
          ))}
        </div>
        <div className="table-scroll hidden md:block">
          <table className="w-full min-w-[760px]" data-density="compact">
            <thead><tr><th className="w-[18%]">Node</th><th className="w-[22%]">Status</th><th className="w-[14%]">Available</th><th>Installation</th><th className="w-24" aria-label="Actions" /></tr></thead>
            <tbody>
              {cluster.nodes.map((node) => (
                <tr key={node.name}>
                  <td className="font-mono font-medium">{node.name}</td>
                  <td>
                    <StatusBadge tone={node.update_status === "available" ? "warning" : node.update_status === "current" ? "success" : "muted"} dot>
                      {node.update_status === "available" ? "Updates available" : node.update_status === "current" ? "Current" : "Catalog unavailable"}
                    </StatusBadge>
                  </td>
                  <td className="font-mono tabular-nums">{node.update_status === "unavailable" ? "—" : node.update_count || 0}</td>
                  <td className="text-muted-foreground">
                    {node.fleet_server_id
                      ? canRunUpdates ? "Ready through Shipyard" : "Permission required"
                      : canAddFleetHost ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => setFleetNode(node)}>
                          <Server />
                          Add to Shipyard
                        </Button>
                      ) : "Shipyard edit permission required"}
                  </td>
                  <td className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link to="/infrastructure/$clusterId/nodes/$nodeName" params={{ clusterId: cluster.id, nodeName: node.name }}>
                        Review
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
    <CreateServerDialog
      open={Boolean(fleetNode)}
      onOpenChange={(open) => !open && setFleetNode(null)}
      initialValues={initialValues}
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: ["opentofu", "infrastructure"] })}
    />
    </>
  );
}

export function NodeUpdatesCard({
  cluster,
  node,
  canRunUpdates,
  canAddFleetHost,
}: {
  cluster: Cluster;
  node: Node;
  canRunUpdates: boolean;
  canAddFleetHost: boolean;
}) {
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [addToFleet, setAddToFleet] = useState(false);
  const initialValues = useMemo(
    () => fleetDefaults(cluster, node, environmentId),
    [cluster, environmentId, node],
  );
  const connectionId = cluster.connections?.[0]?.id || "";
  const packages = node.available_updates || [];
  const refresh = useMutation({
    mutationFn: () =>
      apiFetch(`/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/nodes/${encodeURIComponent(node.name)}/updates/refresh`, { method: "POST" }),
    onSuccess: () => {
      showToast(`Package catalog refresh started on ${node.name}.`, "success");
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["opentofu", "infrastructure"] });
      }, 2_500);
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const install = useMutation({
    mutationFn: () => api.runUpdate(node.fleet_server_id!),
    onSuccess: () => showToast(`System update started on ${node.name}. Follow progress under Tasks.`, "success"),
    onError: (error: Error) => showToast(error.message, "error"),
  });

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4" />
              Package updates
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {node.update_status === "unavailable"
                ? node.update_error || "The Proxmox API token cannot read this node's update catalog."
                : `${packages.length} package${packages.length === 1 ? "" : "s"} reported by Proxmox.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!connectionId || !canRunUpdates || refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
              Refresh catalog
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!packages.length || !node.fleet_server_id || !canRunUpdates || install.isPending}
              onClick={() => setConfirmUpdate(true)}
            >
              <Download />
              Install {packages.length || ""} update{packages.length === 1 ? "" : "s"}
            </Button>
          </div>
        </CardHeader>
        {!node.fleet_server_id && packages.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-warning/5 px-4 py-3 text-sm text-warning">
            <span>Add this Proxmox node to Shipyard to install updates securely through SSH.</span>
            {canAddFleetHost && (
              <Button type="button" size="sm" variant="outline" onClick={() => setAddToFleet(true)}>
                <Server />
                Add to Shipyard
              </Button>
            )}
          </div>
        )}
        <CardContent className="p-0">
          {node.update_status === "unavailable" ? (
            <div className="p-5 text-sm text-muted-foreground">
              Grant the Proxmox API token <code>Sys.Modify</code> on this node to view and refresh package updates.
            </div>
          ) : packages.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">This node is up to date.</div>
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[760px]" data-density="compact">
                <thead><tr><th>Package</th><th>Origin</th><th>Installed</th><th>Available</th></tr></thead>
                <tbody>
                  {packages.map((item) => (
                    <tr key={`${item.package}:${item.available_version}`}>
                      <td>
                        <div className="font-mono font-medium">{item.package}</div>
                        {item.description && <div className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground">{item.description}</div>}
                      </td>
                      <td>{item.origin || "—"}</td>
                      <td className="font-mono text-xs">{item.current_version || "—"}</td>
                      <td className="font-mono text-xs">{item.available_version || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmUpdate}
        onOpenChange={setConfirmUpdate}
        title={`Install updates on ${node.name}?`}
        description={`Shipyard will run a full system upgrade for ${packages.length} available package${packages.length === 1 ? "" : "s"}. Services may restart and a reboot may be required.`}
        confirmLabel="Start update"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => install.mutate()}
        isPending={install.isPending}
      />
      <CreateServerDialog
        open={addToFleet}
        onOpenChange={setAddToFleet}
        initialValues={initialValues}
        onSuccess={() => void queryClient.invalidateQueries({ queryKey: ["opentofu", "infrastructure"] })}
      />
    </>
  );
}
