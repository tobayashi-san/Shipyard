import { EmptyState } from '@/components/ui/empty-state';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Download, Power, RefreshCw, X } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { useUi } from '@/lib/store';
import { hasCap, useProfile } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Timestamp } from '@/components/ui/timestamp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { appsStatus, catalogStatus, needsAction, packageIndex, pendingApps, pendingUpdates, type Catalog, type CustomApp, type UpdateHost } from '@/features/updates/model';

const RUNNING = ['running', 'pending', 'queued'];

/** More simultaneous reboots than this are refused by the API rate limit and are rarely intended. */
const MAX_BULK_REBOOTS = 5;

interface HistoryRow { id: string; kind: 'update' | 'reboot'; name: string; hosts: string[]; status: string; started_at: string; completed_at: string | null; triggered_by: string | null }

function CatalogCell({ host, catalog, kind }: { host: UpdateHost; catalog: Catalog; kind: 'system' | 'docker' }) {
  const status = catalogStatus(catalog, kind);
  const items = kind === 'system' ? catalog.updates : catalog.updates.filter(item => !['up_to_date', 'updated'].includes(item.status || ''));
  const title = kind === 'system' ? 'System' : 'Docker';
  const badge = <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
  return <section aria-label={`${title} updates for ${host.name}`} className="min-w-0">
    {items.length > 0 ? <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 marker:hidden">{badge}<ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
      <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs">{items.map((item, index) => <li key={index} className="break-words">
        <span className="font-medium">{kind === 'system' ? item.package : item.container_name || item.image}</span>{' '}
        <span className="break-all text-muted-foreground">{kind === 'system' ? `${item.current_version || 'installed'} → ${item.version || 'available'}${item.phased ? ' · phased' : ''}` : `${item.image || ''}${item.status === 'update_available' ? '' : ' · check required'}`}</span>
      </li>)}</ul>
      <Link to="/servers/$id" params={{ id: host.id }} hash={kind === 'system' ? 'tab=updates' : 'tab=docker'} className="mt-2 inline-block text-xs text-primary hover:underline">Open {title.toLowerCase()} updates</Link>
    </details> : badge}
    {catalog.failure && <p role="status" className="mt-1 break-words text-xs text-destructive">{catalog.failure.reason}</p>}
  </section>;
}

function AppsCell({ host, apps }: { host: UpdateHost; apps: CustomApp[] }) {
  const status = appsStatus(apps);
  const badge = <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
  return <section aria-label={`App updates for ${host.name}`} className="min-w-0">
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 marker:hidden">{badge}<ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
      <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto text-xs">{apps.map(app => <li key={app.id} className="break-words">
        <span className="font-medium">{app.name}</span>{' '}
        <span className="break-all text-muted-foreground">{app.failed ? 'check failed' : app.has_update ? `${app.current_version || 'installed'} → ${app.version || 'available'}` : app.current_version || 'not checked'}</span>
      </li>)}</ul>
      <Link to="/servers/$id" params={{ id: host.id }} hash="tab=updates" className="mt-2 inline-block text-xs text-primary hover:underline">Open app updates</Link>
    </details>
  </section>;
}

function lastCheck(host: UpdateHost, withDocker: boolean) {
  const times = [host.system.checked_at, withDocker ? host.docker?.checked_at : null].filter((value): value is string => Boolean(value));
  return times.sort()[0] || null;
}

async function inBatches<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  }));
}

function historyTone(status: string) {
  return status === 'success' ? 'success' : status === 'failed' ? 'danger' : RUNNING.includes(status) ? 'info' : 'muted';
}

