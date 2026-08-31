import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Server, CheckCircle2, RotateCcw, RefreshCw,
  Bell, Clock, Plus, Bot, PackagePlus, Container, Cog,
  Activity, ChevronDown, ChevronUp,
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
import { QueryErrorState } from '@/components/ui/query-error-state';
import { canAccessOperations, hasCap, useProfile } from '@/lib/queries';

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
  attention?: {
    requiresAttention: boolean;
    severity: 'healthy' | 'warning' | 'critical';
    reasons: { code: string; severity: 'warning' | 'critical'; count: number }[];
  };
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
  failedOperations?: number;
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
interface FailedOperationsData { counts?: { failed?: number } }

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

// ---- helpers ----

function needsAttention(s: ServerInfo) {
  if (s.attention) return s.attention.requiresAttention;
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

function formatDashboardFreshness(timestamp: number, now: number, t: TFunction) {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return t('dash.freshJustNow');
  if (minutes < 60) return t('dash.freshMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return t('dash.freshHours', { count: hours });
}

// ---- component ----

export function DashboardPage() {
  const { t } = useTranslation();
  const environmentId = useUi((s) => s.environmentId);
  useEffect(() => { sessionStorage.setItem('shipyard.lastNonDetailRoute', '/'); }, []);
  const qc = useQueryClient();
  const { data: profile } = useProfile();
  const canViewUpdates = hasCap(profile, 'canViewUpdates');
  const canViewDocker = hasCap(profile, 'canViewDocker');
  const canViewCustomUpdates = hasCap(profile, 'canViewCustomUpdates');
  const canViewOperations = canAccessOperations(profile);
  const { data, dataUpdatedAt, isLoading, isFetching, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard', environmentId],
    queryFn: () => api.getDashboard() as unknown as Promise<DashboardData>,
    refetchInterval: 30_000,
  });
  const operationsQuery = useQuery<FailedOperationsData>({
    queryKey: ['operations', environmentId, 'dashboard-counts'],
    queryFn: () => apiFetch<FailedOperationsData>('/operations?scope=failed&page=1&page_size=1'),
    enabled: canViewOperations,
    staleTime: 30_000,
  });
  const operationsData = operationsQuery.data;

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
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const summary = useMemo(() => ({ total: servers.length, online: servers.filter(s => s.status === 'online').length, offline: servers.filter(s => s.status === 'offline').length, rebootRequired: servers.filter(s => s.reboot_required).length, totalUpdates: servers.reduce((total, s) => total + (s.updates_count ?? 0), 0), criticalDisk: 0, criticalRam: 0, failedOperations: operationsData?.counts?.failed ?? data?.summary?.failedOperations ?? (canViewOperations && (operationsQuery.isPending || operationsQuery.isError) ? null : 0) }), [canViewOperations, data?.summary?.failedOperations, operationsData?.counts?.failed, operationsQuery.isError, operationsQuery.isPending, servers]);
  const recentHistory = asArray<HistoryEntry>(data?.recentHistory);
  const attentionCount = useMemo(() => servers.filter(needsAttention).length, [servers]);

  const orderedHosts = useMemo(() => [...servers].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.name.localeCompare(b.name, 'en')), [servers]);
  const attentionHosts = useMemo(() => orderedHosts.filter(needsAttention), [orderedHosts]);
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
  const actionableHistory = useMemo(() => recentHistory.filter(item => item.status === 'failed' || item.status === 'running' || item.status === 'queued'), [recentHistory]);
  const runningTaskCount = actionableHistory.filter(item => item.status === 'running' || item.status === 'queued').length;
  const criticalAlertCount = activeAlerts.filter(alert => alertTone(alert) === 'danger').length;
  const updateCount = servers.reduce((total, server) => total
    + (canViewUpdates ? (server.updates_count ?? 0) : 0)
    + (canViewUpdates && canViewDocker ? (server.image_updates_count ?? 0) : 0)
    + (canViewCustomUpdates ? (server.custom_updates_count ?? 0) : 0), 0);
  const hasAttention = activeAlerts.length > 0 || actionableHistory.length > 0 || attentionCount > 0;
  const dataAge = dataUpdatedAt ? Math.max(0, freshnessNow - dataUpdatedAt) : 0;
  const freshness = dataUpdatedAt ? formatDashboardFreshness(dataUpdatedAt, freshnessNow, t) : t('dash.notUpdatedYet');

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title={t('dash.operationsOverview')}
        description={isLoading ? t('dash.loading') : <span className={dataAge > 75_000 ? 'text-warning' : undefined}>{t(dataAge > 75_000 ? 'dash.updatedStale' : 'dash.updatedRelative', { time: freshness })} · {t('dash.autoRefresh')}</span>}
        actions={
          <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isBusy}>
            <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </Button>
        }
      />

      <OverviewStatusBar
        loading={isLoading}
        criticalAlerts={criticalAlertCount}
        offlineHosts={summary.offline}
        updates={updateCount}
        runningTasks={runningTaskCount}
        failedOperations={summary.failedOperations}
      />

      {canViewOperations && operationsQuery.isError && data?.summary?.failedOperations == null && (
        <QueryErrorState
          compact
          error={operationsQuery.error}
          onRetry={() => {
            void operationsQuery.refetch();
          }}
          title="Failed operation count could not be loaded"
        />
      )}

      {isError && (
        <Card className="border-destructive/40">
          <EmptyState
            compact
            icon={<Bell className="h-5 w-5" />}
            title={t('dash.loadError')}
            description={(error as Error)?.message || t('dash.loadErrorHint')}
            action={<Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw />{t('common.retry')}</Button>}
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
        <HealthySummary totalHosts={summary.total} onlineHosts={summary.online} />
      )}

      {!isError && hasAttention && (
        <section className="overflow-hidden rounded-[3px] border border-border-strong/80 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.035)]" aria-labelledby="attention-heading">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-warning" />
              <h2 id="attention-heading" className="text-sm font-semibold">{t('dash.needsAttention')}</h2>
            </div>
            <Button asChild size="sm" variant="ghost"><Link to="/operations">{t('dash.openOperations')}</Link></Button>
          </div>
          {activeAlerts.length > 0 && <ActiveAlertsSection alerts={activeAlerts} acknowledgingId={ackAlert.isPending ? ackAlert.variables : undefined} onAcknowledge={id => ackAlert.mutate(id)} />}
          <RecentTasksSection history={actionableHistory} />
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

function OverviewStatusBar({ loading, criticalAlerts, offlineHosts, updates, runningTasks, failedOperations }: {
  loading: boolean;
  criticalAlerts: number;
  offlineHosts: number;
  updates: number;
  runningTasks: number;
  failedOperations: number | null;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid overflow-hidden rounded-[3px] border border-border-strong/80 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr" aria-label={t('dash.currentEnvironmentStatus')}>
      <OverviewStatusItem icon={<Bell className="h-4 w-4" />} label={t('dash.critical')} value={loading ? '—' : criticalAlerts} to="/servers" search={{ attention: true }} tone={criticalAlerts > 0 ? 'danger' : 'neutral'} />
      <OverviewStatusItem icon={<Server className="h-4 w-4" />} label={t('common.offline')} value={loading ? '—' : offlineHosts} to="/servers" search={{ status: 'offline' }} tone={offlineHosts > 0 ? 'danger' : 'neutral'} />
      <OverviewStatusItem icon={<PackagePlus className="h-4 w-4" />} label={t('dash.updates')} value={loading ? '—' : updates} to="/servers" search={{ updates: true }} tone={updates > 0 ? 'warning' : 'neutral'} />
      <OverviewStatusItem icon={<Clock className="h-4 w-4" />} label={t('dash.runningTasks')} value={loading ? '—' : runningTasks} to="/operations" search={{ scope: 'active' }} tone={runningTasks > 0 ? 'info' : 'neutral'} />
      <OverviewStatusItem icon={<Clock className="h-4 w-4" />} label="Failed operations" value={loading || failedOperations === null ? '—' : failedOperations} to="/operations" search={{ scope: 'failed' }} tone={(failedOperations ?? 0) > 0 ? 'danger' : 'neutral'} />
    </section>
  );
}

function OverviewStatusItem({ icon, label, value, to, search, tone }: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  to: '/operations' | '/servers';
  search?: Record<string, string | boolean>;
  tone: 'neutral' | 'danger' | 'warning' | 'info';
}) {
  return (
    <Link to={to} search={search as never} className="group flex min-w-0 items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-muted/35 sm:odd:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
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

function HealthySummary({ totalHosts, onlineHosts }: { totalHosts: number; onlineHosts: number }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-[3px] border border-border-strong/70 bg-card px-4 py-3" aria-label={t('dash.environmentHealthy')}>
      <CheckCircle2 className="h-5 w-5 text-success" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('dash.noActionRequired')}</div>
        <div className="text-[13px] text-muted-foreground">{t('dash.hostsReachable', { online: onlineHosts, total: totalHosts })}</div>
      </div>
      <Button asChild size="sm" variant="ghost"><Link to="/servers">{t('dash.openHosts')}</Link></Button>
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
  const { t } = useTranslation();
  const displayed = alerts.slice(0, 4);
  return <div className="border-b">
    <DashboardSectionHeader icon={<Bell className="h-3.5 w-3.5" />} title={t('dash.openAlerts')} count={alerts.length} />
    <div className="divide-y">
      {displayed.map(alert => <div key={alert.id} className="flex items-start gap-3 px-4 py-3">
        <StatusBadge tone={alertTone(alert)} dot className="mt-0.5 shrink-0">{t(alert.severity === 'critical' ? 'dash.critical' : alert.severity === 'warning' ? 'dash.warning' : 'dash.info')}</StatusBadge>
        <div className="min-w-0 flex-1">
          <Link to="/servers/$id" params={{ id: alert.server_id }} className="block truncate text-sm font-medium hover:text-primary hover:underline">{alert.server_name || t('dash.openHost')}</Link>
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground" title={alert.message}>{alert.message}</p>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={acknowledgingId === alert.id} onClick={() => onAcknowledge(alert.id)}>{t('det.acknowledge')}</Button>
      </div>)}
      {alerts.length > displayed.length && <div className="px-4 py-2.5 text-xs text-muted-foreground">{t('dash.moreAlerts', { count: alerts.length - displayed.length })}</div>}
    </div>
  </div>;
}

function RecentTasksSection({ history }: { history: HistoryEntry[] }) {
  const { t } = useTranslation();
  if (history.length === 0) return null;
  return (
    <div className="border-b">
      <DashboardSectionHeader icon={<Clock className="h-3.5 w-3.5" />} title={t('dash.runningFailedTasks')} count={history.length} />
        <div className="table-scroll hidden md:block">
          <table className="w-full text-sm" data-density="compact">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="w-8 px-4 py-2" /><th className="px-2 py-2">{t('dash.target')}</th><th className="px-2 py-2">{t('dash.task')}</th><th className="w-36 px-2 py-2">{t('dash.started')}</th><th className="w-32 px-4 py-2">{t('dash.result')}</th></tr></thead>
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

function AttentionHostsSection({ hosts, total, agentEnabled, t }: { hosts: ServerInfo[]; total: number; agentEnabled: boolean; t: TFunction }) {
  const [expanded, setExpanded] = useState(false);
  const visibleHosts = expanded ? hosts : hosts.slice(0, 6);

  return (
    <div>
      <DashboardSectionHeader
        icon={<Server className="h-3.5 w-3.5" />}
        title={t('dash.hostsRequiringAttention')}
        count={total}
        action={<Link to="/servers" search={{ attention: true }} className="text-xs font-medium text-primary hover:underline">{t('dash.allHosts')}</Link>}
      />
      <div className="table-scroll hidden md:block">
        <table className="w-full text-sm" data-density="compact">
          <thead><tr><th>{t('servers.host')}</th><th className="w-[120px]">{t('common.status')}</th><th>{t('dash.reason')}</th>{agentEnabled && <th className="w-[150px]">{t('dash.agentMode')}</th>}<th className="w-[100px]">{t('dash.colUptime')}</th></tr></thead>
          <tbody>{visibleHosts.map(server => <ServerRow key={server.id} s={server} t={t} agentEnabled={agentEnabled} />)}</tbody>
        </table>
      </div>
      <div className="divide-y md:hidden">{visibleHosts.map(server => <AttentionHostMobileRow key={server.id} server={server} />)}</div>
      {hosts.length > 6 && (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>{t(expanded ? 'dash.showingAllHosts' : 'dash.showingPriorityHosts', { count: total })}</span>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
            {expanded ? <><ChevronUp className="h-3.5 w-3.5" />{t('dash.showFewer')}</> : <><ChevronDown className="h-3.5 w-3.5" />{t('dash.showAll', { count: total })}</>}
          </Button>
        </div>
      )}
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
      <td className="px-2 py-2.5"><div className="flex flex-wrap gap-1"><AttentionReasonChips s={s} /></div></td>
      {agentEnabled && <td className="px-2 py-2.5"><AgentBadge s={s} /><span className="text-xs text-muted-foreground">{s.agent_mode === 'legacy' ? 'SSH' : t('dash.agentMode')}</span></td>}
      <td className="px-4 py-2.5">
        <span className={`font-mono text-xs ${!s.uptime_seconds ? 'text-muted-foreground' : ''}`}>
          {formatUptime(s.uptime_seconds)}
        </span>
      </td>
    </tr>
  );
}

function AttentionReasonChips({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const canViewUpdates = hasCap(profile, 'canViewUpdates');
  const canViewDocker = hasCap(profile, 'canViewDocker');
  const canViewCustomUpdates = hasCap(profile, 'canViewCustomUpdates');
  const chips: React.ReactNode[] = [];
  const failedOperations = s.attention?.reasons.find(reason => reason.code === 'failed_operations')?.count ?? 0;
  const activeAlertCount = s.attention?.reasons.find(reason => reason.code === 'active_alerts')?.count ?? (s.alert_count ?? 0);
  if (s.status === 'offline') chips.push(<StatusBadge key="offline" tone="danger">{t('common.offline')}</StatusBadge>);
  if (activeAlertCount > 0) chips.push(<StatusBadge key="alerts" tone="danger"><Bell className="mr-1 h-3 w-3" />{t('dash.alertCount', { count: activeAlertCount })}</StatusBadge>);
  if (canViewUpdates && s.reboot_required) chips.push(<StatusBadge key="rb" tone="warning"><RotateCcw className="mr-1 h-3 w-3" />{t('dash.needsReboot')}</StatusBadge>);
  if (canViewUpdates && (s.updates_count ?? 0) > 0) chips.push(<StatusBadge key="u" tone="warning"><PackagePlus className="mr-1 h-3 w-3" />{s.updates_count} {t('dash.colUpdates')}</StatusBadge>);
  if (canViewUpdates && canViewDocker && (s.image_updates_count ?? 0) > 0) chips.push(<StatusBadge key="i" tone="warning"><Container className="mr-1 h-3 w-3" />{s.image_updates_count} {t('dash.colImageUpdates')}</StatusBadge>);
  if (canViewCustomUpdates && (s.custom_updates_count ?? 0) > 0) chips.push(<StatusBadge key="c" tone="warning"><Cog className="mr-1 h-3 w-3" />{s.custom_updates_count} {t('dash.colCustomUpdates')}</StatusBadge>);
  if (failedOperations > 0) chips.push(<StatusBadge key="failed" tone="danger"><Clock className="mr-1 h-3 w-3" />{failedOperations} {failedOperations === 1 ? 'failed operation' : 'failed operations'}</StatusBadge>);
  if (chips.length === 0) return null;
  return <>{chips}</>;
}

const UpdatesChips = AttentionReasonChips;
