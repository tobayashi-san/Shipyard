import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useState,
} from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Layers3,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Settings2,
  Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUi } from "@/lib/store";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useUrlTab } from "@/lib/use-url-tab";

const NETWORK_TABS = ["allocations", "children"] as const;

interface Prefix {
  id: string;
  environment_id: string;
  name: string;
  cidr: string;
  gateway?: string;
  dns_servers?: string[];
  vlan_id?: number | null;
  bridge?: string;
  description?: string;
  status: string;
  role?: string;
  parent_id?: string | null;
  parent_cidr?: string | null;
  child_prefix_count: number;
  usable_address_count: number;
  used_address_count: number;
  free_address_count: number;
  reservation_count: number;
  range_count: number;
  next_free_address?: string | null;
}
interface Reservation {
  id: string;
  address: string;
  hostname?: string;
  server_id?: string;
  server_name?: string;
  mac_address?: string;
  status: string;
  role?: string;
  description?: string;
  source_type?: string;
  source_name?: string | null;
  last_synced_at?: string | null;
  conflict?: boolean;
  conflicts?: string[];
}
interface Allocation extends Partial<Reservation> {
  id: string;
  kind: "address" | "range";
  start_address: string;
  end_address: string;
  address_count: number;
  status: string;
  role?: string;
  description?: string;
}
interface Server {
  id: string;
  name: string;
  ip_address?: string;
}
interface ProxmoxConnection {
  id: string;
  name: string;
}
interface SyncConflict {
  id: string;
  address: string;
  hostname?: string;
  mac_address?: string;
  reason: string;
  last_seen_at?: string;
  source_kind: "external" | "proxmox";
  source_type?: string;
  source_name: string;
  existing_reservation_id?: string;
  existing_address?: string;
  existing_hostname?: string;
  existing_source_type?: string;
  existing_server_id?: string;
  existing_server_name?: string;
}

const statusLabel: Record<string, string> = {
  active: "Active",
  reserved: "Reserved",
  dhcp: "DHCP",
  deprecated: "Deprecated",
  container: "Container",
};
const capacityTone = (usage: number): "healthy" | "warning" | "critical" =>
  usage > 90 ? "critical" : usage > 70 ? "warning" : "healthy";
const statusTone = (status?: string): StatusTone =>
  status === "active"
    ? "success"
    : status === "reserved"
      ? "warning"
      : status === "dhcp"
        ? "info"
        : status === "deprecated"
          ? "muted"
          : "neutral";
const sourceSystemName = (type?: string) =>
  type === "proxmox"
    ? "Proxmox"
    : type === "unifi"
      ? "UniFi"
      : type === "pfsense"
        ? "pfSense"
        : type || "";
function sourceSyncLabel(
  row: Pick<Reservation, "source_type" | "source_name" | "last_synced_at">,
) {
  const system = sourceSystemName(row.source_type);
  if (!system || row.source_type === "manual") return null;
  return `${row.source_name || system}${row.last_synced_at ? ` · ${new Date(row.last_synced_at).toLocaleString()}` : ""}`;
}

