import { Timestamp } from '@/components/ui/timestamp';
import {upcomingSeriesIds} from '@/lib/maintenance-series';
import {DeleteMaintenanceDialog} from '@/features/operations/DeleteMaintenanceDialog';
import { overlappingWindows } from '@/lib/maintenance-overlap';
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch, useBlocker } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { ApiError, api, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DateTextInput,
  ZonedDateTimePicker,
} from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { TablePagination } from "@/components/ui/table-pagination";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { OverflowItem, OverflowMenu } from "@/components/ui/overflow-menu";
import {
  canAccessDeployments,
  hasCap,
  useProfile,
} from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { cn, formatDateTime } from "@/lib/utils";
import { AuditLogPanel } from "@/features/operations/AuditLogPanel";

interface Workspace {
  id: string;
  name: string;
}
export interface OperationRow {
  executions?: Array<{ id: string; time?: string }>;
  id: string;
  source: "Host" | "Deployment" | "Workflow";
  name: string;
  target: string;
  target_detail?: string;
  target_deleted?: boolean;
  playbook?: string;
  check_mode?: boolean;
  schedule_deleted?: boolean;
  started_at?: string;
  completed_at?: string;
  action?: string;
  initiator: string;
  status: string;
  statusTone: StatusTone;
  acknowledged?: boolean;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  time?: string;
  href?: "/servers/$id" | "/deployments/$id" | "/playbooks";
  params?: Record<string, string>;
}

interface OperationsResponse {
  items: OperationRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: { all: number; active: number; failed: number };
}

const OPERATIONS_PAGE_SIZE = 10;
interface MaintenanceWindow {
  id: string;
  environment_id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  description?: string;
  affected_resources?: string;
  resource_ids?: string[];
  revision?: string;
  can_edit?: boolean;
  series_id?: string|null;
  series_index?: number|null;
  series_count?: number|null;
  recurrence_frequency?: string|null;
  change_reference?: string;
  timezone?: string;
  owner?: string;
  cancelled_at?: string|null;
  cancelled_by?: string|null;
  cancellation_reason?: string|null;
  state?: "scheduled" | "active" | "completed" | "cancelled";
}

function readableTime(value?: string) {
  return formatDateTime(value);
}
function maintenanceTone(state?: string): StatusTone {
  return state === "active"
    ? "warning"
    : state === "scheduled"
      ? "info"
      : "muted";
}
function maintenanceLabel(state?: string) {
  if(state==='cancelled')return 'Cancelled';
  return state === "active"
    ? "Active"
    : state === "scheduled"
      ? "Scheduled"
      : "Completed";
}
function operationSourceLabel(source: OperationRow["source"]) {
  return source === "Host"
    ? "Host operation"
    : source === "Deployment"
    ? "Deployment"
    : "Playbook workflow";
}
function operationStatusLabel(status: string) {
  const normalized = status.toLowerCase();
  if (
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "erfolgreich"
  )
    return "Successful";
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "fehlgeschlagen"
  )
    return "Failed";
  if (normalized === "running") return "Running";
  if (normalized === "queued") return "Queued";
  if (normalized === "pending") return "Pending";
  if (normalized === "cancelling") return "Cancelling";
  if (["cancelled", "canceled"].includes(normalized)) return "Cancelled";
  if (normalized === "skipped") return "Skipped";
  return status || "Unknown";
}

function operationDisplayTone(row: OperationRow): StatusTone {
  return row.acknowledged ? "muted" : row.statusTone;
}

function operationDisplayLabel(row: OperationRow) {
  return row.acknowledged
    ? `${operationStatusLabel(row.status)} · acknowledged`
    : operationStatusLabel(row.status);
}

