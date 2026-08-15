import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Server, CheckCircle2, RotateCcw, RefreshCw,
  Bell, Clock, Filter, Plus, Bot, PackagePlus, Container, Cog,
  Database, Activity,
} from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { ws } from '@/lib/ws';
import { actionLabel, statusLabel } from '@/lib/history-labels';
import { useUi } from '@/lib/store';
import { asArray, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRow } from '@/components/ui/skeleton';

// ---- types ----

interface ServerInfo {
  id: string | number;
  name: string;
  ip_address?: string;
  status?: string;
  ram_pct?: number | null;
  disk_pct?: number | null;
  cpu_pct?: number | null;
  uptime_seconds?: number | null;
  reboot_required?: boolean;
  updates_count?: number;
  image_updates_count?: number;
  custom_updates_count?: number;
  tags?: string[];
  agent_mode?: string;
  agent_state?: string;
  alert_count?: number;
  alert_thresholds?: { cpu?: number; ram?: number; disk?: number; storage?: number };
  custom_update_tasks?: CustomUpdateTask[];
}

interface CustomUpdateTask {
  id: string;
  name: string;
  type: 'script' | 'github' | 'trigger';
  current_version?: string | null;
  last_version?: string | null;
  trigger_output?: string | null;
  has_update?: boolean;
  last_checked_at?: string | null;
}

interface Summary {
  total: number;
  online: number;
  offline: number;
  rebootRequired: number;
  totalUpdates: number;
  criticalDisk: number;
  criticalRam: number;
}

interface HistoryEntry {
  id?: string | number;
  server_name?: string;
  action?: string;
  status?: string;
  started_at?: string;
}

interface DashboardData {
  summary: Summary;
  servers: ServerInfo[];
  agentEnabled?: boolean;
  alerts?: AlertInfo[];
  recentHistory: HistoryEntry[];
}

interface AlertInfo {
  id: string;
  server_id: string;
  server_name?: string;
  type: string;
  target_key?: string;
  severity?: string;
  status: string;
  value?: number | null;
  threshold?: number | null;
  message: string;
  acknowledged_at?: string | null;
}

interface InfrastructureNode { name: string; status: string; }
interface InfrastructureDatastore { id: string; node_name: string; used: number; total: number; }
interface InfrastructureCluster { id: string; status: string; nodes: InfrastructureNode[]; datastores?: InfrastructureDatastore[]; }
interface InfrastructureResponse { clusters?: InfrastructureCluster[]; }

// ---- helpers ----

function needsAttention(s: ServerInfo) {
  return (s.alert_count ?? 0) > 0 || s.status === 'offline' || s.reboot_required ||
    (s.updates_count ?? 0) > 0 || (s.image_updates_count ?? 0) > 0 ||
    (s.custom_updates_count ?? 0) > 0;
}

function formatUptime(seconds?: number | null) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRelativeTime(dateStr: string | undefined, t: (k: string, o?: Record<string, unknown>) => string) {
  if (!dateStr) return '—';
  try {
    const dt = !dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
    const diff = Date.now() - new Date(dt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('dash.justNow');
    if (mins < 60) return t('dash.minutesAgo', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('dash.hoursAgo', { n: hrs });
    return t('dash.daysAgo', { n: Math.floor(hrs / 24) });
  } catch { return '—'; }
}

function formatCurrentTime(hour12: boolean) {
  return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12 });
}

// ---- component ----

