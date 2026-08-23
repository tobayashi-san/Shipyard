import {
  cloneElement,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Layers3,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Settings2,
  Tag,
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
import { TablePagination } from "@/components/ui/table-pagination";
import { ActiveFilterChips } from "@/components/ui/filter-chips";
import i18n from "@/lib/i18n";
import { hasCap, useProfile } from "@/lib/queries";

const NETWORK_TABS = ["allocations", "children"] as const;

interface Prefix {
  id: string;
  environment_id: string;
  name: string;
  cidr: string;
  gateway?: string;
  dhcp_start?: string;
  dhcp_end?: string;
  dhcp_address_count?: number;
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
  device_name?: string;
  status: string;
  configured_status?: string;
  role?: string;
  description?: string;
  source_type?: string;
  source_name?: string | null;
  last_synced_at?: string | null;
  conflict?: boolean;
  conflicts?: string[];
  observed_sources?: string[];
  source_observations?: SourceObservation[];
}
interface SourceObservation {
  name: string;
  type: string;
  last_seen_at?: string | null;
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
  system_managed?: boolean;
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
interface Paginated<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  free_segments?: FreeSpaceSegment[];
}
interface FreeSpaceSegment {
  start_address: string;
  end_address: string;
  address_count: number;
  before_allocation_key: string | null;
}

const tr = (key: string, options?: Record<string, unknown>) =>
  String(i18n.t(`ipam.${key}`, options));

const statusLabel: Record<string, string> = {
  active: tr("active"),
  reserved: tr("reserved"),
  dhcp: tr("dhcp"),
  deprecated: tr("deprecated"),
  container: tr("container"),
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
        : type === "system"
          ? "System"
        : type || "";

export function NetworkDetailPage() {
  const networkTabs = useUrlTab("allocations", NETWORK_TABS);
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const canEdit = hasCap(profile, "canEditServers");
  const [address, setAddress] = useState("");
  const [hostname, setHostname] = useState("");
  const [macAddress, setMacAddress] = useState("");
  const [description, setDescription] = useState("");
  const [serverId, setServerId] = useState("");
  const [addressStatus, setAddressStatus] = useState("active");
  const [addressRole, setAddressRole] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeDescription, setRangeDescription] = useState("");
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [naming, setNaming] = useState<Reservation | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<"address" | "range">("address");
  const [connectionId, setConnectionId] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<Allocation | null>(null);
  const [editPrefixOpen, setEditPrefixOpen] = useState(false);
  const [deletePrefixOpen, setDeletePrefixOpen] = useState(false);
  const [allocationPage, setAllocationPage] = useState(1);
  const [allocationSearch, setAllocationSearch] = useState("");
  const [allocationStatus, setAllocationStatus] = useState("all");
  const allocationPageSize = 50;

  const detail = useQuery({
    queryKey: ["ipam", "network", id],
    queryFn: () => apiFetch<Prefix>(`/ipam/subnets/${encodeURIComponent(id)}`),
  });
  const allocations = useQuery({
    queryKey: ["ipam", "allocations", id, allocationPage, allocationSearch, allocationStatus],
    queryFn: () =>
      apiFetch<Paginated<Allocation>>(
        `/ipam/subnets/${encodeURIComponent(id)}/allocations?paginated=1&page=${allocationPage}&page_size=${allocationPageSize}&q=${encodeURIComponent(allocationSearch)}&status=${encodeURIComponent(allocationStatus)}`,
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
    queryKey: ["servers", environmentId],
    queryFn: () => apiFetch<Server[]>(`/servers?environment_id=${encodeURIComponent(environmentId)}`),
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
  const openAddressReservation = (nextAddress = "") => {
    setAddress(nextAddress);
    setHostname("");
    setMacAddress("");
    setDescription("");
    setServerId("");
    setAddressStatus("active");
    setAddressRole("");
    setAddKind("address");
    setAddOpen(true);
  };
  const openRangeReservation = (segment: FreeSpaceSegment) => {
    setRangeStart(segment.start_address);
    setRangeEnd(segment.end_address);
    setRangeDescription("");
    setAddKind("range");
    setAddOpen(true);
  };

  const reserve = useMutation({
    mutationFn: () =>
      apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/reservations`, {
        method: "POST",
        body: {
          address,
          hostname,
          mac_address: macAddress,
          description,
          server_id: serverId || undefined,
          status: addressStatus,
          role: addressRole,
        },
      }),
    onSuccess: () => {
      setAddress("");
      setHostname("");
      setMacAddress("");
      setDescription("");
      setServerId("");
      setAddOpen(false);
      showToast(tr("ipCreated"), "success");
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
      showToast(tr("rangeReserved", { count: result.count }), "success");
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
      showToast(tr("ipReleased"), "success");
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
      showToast(tr("rangeReleased"), "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const updateReservation = useMutation({
    mutationFn: (reservation: Reservation) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservation.id)}`, {
        method: "PUT",
        body: {
          ...reservation,
          status:
            reservation.configured_status ||
            (reservation.status === "dhcp" ? "active" : reservation.status),
        },
      }),
    onSuccess: () => {
      showToast(tr("ipSaved"), "success");
      setEditing(null);
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const updateDeviceName = useMutation({
    mutationFn: ({ reservation, name }: { reservation: Reservation; name: string }) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservation.id)}/device-name`, {
        method: "PATCH",
        body: { name },
      }),
    onSuccess: () => {
      showToast(tr("deviceNameSaved"), "success");
      setNaming(null);
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const updatePrefix = useMutation({
    mutationFn: (value: Partial<Prefix>) =>
      apiFetch(`/ipam/subnets/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: value,
      }),
    onSuccess: () => {
      setEditPrefixOpen(false);
      showToast(tr("prefixSaved"), "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const deletePrefix = useMutation({
    mutationFn: () => apiFetch(`/ipam/subnets/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeletePrefixOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["ipam"] });
      showToast(tr("prefixDeleted"), "success");
      await navigate({ to: "/networks" });
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
        tr("proxmoxSyncResult", {
          created: result.created,
          updated: result.updated,
          conflicts: result.conflicts ? tr("conflictsSuffix", { count: result.conflicts }) : "",
        }),
        result.failed || result.conflicts ? "warning" : "success",
      );
      setSyncOpen(false);
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const network = detail.data;
  const allocationRows = Array.isArray(allocations.data?.items)
    ? allocations.data.items
    : [];
  const freeSegments = Array.isArray(allocations.data?.free_segments)
    ? allocations.data.free_segments
    : [];
  const childRows = Array.isArray(children.data) ? children.data : [];
  const serverRows = Array.isArray(servers.data) ? servers.data : [];
  const connectionRows = Array.isArray(connections.data)
    ? connections.data
    : [];
  const conflictRows = Array.isArray(syncConflicts.data)
    ? syncConflicts.data
    : [];
  useEffect(() => {
    setAllocationPage(1);
  }, [allocationSearch, allocationStatus, id]);
  useEffect(() => {
    if (allocations.data && allocationPage > allocations.data.total_pages)
      setAllocationPage(allocations.data.total_pages);
  }, [allocationPage, allocations.data]);
  if (detail.isPending)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {tr("loadingPrefix")}
      </div>
    );
  if (detail.isError || !network)
    return (
      <div className="space-y-5">
        <PageHeader
          back={
            <Button variant="ghost" size="icon" asChild>
              <Link to="/networks" aria-label={tr("backPrefixes")}>
                <ArrowLeft />
              </Link>
            </Button>
          }
          title={tr("prefixUnavailable")}
          description={tr("prefixUnavailableDescription")}
        />
        <Card>
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={tr("prefixLoadFailed")}
            description={tr("prefixLoadFailedDescription")}
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link to="/networks">{tr("backOverview")}</Link>
                </Button>
                <Button onClick={() => void detail.refetch()}>
                  <RefreshCw />
                  {tr("tryAgain")}
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
            <Link to="/networks" aria-label={tr("backPrefixes")}>
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
          <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
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
              {tr("refresh")}
            </Button>
            {canEdit && <Button
              size="sm"
              onClick={() => {
                openAddressReservation();
              }}
            >
              <Plus />
              {tr("reserveAddress")}
            </Button>}
            {canEdit && <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConnectionId(connectionRows[0]?.id || "");
                setSyncOpen(true);
              }}
              disabled={connectionRows.length === 0}
              title={
                connections.isError
                  ? tr("proxmoxConnectionsFailed")
                  : tr("noProxmoxConnection")
              }
            >
              <ServerCog />
              {tr("syncProxmox")}
            </Button>}
            {canEdit && <Button variant="outline" size="sm" onClick={() => setEditPrefixOpen(true)}>
              <Pencil />
              {tr("editPrefix")}
            </Button>}
            {canEdit && <Button variant="outline" size="sm" onClick={() => setDeletePrefixOpen(true)}>
              <Trash2 className="text-destructive" />
              {tr("delete")}
            </Button>}
          </div>
        }
      />
      {network.parent_id && (
        <Link
          to="/networks/$id"
          params={{ id: network.parent_id }}
          className="inline-flex text-sm text-brand hover:underline"
        >
          {tr("parentPrefix", { cidr: network.parent_cidr })}
        </Link>
      )}
      <section className="console-object-summary overflow-hidden">
        <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)]">
          <div className="console-object-summary-main !py-2.5">
            <div className="flex items-center gap-2 border-b pb-2.5 text-sm font-semibold">
              <Network className="h-4 w-4 text-brand" />
              {tr("addressSpace")}
            </div>
            <div className="console-object-info-grid grid-cols-2 lg:grid-cols-4">
              <NetworkFact
                label={tr("usableIps")}
                value={network.usable_address_count}
                detail={tr("assignedCount", { count: network.used_address_count })}
              />
              <NetworkFact
                label={tr("free")}
                value={network.free_address_count}
                detail={tr("availablePercent", { count: Math.max(0, 100 - usagePercent) })}
                tone="success"
              />
              <NetworkFact
                label={tr("individualAddresses")}
                value={network.reservation_count}
                detail={tr("usedOrReserved")}
              />
              <NetworkFact
                label={tr("ranges")}
                value={network.range_count}
                detail={
                  network.child_prefix_count
                    ? tr("childCount", { count: network.child_prefix_count })
                    : tr("noChildren")
                }
              />
            </div>
          </div>
          <div className="console-object-capacity border-t !py-2.5 xl:border-l xl:border-t-0">
            <div className="flex items-center justify-between gap-3 border-b pb-2.5 text-sm font-semibold">
              <span>{tr("usage")}</span>
              <span className="font-mono text-muted-foreground">
                {usagePercent} %
              </span>
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-3 text-xs">
              <span>{tr("used")}</span>
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
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {tr("nextFree")}
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
                  {tr("noneFree")}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
      <Card>
        <CardHeader className="border-b px-3 py-2.5">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="h-4 w-4" />
            {tr("networkConfiguration")}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-px bg-border p-0 text-sm sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Info
            label={tr("vlanBridge")}
            value={`${network.vlan_id ? `VLAN ${network.vlan_id}` : "—"} · ${network.bridge || "—"}`}
          />
          <Info label={tr("gateway")} value={network.gateway || "—"} />
          <Info
            label={tr("dhcpRange")}
            value={
              network.dhcp_start && network.dhcp_end
                ? `${network.dhcp_start} – ${network.dhcp_end} (${tr("dhcpPoolCount", { count: network.dhcp_address_count || 0 })})`
                : tr("dhcpNotConfigured")
            }
          />
          <Info
            label={tr("dns")}
            value={(network.dns_servers || []).join(", ") || "—"}
          />
          <Info label={tr("role")} value={network.role || "—"} />
          <Info
            label={tr("descriptionLabel")}
            value={network.description || "—"}
          />
        </CardContent>
      </Card>
      {syncConflicts.isError && (
        <Card className="border-destructive/40">
          <EmptyState
            compact
            icon={<AlertTriangle className="h-5 w-5" />}
            title={tr("syncConflictLoadFailed")}
            description={tr("unchangedReservations")}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void syncConflicts.refetch()}
              >
                <RefreshCw />
                {tr("tryAgain")}
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
        <TabsList aria-label={tr("prefixSections")} className="console-tabs">
          <TabsTrigger value="allocations">
            {tr("addressInventory")}{" "}
            <Badge variant="secondary">{allocations.data?.total || 0}</Badge>
          </TabsTrigger>
          <TabsTrigger value="children">
            {tr("childPrefixes")} <Badge variant="secondary">{childRows.length}</Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="allocations">
          {allocations.isError ? (
            <QueryLoadError
              label={tr("addressInventory")}
              onRetry={() => void allocations.refetch()}
            />
          ) : (
            <AllocationTable
              rows={allocationRows}
              freeSegments={freeSegments}
              loading={allocations.isPending}
              page={allocationPage}
              pageSize={allocationPageSize}
              total={allocations.data?.total || 0}
              search={allocationSearch}
              statusFilter={allocationStatus}
              canEdit={canEdit}
              onPage={setAllocationPage}
              onSearch={setAllocationSearch}
              onStatusFilter={setAllocationStatus}
              onEdit={setEditing}
              onName={setNaming}
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
                  tr("recordsReleased", { count: selected.length }),
                  "success",
                );
                refresh();
              }}
              onReserveFirst={(segment) =>
                openAddressReservation(segment.start_address)
              }
              onReserveRange={openRangeReservation}
            />
          )}
        </TabsContent>
        <TabsContent value="children">
          {children.isError ? (
            <QueryLoadError
              label={tr("childPrefixes")}
              onRetry={() => void children.refetch()}
            />
          ) : (
            <ChildPrefixTable rows={childRows} loading={children.isPending} canEdit={canEdit} />
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
      <DeviceNameDialog
        reservation={naming}
        open={Boolean(naming)}
        onOpenChange={(open) => !open && setNaming(null)}
        onSave={(name) => naming && updateDeviceName.mutate({ reservation: naming, name })}
        saving={updateDeviceName.isPending}
      />
      <EditPrefixDialog
        prefix={network}
        open={editPrefixOpen}
        onOpenChange={setEditPrefixOpen}
        onSave={(value) => updatePrefix.mutate(value)}
        saving={updatePrefix.isPending}
      />
      <ConfirmDialog
        open={deletePrefixOpen}
        onOpenChange={setDeletePrefixOpen}
        title={tr("deletePrefix")}
        description={tr("deletePrefixDescription", {
          cidr: network.cidr,
          addresses: network.reservation_count,
          ranges: network.range_count,
        })}
        confirmLabel={tr("deletePrefixAction")}
        cancelLabel={tr("cancel")}
        variant="destructive"
        onConfirm={() => deletePrefix.mutate()}
        isPending={deletePrefix.isPending}
      />
      <ConfirmDialog
        open={Boolean(releaseTarget)}
        onOpenChange={(open) => !open && setReleaseTarget(null)}
        title={
          releaseTarget?.kind === "range"
            ? tr("releaseRangeTitle")
            : tr("releaseAddressTitle")
        }
        description={releaseTarget ? (
          <>
            {releaseTarget.kind === "range"
              ? tr("releaseRangeDescription", { range: `${releaseTarget.start_address} – ${releaseTarget.end_address}` })
              : tr("releaseAddressDescription", { address: releaseTarget.start_address })}
            {releaseTarget.kind === "address" && releaseTarget.source_type && releaseTarget.source_type !== "manual" ? (
              <span className="mt-2 block">{tr("sourceRestoreWarning", { source: sourceSystemName(releaseTarget.source_type) })}</span>
            ) : null}
          </>
        ) : ""}
        confirmLabel={tr("release")}
        cancelLabel={tr("cancel")}
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
            <DialogTitle>{tr("reserveSpace")}</DialogTitle>
            <DialogDescription>
              {tr("reserveSpaceDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="inline-flex w-fit rounded-md border bg-muted/30 p-0.5">
            <Button
              type="button"
              size="sm"
              variant={addKind === "address" ? "secondary" : "ghost"}
              onClick={() => setAddKind("address")}
            >
              {tr("singleAddress")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={addKind === "range" ? "secondary" : "ghost"}
              onClick={() => setAddKind("range")}
            >
              {tr("range")}
            </Button>
          </div>
          {addKind === "address" ? (
            <AddressForm
              address={address}
              hostname={hostname}
              macAddress={macAddress}
              description={description}
              serverId={serverId}
              status={addressStatus}
              role={addressRole}
              servers={serverRows}
              submitting={reserve.isPending}
              onAddress={setAddress}
              onHostname={setHostname}
              onMacAddress={setMacAddress}
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
            <DialogTitle>{tr("syncProxmoxTitle")}</DialogTitle>
            <DialogDescription>
              {tr("syncProxmoxDescription")}
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
              {tr("cancel")}
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
              {tr("synchronize")}
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
        description={tr("queryLoadDescription")}
        action={
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw />
            {tr("tryAgain")}
          </Button>
        }
      />
    </Card>
  );
}

function ChildPrefixTable({
  rows,
  loading = false,
  canEdit,
}: {
  rows: Prefix[];
  loading?: boolean;
  canEdit: boolean;
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
        tr("childPrefixesUpdated", { count: variables.ids.length }),
        "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) =>
      showToast(
        error.message || tr("statusUpdateFailed"),
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
            {tr("childPrefixes")}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tr("directChildrenDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canEdit && selectedRows.length > 0 && (
            <>
              <span className="whitespace-nowrap text-xs font-medium tabular-nums">
                {tr("selected", { count: selectedRows.length })}
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
                {tr("active")}
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
                {tr("reserved")}
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
          <EmptyState compact title={tr("loadingChildren")} />
        ) : rows.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            {tr("noDirectChildren")}
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
                  {canEdit && <input
                    className="mt-1"
                    type="checkbox"
                    aria-label={tr("selectPrefix", { cidr: child.cidr })}
                    checked={selected.has(child.id)}
                    onChange={() => toggle(child.id)}
                  />}
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
                            tr("noDescription")}
                        </p>
                      </div>
                      <StatusBadge tone={statusTone(child.status)} dot>
                        {statusLabel[child.status] || child.status}
                      </StatusBadge>
                    </div>
                    <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                      <span>
                        {child.vlan_id ? `VLAN ${child.vlan_id}` : tr("noVlan")}{" "}
                        ·{" "}
                        <span className="font-mono">{child.bridge || "—"}</span>
                      </span>
                      <span>{tr("freeCount", { count: child.free_address_count })}</span>
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
                    {canEdit && <th className="w-11 px-3">
                      <input
                        type="checkbox"
                        aria-label={tr("selectAllChildren")}
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
                    </th>}
                    <th className="px-3">{tr("prefixes")}</th>
                    <th className="px-3">{tr("status")}</th>
                    <th className="px-3">{tr("vlanBridge")}</th>
                    <th className="px-3">{tr("free")}</th>
                    <th className="px-3">{tr("descriptionLabel")}</th>
                    <th className="w-20 px-3 text-right">{tr("open")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((child) => (
                    <tr
                      key={child.id}
                      data-selected={selected.has(child.id) || undefined}
                    >
                      {canEdit && <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={tr("selectPrefix", { cidr: child.cidr })}
                          checked={selected.has(child.id)}
                          onChange={() => toggle(child.id)}
                        />
                      </td>}
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
                          {child.name || tr("noDescription")}
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
                            {tr("open")}
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
  freeSegments,
  loading = false,
  page,
  pageSize,
  total,
  search,
  statusFilter,
  canEdit,
  onPage,
  onSearch,
  onStatusFilter,
  onEdit,
  onName,
  onRelease,
  onBulkRelease,
  onReserveFirst,
  onReserveRange,
}: {
  rows: Allocation[];
  freeSegments: FreeSpaceSegment[];
  loading?: boolean;
  page: number;
  pageSize: number;
  total: number;
  search: string;
  statusFilter: string;
  canEdit: boolean;
  onPage: (page: number) => void;
  onSearch: (value: string) => void;
  onStatusFilter: (value: string) => void;
  onEdit: (row: Reservation) => void;
  onName: (row: Reservation) => void;
  onRelease: (row: Allocation) => void;
  onBulkRelease: (rows: Allocation[]) => Promise<void>;
  onReserveFirst: (segment: FreeSpaceSegment) => void;
  onReserveRange: (segment: FreeSpaceSegment) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const keyFor = (row: Allocation) => `${row.kind}:${row.id}`;
  const visibleRows = rows;
  const freeBefore = (row: Allocation) =>
    freeSegments.filter((segment) => segment.before_allocation_key === keyFor(row));
  const trailingFree = freeSegments.filter(
    (segment) => segment.before_allocation_key === null,
  );
  const isProtected = (row: Allocation) =>
    row.kind === "address" &&
    (row.system_managed || Boolean(row.source_type && row.source_type !== "manual"));
  const selectableRows = visibleRows.filter((row) => !isProtected(row));
  const selectedRows = selectableRows.filter((row) => selected.has(keyFor(row)));
  const allSelected =
    selectableRows.length > 0 && selectedRows.length === selectableRows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;
  const toggle = (row: Allocation) =>
    setSelected((current) => {
      if (isProtected(row)) return current;
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
          tr("releaseFailed"),
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
              {tr("usedReserved")}
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {tr("inventoryOrder")}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 lg:max-w-3xl lg:justify-end">
            <Input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              className="h-9 min-w-[280px] flex-1 lg:min-w-[380px]"
              placeholder={tr("searchAllocations")}
              aria-label={tr("addressSearchLabel")}
            />
            <Button
              type="button"
              size="sm"
              variant={statusFilter !== "all" ? "secondary" : "outline"}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Settings2 />
              {statusFilter !== "all" ? tr("filterCount", { count: 1 }) : tr("filter")}
            </Button>
            {canEdit && selectedRows.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setConfirmRelease(true)}
              >
                <Trash2 />
                {tr("release")} {selectedRows.length}
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
              {tr("status")}
            </Label>
            <select
              id="allocation-status-filter"
              value={statusFilter}
              onChange={(event) => onStatusFilter(event.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label={tr("addressStatusFilterLabel")}
            >
              <option value="all">{tr("allStatuses")}</option>
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
                onClick={() => onStatusFilter("all")}
              >
                {tr("reset")}
              </Button>
            )}
          </div>
        )}
        <ActiveFilterChips
          className="rounded-none border-x-0 border-b-0"
          filters={statusFilter !== "all" ? [{
            id: "status",
            label: `${tr("status")}: ${statusLabel[statusFilter] || statusFilter}`,
            onRemove: () => onStatusFilter("all"),
          }] : []}
          onClear={() => onStatusFilter("all")}
          clearLabel={tr("reset")}
        />
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <EmptyState compact title={tr("loadingInventory")} />
        ) : rows.length === 0 && freeSegments.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground">
            {search || statusFilter !== "all"
              ? tr("emptyFilter")
              : tr("emptyInventory")}
          </p>
        ) : (
          <>
            <div className="divide-y md:hidden">
              {visibleRows.map((row) => (
                <Fragment key={keyFor(row)}>
                  {freeBefore(row).map((segment) => (
                    <FreeSpaceMobileRow
                      key={`${segment.start_address}-${segment.end_address}`}
                      segment={segment}
                      onReserveFirst={onReserveFirst}
                      onReserveRange={onReserveRange}
                      canEdit={canEdit}
                    />
                  ))}
                  <AllocationMobileRow
                    row={row}
                    checked={selected.has(keyFor(row))}
                    onToggle={() => toggle(row)}
                    onEdit={onEdit}
                    onName={onName}
                    onRelease={onRelease}
                    canEdit={canEdit}
                  />
                </Fragment>
              ))}
              {trailingFree.map((segment) => (
                <FreeSpaceMobileRow
                  key={`${segment.start_address}-${segment.end_address}`}
                  segment={segment}
                  onReserveFirst={onReserveFirst}
                  onReserveRange={onReserveRange}
                  canEdit={canEdit}
                />
              ))}
            </div>
            <div className="table-scroll hidden md:block">
              <table
                className="w-full min-w-[980px] text-sm"
                data-density="compact"
              >
                <thead>
                  <tr>
                    {canEdit && <th className="w-11 px-3">
                      <input
                        type="checkbox"
                        aria-label={tr("selectAllAllocations")}
                        checked={allSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = someSelected;
                        }}
                        onChange={() =>
                          setSelected(
                            allSelected
                              ? new Set()
                              : new Set(selectableRows.map(keyFor)),
                          )
                        }
                      />
                    </th>}
                    <th className="px-3">{tr("addressRange")}</th>
                    <th className="px-3">{tr("status")}</th>
                    <th className="px-3">{tr("assignedTo")}</th>
                    <th className="px-3">{tr("source")}</th>
                    <th className="px-3">{tr("macAddress")}</th>
                    <th className="px-3">{tr("descriptionLabel")}</th>
                    {canEdit && <th className="w-24 px-3 text-right">{tr("actions")}</th>}
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
                    return (
                      <Fragment key={keyFor(row)}>
                        {freeBefore(row).map((segment) => (
                          <FreeSpaceTableRow
                            key={`${segment.start_address}-${segment.end_address}`}
                            segment={segment}
                            onReserveFirst={onReserveFirst}
                            onReserveRange={onReserveRange}
                            canEdit={canEdit}
                          />
                        ))}
                      <tr data-selected={checked || undefined}>
                        {canEdit && <td className="px-3">
                          <input
                            type="checkbox"
                            aria-label={tr("selectAllocation", { allocation: label })}
                            checked={checked}
                            disabled={isProtected(row)}
                            onChange={() => toggle(row)}
                          />
                        </td>}
                        <td className="px-3">
                          <span className="font-mono font-medium">{label}</span>
                          {!isAddress && (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              {tr("addressCount", { count: row.address_count })}
                            </div>
                          )}
                          {!isAddress && (
                            <Badge variant="outline" className="mt-1 w-fit">
                              {tr("range")}
                            </Badge>
                          )}
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
                                {tr("conflict")}
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
                                row.device_name ||
                                row.hostname ||
                                tr("openManagedHost")}
                            </Link>
                          ) : (
                            <span
                              className={
                                isAddress && (row.server_name || row.device_name || row.hostname)
                                  ? "block truncate font-semibold text-foreground"
                                  : "block truncate text-muted-foreground"
                              }
                            >
                              {isAddress
                                ? row.server_name || row.device_name || row.hostname || "—"
                                : row.role || "—"}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[230px] px-3">
                          <SourceBadges row={row} />
                        </td>
                        <td className="px-3">
                          <span className="font-mono text-xs">
                            {isAddress ? row.mac_address || "—" : "—"}
                          </span>
                        </td>
                        <td className="max-w-[240px] px-3">
                          <span
                            className="block truncate text-muted-foreground"
                            title={conflicts.length ? conflicts.join(" · ") : row.description || undefined}
                          >
                            {conflicts.length
                              ? conflicts.join(" · ")
                              : row.description || "—"}
                          </span>
                        </td>
                        {canEdit && <td className="px-3">
                          <div className="flex justify-end gap-1">
                            {isAddress && !row.system_managed && row.mac_address && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => onName(row as Reservation)}
                                aria-label={tr("nameDevice", { mac: row.mac_address })}
                                title={tr("nameDevice", { mac: row.mac_address })}
                              >
                                <Tag className="h-4 w-4" />
                              </Button>
                            )}
                            {isAddress && !isProtected(row) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => onEdit(row as Reservation)}
                                aria-label={tr("editAllocation", { allocation: row.start_address })}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            {!isProtected(row) && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => onRelease(row)}
                                aria-label={tr("releaseAllocation", { allocation: label })}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            )}
                          </div>
                        </td>}
                      </tr>
                      </Fragment>
                    );
                  })}
                  {trailingFree.map((segment) => (
                    <FreeSpaceTableRow
                      key={`${segment.start_address}-${segment.end_address}`}
                      segment={segment}
                      onReserveFirst={onReserveFirst}
                      onReserveRange={onReserveRange}
                      canEdit={canEdit}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
      <TablePagination
        page={page}
        pageSize={pageSize}
        totalItems={total}
        onPageChange={onPage}
        disabled={loading}
        itemLabel={tr("allocationsPagination")}
      />
      <ConfirmDialog
        open={confirmRelease}
        onOpenChange={setConfirmRelease}
        title={tr("releaseSelectedTitle")}
        description={
          <>
            {tr("releaseSelectedDescription", { count: selectedRows.length })}
            {selectedRows.some(
              (row) =>
                row.kind === "address" &&
                row.source_type &&
                row.source_type !== "manual",
            ) ? (
              <span className="mt-2 block">
                {tr("externalReleaseWarning")}
              </span>
            ) : null}
          </>
        }
        confirmLabel={tr("release")}
        cancelLabel={tr("cancel")}
        variant="destructive"
        onConfirm={releaseSelected}
        isPending={releasing}
      />
    </Card>
  );
}

function FreeSpaceLabel({ segment }: { segment: FreeSpaceSegment }) {
  return (
    <div className="min-w-0 text-left text-xs">
      <div className="font-semibold text-emerald-700 dark:text-emerald-300">
        {tr("freeAddresses", { count: segment.address_count })}
      </div>
      <div className="mt-0.5 truncate font-mono text-muted-foreground">
        {segment.start_address === segment.end_address
          ? segment.start_address
          : `${segment.start_address} – ${segment.end_address}`}
      </div>
    </div>
  );
}

function FreeSpaceActions({
  segment,
  onReserveFirst,
  onReserveRange,
}: {
  segment: FreeSpaceSegment;
  onReserveFirst: (segment: FreeSpaceSegment) => void;
  onReserveRange: (segment: FreeSpaceSegment) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onReserveFirst(segment)}
      >
        <Plus />
        {tr("reserveFirstIp")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onReserveRange(segment)}
      >
        {tr("reserveFreeRange")}
      </Button>
    </div>
  );
}

function FreeSpaceTableRow({
  segment,
  onReserveFirst,
  onReserveRange,
  canEdit,
}: {
  segment: FreeSpaceSegment;
  onReserveFirst: (segment: FreeSpaceSegment) => void;
  onReserveRange: (segment: FreeSpaceSegment) => void;
  canEdit: boolean;
}) {
  return (
    <tr className="bg-emerald-500/[0.025]" aria-label={tr("freeSectionAria", { count: segment.address_count })}>
      <td colSpan={canEdit ? 8 : 6} className="px-4 py-2">
        <div className="flex items-center justify-between gap-4">
          <FreeSpaceLabel segment={segment} />
          {canEdit && <FreeSpaceActions
            segment={segment}
            onReserveFirst={onReserveFirst}
            onReserveRange={onReserveRange}
          />}
        </div>
      </td>
    </tr>
  );
}

function FreeSpaceMobileRow({
  segment,
  onReserveFirst,
  onReserveRange,
  canEdit,
}: {
  segment: FreeSpaceSegment;
  onReserveFirst: (segment: FreeSpaceSegment) => void;
  onReserveRange: (segment: FreeSpaceSegment) => void;
  canEdit: boolean;
}) {
  return (
    <div className="space-y-2 bg-emerald-500/[0.025] px-4 py-3">
      <FreeSpaceLabel segment={segment} />
      {canEdit && <FreeSpaceActions
        segment={segment}
        onReserveFirst={onReserveFirst}
        onReserveRange={onReserveRange}
      />}
    </div>
  );
}

function isStaleTimestamp(value?: string | null) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp > 60 * 60 * 1000;
}

function SourceBadges({ row }: { row: Allocation }) {
  if (row.kind !== "address") return <span className="text-muted-foreground">—</span>;
  const primarySystem = sourceSystemName(row.source_type);
  const primaryName = row.source_name || primarySystem;
  const primaryIsStale = isStaleTimestamp(row.last_synced_at);
  const observations = Array.isArray(row.source_observations)
    ? row.source_observations
    : (row.observed_sources || []).map((name) => ({
        name,
        type: "",
        last_seen_at: null,
      }));
  const distinctObservations = observations.filter(
    (source, index, all) =>
      !(source.type === row.source_type && source.name === primaryName) &&
      all.findIndex(
        (candidate) =>
          candidate.type === source.type && candidate.name === source.name,
      ) === index,
  );
  return (
    <div className="flex flex-wrap gap-1">
      {row.source_type === "system" || row.system_managed ? (
        <Badge variant="secondary" title={tr("systemSourceTitle")}>
          <LockKeyhole className="h-3 w-3" />
          {tr("systemSource")}
        </Badge>
      ) : row.source_type && row.source_type !== "manual" ? (
        <Badge
          variant={primaryIsStale ? "warning" : "secondary"}
          title={tr("managedSourceTitle", {
            name: primaryName || primarySystem,
            date: row.last_synced_at
              ? new Date(row.last_synced_at).toLocaleString()
              : tr("unknownTime"),
          })}
        >
          <LockKeyhole className="h-3 w-3" />
          {tr("managedBy", { source: primarySystem || primaryName })}
        </Badge>
      ) : (
        <Badge variant="outline">{tr("manualSource")}</Badge>
      )}
      {distinctObservations.map((source) => {
        const system = sourceSystemName(source.type) || source.name;
        const stale = isStaleTimestamp(source.last_seen_at);
        return (
          <Badge
            key={`${source.type}:${source.name}`}
            variant={stale ? "warning" : "outline"}
            title={tr("observedSourceTitle", {
              name: source.name,
              date: source.last_seen_at
                ? new Date(source.last_seen_at).toLocaleString()
                : tr("unknownTime"),
            })}
          >
            {tr("observedBy", { source: system })}
          </Badge>
        );
      })}
    </div>
  );
}

function AllocationMobileRow({
  row,
  checked,
  onToggle,
  onEdit,
  onName,
  onRelease,
  canEdit,
}: {
  row: Allocation;
  checked: boolean;
  onToggle: () => void;
  onEdit: (row: Reservation) => void;
  onName: (row: Reservation) => void;
  onRelease: (row: Allocation) => void;
  canEdit: boolean;
}) {
  const isAddress = row.kind === "address";
  const label = isAddress
    ? row.start_address
    : `${row.start_address} – ${row.end_address}`;
  const conflicts = isAddress ? row.conflicts || [] : [];
  const protectedRow =
    isAddress &&
    (row.system_managed || Boolean(row.source_type && row.source_type !== "manual"));
  return (
    <div className="space-y-3 p-4" data-selected={checked || undefined}>
      <div className="flex items-start gap-3">
        {canEdit && <input
          className="mt-1"
          type="checkbox"
          aria-label={tr("selectAllocation", { allocation: label })}
          checked={checked}
          disabled={protectedRow}
          onChange={onToggle}
        />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">{label}</span>
            {!isAddress && <Badge variant="outline">{tr("range")}</Badge>}
            {conflicts.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {tr("conflict")}
              </span>
            )}
          </div>
          {!isAddress && (
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("addressCount", { count: row.address_count })}
            </p>
          )}
        </div>
        <StatusBadge tone={statusTone(row.status)} dot>
          {statusLabel[row.status] || row.status}
        </StatusBadge>
      </div>
      <div className="ml-7 grid gap-1 text-xs">
        <span className="text-muted-foreground">
          {tr("assignedToLabel")}
          {isAddress && row.server_id ? (
            <Link
              to="/servers/$id"
              params={{ id: row.server_id }}
              className="font-medium text-primary hover:underline"
            >
              {row.server_name || row.device_name || row.hostname || tr("openManagedHost")}
            </Link>
          ) : (
            <span className="text-foreground">
              {isAddress
                ? row.server_name || row.device_name || row.hostname || "—"
                : row.role || "—"}
            </span>
          )}
        </span>
        {isAddress && row.mac_address && (
          <span className="text-muted-foreground">
            {tr("macAddressLabel")}
            <span className="font-mono text-foreground">{row.mac_address}</span>
          </span>
        )}
        <SourceBadges row={row} />
        {(conflicts.length > 0 || row.description) && (
          <span className="text-muted-foreground">
            {conflicts.length ? conflicts.join(" · ") : row.description}
          </span>
        )}
      </div>
      {canEdit && <div className="ml-7 flex gap-2">
        {isAddress && !row.system_managed && row.mac_address && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onName(row as Reservation)}
          >
            <Tag />
            {tr("deviceName")}
          </Button>
        )}
        {isAddress && !protectedRow && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(row as Reservation)}
          >
            <Pencil />
            {tr("edit")}
          </Button>
        )}
        {!protectedRow && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onRelease(row)}
          >
            <Trash2 />
            {tr("release")}
          </Button>
        )}
      </div>}
    </div>
  );
}

function SyncConflictPanel({ rows }: { rows: SyncConflict[] }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader className="border-b bg-destructive/[0.04] py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          {tr("syncConflictsTitle")}{" "}
          <Badge variant="destructive">{rows.length}</Badge>
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          {tr("syncConflictsDescription")}
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
                {tr("observed")}: {row.hostname || tr("noHostname")}
              </p>
              <p className="text-muted-foreground">
                {tr("existing")}:{" "}
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
                  tr("noLongerPresent")
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
                <th className="px-3">{tr("address")}</th>
                <th className="px-3">{tr("source")}</th>
                <th className="px-3">{tr("observed")}</th>
                <th className="px-3">{tr("existingAssignment")}</th>
                <th className="px-3">{tr("reason")}</th>
                <th className="px-3">{tr("lastSeen")}</th>
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
                      tr("noLongerPresent")
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
  macAddress,
  description,
  serverId,
  status,
  role,
  servers,
  submitting,
  onAddress,
  onHostname,
  onMacAddress,
  onDescription,
  onServer,
  onStatus,
  onRole,
  onSubmit,
}: {
  address: string;
  hostname: string;
  macAddress: string;
  description: string;
  serverId: string;
  status: string;
  role: string;
  servers: Server[];
  submitting: boolean;
  onAddress: (value: string) => void;
  onHostname: (value: string) => void;
  onMacAddress: (value: string) => void;
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
        <Field label={tr("ipAddress")}>
          <Input
            required
            autoFocus
            value={address}
            onChange={(event) => onAddress(event.target.value)}
            placeholder="10.20.10.25"
            inputMode="decimal"
          />
        </Field>
        <Field label={tr("hostname")}>
          <Input
            value={hostname}
            onChange={(event) => onHostname(event.target.value)}
            placeholder={tr("hostnameExample")}
          />
        </Field>
        <Field label={tr("macAddress")}>
          <Input
            value={macAddress}
            onChange={(event) => onMacAddress(event.target.value)}
            placeholder="02:00:00:00:00:01"
            autoComplete="off"
          />
        </Field>
        <Field label={tr("status")}>
          <select
            value={status}
            onChange={(event) => onStatus(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            <option value="active">{tr("active")}</option>
            <option value="reserved">{tr("reserved")}</option>
            <option value="deprecated">{tr("deprecated")}</option>
          </select>
        </Field>
        <p className="sm:col-span-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {tr("dhcpStatusManagedHint")}
        </p>
        <Field label={tr("role")}>
          <select
            value={role}
            onChange={(event) => onRole(event.target.value)}
            className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
          >
            <option value="">{tr("noRole")}</option>
            <option value="gateway">{tr("gatewayRole")}</option>
            <option value="vip">{tr("vipRole")}</option>
            <option value="secondary">{tr("secondaryRole")}</option>
            <option value="loopback">{tr("loopbackRole")}</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label={tr("fleetHost")}>
            <select
              value={serverId}
              onChange={(event) => onServer(event.target.value)}
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="">{tr("notAssigned")}</option>
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
          <Field label={tr("descriptionLabel")}>
            <Input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder={tr("purposePlaceholder")}
            />
          </Field>
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={submitting}>
          <Plus />
          {tr("addIp")}
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
        <Field label={tr("firstAddress")}>
          <Input
            required
            autoFocus
            value={start}
            onChange={(event) => onStart(event.target.value)}
            placeholder="10.20.10.100"
            inputMode="decimal"
          />
        </Field>
        <Field label={tr("lastAddress")}>
          <Input
            required
            value={end}
            onChange={(event) => onEnd(event.target.value)}
            placeholder="10.20.10.150"
            inputMode="decimal"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label={tr("descriptionLabel")}>
            <Input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder={tr("rangePurposePlaceholder")}
            />
          </Field>
        </div>
      </div>
      <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {tr("rangeObjectHint")}
      </p>
      <DialogFooter>
        <Button type="submit" variant="secondary" disabled={submitting}>
          <Plus />
          {tr("reserveRange")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function editableReservationValue(reservation: Reservation | null) {
  return reservation
    ? {
        ...reservation,
        status:
          reservation.configured_status ||
          (reservation.status === "dhcp" ? "active" : reservation.status),
      }
    : null;
}

function DeviceNameDialog({
  reservation,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  reservation: Reservation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    setName(reservation?.device_name || "");
  }, [reservation]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tr("nameDeviceTitle")}</DialogTitle>
          <DialogDescription>
            {tr("nameDeviceDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={tr("deviceName")}>
            <Input
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={tr("deviceNamePlaceholder")}
            />
          </Field>
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span className="block">{reservation?.address || "—"}</span>
            <span className="font-mono text-foreground">
              {reservation?.mac_address || "—"}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tr("cancel")}
          </Button>
          <Button onClick={() => onSave(name.trim())} disabled={saving}>
            <Tag />
            {tr("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [value, setValue] = useState<Reservation | null>(
    editableReservationValue(reservation),
  );
  useEffect(() => {
    setValue(editableReservationValue(reservation));
  }, [reservation]);
  if (!value) return null;
  const sourceName = sourceSystemName(value.source_type);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("editAddress")}</DialogTitle>
          <DialogDescription>
            {tr("changeAddressDescription")}
          </DialogDescription>
        </DialogHeader>
        {sourceName && value.source_type !== "manual" ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
            <strong>{tr("syncedFrom", { source: sourceName })}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr("syncedEditWarning")}
            </span>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("ipAddress")}>
            <Input
              value={value.address}
              onChange={(event) =>
                setValue({ ...value, address: event.target.value })
              }
            />
          </Field>
          <Field label={tr("status")}>
            <select
              value={value.status}
              onChange={(event) =>
                setValue({ ...value, status: event.target.value })
              }
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="active">{tr("active")}</option>
              <option value="reserved">{tr("reserved")}</option>
              <option value="deprecated">{tr("deprecated")}</option>
            </select>
          </Field>
          <Field label={tr("hostname")}>
            <Input
              value={value.hostname || ""}
              onChange={(event) =>
                setValue({ ...value, hostname: event.target.value })
              }
              placeholder={tr("hostnameExample")}
            />
          </Field>
          <Field label={tr("macAddress")}>
            <Input
              value={value.mac_address || ""}
              onChange={(event) =>
                setValue({ ...value, mac_address: event.target.value })
              }
              placeholder="52:54:00:12:34:56"
            />
          </Field>
          <Field label={tr("role")}>
            <select
              value={value.role || ""}
              onChange={(event) =>
                setValue({ ...value, role: event.target.value })
              }
              className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
            >
              <option value="">{tr("noRole")}</option>
              <option value="gateway">{tr("gatewayRole")}</option>
              <option value="vip">{tr("vipRole")}</option>
              <option value="secondary">{tr("secondaryRole")}</option>
              <option value="loopback">{tr("loopbackRole")}</option>
            </select>
          </Field>
          <Field label={tr("fleetHost")}>
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
              <option value="">{tr("notAssigned")}</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={tr("descriptionLabel")}>
              <Input
                value={value.description || ""}
                onChange={(event) =>
                  setValue({ ...value, description: event.target.value })
                }
              />
            </Field>
          </div>
        </div>
        {reservation?.status === "dhcp" && (
          <p className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-muted-foreground">
            {tr("dhcpAddressHint")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tr("cancel")}
          </Button>
          <Button onClick={() => onSave(value)} disabled={saving}>
            <Pencil />
            {tr("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPrefixDialog({
  prefix,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  prefix: Prefix;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: Partial<Prefix>) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState({
    name: prefix.name,
    gateway: prefix.gateway || "",
    dhcpStart: prefix.dhcp_start || "",
    dhcpEnd: prefix.dhcp_end || "",
    dns: (prefix.dns_servers || []).join(", "),
    vlan: prefix.vlan_id == null ? "" : String(prefix.vlan_id),
    bridge: prefix.bridge || "",
    description: prefix.description || "",
    status: prefix.status,
    role: prefix.role || "",
  });
  useEffect(() => {
    if (!open) return;
    setValue({
      name: prefix.name,
      gateway: prefix.gateway || "",
      dhcpStart: prefix.dhcp_start || "",
      dhcpEnd: prefix.dhcp_end || "",
      dns: (prefix.dns_servers || []).join(", "),
      vlan: prefix.vlan_id == null ? "" : String(prefix.vlan_id),
      bridge: prefix.bridge || "",
      description: prefix.description || "",
      status: prefix.status,
      role: prefix.role || "",
    });
  }, [open, prefix]);
  const change = (key: keyof typeof value, next: string) =>
    setValue((current) => ({ ...current, [key]: next }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("editPrefix")}</DialogTitle>
          <DialogDescription>
            {tr("editPrefixDescription", { cidr: prefix.cidr })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              name: value.name,
              gateway: value.gateway,
              dhcp_start: value.dhcpStart,
              dhcp_end: value.dhcpEnd,
              dns_servers: value.dns.split(",").map((item) => item.trim()).filter(Boolean),
              vlan_id: value.vlan ? Number(value.vlan) : null,
              bridge: value.bridge,
              description: value.description,
              status: value.status,
              role: value.role,
            });
          }}
        >
          <Field label={tr("name")}><Input required value={value.name} onChange={(event) => change("name", event.target.value)} /></Field>
          <Field label={tr("cidr")}><Input value={prefix.cidr} disabled /></Field>
          <Field label={tr("status")}>
            <select value={value.status} onChange={(event) => change("status", event.target.value)} className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]">
              <option value="active">{tr("active")}</option><option value="container">{tr("container")}</option><option value="reserved">{tr("reserved")}</option><option value="deprecated">{tr("deprecated")}</option>
            </select>
          </Field>
          <Field label={tr("role")}><Input value={value.role} onChange={(event) => change("role", event.target.value)} /></Field>
          <Field label={tr("gateway")}><Input value={value.gateway} onChange={(event) => change("gateway", event.target.value)} /></Field>
          <Field label={tr("dhcpStart")}><Input inputMode="decimal" value={value.dhcpStart} onChange={(event) => change("dhcpStart", event.target.value)} placeholder="10.20.10.100" /></Field>
          <Field label={tr("dhcpEnd")}><Input inputMode="decimal" value={value.dhcpEnd} onChange={(event) => change("dhcpEnd", event.target.value)} placeholder="10.20.10.200" /></Field>
          <p className="sm:col-span-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{tr("dhcpRangeHint")}</p>
          <Field label={tr("dnsServers")}><Input value={value.dns} onChange={(event) => change("dns", event.target.value)} placeholder="10.20.10.10, 10.20.10.11" /></Field>
          <Field label={tr("vlanId")}><Input inputMode="numeric" value={value.vlan} onChange={(event) => change("vlan", event.target.value)} /></Field>
          <Field label={tr("bridge")}><Input value={value.bridge} onChange={(event) => change("bridge", event.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label={tr("descriptionLabel")}><Input value={value.description} onChange={(event) => change("description", event.target.value)} /></Field></div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tr("cancel")}</Button>
            <Button type="submit" disabled={saving}><Pencil />{tr("savePrefix")}</Button>
          </DialogFooter>
        </form>
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
    <div className="console-object-info !min-h-10 !py-1">
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
    <div className="min-w-0 bg-card px-3 py-2.5">
      <div className="text-[11px] leading-4 text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}
