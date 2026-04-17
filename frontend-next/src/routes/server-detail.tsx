import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, PlayCircle, RotateCw, CircleDot, Cpu, HardDrive, MemoryStick, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface ServerDetail {
  id: number | string;
  name: string;
  ip_address?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: string;
  group_name?: string;
  tags?: string[] | string;
  description?: string;
}

interface ServerInfo {
  os?: string;
  kernel?: string;
  cpu?: string;
  cpu_cores?: number;
  cpu_usage_pct?: number | null;
  uptime_seconds?: number;
  ram_used_mb?: number | null;
  ram_total_mb?: number | null;
  disk_used_gb?: number;
  disk_total_gb?: number;
  updates_count?: number;
  _cached?: boolean;
}

interface HistoryRow {
  id: number | string;
  action?: string;
  status?: string;
  created_at?: string;
  duration_ms?: number;
  user?: string;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(mb: number | null | undefined, base: 'mb' | 'gb' = 'mb'): string {
  if (mb === null || mb === undefined) return '—';
  if (base === 'gb') return mb >= 1024 ? `${(mb / 1024).toFixed(1)} TB` : `${mb.toFixed(1)} GB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function StatTile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="truncate font-semibold">{value}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export function ServerDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? '';

  const { data: server, isLoading: loadingServer } = useQuery<ServerDetail>({
    queryKey: ['server', id],
    queryFn: async () => (await api.getServer(id)) as unknown as ServerDetail,
    enabled: !!id,
  });

  const { data: info, isLoading: loadingInfo, refetch: refetchInfo, isFetching: fetchingInfo } = useQuery<ServerInfo>({
    queryKey: ['server', id, 'info'],
    queryFn: async () => (await api.getServerInfo(id)) as unknown as ServerInfo,
    enabled: !!id,
  });

  const { data: history, isLoading: loadingHistory } = useQuery<HistoryRow[]>({
    queryKey: ['server', id, 'history'],
    queryFn: async () => (await api.getServerHistory(id)) as unknown as HistoryRow[],
    enabled: !!id,
  });

  const { data: notesData } = useQuery({
    queryKey: ['server', id, 'notes'],
    queryFn: () => api.getServerNotes(id),
    enabled: !!id,
  });

  const [notes, setNotes] = useState('');
  useEffect(() => { if (notesData?.notes !== undefined) setNotes(notesData.notes); }, [notesData?.notes]);

  const saveNotes = useMutation({
    mutationFn: () => api.saveServerNotes(id, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server', id, 'notes'] }),
  });

  const runUpdate = useMutation({
    mutationFn: () => api.runUpdate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server', id] }),
  });

  const runReboot = useMutation({
    mutationFn: () => api.runReboot(id),
  });

  const testConn = useMutation({
    mutationFn: () => api.testConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server', id] }),
  });

  if (loadingServer) {
    return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>;
  }
  if (!server) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/servers' })}>
          <ArrowLeft className="h-4 w-4" /> {t('common.back')}
        </Button>
        <p className="text-sm text-muted-foreground">{t('det.notFound')}</p>
      </div>
    );
  }

  const ramPct = info?.ram_total_mb ? Math.round(((info.ram_used_mb ?? 0) / info.ram_total_mb) * 100) : null;
  const diskPct = info?.disk_total_gb ? Math.round(((info.disk_used_gb ?? 0) / info.disk_total_gb) * 100) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/servers"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleDot className={`h-3 w-3 ${server.status === 'online' ? 'text-emerald-500' : server.status === 'offline' ? 'text-rose-500' : 'text-muted-foreground'}`} />
              <span>{server.ip_address}{server.ssh_port ? `:${server.ssh_port}` : ''}</span>
              {server.ssh_user && <span>· {server.ssh_user}</span>}
              {server.group_name && <span>· {server.group_name}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => testConn.mutate()} disabled={testConn.isPending}>
            <RefreshCw className={`h-4 w-4 ${testConn.isPending ? 'animate-spin' : ''}`} /> {t('det.testConn')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => runUpdate.mutate()} disabled={runUpdate.isPending}>
            <PlayCircle className="h-4 w-4" /> {t('det.runUpdate')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => runReboot.mutate()} disabled={runReboot.isPending}>
            <RotateCw className="h-4 w-4" /> {t('det.reboot')}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('det.tabOverview')}</TabsTrigger>
          <TabsTrigger value="updates">{t('det.tabUpdates')}</TabsTrigger>
          <TabsTrigger value="history">{t('det.tabHistory')}</TabsTrigger>
          <TabsTrigger value="notes">{t('det.tabNotes')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">{t('det.systemInfo')}</h2>
            <Button variant="ghost" size="sm" onClick={() => refetchInfo()} disabled={fetchingInfo}>
              <RefreshCw className={`h-3.5 w-3.5 ${fetchingInfo ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </Button>
          </div>

          {loadingInfo ? (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : !info ? (
            <div className="text-sm text-muted-foreground">{t('det.noInfo')}</div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  icon={<Cpu className="h-5 w-5" />}
                  label={t('det.cpu')}
                  value={info.cpu_usage_pct != null ? `${info.cpu_usage_pct.toFixed(0)}%` : '—'}
                  hint={info.cpu_cores ? `${info.cpu_cores} ${t('det.cores')}` : undefined}
                />
                <StatTile
                  icon={<MemoryStick className="h-5 w-5" />}
                  label={t('det.ram')}
                  value={ramPct !== null ? `${ramPct}%` : '—'}
                  hint={`${formatBytes(info.ram_used_mb)} / ${formatBytes(info.ram_total_mb)}`}
                />
                <StatTile
                  icon={<HardDrive className="h-5 w-5" />}
                  label={t('det.disk')}
                  value={diskPct !== null ? `${diskPct}%` : '—'}
                  hint={info.disk_total_gb ? `${(info.disk_used_gb ?? 0).toFixed(1)} / ${info.disk_total_gb.toFixed(1)} GB` : undefined}
                />
                <StatTile
                  icon={<Clock className="h-5 w-5" />}
                  label={t('det.uptime')}
                  value={info.uptime_seconds ? formatUptime(info.uptime_seconds) : '—'}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('det.systemInfo')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    {[
                      [t('det.os'), info.os],
                      [t('det.kernel'), info.kernel],
                      [t('det.cpu'), info.cpu],
                      [t('det.cores'), info.cpu_cores],
                      [t('det.updatesAvailable'), info.updates_count ?? 0],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="flex items-center justify-between border-b border-dashed py-1.5 last:border-0">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="font-medium">{v ?? '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="updates">
          <Card>
            <CardContent className="space-y-3 p-6">
              <p className="text-sm text-muted-foreground">{t('det.updatesHint')}</p>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-semibold tabular-nums">{info?.updates_count ?? 0}</span>
                <span className="text-sm text-muted-foreground">{t('det.pendingUpdates')}</span>
              </div>
              <Button onClick={() => runUpdate.mutate()} disabled={runUpdate.isPending}>
                <PlayCircle className="h-4 w-4" /> {t('det.runUpdate')}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardContent className="p-0">
              {loadingHistory ? (
                <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
              ) : !history || history.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">{t('det.noHistory')}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2">{t('det.action')}</th>
                      <th className="px-4 py-2">{t('common.status')}</th>
                      <th className="px-4 py-2">{t('det.user')}</th>
                      <th className="px-4 py-2">{t('det.when')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {history.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2 font-medium">{r.action || '—'}</td>
                        <td className="px-4 py-2">
                          <span className={`text-xs ${r.status === 'success' ? 'text-emerald-600' : r.status === 'failed' ? 'text-rose-600' : 'text-muted-foreground'}`}>
                            {r.status || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{r.user || '—'}</td>
                        <td className="px-4 py-2 text-muted-foreground tabular-nums">{r.created_at || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes">
          <Card>
            <CardContent className="space-y-3 p-6">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={12}
                placeholder={t('det.notesPlaceholder')}
              />
              <div className="flex justify-end">
                <Button onClick={() => saveNotes.mutate()} disabled={saveNotes.isPending}>
                  {t('common.save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
