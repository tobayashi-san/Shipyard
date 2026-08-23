import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Server, CheckCircle2, RotateCcw, RefreshCw,
  Bell, Clock, Plus, Bot, PackagePlus, Container, Cog,
  Database, Activity,
} from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { ws } from '@/lib/ws';
import { actionLabel, statusLabel } from '@/lib/history-labels';
import { useUi } from '@/lib/store';
import { asArray, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { canAccessInfrastructure, hasCap, useProfile } from '@/lib/queries';

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
  const { data: profile } = useProfile();
  const canViewInfrastructure = canAccessInfrastructure(profile);
  const canViewUpdates = hasCap(profile, 'canViewUpdates');
  const canViewDocker = hasCap(profile, 'canViewDocker');
  const canViewCustomUpdates = hasCap(profile, 'canViewCustomUpdates');
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard', environmentId],
    queryFn: () => api.getDashboard() as unknown as Promise<DashboardData>,
    refetchInterval: 30_000,
  });
  const infrastructureQuery = useQuery({
    queryKey: ['opentofu', 'infrastructure', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 30_000,
    enabled: canViewInfrastructure,
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
          ...(canViewUpdates ? [api.getServerUpdates(id, true)] : []),
        ])
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const total = onlineIds.length * (canViewUpdates ? 2 : 1);
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
  }, [canViewUpdates, data?.servers, refetch, t]);

  const isBusy = isFetching || refreshing;
  const agentEnabled = data?.agentEnabled === true;

  const servers = useMemo(() => {
    const allServers = asArray<ServerInfo>(data?.servers);
    return allServers.filter((server) => String((server as ServerInfo & { environment_id?: string }).environment_id || 'default') === environmentId);
  }, [data?.servers, environmentId]);
  const summary = useMemo(() => ({ total: servers.length, online: servers.filter(s => s.status === 'online').length, offline: servers.filter(s => s.status === 'offline').length, rebootRequired: servers.filter(s => s.reboot_required).length, totalUpdates: servers.reduce((total, s) => total + (s.updates_count ?? 0), 0), criticalDisk: 0, criticalRam: 0 }), [servers]);
  const recentHistory = asArray<HistoryEntry>(data?.recentHistory);
  const attentionCount = useMemo(() => servers.filter(needsAttention).length, [servers]);

  const orderedHosts = useMemo(() => [...servers].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.name.localeCompare(b.name, 'en')), [servers]);
  const attentionHosts = useMemo(() => orderedHosts.filter(needsAttention).slice(0, 6), [orderedHosts]);
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
  const runningTaskCount = actionableHistory.filter(item => item.status === 'running' || item.status === 'queued').length;
  const criticalAlertCount = activeAlerts.filter(alert => alertTone(alert) === 'danger').length;
  const updateCount = servers.reduce((total, server) => total
    + (canViewUpdates ? (server.updates_count ?? 0) : 0)
    + (canViewUpdates && canViewDocker ? (server.image_updates_count ?? 0) : 0)
    + (canViewCustomUpdates ? (server.custom_updates_count ?? 0) : 0), 0);
  const platformIssueCount = infrastructureHealth.unavailablePlatforms + infrastructureHealth.unavailableNodes + infrastructureHealth.constrainedDatastores;
  const hasAttention = activeAlerts.length > 0 || actionableHistory.length > 0 || attentionCount > 0 || platformIssueCount > 0;

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

      <OverviewStatusBar
        loading={isLoading || (canViewInfrastructure && infrastructureQuery.isPending)}
        criticalAlerts={criticalAlertCount}
        offlineHosts={summary.offline}
        updates={updateCount}
        runningTasks={runningTaskCount}
        platformIssues={canViewInfrastructure ? platformIssueCount : undefined}
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

      {!isError && !isLoading && servers.length === 0 && (
        <Card>
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title={t('dash.noServers')}
            description={t('dash.noServersHint')}
            action={<Button asChild size="sm"><Link to="/servers"><Plus className="h-4 w-4" />{t('servers.addServer')}</Link></Button>}
          />
        </Card>
      )}

      {!isError && !isLoading && servers.length > 0 && !hasAttention && (
        <HealthySummary totalHosts={summary.total} onlineHosts={summary.online} platforms={canViewInfrastructure ? infrastructureHealth.platforms : undefined} />
      )}

      {!isError && hasAttention && (
        <section className="overflow-hidden rounded-[3px] border border-border-strong/80 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.035)]" aria-labelledby="attention-heading">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-warning" />
              <h2 id="attention-heading" className="text-sm font-semibold">Needs attention</h2>
            </div>
            <Button asChild size="sm" variant="ghost"><Link to="/operations">Open operations</Link></Button>
          </div>
          {activeAlerts.length > 0 && <ActiveAlertsSection alerts={activeAlerts} acknowledgingId={ackAlert.isPending ? ackAlert.variables : undefined} onAcknowledge={id => ackAlert.mutate(id)} />}
          <RecentTasksSection history={actionableHistory} />
          {platformIssueCount > 0 && <PlatformIssuesSection count={platformIssueCount} />}
          {attentionHosts.length > 0 && (
            <AttentionHostsSection
              hosts={attentionHosts}
              total={attentionCount}
              agentEnabled={agentEnabled}
              t={t}
            />
          )}
        </section>
      )}
    </div>
  );
}