export function UpdatesPage() {
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const search = useSearch({ from: '/_protected/updates' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canViewDocker = hasCap(profile, 'canViewDocker');
  const canRun = hasCap(profile, 'canRunUpdates');
  const canReboot = hasCap(profile, 'canRebootServers');
  const canCheckImages = hasCap(profile, 'canPullDocker');
  const canViewApps = hasCap(profile, 'canViewCustomUpdates');
  const canCheckApps = hasCap(profile, 'canRunCustomUpdates');
  const tab = search.tab || 'hosts';
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('action');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | 'install' | 'reboot'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['update-dashboard', environmentId],
    queryFn: () => apiFetch<UpdateHost[]>('/servers/update-dashboard', { environmentId }),
    refetchInterval: 30_000,
  });
  // History also drives the per-host "Updating…" state, so it polls faster while work runs.
  const history = useQuery({
    queryKey: ['update-history', environmentId],
    queryFn: () => apiFetch<HistoryRow[]>('/servers/update-history', { environmentId }),
    refetchInterval: query => (query.state.data || []).some(row => RUNNING.includes(row.status)) ? 5_000 : 30_000,
  });
  const runningByHost = useMemo(() => {
    const map = new Map<string, HistoryRow['kind']>();
    for (const row of history.data || []) if (RUNNING.includes(row.status)) for (const name of row.hosts) if (!map.has(name)) map.set(name, row.kind);
    return map;
  }, [history.data]);
  const hosts = useMemo(() => query.data || [], [query.data]);
  const packages = useMemo(() => packageIndex(hosts, canViewDocker), [hosts, canViewDocker]);
  const count = (host: UpdateHost) => pendingUpdates(host.system, 'system').length + (canViewDocker && host.docker ? pendingUpdates(host.docker, 'docker').length : 0) + pendingApps(host).length;
  const needsCheck = (host: UpdateHost) => catalogStatus(host.system, 'system').needsCheck || Boolean(canViewDocker && host.docker && catalogStatus(host.docker, 'docker').needsCheck) || Boolean(host.custom?.length && appsStatus(host.custom).needsCheck);
  const matching = hosts.filter(host => (!search.host || host.id === search.host) && `${host.name} ${host.ip_address || ''}`.toLowerCase().includes(text.toLowerCase()));
  const visible = matching.filter(host => filter === 'all' || search.host || (filter === 'action' ? needsAction(host, canViewDocker) : filter === 'available' ? count(host) > 0 : filter === 'reboot' ? host.reboot_required : needsCheck(host)))
    .sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name));
  const hiddenCurrent = filter === 'action' && !search.host ? matching.length - visible.length : 0;
  const selectedHosts = hosts.filter(host => selected.has(host.id));
  const allVisibleSelected = visible.length > 0 && visible.every(host => selected.has(host.id));
  const setTab = (next: string) => void navigate({ to: '/updates', search: { ...(next !== 'hosts' ? { tab: next as 'packages' | 'history' } : {}), ...(search.host ? { host: search.host } : {}) } });
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['update-dashboard'] }), queryClient.invalidateQueries({ queryKey: ['update-history'] }), queryClient.invalidateQueries({ queryKey: ['servers'] })]);

  const checkNow = async () => {
    const targets = selectedHosts.filter(host => host.status !== 'offline');
    let done = 0; let failed = 0;
    setBusy(`Checking 0 of ${targets.length}…`);
    await inBatches(targets, 3, async host => {
      try {
        await apiFetch(`/servers/${encodeURIComponent(host.id)}/updates?force=1&include_meta=1`, { environmentId });
        if (canCheckApps) for (const app of host.custom || []) await apiFetch(`/servers/${encodeURIComponent(host.id)}/custom-updates/${encodeURIComponent(app.id)}/check`, { method: 'POST', environmentId });
        if (canViewDocker && canCheckImages && host.docker) await apiFetch(`/servers/${encodeURIComponent(host.id)}/docker/image-updates`, { environmentId });
      } catch { failed++; }
      setBusy(`Checking ${++done} of ${targets.length}…`);
    });
    setBusy(null);
    await refresh();
    const skipped = selectedHosts.length - targets.length;
    showToast(`${targets.length - failed} of ${selectedHosts.length} hosts checked${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} offline skipped` : ''}.`, failed ? 'error' : 'success');
  };
  const install = async () => {
    setBusy('Starting system updates…');
    try {
      await apiFetch('/servers/update-all', { method: 'POST', body: JSON.stringify({ server_ids: selectedHosts.map(host => host.id) }), environmentId });
      showToast(`System update started on ${selectedHosts.length} ${selectedHosts.length === 1 ? 'host' : 'hosts'}.`, 'success');
      setSelected(new Set());
    } catch (error) { showToast((error as Error).message, 'error'); }
    setBusy(null); setConfirm(null);
    await refresh();
  };
  const reboot = async () => {
    setBusy('Starting reboots…');
    let failed = 0;
    for (const host of selectedHosts) { try { await api.runReboot(host.id); } catch { failed++; } }
    showToast(failed ? `${failed} of ${selectedHosts.length} reboots could not be started.` : `Reboot started on ${selectedHosts.length} ${selectedHosts.length === 1 ? 'host' : 'hosts'}.`, failed ? 'error' : 'success');
    setSelected(new Set()); setBusy(null); setConfirm(null);
    await refresh();
  };

  const catalogColumns = 1 + (canViewDocker ? 1 : 0) + (canViewApps ? 1 : 0);
  const columns = ['md:grid-cols-[1.5rem_minmax(12rem,1.4fr)_minmax(8rem,1fr)_8rem_2rem]', 'md:grid-cols-[1.5rem_minmax(12rem,1.4fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_8rem_2rem]', 'md:grid-cols-[1.5rem_minmax(12rem,1.4fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_8rem_2rem]'][catalogColumns - 1];
  const cellLabel = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden';
  const filteredHost = search.host ? hosts.find(host => host.id === search.host) : null;

  return <div className="space-y-5">
    <PageHeader title="Updates" description="Check, install and reboot across hosts." />
    {query.isError ? <QueryErrorState error={query.error} title="Updates could not be loaded" onRetry={() => void query.refetch()} /> : query.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading updates…</p> : <>
      {/* Each figure is also the shortcut to the hosts behind it. */}
      <div className={cn("-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 md:mx-0 md:grid md:grid-cols-3 md:gap-3 md:overflow-visible md:px-0 md:pb-0", catalogColumns === 3 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>{([
        ['System updates', hosts.reduce((sum, host) => sum + pendingUpdates(host.system, 'system').length, 0), 'available'],
        ...(canViewDocker ? [['Docker updates', hosts.reduce((sum, host) => sum + (host.docker ? pendingUpdates(host.docker, 'docker').length : 0), 0), 'available']] : []),
        ...(canViewApps ? [['App updates', hosts.reduce((sum, host) => sum + pendingApps(host).length, 0), 'available']] : []),
        ['Outdated checks', hosts.filter(needsCheck).length, 'check'], ['Reboot required', hosts.filter(host => host.reboot_required).length, 'reboot'],
      ] as [string, number, string][]).map(([label, value, target]) => <button key={label} type="button" onClick={() => { setFilter(target); if (tab !== 'hosts' || search.host) void navigate({ to: '/updates', search: {} }); }} aria-label={`${label}: ${value}. Show these hosts`} className={cn('min-w-[8.5rem] shrink-0 rounded-panel border bg-card px-3 py-2.5 text-left transition-colors md:min-w-0 md:p-4 hover:border-border-strong hover:bg-accent/40', filter === target && tab === 'hosts' && 'border-primary/50')}>
        <p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 text-xl font-semibold tabular-nums md:mt-1 md:text-2xl">{value}</p>
      </button>)}</div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Update views">
          <TabsTrigger value="hosts">Hosts</TabsTrigger>
          <TabsTrigger value="packages">Packages{packages.length ? ` (${packages.length})` : ''}</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'hosts' && <>
        <div className="flex flex-wrap items-center gap-3">
          <Input aria-label="Search hosts" placeholder="Search hosts…" value={text} onChange={event => setText(event.target.value)} className="sm:max-w-xs" />
          <select aria-label="Filter updates" value={filter} onChange={event => setFilter(event.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="action">Needs action</option><option value="available">Updates available</option><option value="check">Outdated or missing check</option><option value="reboot">Reboot required</option><option value="all">All hosts</option></select>
          {filteredHost && <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs">Host: <b>{filteredHost.name}</b><Link to="/updates" search={search.tab ? { tab: search.tab } : {}} aria-label="Show all hosts" className="ml-1 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></Link></span>}
        </div>

        {selected.size > 0 && <div role="toolbar" aria-label="Actions for selected hosts" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-panel border bg-card px-3 py-2 shadow-sm">
          <span className="text-sm font-medium">{selected.size} selected</span>
          {busy ? <span role="status" className="ml-2 text-sm text-muted-foreground">{busy}</span> : <>
            <Button size="sm" variant="outline" onClick={() => void checkNow()}><RefreshCw />Check now</Button>
            {canRun && <Button size="sm" onClick={() => setConfirm('install')}><Download />Install system updates</Button>}
            {canReboot && <Button size="sm" variant="outline" disabled={selected.size > MAX_BULK_REBOOTS} onClick={() => setConfirm('reboot')}><Power />Reboot</Button>}
            {canReboot && selected.size > MAX_BULK_REBOOTS && <span className="text-xs text-muted-foreground">Reboot up to {MAX_BULK_REBOOTS} hosts at once</span>}
          </>}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={Boolean(busy)} onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>}

        {!visible.length && !hiddenCurrent ? <EmptyState compact className="rounded-panel border bg-card" title={hosts.length ? 'No hosts match this filter.' : 'No hosts in this environment.'} /> : <div className="overflow-hidden rounded-panel border bg-card" role="table" aria-label="Updates by host">
          {visible.length > 0 && <div role="row" className={`hidden items-center gap-4 border-b bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid ${columns}`}>
            <span role="columnheader"><input type="checkbox" aria-label="Select all shown hosts" checked={allVisibleSelected} onChange={() => setSelected(current => { const next = new Set(current); for (const host of visible) { if (allVisibleSelected) next.delete(host.id); else next.add(host.id); } return next; })} /></span>
            <span role="columnheader">Host</span><span role="columnheader">System</span>{canViewDocker && <span role="columnheader">Docker</span>}{canViewApps && <span role="columnheader">Apps</span>}<span role="columnheader">Last check</span><span role="columnheader"><span className="sr-only">Open</span></span>
          </div>}
          {visible.map(host => { const checked = lastCheck(host, canViewDocker); return <div key={host.id} role="row" className={cn(`grid grid-cols-[1.5rem_1fr_1fr] items-start gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0 hover:bg-muted/30 md:items-center ${columns}`, selected.has(host.id) && 'bg-primary/[0.05]')}>
            <div role="cell" className="row-span-3 pt-0.5 md:row-span-1 md:pt-0"><input type="checkbox" aria-label={`Select ${host.name}`} checked={selected.has(host.id)} onChange={() => toggle(host.id)} /></div>
            <div role="cell" className="col-span-2 min-w-0 md:col-span-1"><div className="flex min-w-0 flex-wrap items-center gap-2"><Link to="/servers/$id" params={{ id: host.id }} className="truncate font-medium hover:underline">{host.name}</Link>{host.status !== 'online' && <StatusBadge tone={host.status === 'offline' ? 'danger' : 'muted'}>{host.status === 'offline' ? 'Offline' : 'Check connection'}</StatusBadge>}{runningByHost.has(host.name) ? <StatusBadge tone="info" dot pulse>{runningByHost.get(host.name) === 'reboot' ? 'Rebooting…' : 'Updating…'}</StatusBadge> : host.reboot_required && <StatusBadge tone="warning">Reboot required</StatusBadge>}</div><p className="truncate font-mono text-xs text-muted-foreground">{host.ip_address}</p></div>
            <div role="cell" className="min-w-0"><p className={cellLabel}>System</p><CatalogCell host={host} catalog={host.system} kind="system" /></div>
            {canViewDocker && <div role="cell" className="min-w-0"><p className={cellLabel}>Docker</p>{host.docker ? <CatalogCell host={host} catalog={host.docker} kind="docker" /> : <span className="text-sm text-muted-foreground">—</span>}</div>}
            {canViewApps && <div role="cell" className="min-w-0"><p className={cellLabel}>Apps</p>{host.custom?.length ? <AppsCell host={host} apps={host.custom} /> : <span className="text-sm text-muted-foreground">—</span>}</div>}
            <div role="cell" className="text-sm text-muted-foreground"><p className={cellLabel}>Last check</p>{checked ? <Timestamp value={checked} /> : 'Never'}</div>
            <div role="cell" className="hidden md:block"><Link to="/servers/$id" params={{ id: host.id }} hash="tab=updates" aria-label={`Open ${host.name}`} className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronRight className="h-4 w-4" /></Link></div>
          </div>; })}
          {hiddenCurrent > 0 && <button type="button" onClick={() => setFilter('all')} className="flex w-full items-center justify-between gap-2 border-t px-4 py-3 text-left text-sm text-muted-foreground first:border-t-0 hover:bg-muted/30">
            <span><StatusBadge tone="success">Up to date</StatusBadge> <span className="ml-1">{hiddenCurrent} {hiddenCurrent === 1 ? 'host is' : 'hosts are'} current</span></span><span className="inline-flex items-center gap-1 text-primary">Show hosts<ChevronDown className="size-4" /></span>
          </button>}
        </div>}
      </>}

      {tab === 'packages' && <PackagesView rows={packages} />}

      {tab === 'history' && (history.isError ? <QueryErrorState error={history.error} title="Update history could not be loaded" onRetry={() => void history.refetch()} /> : history.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading history…</p> : !history.data.length ? <EmptyState compact className="rounded-panel border bg-card" title="No update or reboot runs yet." /> : <ul className="divide-y rounded-panel border bg-card" aria-label="Update history">
        {history.data.map(row => <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{row.name}</span><StatusBadge tone={historyTone(row.status)}>{row.status === 'success' ? 'Successful' : row.status === 'failed' ? 'Failed' : row.status}</StatusBadge></div>
            <p className="break-words text-xs text-muted-foreground">{row.hosts.length > 3 ? `${row.hosts.slice(0, 3).join(', ')} +${row.hosts.length - 3}` : row.hosts.join(', ')} · {row.triggered_by || 'System'} · <Timestamp value={row.started_at} /></p>
          </div>
          <Button asChild variant="ghost" size="sm"><Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }}>View log<ChevronRight /></Link></Button>
        </li>)}
      </ul>)}
    </>}

    <ConfirmDialog open={confirm === 'install'} onOpenChange={open => !open && setConfirm(null)} title={`Install system updates on ${selectedHosts.length} ${selectedHosts.length === 1 ? 'host' : 'hosts'}?`}
      description={<>Runs the system update playbook as one job on: <b>{selectedHosts.map(host => host.name).join(', ')}</b>. Services may restart; a reboot is not started automatically.</>}
      confirmLabel="Install updates" variant="warning" isPending={busy !== null} closeOnConfirm={false} onConfirm={() => void install()} />
    <ConfirmDialog open={confirm === 'reboot'} onOpenChange={open => !open && setConfirm(null)} title={`Reboot ${selectedHosts.length} ${selectedHosts.length === 1 ? 'host' : 'hosts'}?`}
      description={<>The following hosts restart now and are briefly unavailable: <b>{selectedHosts.map(host => host.name).join(', ')}</b>.</>}
      confirmLabel="Reboot" variant="destructive" isPending={busy !== null} closeOnConfirm={false} onConfirm={() => void reboot()} />
  </div>;
}

function PackagesView({ rows }: { rows: ReturnType<typeof packageIndex> }) {
  const [text, setText] = useState('');
  const visible = rows.filter(row => `${row.name} ${row.hosts.map(host => host.name).join(' ')}`.toLowerCase().includes(text.toLowerCase()));
  return <div className="space-y-3">
    <Input aria-label="Search packages" placeholder="Search packages, images, apps or hosts…" value={text} onChange={event => setText(event.target.value)} className="sm:max-w-sm" />
    {!rows.length ? <EmptyState compact className="rounded-panel border bg-card" title="No pending updates" description="Based on the latest saved checks." /> : !visible.length ? <EmptyState compact className="rounded-panel border bg-card" title="No packages match this search." /> : <div className="overflow-x-auto rounded-panel border bg-card">
      <table className="w-full text-left text-sm" aria-label="Pending updates by package">
        <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-2 font-semibold">Package</th><th className="px-4 py-2 font-semibold">Type</th><th className="px-4 py-2 font-semibold">Hosts</th><th className="px-4 py-2 font-semibold">New version</th></tr></thead>
        <tbody>{visible.map(row => <tr key={row.key} className="border-b align-top last:border-0">
          <td className="px-4 py-2.5 font-mono text-xs font-medium">{row.name}</td>
          <td className="px-4 py-2.5 text-muted-foreground">{row.kind === 'system' ? 'System' : row.kind === 'docker' ? 'Docker' : 'App'}</td>
          <td className="px-4 py-2.5"><details><summary className="cursor-pointer">{row.hosts.length} {row.hosts.length === 1 ? 'host' : 'hosts'}</summary>
            <ul className="mt-1.5 space-y-1 text-xs">{row.hosts.map(host => <li key={`${host.id}:${host.detail}`}><Link to="/servers/$id" params={{ id: host.id }} hash={row.kind === 'docker' ? 'tab=docker' : 'tab=updates'} className="font-medium hover:underline">{host.name}</Link>{host.detail && <span className="ml-1.5 font-mono text-muted-foreground">{host.detail}</span>}</li>)}</ul>
          </details></td>
          <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{row.versions.join(', ') || '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
