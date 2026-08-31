import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  CheckSquare2,
  ClipboardList,
  Download,
  HardDrive,
  RefreshCw,
  Server,
  ServerCog,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OverflowItem, OverflowLink, OverflowMenu } from "@/components/ui/overflow-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUi } from "@/lib/store";
import { asArray } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import {
  type AuditTask,
  type Bridge,
  type Cluster,
  type Datastore,
  type Folder,
  type Node,
  type Vm,
  bytes,
  CapacityCell,
  CompactUsage,
  pct,
  preferredDatastores,
  statusLabel,
  taskDate,
  tone,
  uptime,
  guestKind,
} from "./detail-model";

export function ObjectInventoryPreview({
  cluster,
  node,
  onOpenInventory,
}: {
  cluster: Cluster;
  node?: Node;
  onOpenInventory: () => void;
}) {
  const vms = node
    ? cluster.vms.filter((vm) => vm.node_name === node.name)
    : cluster.vms;
  const isNode = Boolean(node);
  const preview = isNode ? vms.slice(0, 6) : cluster.nodes.slice(0, 6);
  const running = vms.filter((vm) => vm.status === "running").length;
  const stopped = vms.filter((vm) => vm.status === "stopped").length;
  const managed = vms.filter((vm) => Boolean(vm.fleet_server_id)).length;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4" />
            {isNode ? "Virtual machines" : "Inventory"}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isNode
              ? `${running} running · ${stopped} stopped · ${managed} managed in Shipyard`
              : `${cluster.nodes.length} nodes · ${cluster.vms.length} virtual machines · ${managed} managed in Shipyard`}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenInventory}
        >
          {isNode ? "Show all virtual machines" : "Show all nodes"}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {preview.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            {isNode
              ? "No virtual machines on this node."
              : "No nodes in platform inventory."}
          </div>
        ) : isNode ? (
          <>
            <div className="divide-y md:hidden">
              {(preview as Vm[]).map((vm) => (
                <Link
                  key={`${vm.node_name}:${vm.vm_id}`}
                  to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                  params={{
                    clusterId: cluster.id,
                    nodeName: vm.node_name,
                    vmId: String(vm.vm_id),
                  }}
                  className="block p-3 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{vm.name}</div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {guestKind(vm)} {vm.vm_id} · {vm.maxcpu || "—"} vCPU
                      </div>
                    </div>
                    <StatusBadge tone={tone(vm.status)} dot>
                      {statusLabel(vm.status)}
                    </StatusBadge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      RAM{" "}
                      <b className="font-mono text-foreground">
                        {vm.maxmem
                          ? `${bytes(vm.mem)} / ${bytes(vm.maxmem)}`
                          : "—"}
                      </b>
                    </span>
                    <span>
                      {vm.fleet_server_id
                        ? "Managed in Shipyard"
                        : "Inventory only"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                data-density="compact"
                className="w-full min-w-[680px] text-sm"
              >
                <thead>
                  <tr>
                    <th>VM / container</th>
                    <th>ID</th>
                    <th>Status</th>
                    <th>vCPU</th>
                    <th>Memory</th>
                    <th>Management</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview as Vm[]).map((vm) => (
                    <tr key={`${vm.node_name}:${vm.vm_id}`}>
                      <td className="font-medium">
                        <Link
                          className="hover:text-primary hover:underline"
                          to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                          params={{
                            clusterId: cluster.id,
                            nodeName: vm.node_name,
                            vmId: String(vm.vm_id),
                          }}
                        >
                          {vm.name}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">{vm.vm_id}</td>
                      <td>
                        <StatusBadge tone={tone(vm.status)} dot>
                          {statusLabel(vm.status)}
                        </StatusBadge>
                      </td>
                      <td className="font-mono tabular-nums">
                        {vm.maxcpu || "—"}
                      </td>
                      <td className="font-mono text-xs">
                        {vm.maxmem
                          ? `${bytes(vm.mem)} / ${bytes(vm.maxmem)}`
                          : "—"}
                      </td>
                      <td>
                        {vm.fleet_server_id ? (
                          <Link
                            to="/servers/$id"
                            params={{ id: vm.fleet_server_id }}
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            Host
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Not adopted
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {(preview as Node[]).map((item) => {
                const vmCount = cluster.vms.filter(
                  (vm) => vm.node_name === item.name,
                ).length;
                return (
                  <Link
                    key={item.name}
                    to="/infrastructure/$clusterId/nodes/$nodeName"
                    params={{ clusterId: cluster.id, nodeName: item.name }}
                    className="block p-3 transition-colors hover:bg-muted/30"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono font-medium">{item.name}</span>
                      <StatusBadge tone={tone(item.status)} dot>
                        {statusLabel(item.status)}
                      </StatusBadge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        CPU{" "}
                        <b className="font-mono text-foreground">
                          {pct(item.cpu, 1)} · {item.maxcpu || "—"} cores
                        </b>
                      </span>
                      <span>
                        RAM{" "}
                        <b className="font-mono text-foreground">
                          {bytes(item.mem)} / {bytes(item.maxmem)}
                        </b>
                      </span>
                      <span>
                        Virtual machines{" "}
                        <b className="font-mono text-foreground">{vmCount}</b>
                      </span>
                      <span>
                        Uptime{" "}
                        <b className="font-mono text-foreground">
                          {uptime(item.uptime)}
                        </b>
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                data-density="compact"
                className="w-full min-w-[680px] text-sm"
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
                  {(preview as Node[]).map((item) => {
                    const vmCount = cluster.vms.filter(
                      (vm) => vm.node_name === item.name,
                    ).length;
                    return (
                      <tr key={item.name}>
                        <td className="font-mono font-medium">
                          <Link
                            className="hover:text-primary hover:underline"
                            to="/infrastructure/$clusterId/nodes/$nodeName"
                            params={{
                              clusterId: cluster.id,
                              nodeName: item.name,
                            }}
                          >
                            {item.name}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge tone={tone(item.status)} dot>
                            {statusLabel(item.status)}
                          </StatusBadge>
                        </td>
                        <td className="font-mono text-xs">
                          {pct(item.cpu, 1)} · {item.maxcpu || "—"} cores
                        </td>
                        <td className="font-mono text-xs">
                          {bytes(item.mem)} / {bytes(item.maxmem)}
                        </td>
                        <td className="font-mono tabular-nums">{vmCount}</td>
                        <td className="font-mono text-xs">
                          {uptime(item.uptime)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {isNode && vms.length > preview.length && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {vms.length - preview.length} more virtual machines in the complete inventory.
          </div>
        )}
        {!isNode && cluster.nodes.length > preview.length && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {cluster.nodes.length - preview.length} more nodes in the complete
            inventory.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function NodeConfiguration({ node, vms }: { node: Node; vms: Vm[] }) {
  const stores = node.datastores ?? [];
  const bridges = node.bridges ?? [];
  const running = vms.filter((vm) => vm.status === "running").length;
  const stopped = vms.filter((vm) => vm.status === "stopped").length;
  // Proxmox returns directory, ISO and ZFS storage in no useful presentation
  // order. The selected host's configuration must use the same ZFS-first
  // rule as platform and overview pages, otherwise operators see a wrong
  // "primary datastore" depending on API response ordering.
  const primaryStore = preferredDatastores(stores)[0];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,.72fr)]">
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerCog className="h-4 w-4" />
            Hardware & configuration
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Static host data; current usage appears in the overview.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="console-properties">
            <Property
              label="CPU-Modell"
              value={node.cpu_model || "Not reported"}
            />
            <Property
              label="CPU capacity"
              value={`${node.maxcpu || 0} cores${node.cpu_sockets ? ` · ${node.cpu_sockets} socket${node.cpu_sockets === 1 ? "" : "s"}` : ""}`}
              mono
            />
            <Property label="Memory" value={bytes(node.maxmem)} mono />
            <Property
              label="Proxmox VE"
              value={node.platform_version || "Not reported"}
              mono
            />
            <Property
              label="Kernel"
              value={node.kernel_version || "Not reported"}
              mono
            />
            <Property
              label="ZFS-Datastores"
              value={`${stores.length} available`}
            />
            <Property
              label="Primary datastore"
              value={
                primaryStore
                  ? `${primaryStore.id}${primaryStore.type ? ` · ${primaryStore.type}` : ""}`
                  : "—"
              }
              mono
            />
            <Property
              label="Free storage"
              value={
                primaryStore && Number.isFinite(primaryStore.available)
                  ? bytes(primaryStore.available || 0)
                  : "—"
              }
              mono
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Operational status
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Inventory status for this node.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="console-properties">
            <Property label="Node" value={statusLabel(node.status)} />
            <Property label="Uptime" value={uptime(node.uptime)} mono />
            <Property
              label="Virtual machines running"
              value={`${running} / ${vms.length}`}
            />
            <Property label="Virtual machines stopped" value={String(stopped)} />
            <Property
              label="Snapshots"
              value="Manage on the individual VM"
            />
          </dl>
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader className="border-b py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            Network & bridges
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Proxmox bridges relevant to VM networks. Physical NICs remain
            bewusst ausgeblendet.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {bridges.length === 0 ? (
            <div className="px-4 py-5 text-sm text-muted-foreground">
              No active or configured Proxmox bridges reported.
            </div>
          ) : (
            <>
              <div className="divide-y md:hidden">
                {bridges.map((bridge) => (
                  <div key={bridge.name} className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono font-medium">
                        {bridge.name}
                      </span>
                      <StatusBadge
                        tone={bridge.active ? "success" : "muted"}
                        dot
                      >
                        {bridge.active ? "Active" : "Inactive"}
                      </StatusBadge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <span className="text-muted-foreground">
                        IPv4{" "}
                        <b className="ml-1 font-mono text-foreground">
                          {bridge.address
                            ? `${bridge.address}${bridge.cidr !== null ? `/${bridge.cidr}` : ""}`
                            : "—"}
                        </b>
                      </span>
                      <span className="text-muted-foreground">
                        Gateway{" "}
                        <b className="ml-1 font-mono text-foreground">
                          {bridge.gateway || "—"}
                        </b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="table-scroll hidden md:block">
                <table
                  data-density="compact"
                  className="w-full min-w-[660px] text-sm"
                >
                  <thead>
                    <tr>
                      <th>Bridge</th>
                      <th>Status</th>
                      <th>Type</th>
                      <th>IPv4 / CIDR</th>
                      <th>Gateway</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bridges.map((bridge) => (
                      <tr key={bridge.name}>
                        <td className="font-mono font-medium">{bridge.name}</td>
                        <td>
                          <StatusBadge
                            tone={bridge.active ? "success" : "muted"}
                            dot
                          >
                            {bridge.active ? "Active" : "Inactive"}
                          </StatusBadge>
                        </td>
                        <td className="font-mono text-xs">
                          {bridge.type || "bridge"}
                        </td>
                        <td className="font-mono text-xs">
                          {bridge.address
                            ? `${bridge.address}${bridge.cidr !== null ? `/${bridge.cidr}` : ""}`
                            : "—"}
                        </td>
                        <td className="font-mono text-xs">
                          {bridge.gateway || "—"}
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
    </div>
  );
}

/**
 * vSphere keeps the latest object activity visible in the summary, while the
 * full history remains a dedicated view.  This compact card follows that
 * pattern: it does not duplicate the entire audit table, but immediately
 * answers whether the selected platform/node has recently changed.
 */
interface ObjectTaskStateProps {
  tasks?: AuditTask[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}

export function RecentObjectTasks({ tasks = [], loading = false, error, onRetry }: ObjectTaskStateProps) {
  const recent = tasks.slice(0, 4);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" />
            Recent tasks
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The most recent recorded changes to this object.
          </p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {tasks.length}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">Loading tasks…</div>
        ) : error ? (
          <QueryErrorState compact error={error} title="Object tasks could not be loaded" onRetry={onRetry} />
        ) : recent.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">
            No tasks have been recorded for this object yet.
          </div>
        ) : (
          <div className="divide-y">
            {recent.map((task, index) => (
              <div
                key={`${task.created_at ?? ""}-${task.action ?? ""}-${index}`}
                className="grid gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(12rem,1fr)_minmax(16rem,1.5fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {task.action || "Action"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {taskDate(task.created_at)} · {task.user || "System"}
                  </div>
                </div>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={task.detail}
                >
                  {task.detail || "No further details"}
                </p>
                <StatusBadge
                  tone={
                    task.success === false || task.success === 0
                      ? "danger"
                      : "success"
                  }
                  dot
                >
                  {task.success === false || task.success === 0
                    ? "Failed"
                    : "Successful"}
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Property({
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
      <dd className={mono ? "font-mono text-xs" : ""}>{value || "—"}</dd>
    </div>
  );
}

export function ObjectTasksCard({ tasks = [], loading = false, error, onRetry }: ObjectTaskStateProps) {
  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          Recent tasks
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-5 text-sm text-muted-foreground">Loading tasks…</div>
        ) : error ? (
          <QueryErrorState compact error={error} title="Object tasks could not be loaded" onRetry={onRetry} />
        ) : tasks.length === 0 ? (
          <div className="p-7 text-center text-sm text-muted-foreground">
            No tasks have been recorded for this object yet.
          </div>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {tasks.map((task, index) => (
                <div
                  key={`${task.created_at ?? ""}-${task.action ?? ""}-${index}`}
                  className="space-y-1.5 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">
                      {task.action || "Action"}
                    </span>
                    <StatusBadge
                      tone={
                        task.success === false || task.success === 0
                          ? "danger"
                          : "success"
                      }
                    >
                      {task.success === false || task.success === 0
                        ? "Failed"
                        : "Successful"}
                    </StatusBadge>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {task.detail || "—"}
                  </p>
                  <div className="text-xs text-muted-foreground">
                    {taskDate(task.created_at)} · {task.user || "System"}
                  </div>
                </div>
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                data-density="compact"
                className="w-full min-w-[720px] text-sm"
              >
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Task</th>
                    <th>Details</th>
                    <th>Run by</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task, index) => (
                    <tr
                      key={`${task.created_at ?? ""}-${task.action ?? ""}-${index}`}
                    >
                      <td className="whitespace-nowrap font-mono text-xs">
                        {taskDate(task.created_at)}
                      </td>
                      <td className="font-medium">{task.action || "Action"}</td>
                      <td
                        className="max-w-[32rem] truncate text-muted-foreground"
                        title={task.detail}
                      >
                        {task.detail || "—"}
                      </td>
                      <td>{task.user || "System"}</td>
                      <td>
                        <StatusBadge
                          tone={
                            task.success === false || task.success === 0
                              ? "danger"
                              : "success"
                          }
                        >
                          {task.success === false || task.success === 0
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
        )}
      </CardContent>
    </Card>
  );
}

export function DatastoresCard({
  stores,
  emptyText,
}: {
  stores: Datastore[];
  emptyText: string;
}) {
  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="h-4 w-4" />
          ZFS-Datastores
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Active ZFS pools available to virtual machines.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {stores.length ? (
            stores.map((store) => (
              <div
                key={`${store.node_name}-${store.id}`}
                className="space-y-3 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono font-medium">{store.id}</div>
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {store.node_name || "—"}
                      {store.type ? ` · ${store.type}` : ""}
                    </div>
                  </div>
                </div>
                <CapacityCell used={store.used} total={store.total} />
              </div>
            ))
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </div>
          )}
        </div>
        <div className="table-scroll hidden md:block">
          <table
            data-density="compact"
            className="w-full min-w-[740px] text-sm"
          >
            <thead>
              <tr>
                <th>Name</th>
                <th>Node</th>
                <th>Type</th>
                <th>Used</th>
                <th>Free</th>
                <th>Capacity</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {stores.length ? (
                stores.map((store) => (
                  <tr key={`${store.node_name}-${store.id}`}>
                    <td className="font-mono font-medium">{store.id}</td>
                    <td className="font-mono text-xs">
                      {store.node_name || "—"}
                    </td>
                    <td className="font-mono text-xs">
                      {store.type || "zfspool"}
                    </td>
                    <td className="font-mono text-xs">{bytes(store.used)}</td>
                    <td className="font-mono text-xs">
                      {Number.isFinite(store.available)
                        ? bytes(store.available || 0)
                        : "—"}
                    </td>
                    <td className="font-mono text-xs">{bytes(store.total)}</td>
                    <td className="font-mono text-xs tabular-nums">
                      {store.total > 0
                        ? `${Math.round((store.used / store.total) * 100)} %`
                        : "—"}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={7}
                    className="py-7 text-center text-muted-foreground"
                  >
                    {emptyText}
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

export function VmTable({
  cluster,
  vms,
  onImportVm,
  onImportVms,
  canImportVm,
}: {
  cluster: Cluster;
  vms: Vm[];
  onImportVm: (vm: Vm) => void;
  onImportVms: (vms: Vm[]) => void;
  canImportVm: boolean;
}) {
  const [selectedVmIds, setSelectedVmIds] = useState<Set<string>>(new Set());
  const selectable = useMemo(
    () => vms.filter((vm) => !vm.fleet_server_id),
    [vms],
  );
  const selectedVms = useMemo(
    () =>
      selectable.filter((vm) =>
        selectedVmIds.has(`${vm.node_name}:${vm.vm_id}`),
      ),
    [selectable, selectedVmIds],
  );
  const allSelected =
    selectable.length > 0 && selectedVms.length === selectable.length;
  const someSelected = selectedVms.length > 0 && !allSelected;
  useEffect(
    () =>
      setSelectedVmIds((current) => {
        const next = new Set(
          [...current].filter((id) =>
            selectable.some((vm) => `${vm.node_name}:${vm.vm_id}` === id),
          ),
        );
        return next.size === current.size &&
          [...next].every((id) => current.has(id))
          ? current
          : next;
      }),
    [selectable],
  );
  const toggleVm = (vm: Vm) =>
    setSelectedVmIds((current) => {
      const next = new Set(current);
      const id = `${vm.node_name}:${vm.vm_id}`;
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedVmIds(
      allSelected
        ? new Set()
        : new Set(selectable.map((vm) => `${vm.node_name}:${vm.vm_id}`)),
    );
  const action = (vm: Vm) =>
    vm.fleet_server_id ? (
      <OverflowMenu title={`Actions for ${vm.name}`}>
        <OverflowLink icon={Server} to="/servers/$id" params={{ id: vm.fleet_server_id }}>
          Host details
        </OverflowLink>
      </OverflowMenu>
    ) : canImportVm && cluster.connections?.[0]?.id ? (
      <OverflowMenu title={`Actions for ${vm.name}`}>
        <OverflowItem icon={ServerCog} onClick={() => onImportVm(vm)}>
          Adopt as host
        </OverflowItem>
      </OverflowMenu>
    ) : (
      <span className="text-xs text-muted-foreground">Not adopted</span>
    );
  const name = (vm: Vm) =>
    cluster.connections?.[0]?.id ? (
      <Link
        className="min-w-0 truncate font-medium hover:text-primary hover:underline"
        to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
        params={{
          clusterId: cluster.id,
          nodeName: vm.node_name,
          vmId: String(vm.vm_id),
        }}
      >
        {vm.name}
      </Link>
    ) : (
      <span className="min-w-0 truncate font-medium">{vm.name}</span>
    );
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4" />
            Virtual machines
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Explicitly select inventory VMs and CTs and adopt them into Shipyard with their
            access details.
          </p>
        </div>
        {canImportVm && selectable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5">
            <Button size="sm" onClick={() => onImportVms(selectable)}>
              <ServerCog />
              Import all orphaned virtual machines
            </Button>
            {selectedVms.length > 0 && <>
            <span className="text-xs text-muted-foreground">
              {selectedVms.length} selected
            </span>
            <Button size="sm" variant="outline" onClick={() => onImportVms(selectedVms)}>
              <CheckSquare2 />
              Adopt into Shipyard
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setSelectedVmIds(new Set())}
            >
              <X className="h-4 w-4" />
            </Button>
            </>}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {vms.length ? (
            vms.map((vm) => {
              const selectableVm = !vm.fleet_server_id;
              return (
                <div
                  key={`${vm.node_name}-${vm.vm_id}`}
                  className="space-y-3 p-4"
                  data-selected={
                    selectedVmIds.has(`${vm.node_name}:${vm.vm_id}`) ||
                    undefined
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {canImportVm && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${vm.name}`}
                          disabled={!selectableVm}
                          checked={selectedVmIds.has(
                            `${vm.node_name}:${vm.vm_id}`,
                          )}
                          onChange={() => toggleVm(vm)}
                        />
                      )}
                      {name(vm)}
                    </div>
                    <StatusBadge tone={tone(vm.status)} dot>
                      {vm.status}
                    </StatusBadge>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <span>
                      Node{" "}
                      <b className="ml-1 font-mono text-foreground">
                        {vm.node_name}
                      </b>
                    </span>
                    <span>
                      {guestKind(vm)} ID{" "}
                      <b className="ml-1 font-mono text-foreground">
                        {vm.vm_id}
                      </b>
                    </span>
                    <span>
                      vCPU{" "}
                      <b className="ml-1 text-foreground">{vm.maxcpu || "—"}</b>
                    </span>
                    <span>
                      RAM{" "}
                      <b className="ml-1 text-foreground">
                        {vm.maxmem
                          ? `${bytes(vm.mem)} / ${bytes(vm.maxmem)}`
                          : "—"}
                      </b>
                    </span>
                  </div>
                  {vm.maxmem ? (
                    <CapacityCell used={vm.mem} total={vm.maxmem} />
                  ) : null}
                  {vm.maxdisk ? (
                    <CapacityCell used={vm.disk} total={vm.maxdisk} />
                  ) : null}
                  <div>{action(vm)}</div>
                </div>
              );
            })
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No virtual machines on this node.
            </div>
          )}
        </div>
        <div className="table-scroll hidden md:block">
          <table
            data-density="compact"
            className="w-full min-w-[980px] text-sm"
          >
            <thead>
              <tr>
                {canImportVm && (
                  <th className="w-11">
                    <input
                      type="checkbox"
                      aria-label="Select all adoptable virtual machines"
                      checked={allSelected}
                      ref={(input) => {
                        if (input) input.indeterminate = someSelected;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th>VM / container</th>
                <th>Node</th>
                <th>Type</th>
                <th>ID</th>
                <th>Status</th>
                <th>vCPU</th>
                <th>Memory</th>
                <th>Disk</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vms.length ? (
                vms.map((vm) => {
                  const selectableVm = !vm.fleet_server_id;
                  const checked = selectedVmIds.has(
                    `${vm.node_name}:${vm.vm_id}`,
                  );
                  return (
                    <tr
                      key={`${vm.node_name}-${vm.vm_id}`}
                      data-selected={checked || undefined}
                    >
                      {canImportVm && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${vm.name}`}
                            disabled={!selectableVm}
                            checked={checked}
                            onChange={() => toggleVm(vm)}
                          />
                        </td>
                      )}
                      <td>{name(vm)}</td>
                      <td className="font-mono text-xs">{vm.node_name}</td>
                      <td>{guestKind(vm)}</td>
                      <td className="font-mono text-xs">{vm.vm_id}</td>
                      <td>
                        <StatusBadge tone={tone(vm.status)} dot>
                          {vm.status}
                        </StatusBadge>
                      </td>
                      <td className="font-mono tabular-nums">
                        {vm.maxcpu || "—"}
                      </td>
                      <td>
                        <CompactUsage used={vm.mem} total={vm.maxmem} />
                      </td>
                      <td>
                        <CompactUsage used={vm.disk} total={vm.maxdisk} />
                      </td>
                      <td className="text-right">{action(vm)}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={canImportVm ? 10 : 9}
                    className="py-7 text-center text-muted-foreground"
                  >
                    No virtual machines on this node.
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

export function BulkImportProxmoxVmsDialog({
  connectionId,
  environmentId,
  vms,
  open,
  onOpenChange,
}: {
  connectionId: string;
  environmentId: string;
  vms: Vm[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState("22");
  const [groupId, setGroupId] = useState("");
  const groupsQuery = useQuery({
    queryKey: ["server-groups", environmentId],
    queryFn: () =>
      apiFetch<Folder[]>(
        `/servers/groups?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    enabled: open,
    staleTime: 30_000,
  });
  const groups = asArray<Folder>(groupsQuery.data).filter(
    (group) => String(group.environment_id || environmentId) === environmentId,
  );
  const importMutation = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        vms.map((vm) =>
          apiFetch(
            `/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/import-vm`,
            {
              method: "POST",
              body: {
                name: vm.name,
                node_name: vm.node_name,
                vm_id: vm.vm_id,
                guest_type: vm.guest_type || "qemu",
                ssh_user: sshUser,
                ssh_port: Number(sshPort),
                group_id: groupId || undefined,
              },
            },
          ),
        ),
      );
      return {
        succeeded: results.filter((result) => result.status === "fulfilled")
          .length,
        failed: results.filter((result) => result.status === "rejected"),
      };
    },
    onSuccess: ({ succeeded, failed }) => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "infrastructure", environmentId],
      });
      if (failed.length)
        showToast(
          `${succeeded} virtual machines adopted; ${failed.length} could not be adopted. Check the VM IP address and duplicate hosts.`,
          "warning",
        );
      else
        showToast(
          `${succeeded} virtual machines were adopted as hosts.`,
          "success",
        );
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCog className="h-5 w-5" />
            Adopt {vms.length} virtual machines into Shipyard
          </DialogTitle>
          <DialogDescription>
            The VMs and CTs remain unchanged in Proxmox. Shipyard only creates
            hosts and reads their reported IPv4 addresses.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/20 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Selection
          </div>
          <div className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-sm">
            {vms.map((vm) => (
              <div key={`${vm.node_name}:${vm.vm_id}`}>
                {vm.node_name} / {vm.vm_id} · {vm.name}
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-import-ssh-user">SSH user</Label>
            <Input
              id="bulk-import-ssh-user"
              required
              value={sshUser}
              onChange={(event) => setSshUser(event.target.value)}
              placeholder="ubuntu"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-import-ssh-port">SSH-Port</Label>
            <Input
              id="bulk-import-ssh-port"
              required
              inputMode="numeric"
              value={sshPort}
              onChange={(event) => setSshPort(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulk-import-folder">Folder</Label>
          <select
            id="bulk-import-folder"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            <option value="">No folder</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
        <p className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          Virtual machines without a reported IPv4 address are skipped. QEMU VMs require
          an enabled Guest Agent for automatic address detection.
          They can later be adopted individually with a manually entered IP.
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={
              importMutation.isPending || !sshUser.trim() || !Number(sshPort)
            }
          >
            {importMutation.isPending ? (
              <RefreshCw className="animate-spin" />
            ) : (
              <ServerCog />
            )}
            Adopt selection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