export function DashboardPage() {
  const { t } = useTranslation();
  const timeFormat = useUi((s) => s.timeFormat);
  const environmentId = useUi((s) => s.environmentId);
  const hour12 = timeFormat === '12h';
  useEffect(() => { sessionStorage.setItem('shipyard.lastNonDetailRoute', '/'); }, []);
  const qc = useQueryClient();
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api.getDashboard() as unknown as Promise<DashboardData>,
    refetchInterval: 30_000,
  });
  const infrastructureQuery = useQuery({
    queryKey: ['opentofu', 'infrastructure', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 30_000,
  });

  // Backend broadcasts cache_updated whenever the updates cache changes
  // (scheduler poll, after a system update, after ansible runs). Refetch the
  // dashboard so updates_count and reboot_required reflect the new state
  // without waiting for the 30s polling interval or a manual refresh.
  useEffect(() => {
    ws.connect();
    const unsub = ws.subscribe((raw) => {
      const msg = raw as { type?: string };
      if (msg?.type === 'cache_updated' || msg?.type === 'docker_refreshed') {
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
      }
    });
    return unsub;
  }, [qc, t]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const onlineIds = asArray<ServerInfo>(data?.servers)
        .filter(s => s.status === 'online')
        .map(s => s.id);
      // Force-refresh both system info and updates cache for all online servers in parallel
      const results = await Promise.allSettled(
        onlineIds.flatMap(id => [
          api.getServerInfo(id, true),
          api.getServerUpdates(id, true),
        ])
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const total = onlineIds.length * 2;
      if (failed > 0) {
        if (failed === total) {
          showToast(t('dash.refreshFailed', { n: onlineIds.length }), 'error');
        } else {
          showToast(t('dash.refreshPartial', { failed, total }), 'warning');
        }
      }
    } finally {
      await refetch();
      setRefreshing(false);
    }
  }, [data?.servers, refetch, t]);

  const isBusy = isFetching || refreshing;
  const agentEnabled = data?.agentEnabled === true;

  const servers = useMemo(() => {
    const allServers = asArray<ServerInfo>(data?.servers);
    return allServers.filter((server) => String((server as ServerInfo & { environment_id?: string }).environment_id || 'default') === environmentId);
  }, [data?.servers, environmentId]);
  const summary = useMemo(() => ({ total: servers.length, online: servers.filter(s => s.status === 'online').length, offline: servers.filter(s => s.status === 'offline').length, rebootRequired: servers.filter(s => s.reboot_required).length, totalUpdates: servers.reduce((total, s) => total + (s.updates_count ?? 0), 0), criticalDisk: 0, criticalRam: 0 }), [servers]);
  const recentHistory = asArray<HistoryEntry>(data?.recentHistory);
  const [attentionOnly, setAttentionOnly] = [
    useUi((s) => s.dashAttentionOnly),
    useUi((s) => s.setDashAttentionOnly),
  ];
  const [showAllHosts, setShowAllHosts] = useState(false);
  const attentionCount = useMemo(() => servers.filter(needsAttention).length, [servers]);

  const orderedHosts = useMemo(() => [...servers].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.name.localeCompare(b.name, 'en')), [servers]);
  const visible = attentionOnly ? orderedHosts.filter(needsAttention) : orderedHosts;
  // The dashboard is an operator cockpit, not another full resource list.
  // Keep it quick to scan; the explicit resource page remains the place for
  // paging, grouping and bulk host administration.
  const dashboardHostLimit = 8;
  const displayedHosts = attentionOnly || showAllHosts ? visible : visible.slice(0, dashboardHostLimit);
  const ackAlert = useMutation({
    mutationFn: (id: string) => api.acknowledgeAlert(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dashboard'] }),
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  // Alerts are returned with the global dashboard payload. The cockpit itself
  // is environment-scoped, therefore its attention queue must not surface a
  // condition from a different environment just because the user switched
  // context in the shell.
  const activeAlerts = useMemo(() => {
    const serverIds = new Set(servers.map(server => String(server.id)));
    return asArray<AlertInfo>(data?.alerts).filter(alert =>
      alert.status === 'active' && !alert.acknowledged_at && serverIds.has(String(alert.server_id))
    );
  }, [data?.alerts, servers]);
  const clusters = useMemo(() => Array.isArray(infrastructureQuery.data?.clusters) ? infrastructureQuery.data!.clusters! : [], [infrastructureQuery.data]);
  const infrastructureHealth = useMemo(() => {
    const nodes = clusters.flatMap(cluster => cluster.nodes || []);
    const stores = clusters.flatMap(cluster => cluster.datastores || []);
    return {
      platforms: clusters.length,
      unavailablePlatforms: clusters.filter(cluster => cluster.status !== 'online').length,
      unavailableNodes: nodes.filter(node => node.status !== 'online').length,
      constrainedDatastores: stores.filter(store => store.total > 0 && (store.used / store.total) >= 0.85).length,
    };
  }, [clusters]);
  const actionableHistory = useMemo(() => recentHistory.filter(item => item.status === 'failed' || item.status === 'running' || item.status === 'queued'), [recentHistory]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title="Operations overview"
        description={isLoading ? t('dash.loading') : t('dash.updatedAt', { time: formatCurrentTime(hour12) })}
        actions={
          <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isBusy}>
            <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </Button>
        }
      />

      {isError && (
        <Card className="border-destructive/40">
          <EmptyState
            compact
            icon={<Bell className="h-5 w-5" />}
            title="Dashboard data could not be loaded"
            description={(error as Error)?.message || "Host status is currently unavailable. No data has been changed."}
            action={<Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw />Try again</Button>}
          />
        </Card>
      )}

      <EnvironmentOperatingState
        platforms={infrastructureHealth.platforms}
        unavailablePlatforms={infrastructureHealth.unavailablePlatforms}
        unavailableNodes={infrastructureHealth.unavailableNodes}
        constrainedDatastores={infrastructureHealth.constrainedDatastores}
        totalHosts={summary.total}
        onlineHosts={summary.online}
        offlineHosts={summary.offline}
        hostState={isLoading ? 'loading' : isError ? 'error' : 'loaded'}
        platformState={infrastructureQuery.isPending ? 'loading' : infrastructureQuery.isError ? 'error' : 'loaded'}
      />

      {data && !isError && <UpdateOverview servers={servers} />}

      {activeAlerts.length > 0 && <ActiveAlertsCard alerts={activeAlerts} acknowledgingId={ackAlert.isPending ? ackAlert.variables : undefined} onAcknowledge={id => ackAlert.mutate(id)} />}

      {/* Hosts are ranked by attention. Full inventory and capacity live under
          infrastructure and resources, not in this operational cockpit. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b bg-muted/15 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2"><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4 text-muted-foreground" />{attentionCount > 0 ? 'Hosts requiring attention' : 'Fleet hosts'}</CardTitle><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{visible.length}</span></div>
          {attentionCount > 0 && (
            <Button variant={attentionOnly ? 'default' : 'secondary'} size="sm"
              onClick={() => setAttentionOnly(!attentionOnly)}>
              <Filter className="h-3.5 w-3.5" />
              {t('dash.needsAttention')}
              <Badge variant="secondary" className="ml-1">{attentionCount}</Badge>
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
            {isLoading && servers.length === 0 ? (
              <div className="py-2">
                {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={4} />)}
              </div>
            ) : isError && !data ? (
              <EmptyState
                icon={<Server className="h-5 w-5" />}
                title="Host inventory unavailable"
                description="Fleet hosts could not be loaded. Try refreshing the dashboard."
                action={<Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw />Try again</Button>}
              />
            ) : servers.length === 0 ? (
              <EmptyState
                icon={<Server className="h-5 w-5" />}
                title={t('dash.noServers')}
                description={t('dash.noServersHint')}
                action={
                  <Link to="/servers">
                    <Button size="sm"><Plus className="h-4 w-4" /> {t('servers.addServer')}</Button>
                  </Link>
                }
              />
            ) : (
              <>
                {/* Desktop table */}
                <div className="table-scroll hidden md:block">
                  <table className="w-full text-sm" data-density="compact">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-4 py-3">Host</th>
                        <th className="w-[120px] px-2 py-3">Status</th>
                        {agentEnabled && <th className="w-[150px] px-2 py-3">Agent</th>}
                        <th className="w-[100px] px-4 py-3">{t('dash.colUptime')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedHosts.map(s => <ServerRow key={s.id} s={s} t={t} agentEnabled={agentEnabled} />)}
                    </tbody>
                  </table>
                </div>
                {/* Mobile cards */}
                <div className="flex flex-col gap-3 p-4 md:hidden">
                  {displayedHosts.map(s => <ServerCard key={s.id} s={s} t={t} agentEnabled={agentEnabled} />)}
                </div>
              </>
            )}
            {servers.length > 0 && visible.length > dashboardHostLimit && !attentionOnly && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/[0.08] px-4 py-2.5"><span className="text-xs text-muted-foreground">{showAllHosts ? `${visible.length} hosts shown.` : `${dashboardHostLimit} of ${visible.length} hosts shown.`}</span><div className="flex items-center gap-2"><Button size="sm" variant="ghost" onClick={() => setShowAllHosts(open => !open)}>{showAllHosts ? 'Show less' : 'Show all'}</Button><Button size="sm" variant="outline" asChild><Link to="/servers">Open resource list</Link></Button></div></div>}
        </CardContent>
      </Card>

      <RecentTasksPanel history={actionableHistory} t={t} />
    </div>
  );
}

