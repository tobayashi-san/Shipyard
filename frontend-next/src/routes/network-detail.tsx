import { Badge } from "@/components/ui/badge";
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
import { OverflowItem, OverflowMenu, OverflowSep } from "@/components/ui/overflow-menu";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import { releaseIpamAllocations } from "@/lib/ipam-bulk-release";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { useUrlTab } from "@/lib/use-url-tab";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowLeft,
	Network,
	Pencil,
	Plus,
	RefreshCw,
	ServerCog,
	Trash2
} from "lucide-react";
import {
	useDeferredValue,
	useEffect,
	useState
} from "react";

import { AllocationTable } from "@/features/ipam/AllocationTable";
import { ChildPrefixTable } from "@/features/ipam/ChildPrefixTable";
import { capacityTone, Info, QueryLoadError, sourceSystemName, statusLabel, statusTone, tr } from "@/features/ipam/network-presentation";
import type { Allocation, FreeSpaceSegment, Paginated, Prefix, ProxmoxConnection, Reservation, Server, SyncConflict } from "@/features/ipam/network-types";
import { AddressForm, DeviceNameDialog, EditAddressDialog, EditPrefixDialog, RangeForm } from "@/features/ipam/ReservationForms";
import { SyncConflictPanel } from "@/features/ipam/SyncConflictPanel";
const NETWORK_TABS = ["allocations", "children"] as const;
export function NetworkDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <NetworkDetailContent key={id} id={id} />;
}