// ---- sub-components ----

function alertTone(alert: AlertInfo): 'danger' | 'warning' | 'muted' {
  return alert.severity === 'critical' || alert.severity === 'error' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'muted';
}

function OverviewStatusBar({ loading, criticalAlerts, offlineHosts, updates, runningTasks, platformIssues }: {
  loading: boolean;
  criticalAlerts: number;
  offlineHosts: number;
  updates: number;
  runningTasks: number;
  platformIssues?: number;
}) {
  return (
    <section className="grid overflow-hidden rounded-[3px] border border-border-strong/80 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr" aria-label="Current environment status">
      <OverviewStatusItem icon={<Bell className="h-4 w-4" />} label="Critical" value={loading ? '—' : criticalAlerts} to="/operations" tone={criticalAlerts > 0 ? 'danger' : 'neutral'} />
      <OverviewStatusItem icon={<Server className="h-4 w-4" />} label="Offline" value={loading ? '—' : offlineHosts} to="/servers" tone={offlineHosts > 0 ? 'danger' : 'neutral'} />
      <OverviewStatusItem icon={<PackagePlus className="h-4 w-4" />} label="Updates" value={loading ? '—' : updates} to="/servers" tone={updates > 0 ? 'warning' : 'neutral'} />
      <OverviewStatusItem icon={<Clock className="h-4 w-4" />} label="Running tasks" value={loading ? '—' : runningTasks} to="/operations" tone={runningTasks > 0 ? 'info' : 'neutral'} />
      {platformIssues !== undefined && <OverviewStatusItem icon={<Database className="h-4 w-4" />} label="Platform issues" value={loading ? '—' : platformIssues} to="/infrastructure" tone={platformIssues > 0 ? 'danger' : 'neutral'} />}
    </section>
  );
}

function OverviewStatusItem({ icon, label, value, to, tone }: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  to: '/operations' | '/servers' | '/infrastructure';
  tone: 'neutral' | 'danger' | 'warning' | 'info';
}) {
  return (
    <Link to={to} className="group flex min-w-0 items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-muted/35 sm:odd:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
      <span className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground',
        tone === 'danger' && 'bg-destructive/10 text-destructive',
        tone === 'warning' && 'bg-warning/10 text-warning',
        tone === 'info' && 'bg-info/10 text-info',
      )}>{icon}</span>
      <span className="min-w-0">
        <span className={cn('block font-mono text-lg font-semibold leading-5', tone === 'danger' && 'text-destructive', tone === 'warning' && 'text-warning')}>{value}</span>
        <span className="block truncate text-[13px] text-muted-foreground group-hover:text-foreground">{label}</span>
      </span>
    </Link>
  );
}

function HealthySummary({ totalHosts, onlineHosts, platforms }: { totalHosts: number; onlineHosts: number; platforms?: number }) {
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-[3px] border border-border-strong/70 bg-card px-4 py-3" aria-label="Environment healthy">
      <CheckCircle2 className="h-5 w-5 text-success" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">No action required</div>
        <div className="text-[13px] text-muted-foreground">{onlineHosts} of {totalHosts} hosts reachable{platforms !== undefined ? ` · ${platforms} platform${platforms === 1 ? '' : 's'} available` : ''}</div>
      </div>
      <Button asChild size="sm" variant="ghost"><Link to="/servers">Open hosts</Link></Button>
    </section>
  );
}