// ---- sub-components ----

function alertTone(alert: AlertInfo): 'danger' | 'warning' | 'muted' {
  return alert.severity === 'critical' || alert.severity === 'error' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'muted';
}

/** A compact vCenter-style attention queue. It deliberately lists only
 * unacknowledged conditions, while the host table remains the place to
 * inspect metrics and decide on the remediation. */
function ActiveAlertsCard({ alerts, acknowledgingId, onAcknowledge }: { alerts: AlertInfo[]; acknowledgingId?: string; onAcknowledge: (id: string) => void }) {
  const displayed = alerts.slice(0, 4);
  return <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b bg-muted/15 px-4 py-3">
      <div className="flex items-center gap-2"><CardTitle className="flex items-center gap-2 text-base"><Bell className="h-4 w-4 text-muted-foreground" />Open alerts</CardTitle><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{alerts.length}</span></div>
      <Button asChild size="sm" variant="outline"><Link to="/operations">Open operations</Link></Button>
    </CardHeader>
    <CardContent className="divide-y p-0">
      {displayed.map(alert => <div key={alert.id} className="flex items-start gap-3 px-4 py-3">
        <StatusBadge tone={alertTone(alert)} dot className="mt-0.5 shrink-0">{alert.severity === 'critical' ? 'Critical' : alert.severity === 'warning' ? 'Warning' : 'Info'}</StatusBadge>
        <div className="min-w-0 flex-1">
          <Link to="/servers/$id" params={{ id: alert.server_id }} className="block truncate text-sm font-medium hover:text-primary hover:underline">{alert.server_name || 'Open host'}</Link>
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground" title={alert.message}>{alert.message}</p>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={acknowledgingId === alert.id} onClick={() => onAcknowledge(alert.id)}>Acknowledge</Button>
      </div>)}
      {alerts.length > displayed.length && <div className="px-4 py-2.5 text-xs text-muted-foreground">{alerts.length - displayed.length} more alerts in operations.</div>}
    </CardContent>
  </Card>;
}

