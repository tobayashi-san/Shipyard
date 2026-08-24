import { cloneElement, isValidElement, useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  DatabaseZap,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Settings2,
  Trash2,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ActiveFilterChips } from "@/components/ui/filter-chips";
import { TablePagination } from "@/components/ui/table-pagination";
import { OverflowItem, OverflowMenu, OverflowSep } from "@/components/ui/overflow-menu";
import i18n from "@/lib/i18n";
import { hasCap, useProfile } from "@/lib/queries";

interface Prefix {
  id: string;
  name: string;
  cidr: string;
  gateway?: string;
  dhcp_start?: string;
  dhcp_end?: string;
  dhcp_address_count?: number;
  vlan_id?: number | null;
  bridge?: string;
  description?: string;
  status: string;
  role?: string;
  parent_id?: string | null;
  child_prefix_count: number;
  child_prefix_address_count?: number;
  usable_address_count: number;
  used_address_count: number;
  free_address_count: number;
  reservation_count: number;
  range_count: number;
}
interface SyncSource {
  id: string;
  type: "unifi" | "pfsense";
  name: string;
  endpoint: string;
  site?: string;
  path?: string;
  insecure: boolean;
  enabled: boolean;
  auto_sync: boolean;
  sync_interval_min: number;
  api_token_configured: boolean;
  last_synced_at?: string;
  last_status?: string;
  last_error?: string;
  last_tested_at?: string;
  last_test_status?: string;
  last_test_error?: string;
  inventory_count?: number;
  record_count?: number;
  ignored_count?: number;
  conflict_count?: number;
}
interface SourceTestResult {
  records: number;
  matching_prefixes: number;
  outside_prefixes: number;
  samples?: Array<{
    address?: string;
    hostname?: string | null;
    mac_address?: string | null;
  }>;
}
interface Paginated<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}
interface PrefixPage extends Paginated<Prefix> {
  summary: {
    prefix_count: number;
    child_prefix_count: number;
    usable_address_count: number;
    used_address_count: number;
    free_address_count: number;
    reservation_count: number;
    range_count: number;
  };
}
interface SearchResult {
  id: string;
  kind: "prefix" | "address" | "range";
  label: string;
  secondary: string;
  subnet_id: string;
  subnet_cidr: string;
  status: string;
  description?: string;
  server_id?: string | null;
}
interface ProxmoxConnection { id: string; name: string }
const tr = (key: string, options?: Record<string, unknown>) =>
  String(i18n.t(`ipam.${key}`, options));
const statusLabel: Record<string, string> = {
  active: tr("active"),
  container: tr("container"),
  reserved: tr("reserved"),
  deprecated: tr("deprecated"),
};
const statusVariant = (
  status: string,
): "success" | "default" | "warning" | "muted" =>
  (({
    active: "success",
    container: "default",
    reserved: "warning",
    deprecated: "muted",
  })[status] || "muted") as "success" | "default" | "warning" | "muted";