function DashboardSectionHeader({ icon, title, count, action }: { icon: React.ReactNode; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 bg-muted/20 px-4 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function ActiveAlertsSection({ alerts, acknowledgingId, onAcknowledge }: { alerts: AlertInfo[]; acknowledgingId?: string; onAcknowledge: (id: string) => void }) {
  const displayed = alerts.slice(0, 4);
  return <div className="border-b">
    <DashboardSectionHeader icon={<Bell className="h-3.5 w-3.5" />} title="Open alerts" count={alerts.length} />
    <div className="divide-y">
      {displayed.map(alert => <div key={alert.id} className="flex items-start gap-3 px-4 py-3">
        <StatusBadge tone={alertTone(alert)} dot className="mt-0.5 shrink-0">{alert.severity === 'critical' ? 'Critical' : alert.severity === 'warning' ? 'Warning' : 'Info'}</StatusBadge>
        <div className="min-w-0 flex-1">
          <Link to="/servers/$id" params={{ id: alert.server_id }} className="block truncate text-sm font-medium hover:text-primary hover:underline">{alert.server_name || 'Open host'}</Link>
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground" title={alert.message}>{alert.message}</p>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={acknowledgingId === alert.id} onClick={() => onAcknowledge(alert.id)}>Acknowledge</Button>
      </div>)}
      {alerts.length > displayed.length && <div className="px-4 py-2.5 text-xs text-muted-foreground">{alerts.length - displayed.length} more alerts in operations.</div>}
    </div>
  </div>;
}

function RecentTasksSection({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return null;
  return (
    <div className="border-b">
      <DashboardSectionHeader icon={<Clock className="h-3.5 w-3.5" />} title="Running & failed tasks" count={history.length} />
        <div className="table-scroll hidden md:block">
          <table className="w-full text-sm" data-density="compact">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="w-8 px-4 py-2" /><th className="px-2 py-2">Target</th><th className="px-2 py-2">Task</th><th className="w-36 px-2 py-2">Started</th><th className="w-32 px-4 py-2">Result</th></tr></thead>
            <tbody>{history.slice(0, 6).map((item, index) => <RecentTaskRow key={item.id ?? index} item={item} />)}</tbody>
          </table>
        </div>
        <div className="divide-y md:hidden">{history.slice(0, 6).map((item, index) => <RecentTaskCard key={item.id ?? index} item={item} />)}</div>
    </div>
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

function PlatformIssuesSection({ count }: { count: number }) {
  return (
    <div className="border-b">
      <DashboardSectionHeader icon={<Database className="h-3.5 w-3.5" />} title="Platform availability" count={count} />
      <Link to="/infrastructure" className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted/35">
        <StatusBadge tone="danger" dot>{count} issue{count === 1 ? '' : 's'}</StatusBadge>
        <span className="min-w-0 flex-1 text-muted-foreground">Review unavailable platforms, nodes, or constrained storage.</span>
        <span className="text-xs font-medium text-primary">Review</span>
      </Link>
    </div>
  );
}

function AttentionHostsSection({ hosts, total, agentEnabled, t }: { hosts: ServerInfo[]; total: number; agentEnabled: boolean; t: (key: string) => string }) {
  return (
    <div>
      <DashboardSectionHeader
        icon={<Server className="h-3.5 w-3.5" />}
        title="Hosts requiring attention"
        count={total}
        action={<Link to="/servers" className="text-xs font-medium text-primary hover:underline">All hosts</Link>}
      />
      <div className="table-scroll hidden md:block">
        <table className="w-full text-sm" data-density="compact">
          <thead><tr><th>Host</th><th className="w-[120px]">Status</th>{agentEnabled && <th className="w-[150px]">Agent</th>}<th className="w-[100px]">{t('dash.colUptime')}</th></tr></thead>
          <tbody>{hosts.map(server => <ServerRow key={server.id} s={server} t={t} agentEnabled={agentEnabled} />)}</tbody>
        </table>
      </div>
      <div className="divide-y md:hidden">{hosts.map(server => <AttentionHostMobileRow key={server.id} server={server} />)}</div>
      {total > hosts.length && <div className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the {hosts.length} highest-priority hosts. <Link to="/servers" className="font-medium text-primary hover:underline">Review all {total}</Link></div>}
    </div>
  );
}

function AttentionHostMobileRow({ server }: { server: ServerInfo }) {
  return (
    <Link to="/servers/$id" params={{ id: String(server.id) }} className="block px-4 py-3 hover:bg-muted/35">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', server.status === 'online' ? 'bg-success' : server.status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground')} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{server.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{server.ip_address}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1"><UpdatesChips s={server} /></div>
    </Link>
  );
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
  const hostStatus = s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown');
  return (
    <tr className="border-b transition-colors last:border-b-0 hover:bg-muted/50 cursor-pointer"
      onClick={() => navigate({ to: '/servers/$id', params: { id: String(s.id) } })}>
      <td className="px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{s.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{s.ip_address}</span>
        </div>
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

function UpdatesChips({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const canViewUpdates = hasCap(profile, 'canViewUpdates');
  const canViewDocker = hasCap(profile, 'canViewDocker');
  const canViewCustomUpdates = hasCap(profile, 'canViewCustomUpdates');
  if (!canViewUpdates && !canViewCustomUpdates) return null;
  const chips: React.ReactNode[] = [];
  if (canViewUpdates && s.reboot_required) chips.push(<StatusBadge key="rb" tone="warning"><RotateCcw className="mr-1 h-3 w-3" />{t('dash.needsReboot')}</StatusBadge>);
  if (canViewUpdates && (s.updates_count ?? 0) > 0) chips.push(<StatusBadge key="u" tone="warning"><PackagePlus className="mr-1 h-3 w-3" />{s.updates_count} {t('dash.colUpdates')}</StatusBadge>);
  if (canViewUpdates && canViewDocker && (s.image_updates_count ?? 0) > 0) chips.push(<StatusBadge key="i" tone="warning"><Container className="mr-1 h-3 w-3" />{s.image_updates_count} {t('dash.colImageUpdates')}</StatusBadge>);
  if (canViewCustomUpdates && (s.custom_updates_count ?? 0) > 0) chips.push(<StatusBadge key="c" tone="warning"><Cog className="mr-1 h-3 w-3" />{s.custom_updates_count} {t('dash.colCustomUpdates')}</StatusBadge>);
  if (chips.length === 0) return null;
  return <>{chips}</>;
}