function RecentTasksPanel({ history, t }: { history: HistoryEntry[]; t: (k: string, o?: Record<string, unknown>) => string }) {
  if (history.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b bg-muted/15 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base"><Clock className="h-4 w-4 text-muted-foreground" />Running &amp; failed tasks</CardTitle>
        <Button asChild size="sm" variant="outline"><Link to="/operations">All tasks</Link></Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="table-scroll hidden md:block">
          <table className="w-full text-sm" data-density="compact">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="w-8 px-4 py-2" /><th className="px-2 py-2">Target</th><th className="px-2 py-2">Task</th><th className="w-36 px-2 py-2">Started</th><th className="w-32 px-4 py-2">Result</th></tr></thead>
            <tbody>{history.slice(0, 6).map((item, index) => <RecentTaskRow key={item.id ?? index} item={item} />)}</tbody>
          </table>
        </div>
        <div className="divide-y md:hidden">{history.slice(0, 6).map((item, index) => <RecentTaskCard key={item.id ?? index} item={item} />)}</div>
      </CardContent>
    </Card>
  );
}

function taskTone(status?: string): 'info' | 'danger' | 'muted' {
  return status === 'running' || status === 'queued' ? 'info' : status === 'failed' ? 'danger' : 'muted';
}

function RecentTaskRow({ item }: { item: HistoryEntry }) {
  const { t } = useTranslation();
  return <tr className="border-b last:border-b-0 hover:bg-muted/35"><td className="px-4 py-2"><span className={`block h-2 w-2 rounded-full ${item.status === 'success' ? 'bg-emerald-500' : item.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'}`} /></td><td className="px-2 py-2 font-medium">{item.server_name || '—'}</td><td className="px-2 py-2 text-muted-foreground">{actionLabel(t, item.action)}</td><td className="px-2 py-2 font-mono text-xs text-muted-foreground">{formatRelativeTime(item.started_at, t)}</td><td className="px-4 py-2"><StatusBadge tone={taskTone(item.status)}>{statusLabel(t, item.status)}</StatusBadge></td></tr>;
}