function NetworkDetailContent({ id }: { id: string }) {
  const networkTabs = useUrlTab("allocations", NETWORK_TABS);
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
  const [addressStatus, setAddressStatus] = useState("reserved");
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
  const deferredAddress = useDeferredValue(address.trim());
  const deferredRangeStart = useDeferredValue(rangeStart.trim());
  const deferredRangeEnd = useDeferredValue(rangeEnd.trim());

  const detail = useQuery({
    queryKey: ["ipam", "network", id],
    queryFn: () => apiFetch<Prefix>(`/ipam/subnets/${encodeURIComponent(id)}`),
    refetchInterval: 60_000,
  });
  const targetEnvironmentId = detail.data?.environment_id || environmentId;
  const allocations = useQuery({
    queryKey: ["ipam", "allocations", id, allocationPage, allocationSearch, allocationStatus],
    queryFn: () =>
      apiFetch<Paginated<Allocation>>(
        `/ipam/subnets/${encodeURIComponent(id)}/allocations?paginated=1&page=${allocationPage}&page_size=${allocationPageSize}&q=${encodeURIComponent(allocationSearch)}&status=${encodeURIComponent(allocationStatus === "unassigned" ? "all" : allocationStatus)}`,
      ),
    refetchInterval: 60_000,
  });
  const reservationValidation = useQuery({
    queryKey: ["ipam", "reservation-validation", id, targetEnvironmentId, addKind, deferredAddress, deferredRangeStart, deferredRangeEnd],
    queryFn: () => apiFetch<{ valid: boolean; message: string }>(
      `/ipam/subnets/${encodeURIComponent(id)}/reservations/validate`,
      {
        method: "POST",
        environmentId: targetEnvironmentId,
        body: addKind === "address"
          ? { kind: "address", address: deferredAddress }
          : { kind: "range", start_address: deferredRangeStart, end_address: deferredRangeEnd },
      },
    ),
    enabled: addOpen && (addKind === "address"
      ? Boolean(deferredAddress)
      : Boolean(deferredRangeStart && deferredRangeEnd)),
    retry: false,
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
    queryKey: ["servers", targetEnvironmentId],
    queryFn: () => apiFetch<Server[]>(`/servers?environment_id=${encodeURIComponent(targetEnvironmentId)}`, { environmentId: targetEnvironmentId }),
  });
  const connections = useQuery({
    queryKey: ["opentofu", "proxmox-connections", targetEnvironmentId],
    queryFn: () =>
      apiFetch<ProxmoxConnection[]>(
        `/opentofu/proxmox-connections?environment_id=${encodeURIComponent(targetEnvironmentId)}`,
        { environmentId: targetEnvironmentId },
      ),
    retry: false,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["ipam"] });
  const openAddressReservation = (nextAddress = "") => {
    reserve.reset();
    reserveRange.reset();
    setAddress(nextAddress);
    setHostname("");
    setMacAddress("");
    setDescription("");
    setServerId("");
    setAddressStatus("reserved");
    setAddressRole("");
    setAddKind("address");
    setAddOpen(true);
  };
  const openRangeReservation = (segment: FreeSpaceSegment) => {
    reserve.reset();
    reserveRange.reset();
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
        environmentId: targetEnvironmentId,
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
    onError: (error: Error) => {
      showToast(error.message, "error");
      void queryClient.invalidateQueries({ queryKey: ["ipam", "reservation-validation", id] });
    },
  });
  const reserveRange = useMutation({
    mutationFn: () =>
      apiFetch<{ count: number }>(
        `/ipam/subnets/${encodeURIComponent(id)}/reservations/range`,
        {
          method: "POST",
        environmentId: targetEnvironmentId,
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
    onError: (error: Error) => {
      showToast(error.message, "error");
      void queryClient.invalidateQueries({ queryKey: ["ipam", "reservation-validation", id] });
    },
  });
  const removeReservation = useMutation({
    mutationFn: (reservationId: string) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservationId)}`, {
        method: "DELETE",
        environmentId: targetEnvironmentId,
      }),
    onSuccess: () => {
      setReleaseTarget(null);
      showToast(tr("ipReleased"), "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const removeRange = useMutation({
    mutationFn: (rangeId: string) =>
      apiFetch(`/ipam/ranges/${encodeURIComponent(rangeId)}`, {
        method: "DELETE",
        environmentId: targetEnvironmentId,
      }),
    onSuccess: () => {
      setReleaseTarget(null);
      showToast(tr("rangeReleased"), "success");
      refresh();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const updateReservation = useMutation({
    mutationFn: (reservation: Reservation) =>
      apiFetch(`/ipam/reservations/${encodeURIComponent(reservation.id)}`, {
        method: "PUT",
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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
        environmentId: targetEnvironmentId,
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
    mutationFn: () => apiFetch(`/ipam/subnets/${encodeURIComponent(id)}`, { method: "DELETE", environmentId: targetEnvironmentId }),
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
        { method: "POST",
        environmentId: targetEnvironmentId, body: { subnet_id: id } },
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
  // Only configured values; an unconfigured network shows no row of dashes.
  const bridge = network.bridge && !(network.vlan_id && network.bridge.toLowerCase() === `vlan${network.vlan_id}`) ? network.bridge : "";
  const configuration = ([
    [tr("vlanBridge"), [network.vlan_id ? `VLAN ${network.vlan_id}` : "", bridge].filter(Boolean).join(" · ")],
    [tr("gateway"), network.gateway || ""],
    [tr("dhcpRange"), network.dhcp_start && network.dhcp_end ? `${network.dhcp_start} – ${network.dhcp_end} (${tr("dhcpPoolCount", { count: network.dhcp_address_count || 0 })})` : ""],
    [tr("dns"), (network.dns_servers || []).join(", ")],
    [tr("role"), network.role || ""],
    [tr("descriptionLabel"), network.description || ""],
  ] as [string, string][]).filter(([, value]) => value);
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
        badge={
          <StatusBadge tone={statusTone(network.status)} dot>
            {statusLabel[network.status] || network.status}
          </StatusBadge>
        }
        actions={
          <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
            {canEdit && <Button
              size="sm"
              onClick={() => {
                openAddressReservation(network.next_free_address || "");
              }}
            >
              <Plus />
              {tr("reserveAddress")}
            </Button>}
            {canEdit && connectionRows.length > 0 && <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConnectionId(connectionRows[0]?.id || "");
                setSyncOpen(true);
              }}
              title={
                connections.isError
                  ? tr("proxmoxConnectionsFailed")
                  : connections.isLoading
                    ? "Loading Proxmox connections…"
                    : connectionRows.length === 0
                      ? tr("noProxmoxConnection")
                      : tr("syncProxmoxDescription")
              }
            >
              <ServerCog />
              {tr("syncProxmox")}
            </Button>}
            {canEdit && <OverflowMenu title={tr("moreActions")}>
              <OverflowItem icon={Pencil} onClick={() => { updatePrefix.reset(); setEditPrefixOpen(true); }}>{tr("editPrefix")}</OverflowItem>
              <OverflowSep />
              <OverflowItem icon={Trash2} danger onClick={() => { deletePrefix.reset(); setDeletePrefixOpen(true); }}>{tr("delete")}</OverflowItem>
            </OverflowMenu>}
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
      {connections.isError && (
        <Card>
          <QueryErrorState
            compact
            error={connections.error}
            title={tr("proxmoxConnectionsFailed")}
            onRetry={() => void connections.refetch()}
          />
        </Card>
      )}
      {/* Utilisation, the next free address and the counts in one place. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Network className="h-4 w-4 text-brand" />{tr("addressSpace")}</h2>
            <span className="text-sm text-muted-foreground tabular-nums">{tr("usedSummary", { used: network.used_address_count, total: network.usable_address_count, percent: usagePercent })}</span>
          </div>
          <div className="console-capacity-track">
            <span data-capacity-tone={capacityTone(usagePercent)} style={{ width: `${usagePercent}%` }} />
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>{tr("nextFree")}: {network.next_free_address ? <button type="button" onClick={() => openAddressReservation(network.next_free_address || "")} className="font-mono text-sm font-medium text-brand hover:underline">{network.next_free_address}</button> : tr("noneFree")}</span>
            <span>{network.reservation_count} {network.reservation_count === 1 ? "reservation" : "reservations"}</span>
            <span>{network.range_count} {network.range_count === 1 ? "range" : "ranges"}</span>
            {network.child_prefix_count > 0 && <span>{tr("childCount", { count: network.child_prefix_count })}</span>}
          </div>
        </CardContent>
      </Card>
      {configuration.length > 0 && <Card>
        <CardHeader className="border-b px-3 py-2.5">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="h-4 w-4" />
            {tr("networkConfiguration")}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-px bg-border p-0 text-sm sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
          {configuration.map(([label, value]) => <Info key={label} label={label} value={value} />)}
        </CardContent>
      </Card>}
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
              environmentId={network.environment_id}
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
              onRelease={(row) => { removeReservation.reset(); removeRange.reset(); setReleaseTarget(row); }}
              onBulkRelease={async (selected, targetEnvironmentId) => {
                const result = await releaseIpamAllocations(selected, targetEnvironmentId);
                if (!result.failed.length) showToast(tr("recordsReleased", { count: result.released.length }), "success");
                refresh();
                return result;
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
      {editPrefixOpen && <EditPrefixDialog
        prefix={network}
        open={editPrefixOpen}
        onOpenChange={setEditPrefixOpen}
        onSave={(value) => updatePrefix.mutate(value)}
        saving={updatePrefix.isPending}
        error={updatePrefix.error?.message}
      />}
      <ConfirmDialog
        open={deletePrefixOpen}
        targetEnvironmentId={targetEnvironmentId}
        closeOnConfirm={false}
        error={deletePrefix.error?.message}
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
        targetEnvironmentId={targetEnvironmentId}
        closeOnConfirm={false}
        error={(releaseTarget?.kind === "range" ? removeRange.error : removeReservation.error)?.message}
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
      <Dialog open={addOpen} onOpenChange={(open) => { if (!reserve.isPending && !reserveRange.isPending) setAddOpen(open); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tr("reserveSpace")}</DialogTitle>
            <DialogDescription>
              {tr("reserveSpaceDescription")} {tr("reservationContext", { cidr: network.cidr })}
              {addressStatus === "active" && tr("activeReservationHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="inline-flex w-fit rounded-md border bg-muted/30 p-0.5">
            <Button
              type="button"
              size="sm"
              disabled={reserve.isPending || reserveRange.isPending}
              variant={addKind === "address" ? "secondary" : "ghost"}
              onClick={() => setAddKind("address")}
            >
              {tr("singleAddress")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={reserve.isPending || reserveRange.isPending}
              variant={addKind === "range" ? "secondary" : "ghost"}
              onClick={() => setAddKind("range")}
            >
              {tr("range")}
            </Button>
          </div>
          {servers.isError && (
            <QueryErrorState
              compact
              className="py-3"
              error={servers.error}
              title={tr("managedHostReferencesFailed")}
              onRetry={() => void servers.refetch()}
            />
          )}
          {reservationValidation.isError && (
            <QueryErrorState
              compact
              className="py-3"
              error={reservationValidation.error}
              title={tr("reservationValidationFailed")}
              onRetry={() => void reservationValidation.refetch()}
            />
          )}
          {(addKind === "address" ? reserve.error : reserveRange.error) && <p role="alert" className="text-sm text-destructive">{(addKind === "address" ? reserve.error : reserveRange.error)?.message}</p>}
          {(reserve.isPending || reserveRange.isPending) && <p role="status" className="text-sm text-muted-foreground">{tr("savingReservation", { cidr: network.cidr })}</p>}
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
              validation={reservationValidation.isError ? { valid: false, message: tr("reservationValidationFailed") } : reservationValidation.data}
              validating={reservationValidation.isFetching || address.trim() !== deferredAddress}
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
              validation={reservationValidation.isError ? { valid: false, message: tr("reservationValidationFailed") } : reservationValidation.data}
              validating={reservationValidation.isFetching || rangeStart.trim() !== deferredRangeStart || rangeEnd.trim() !== deferredRangeEnd}
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