export function OperationsPage() {
  const routeSearch = useSearch({ from: "/_protected/operations" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const canViewDeployments = canAccessDeployments(profile);
  const canViewSchedules = hasCap(profile, "canViewSchedules");
  const canViewAudit = hasCap(profile, "canViewAudit");
  const canViewMaintenance = hasCap(profile, "canViewMaintenance");
  const canManageMaintenance = hasCap(profile, "canEditMaintenance");
  const [taskScope, setTaskScope] = useState<"all" | "active" | "failed">(
    routeSearch.scope || "all",
  );
  const [sourceFilter, setSourceFilter] = useState<"all" | "Host" | "Deployment" | "Workflow">(routeSearch.source || "all");
  const [targetFilter, setTargetFilter] = useState(routeSearch.q || "");
  const [fromDate, setFromDate] = useState(routeSearch.from || "");
  const [toDate, setToDate] = useState(routeSearch.to || "");
  const [operationsPage, setOperationsPage] = useState(routeSearch.page || 1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showCompactOperationDialog, setShowCompactOperationDialog] =
    useState(false);
  const initialFailureFilterApplied = useRef(false);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null,
  );
  const [maintenanceDialog, setMaintenanceDialog] = useState<
    MaintenanceWindow | "new" | null
  >(null);
  const [windowToDelete, setWindowToDelete] =
    useState<MaintenanceWindow | null>(null);
  const workspaceQuery = useQuery({
    queryKey: ["opentofu", "workspaces", environmentId],
    queryFn: () =>
      apiFetch<Workspace[]>(
        `/opentofu/workspaces?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    enabled: canViewDeployments,
    staleTime: 15_000,
  });
  useEffect(() => {
    void navigate({
      to: "/operations",
      search: {
        ...(taskScope !== "all" ? { scope: taskScope } : {}),
        ...(routeSearch.section ? { section: routeSearch.section } : {}),
        ...(sourceFilter !== "all" ? { source: sourceFilter } : {}),
        ...(targetFilter.trim() ? { q: targetFilter.trim() } : {}),
        ...(fromDate ? { from: fromDate } : {}),
        ...(toDate ? { to: toDate } : {}),
        ...(operationsPage > 1 ? { page: operationsPage } : {}),
      },
      replace: true,
    });
  }, [fromDate, navigate, operationsPage, routeSearch.section, sourceFilter, targetFilter, taskScope, toDate]);

  useEffect(() => {
    if (!routeSearch.section) return;
    const target = document.getElementById(`operation-${routeSearch.section}`);
    window.requestAnimationFrame(() => target?.scrollIntoView({ block: "start" }));
  }, [routeSearch.section]);
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1279px)");
    const syncDialogLayout = () =>
      setShowCompactOperationDialog(mediaQuery.matches);
    syncDialogLayout();
    mediaQuery.addEventListener("change", syncDialogLayout);
    return () => mediaQuery.removeEventListener("change", syncDialogLayout);
  }, []);
  const workspaces = Array.isArray(workspaceQuery.data)
    ? workspaceQuery.data
    : [];
  const operationsQuery = useQuery({
    queryKey: [
      "operations", environmentId, taskScope, sourceFilter, targetFilter,
      fromDate, toDate, operationsPage,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        scope: taskScope,
        page: String(operationsPage),
        page_size: String(OPERATIONS_PAGE_SIZE),
      });
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (targetFilter.trim()) params.set("q", targetFilter.trim());
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      return apiFetch<OperationsResponse>(`/operations?${params}`);
    },
    staleTime: 10_000,
  });
  const refreshOperations = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operations"] }),
      queryClient.invalidateQueries({ queryKey: ["audit-log"] }),
    ]);
  };
  const acknowledgeOperation = useMutation({
    mutationFn: (id: string) => apiFetch(`/operations/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
    onSuccess: async () => {
      showToast("Failure acknowledged.", "success");
      await refreshOperations();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const acknowledgeAllOperations = useMutation({
    mutationFn: () => apiFetch<{ acknowledged: number }>("/operations/acknowledge-all", { method: "POST" }),
    onSuccess: async (result) => {
      showToast(
        result.acknowledged === 1
          ? "1 failure acknowledged."
          : `${result.acknowledged} failures acknowledged.`,
        "success",
      );
      await refreshOperations();
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const maintenanceQuery = useQuery({
    queryKey: ["maintenance-windows", environmentId],
    queryFn: () =>
      apiFetch<MaintenanceWindow[]>(
        `/maintenance-windows?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    enabled: canViewMaintenance,
    staleTime: 15_000,
  });
  const maintenanceWindows = Array.isArray(maintenanceQuery.data)
    ? maintenanceQuery.data
    : [];
  const activeMaintenance = maintenanceWindows.find(
    (window) => window.state === "active",
  );
  const nextMaintenance = maintenanceWindows
    .filter((window) => window.state === "scheduled")
    .sort((left, right) =>
      String(left.starts_at).localeCompare(String(right.starts_at)),
    )[0];
  const operationRows = Array.isArray(operationsQuery.data?.items)
    ? operationsQuery.data.items
    : [];
  const operationCounts = operationsQuery.data?.counts || { all: 0, active: 0, failed: 0 };
  const activeOperationCount = operationCounts.active;
  const failedOperationCount = operationCounts.failed;
  const operationsTotalPages = operationsQuery.data?.total_pages || 1;
  const safeOperationsPage = operationsQuery.data?.page || operationsPage;
  const explicitlySelectedOperation =
    operationRows.find((row) => row.id === selectedOperationId) || null;
  const selectedOperation =
    explicitlySelectedOperation ||
    operationRows[0] ||
    null;
  const activeSection = routeSearch.section || "tasks";
  useEffect(() => {
    if (initialFailureFilterApplied.current || routeSearch.scope || operationsQuery.isLoading) return;
    initialFailureFilterApplied.current = true;
    if ((operationsQuery.data?.counts.failed || 0) > 0) setTaskScope("failed");
  }, [operationsQuery.data?.counts.failed, operationsQuery.isLoading, routeSearch.scope]);
  useEffect(() => {
    setOperationsPage(1);
  }, [taskScope, sourceFilter, targetFilter, fromDate, toDate]);
  useEffect(() => {
    if (operationsPage > operationsTotalPages)
      setOperationsPage(operationsTotalPages);
  }, [operationsPage, operationsTotalPages]);
  useEffect(() => {
    if (
      selectedOperationId &&
      !operationRows.some((row) => row.id === selectedOperationId)
    )
      setSelectedOperationId(null);
  }, [operationRows, selectedOperationId]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["opentofu"] });
    void queryClient.invalidateQueries({ queryKey: ["operations"] });
    void queryClient.invalidateQueries({ queryKey: ["audit-log"] });
    void queryClient.invalidateQueries({ queryKey: ["maintenance-windows"] });
  };
  const isRefreshing =
    workspaceQuery.isFetching ||
    operationsQuery.isFetching ||
    maintenanceQuery.isFetching;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Jobs"
        description="Runs and scheduled changes."
        actions={
          <Button variant="outline" onClick={refresh} disabled={isRefreshing}>
            <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />
      {activeSection === "tasks" && operationsQuery.isSuccess && (!canViewMaintenance || maintenanceQuery.isSuccess) && <OperationsContext
        canViewMaintenance={canViewMaintenance}
        active={activeMaintenance}
        next={nextMaintenance}
        activeOperations={activeOperationCount}
        failedOperations={failedOperationCount}
        onShowFailures={() => {
          setTaskScope("failed");
          setSelectedOperationId(null);
          document
            .getElementById("operation-tasks")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />}
      <nav className="flex gap-1 overflow-x-auto rounded-panel border bg-card p-1" aria-label="Operations sections">
        <Button asChild size="sm" variant={activeSection === "tasks" ? "secondary" : "ghost"}><Link to="/operations" search={{ ...routeSearch, section: "tasks" }}>Activity</Link></Button>
        {canViewMaintenance && <Button asChild size="sm" variant={activeSection === "maintenance" ? "secondary" : "ghost"}><Link to="/operations" search={{ ...routeSearch, section: "maintenance" }}>Maintenance</Link></Button>}
        {canViewAudit && <Button asChild size="sm" variant={activeSection === "audit" ? "secondary" : "ghost"}><Link to="/operations" search={{ ...routeSearch, section: "audit" }}>Audit</Link></Button>}
      </nav>
      <div className="flex flex-col gap-5">
        {activeSection === "tasks" && <Card id="operation-tasks" className="scroll-mt-16">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/15 py-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="h-4 w-4" />
                Activity
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Running tasks appear first. Select a task to review its context.
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {canViewDeployments && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/deployments">
                    Deployment
                    <ExternalLink />
                  </Link>
                </Button>
              )}
              {canViewSchedules && (
                <Button asChild size="sm" variant="ghost">
                  <Link to="/playbooks">
                    Workflows
                    <ExternalLink />
                  </Link>
                </Button>
              )}
              {canViewAudit && <Button asChild size="sm" variant="ghost"><Link to="/operations" search={{ ...routeSearch, section: "audit" }}>Audit log</Link></Button>}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {operationsQuery.isLoading ? (
              <div className="p-5 text-sm text-muted-foreground">
                Loading activity…
              </div>
            ) : operationsQuery.isError ? (
              <div>
                <QueryErrorState
                  error={operationsQuery.error}
                  title="Activity could not be loaded"
                  onRetry={() => void operationsQuery.refetch()}
                />
                <Button className="m-3" variant="outline" size="sm" onClick={() => { setTaskScope("all"); setSourceFilter("all"); setTargetFilter(""); setFromDate(""); setToDate(""); setOperationsPage(1); }}>Reset filters and show newest tasks</Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1 border-b bg-muted/10 px-3 py-2">
                  <TaskScopeButton
                    active={taskScope === "all"}
                    onClick={() => setTaskScope("all")}
                  >
                    All <span>{operationCounts.all}</span>
                  </TaskScopeButton>
                  <TaskScopeButton
                    active={taskScope === "active"}
                    onClick={() => setTaskScope("active")}
                  >
                    Active <span>{activeOperationCount}</span>
                  </TaskScopeButton>
                  <TaskScopeButton
                    active={taskScope === "failed"}
                    onClick={() => setTaskScope("failed")}
                  >
                    Failed <span>{failedOperationCount}</span>
                  </TaskScopeButton>
                  {failedOperationCount > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      disabled={acknowledgeAllOperations.isPending}
                      onClick={() => acknowledgeAllOperations.mutate()}
                    >
                      <CheckCircle2 />
                      {acknowledgeAllOperations.isPending ? "Acknowledging…" : "Acknowledge all failures"}
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between border-b bg-background/60 px-3 py-2 md:hidden">
                  <span className="text-xs text-muted-foreground">
                    {sourceFilter !== "all" || targetFilter || fromDate || toDate
                      ? "Filters active"
                      : "Filters collapsed"}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={filtersOpen ? "secondary" : "outline"}
                    aria-expanded={filtersOpen}
                    aria-controls="activity-filters"
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    Filters
                  </Button>
                </div>
                <div id="activity-filters" className={`${filtersOpen ? "grid" : "hidden"} gap-2 border-b bg-background/60 px-3 py-2.5 sm:grid-cols-2 md:grid xl:grid-cols-[12rem_minmax(14rem,1fr)_10rem_10rem_auto]`}>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Source</span>
                    <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground">
                      <option value="all">All sources</option>
                      <option value="Host">Hosts</option>
                      <option value="Deployment">Deployments</option>
                      <option value="Workflow">Playbooks</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Target, task, or initiator</span>
                    <span className="relative block"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4" /><Input value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)} className="pl-8" placeholder="Filter operations…" /></span>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground"><span>From · Europe/Zurich</span><DateTextInput value={fromDate} onChange={setFromDate} ariaLabel="Activity from date" /></label>
                  <label className="space-y-1 text-xs text-muted-foreground"><span>Through · Europe/Zurich</span><DateTextInput value={toDate} onChange={setToDate} ariaLabel="Activity to date" /></label>
                  <div className="flex items-end"><Button type="button" size="sm" variant="ghost" disabled={sourceFilter === "all" && !targetFilter && !fromDate && !toDate} onClick={() => { setSourceFilter("all"); setTargetFilter(""); setFromDate(""); setToDate(""); }}>Reset</Button></div>
                </div>
                {operationRows.length ? (
                  <>
                    <div className="grid xl:grid-cols-[minmax(30rem,1.2fr)_minmax(22rem,.8fr)]">
                      <OperationList
                        rows={operationRows}
                        selectedId={selectedOperation?.id}
                        onSelect={setSelectedOperationId}
                      />
                      <OperationDetail
                        className="hidden xl:block"
                        row={selectedOperation}
                        acknowledging={acknowledgeOperation.isPending}
                        onAcknowledge={(id) => acknowledgeOperation.mutate(id)}
                      />
                    </div>
                    <Dialog
                      open={Boolean(showCompactOperationDialog && selectedOperationId && explicitlySelectedOperation)}
                      onOpenChange={(open) => !open && setSelectedOperationId(null)}
                    >
                      <DialogContent className="p-0">
                        <DialogHeader className="border-b px-4 pb-3 pt-4 text-left">
                          <DialogTitle>Task details</DialogTitle>
                          <DialogDescription>
                            Review the selected activity without leaving the list.
                          </DialogDescription>
                        </DialogHeader>
                        <OperationDetail
                          className="border-0 p-4"
                          row={explicitlySelectedOperation}
                          acknowledging={acknowledgeOperation.isPending}
                          onAcknowledge={(id) => acknowledgeOperation.mutate(id)}
                          showHeading={false}
                        />
                      </DialogContent>
                    </Dialog>
                    <TablePagination
                      page={safeOperationsPage}
                      pageSize={OPERATIONS_PAGE_SIZE}
                      totalItems={operationsQuery.data?.total || 0}
                      onPageChange={setOperationsPage}
                      itemLabel="events"
                    />
                  </>
                ) : (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    There are no entries for this view.
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>}
        {activeSection === "maintenance" && canViewMaintenance && (
          <div id="operation-maintenance" className="scroll-mt-16"><MaintenanceWindowsCard
              windows={maintenanceWindows}
              loading={maintenanceQuery.isLoading}
              error={maintenanceQuery.error}
              onRetry={() => void maintenanceQuery.refetch()}
              canManage={canManageMaintenance}
              onCreate={() => setMaintenanceDialog("new")}
              onEdit={setMaintenanceDialog}
              onDelete={setWindowToDelete}
            /></div>
        )}
        {activeSection === "audit" && canViewAudit && <div id="operation-audit" className="scroll-mt-16"><AuditLogPanel /></div>}
      </div>
      <MaintenanceWindowDialog
        key={
          maintenanceDialog === "new"
            ? "new"
            : maintenanceDialog?.id || "closed"
        }
        window={maintenanceDialog}
        environmentId={environmentId}
        onClose={() => setMaintenanceDialog(null)}
      />
      <DeleteMaintenanceDialog windows={windowToDelete?[windowToDelete]:[]} environmentId={environmentId} onClose={()=>setWindowToDelete(null)} />
    </div>
  );
}

function OperationsContext({
  canViewMaintenance,
  active,
  next,
  activeOperations,
  failedOperations,
  onShowFailures,
}: {
  canViewMaintenance: boolean;
  active?: MaintenanceWindow;
  next?: MaintenanceWindow;
  activeOperations: number;
  failedOperations: number;
  onShowFailures: () => void;
}) {
  const maintenance = active || next;
  const maintenanceState = !canViewMaintenance ? "Not available" : active
    ? "Active"
    : next
      ? "Scheduled"
      : "None scheduled";
  return (
    <section
      className={`overflow-hidden rounded-panel border bg-card ${active ? "border-amber-500/35" : ""}`}
      aria-label="Operating status"
    >
      <div className="flex flex-wrap items-stretch">
        <div className="flex min-w-[12rem] items-center gap-2 border-b px-3 py-2 text-sm font-semibold sm:border-b-0 sm:border-r">
            <ClipboardList className="h-4 w-4 text-brand" />
            Operating status
        </div>
        <OperationFact
          icon={CircleDashed}
          label="Active tasks"
          value={activeOperations}
          detail={activeOperations ? "Running or waiting" : "No open tasks"}
          tone={activeOperations ? "info" : undefined}
        />
        <OperationFact
          icon={failedOperations ? TriangleAlert : CheckCircle2}
          label="Open failures"
          value={failedOperations}
          detail={failedOperations ? "Review and acknowledge" : "No unacknowledged failures"}
          tone={failedOperations ? "danger" : "success"}
          onClick={failedOperations ? onShowFailures : undefined}
        />
        <OperationFact
          icon={CalendarClock}
          label="Maintenance"
          value={maintenanceState}
          detail={!canViewMaintenance ? "Visibility restricted" : maintenance ? maintenance.name : "No window scheduled"}
          tone={active ? "warning" : next ? "info" : undefined}
        />
      </div>
      {canViewMaintenance && maintenance && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{active ? "Active window" : "Next window"}</span>
        <span>{readableTime(maintenance.starts_at)} – {readableTime(maintenance.ends_at)}</span>
        {maintenance.description && <span className="min-w-0 truncate">{maintenance.description}</span>}
      </div>}
    </section>
  );
}

function OperationFact({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  icon: typeof Workflow;
  label: string;
  value: string | number;
  detail: string;
  tone?: "info" | "warning" | "danger" | "success";
  onClick?: () => void;
}) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "success"
        ? "[color:hsl(var(--success))]"
        : tone === "warning"
          ? "[color:hsl(var(--warning))]"
          : tone === "info"
            ? "[color:hsl(var(--info))]"
            : "text-muted-foreground";
  const content = (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${toneClass}`} />
        {label}
      </div>
      <div className={`font-mono text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <p className="truncate text-xs text-muted-foreground">{detail}</p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="min-w-[12rem] flex-1 border-b px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 sm:border-b-0 sm:border-r last:border-r-0"
      aria-label={`${label}: ${detail}`}
    >
      {content}
    </button>
  ) : (
    <div className="min-w-[12rem] flex-1 border-b px-3 py-2 sm:border-b-0 sm:border-r last:border-r-0">{content}</div>
  );
}

export function MaintenanceWindowsCard({
  windows,
  loading,
  error,
  onRetry,
  canManage,
  onCreate,
  onEdit,
  onDelete,
}: {
  windows: MaintenanceWindow[];
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  canManage: boolean;
  onCreate: () => void;
  onEdit: (window: MaintenanceWindow) => void;
  onDelete: (window: MaintenanceWindow) => void;
}) {
  const environmentId = useUi(state=>state.environmentId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<MaintenanceWindow[]>([]);
  const [cancelTargets,setCancelTargets]=useState<MaintenanceWindow[]>([]);
  const editableWindows = windows.filter(window=>window.can_edit !== false && !window.cancelled_at);
  const selectedWindows = editableWindows.filter((window) => selected.has(window.id));
  const seriesInfo = (item:MaintenanceWindow) => item.series_id ? <div className="mt-1 text-xs text-muted-foreground">{item.recurrence_frequency === 'weekly' ? 'Weekly' : 'Daily'} series · Occurrence {item.series_index} of {item.series_count} originally scheduled{canManage&&<Button className="ml-2 h-auto px-1 py-0 text-xs" variant="link" disabled={!upcomingSeriesIds(editableWindows,item).length} onClick={()=>setSelected(new Set(upcomingSeriesIds(editableWindows,item)))}>Select upcoming in this series</Button>}</div> : null;
  const allSelected =
    editableWindows.length > 0 && selectedWindows.length === editableWindows.length;
  const someSelected = selectedWindows.length > 0 && !allSelected;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/15 py-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" />
            Maintenance windows
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Scheduled work is documented per environment and remains traceable
            in the audit log.
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={onCreate}>
            <Plus />
            Add maintenance window
          </Button>
        )}
      </CardHeader>
      {canManage && selectedWindows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary/[0.04] px-4 py-2 text-sm">
          <span className="font-medium tabular-nums">
            {selectedWindows.length} selected
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            onClick={() => setDeleteTargets(selectedWindows.map(row=>({...row})))}
          >
            <Trash2 />
            Delete
          </Button>
          <Button size="sm" variant="outline" disabled={!selectedWindows.some(item=>item.state==='scheduled'||item.state==='active')} onClick={()=>setCancelTargets(selectedWindows.filter(item=>item.state==='scheduled'||item.state==='active'))}>Cancel scheduled work</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}
      <CardContent className="p-0">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">
            Loading maintenance windows…
          </div>
        ) : error ? (
          <QueryErrorState
            compact
            error={error}
            title="Maintenance windows could not be loaded"
            onRetry={onRetry}
          />
        ) : windows.length === 0 ? (
          <EmptyState
            compact
            icon={<CalendarClock className="h-5 w-5" />}
            title="No maintenance windows scheduled"
            description="Schedule a maintenance window."
          />
        ) : (
          <>
            <div className="divide-y md:hidden">
              {windows.map((window) => (
                <div
                  key={window.id}
                  className="flex gap-3 p-3.5"
                  data-selected={selected.has(window.id) || undefined}
                >
                  {canManage && (
                    <input
                      className="mt-1"
                      type="checkbox"
                      aria-label={`Select ${window.name}`}
                      disabled={window.can_edit === false}
                            checked={selected.has(window.id)}
                      onChange={() => toggle(window.id)}
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {window.name}
                        </div>
                        {seriesInfo(window)}
                        {window.cancelled_at&&<p className="text-xs text-muted-foreground">Cancelled {formatDateTime(window.cancelled_at)} by {window.cancelled_by||'System'} · {window.cancellation_reason}</p>}
                        {window.description && (
                          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {window.description}
                          </div>
                        )}
                        {(window.affected_resources || window.owner || window.resource_ids?.length || window.change_reference) && <div className="mt-1 text-xs text-muted-foreground">{window.resource_ids?.length ? `${window.resource_ids.length} selected hosts` : window.affected_resources || "Entire environment"}{window.change_reference ? ` · ${window.change_reference}` : ""}{window.owner ? ` · Owner: ${window.owner}` : ""}</div>}
                      </div>
                      <StatusBadge tone={maintenanceTone(window.state)} dot>
                        {maintenanceLabel(window.state)}
                      </StatusBadge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {readableTime(window.starts_at)} –{" "}
                      {readableTime(window.ends_at)}
                    </div>
                    {canManage && window.can_edit !== false && (
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onEdit(window)}
                        >
                          <Pencil />
                          Edit
                        </Button>
                        {(window.state==='scheduled'||window.state==='active')&&<Button size="sm" variant="outline" onClick={()=>setCancelTargets([window])}>Cancel window</Button>}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onDelete(window)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    )}
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
                    {canManage && (
                      <th className="w-11 px-3">
                        <input
                          type="checkbox"
                          aria-label="Select all maintenance windows"
                          checked={allSelected}
                          ref={(input) => {
                            if (input) input.indeterminate = someSelected;
                          }}
                          onChange={() =>
                            setSelected(
                              allSelected
                                ? new Set()
                                : new Set(editableWindows.map((window) => window.id)),
                            )
                          }
                        />
                      </th>
                    )}
                    <th className="px-3">Maintenance window</th>
                    <th className="px-3">Time range</th>
                    <th className="px-3">Status</th>
                    <th className="w-24 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((window) => (
                    <tr
                      key={window.id}
                      data-selected={selected.has(window.id) || undefined}
                    >
                      {canManage && (
                        <td className="px-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${window.name}`}
                            disabled={window.can_edit === false}
                            checked={selected.has(window.id)}
                            onChange={() => toggle(window.id)}
                          />
                        </td>
                      )}
                      <td className="px-3">
                        <div className="font-medium">{window.name}</div>
                        {seriesInfo(window)}
                        {window.cancelled_at&&<p className="text-xs text-muted-foreground">Cancelled {formatDateTime(window.cancelled_at)} by {window.cancelled_by||'System'} · {window.cancellation_reason}</p>}
                        {window.description && (
                          <div className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground">
                            {window.description}
                          </div>
                        )}
                        {(window.affected_resources || window.owner || window.resource_ids?.length || window.change_reference) && <div className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground">{window.resource_ids?.length ? `${window.resource_ids.length} selected hosts` : window.affected_resources || "Entire environment"}{window.change_reference ? ` · ${window.change_reference}` : ""}{window.owner ? ` · Owner: ${window.owner}` : ""}</div>}
                      </td>
                      <td className="px-3 whitespace-nowrap text-xs text-muted-foreground">
                        {readableTime(window.starts_at)} –{" "}
                        {readableTime(window.ends_at)}
                        <div>{window.timezone || "Europe/Zurich"}</div>
                      </td>
                      <td className="px-3">
                        <StatusBadge tone={maintenanceTone(window.state)} dot>
                          {maintenanceLabel(window.state)}
                        </StatusBadge>
                      </td>
                      <td className="px-3 text-right">
                        {canManage && window.can_edit !== false ? (
                          <div className="flex justify-end">
                            <OverflowMenu title={`Actions for ${window.name}`}>
                              <OverflowItem icon={Pencil} onClick={() => onEdit(window)}>
                                Edit window
                              </OverflowItem>
                              {(window.state==='scheduled'||window.state==='active')&&<OverflowItem onClick={()=>setCancelTargets([window])}>Cancel window</OverflowItem>}
                              <OverflowItem icon={Trash2} danger onClick={() => onDelete(window)}>
                                Delete window
                              </OverflowItem>
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
      <DeleteMaintenanceDialog mode="cancel" windows={cancelTargets} environmentId={environmentId} onClose={()=>setCancelTargets([])} onDeleted={id=>setSelected(previous=>{const next=new Set(previous);next.delete(id);return next;})} />
      <DeleteMaintenanceDialog windows={deleteTargets} environmentId={environmentId} onClose={()=>setDeleteTargets([])} onDeleted={id=>setSelected(previous=>{const next=new Set(previous);next.delete(id);return next;})} />
    </Card>
  );
}

function TaskScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

export function MaintenanceWindowDialog({
  window,
  environmentId,
  onClose,
}: {
  window: MaintenanceWindow | "new" | null;
  environmentId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const {data:maintenanceProfile}=useProfile();
  const canUseEntireEnvironment=maintenanceProfile?.role==='admin'||maintenanceProfile?.permissions?.full===true||maintenanceProfile?.permissions?.servers==='all';
  const [initial] = useState(window && window !== "new" ? window : null);
  const [openedEnvironment] = useState(environmentId);
  const [reviewedRevision,setReviewedRevision]=useState(initial?.revision);
  const [latestWindow,setLatestWindow]=useState<MaintenanceWindow|null>(null);
  const [reviewError,setReviewError]=useState('');
  const contextChanged = environmentId !== openedEnvironment;
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const submitting = useRef(false);
  const [name, setName] = useState(initial?.name || "");
  const [timezoneSearch, setTimezoneSearch] = useState("");
  const [timezone, setTimezone] = useState(initial?.timezone || "Europe/Zurich");
  const [startsAt, setStartsAt] = useState(
    initial?.starts_at || new Date().toISOString(),
  );
  const [endsAt, setEndsAt] = useState(
    initial?.ends_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );
  const [description, setDescription] = useState(initial?.description || "");
  const [resourceScope, setResourceScope] = useState<'selected' | 'environment'>(!initial || !initial.resource_ids?.length ? 'environment' : 'selected');
  const [resourceIds, setResourceIds] = useState<string[]>(initial?.resource_ids || []);
  const [changeReference, setChangeReference] = useState(initial?.change_reference || "");
  const [repeat, setRepeat] = useState('none');
  const [repeatCount, setRepeatCount] = useState(4);
  const [hostSearch, setHostSearch] = useState("");
  const hostsQuery = useQuery({ queryKey: ["maintenance-host-options", openedEnvironment], queryFn: () => apiFetch<Array<{ id: string; name: string; ip_address?: string }>>(`/servers?environment_id=${encodeURIComponent(openedEnvironment)}`, {environmentId: openedEnvironment}), enabled: Boolean(window) });
  const teamsQuery = useQuery({ queryKey: ["server-groups", openedEnvironment], queryFn: () => apiFetch<Array<{ id: string; name: string }>>(`/servers/groups?environment_id=${encodeURIComponent(openedEnvironment)}`, {environmentId: openedEnvironment}), enabled: Boolean(window) });
  const windowsQuery = useQuery({ queryKey: ["maintenance-windows", openedEnvironment], queryFn: () => apiFetch<MaintenanceWindow[]>(`/maintenance-windows?environment_id=${encodeURIComponent(openedEnvironment)}`, {environmentId: openedEnvironment}), enabled: Boolean(window) });
  const scopedResourceIds = resourceScope === 'environment' ? [] : resourceIds;
  const hasValidScope = resourceScope === 'environment' ? canUseEntireEnvironment : resourceIds.length > 0;
  const availableHostIds = new Set((Array.isArray(hostsQuery.data) ? hostsQuery.data : []).map(host => host.id));
  const unavailableHostIds = hostsQuery.isSuccess ? scopedResourceIds.filter(id => !availableHostIds.has(id)) : [];
  const overlaps = hasValidScope ? overlappingWindows({ id: initial?.id, starts_at: startsAt, ends_at: endsAt, resource_ids: scopedResourceIds }, Array.isArray(windowsQuery.data) ? windowsQuery.data : []) : [];
  const [affectedResources, setAffectedResources] = useState(initial?.affected_resources || "");
  const [owner, setOwner] = useState(initial?.owner || "");
  const hasValidRange = Boolean(
    startsAt &&
      endsAt &&
      new Date(endsAt).getTime() > new Date(startsAt).getTime(),
  );
  const recurrence = !initial && repeat !== 'none' ? {frequency: repeat, count: repeatCount} : undefined;
  const previewBody = {environment_id: openedEnvironment, name, starts_at: startsAt, ends_at: endsAt, timezone, resource_ids: scopedResourceIds, resource_scope: resourceScope, recurrence};
  const repeatPreview = useQuery({
    queryKey: ['maintenance-repeat-preview', previewBody],
    queryFn: () => apiFetch<{occurrences: Array<{starts_at:string;ends_at:string;planned_conflicts?:number[];conflicts:Array<{id:string;name:string}>}>;conflicts_checked:boolean}>('/maintenance-windows/preview', {method:'POST',environmentId:openedEnvironment,body:previewBody}),
    enabled: Boolean(window && recurrence && name.trim() && hasValidRange && hasValidScope && !contextChanged),
    retry: false,
  });
  const repeatReady = !recurrence || (repeatPreview.isSuccess && !repeatPreview.isFetching);
  const saveMutation = useMutation({
    mutationFn: () => {
      if (contextChanged) throw new Error('Return to the original environment before saving this draft.');
      return apiFetch(
        `/maintenance-windows${initial ? `/${encodeURIComponent(initial.id)}` : ""}`,
        {
          method: initial ? "PUT" : "POST",
          environmentId: openedEnvironment,
          body: {
            environment_id: openedEnvironment,
            name,
            starts_at: startsAt,
            ends_at: endsAt,
            description,
            revision: reviewedRevision,
            affected_resources: affectedResources,
            resource_ids: scopedResourceIds,
            resource_scope: resourceScope,
            change_reference: changeReference,
            timezone,
            owner,
            ...(recurrence ? {recurrence} : {}),
          },
        },
      );
    },
    onSettled: () => { submitting.current = false; },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["maintenance-windows", openedEnvironment],
      });
      onClose();
    },
  });
  const versionConflict=saveMutation.error instanceof ApiError && saveMutation.error.status===409;
  const reviewLatest=async()=>{
    setLatestWindow(null);setReviewError('');
    const response=await windowsQuery.refetch();
    if(response.error){setReviewError('The current version could not be loaded. Your draft is unchanged.');return;}
    const current=response.data?.find(row=>row.id===initial?.id);
    if(!current?.revision){setReviewError('This window is no longer available or has no version. Your draft is unchanged.');return;}
    setLatestWindow(current);
  };
  const scopeLabel=(ids:string[]|undefined)=>ids?.length ? ids.map(id=>hostsQuery.data?.find(host=>host.id===id)?.name || id).join(', ') : 'Entire environment';
  const comparison=latestWindow ? [
    ['Name',latestWindow.name,name],['Owner',latestWindow.owner,owner],['Change reference',latestWindow.change_reference,changeReference],
    ['Start',formatDateTime(latestWindow.starts_at),formatDateTime(startsAt)],['End',formatDateTime(latestWindow.ends_at),formatDateTime(endsAt)],
    ['Timezone',latestWindow.timezone,timezone],['Scope',scopeLabel(latestWindow.resource_ids),scopeLabel(scopedResourceIds)],
    ['Impact notes',latestWindow.affected_resources,affectedResources],['Description',latestWindow.description,description],
  ] : [];
  useBlocker({
    disabled: !window || (!dirty && !saveMutation.isPending),
    enableBeforeUnload: Boolean(window && (dirty || saveMutation.isPending)),
    shouldBlockFn: () => submitting.current || (dirty && !globalThis.confirm('Discard unsaved maintenance changes and leave this page?')),
  });
  const markEdited = (event: React.FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    // Search filters are presentation state, not an unsaved maintenance edit.
    if (target.id?.startsWith('maintenance-') || target.type === 'checkbox') setDirty(true);
  };
  const requestClose = () => {
    if (submitting.current) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };
  if (!window) return null;
  return (<>
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="flex max-w-2xl max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit maintenance window" : "Schedule maintenance window"}
          </DialogTitle>
          <DialogDescription>
            During this period, teams can clearly identify scheduled work and its impact.
            {initial?.series_id && " You are editing this occurrence only; other dates in the series stay unchanged."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          onInput={markEdited}
          onChange={markEdited}
          onSubmit={(event) => {
            event.preventDefault();
            if (versionConflict || !hasValidRange || !hasValidScope || !repeatReady || unavailableHostIds.length > 0 || contextChanged || submitting.current) return;
            submitting.current = true;
            saveMutation.mutate();
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-1" data-dialog-body>
          {contextChanged && <p role="alert" className="text-sm text-destructive">This draft belongs to {openedEnvironment}. Return to that environment to save, or discard the draft.</p>}
          <fieldset disabled={saveMutation.isPending || contextChanged} className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="maintenance-name">Name</Label>
            <Input
              id="maintenance-name"
              maxLength={120}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Proxmox maintenance"
            />
          </div>
          {!initial && <div className="space-y-3 rounded-md border p-3">
            <Label htmlFor="maintenance-repeat">Repeat</Label>
            <select id="maintenance-repeat" value={repeat} onChange={event => setRepeat(event.target.value)} className="h-9 w-full rounded-sm border border-input bg-background px-3 text-sm">
              <option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
            </select>
            {recurrence && <>
              <Label htmlFor="maintenance-repeat-count">Number of occurrences, including the first</Label>
              <Input id="maintenance-repeat-count" type="number" min={2} max={52} required value={repeatCount} onChange={event => setRepeatCount(Number(event.target.value))} />
              <p className="text-xs text-muted-foreground">Creates a finite set of individual windows. Start time stays fixed in {timezone}; duration stays fixed. Each window can be edited or deleted separately.</p>
              {repeatPreview.isFetching && <p role="status" className="text-sm">Calculating occurrences…</p>}
              {repeatPreview.isError && <QueryErrorState compact title="Recurrence preview unavailable" error={repeatPreview.error} onRetry={() => void repeatPreview.refetch()} />}
              {repeatPreview.data && <div className="max-h-48 space-y-2 overflow-y-auto text-sm" aria-label="Planned occurrences">
                {!repeatPreview.data.conflicts_checked && <p>Existing-window conflicts could not be checked with your permissions.</p>}
                {repeatPreview.data.occurrences.map((item,index) => <div key={item.starts_at} className="rounded border p-2">
                  <p>{index+1}. {formatDateTime(item.starts_at,{timeZone:timezone})} – {formatDateTime(item.ends_at,{timeZone:timezone})}</p>
                  {Boolean(item.planned_conflicts?.length) && <p className="text-amber-500">Overlaps planned occurrence: {item.planned_conflicts?.join(', ')}</p>}
                  {item.conflicts.length>0 && <p className="text-amber-500">Overlaps: {item.conflicts.map(conflict=>conflict.name).join(', ')}</p>}
                </div>)}
                <p className="text-xs text-muted-foreground">Overlaps are allowed when intentional. Coordinate the affected work before saving.</p>
              </div>}
            </>}
          </div>}
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maintenance-start">Start</Label>
              <ZonedDateTimePicker
                id="maintenance-start"
                required
                value={startsAt}
                onChange={setStartsAt}
                timeZone={timezone}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maintenance-end">End</Label>
              <ZonedDateTimePicker
                id="maintenance-end"
                required
                value={endsAt}
                onChange={setEndsAt}
                timeZone={timezone}
              />
            </div>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            Choose a date and time or enter it with the keyboard · {timezone}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="maintenance-resources">Scope / impact notes</Label>
              <Input id="maintenance-resources" maxLength={1000} value={affectedResources} onChange={(event) => setAffectedResources(event.target.value)} placeholder="e.g. Cluster A, hosts tagged production" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maintenance-owner">Owner / team</Label>
              <Input id="maintenance-owner" maxLength={120} value={owner} onChange={(event) => setOwner(event.target.value)} list="maintenance-owners" placeholder="Choose a team or enter a person" />
              <p className="text-xs text-muted-foreground">Suggestions include teams from this environment and owners used on other windows.</p>
              {teamsQuery.isError && <p role="status" className="text-xs text-amber-600">Team suggestions could not be loaded. You can still enter an owner.</p>}
            </div>
          </div>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Affected hosts</legend>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm"><input id="maintenance-scope-selected" type="radio" name="maintenance-scope" checked={resourceScope === 'selected'} onChange={() => setResourceScope('selected')} />Selected hosts</label>
              <label className="flex items-center gap-2 text-sm"><input id="maintenance-scope-environment" disabled={!canUseEntireEnvironment} type="radio" name="maintenance-scope" checked={resourceScope === 'environment'} onChange={() => setResourceScope('environment')} />Entire environment</label>
            </div>
            {!canUseEntireEnvironment && <p className="text-xs text-muted-foreground">Entire-environment maintenance requires verified access to all hosts. Select hosts within your access scope.</p>}
            {resourceScope === 'environment' && <p className="text-xs text-muted-foreground">This window covers the entire environment, including hosts added later.</p>}
            <fieldset disabled={resourceScope === 'environment'} className="space-y-2">
            <Input aria-label="Find affected hosts" value={hostSearch} onChange={event => setHostSearch(event.target.value)} placeholder="Find host by name or IP…" />
            {hostsQuery.isError && <QueryErrorState compact error={hostsQuery.error} title="Host selection unavailable" onRetry={() => void hostsQuery.refetch()} />}
            <div className="max-h-36 overflow-y-auto">{(Array.isArray(hostsQuery.data) ? hostsQuery.data : []).filter(host => `${host.name} ${host.ip_address || ''}`.toLowerCase().includes(hostSearch.toLowerCase())).map(host => <label key={host.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={resourceIds.includes(host.id)} onChange={event => setResourceIds(current => event.target.checked ? [...current, host.id] : current.filter(id => id !== host.id))} />{host.name}<span className="text-xs text-muted-foreground">{host.ip_address}</span></label>)}</div>
            {unavailableHostIds.length > 0 && <div role="alert" className="space-y-2 rounded-md border border-amber-500 p-2 text-sm">
              <p>Some selected hosts are no longer available in this environment or your access scope. Remove them or restore access before saving.</p>
              {unavailableHostIds.map(id => <div key={id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all">Unavailable host · {id}</span>
                <Button type="button" size="sm" variant="outline" aria-label={`Remove unavailable host ${id}`} onClick={() => {setResourceIds(current => current.filter(value => value !== id)); setDirty(true);}}>Remove</Button>
              </div>)}
              <p className="text-xs">Removing the last selected host leaves an empty selection. Choose a host or explicitly select the entire environment.</p>
            </div>}
            </fieldset>
            {!hasValidScope && <p role="alert" className="text-sm text-destructive">Select at least one host or choose Entire environment.</p>}
            <p className="text-xs text-muted-foreground">{resourceScope === 'environment' ? 'Entire environment' : `${resourceIds.length} selected ${resourceIds.length === 1 ? 'host' : 'hosts'}`}</p>
          </fieldset>
          <div className="space-y-1.5"><Label htmlFor="maintenance-change">Change reference</Label><Input id="maintenance-change" value={changeReference} onChange={event => setChangeReference(event.target.value)} maxLength={200} placeholder="e.g. CHG-2026-104" /></div>
          {windowsQuery.isError && <QueryErrorState compact error={windowsQuery.error} title="Overlap check unavailable" onRetry={() => void windowsQuery.refetch()} />}
          {overlaps.length > 0 && <div role="status" className="rounded-md border border-amber-500 p-3 text-sm"><p className="font-medium">Overlapping maintenance on the same scope</p><ul>{overlaps.map(item => <li key={item.id}>{item.name} · {formatDateTime(item.starts_at)}{item.owner ? ` · ${item.owner}` : ''}</li>)}</ul><p className="mt-1 text-xs">Coordinate owners before saving. Overlaps are allowed when intentional.</p></div>}
          <div className="space-y-1.5">
            <datalist id="maintenance-owners">{[...new Set([
              ...(Array.isArray(teamsQuery.data) ? teamsQuery.data.map(team => team.name) : []),
              ...(windowsQuery.data || []).map(item => item.owner).filter((value): value is string => Boolean(value)),
            ])].map(value => <option key={value} value={value} />)}</datalist>
            <Label htmlFor="maintenance-timezone">Timezone</Label>
            <Input aria-label="Search timezones" placeholder="Search city or timezone…" value={timezoneSearch} onChange={event => setTimezoneSearch(event.target.value)} />
            <select id="maintenance-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} className="h-9 w-full rounded-sm border border-input bg-background px-3 text-sm">
              {[...new Set(['UTC', timezone, ...Intl.supportedValuesOf('timeZone')])].sort().filter(zone => zone === timezone || zone.toLowerCase().replaceAll('_', ' ').includes(timezoneSearch.toLowerCase().replaceAll('_', ' '))).map(zone => <option key={zone} value={zone}>{zone}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Changing the timezone keeps the same instant and updates the displayed local time.</p>
          </div>
          {!hasValidRange && (
            <p className="text-sm text-destructive">
              The end must be after the start.
            </p>
          )}
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="maintenance-description">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <textarea
              id="maintenance-description"
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="flex min-h-20 min-w-0 w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-[13px] leading-5 shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025)]"
              placeholder="Affected platforms, reason, and expected impact"
            />
          </div>
          </fieldset>
          {saveMutation.error && (
            <p role="alert" className="text-sm text-destructive">
              {(saveMutation.error as Error).message}
            </p>
          )}
          {versionConflict && <div className="space-y-3 rounded border border-amber-500 p-3">
            <Button type="button" variant="outline" disabled={windowsQuery.isFetching||contextChanged} onClick={()=>void reviewLatest()}>{windowsQuery.isFetching?'Loading current version…':'Review current version'}</Button>
            {reviewError&&<p role="alert" className="text-sm text-destructive">{reviewError}</p>}
            {latestWindow&&<><p className="text-sm">Compare the saved version with your draft. Accepting keeps your draft as a complete replacement; it does not save yet.</p>
              <div className="max-h-72 overflow-auto"><table className="w-full table-fixed text-xs"><thead><tr><th>Field</th><th>Current saved value</th><th>Your draft</th></tr></thead><tbody>{comparison.map(([label,current,draft])=><tr key={label} className={current!==draft?'bg-amber-500/10':''}><th className="align-top text-left">{label}</th><td className="break-words p-2 align-top">{current||'—'}</td><td className="break-words p-2 align-top">{draft||'—'}</td></tr>)}</tbody></table></div>
              {latestWindow.can_edit===false?<p role="alert" className="text-sm text-destructive">You can no longer edit this window's scope.</p>:<Button type="button" variant="outline" disabled={contextChanged} onClick={()=>{setReviewedRevision(latestWindow.revision);setLatestWindow(null);saveMutation.reset();}}>Use my draft against this version</Button>}</>}
          </div>}
          </div>
          <DialogFooter className="shrink-0 border-t bg-card pt-3 mt-3">
            <Button type="button" variant="outline" onClick={requestClose} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={versionConflict || saveMutation.isPending || !hasValidRange || !hasValidScope || !repeatReady || unavailableHostIds.length > 0 || contextChanged}
            >
              {saveMutation.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <CalendarClock />
              )}
              {initial ? "Save" : recurrence ? `Schedule ${repeatCount} windows` : "Schedule maintenance window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen}
      title="Discard maintenance changes?" description="Your unsaved maintenance draft will be lost."
      confirmLabel="Discard changes" cancelLabel="Keep editing"
      onConfirm={() => { setDiscardOpen(false); onClose(); }} />
  </>);
}

function OperationLink({
  row,
  children,
}: {
  row: OperationRow;
  children: React.ReactNode;
}) {
  if (!row.href) return <>{children}</>;
  if (row.href === "/deployments/$id" || row.href === "/servers/$id")
    return (
      <Link
        to={row.href}
        params={row.params as { id: string }}
        className="hover:text-primary hover:underline"
      >
        {children}
      </Link>
    );
  return (
    <Link to={row.href} className="hover:text-primary hover:underline">
      {children}
    </Link>
  );
}

function OperationDetail({
  row,
  acknowledging,
  onAcknowledge,
  className,
  showHeading = true,
}: {
  row: OperationRow | null;
  acknowledging: boolean;
  onAcknowledge: (id: string) => void;
  className?: string;
  showHeading?: boolean;
}) {
  const environmentId = useUi(state => state.environmentId);
  const details = useQuery({
    queryKey: ['operation-details', environmentId, row?.id],
    queryFn: () => apiFetch<{ execution_id: string; duration_seconds: number | null; summary: string; output: string; output_truncated: boolean }>(`/operations/${encodeURIComponent(row!.id)}/details`),
    enabled: Boolean(row),
    refetchInterval: row && ['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 3000 : false,
  });
  if (!row) return null;
  return (
    <aside className={cn("border-t bg-muted/[0.12] p-4 xl:border-l xl:border-t-0", className)}>
      {showHeading && <div className="flex items-center gap-2 text-sm font-semibold">
        <Info className="h-4 w-4 text-brand" />
        Task details
      </div>}
      <div className={cn(showHeading && "mt-3")}>
        <h3 className="break-words text-base font-semibold leading-snug">
          {row.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {operationSourceLabel(row.source)} · {row.initiator}
        </p>
      </div>
      <div className="console-properties mt-3 overflow-hidden rounded-md border bg-card">
        <div className="console-property">
          <span>Status</span>
          <b>
            <StatusBadge tone={operationDisplayTone(row)} dot>
              {operationDisplayLabel(row)}
            </StatusBadge>
          </b>
        </div>
        <div className="console-property">
          <span>Type</span>
          <b>{operationSourceLabel(row.source)}</b>
        </div>
        <div className="console-property items-start">
          <span className="pt-0.5">Target</span>
          <div className="!overflow-visible !whitespace-normal !break-words text-right font-semibold leading-relaxed">
            <OperationTarget row={row} align="right" />
          </div>
        </div>
        <div className="console-property items-start">
          <span className="pt-0.5">Triggered by</span>
          <b className="!overflow-visible !whitespace-normal !break-words text-right leading-relaxed">
            {row.initiator}
          </b>
        </div>
        <div className="console-property">
          <span>{row.completed_at ? "Completed" : "Started"}</span>
          <b className="whitespace-normal text-right">
            <Timestamp value={row.time} />
          </b>
        </div>
        {row.acknowledged && (
          <>
            <div className="console-property">
              <span>Acknowledged by</span>
              <b>{row.acknowledged_by || "Unknown operator"}</b>
            </div>
            <div className="console-property">
              <span>Acknowledged at</span>
              <b className="whitespace-normal text-right">
                {readableTime(row.acknowledged_at || undefined)}
              </b>
            </div>
          </>
        )}
      </div>
      <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} className="mt-3 inline-block text-sm text-primary hover:underline">Open execution page</Link>
      <section className="mt-3 space-y-3 rounded-md border bg-card p-3" aria-label="Execution result">
        {row.source === "Workflow" && <p className="text-sm">{row.check_mode ? "Dry run" : "Execution"} · {row.playbook}{row.schedule_deleted ? " · Schedule deleted" : ""}</p>}
        {row.started_at && <p className="text-xs text-muted-foreground">Started: {readableTime(row.started_at)}</p>}
        {details.isPending && <p role="status" className="text-sm">Loading execution details…</p>}
        {details.isError && <QueryErrorState compact error={details.error} title="Execution details unavailable" onRetry={() => void details.refetch()} />}
        {details.data && !details.isError && <>
          <p className="text-xs text-muted-foreground">Execution {details.data.execution_id}{details.data.duration_seconds !== null ? ` · ${details.data.duration_seconds}s` : (['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? ' · duration pending completion' : ' · duration not recorded')}</p>
          <p className="break-words text-sm">{details.data.summary}</p>
          <details><summary className="cursor-pointer text-sm font-medium">Execution log</summary>
            {details.data.output_truncated && <p className="text-xs text-muted-foreground">Showing the last 200,000 characters.</p>}
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{details.data.output || 'No output recorded.'}</pre>
          </details>
          {row.action && <p className="text-xs text-muted-foreground">Action identifier: {row.action}</p>}
        </>}
      </section>
      {row.statusTone === "danger" && !row.acknowledged && (
        <Button
          type="button"
          className="mt-3 w-full"
          size="sm"
          variant="secondary"
          disabled={acknowledging}
          onClick={() => onAcknowledge(row.id)}
        >
          <CheckCircle2 />
          {acknowledging ? "Acknowledging…" : "Acknowledge failure"}
        </Button>
      )}
      {row.href && (
        <Button asChild className="mt-3 w-full" size="sm" variant="outline">
          <OperationLink row={row}>
            Open resource
            <ExternalLink />
          </OperationLink>
        </Button>
      )}
    </aside>
  );
}

function GroupedExecutionLinks({ row }: { row: OperationRow }) {
  const environmentId = useUi(state => state.environmentId);
  if (!row.executions?.length) return null;
  return <details className="mt-2 text-xs" onClick={event => event.stopPropagation()}>
    <summary className="cursor-pointer font-medium">View all {row.executions.length} executions</summary>
    <ul className="mt-2 max-h-60 space-y-2 overflow-auto">{row.executions.map(execution => <li key={execution.id}>
      <Link to="/operations/executions/$id" params={{ id: execution.id }} search={{ environment: environmentId }} className="text-primary hover:underline">
        {execution.time ? <Timestamp value={execution.time} /> : execution.id}
      </Link>
    </li>)}</ul>
  </details>;
}

function OperationList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: OperationRow[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const environmentId = useUi(state => state.environmentId);
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map((row) => (
          <div key={row.id} className={selectedId === row.id ? "bg-primary/[0.07]" : "hover:bg-muted/45"}>
            <button
              type="button"
              onClick={() => onSelect(row.id)}
              className="block w-full space-y-2 px-4 py-3 text-left"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{row.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {operationSourceLabel(row.source)} · {row.initiator}
                  </div>
                </div>
                <StatusBadge tone={operationDisplayTone(row)} dot>
                  {operationDisplayLabel(row)}
                </StatusBadge>
              </div>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span className="truncate">{row.target}</span>
                <span className="whitespace-normal break-words">{row.completed_at ? "Completed" : "Started"}: <Timestamp value={row.time} /></span>
              </div>
            </button>
            <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} onClick={event => event.stopPropagation()} className="mx-4 mb-3 inline-block text-xs text-primary hover:underline" aria-label={`${row.executions?.length ? "Open latest execution" : "Open execution"}: ${row.name}`}>{row.executions?.length ? "Open latest execution" : "Open execution"}</Link>
            <div className="px-4 pb-2"><GroupedExecutionLinks row={row} /></div>
            {row.target_detail && (
              <div className="px-4 pb-3 text-xs">
                <OperationTarget row={row} detailsOnly />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="table-scroll hidden md:block">
        <table data-density="compact" className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th className="w-40">Time</th>
              <th>Task</th>
              <th>Target</th>
              <th className="w-32">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onSelect(row.id)}
                className={`cursor-pointer ${selectedId === row.id ? "bg-primary/[0.07] shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-muted/45"}`}
                aria-selected={selectedId === row.id}
              >
                <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  <span className="block font-sans">{row.completed_at ? "Completed" : "Started"}</span>
                  <Timestamp value={row.time} />
                </td>
                <td>
                  <button type="button" className="text-left font-medium hover:underline" aria-label={`Show task details: ${row.name}`} onClick={event => { event.stopPropagation(); onSelect(row.id); }}>{row.name}</button>
                  <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} onClick={event => event.stopPropagation()} className="ml-2 text-xs text-primary hover:underline" aria-label={`${row.executions?.length ? "Open latest execution" : "Open execution"}: ${row.name}`}>{row.executions?.length ? "Open latest execution" : "Open execution"}</Link>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {operationSourceLabel(row.source)} · {row.initiator}
                  </div>
                  <GroupedExecutionLinks row={row} />
                </td>
                <td className="max-w-[18rem]">
                  <OperationTarget row={row} />
                </td>
                <td>
                  <StatusBadge tone={operationDisplayTone(row)} dot>
                    {operationDisplayLabel(row)}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OperationTarget({
  row,
  align = "left",
  detailsOnly = false,
}: {
  row: OperationRow;
  align?: "left" | "right";
  detailsOnly?: boolean;
}) {
  if (!row.target_detail) return detailsOnly ? null : <span>{row.target}{row.target_deleted && <span className="ml-1 text-xs text-muted-foreground">(deleted host)</span>}</span>;
  return (
    <details
      className={cn("group min-w-0 font-normal", align === "right" && "text-right")}
      onClick={(event) => event.stopPropagation()}
    >
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        {detailsOnly ? "Show target details" : row.target}
      </summary>
      <div className="mt-1 break-all text-[11px] text-muted-foreground">
        Raw target: <code>{row.target_detail}</code>
      </div>
    </details>
  );
}