function RecentTaskCard({ item }: { item: HistoryEntry }) {
  const { t } = useTranslation();
  return <div className="flex items-center gap-3 px-4 py-3"><span className={`h-2 w-2 shrink-0 rounded-full ${item.status === 'success' ? 'bg-emerald-500' : item.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'}`} /><div className="min-w-0 flex-1"><div className="truncate font-medium">{item.server_name || '—'}</div><div className="truncate text-xs text-muted-foreground">{actionLabel(t, item.action)} · {formatRelativeTime(item.started_at, t)}</div></div><StatusBadge tone={taskTone(item.status)}>{statusLabel(t, item.status)}</StatusBadge></div>;
}

// The environment landing page should feel like the vCenter "recent tasks /
// host state" area, not like a wall of alert tiles. These cells are
// intentionally phrased as operator decisions and link to the exact place
// where the condition can be inspected.
type DataState = 'loading' | 'error' | 'loaded';

function EnvironmentOperatingState({ platforms, unavailablePlatforms, unavailableNodes, constrainedDatastores, totalHosts, onlineHosts, offlineHosts, hostState, platformState }: {
  platforms: number; unavailablePlatforms: number; unavailableNodes: number; constrainedDatastores: number;
  totalHosts: number; onlineHosts: number; offlineHosts: number; hostState: DataState; platformState: DataState;
}) {
  const platformIssues = unavailablePlatforms + unavailableNodes + constrainedDatastores;
  const hostIssues = offlineHosts;
  const loading = hostState === 'loading' || platformState === 'loading';
  const unavailable = hostState === 'error' || platformState === 'error';
  const hasResources = platforms > 0 || totalHosts > 0;
  const ready = !loading && !unavailable && hasResources && platformIssues === 0 && hostIssues === 0;
  const badge = unavailable
    ? { tone: 'danger' as const, label: 'Status unavailable' }
    : loading
      ? { tone: 'muted' as const, label: 'Checking status' }
      : !hasResources
        ? { tone: 'muted' as const, label: 'No resources connected' }
        : ready
          ? { tone: 'success' as const, label: 'Ready for operation' }
          : { tone: 'danger' as const, label: 'Review required' };
  return <Card>
    <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/15 px-4 py-3">
      <div><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-muted-foreground" />Operating state</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Connectivity and platform availability.</p></div>
      <StatusBadge tone={badge.tone} dot>{badge.label}</StatusBadge>
    </CardHeader>
    <CardContent className="grid p-0 md:grid-cols-2">
      <OperatingStateCell icon={<Database className="h-4 w-4" />} label="Platforms" detail={platformState === 'loading' ? 'Loading platform state…' : platformState === 'error' ? 'Platform state is unavailable' : platformIssues ? `${platformIssues} deviation${platformIssues === 1 ? '' : 's'} across platforms, nodes, or ZFS` : platforms === 0 ? 'No platforms connected' : `${platforms} platform${platforms === 1 ? '' : 's'} without reported deviations`} tone={platformState === 'error' || platformIssues ? 'danger' : platformState === 'loading' || platforms === 0 ? 'muted' : 'success'} action="Open infrastructure" to="/infrastructure" />
      <OperatingStateCell icon={<Server className="h-4 w-4" />} label="Fleet hosts" detail={hostState === 'loading' ? 'Loading host state…' : hostState === 'error' ? 'Host state is unavailable' : hostIssues ? `${offlineHosts} unreachable · ${onlineHosts} / ${totalHosts} reachable` : totalHosts === 0 ? 'No hosts connected' : `${onlineHosts} / ${totalHosts} hosts reachable`} tone={hostState === 'error' || hostIssues ? 'danger' : hostState === 'loading' || totalHosts === 0 ? 'muted' : 'success'} action="Review hosts" to="/servers" bordered />
    </CardContent>
  </Card>;
}