export function NetworksPage() {
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const canEdit = hasCap(profile, "canEditServers");
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkVlanOpen, setBulkVlanOpen] = useState(false);
  const [bulkVlan, setBulkVlan] = useState("");
  const [bulkScanOpen, setBulkScanOpen] = useState(false);
  const [bulkConnectionId, setBulkConnectionId] = useState("");
  const query = useQuery({
    queryKey: ["ipam", "subnets", environmentId, page, deferredSearch, status],
    queryFn: () =>
      apiFetch<PrefixPage>(
        `/ipam/subnets?environment_id=${encodeURIComponent(environmentId)}&paginated=1&page=${page}&page_size=${pageSize}&status=${encodeURIComponent(status === "all-including-deprecated" ? "all" : status === "all" ? "current" : status)}&q=${encodeURIComponent(deferredSearch)}`,
      ),
  });
  const rows = Array.isArray(query.data?.items) ? query.data.items : [];
  const connections = useQuery({
    queryKey: ["opentofu", "proxmox-connections", environmentId],
    queryFn: () => apiFetch<ProxmoxConnection[]>(
      `/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`,
    ),
    retry: false,
  });
  const hierarchicalRows = useMemo(() => {
    const byParent = new Map<string | null, Prefix[]>();
    rows.forEach((prefix) => {
      const parent =
        prefix.parent_id &&
        rows.some((candidate) => candidate.id === prefix.parent_id)
          ? prefix.parent_id
          : null;
      byParent.set(parent, [...(byParent.get(parent) || []), prefix]);
    });
    const sort = (items: Prefix[]) =>
      items.sort((left, right) =>
        left.cidr.localeCompare(right.cidr, undefined, { numeric: true }),
      );
    const visit = (
      parentId: string | null,
      depth: number,
    ): Array<{ prefix: Prefix; depth: number }> =>
      sort(byParent.get(parentId) || []).flatMap((prefix) => [
        { prefix, depth },
        ...visit(prefix.id, depth + 1),
      ]);
    return visit(null, 0);
  }, [rows]);
  // Only top-level prefixes belong in the environment total. Child prefixes
  // already consume capacity inside their parent and must not be counted twice.
  const visibleIds = hierarchicalRows.map(({ prefix }) => prefix.id);
  const selectedCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const selectedPrefixIds = visibleIds.filter((id) => selectedIds.has(id));
  const allSelected =
    visibleIds.length > 0 && selectedCount === visibleIds.length;
  const someSelected = selectedCount > 0 && !allSelected;
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [deferredSearch, environmentId, status]);
  useEffect(() => {
    if (query.data && page > query.data.total_pages) setPage(query.data.total_pages);
  }, [page, query.data]);
  const updateStatus = useMutation({
    mutationFn: ({ ids, value }: { ids: string[]; value: string }) =>
      Promise.all(
        ids.map((id) =>
          apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/status`, {
            method: "PATCH",
            body: { status: value },
          }),
        ),
      ),
    onSuccess: (_result, variables) => {
      setSelectedIds(new Set());
      showToast(
        tr("prefixesMarked", {
          count: variables.ids.length,
          status: statusLabel[variables.value] || variables.value,
        }),
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["ipam", "subnets", environmentId],
      });
    },
    onError: (error: Error) =>
      showToast(
        error.message || tr("prefixStatusFailed"),
        "error",
      ),
  });
  const bulkVlanMutation = useMutation({
    mutationFn: () => Promise.all(selectedPrefixIds.map((id) =>
      apiFetch(`/ipam/subnets/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { vlan_id: bulkVlan.trim() ? Number(bulkVlan) : null },
      }),
    )),
    onSuccess: () => {
      showToast(tr("bulkVlanUpdated", { count: selectedPrefixIds.length }), "success");
      setBulkVlanOpen(false);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const bulkDeleteMutation = useMutation({
    mutationFn: () => Promise.all(selectedPrefixIds.map((id) =>
      apiFetch(`/ipam/subnets/${encodeURIComponent(id)}`, { method: "DELETE" }),
    )),
    onSuccess: () => {
      showToast(tr("bulkPrefixesDeleted", { count: selectedPrefixIds.length }), "success");
      setBulkDeleteOpen(false);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const bulkScanMutation = useMutation({
    mutationFn: () => Promise.all(selectedPrefixIds.map((subnetId) =>
      apiFetch(`/opentofu/proxmox-connections/${encodeURIComponent(bulkConnectionId)}/sync-ipam`, {
        method: "POST",
        body: { subnet_id: subnetId },
      }),
    )),
    onSuccess: () => {
      showToast(tr("bulkPrefixesScanned", { count: selectedPrefixIds.length }), "success");
      setBulkScanOpen(false);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const toggle = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["ipam"] });
  return (
    <div className="space-y-5">
      <PageHeader
        title={tr("title")}
        description={tr("description")}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={refresh}
            >
              <RefreshCw
                className={query.isFetching ? "animate-spin" : undefined}
              />
              {tr("refresh")}
            </Button>
            <Button variant="outline" asChild>
              <Link to="/networks/sources"><DatabaseZap />{tr("sources")}</Link>
            </Button>
            {canEdit && <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              {tr("addPrefix")}
            </Button>}
          </div>
        }
      />
      <GlobalIpamSearch environmentId={environmentId} />
      {query.isError ? (
        <Card>
          <EmptyState
            compact
            icon={<AlertTriangle className="h-5 w-5" />}
            title={tr("loadError")}
            description={tr("loadErrorDescription")}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                <RefreshCw />
                {tr("tryAgain")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="gap-0 border-b bg-muted/15 p-0">
              <div className="console-toolbar gap-3 border-0">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Network className="h-4 w-4" />
                    {tr("prefixes")}{" "}
                    <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {rows.length}
                    </span>
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr("prefixInventoryDescription")}
                  </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  {canEdit && selectedCount > 0 && (
                    <>
                      <span className="whitespace-nowrap text-xs font-medium tabular-nums">
                        {tr("selected", { count: selectedCount })}
                      </span>
                      <OverflowMenu title={tr("bulkActions")} trigger={tr("bulkActions")}>
                        <OverflowItem disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ ids: selectedPrefixIds, value: "active" })}>{tr("active")}</OverflowItem>
                        <OverflowItem disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ ids: selectedPrefixIds, value: "deprecated" })}>{tr("deprecated")}</OverflowItem>
                        <OverflowSep />
                        <OverflowItem icon={ServerCog} onClick={() => setBulkScanOpen(true)}>{tr("scan")}</OverflowItem>
                        <OverflowItem icon={Pencil} onClick={() => setBulkVlanOpen(true)}>{tr("assignVlan")}</OverflowItem>
                        <OverflowSep />
                        <OverflowItem icon={Trash2} danger onClick={() => setBulkDeleteOpen(true)}>{tr("delete")}</OverflowItem>
                      </OverflowMenu>
                    </>
                  )}
                  <label className="relative min-w-0 flex-1 sm:w-64">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="pl-8"
                      placeholder={tr("searchPrefixes")}
                      aria-label={tr("searchPrefixes")}
                    />
                  </label>
                  <Button
                    type="button"
                    variant={status !== "all" ? "secondary" : "outline"}
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <Settings2 />
                    {status !== "all" ? tr("filterCount", { count: 1 }) : tr("filter")}
                  </Button>
                </div>
              </div>
              {filtersOpen && (
                <div className="flex flex-wrap items-center gap-2 border-t bg-background/60 px-4 py-2.5">
                  <Label
                    htmlFor="prefix-status-filter"
                    className="text-xs text-muted-foreground"
                  >
                    {tr("status")}
                  </Label>
                  <select
                    id="prefix-status-filter"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="all">{tr("currentStatuses")}</option>
                    <option value="all-including-deprecated">
                      {tr("allStatusesDeprecated")}
                    </option>
                    {Object.entries(statusLabel).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {status !== "all" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setStatus("all")}
                    >
                      {tr("reset")}
                    </Button>
                  )}
                </div>
              )}
              <ActiveFilterChips
                className="rounded-none border-x-0 border-b-0"
                filters={status !== "all" ? [{
                  id: "status",
                  label: `${tr("status")}: ${status === "all-including-deprecated" ? tr("allStatusesDeprecated") : statusLabel[status] || status}`,
                  onRemove: () => { setStatus("all"); setPage(1); },
                }] : []}
                onClear={() => { setStatus("all"); setPage(1); }}
                clearLabel={tr("reset")}
              />
            </CardHeader>
            <CardContent className="p-0">
              {query.isPending ? (
                <EmptyState compact title={tr("loadingPrefixes")} />
              ) : hierarchicalRows.length === 0 ? (
                <p className="p-10 text-sm text-muted-foreground">
                  {tr("noPrefixes")}
                </p>
              ) : (
                <>
                  <div className="table-scroll">
                    <table
                      className="w-full min-w-[940px] text-sm"
                      data-density="compact"
                    >
                      <thead>
                        <tr>
                          {canEdit && <th className="w-11 px-3">
                            <input
                              type="checkbox"
                              aria-label={tr("selectAllPrefixes")}
                              checked={allSelected}
                              ref={(input) => {
                                if (input) input.indeterminate = someSelected;
                              }}
                              onChange={() =>
                                setSelectedIds(
                                  allSelected ? new Set() : new Set(visibleIds),
                                )
                              }
                            />
                          </th>}
                          <th className="px-3">{tr("prefixNameColumn")}</th>
                          <th className="px-3">{tr("status")}</th>
                          <th className="px-3">{tr("vlanBridge")}</th>
                          <th className="px-3">{tr("descriptionLabel")}</th>
                          <th className="w-10 px-3">
                            <span className="sr-only">{tr("open")}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {hierarchicalRows.map(({ prefix, depth }) => (
                          <PrefixRow
                            key={prefix.id}
                            prefix={prefix}
                            depth={depth}
                            checked={selectedIds.has(prefix.id)}
                            onToggle={() => toggle(prefix.id)}
                            canSelect={canEdit}
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
              totalItems={query.data?.total || 0}
              onPageChange={setPage}
              disabled={query.isFetching}
              itemLabel={tr("prefixesPagination")}
            />
          </Card>
        </>
      )}
      {canEdit && <CreatePrefixDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        environmentId={environmentId}
      />}
      <Dialog open={bulkVlanOpen} onOpenChange={setBulkVlanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tr("assignVlan")}</DialogTitle>
            <DialogDescription>{tr("assignVlanDescription", { count: selectedCount })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-vlan">{tr("vlanId")}</Label>
            <Input id="bulk-vlan" type="number" min={1} max={4094} value={bulkVlan} onChange={(event) => setBulkVlan(event.target.value)} placeholder={tr("vlanExample")} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkVlanOpen(false)}>{tr("cancel")}</Button>
            <Button disabled={bulkVlanMutation.isPending} onClick={() => bulkVlanMutation.mutate()}>{tr("apply")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bulkScanOpen} onOpenChange={setBulkScanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tr("scanPrefixes")}</DialogTitle>
            <DialogDescription>{tr("scanPrefixesDescription", { count: selectedCount })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-scan-connection">{tr("proxmoxConnection")}</Label>
            <select id="bulk-scan-connection" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={bulkConnectionId} onChange={(event) => setBulkConnectionId(event.target.value)}>
              <option value="">{tr("selectConnection")}</option>
              {(connections.data || []).map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkScanOpen(false)}>{tr("cancel")}</Button>
            <Button disabled={!bulkConnectionId || bulkScanMutation.isPending} onClick={() => bulkScanMutation.mutate()}><ServerCog /> {tr("scan")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={tr("deletePrefixesTitle", { count: selectedCount })}
        description={tr("deletePrefixesDescription")}
        confirmLabel={tr("delete")}
        cancelLabel={tr("cancel")}
        variant="destructive"
        onConfirm={() => bulkDeleteMutation.mutate()}
        isPending={bulkDeleteMutation.isPending}
      />
    </div>
  );
}

function GlobalIpamSearch({ environmentId }: { environmentId: string }) {
  const [value, setValue] = useState("");
  const deferredValue = useDeferredValue(value.trim());
  const results = useQuery({
    queryKey: ["ipam", "global-search", environmentId, deferredValue],
    queryFn: () => apiFetch<Paginated<SearchResult>>(
      `/ipam/search?environment_id=${encodeURIComponent(environmentId)}&q=${encodeURIComponent(deferredValue)}&page=1&page_size=12`,
    ),
    enabled: deferredValue.length > 0,
  });
  const rows = results.data?.items || [];
  return (
    <Card className="relative z-20">
      <CardContent className="p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="pl-9"
            placeholder={tr("globalSearch")}
            aria-label={tr("globalSearchLabel")}
          />
        </label>
        {deferredValue && (
          <div className="mt-3 overflow-hidden rounded-md border">
            {results.isPending ? (
              <p className="p-3 text-sm text-muted-foreground">{tr("searching")}</p>
            ) : results.isError ? (
              <p className="p-3 text-sm text-destructive">{tr("searchFailed")}</p>
            ) : rows.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{tr("searchEmpty")}</p>
            ) : (
              <div className="divide-y">
                {rows.map((row) => (
                  <Link
                    key={`${row.kind}:${row.id}`}
                    to="/networks/$id"
                    params={{ id: row.subnet_id }}
                    className="flex items-center justify-between gap-4 px-3 py-2.5 hover:bg-muted/30"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{row.kind}</Badge>
                        <span className="truncate font-mono text-sm font-medium">{row.label}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.secondary}</p>
                    </div>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.subnet_cidr}</span>
                  </Link>
                ))}
                {(results.data?.total || 0) > rows.length && (
                  <p className="bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                    {tr("searchMore", { shown: rows.length, total: results.data?.total })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function IpamSourcesDialog({
  open = true,
  onOpenChange = () => undefined,
  environmentId,
  embedded = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  environmentId: string;
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const canEdit = hasCap(profile, "canEditServers");
  const [creating, setCreating] = useState(false);
  const [editingSource, setEditingSource] = useState<SyncSource | null>(null);
  const [type, setType] = useState<"unifi" | "pfsense">("unifi");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [site, setSite] = useState("default");
  const [path, setPath] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [syncInterval, setSyncInterval] = useState("15");
  const [sourceToRemove, setSourceToRemove] = useState<SyncSource | null>(null);
  const [sourceToSync, setSourceToSync] = useState<SyncSource | null>(null);
  const [testReport, setTestReport] = useState<{
    source: SyncSource;
    result: SourceTestResult;
  } | null>(null);
  const query = useQuery({
    queryKey: ["ipam", "sources", environmentId],
    queryFn: () =>
      apiFetch<SyncSource[]>(
        `/ipam/sources?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    enabled: open || embedded,
  });
  const sources = Array.isArray(query.data) ? query.data : [];
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: ["ipam", "sources", environmentId],
    });
  const resetForm = () => {
    setCreating(false);
    setEditingSource(null);
    setName("");
    setEndpoint("");
    setToken("");
    setPath("");
    setSite("default");
    setInsecure(false);
    setEnabled(true);
    setAutoSync(true);
    setSyncInterval("15");
  };
  const save = useMutation({
    mutationFn: () =>
      editingSource
        ? apiFetch(`/ipam/sources/${encodeURIComponent(editingSource.id)}`, {
            method: "PUT",
            body: {
              type,
              name,
              endpoint,
              api_token: token || undefined,
              site,
              path,
              insecure,
              enabled,
              auto_sync: autoSync,
              sync_interval_min: syncInterval,
            },
          })
        : apiFetch("/ipam/sources", {
            method: "POST",
            body: {
              environment_id: environmentId,
              type,
              name,
              endpoint,
              api_token: token,
              site,
              path,
              insecure,
              enabled,
              auto_sync: autoSync,
              sync_interval_min: syncInterval,
            },
          }),
    onSuccess: () => {
      const wasEditing = Boolean(editingSource);
      resetForm();
      refresh();
      showToast(
        wasEditing ? tr("sourceUpdated") : tr("sourceSaved"),
        "success",
      );
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const test = useMutation({
    mutationFn: (source: SyncSource) =>
      apiFetch<SourceTestResult>(
        `/ipam/sources/${encodeURIComponent(source.id)}/test`,
        { method: "POST" },
      ),
    onSuccess: (result, source) => {
      refresh();
      setTestReport({ source, result });
      showToast(
        tr("connectionSuccess", { count: result.records }),
        result.matching_prefixes ? "success" : "warning",
      );
    },
    onError: (error: Error) => {
      refresh();
      showToast(error.message, "error");
    },
  });
  const sync = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{
        created: number;
        updated: number;
        removed: number;
        conflicts: number;
        ignored: number;
      }>(`/ipam/sources/${encodeURIComponent(id)}/sync`, { method: "POST" }),
    onSuccess: (result) => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
      const changes = [
        tr("syncCreated", { count: result.created }),
        tr("syncUpdated", { count: result.updated }),
      ];
      if (result.removed) changes.push(tr("syncReleased", { count: result.removed }));
      if (result.conflicts) changes.push(tr("syncConflicts", { count: result.conflicts }));
      if (result.ignored)
        changes.push(tr("syncOutside", { count: result.ignored }));
      showToast(
        tr("syncResult", { changes: changes.join(", ") }),
        result.conflicts ? "warning" : "success",
      );
    },
    onError: (error: Error) => {
      refresh();
      showToast(error.message, "error");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/ipam/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      setSourceToRemove(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
      showToast(
        tr("sourceRemoved"),
        "success",
      );
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const beginCreate = () => {
    resetForm();
    setType("unifi");
    setCreating(true);
  };
  const beginEdit = (source: SyncSource) => {
    setEditingSource(source);
    setType(source.type);
    setName(source.name);
    setEndpoint(source.endpoint);
    setToken("");
    setSite(source.site || "default");
    setPath(
      source.type === "pfsense" && source.path === "/api/v2/status/dhcp_leases"
        ? "/api/v2/status/dhcp_server/leases"
        : source.path || "",
    );
    setInsecure(source.insecure);
    setEnabled(source.enabled);
    setAutoSync(source.auto_sync !== false);
    setSyncInterval(String(source.sync_interval_min || 15));
    setCreating(true);
  };
  const defaultPath =
    type === "unifi"
      ? `/proxy/network/api/s/${encodeURIComponent(site || "default")}/stat/sta`
      : "/api/v2/status/dhcp_server/leases";
  const endpointPlaceholder =
    type === "pfsense"
      ? tr("pfsenseEndpointPlaceholder")
      : tr("sourceEndpointPlaceholder");
  const content = (
    <>
          {!embedded && (
            <DialogHeader className="min-w-0 border-b px-4 py-4 text-left sm:px-5">
              <DialogTitle className="flex items-center gap-2">
                <DatabaseZap className="h-5 w-5" />
                {tr("sourceTitle")}
              </DialogTitle>
              <DialogDescription>{tr("sourceDescription")}</DialogDescription>
            </DialogHeader>
          )}
          <div className="min-w-0 space-y-4 p-3 sm:p-5">
            <div className="rounded-sm border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <strong className="text-foreground">{tr("automaticMaintenance")}</strong>{" "}
              {tr("automaticMaintenanceDescription")}
            </div>
            {query.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/[0.04] p-4 text-sm">
                <div className="font-medium text-destructive">
                  {tr("sourcesLoadFailed")}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {tr("sourcesLoadFailedDescription")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void query.refetch()}
                >
                  <RefreshCw />
                  {tr("tryAgain")}
                </Button>
              </div>
            ) : query.isPending ? (
              <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                {tr("loadingSources")}
              </div>
            ) : (
              <>
                {sources.length > 0 && (
                  <div data-ipam-source-list className="space-y-3">
                    {sources.map((source) => {
                      const testing = test.isPending;
                      const syncing = sync.isPending;
                      const testStatus =
                        source.last_test_status === "success"
                          ? {
                              label: tr("connectionVerified"),
                              variant: "success" as const,
                            }
                          : source.last_test_status === "failed"
                            ? {
                                label: tr("connectionFailed"),
                                variant: "destructive" as const,
                              }
                            : {
                                label: tr("notChecked"),
                                variant: "outline" as const,
                              };
                      const syncStatus =
                        source.last_status === "failed"
                          ? {
                              label: tr("lastSyncFailed"),
                              variant: "destructive" as const,
                            }
                          : source.last_synced_at
                            ? {
                                label: tr("synchronized"),
                                variant: "success" as const,
                              }
                            : {
                                label: tr("notSynchronized"),
                                variant: "outline" as const,
                              };

                      return (
                        <section
                          key={source.id}
                          className="min-w-0 overflow-hidden rounded-[3px] border border-border-strong/70 bg-card"
                        >
                          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium">{source.name}</h3>
                                <Badge variant="outline">
                                  {source.type === "unifi"
                                    ? "UniFi"
                                    : "pfSense"}
                                </Badge>
                                {!source.enabled && (
                                  <Badge variant="muted">{tr("disabled")}</Badge>
                                )}
                              </div>
                              <p
                                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                                title={`${source.endpoint}${source.path || ""}`}
                              >
                                {source.endpoint}
                                {source.path || ""}
                              </p>
                            </div>
                            {canEdit && <div className="ipam-source-actions">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`${tr("test")} ${source.name}`}
                                disabled={testing || !source.enabled}
                                className="w-full min-w-0 max-w-full overflow-hidden px-2 text-xs sm:w-auto sm:px-3 sm:text-sm"
                                onClick={() => test.mutate(source)}
                              >
                                <RefreshCw
                                  className={
                                    testing
                                      ? "hidden h-4 w-4 animate-spin sm:mr-1.5 sm:block"
                                      : "hidden h-4 w-4 sm:mr-1.5 sm:block"
                                  }
                                />
                                <span className="sm:hidden">{tr("test")}</span>
                                <span className="hidden sm:inline">{tr("testConnection")}</span>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                aria-label={`${tr("sync")} ${source.name}`}
                                disabled={syncing || !source.enabled}
                                className="w-full min-w-0 max-w-full overflow-hidden px-2 text-xs sm:w-auto sm:px-3 sm:text-sm"
                                onClick={() => setSourceToSync(source)}
                              >
                                <DatabaseZap className="hidden h-4 w-4 sm:mr-1.5 sm:block" />
                                <span className="sm:hidden">{tr("sync")}</span>
                                <span className="hidden sm:inline">{tr("syncNow")}</span>
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title={tr("editSource")}
                                aria-label={`${tr("editSource")} ${source.name}`}
                                onClick={() => beginEdit(source)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title={tr("removeSource")}
                                aria-label={`${tr("removeSource")} ${source.name}`}
                                className="text-destructive hover:text-destructive"
                                onClick={() => setSourceToRemove(source)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>}
                          </div>

                          <div className="grid border-t bg-muted/[0.18] sm:grid-cols-3">
                            <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("connection")}
                              </p>
                              <div className="mt-1.5">
                                <Badge variant={testStatus.variant}>
                                  {testStatus.label}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.last_tested_at
                                  ? tr("testedAt", { date: new Date(source.last_tested_at).toLocaleString() })
                                  : tr("noConnectionTest")}
                              </p>
                              {source.last_test_error && (
                                <p
                                  className="mt-1 truncate text-xs text-destructive"
                                  title={source.last_test_error}
                                >
                                  {source.last_test_error}
                                </p>
                              )}
                            </div>
                            <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("synchronization")}
                              </p>
                              <div className="mt-1.5">
                                <Badge variant={syncStatus.variant}>
                                  {syncStatus.label}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.last_synced_at
                                  ? tr("lastSyncAt", { date: new Date(source.last_synced_at).toLocaleString() })
                                  : tr("noImport")}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {source.auto_sync !== false
                                  ? tr("automaticInterval", { count: source.sync_interval_min || 15 })
                                  : tr("automaticDisabled")}
                              </p>
                            </div>
                            <div className="px-4 py-3">
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {tr("observedInventory")}
                              </p>
                              <div className="mt-1.5 flex items-baseline gap-2">
                                <span className="text-lg font-semibold tabular-nums">
                                  {source.record_count || 0}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                  {tr("ipAddresses")}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {tr("sourceInventoryBreakdown", {
                                  imported: source.inventory_count || 0,
                                  outside: source.ignored_count || 0,
                                })}
                              </p>
                              <div className="mt-1">
                                {source.conflict_count ? (
                                  <Badge variant="destructive">
                                    {tr("conflictCount", { count: source.conflict_count })}
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary">
                                    {tr("noConflicts")}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
                {sources.length === 0 && !creating && (
                  <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {tr("noSources")}
                  </div>
                )}
              </>
            )}
            {canEdit && (creating ? (
              <form
                className="space-y-4 rounded-md border bg-muted/15 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate();
                }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">
                      {editingSource
                        ? tr("editSource")
                        : tr("addSource")}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {editingSource
                        ? tr("tokenKeepHint")
                        : tr("credentialsHint")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={resetForm}
                  >
                    {tr("cancel")}
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={tr("system")}>
                    <select
                      value={type}
                      onChange={(event) =>
                        setType(event.target.value as "unifi" | "pfsense")
                      }
                      className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
                    >
                      <option value="unifi">{tr("unifiNetwork")}</option>
                      <option value="pfsense">{tr("pfsense")}</option>
                    </select>
                  </Field>
                  <Field label={tr("displayName")}>
                    <Input
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={
                        type === "pfsense"
                          ? tr("pfsenseProductionExample")
                          : tr("unifiProductionExample")
                      }
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label={tr("controllerUrl")}>
                      <Input
                        required
                        type="url"
                        value={endpoint}
                        onChange={(event) => setEndpoint(event.target.value)}
                        placeholder={endpointPlaceholder}
                      />
                    </Field>
                  </div>
                  {type === "pfsense" && (
                    <div className="sm:col-span-2 rounded-md border bg-background p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">{tr("pfsenseSetupTitle")}</p>
                      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                        <li>{tr("pfsenseSetupInstall")}</li>
                        <li>{tr("pfsenseSetupKey")}</li>
                        <li>{tr("pfsenseSetupAccess")}</li>
                      </ol>
                      <p className="mt-2">{tr("pfsenseReadOnlyHint")}</p>
                      <p className="mt-2">
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href="https://pfrest.org/INSTALL_AND_CONFIG/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tr("pfsenseInstallDocs")}
                        </a>
                        {" · "}
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href="https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tr("pfsenseAuthDocs")}
                        </a>
                      </p>
                    </div>
                  )}
                  <Field
                    label={editingSource ? tr("apiTokenOptional") : tr("apiToken")}
                  >
                    <Input
                      required={!editingSource}
                      type="password"
                      autoComplete="new-password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </Field>
                  {type === "unifi" && (
                    <Field label={tr("unifiSite")}>
                      <Input
                        value={site}
                        onChange={(event) => setSite(event.target.value)}
                        placeholder={tr("defaultSitePlaceholder")}
                      />
                    </Field>
                  )}
                  <div className="sm:col-span-2">
                    <details>
                      <summary className="cursor-pointer text-sm text-muted-foreground">
                        {tr("advancedConnection")}
                      </summary>
                      <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
                        <Field label={tr("apiPath")}>
                          <Input
                            value={path}
                            onChange={(event) => setPath(event.target.value)}
                            placeholder={defaultPath}
                          />
                        </Field>
                        <label className="flex items-center gap-2 self-end text-sm">
                          <input
                            type="checkbox"
                            checked={insecure}
                            onChange={(event) =>
                              setInsecure(event.target.checked)
                            }
                          />
                          {tr("skipTls")}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) =>
                              setEnabled(event.target.checked)
                            }
                          />
                          {tr("sourceActive")}
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={autoSync}
                            onChange={(event) =>
                              setAutoSync(event.target.checked)
                            }
                          />
                          {tr("autoSync")}
                        </label>
                        <Field label={tr("syncInterval")}>
                          <Input
                            type="number"
                            min="5"
                            max="1440"
                            disabled={!autoSync}
                            value={syncInterval}
                            onChange={(event) =>
                              setSyncInterval(event.target.value)
                            }
                          />
                        </Field>
                      </div>
                    </details>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={resetForm}>
                    {tr("cancel")}
                  </Button>
                  <Button type="submit" disabled={save.isPending}>
                    <Settings2 />
                    {editingSource
                      ? tr("updateSource")
                      : tr("saveSource")}
                  </Button>
                </div>
              </form>
            ) : (
              <Button type="button" variant="outline" onClick={beginCreate}>
                <Plus />
                {tr("addSource")}
              </Button>
            ))}
          </div>
          {!embedded && (
            <DialogFooter className="border-t px-5 py-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tr("close")}
              </Button>
            </DialogFooter>
          )}
    </>
  );
  return (
    <>
      {embedded ? (
        <Card data-ipam-sources className="min-w-0 overflow-hidden">{content}</Card>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 max-w-3xl overflow-x-hidden overflow-y-auto p-0">
            {content}
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(sourceToSync)}
        onOpenChange={(nextOpen) => !nextOpen && setSourceToSync(null)}
        title={tr("confirmSyncTitle")}
        description={sourceToSync ? tr("confirmSyncDescription", { name: sourceToSync.name }) : ""}
        confirmLabel={tr("syncNow")}
        cancelLabel={tr("cancel")}
        variant="warning"
        onConfirm={() => sourceToSync && sync.mutate(sourceToSync.id)}
        isPending={sync.isPending}
      />
      <ConfirmDialog
        open={Boolean(sourceToRemove)}
        onOpenChange={(nextOpen) => !nextOpen && setSourceToRemove(null)}
        title={tr("confirmRemoveSource")}
        description={sourceToRemove ? tr("confirmRemoveSourceDescription", {
          name: sourceToRemove.name,
          count: sourceToRemove.inventory_count || 0,
        }) : ""}
        confirmLabel={tr("removeSource")}
        cancelLabel={tr("cancel")}
        variant="destructive"
        onConfirm={() => sourceToRemove && remove.mutate(sourceToRemove.id)}
        isPending={remove.isPending}
      />
      <Dialog
        open={Boolean(testReport)}
        onOpenChange={(nextOpen) => !nextOpen && setTestReport(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tr("sourceChecked")}</DialogTitle>
            <DialogDescription>
              {testReport && (
                tr("sourceReachable", { name: testReport.source.name })
              )}
            </DialogDescription>
          </DialogHeader>
          {testReport && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 overflow-hidden rounded-md border">
                <SourceTestFact
                  label={tr("detected")}
                  value={testReport.result.records}
                />
                <SourceTestFact
                  label={tr("inIpam")}
                  value={testReport.result.matching_prefixes}
                />
                <SourceTestFact
                  label={tr("outside")}
                  value={testReport.result.outside_prefixes}
                />
              </div>
              {testReport.result.outside_prefixes > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  {tr("outsidePrefixWarning")}
                </div>
              )}
              {testReport.result.samples?.length ? (
                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                    {tr("sampleLeases")}
                  </div>
                  <ul className="divide-y">
                    {testReport.result.samples
                      .slice(0, 3)
                      .map((sample, index) => (
                        <li
                          key={`${sample.address || "unknown"}-${index}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <span className="font-mono">
                            {sample.address || "—"}
                          </span>
                          <span className="min-w-0 text-right text-muted-foreground">
                            <span className="block truncate">
                              {sample.hostname || tr("noHostname")}
                            </span>
                            {sample.mac_address && (
                              <span className="block truncate font-mono text-xs">
                                {sample.mac_address}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {tr("noUsableLeases")}
                </p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {tr("reviewSyncHint")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setTestReport(null)}>
              {tr("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SourceTestFact({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r px-3 py-2.5 last:border-r-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function PrefixRow({
  prefix,
  depth,
  checked,
  onToggle,
  canSelect,
}: {
  prefix: Prefix;
  depth: number;
  checked: boolean;
  onToggle: () => void;
  canSelect: boolean;
}) {
  return (
    <tr data-selected={checked || undefined}>
      {canSelect && <td className="px-3">
        <input
          type="checkbox"
          aria-label={tr("selectPrefix", { cidr: prefix.cidr })}
          checked={checked}
          onChange={onToggle}
        />
      </td>}
      <td className="px-3">
        <Link
          to="/networks/$id"
          params={{ id: prefix.id }}
          className="flex min-w-0 items-center gap-2 hover:text-primary"
          style={{ paddingLeft: `${Math.min(depth, 6) * 20}px` }}
        >
          <Network className="h-4 w-4 shrink-0 text-brand" />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold text-foreground">
              {prefix.name || prefix.cidr}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {prefix.cidr}
              </span>
              {prefix.child_prefix_count > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {tr("childCount", { count: prefix.child_prefix_count })}
                </span>
              )}
            </span>
          </span>
        </Link>
      </td>
      <td className="px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant={statusVariant(prefix.status)}>
            {statusLabel[prefix.status] || prefix.status}
          </Badge>
          {prefix.role && (
            <span className="truncate text-xs text-muted-foreground">
              {prefix.role}
            </span>
          )}
        </div>
      </td>
      <td className="px-3">
        <span>{prefix.vlan_id ? `VLAN ${prefix.vlan_id}` : "—"}</span>
        <span className="ml-1.5 font-mono text-xs text-muted-foreground">
          {prefix.bridge || "—"}
        </span>
        {prefix.dhcp_start && prefix.dhcp_end && (
          <div className="mt-1 flex items-center gap-1.5 text-xs">
            <Badge variant="outline">{tr("dhcp")}</Badge>
            <span className="font-mono text-muted-foreground">
              {prefix.dhcp_start} – {prefix.dhcp_end}
            </span>
          </div>
        )}
      </td>
      <td className="max-w-[250px] px-3">
        <span className="block truncate text-muted-foreground">
          {prefix.description || "—"}
        </span>
      </td>
      <td className="px-3">
        <Link
          to="/networks/$id"
          params={{ id: prefix.id }}
          aria-label={tr("openPrefix", { cidr: prefix.cidr })}
          className="inline-flex text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  );
}

function CreatePrefixDialog({
  open,
  onOpenChange,
  environmentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [cidr, setCidr] = useState("");
  const [gateway, setGateway] = useState("");
  const [dhcpStart, setDhcpStart] = useState("");
  const [dhcpEnd, setDhcpEnd] = useState("");
  const [dns, setDns] = useState("");
  const [vlan, setVlan] = useState("");
  const [bridge, setBridge] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("active");
  const [role, setRole] = useState("");
  const create = useMutation({
    mutationFn: () =>
      apiFetch("/ipam/subnets", {
        method: "POST",
        body: {
          environment_id: environmentId,
          name,
          cidr,
          gateway,
          dhcp_start: dhcpStart,
          dhcp_end: dhcpEnd,
          vlan_id: vlan,
          bridge,
          description,
          status,
          role,
          dns_servers: dns
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      showToast(tr("prefixCreated"), "success");
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["ipam"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("addPrefix")}</DialogTitle>
          <DialogDescription>
            {tr("addPrefixDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("name")}>
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={tr("productionNetworkPlaceholder")}
              />
            </Field>
            <Field label={tr("ipv4Prefix")}>
              <Input
                required
                value={cidr}
                onChange={(event) => setCidr(event.target.value)}
                placeholder="10.20.10.0/24"
              />
            </Field>
          </div>
          <details className="rounded-md border bg-muted/15">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
              {tr("advancedNetwork")}
            </summary>
            <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
              <Field label={tr("status")}>
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
                >
                  {Object.entries(statusLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tr("role")}>
                <Input
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder={tr("productionRoleExample")}
                />
              </Field>
              <Field label={tr("gateway")}>
                <Input
                  value={gateway}
                  onChange={(event) => setGateway(event.target.value)}
                  placeholder="10.20.10.1"
                />
              </Field>
              <Field label={tr("dhcpStart")}>
                <Input
                  value={dhcpStart}
                  onChange={(event) => setDhcpStart(event.target.value)}
                  placeholder="10.20.10.100"
                  inputMode="decimal"
                />
              </Field>
              <Field label={tr("dhcpEnd")}>
                <Input
                  value={dhcpEnd}
                  onChange={(event) => setDhcpEnd(event.target.value)}
                  placeholder="10.20.10.200"
                  inputMode="decimal"
                />
              </Field>
              <p className="sm:col-span-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {tr("dhcpRangeHint")}
              </p>
              <Field label={tr("dnsServers")}>
                <Input
                  value={dns}
                  onChange={(event) => setDns(event.target.value)}
                  placeholder="10.20.10.10, 10.20.10.11"
                />
              </Field>
              <Field label={tr("vlanId")}>
                <Input
                  value={vlan}
                  onChange={(event) => setVlan(event.target.value)}
                  inputMode="numeric"
                  placeholder="2010"
                />
              </Field>
              <Field label={tr("bridge")}>
                <Input
                  value={bridge}
                  onChange={(event) => setBridge(event.target.value)}
                  placeholder={tr("bridgePlaceholder")}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label={tr("descriptionLabel")}>
                  <Input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={tr("productionNetworkExample")}
                  />
                </Field>
              </div>
            </div>
          </details>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tr("cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {tr("addPrefix")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
