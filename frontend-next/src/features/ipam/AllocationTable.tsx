import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ActiveFilterChips } from "@/components/ui/filter-chips";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverflowItem, OverflowMenu } from "@/components/ui/overflow-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { TablePagination } from "@/components/ui/table-pagination";
import { type ReleaseResult } from "@/lib/ipam-bulk-release";
import { showToast } from "@/lib/toast";
import { formatDateTime } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	Layers3,
	LockKeyhole,
	Pencil,
	Plus,
	Settings2,
	Tag,
	Trash2
} from "lucide-react";
import {
	Fragment,
	useState
} from "react";

import { sourceSystemName, statusLabel, statusTone, tr } from "./network-presentation";
import type { Allocation, FreeSpaceSegment, Reservation } from "./network-types";
export function AllocationTable({
  environmentId,
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
  environmentId: string;
  onBulkRelease: (rows: Allocation[], environmentId: string) => Promise<ReleaseResult>;
  onReserveFirst: (segment: FreeSpaceSegment) => void;
  onReserveRange: (segment: FreeSpaceSegment) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [releaseEnvironment, setReleaseEnvironment] = useState(environmentId);
  const [releaseTargets, setReleaseTargets] = useState<Allocation[]>([]);
  const [releaseError, setReleaseError] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const keyFor = (row: Allocation) => `${row.kind}:${row.id}`;
  const visibleRows = statusFilter === "unassigned" ? [] : rows;
  const visibleFreeSegments =
    statusFilter === "all" || statusFilter === "unassigned" ? freeSegments : [];
  const freeBefore = (row: Allocation) =>
    visibleFreeSegments.filter((segment) => segment.before_allocation_key === keyFor(row));
  const trailingFree = statusFilter === "unassigned"
    ? visibleFreeSegments
    : visibleFreeSegments.filter((segment) => segment.before_allocation_key === null);
  const isProtected = (row: Allocation) =>
    row.kind === "address" &&
    (row.system_managed || Boolean(row.source_type && row.source_type !== "manual"));
  const selectableRows = visibleRows;
  const selectedRows = selectableRows.filter((row) => selected.has(keyFor(row)));
  const releasableRows = selectedRows.filter(row => !isProtected(row));
  const protectedCount = selectedRows.length - releasableRows.length;
  const allSelected =
    selectableRows.length > 0 && selectedRows.length === selectableRows.length;
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
    if (releasing || !releaseTargets.length) return;
    setReleasing(true);
    setReleaseError("");
    try {
      const result = await onBulkRelease(releaseTargets, releaseEnvironment);
      const failedKeys = new Set(result.failed.map(item => item.key));
      setSelected(failedKeys);
      setReleaseTargets(current => current.filter(row => failedKeys.has(keyFor(row))));
      if (result.failed.length) {
        setReleaseError(tr("bulkReleasePartial", { released: result.released.length, failed: result.failed.length, details: result.failed.map(item => `${item.label}: ${item.message}`).join(" ") }));
      } else setConfirmRelease(false);
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : tr("releaseFailed"));
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
        <div className="console-toolbar gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" />
              {tr("usedReserved")}
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {tr("inventoryOrder")}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 lg:justify-end">
            <div className="flex flex-wrap gap-1" aria-label={tr("quickFilters")}>
              {[
                ["active", tr("active")],
                ["reserved", tr("reserved")],
                ["dhcp", tr("dhcp")],
                ["unassigned", tr("unassigned")],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={statusFilter === value ? "default" : "outline"}
                  aria-pressed={statusFilter === value}
                  onClick={() => onStatusFilter(statusFilter === value ? "all" : value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              className="min-w-[220px] flex-1"
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
              <OverflowMenu title={tr("bulkActions")} trigger={`${tr("bulkActions")} · ${selectedRows.length}`}>
                <OverflowItem icon={Trash2} danger disabled={!releasableRows.length} onClick={() => { setReleaseEnvironment(environmentId); setReleaseTargets([...releasableRows]); setReleaseError(""); setConfirmRelease(true); }}>
                  {tr("release")} {releasableRows.length}
                </OverflowItem>
              </OverflowMenu>
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
              <option value="unassigned">{tr("unassigned")}</option>
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
        {canEdit && protectedCount > 0 && <p role="status" className="border-t px-4 py-2 text-sm text-muted-foreground">{tr("protectedSelection", { count: protectedCount })}</p>}
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
        ) : visibleRows.length === 0 && visibleFreeSegments.length === 0 ? (
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
                          {isAddress && row.mac_address
                            ? <span className="font-mono text-xs">{row.mac_address}</span>
                            : <span className="text-muted-foreground">—</span>}
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
        targetEnvironmentId={releaseEnvironment}
        open={confirmRelease}
        closeOnConfirm={false}
        error={releaseError}
        onOpenChange={setConfirmRelease}
        title={tr("releaseSelectedTitle")}
        description={
          <>
            {tr("releaseSelectedDescription", { count: releaseTargets.length })}
            {selectedRows.some(
              (row) =>
                row.kind === "address" &&
                row.source_type &&
                row.source_type !== "manual",
            ) ? (
              <span className="mt-2 block">
                {tr("protectedSelection", { count: protectedCount })}
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
              ? formatDateTime(row.last_synced_at)
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
                ? formatDateTime(source.last_seen_at)
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