function OperatingStateCell({ icon, label, detail, tone, action, to, bordered = false }: { icon: React.ReactNode; label: string; detail: string; tone: 'success' | 'danger' | 'muted'; action: string; to: '/infrastructure' | '/servers'; bordered?: boolean }) {
  return <div className={cn('p-3.5', bordered && 'border-t md:border-l md:border-t-0')}><div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{icon}{label}</div><div className={cn('mt-1.5 text-sm font-medium', tone === 'danger' && 'text-destructive', tone === 'muted' && 'text-muted-foreground')}>{detail}</div><Button asChild variant="link" size="sm" className="mt-1.5 h-auto px-0"><Link to={to}>{action}</Link></Button></div>;
}

/** Central, vCenter-like update workspace. The host inventory below remains
 * about reachability; every deviation from the desired software state lives
 * here exactly once. */
function UpdateOverview({ servers }: { servers: ServerInfo[] }) {
  const affected = servers.filter(server => server.reboot_required || (server.updates_count ?? 0) > 0 || (server.image_updates_count ?? 0) > 0 || (server.custom_updates_count ?? 0) > 0);
  const osUpdates = servers.reduce((sum, server) => sum + (server.updates_count ?? 0), 0);
  const imageUpdates = servers.reduce((sum, server) => sum + (server.image_updates_count ?? 0), 0);
  const customUpdates = servers.reduce((sum, server) => sum + (server.custom_updates_count ?? 0), 0);
  const reboots = servers.filter(server => server.reboot_required).length;

  return <Card className="overflow-hidden">
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b bg-muted/15 px-4 py-3">
      <div><CardTitle className="flex items-center gap-2 text-base"><PackagePlus className="h-4 w-4 text-muted-foreground" />Currency &amp; desired state</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Packages, containers, reboots, and defined versions.</p></div>
      <StatusBadge tone={servers.length === 0 ? 'muted' : affected.length ? 'warning' : 'success'} dot>{servers.length === 0 ? 'No hosts connected' : affected.length ? `${affected.length} host${affected.length === 1 ? '' : 's'} requiring attention` : 'All desired states met'}</StatusBadge>
    </CardHeader>
    <CardContent className="p-0">
      <div className="grid divide-y border-b md:grid-cols-4 md:divide-x md:divide-y-0">
        <UpdateMetric icon={<PackagePlus className="h-4 w-4" />} label="System packages" value={osUpdates} detail="pending package updates" tone={osUpdates ? 'warning' : 'success'} />
        <UpdateMetric icon={<Container className="h-4 w-4" />} label="Container images" value={imageUpdates} detail="new image versions" tone={imageUpdates ? 'warning' : 'success'} />
        <UpdateMetric icon={<RotateCcw className="h-4 w-4" />} label="Reboots" value={reboots} detail="required after update" tone={reboots ? 'warning' : 'success'} />
        <UpdateMetric icon={<Cog className="h-4 w-4" />} label="Custom desired state" value={customUpdates} detail="version deviations" tone={customUpdates ? 'warning' : 'success'} />
      </div>
      {servers.length === 0 ? <div className="px-4 py-3 text-sm text-muted-foreground">Connect a Fleet host to evaluate its desired state.</div> : affected.length === 0 ? <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-success" />No action required. All reported desired states match.</div> : <div className="table-scroll">
        <table className="w-full min-w-[720px] text-sm" data-density="compact">
          <thead><tr className="border-b bg-muted/20 text-left text-xs text-muted-foreground"><th className="px-4 py-2.5">Host</th><th className="px-3 py-2.5">System</th><th className="px-3 py-2.5">Containers</th><th className="px-3 py-2.5">Reboot</th><th className="px-4 py-2.5">Custom desired state</th></tr></thead>
          <tbody className="divide-y">{affected.map(server => <UpdateOverviewRow key={server.id} server={server} />)}</tbody>
        </table>
      </div>}
    </CardContent>
  </Card>;
}

