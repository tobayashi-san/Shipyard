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
import { ActiveFilterChips } from "@/components/ui/filter-chips";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverflowItem, OverflowMenu, OverflowSep } from "@/components/ui/overflow-menu";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { TablePagination } from "@/components/ui/table-pagination";
import { CreatePrefixDialog } from '@/features/ipam/CreatePrefixDialog';
import { GlobalIpamSearch } from '@/features/ipam/GlobalIpamSearch';
import { Prefix, PrefixPage, ProxmoxConnection, statusLabel, tr } from '@/features/ipam/prefix-model';
import { PrefixMobileCard, PrefixRow } from '@/features/ipam/PrefixRows';
import { apiFetch } from "@/lib/api";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	DatabaseZap,
	Network,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	ServerCog,
	Settings2,
	Trash2
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";



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
    refetchInterval: 60_000,
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
  const [addressMatches, setAddressMatches] = useState(0);
  // Hide the description column while no prefix has one.
  const showDescription = rows.some(prefix => prefix.description);
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
  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title={tr("title")}
        description={tr("description")}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
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
          <Card className="min-w-0 overflow-hidden">
            <CardHeader className="gap-0 border-b bg-muted/15 p-0">
              <div className="console-toolbar gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Network className="h-4 w-4" />
                    {tr("prefixes")}{" "}
                    <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {rows.length}
                    </span>
                  </CardTitle>
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
                  <label className="relative min-w-0 flex-1 sm:w-80">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="pl-8"
                      placeholder={tr("globalSearch")}
                      aria-label={tr("globalSearchLabel")}
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
              <GlobalIpamSearch environmentId={environmentId} value={search} onMatches={setAddressMatches} />
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
            <CardContent className="min-w-0 p-0">
              {query.isPending ? (
                <EmptyState compact title={tr("loadingPrefixes")} />
              ) : hierarchicalRows.length === 0 ? (
                // Address matches above already answer the search; only say "nothing" when nothing matched.
                addressMatches > 0 ? null : <EmptyState compact title={search.trim() ? tr("noResults") : tr("noPrefixes")} />
              ) : (
                <>
                  <div className="hidden md:block">
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
                          <th className="px-3">{tr("usageColumn")}</th>
                          <th className="px-3">{tr("vlanBridge")}</th>
                          {showDescription && <th className="px-3">{tr("descriptionLabel")}</th>}
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
                            showDescription={showDescription}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="divide-y md:hidden">
                    {hierarchicalRows.map(({ prefix, depth }) => (
                      <PrefixMobileCard
                        key={prefix.id}
                        prefix={prefix}
                        depth={depth}
                        checked={selectedIds.has(prefix.id)}
                        onToggle={() => toggle(prefix.id)}
                        canSelect={canEdit}
                      />
                    ))}
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
          {connections.isError ? (
            <QueryErrorState
              compact
              error={connections.error}
              title={tr("proxmoxConnectionsFailed")}
              onRetry={() => void connections.refetch()}
            />
          ) : <div className="space-y-2">
            <Label htmlFor="bulk-scan-connection">{tr("proxmoxConnection")}</Label>
            <select id="bulk-scan-connection" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={bulkConnectionId} onChange={(event) => setBulkConnectionId(event.target.value)}>
              <option value="">{tr("selectConnection")}</option>
              {(connections.data || []).map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
            </select>
          </div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkScanOpen(false)}>{tr("cancel")}</Button>
            <Button disabled={!bulkConnectionId || bulkScanMutation.isPending || connections.isError} onClick={() => bulkScanMutation.mutate()}><ServerCog /> {tr("scan")}</Button>
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

export { IpamSourcesDialog } from '@/features/ipam/IpamSourcesDialog';