export function NetworkDetailPage() {
  const networkTabs = useUrlTab("allocations", NETWORK_TABS);
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const [address, setAddress] = useState("");
  const [hostname, setHostname] = useState("");
  const [description, setDescription] = useState("");
  const [serverId, setServerId] = useState("");
  const [addressStatus, setAddressStatus] = useState("active");
  const [addressRole, setAddressRole] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeDescription, setRangeDescription] = useState("");
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<"address" | "range">("address");
  const [connectionId, setConnectionId] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<Allocation | null>(null);

  const detail = useQuery({
    queryKey: ["ipam", "network", id],
    queryFn: () => apiFetch<Prefix>(`/ipam/subnets/${encodeURIComponent(id)}`),
  });
  const allocations = useQuery({
    queryKey: ["ipam", "allocations", id],
    queryFn: () =>
      apiFetch<Allocation[]>(
        `/ipam/subnets/${encodeURIComponent(id)}/allocations`,
      ),
  });
  const syncConflicts = useQuery({
    queryKey: ["ipam", "conflicts", id],
    queryFn: () =>
      apiFetch<SyncConflict[]>(
        `/ipam/subnets/${encodeURIComponent(id)}/conflicts`,
      ),
  });
  const children = useQuery({
    queryKey: ["ipam", "children", id],
    queryFn: () =>
      apiFetch<Prefix[]>(`/ipam/subnets/${encodeURIComponent(id)}/children`),
  });
  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => apiFetch<Server[]>("/servers"),
  });
  const connections = useQuery({
    queryKey: ["opentofu", "proxmox-connections", environmentId],
    queryFn: () =>
      apiFetch<ProxmoxConnection[]>(
        `/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    retry: false,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["ipam"] });

  const reserve = useMutation({
    mutationFn: () =>
      apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/reservations`, {
        method: "POST",
        body: {
          address,
          hostname,
          description,
          server_id: serverId || undefined,
          status: addressStatus,
          role: addressRole,
        },
      }),
    onSuccess: () => {
      setAddress("");
      setHostname("");
      setDescription("");
      setServerId("");
      setAddOpen(false);
      showToast("IP address created.", "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const reserveRange = useMutation({
    mutationFn: () =>
      apiFetch<{ count: number }>(
        `/ipam/subnets/${encodeURIComponent(id)}/reservations/range`,
        {
          method: "POST",
          body: {
            start_address: rangeStart,
            end_address: rangeEnd,
            description: rangeDescription,
            status: "reserved",
          },
        },
      ),
    onSuccess: (result) => {
      setRangeStart("");
      setRangeEnd("");
      setRangeDescription("");
      setAddOpen(false);
      showToast(`Range with ${result.count} addresses reserved.`, "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const removeReservation = useMutation({
    mutationFn: (reservationId: string) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservationId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("IP address released.", "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const removeRange = useMutation({
    mutationFn: (rangeId: string) =>
      apiFetch(`/ipam/ranges/${encodeURIComponent(rangeId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      showToast("IP range released.", "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const updateReservation = useMutation({
    mutationFn: (reservation: Reservation) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservation.id)}`, {
        method: "PUT",
        body: reservation,
      }),
    onSuccess: () => {
      showToast("IP address saved.", "success");
      setEditing(null);
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const syncProxmox = useMutation({
    mutationFn: () =>
      apiFetch<{
        created: number;
        updated: number;
        conflicts: number;
        failed: number;
      }>(
        `/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/sync-ipam`,
        { method: "POST", body: { subnet_id: id } },
      ),
    onSuccess: (result) => {
      showToast(
        `${result.created} new, ${result.updated} updated IPs${result.conflicts ? ` · ${result.conflicts} conflicts` : ""}`,
        result.failed || result.conflicts ? "warning" : "success",
      );
      setSyncOpen(false);
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const network = detail.data;
  const allocationRows = Array.isArray(allocations.data)
    ? allocations.data
    : [];
  const childRows = Array.isArray(children.data) ? children.data : [];
  const serverRows = Array.isArray(servers.data) ? servers.data : [];
  const connectionRows = Array.isArray(connections.data)
    ? connections.data
    : [];
  const conflictRows = Array.isArray(syncConflicts.data)
    ? syncConflicts.data
    : [];
  if (detail.isPending)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading prefix…
      </div>
    );
  if (detail.isError || !network)
    return (
      <div className="space-y-5">
        <PageHeader
          back={
            <Button variant="ghost" size="icon" asChild>
              <Link to="/networks" aria-label="Back to prefixes">
                <ArrowLeft />
              </Link>
            </Button>
          }
          title="Prefix unavailable"
          description="The requested address space could not be loaded."
        />
        <Card>
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="IPAM prefix could not be loaded"
            description="Check the connection and whether the prefix still exists. No data was changed."
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link to="/networks">Back to prefix overview</Link>
                </Button>
                <Button onClick={() => void detail.refetch()}>
                  <RefreshCw />
                  Try again
                </Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  const usagePercent = network.usable_address_count
    ? Math.round(
        (network.used_address_count / network.usable_address_count) * 100,
      )
    : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        back={
          <Button variant="ghost" size="icon" asChild>
            <Link to="/networks" aria-label="Back to prefixes">
              <ArrowLeft />
            </Link>
          </Button>
        }
        title={network.cidr}
        description={
          <span>
            {network.name}
            {network.description ? ` · ${network.description}` : ""}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <StatusBadge tone={statusTone(network.status)} dot>
              {statusLabel[network.status] || network.status}
            </StatusBadge>
            <Button
              variant="outline"
              size="sm"
              disabled={detail.isFetching || allocations.isFetching}
              onClick={refresh}
            >
              <RefreshCw
                className={
                  detail.isFetching || allocations.isFetching
                    ? "animate-spin"
                    : undefined
                }
              />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setAddKind("address");
                setAddOpen(true);
              }}
            >
              <Plus />
              Reserve address
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConnectionId(connectionRows[0]?.id || "");
                setSyncOpen(true);
              }}
              disabled={connectionRows.length === 0}
              title={
                connections.isError
                  ? "Proxmox connections could not be loaded."
                  : "No Proxmox connection is available in this environment."
              }
            >
              <ServerCog />
              Synchronize Proxmox
            </Button>
          </div>
        }
      />
      {network.parent_id && (
        <Link
          to="/networks/$id"
          params={{ id: network.parent_id }}
          className="inline-flex text-sm text-brand hover:underline"
        >
          Parent prefix: {network.parent_cidr}
        </Link>
      )}
      <section className="console-object-summary overflow-hidden">
        <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
          <div className="console-object-summary-main">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Network className="h-4 w-4 text-brand" />
              Address space
            </div>
            <div className="console-object-info-grid grid-cols-2 lg:grid-cols-4">
              <NetworkFact
                label="Usable IPs"
                value={network.usable_address_count}
                detail={`${network.used_address_count} used`}
              />
              <NetworkFact
                label="Free"
                value={network.free_address_count}
                detail={`${Math.max(0, 100 - usagePercent)}% available`}
                tone="success"
              />
              <NetworkFact
                label="Individual addresses"
                value={network.reservation_count}
                detail="Used or reserved"
              />
              <NetworkFact
                label="Ranges"
                value={network.range_count}
                detail={
                  network.child_prefix_count
                    ? `${network.child_prefix_count} child prefixes`
                    : "No child prefixes"
                }
              />
            </div>
          </div>
          <div className="console-object-capacity">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm font-semibold">
              <span>Address space usage</span>
              <span className="font-mono text-muted-foreground">
                {usagePercent} %
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span>Used</span>
              <span className="font-mono text-muted-foreground">
                {network.used_address_count} / {network.usable_address_count}
              </span>
            </div>
            <div className="console-capacity-track mt-2">
              <span
                data-capacity-tone={capacityTone(usagePercent)}
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Next free IP
              </span>
              {network.next_free_address ? (
                <button
                  type="button"
                  onClick={() => {
                    setAddress(network.next_free_address || "");
                    setAddKind("address");
                    setAddOpen(true);
                  }}
                  className="font-mono text-sm font-medium text-brand hover:underline"
                >
                  {network.next_free_address}
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  None free
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
      <Card>
        <CardHeader className="border-b bg-muted/15 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            Network configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-0 p-0 text-sm sm:grid-cols-2">
          <Info
            label="VLAN / Bridge"
            value={`${network.vlan_id ? `VLAN ${network.vlan_id}` : "—"} · ${network.bridge || "—"}`}
          />
          <Info label="Gateway" value={network.gateway || "—"} />
          <Info
            label="DNS"
            value={(network.dns_servers || []).join(", ") || "—"}
          />
          <Info label="Role" value={network.role || "—"} />
        </CardContent>
      </Card>
      {syncConflicts.isError && (
        <Card className="border-destructive/40">
          <EmptyState
            compact
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Synchronization conflicts could not be loaded"
            description="Existing reservations remain unchanged."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void syncConflicts.refetch()}
              >
                <RefreshCw />
                Try again
              </Button>
            }
          />
        </Card>
      )}
      {conflictRows.length > 0 && <SyncConflictPanel rows={conflictRows} />}
      <Tabs
        value={networkTabs.value}
        onValueChange={networkTabs.onValueChange}
      >
        <TabsList aria-label="Prefix sections" className="console-tabs">
          <TabsTrigger value="allocations">
            Address inventory{" "}
            <Badge variant="secondary">{allocationRows.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="children">
            Child prefixes <Badge variant="secondary">{childRows.length}</Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="allocations">
          {allocations.isError ? (
            <QueryLoadError
              label="Address inventory"
              onRetry={() => void allocations.refetch()}
            />
          ) : (
            <AllocationTable
              rows={allocationRows}
              loading={allocations.isPending}
              onEdit={setEditing}
              onRelease={setReleaseTarget}
              onBulkRelease={async (selected) => {
                await Promise.all(
                  selected.map((row) =>
                    apiFetch(
                      row.kind === "address"
                        ? `/ipam/reservations/${encodeURIComponent(row.id)}`
                        : `/ipam/ranges/${encodeURIComponent(row.id)}`,
                      { method: "DELETE" },
                    ),
                  ),
                );
                showToast(
                  `${selected.length} record${selected.length === 1 ? "" : "s"} released.`,
                  "success",
                );
                refresh();
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="children">
          {children.isError ? (
            <QueryLoadError
              label="Child prefixes"
              onRetry={() => void children.refetch()}
            />
          ) : (
            <ChildPrefixTable rows={childRows} loading={children.isPending} />
          )}
        </TabsContent>
      </Tabs>
      <EditAddressDialog
        reservation={editing}
        servers={serverRows}
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={(value) => updateReservation.mutate(value)}
        saving={updateReservation.isPending}
      />
      <ConfirmDialog
        open={Boolean(releaseTarget)}
        onOpenChange={(open) => !open && setReleaseTarget(null)}
        title={
          releaseTarget?.kind === "range"
            ? "Release IP range?"
            : "Release IP address?"
        }
        description={
          releaseTarget ? (
            <>
              {releaseTarget.kind === "range" ? (
                <>
                  The reserved range{" "}
                  <strong className="font-mono">
                    {releaseTarget.start_address} – {releaseTarget.end_address}
                  </strong>{" "}
                  will be removed from IPAM.
                </>
              ) : (
                <>
                  <strong className="font-mono">
                    {releaseTarget.start_address}
                  </strong>{" "}
                  will be removed from IPAM.
                  {releaseTarget.source_type &&
                  releaseTarget.source_type !== "manual" ? (
                    <span className="mt-2 block">
                      This address comes from{" "}
                      <strong>
                        {sourceSystemName(releaseTarget.source_type)}
                      </strong>
                      . It may be restored by the source during the next sync.
                    </span>
                  ) : null}
                </>
              )}
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Release"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          if (!releaseTarget) return;
          if (releaseTarget.kind === "address")
            removeReservation.mutate(releaseTarget.id);
          else removeRange.mutate(releaseTarget.id);
        }}
        isPending={removeReservation.isPending || removeRange.isPending}
      />
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Reserve address space</DialogTitle>
            <DialogDescription>
              Add a single address or reserve a contiguous range. Detail fields
              remain in the selected form.
            </DialogDescription>
          </DialogHeader>
          <div className="inline-flex w-fit rounded-md border bg-muted/30 p-0.5">
            <Button
              type="button"
              size="sm"
              variant={addKind === "address" ? "secondary" : "ghost"}
              onClick={() => setAddKind("address")}
            >
              Single address
            </Button>
            <Button
              type="button"
              size="sm"
              variant={addKind === "range" ? "secondary" : "ghost"}
              onClick={() => setAddKind("range")}
            >
              Range
            </Button>
          </div>
          {addKind === "address" ? (
            <AddressForm
              address={address}
              hostname={hostname}
              description={description}
              serverId={serverId}
              status={addressStatus}
              role={addressRole}
              servers={serverRows}
              submitting={reserve.isPending}
              onAddress={setAddress}
              onHostname={setHostname}
              onDescription={setDescription}
              onServer={setServerId}
              onStatus={setAddressStatus}
              onRole={setAddressRole}
              onSubmit={() => reserve.mutate()}
            />
          ) : (
            <RangeForm
              start={rangeStart}
              end={rangeEnd}
              description={rangeDescription}
              submitting={reserveRange.isPending}
              onStart={setRangeStart}
              onEnd={setRangeEnd}
              onDescription={setRangeDescription}
              onSubmit={() => reserveRange.mutate()}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Synchronize Proxmox IP addresses</DialogTitle>
            <DialogDescription>
              Guest addresses are read from the QEMU Guest Agent. Manually
              managed records and ranges remain unchanged.
            </DialogDescription>
          </DialogHeader>
          <select
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            {connectionRows.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => syncProxmox.mutate()}
              disabled={!connectionId || syncProxmox.isPending}
            >
              {syncProxmox.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <ServerCog />
              )}
              Synchronize
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QueryLoadError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <EmptyState
        compact
        icon={<AlertTriangle className="h-5 w-5" />}
        title={`${label} could not be loaded`}
        description="IPAM data is currently unavailable. No changes were made."
        action={
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw />
            Try again
          </Button>
        }
      />
    </Card>
  );
}

function ChildPrefixTable({
  rows,
  loading = false,
}: {
  rows: Prefix[];
  loading?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;
  const updateStatus = useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: string }) =>
      Promise.all(
        ids.map((id) =>
          apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/status`, {
            method: "PATCH",
            body: { status },
          }),
        ),
      ),
    onSuccess: (_result, variables) => {
      setSelected(new Set());
      showToast(
        `${variables.ids.length} child prefix${variables.ids.length === 1 ? "" : "es"} updated.`,
        "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) =>
      showToast(
        error.message || "Status could not be updated.",
        "error",
      ),
  });
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/15 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Box className="h-4 w-4" />
            Child prefixes
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Direkt untergeordnete Netzbereiche dieses Prefixes.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {selectedRows.length > 0 && (
            <>
              <span className="whitespace-nowrap text-xs font-medium tabular-nums">
                {selectedRows.length} selected
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={updateStatus.isPending}
                onClick={() =>
                  updateStatus.mutate({
                    ids: selectedRows.map((row) => row.id),
                    status: "active",
                  })
                }
              >
                Active
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={updateStatus.isPending}
                onClick={() =>
                  updateStatus.mutate({
                    ids: selectedRows.map((row) => row.id),
                    status: "reserved",
                  })
                }
              >
                Reserved
              </Button>
            </>
          )}
          <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {rows.length}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <EmptyState compact title="Loading child prefixes…" />
        ) : rows.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            No direct child prefixes.
          </p>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {rows.map((child) => (
                <div
                  key={child.id}
                  className="flex gap-3 p-4"
                  data-selected={selected.has(child.id) || undefined}
                >
                  <input
                    className="mt-1"
                    type="checkbox"
                    aria-label={`Select ${child.cidr}`}
                    checked={selected.has(child.id)}
                    onChange={() => toggle(child.id)}
                  />
                  <Link
                    to="/networks/$id"
                    params={{ id: child.id }}
                    className="min-w-0 flex-1 transition-colors hover:text-primary"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono font-medium">
                          <Box className="h-4 w-4 shrink-0 text-brand" />
                          {child.cidr}
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {child.name ||
                            child.description ||
                            "No description"}
                        </p>
                      </div>
                      <StatusBadge tone={statusTone(child.status)} dot>
                        {statusLabel[child.status] || child.status}
                      </StatusBadge>
                    </div>
                    <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                      <span>
                        {child.vlan_id ? `VLAN ${child.vlan_id}` : "No VLAN"}{" "}
                        ·{" "}
                        <span className="font-mono">{child.bridge || "—"}</span>
                      </span>
                      <span>{child.free_address_count} free</span>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                data-density="compact"
                className="w-full min-w-[760px] text-sm"
              >
                <thead>
                  <tr>
                    <th className="w-11 px-3">
                      <input
                        type="checkbox"
                        aria-label="Select all child prefixes"
                        checked={allSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = someSelected;
                        }}
                        onChange={() =>
                          setSelected(
                            allSelected
                              ? new Set()
                              : new Set(rows.map((row) => row.id)),
                          )
                        }
                      />
                    </th>
                    <th className="px-3">Prefix</th>
                    <th className="px-3">Status</th>
                    <th className="px-3">VLAN / Bridge</th>
                    <th className="px-3">Free</th>
                    <th className="px-3">Description</th>
                    <th className="w-20 px-3 text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((child) => (
                    <tr
                      key={child.id}
                      data-selected={selected.has(child.id) || undefined}
                    >
                      <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${child.cidr}`}
                          checked={selected.has(child.id)}
                          onChange={() => toggle(child.id)}
                        />
                      </td>
                      <td className="px-3">
                        <Link
                          to="/networks/$id"
                          params={{ id: child.id }}
                          className="flex items-center gap-2 font-mono font-medium hover:text-primary hover:underline"
                        >
                          <Box className="h-4 w-4 text-brand" />
                          {child.cidr}
                        </Link>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {child.name || "Unnamed"}
                        </div>
                      </td>
                      <td className="px-3">
                        <StatusBadge tone={statusTone(child.status)} dot>
                          {statusLabel[child.status] || child.status}
                        </StatusBadge>
                      </td>
                      <td className="px-3">
                        {child.vlan_id ? `VLAN ${child.vlan_id}` : "—"}{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          {child.bridge || "—"}
                        </span>
                      </td>
                      <td className="px-3 font-mono">
                        {child.free_address_count}
                      </td>
                      <td className="max-w-[20rem] px-3">
                        <span className="block truncate text-muted-foreground">
                          {child.description || "—"}
                        </span>
                      </td>
                      <td className="px-3 text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link to="/networks/$id" params={{ id: child.id }}>
                            Open
                          </Link>
                        </Button>
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

function AllocationTable({
  rows,
  loading = false,
  onEdit,
  onRelease,
  onBulkRelease,
}: {
  rows: Allocation[];
  loading?: boolean;
  onEdit: (row: Reservation) => void;
  onRelease: (row: Allocation) => void;
  onBulkRelease: (rows: Allocation[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const keyFor = (row: Allocation) => `${row.kind}:${row.id}`;
  const visibleRows = rows.filter((row) => {
    const needle = search.trim().toLowerCase();
    const searchable = [
      row.start_address,
      row.end_address,
      row.hostname,
      row.server_name,
      row.description,
      row.role,
      row.source_type,
      row.status,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      (!needle || searchable.includes(needle)) &&
      (statusFilter === "all" || row.status === statusFilter)
    );
  });
  const selectedRows = visibleRows.filter((row) => selected.has(keyFor(row)));
  const allSelected =
    visibleRows.length > 0 && selectedRows.length === visibleRows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;
  const toggle = (row: Allocation) =>
    setSelected((current) => {
      const next = new Set(current);
      const key = keyFor(row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const releaseSelected = async () => {
    setReleasing(true);
    try {
      await onBulkRelease(selectedRows);
      setSelected(new Set());
      setConfirmRelease(false);
    } catch (error) {
      showToast(
        (error as Error).message ||
          "Records could not be released.",
        "error",
      );
    } finally {
      setReleasing(false);
    }
  };
  return (
    <Card>
      <CardHeader className="gap-0 border-b p-0">
        <div className="console-toolbar gap-3 border-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" />
              Used and reserved addresses
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              Individual addresses and ranges in ascending IP order.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 min-w-[190px] flex-1 lg:w-56"
              placeholder="Search address, host, or source…"
              aria-label="Search address space"
            />
            <Button
              type="button"
              size="sm"
              variant={statusFilter !== "all" ? "secondary" : "outline"}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Settings2 />
              Filter{statusFilter !== "all" ? ": 1" : ""}
            </Button>
            {selectedRows.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setConfirmRelease(true)}
              >
                <Trash2 />
                Release {selectedRows.length}
              </Button>
            )}
          </div>
        </div>
        {filtersOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-background/60 px-4 py-2.5">
            <Label
              htmlFor="allocation-status-filter"
              className="text-xs text-muted-foreground"
            >
              Status
            </Label>
            <select
              id="allocation-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="Adressstatus filtern"
            >
              <option value="all">All statuses</option>
              {Object.entries(statusLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {statusFilter !== "all" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setStatusFilter("all")}
              >
                Reset
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <EmptyState compact title="Loading address inventory…" />
        ) : rows.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            This prefix has no used addresses or ranges yet.
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            No records match the current search or
            Statusfilter.
          </p>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {visibleRows.map((row) => (
                <AllocationMobileRow
                  key={keyFor(row)}
                  row={row}
                  checked={selected.has(keyFor(row))}
                  onToggle={() => toggle(row)}
                  onEdit={onEdit}
                  onRelease={onRelease}
                />
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                className="w-full min-w-[820px] text-sm"
                data-density="compact"
              >
                <thead>
                  <tr>
                    <th className="w-11 px-3">
                      <input
                        type="checkbox"
                        aria-label="Select all visible address-space records"
                        checked={allSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = someSelected;
                        }}
                        onChange={() =>
                          setSelected(
                            allSelected
                              ? new Set()
                              : new Set(visibleRows.map(keyFor)),
                          )
                        }
                      />
                    </th>
                    <th className="px-3">Address / range</th>
                    <th className="px-3">Type</th>
                    <th className="px-3">Status</th>
                    <th className="px-3">Assigned to</th>
                    <th className="px-3">Description</th>
                    <th className="w-24 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const isAddress = row.kind === "address";
                    const label = isAddress
                      ? row.start_address
                      : `${row.start_address} – ${row.end_address}`;
                    const checked = selected.has(keyFor(row));
                    const conflicts = isAddress ? row.conflicts || [] : [];
                    const sourceLabel = isAddress ? sourceSyncLabel(row) : null;
                    return (
                      <tr
                        key={keyFor(row)}
                        data-selected={checked || undefined}
                      >
                        <td className="px-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${label}`}
                            checked={checked}
                            onChange={() => toggle(row)}
                          />
                        </td>
                        <td className="px-3">
                          <span className="font-mono font-medium">{label}</span>
                          {!isAddress && (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {row.address_count} addresses
                            </div>
                          )}
                          {sourceLabel && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              Synchronized from {sourceLabel}
                            </div>
                          )}
                        </td>
                        <td className="px-3">
                          <Badge variant="outline" className="w-fit">
                            {isAddress ? "Single IP" : "Range"}
                          </Badge>
                        </td>
                        <td className="px-3">
                          <div className="flex flex-wrap items-center gap-1">
                            <StatusBadge tone={statusTone(row.status)} dot>
                              {statusLabel[row.status] || row.status}
                            </StatusBadge>
                            {conflicts.length > 0 && (
                              <span
                                title={conflicts.join(" · ")}
                                className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                Conflict
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="max-w-[180px] px-3">
                          {isAddress && row.server_id ? (
                            <Link
                              to="/servers/$id"
                              params={{ id: row.server_id }}
                              className="block truncate font-medium text-primary hover:underline"
                            >
                              {row.server_name ||
                                row.hostname ||
                                "Open Fleet host"}
                            </Link>
                          ) : (
                            <span className="block truncate">
                              {isAddress
                                ? row.server_name || row.hostname || "—"
                                : row.role || "—"}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[240px] px-3">
                          <span className="block truncate text-muted-foreground">
                            {conflicts.length
                              ? conflicts.join(" · ")
                              : row.description || "—"}
                          </span>
                        </td>
                        <td className="px-3">
                          <div className="flex justify-end gap-1">
                            {isAddress && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => onEdit(row as Reservation)}
                                aria-label={`Edit ${row.start_address}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => onRelease(row)}
                              aria-label={`Release ${label}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        title="Release selected records?"
        description={
          <>
            You are releasing <strong>{selectedRows.length}</strong> reserved
            {selectedRows.length === 1 ? " address or range" : " addresses or ranges"}.
            This action cannot be undone.
            {selectedRows.some(
              (row) =>
                row.kind === "address" &&
                row.source_type &&
                row.source_type !== "manual",
            ) ? (
              <span className="mt-2 block">
                Some selected addresses are managed by external sources. They
                may be restored during the next synchronization.
              </span>
            ) : null}
          </>
        }
        confirmLabel="Release"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={releaseSelected}
        isPending={releasing}
      />
    </Card>
  );
}

function AllocationMobileRow({
  row,
  checked,
  onToggle,
  onEdit,
  onRelease,
}: {
  row: Allocation;
  checked: boolean;
  onToggle: () => void;
  onEdit: (row: Reservation) => void;
  onRelease: (row: Allocation) => void;
}) {
  const isAddress = row.kind === "address";
  const label = isAddress
    ? row.start_address
    : `${row.start_address} – ${row.end_address}`;
  const conflicts = isAddress ? row.conflicts || [] : [];
  const sourceLabel = isAddress ? sourceSyncLabel(row) : null;
  return (
    <div className="space-y-3 p-4" data-selected={checked || undefined}>
      <div className="flex items-start gap-3">
        <input
          className="mt-1"
          type="checkbox"
          aria-label={`Select ${label}`}
          checked={checked}
          onChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">{label}</span>
            <Badge variant="outline">
              {isAddress ? "Single IP" : "Range"}
            </Badge>
            {conflicts.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                <AlertTriangle className="h-3 w-3" />
                Conflict
              </span>
            )}
          </div>
          {!isAddress && (
            <p className="mt-1 text-xs text-muted-foreground">
              {row.address_count} addresses
            </p>
          )}
          {sourceLabel && (
            <p className="mt-1 text-xs text-muted-foreground">
              Synchronized from {sourceLabel}
            </p>
          )}
        </div>
        <StatusBadge tone={statusTone(row.status)} dot>
          {statusLabel[row.status] || row.status}
        </StatusBadge>
      </div>
      <div className="ml-7 grid gap-1 text-xs">
        <span className="text-muted-foreground">
          Assigned to:{" "}
          {isAddress && row.server_id ? (
            <Link
              to="/servers/$id"
              params={{ id: row.server_id }}
              className="font-medium text-primary hover:underline"
            >
              {row.server_name || row.hostname || "Open Fleet host"}
            </Link>
          ) : (
            <span className="text-foreground">
              {isAddress
                ? row.server_name || row.hostname || "—"
                : row.role || "—"}
            </span>
          )}
        </span>
        {(conflicts.length > 0 || row.description) && (
          <span className="text-muted-foreground">
            {conflicts.length ? conflicts.join(" · ") : row.description}
          </span>
        )}
      </div>
      <div className="ml-7 flex gap-2">
        {isAddress && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(row as Reservation)}
          >
            <Pencil />
            Edit
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => onRelease(row)}
        >
          <Trash2 />
          Freigeben
        </Button>
      </div>
    </div>
  );
}

function SyncConflictPanel({ rows }: { rows: SyncConflict[] }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader className="border-b bg-destructive/[0.04] py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Synchronization conflicts{" "}
          <Badge variant="destructive">{rows.length}</Badge>
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Fleet left the existing IPAM assignment unchanged. Check the source
          or correct the existing address before trying again
          synchronisierst.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y md:hidden">
          {rows.map((row) => (
            <div
              key={`${row.source_kind}:${row.id}`}
              className="space-y-1.5 p-4 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono font-medium">{row.address}</span>
                <Badge variant="outline">{row.source_name}</Badge>
              </div>
              <p className="text-muted-foreground">
                Observed: {row.hostname || "no hostname"}
              </p>
              <p className="text-muted-foreground">
                Bestehend:{" "}
                {row.existing_server_id ? (
                  <Link
                    to="/servers/$id"
                    params={{ id: row.existing_server_id }}
                    className="font-medium text-primary hover:underline"
                  >
                    {row.existing_server_name ||
                      row.existing_hostname ||
                      row.existing_address}
                  </Link>
                ) : (
                  row.existing_hostname ||
                  row.existing_address ||
                  "no longer present"
                )}
              </p>
              <p className="text-destructive">{row.reason}</p>
            </div>
          ))}
        </div>
        <div className="table-scroll hidden md:block">
          <table
            className="w-full min-w-[760px] text-sm"
            data-density="compact"
          >
            <thead>
              <tr>
                <th className="px-3">Address</th>
                <th className="px-3">Source</th>
                <th className="px-3">Beobachtet</th>
                <th className="px-3">Existing assignment</th>
                <th className="px-3">Grund</th>
                <th className="px-3">Zuletzt gesehen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source_kind}:${row.id}`}>
                  <td className="px-3 font-mono font-medium">{row.address}</td>
                  <td className="px-3">
                    <span className="font-medium">{row.source_name}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {sourceSystemName(row.source_type)}
                    </span>
                  </td>
                  <td className="px-3">{row.hostname || "—"}</td>
                  <td className="px-3">
                    {row.existing_server_id ? (
                      <Link
                        to="/servers/$id"
                        params={{ id: row.existing_server_id }}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.existing_server_name ||
                          row.existing_hostname ||
                          row.existing_address}
                      </Link>
                    ) : (
                      row.existing_hostname ||
                      row.existing_address ||
                      "No longer present"
                    )}
                  </td>
                  <td className="max-w-[24rem] px-3">
                    <span
                      className="block truncate text-destructive"
                      title={row.reason}
                    >
                      {row.reason}
                    </span>
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">
                    {row.last_seen_at
                      ? new Date(row.last_seen_at).toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function AddressForm({
  address,
  hostname,
  description,
  serverId,
  status,
  role,
  servers,
  submitting,
  onAddress,
  onHostname,
  onDescription,
  onServer,
  onStatus,
  onRole,
  onSubmit,
}: {
  address: string;
  hostname: string;
  description: string;
  serverId: string;
  status: string;
  role: string;
  servers: Server[];
  submitting: boolean;
  onAddress: (value: string) => void;
  onHostname: (value: string) => void;
  onDescription: (value: string) => void;
  onServer: (value: string) => void;
  onStatus: (value: string) => void;
  onRole: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="IP address">
          <Input
            required
            autoFocus
            value={address}
            onChange={(event) => onAddress(event.target.value)}
            placeholder="10.20.10.25"
            inputMode="decimal"
          />
        </Field>
        <Field label="Hostname">
          <Input
            value={hostname}
            onChange={(event) => onHostname(event.target.value)}
            placeholder="z. B. app-01"
          />
        </Field>
        <Field label="Status">
          <select
            value={status}
            onChange={(event) => onStatus(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            <option value="active">Active</option>
            <option value="reserved">Reserved</option>
            <option value="dhcp">DHCP</option>
            <option value="deprecated">Deprecated</option>
          </select>
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(event) => onRole(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            <option value="">No role</option>
            <option value="gateway">Gateway</option>
            <option value="vip">VIP</option>
            <option value="secondary">Secondary</option>
            <option value="loopback">Loopback</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Fleet-Host">
            <select
              value={serverId}
              onChange={(event) => onServer(event.target.value)}
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="">Not assigned</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                  {server.ip_address ? ` · ${server.ip_address}` : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description">
            <Input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder="Purpose, service, or owner"
            />
          </Field>
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={submitting}>
          <Plus />
          Add IP address
        </Button>
      </DialogFooter>
    </form>
  );
}

function RangeForm({
  start,
  end,
  description,
  submitting,
  onStart,
  onEnd,
  onDescription,
  onSubmit,
}: {
  start: string;
  end: string;
  description: string;
  submitting: boolean;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
  onDescription: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First address">
          <Input
            required
            autoFocus
            value={start}
            onChange={(event) => onStart(event.target.value)}
            placeholder="10.20.10.100"
            inputMode="decimal"
          />
        </Field>
        <Field label="Last address">
          <Input
            required
            value={end}
            onChange={(event) => onEnd(event.target.value)}
            placeholder="10.20.10.150"
            inputMode="decimal"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <Input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder="e.g. DHCP pool, printers, or reserve"
            />
          </Field>
        </div>
      </div>
      <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        The range is managed as one IPAM object and appears together with
        individual addresses in the address space.
      </p>
      <DialogFooter>
        <Button type="submit" variant="secondary" disabled={submitting}>
          <Plus />
          Reserve range
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditAddressDialog({
  reservation,
  servers,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  reservation: Reservation | null;
  servers: Server[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (reservation: Reservation) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState<Reservation | null>(reservation);
  useEffect(() => {
    setValue(reservation);
  }, [reservation]);
  if (!value) return null;
  const sourceName = sourceSystemName(value.source_type);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit IP address</DialogTitle>
          <DialogDescription>
            Change the core data, assignment, and status of this address.
          </DialogDescription>
        </DialogHeader>
        {sourceName && value.source_type !== "manual" ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
            <strong>Synchronized from {sourceName}.</strong>
            <span className="mt-1 block text-muted-foreground">
              Hostname, MAC address, status, and description may be updated by
              the source during the next synchronization. Maintain these values
              permanently in the source.
            </span>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="IP address">
            <Input
              value={value.address}
              onChange={(event) =>
                setValue({ ...value, address: event.target.value })
              }
            />
          </Field>
          <Field label="Status">
            <select
              value={value.status}
              onChange={(event) =>
                setValue({ ...value, status: event.target.value })
              }
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="active">Active</option>
              <option value="reserved">Reserved</option>
              <option value="dhcp">DHCP</option>
              <option value="deprecated">Deprecated</option>
            </select>
          </Field>
          <Field label="Hostname">
            <Input
              value={value.hostname || ""}
              onChange={(event) =>
                setValue({ ...value, hostname: event.target.value })
              }
              placeholder="app-01"
            />
          </Field>
          <Field label="MAC address">
            <Input
              value={value.mac_address || ""}
              onChange={(event) =>
                setValue({ ...value, mac_address: event.target.value })
              }
              placeholder="52:54:00:12:34:56"
            />
          </Field>
          <Field label="Role">
            <select
              value={value.role || ""}
              onChange={(event) =>
                setValue({ ...value, role: event.target.value })
              }
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="">No role</option>
              <option value="gateway">Gateway</option>
              <option value="vip">VIP</option>
              <option value="secondary">Secondary</option>
              <option value="loopback">Loopback</option>
            </select>
          </Field>
          <Field label="Fleet-Host">
            <select
              value={value.server_id || ""}
              onChange={(event) =>
                setValue({
                  ...value,
                  server_id: event.target.value || undefined,
                })
              }
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="">Not assigned</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input
                value={value.description || ""}
                onChange={(event) =>
                  setValue({ ...value, description: event.target.value })
                }
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(value)} disabled={saving}>
            <Pencil />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children)
    ? cloneElement(children, { id: children.props.id || generatedId })
    : children;
  const controlId = isValidElement<{ id?: string }>(child)
    ? child.props.id
    : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={controlId}>{label}</Label>
      {child}
    </div>
  );
}
function NetworkFact({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "success";
}) {
  return (
    <div className="console-object-info">
      <div>{label}</div>
      <div
        className={
          tone === "success" ? "[color:hsl(var(--success))]" : undefined
        }
      >
        {value}
      </div>
      <p>{detail}</p>
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b p-4 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-child(odd)]:border-r">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-mono text-sm font-medium">
        {value}
      </div>
    </div>
  );
}
