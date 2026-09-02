import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
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
import { api, apiFetch } from "@/lib/api";
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
import { Label } from "@/components/ui/label";
import { TablePagination } from "@/components/ui/table-pagination";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { OverflowItem, OverflowMenu } from "@/components/ui/overflow-menu";
import {
  canAccessDeployments,
  hasCap,
  usePlugins,
  useProfile,
} from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { formatDateTime } from "@/lib/utils";
import { AuditLogPanel } from "@/features/operations/AuditLogPanel";

interface Workspace {
  id: string;
  name: string;
}
interface OperationRow {
  id: string;
  source: "Host" | "Deployment" | "Workflow";
  name: string;
  target: string;
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
  timezone?: string;
  owner?: string;
  state?: "scheduled" | "active" | "completed";
}

function readableTime(value?: string) {
  return formatDateTime(value);
}
function dateTimeInput(value?: string) {
  const date = value ? new Date(value) : new Date();
  date.setSeconds(0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function maintenanceTone(state?: string): StatusTone {
  return state === "active"
    ? "warning"
    : state === "scheduled"
      ? "info"
      : "muted";
}
function maintenanceLabel(state?: string) {
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
  const { data: plugins } = usePlugins();
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
  const selectedOperation =
    operationRows.find((row) => row.id === selectedOperationId) ||
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
        title="Operations"
        description="Activity, maintenance planning, and security-relevant changes for the selected environment."
        actions={
          <Button variant="outline" onClick={refresh} disabled={isRefreshing}>
            <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />
      {activeSection === "tasks" && operationsQuery.isSuccess && (!canViewMaintenance || maintenanceQuery.isSuccess) && <OperationsContext
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
      <nav className="flex gap-1 overflow-x-auto rounded-[3px] border bg-card p-1" aria-label="Operations sections">
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
              <QueryErrorState
                error={operationsQuery.error}
                title="Activity could not be loaded"
                onRetry={() => void operationsQuery.refetch()}
              />
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
                <div className="grid gap-2 border-b bg-background/60 px-3 py-2.5 sm:grid-cols-2 xl:grid-cols-[12rem_minmax(14rem,1fr)_10rem_10rem_auto]">
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
                  <label className="space-y-1 text-xs text-muted-foreground"><span>From</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground" /></label>
                  <label className="space-y-1 text-xs text-muted-foreground"><span>To</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground" /></label>
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
                        row={selectedOperation}
                        acknowledging={acknowledgeOperation.isPending}
                        onAcknowledge={(id) => acknowledgeOperation.mutate(id)}
                      />
                    </div>
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
      <ConfirmDialog
        open={Boolean(windowToDelete)}
        onOpenChange={(open) => !open && setWindowToDelete(null)}
        title="Delete maintenance window?"
        description={
          windowToDelete
            ? `The maintenance window “${windowToDelete.name}” will be permanently removed.`
            : ""
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={async () => {
          if (!windowToDelete) return;
          await apiFetch(
            `/maintenance-windows/${encodeURIComponent(windowToDelete.id)}`,
            { method: "DELETE" },
          );
          await queryClient.invalidateQueries({
            queryKey: ["maintenance-windows", environmentId],
          });
          setWindowToDelete(null);
        }}
      />
    </div>
  );
}

function OperationsContext({
  active,
  next,
  activeOperations,
  failedOperations,
  onShowFailures,
}: {
  active?: MaintenanceWindow;
  next?: MaintenanceWindow;
  activeOperations: number;
  failedOperations: number;
  onShowFailures: () => void;
}) {
  const maintenance = active || next;
  const maintenanceState = active
    ? "Active"
    : next
      ? "Scheduled"
      : "None scheduled";
  return (
    <section
      className={`console-object-summary overflow-hidden ${active ? "border-amber-500/35" : ""}`}
    >
      <div className="grid xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,.75fr)]">
        <div className="console-object-summary-main">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-brand" />
            Operating status
          </div>
          <div className="console-object-info-grid grid-cols-3">
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
              label="Maintenance window"
              value={maintenanceState}
              detail={
                active
                  ? "Review planned changes"
                  : next
                    ? "Next scheduled work"
                    : "No maintenance scheduled"
              }
              tone={active ? "warning" : next ? "info" : undefined}
            />
          </div>
        </div>
        <div className="console-object-capacity border-t xl:border-l xl:border-t-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <span className="text-sm font-semibold">
              {active
                ? "Active maintenance window"
                : next
                  ? "Next maintenance window"
                  : "Maintenance planning"}
            </span>
            {active && (
              <StatusBadge tone="warning" dot>
                Active
              </StatusBadge>
            )}
          </div>
          {maintenance ? (
            <>
              <div className="mt-3 truncate text-sm font-semibold">
                {maintenance.name}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {readableTime(maintenance.starts_at)} –{" "}
                {readableTime(maintenance.ends_at)}
                {maintenance.description ? ` · ${maintenance.description}` : ""}
              </div>
            </>
          ) : (
            <div className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Schedule maintenance before platform changes, restarts, or planned
              deployments.
            </div>
          )}
        </div>
      </div>
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
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 ${toneClass}`} />
        {label}
      </div>
      <div className={toneClass}>{value}</div>
      <p>{detail}</p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="console-object-info text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
      aria-label={`${label}: ${detail}`}
    >
      {content}
    </button>
  ) : (
    <div className="console-object-info">{content}</div>
  );
}

function MaintenanceWindowsCard({
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
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selectedWindows = windows.filter((window) => selected.has(window.id));
  const allSelected =
    windows.length > 0 && selectedWindows.length === windows.length;
  const someSelected = selectedWindows.length > 0 && !allSelected;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const deleteSelected = async () => {
    setDeleting(true);
    try {
      await Promise.all(
        selectedWindows.map((window) =>
          apiFetch(`/maintenance-windows/${encodeURIComponent(window.id)}`, {
            method: "DELETE",
          }),
        ),
      );
      await queryClient.invalidateQueries({
        queryKey: ["maintenance-windows"],
      });
      setSelected(new Set());
      setConfirmBulkDelete(false);
    } finally {
      setDeleting(false);
    }
  };
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
            onClick={() => setConfirmBulkDelete(true)}
          >
            <Trash2 />
            Delete
          </Button>
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
            description="Create a time window before performing scheduled changes or restarts."
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
                        {window.description && (
                          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {window.description}
                          </div>
                        )}
                        {(window.affected_resources || window.owner) && <div className="mt-1 text-xs text-muted-foreground">{window.affected_resources || "All resources"}{window.owner ? ` · Owner: ${window.owner}` : ""}</div>}
                      </div>
                      <StatusBadge tone={maintenanceTone(window.state)} dot>
                        {maintenanceLabel(window.state)}
                      </StatusBadge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {readableTime(window.starts_at)} –{" "}
                      {readableTime(window.ends_at)}
                    </div>
                    {canManage && (
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
                                : new Set(windows.map((window) => window.id)),
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
                            checked={selected.has(window.id)}
                            onChange={() => toggle(window.id)}
                          />
                        </td>
                      )}
                      <td className="px-3">
                        <div className="font-medium">{window.name}</div>
                        {window.description && (
                          <div className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground">
                            {window.description}
                          </div>
                        )}
                        {(window.affected_resources || window.owner) && <div className="mt-0.5 max-w-xl truncate text-xs text-muted-foreground">{window.affected_resources || "All resources"}{window.owner ? ` · Owner: ${window.owner}` : ""}</div>}
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
                        {canManage ? (
                          <div className="flex justify-end">
                            <OverflowMenu title={`Actions for ${window.name}`}>
                              <OverflowItem icon={Pencil} onClick={() => onEdit(window)}>
                                Edit window
                              </OverflowItem>
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
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title="Delete selected maintenance windows?"
        description={
          <>
            You are removing <strong>{selectedWindows.length}</strong>{" "}
            maintenance windows. This action cannot be undone.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={deleteSelected}
        isPending={deleting}
      />
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

function MaintenanceWindowDialog({
  window,
  environmentId,
  onClose,
}: {
  window: MaintenanceWindow | "new" | null;
  environmentId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const initial = window && window !== "new" ? window : null;
  const [name, setName] = useState(initial?.name || "");
  const [startsAt, setStartsAt] = useState(dateTimeInput(initial?.starts_at));
  const [endsAt, setEndsAt] = useState(
    dateTimeInput(
      initial?.ends_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ),
  );
  const [description, setDescription] = useState(initial?.description || "");
  const [affectedResources, setAffectedResources] = useState(initial?.affected_resources || "");
  const [timezone, setTimezone] = useState(initial?.timezone || "Europe/Zurich");
  const [owner, setOwner] = useState(initial?.owner || "");
  const hasValidRange = Boolean(
    startsAt &&
      endsAt &&
      new Date(endsAt).getTime() > new Date(startsAt).getTime(),
  );
  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/maintenance-windows${initial ? `/${encodeURIComponent(initial.id)}` : ""}`,
        {
          method: initial ? "PUT" : "POST",
          body: {
            environment_id: environmentId,
            name,
            starts_at: new Date(startsAt).toISOString(),
            ends_at: new Date(endsAt).toISOString(),
            description,
            affected_resources: affectedResources,
            timezone,
            owner,
          },
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["maintenance-windows", environmentId],
      });
      onClose();
    },
  });
  if (!window) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit maintenance window" : "Schedule maintenance window"}
          </DialogTitle>
          <DialogDescription>
            During this period, teams can clearly identify scheduled work and
            its impact.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (hasValidRange) saveMutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="maintenance-name">Name</Label>
            <Input
              id="maintenance-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Proxmox maintenance"
            />
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maintenance-start">Start</Label>
              <Input
                id="maintenance-start"
                required
                type="datetime-local"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maintenance-end">End</Label>
              <Input
                id="maintenance-end"
                required
                type="datetime-local"
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
              />
            </div>
          </div>
          <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            Displayed in 24-hour format: {formatDateTime(startsAt, { hour12: false, timeZone: timezone })} – {formatDateTime(endsAt, { hour12: false, timeZone: timezone })} ({timezone})
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="maintenance-resources">Affected resources</Label>
              <Input id="maintenance-resources" value={affectedResources} onChange={(event) => setAffectedResources(event.target.value)} placeholder="e.g. Cluster A, hosts tagged production" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maintenance-owner">Owner</Label>
              <Input id="maintenance-owner" value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Team or responsible person" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="maintenance-timezone">Timezone</Label>
            <select id="maintenance-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} className="h-9 w-full rounded-sm border border-input bg-background px-3 text-sm">
              <option value="Europe/Zurich">Europe/Zurich</option>
              <option value="UTC">UTC</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
            </select>
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
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="flex min-h-20 min-w-0 w-full rounded-sm border border-input bg-background px-2.5 py-1.5 text-[13px] leading-5 shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025)]"
              placeholder="Affected platforms, reason, and expected impact"
            />
          </div>
          {saveMutation.error && (
            <p className="text-sm text-destructive">
              {(saveMutation.error as Error).message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saveMutation.isPending || !hasValidRange}
            >
              {saveMutation.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <CalendarClock />
              )}
              {initial ? "Save" : "Schedule maintenance window"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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
}: {
  row: OperationRow | null;
  acknowledging: boolean;
  onAcknowledge: (id: string) => void;
}) {
  if (!row) return null;
  return (
    <aside className="border-t bg-muted/[0.12] p-4 xl:border-l xl:border-t-0">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Info className="h-4 w-4 text-brand" />
        Task details
      </div>
      <div className="mt-3 rounded-md border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Selected task
        </p>
        <h3 className="mt-1 break-words text-lg font-semibold leading-snug">
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
          <b
            className="!overflow-visible !whitespace-normal !break-words text-right leading-relaxed"
            title={row.target}
          >
            {row.target}
          </b>
        </div>
        <div className="console-property items-start">
          <span className="pt-0.5">Triggered by</span>
          <b className="!overflow-visible !whitespace-normal !break-words text-right leading-relaxed">
            {row.initiator}
          </b>
        </div>
        <div className="console-property">
          <span>Time</span>
          <b className="whitespace-normal text-right">
            {readableTime(row.time)}
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
            Open details
            <ExternalLink />
          </OperationLink>
        </Button>
      )}
    </aside>
  );
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
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map((row) => (
          <button
            type="button"
            key={row.id}
            onClick={() => onSelect(row.id)}
            className={`block w-full space-y-2 px-4 py-3 text-left ${selectedId === row.id ? "bg-primary/[0.07]" : "hover:bg-muted/45"}`}
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
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate">{row.target}</span>
              <span className="shrink-0">{readableTime(row.time)}</span>
            </div>
          </button>
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
                  {readableTime(row.time)}
                </td>
                <td>
                  <div className="font-medium">{row.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {operationSourceLabel(row.source)} · {row.initiator}
                  </div>
                </td>
                <td className="max-w-[18rem]">
                  <div className="truncate text-muted-foreground">
                    {row.target}
                  </div>
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