function UpdateMetric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: number; detail: string; tone: 'success' | 'warning' }) {
  return <div className="p-3.5"><div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{icon}{label}</div><div className={cn('mt-1.5 font-mono text-xl font-semibold', tone === 'warning' && 'text-warning')}>{value}</div><div className="mt-0.5 text-xs text-muted-foreground">{detail}</div></div>;
}

function UpdateOverviewRow({ server }: { server: ServerInfo }) {
  const taskDeviations = (server.custom_update_tasks || []).filter(task => task.has_update);
  return <tr className="hover:bg-muted/35">
    <td className="px-4 py-3"><Link to="/servers/$id" params={{ id: String(server.id) }} className="font-medium hover:text-primary hover:underline">{server.name}</Link><div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{server.ip_address || '—'}</div></td>
    <td className="px-3 py-3"><UpdateState value={server.updates_count ?? 0} label="package update" /></td>
    <td className="px-3 py-3"><UpdateState value={server.image_updates_count ?? 0} label="image update" /></td>
    <td className="px-3 py-3">{server.reboot_required ? <StatusBadge tone="warning"><RotateCcw className="mr-1 h-3 w-3" />Pending</StatusBadge> : <span className="text-xs text-muted-foreground">Not required</span>}</td>
    <td className="px-4 py-3">{taskDeviations.length ? <div className="flex flex-wrap gap-1">{taskDeviations.map(task => <span key={task.id} title={`${task.current_version || '—'} → ${task.type === 'trigger' ? task.trigger_output || '—' : task.last_version || '—'}`}><StatusBadge tone="warning"><Cog className="mr-1 h-3 w-3" />{task.name}</StatusBadge></span>)}</div> : (server.custom_updates_count ?? 0) > 0 ? <StatusBadge tone="warning">{server.custom_updates_count} deviation{server.custom_updates_count === 1 ? '' : 's'}</StatusBadge> : <span className="text-xs text-muted-foreground">Current</span>}</td>
  </tr>;
}

function UpdateState({ value, label }: { value: number; label: string }) {
  return value > 0 ? <StatusBadge tone="warning">{value} {label}{value === 1 ? '' : 's'}</StatusBadge> : <span className="text-xs text-muted-foreground">Current</span>;
}

