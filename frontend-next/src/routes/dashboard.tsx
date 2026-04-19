import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Server, CheckCircle2, XCircle, RotateCcw, ArrowUp, AlertTriangle, RefreshCw,
  HeartPulse, Bell, Clock, Filter, Plus, Bot, Package, Box, Cog,
  HardDrive, Cpu, MemoryStick,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useUi } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { LiveDot, StatusBadge } from '@/components/ui/status-badge';
import { MetricBar, metricTextClass } from '@/components/ui/metric-bar';
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
  recentHistory: HistoryEntry[];
}

// ---- helpers ----

function needsAttention(s: ServerInfo) {
  return s.status === 'offline' || s.reboot_required ||
    (s.updates_count ?? 0) > 0 || (s.image_updates_count ?? 0) > 0 ||
    (s.custom_updates_count ?? 0) > 0 || (s.disk_pct ?? 0) >= 85 || (s.ram_pct ?? 0) >= 90;
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
  const hour12 = timeFormat === '12h';
  useEffect(() => { sessionStorage.setItem('shipyard.lastNonDetailRoute', '/'); }, []);
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api.getDashboard() as unknown as Promise<DashboardData>,
    refetchInterval: 30_000,
  });

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const onlineIds = (data?.servers ?? [])
        .filter(s => s.status === 'online')
        .map(s => s.id);
      // Force-refresh system info for all online servers in parallel
      await Promise.allSettled(onlineIds.map(id => api.getServerInfo(id, true)));
    } finally {
      await refetch();
      setRefreshing(false);
    }
  }, [data?.servers, refetch]);

  const isBusy = isFetching || refreshing;

  const summary = data?.summary ?? { total: 0, online: 0, offline: 0, rebootRequired: 0, totalUpdates: 0, criticalDisk: 0, criticalRam: 0 };
  const servers = data?.servers ?? [];
  const recentHistory = data?.recentHistory ?? [];
  const [attentionOnly, setAttentionOnly] = [
    useUi((s) => s.dashAttentionOnly),
    useUi((s) => s.setDashAttentionOnly),
  ];
  const attentionCount = useMemo(() => servers.filter(needsAttention).length, [servers]);

  const visible = attentionOnly ? servers.filter(needsAttention) : servers;
  const alerts = useMemo(() => {
    const out: { level: string; icon: React.ReactNode; text: string; serverId: string | number }[] = [];
    servers.forEach(s => {
      if (s.status === 'offline')
        out.push({ level: 'error', icon: <XCircle className="h-3.5 w-3.5" />, text: t('dash.alertOffline', { name: s.name }), serverId: s.id });
      if (s.reboot_required)
        out.push({ level: 'warning', icon: <RotateCcw className="h-3.5 w-3.5" />, text: t('dash.alertReboot', { name: s.name }), serverId: s.id });
      if ((s.disk_pct ?? 0) >= 85)
        out.push({ level: 'warning', icon: <HardDrive className="h-3.5 w-3.5" />, text: t('dash.alertDisk', { name: s.name, pct: s.disk_pct }), serverId: s.id });
      if ((s.ram_pct ?? 0) >= 90)
        out.push({ level: 'warning', icon: <MemoryStick className="h-3.5 w-3.5" />, text: t('dash.alertRam', { name: s.name, pct: s.ram_pct }), serverId: s.id });
      if ((s.updates_count ?? 0) > 0)
        out.push({ level: 'info', icon: <ArrowUp className="h-3.5 w-3.5" />, text: t('dash.alertUpdates', { name: s.name, count: s.updates_count }), serverId: s.id });
      if ((s.image_updates_count ?? 0) > 0)
        out.push({ level: 'info', icon: <Box className="h-3.5 w-3.5" />, text: t('dash.alertImageUpdates', { name: s.name, count: s.image_updates_count }), serverId: s.id });
      if ((s.custom_updates_count ?? 0) > 0)
        out.push({ level: 'info', icon: <Cog className="h-3.5 w-3.5" />, text: t('dash.alertCustomUpdates', { name: s.name, count: s.custom_updates_count }), serverId: s.id });
    });
    return out;
  }, [servers, t]);

  const updatesServerCount = servers.filter(s => (s.updates_count ?? 0) > 0 || (s.image_updates_count ?? 0) > 0 || (s.custom_updates_count ?? 0) > 0).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader
        title={t('dash.title')}
        description={isLoading ? t('dash.loading') : t('dash.updatedAt', { time: formatCurrentTime(hour12) })}
        actions={
          <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isBusy}>
            <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </Button>
        }
      />

      {isError && (
        <p className="text-sm text-destructive">{(error as Error)?.message}</p>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard icon={<Server className="h-4 w-4" />} value={summary.total} label={t('dash.totalServers')}
          footer={t('dash.statFooterReachable', { n: summary.online })} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} value={summary.online} label={t('dash.online')}
          color="success" footer={t('dash.statFooterOfTotal', { n: summary.total })} />
        <StatCard icon={<XCircle className="h-4 w-4" />} value={summary.offline} label={t('dash.offline')}
          color={summary.offline > 0 ? 'error' : undefined}
          footer={summary.offline > 0 ? t('dash.statFooterOfTotal', { n: summary.total }) : t('dash.statFooterAllClear')} />
        <StatCard icon={<RotateCcw className="h-4 w-4" />} value={summary.rebootRequired} label={t('dash.needsReboot')}
          color={summary.rebootRequired > 0 ? 'warning' : undefined}
          footer={summary.rebootRequired > 0 ? t('dash.statFooterServers', { n: summary.rebootRequired }) : t('dash.statFooterAllClear')} />
        <StatCard icon={<ArrowUp className="h-4 w-4" />} value={summary.totalUpdates} label={t('dash.updatesAvailable')}
          color={summary.totalUpdates > 0 ? 'warning' : undefined}
          footer={summary.totalUpdates > 0 ? t('dash.statFooterOnServers', { n: updatesServerCount }) : t('dash.statFooterAllClear')} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} value={summary.criticalDisk + summary.criticalRam} label={t('dash.resourcesCritical')}
          color={(summary.criticalDisk + summary.criticalRam) > 0 ? 'error' : undefined}
          footer={(summary.criticalDisk + summary.criticalRam) > 0
            ? t('dash.statFooterDiskRam', { disk: summary.criticalDisk, ram: summary.criticalRam })
            : t('dash.statFooterAllClear')} />
      </div>

      {/* Main grid: health table + side */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[1fr_340px]">
        {/* Server Health */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <HeartPulse className="h-4 w-4 text-muted-foreground" />
              {t('dash.serverHealth')}
            </CardTitle>
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
                {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}
              </div>
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
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="w-7 px-4 py-2" />
                        <th className="px-2 py-2">{t('common.name')}</th>
                        <th className="w-[170px] px-2 py-2">{t('dash.colRam')}</th>
                        <th className="w-[170px] px-2 py-2">{t('dash.colDisk')}</th>
                        <th className="w-[150px] px-2 py-2">{t('dash.colCpu')}</th>
                        <th className="w-[90px] px-2 py-2">{t('dash.colUptime')}</th>
                        <th className="w-[130px] px-2 py-2">{t('dash.colUpdates')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(s => <ServerRow key={s.id} s={s} t={t} />)}
                    </tbody>
                  </table>
                </div>
                {/* Mobile cards */}
                <div className="flex flex-col gap-3 p-4 md:hidden">
                  {visible.map(s => <ServerCard key={s.id} s={s} t={t} />)}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Side column */}
        <div className="flex flex-col gap-4">
          {/* Alerts */}
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0 px-4 py-3">
              <Bell className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-base">{t('dash.alerts')}</CardTitle>
              {alerts.length > 0 && <Badge variant="secondary">{alerts.length}</Badge>}
            </CardHeader>
            <CardContent className="space-y-0 p-0">
              {alerts.length === 0 ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" /> {t('dash.allClear')}
                </div>
              ) : (
                <div className="max-h-[320px] overflow-y-auto">
                  {alerts.map((a, i) => (
                    <Link key={i} to="/servers/$id" params={{ id: String(a.serverId) }}
                      className="flex items-center gap-2.5 border-b px-4 py-2 text-sm transition-colors last:border-b-0 hover:bg-muted/50">
                      <span className={
                        a.level === 'error' ? 'text-destructive' :
                        a.level === 'warning' ? 'text-amber-500' : 'text-blue-500'
                      }>
                        {a.icon}
                      </span>
                      <span className="truncate">{a.text}</span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Activity */}
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0 px-4 py-3">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">{t('dash.recentActivity')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-0 p-0">
              {recentHistory.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">{t('dash.noActivity')}</div>
              ) : (
                recentHistory.map((h, i) => (
                  <div key={h.id ?? i} className="flex items-center gap-3 border-b px-4 py-2 text-sm last:border-b-0">
                    <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                      h.status === 'success' ? 'bg-emerald-500' :
                      h.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground'
                    }`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{h.server_name || '–'}</div>
                      <div className="text-xs text-muted-foreground">
                        {h.action} · {formatRelativeTime(h.started_at, t)}
                      </div>
                    </div>
                    <StatusBadge tone={h.status === 'success' ? 'success' : h.status === 'failed' ? 'danger' : 'muted'}>
                      {h.status}
                    </StatusBadge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- sub-components ----

function StatCard({ icon, value, label, color, footer }: {
  icon: React.ReactNode; value: number; label: string; color?: 'success' | 'warning' | 'error'; footer: string;
}) {
  const valueClass = color === 'error' ? 'text-destructive' :
    color === 'warning' ? 'text-amber-500' :
    color === 'success' ? 'text-emerald-500' : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{icon}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{footer}</div>
      </CardContent>
    </Card>
  );
}

function MiniBar({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2">
      <MetricBar pct={pct} size="sm" className="min-w-[60px]" />
      <span className={`tabular-nums text-xs font-mono ${metricTextClass(pct)}`}>{pct}%</span>
    </div>
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

function UpdatesCell({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  const parts: React.ReactNode[] = [];
  if (s.reboot_required) parts.push(<span key="rb" title={t('dash.needsReboot')}><RotateCcw className="h-3 w-3" /></span>);
  if ((s.updates_count ?? 0) > 0) parts.push(<span key="u" className="flex items-center gap-0.5" title={t('dash.colUpdates')}><Package className="h-3 w-3" />{s.updates_count}</span>);
  if ((s.image_updates_count ?? 0) > 0) parts.push(<span key="i" className="flex items-center gap-0.5" title={t('dash.colImageUpdates')}><Box className="h-3 w-3" />{s.image_updates_count}</span>);
  if ((s.custom_updates_count ?? 0) > 0) parts.push(<span key="c" className="flex items-center gap-0.5" title={t('dash.colCustomUpdates')}><Cog className="h-3 w-3" />{s.custom_updates_count}</span>);
  if (parts.length === 0) return <span title={t('dash.allClear')}><CheckCircle2 className="h-4 w-4 text-emerald-500" /></span>;
  return <StatusBadge tone="warning" className="gap-1.5">{parts}</StatusBadge>;
}

function ServerRow({ s, t }: { s: ServerInfo; t: (k: string) => string }) {
  const navigate = useNavigate();
  const tags = s.tags ?? [];
  return (
    <tr className="border-b transition-colors last:border-b-0 hover:bg-muted/50 cursor-pointer"
      onClick={() => navigate({ to: '/servers/$id', params: { id: String(s.id) } })}>
      <td className="px-4 py-2.5">
        {s.status === 'online' ? (
          <LiveDot tone="success" />
        ) : (
          <span className={`inline-block h-2 w-2 rounded-full ${s.status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground'}`} />
        )}
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{s.name}</span>
          <AgentBadge s={s} />
          <span className="font-mono text-[11px] text-muted-foreground">{s.ip_address}</span>
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
      <td className="px-2 py-2.5"><MiniBar pct={s.ram_pct} /></td>
      <td className="px-2 py-2.5"><MiniBar pct={s.disk_pct} /></td>
      <td className="px-2 py-2.5"><MiniBar pct={s.cpu_pct} /></td>
      <td className="px-2 py-2.5">
        <span className={`font-mono text-xs ${!s.uptime_seconds ? 'text-muted-foreground' : ''}`}>
          {formatUptime(s.uptime_seconds)}
        </span>
      </td>
      <td className="px-2 py-2.5"><UpdatesCell s={s} /></td>
    </tr>
  );
}

function ServerCard({ s, t }: { s: ServerInfo; t: (k: string) => string }) {
  const dotCls = s.status === 'online' ? 'bg-emerald-500' : s.status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground';
  const statusLabel = s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown');
  const tags = s.tags ?? [];
  return (
    <Link to="/servers/$id" params={{ id: String(s.id) }}
      className="rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dotCls}`} />
        <span className="font-medium">{s.name}</span>
        <StatusBadge tone={s.status === 'online' ? 'success' : s.status === 'offline' ? 'danger' : 'muted'} className="ml-auto">{statusLabel}</StatusBadge>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <AgentBadge s={s} />
        <span className="font-mono">{s.ip_address}</span>
        <span className="font-mono">{formatUptime(s.uptime_seconds)}</span>
      </div>
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.slice(0, 4).map(tag => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{tag}</span>)}
          {tags.length > 4 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">+{tags.length - 4}</span>}
        </div>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <MobileMetric label={t('dash.colRam')} pct={s.ram_pct} />
        <MobileMetric label={t('dash.colDisk')} pct={s.disk_pct} />
        <MobileMetric label={t('dash.colCpu')} pct={s.cpu_pct} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <UpdatesChips s={s} />
      </div>
    </Link>
  );
}

function MobileMetric({ label, pct }: { label: string; pct?: number | null }) {
  return (
    <div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className={`font-mono ${metricTextClass(pct)}`}>{pct == null ? '—' : `${pct}%`}</span>
      </div>
      <MetricBar pct={pct} size="xs" className="mt-0.5" />
    </div>
  );
}

function UpdatesChips({ s }: { s: ServerInfo }) {
  const { t } = useTranslation();
  const chips: React.ReactNode[] = [];
  if (s.reboot_required) chips.push(<StatusBadge key="rb" tone="warning"><RotateCcw className="mr-1 h-3 w-3" />{t('dash.needsReboot')}</StatusBadge>);
  if ((s.updates_count ?? 0) > 0) chips.push(<StatusBadge key="u" tone="warning"><Package className="mr-1 h-3 w-3" />{s.updates_count} {t('dash.colUpdates')}</StatusBadge>);
  if ((s.image_updates_count ?? 0) > 0) chips.push(<StatusBadge key="i" tone="warning"><Box className="mr-1 h-3 w-3" />{s.image_updates_count} {t('dash.colImageUpdates')}</StatusBadge>);
  if ((s.custom_updates_count ?? 0) > 0) chips.push(<StatusBadge key="c" tone="warning"><Cog className="mr-1 h-3 w-3" />{s.custom_updates_count} {t('dash.colCustomUpdates')}</StatusBadge>);
  if (chips.length === 0) return <StatusBadge tone="success"><CheckCircle2 className="mr-1 h-3 w-3" />{t('dash.allClear')}</StatusBadge>;
  return <>{chips}</>;
}
