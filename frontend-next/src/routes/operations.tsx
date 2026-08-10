import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleDashed, ClipboardList, Clock3, ExternalLink, RefreshCw, ShieldCheck, TriangleAlert, Workflow, XCircle } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { hasCap, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';

interface Workspace { id: string; name: string }
interface DeploymentRun { id: string; action?: string; status?: string; started_at?: string; completed_at?: string }
interface RunsResponse { items?: DeploymentRun[] }
interface ScheduleRun { id?: number | string; schedule_name?: string; playbook?: string; targets?: string; status?: string; started_at?: string; completed_at?: string }
interface AuditRow { action?: string; user?: string; detail?: string; success?: boolean | 0 | 1; created_at?: string }

function tone(status?: string): StatusTone {
  switch (String(status || '').toLowerCase()) {
    case 'success': case 'completed': return 'success';
    case 'failed': case 'error': return 'danger';
    case 'running': case 'queued': return 'info';
    default: return 'muted';
  }
}

function readableTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function Metric({ icon: Icon, label, value, toneClass }: { icon: typeof Activity; label: string; value: string | number; toneClass?: string }) {
  return <Card><CardContent className="flex items-center gap-3 p-4"><Icon className={toneClass || 'text-muted-foreground'} /><div><div className="text-2xl font-semibold tabular-nums">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div></CardContent></Card>;
}

export function OperationsPage() {
  const queryClient = useQueryClient();
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const canViewSchedules = hasCap(profile, 'canViewSchedules');
  const isAdmin = profile?.role === 'admin';
  const workspaceQuery = useQuery({ queryKey: ['opentofu', 'workspaces', environmentId], queryFn: () => apiFetch<Workspace[]>(`/plugin/opentofu/workspaces?environment_id=${encodeURIComponent(environmentId)}`), staleTime: 15_000 });
  const workspaces = Array.isArray(workspaceQuery.data) ? workspaceQuery.data : [];
  const deploymentRunQueries = useQueries({ queries: workspaces.map(workspace => ({ queryKey: ['opentofu', 'workspace', workspace.id, 'runs', 'operations'], queryFn: () => apiFetch<RunsResponse>(`/plugin/opentofu/workspaces/${encodeURIComponent(workspace.id)}/runs?page_size=5`), staleTime: 10_000 })) });
  const scheduleQuery = useQuery({ queryKey: ['schedule-history', 'operations'], queryFn: () => api.getScheduleHistory(12) as unknown as Promise<ScheduleRun[]>, enabled: canViewSchedules, staleTime: 15_000 });
  const auditQuery = useQuery({ queryKey: ['audit-log', 'operations'], queryFn: () => api.getAuditLog({ limit: 12 }) as unknown as Promise<AuditRow[]>, enabled: isAdmin, staleTime: 15_000 });
  const deploymentRuns = useMemo(() => workspaces.flatMap((workspace, index) => (Array.isArray(deploymentRunQueries[index]?.data?.items) ? deploymentRunQueries[index].data!.items! : []).map(run => ({ ...run, workspace }))).sort((left, right) => String(right.completed_at || right.started_at || '').localeCompare(String(left.completed_at || left.started_at || ''))).slice(0, 12), [deploymentRunQueries, workspaces]);
  const scheduleRuns = Array.isArray(scheduleQuery.data) ? scheduleQuery.data : [];
  const auditRows = Array.isArray(auditQuery.data) ? auditQuery.data : [];
  const running = deploymentRuns.filter(run => ['running', 'queued'].includes(String(run.status).toLowerCase())).length;
  const failed = deploymentRuns.filter(run => ['failed', 'error'].includes(String(run.status).toLowerCase())).length + scheduleRuns.filter(run => String(run.status).toLowerCase() === 'failed').length;
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['opentofu'] }); void queryClient.invalidateQueries({ queryKey: ['schedule-history'] }); void queryClient.invalidateQueries({ queryKey: ['audit-log'] }); };
  const isRefreshing = workspaceQuery.isFetching || deploymentRunQueries.some(query => query.isFetching) || scheduleQuery.isFetching || auditQuery.isFetching;
  return <div className="space-y-6">
    <PageHeader title="Betrieb" description="Zentrale Übersicht über Deployment-Läufe, geplante Aufgaben und sicherheitsrelevante Ereignisse." actions={<Button variant="outline" onClick={refresh} disabled={isRefreshing}><RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />Aktualisieren</Button>} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={Workflow} label="Deployments in dieser Umgebung" value={workspaces.length} /><Metric icon={CircleDashed} label="Läufe aktiv" value={running} toneClass={running ? 'text-blue-600 dark:text-blue-400' : undefined} /><Metric icon={failed ? TriangleAlert : CheckCircle2} label="Fehlgeschlagene Aufgaben" value={failed} toneClass={failed ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'} /><Metric icon={ClipboardList} label="Geplante Ausführungen" value={scheduleRuns.length} /></div>
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.3fr)_minmax(330px,0.7fr)]">
      <Card><CardHeader className="flex-row items-center justify-between border-b py-4"><CardTitle className="flex items-center gap-2 text-base"><Workflow className="h-4 w-4" />Deployment-Läufe</CardTitle><Button asChild size="sm" variant="ghost"><Link to="/deployments">Alle Deployments<ExternalLink /></Link></Button></CardHeader><CardContent className="p-0">{workspaceQuery.isLoading ? <div className="p-5 text-sm text-muted-foreground">Lade Deployments…</div> : deploymentRuns.length === 0 ? <EmptyState compact icon={<Workflow className="h-5 w-5" />} title="Noch keine Deployment-Läufe" description="Plane oder führe einen Lauf in einem Deployment aus." action={<Button asChild size="sm" variant="outline"><Link to="/deployments">Deployments öffnen</Link></Button>} /> : <div className="divide-y">{deploymentRuns.map(run => <Link key={run.id} to="/deployments/$id" params={{ id: run.workspace.id }} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60"><StatusBadge tone={tone(run.status)} dot>{run.status || 'unbekannt'}</StatusBadge><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{run.workspace.name} <span className="font-normal text-muted-foreground">· {run.action || 'OpenTofu'}</span></div><div className="mt-0.5 text-xs text-muted-foreground">{readableTime(run.completed_at || run.started_at)}</div></div><ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /></Link>)}</div>}</CardContent></Card>
      <Card><CardHeader className="flex-row items-center justify-between border-b py-4"><CardTitle className="flex items-center gap-2 text-base"><Clock3 className="h-4 w-4" />Geplante Aufgaben</CardTitle><Button asChild size="sm" variant="ghost"><Link to="/playbooks">Workflows<ExternalLink /></Link></Button></CardHeader><CardContent className="p-0">{!canViewSchedules ? <EmptyState compact icon={<ShieldCheck className="h-5 w-5" />} title="Keine Berechtigung für Zeitpläne" description="Deine Rolle darf keine geplanten Ausführungen einsehen." /> : scheduleQuery.isLoading ? <div className="p-5 text-sm text-muted-foreground">Lade Aufgaben…</div> : scheduleRuns.length === 0 ? <EmptyState compact icon={<Clock3 className="h-5 w-5" />} title="Noch keine geplanten Ausführungen" description="Zeitpläne werden in Playbook-Workflows verwaltet." /> : <div className="divide-y">{scheduleRuns.map((run, index) => <div key={`${run.id || index}-${run.started_at || ''}`} className="flex items-center gap-3 px-4 py-3"><StatusBadge tone={tone(run.status)} dot>{run.status || 'unbekannt'}</StatusBadge><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{run.schedule_name || run.playbook || 'Geplante Aufgabe'}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{run.targets || '—'} · {readableTime(run.completed_at || run.started_at)}</div></div></div>)}</div>}</CardContent></Card>
    </div>
    <Card><CardHeader className="flex-row items-center justify-between border-b py-4"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Audit-Log</CardTitle>{isAdmin && <Button asChild size="sm" variant="ghost"><Link to="/settings/$tab" params={{ tab: 'audit' }}>Vollständiges Audit-Log<ExternalLink /></Link></Button>}</CardHeader><CardContent className="p-0">{!isAdmin ? <EmptyState compact icon={<ShieldCheck className="h-5 w-5" />} title="Audit-Log ist geschützt" description="Das vollständige Audit-Log steht Administratoren zur Verfügung." /> : auditQuery.isLoading ? <div className="p-5 text-sm text-muted-foreground">Lade Audit-Log…</div> : auditRows.length === 0 ? <EmptyState compact icon={<ClipboardList className="h-5 w-5" />} title="Noch keine Audit-Ereignisse" description="Neue Änderungen und Aktionen erscheinen hier." /> : <div className="divide-y">{auditRows.map((row, index) => <div key={`${row.created_at || ''}-${row.action || ''}-${index}`} className="flex items-start gap-3 px-4 py-3">{row.success ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><code className="text-xs font-medium">{row.action || '—'}</code>{row.user && <span className="text-xs text-muted-foreground">{row.user}</span>}</div><div className="mt-1 break-words text-sm text-muted-foreground">{row.detail || '—'}</div></div><span className="shrink-0 text-xs text-muted-foreground">{readableTime(row.created_at)}</span></div>)}</div>}</CardContent></Card>
  </div>;
}