function AgentBadge({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  if ((s.agent_mode || 'legacy') === 'legacy') return null;
  const st = s.agent_state || 'legacy';
  const cls = st === 'ok' ? 'bg-emerald-500/10 text-emerald-600' :
    st === 'warning' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground';
  const label = st === 'ok' ? t('dash.agentOk') : st === 'warning' ? t('dash.agentDelayed') : t('dash.agentStale');
  return (
    <span className={`ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={`${t('dash.agentMode')}: ${s.agent_mode} · ${label}`}>
      <Bot className="h-3 w-3" /> {s.agent_mode}
    </span>
  );
}

function ServerRow({ s, t, agentEnabled }: { s: ServerInfo; t: (k: string) => string; agentEnabled: boolean }) {
  const navigate = useNavigate();
  const tags = asArray<string>(s.tags);
  const hostStatus = s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown');
  return (
    <tr className="border-b transition-colors last:border-b-0 hover:bg-muted/50 cursor-pointer"
      onClick={() => navigate({ to: '/servers/$id', params: { id: String(s.id) } })}>
      <td className="px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{s.name}</span>
          {agentEnabled && <AgentBadge s={s} />}
          <span className="truncate font-mono text-[11px] text-muted-foreground">{s.ip_address}</span>
        </div>
        {tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.slice(0, 3).map(tag => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{tag}</span>
            ))}
            {tags.length > 3 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">+{tags.length - 3}</span>}
          </div>
        )}
      </td>
      <td className="px-2 py-2.5"><StatusBadge tone={s.status === 'online' ? 'success' : s.status === 'offline' ? 'danger' : 'muted'} dot>{hostStatus}</StatusBadge></td>
      {agentEnabled && <td className="px-2 py-2.5"><AgentBadge s={s} /><span className="text-xs text-muted-foreground">{s.agent_mode === 'legacy' ? 'SSH' : 'Agent'}</span></td>}
      <td className="px-4 py-2.5">
        <span className={`font-mono text-xs ${!s.uptime_seconds ? 'text-muted-foreground' : ''}`}>
          {formatUptime(s.uptime_seconds)}
        </span>
      </td>
    </tr>
  );
}

function ServerCard({ s, t, agentEnabled }: { s: ServerInfo; t: (k: string) => string; agentEnabled: boolean }) {
  const dotCls = s.status === 'online' ? 'bg-emerald-500' : s.status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground';
  const statusLabel = s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown');
  const tags = asArray<string>(s.tags);
  return (
    <Link to="/servers/$id" params={{ id: String(s.id) }}
      className="rounded-[3px] border border-border-strong/80 bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dotCls}`} />
        <span className="truncate font-medium">{s.name}</span>
        <StatusBadge tone={s.status === 'online' ? 'success' : s.status === 'offline' ? 'danger' : 'muted'} className="ml-auto">{statusLabel}</StatusBadge>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {agentEnabled && <AgentBadge s={s} />}
        <span className="font-mono">{s.ip_address}</span>
        <span className="font-mono">{formatUptime(s.uptime_seconds)}</span>
      </div>
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.slice(0, 4).map(tag => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{tag}</span>)}
          {tags.length > 4 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">+{tags.length - 4}</span>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        <UpdatesChips s={s} />
      </div>
    </Link>
  );
}

function UpdatesChips({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  const chips: React.ReactNode[] = [];
  if (s.reboot_required) chips.push(<StatusBadge key="rb" tone="warning"><RotateCcw className="mr-1 h-3 w-3" />{t('dash.needsReboot')}</StatusBadge>);
  if ((s.updates_count ?? 0) > 0) chips.push(<StatusBadge key="u" tone="warning"><PackagePlus className="mr-1 h-3 w-3" />{s.updates_count} {t('dash.colUpdates')}</StatusBadge>);
  if ((s.image_updates_count ?? 0) > 0) chips.push(<StatusBadge key="i" tone="warning"><Container className="mr-1 h-3 w-3" />{s.image_updates_count} {t('dash.colImageUpdates')}</StatusBadge>);
  if ((s.custom_updates_count ?? 0) > 0) chips.push(<StatusBadge key="c" tone="warning"><Cog className="mr-1 h-3 w-3" />{s.custom_updates_count} {t('dash.colCustomUpdates')}</StatusBadge>);
  if (chips.length === 0) return <StatusBadge tone="success"><CheckCircle2 className="mr-1 h-3 w-3" />{t('dash.allClear')}</StatusBadge>;
  return <>{chips}</>;
}
