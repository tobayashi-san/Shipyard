import { OverflowItem, OverflowMenu } from '@/components/ui/overflow-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { VmId } from "@/components/VmId";
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ImportProxmoxVmDialog } from '@/features/infrastructure/ImportProxmoxVmDialog';
import type { InfrastructureResponse, Vm } from '@/features/infrastructure/detail-model';
import { api, apiFetch } from '@/lib/api';
import { canAccessInfrastructure, hasCap, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { Timestamp } from '@/components/ui/timestamp';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpCircle, FolderTree, Plus, RotateCw } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { ServerGroup, ServerRow } from './server-list-utils';
function connectionLabel(host: ServerRow) {
  if (host.deployment && host.deployment.deployment_phase !== 'ready') return !host.ip_address ? 'Waiting for IP' : host.deployment.status === 'failed' ? 'Connection or deployment failed' : host.deployment.deployment_phase === 'connect_host' ? 'Checking connection' : 'Finishing deployment';
  return host.status === 'online' ? 'Connected' : ['offline','error'].includes(host.status || '') ? 'Unreachable' : 'Not checked';
}
function Connection({ host }: { host: ServerRow }) {
  return <span className="inline-flex" title={host.last_seen ? undefined : 'Never checked'}>
    <StatusBadge tone={host.status === 'online' ? 'success' : ['offline','error'].includes(host.status || '') ? 'danger' : 'muted'}>{connectionLabel(host)}</StatusBadge>
  </span>;
}
function percent(used?: number | null, total?: number | null) {
  return used != null && total ? Math.round((used / total) * 100) : null;
}
/** Compact usage bar; colour changes only when action is needed. */
function Usage({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const tone = value >= 90 ? 'bg-destructive' : value >= 80 ? 'bg-[hsl(var(--warning))]' : 'bg-muted-foreground/45';
  return <div className="flex items-center gap-2 text-xs" title={`${label} ${value}%`}>
    <span className="w-8 text-muted-foreground">{label}</span>
    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"><span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.min(value, 100)}%` }} /></span>
    <span className={cn('w-9 text-right tabular-nums', value >= 80 ? 'font-medium text-foreground' : 'text-muted-foreground')}>{value}%</span>
  </div>;
}
function Resources({ host }: { host: ServerRow }) {
  const disk = percent(host.resources?.disk_used_gb, host.resources?.disk_total_gb);
  const ram = percent(host.resources?.ram_used_mb, host.resources?.ram_total_mb);
  if (disk === null && ram === null) return <span className="text-muted-foreground">—</span>;
  return <div className="space-y-1"><Usage label="Disk" value={disk} /><Usage label="RAM" value={ram} /></div>;
}
/** Small pointer to the Updates workspace; the inventory itself does not manage patches. */
function UpdateHint({ host }: { host: ServerRow }) {
  const pending = (host.updates_count || 0) + (host.image_updates_count || 0) + (host.custom_updates_count || 0);
  if (!pending && !host.reboot_required) return null;
  const label = [pending ? `${pending} ${pending === 1 ? 'update' : 'updates'} available` : '', host.reboot_required ? 'reboot required' : ''].filter(Boolean).join(', ');
  return <Link to="/updates" search={{ host: host.id }} title={label} aria-label={`${host.name}: ${label}`} className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.1)] px-1.5 py-0.5 text-[11px] font-semibold text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.18)]">
    {pending > 0 && <span className="inline-flex items-center gap-0.5"><ArrowUpCircle className="h-3 w-3" aria-hidden="true" />{pending}</span>}
    {host.reboot_required && <RotateCw className="h-3 w-3" aria-hidden="true" />}
  </Link>;
}
/** "Debian GNU/Linux 13 (trixie)" reads as "Debian 13". */
function shortOs(os?: string | null) {
  return os ? os.replace(/\s*GNU\/Linux/i, '').replace(/\s*\(.*\)\s*$/, '').replace(/\s+LTS$/i, '').trim() : '';
}
function shortUptime(seconds?: number | null) {
  if (seconds == null) return '';
  return seconds >= 86400 ? `${Math.floor(seconds / 86400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.max(1, Math.floor(seconds / 60))}m`;
}
type SortKey = 'name' | 'connection' | 'resources' | 'os' | 'uptime';
const CONNECTION_ORDER: Record<string, number> = { offline: 0, error: 0, online: 2 };
function sortValue(host: ServerRow, key: SortKey): string | number {
  if (key === 'connection') return CONNECTION_ORDER[host.status || ''] ?? 1;
  if (key === 'resources') return percent(host.resources?.disk_used_gb, host.resources?.disk_total_gb) ?? -1;
  if (key === 'os') return shortOs(host.resources?.os).toLowerCase();
  if (key === 'uptime') return host.resources?.uptime_seconds ?? -1;
  return host.name.toLowerCase();
}

function GroupTags({ host, groupName, hidden }: { host: ServerRow; groupName?: string; hidden: Set<string> }) {
  const tags = (host.tags || []).filter(tag => !hidden.has(tag));
  if (!groupName && !tags.length) return <span className="text-muted-foreground">—</span>;
  return <div className="flex items-center gap-1 whitespace-nowrap">
    {groupName && <span className="font-medium">{groupName}</span>}
    {tags.slice(0, 2).map(tag => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag}</span>)}
    {tags.length > 2 && <span className="text-[11px] text-muted-foreground" title={tags.slice(2).join(', ')}>+{tags.length - 2}</span>}
  </div>;
}

const HostManagement = lazy(() => import('./ServersPage').then(module => ({default:module.ServersPage})));

export function HostsPage() {
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const [management, setManagement] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const hosts = useQuery({ queryKey: ['servers', environmentId], queryFn: () => api.getServers(environmentId) as unknown as Promise<ServerRow[]>, refetchInterval: 30_000 });
  const groups = useQuery({ queryKey: ['server-groups', environmentId], queryFn: () => api.getServerGroups(environmentId) as unknown as Promise<ServerGroup[]> });
  const rows = (hosts.data || []).filter(host => (!group || host.group_id === group) && [host.name, host.ip_address, host.hostname, host.resources?.os, ...(host.tags || [])].some(value => String(value || '').toLowerCase().includes(search.trim().toLowerCase())));
  // A group/tag column that is empty on every row only adds noise.
  // Tags carried by every host (for example an import source) tell hosts apart no better than no tag.
  const allHosts = hosts.data || [];
  const commonTags = new Set(allHosts.length > 1 ? (allHosts[0].tags || []).filter(tag => allHosts.every(host => host.tags?.includes(tag))) : []);
  const showGroups = allHosts.some(host => host.group_id || host.tags?.some(tag => !commonTags.has(tag)));
  const columns: { label: string; key?: SortKey }[] = [
    { label: 'Name', key: 'name' }, { label: 'Address' }, { label: 'Connection', key: 'connection' }, { label: 'Resources', key: 'resources' },
    ...(showGroups ? [{ label: 'Group / Tags' }] : []), { label: 'OS', key: 'os' }, { label: 'Uptime', key: 'uptime' },
  ];
  const sorted = [...rows].sort((a, b) => {
    const left = sortValue(a, sort.key), right = sortValue(b, sort.key);
    const order = left < right ? -1 : left > right ? 1 : a.name.localeCompare(b.name);
    return sort.dir === 'asc' ? order : -order;
  });
  if (management) return <div className="space-y-4"><Button variant="outline" onClick={() => setManagement(false)}>Back to hosts</Button><Suspense fallback={<p role="status">Loading host tools…</p>}><HostManagement /></Suspense></div>;
  return <div className="space-y-4">
    <PageHeader title="Hosts" actions={hasCap(profile, 'canEditServers') && <><Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />Add host</Button><OverflowMenu title="More host actions"><OverflowItem icon={FolderTree} onClick={() => setManagement(true)}>Manage groups…</OverflowItem></OverflowMenu></>} />
    <div className="flex flex-wrap gap-2">
      <Input className="max-w-sm" aria-label="Search hosts" placeholder="Search name, IP, tag or OS" value={search} onChange={event => setSearch(event.target.value)} />
      {(groups.data?.length || group) ? <select className="w-auto" aria-label="Filter by group" value={group} onChange={event => setGroup(event.target.value)}>
        <option value="">All groups</option>{(groups.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select> : null}
    </div>
    {groups.isError && <QueryErrorState compact title="Groups could not be loaded" error={groups.error} onRetry={() => void groups.refetch()} />}
    {hosts.isError ? <QueryErrorState error={hosts.error} onRetry={() => void hosts.refetch()} /> : hosts.isPending ? <p role="status">Loading hosts…</p> : <>
      <ul className="divide-y rounded-md border md:hidden" aria-label="Hosts">
        {sorted.map(host => <li key={host.id} className="space-y-2 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2"><Link className="truncate font-medium hover:underline" to="/servers/$id" params={{ id: host.id }}>{host.name}</Link><UpdateHint host={host} /></div>
              <p className="truncate font-mono text-xs text-muted-foreground">{host.ip_address || host.hostname || 'Not configured'}{shortOs(host.resources?.os) ? ` · ${shortOs(host.resources?.os)}` : ''}</p>
            </div>
            <Connection host={host} />
          </div>
          <Resources host={host} />
        </li>)}
        {!rows.length && <li><EmptyState compact title={search || group ? 'No hosts match these filters.' : 'Add a host to get started.'} /></li>}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border md:block">
      <table className="w-full text-left text-sm"><thead className="border-b bg-muted/40"><tr>{columns.map(column => <th className="px-4 py-3 font-medium" key={column.label} aria-sort={column.key && sort.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
          {column.key ? <button type="button" className="inline-flex items-center gap-1 [font-size:inherit] [font-weight:inherit] [letter-spacing:inherit] [text-transform:inherit] hover:text-foreground" onClick={() => setSort(current => ({ key: column.key!, dir: current.key === column.key && current.dir === 'asc' ? 'desc' : column.key === 'resources' || column.key === 'uptime' ? (current.key === column.key ? 'asc' : 'desc') : 'asc' }))}>{column.label}{sort.key === column.key && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button> : column.label}
        </th>)}</tr></thead>
        <tbody>{sorted.map(host => <tr key={host.id} className="border-b last:border-0 hover:bg-muted/30">
          <td className="px-4 py-3"><div className="flex items-center gap-2 whitespace-nowrap"><Link className="font-medium hover:underline" to="/servers/$id" params={{ id: host.id }}>{host.name}</Link><VmId value={host.proxmox_vm_id} /><UpdateHint host={host} /></div>{host.deployment && <Link className="block text-xs text-muted-foreground hover:underline" to="/deployments/$id" params={{id:host.deployment.id}}>Deployment</Link>}</td>
          <td className="px-4 py-3 font-mono text-xs">{host.ip_address || host.hostname || 'Not configured'}</td>
          <td className="px-4 py-3"><Connection host={host} />{host.status !== 'online' && host.last_seen && <p className="mt-1 text-xs text-muted-foreground">Last seen <Timestamp value={host.last_seen} /></p>}</td>
          <td className="px-4 py-3"><Resources host={host} /></td>
          {showGroups && <td className="px-4 py-3"><GroupTags host={host} hidden={commonTags} groupName={host.group_name || groups.data?.find(item => item.id === host.group_id)?.name} /></td>}
          <td className="px-4 py-3 text-muted-foreground" title={host.resources?.os || undefined}>{shortOs(host.resources?.os) || '—'}</td>
          <td className="px-4 py-3 tabular-nums text-muted-foreground">{shortUptime(host.resources?.uptime_seconds) || '—'}</td>
        </tr>)}{!rows.length && <tr><td colSpan={columns.length}><EmptyState compact title={search || group ? 'No hosts match these filters.' : 'Add a host to get started.'} /></td></tr>}</tbody>
      </table>
    </div></>}
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>Add host</DialogTitle></DialogHeader><div className="grid gap-2">
      <Button variant="outline" onClick={() => { setAddOpen(false); setManualOpen(true); }}>Enter host details</Button>
      {canAccessInfrastructure(profile) && <Button variant="outline" onClick={() => { setAddOpen(false); setImportOpen(true); }}>Import from Proxmox</Button>}
    </div></DialogContent></Dialog>
    <CreateServerDialog open={manualOpen} onOpenChange={setManualOpen} />
    {importOpen && <ProxmoxHostPicker key={environmentId} environmentId={environmentId} onClose={() => setImportOpen(false)} />}
  </div>;
}

function ProxmoxHostPicker({ environmentId, onClose }: { environmentId: string; onClose: () => void }) {
  const [selection, setSelection] = useState<{ connectionId: string; vm: Vm } | null>(null);
  const [search, setSearch] = useState('');
  const inventory = useQuery({
    queryKey: ['opentofu', 'host-import', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`, { environmentId }),
    refetchInterval: query => query.state.data?.refreshing ? 2_000 : false,
  });
  if (selection) return <ImportProxmoxVmDialog open connectionId={selection.connectionId} environmentId={environmentId} vm={selection.vm} onOpenChange={open => { if (!open) onClose(); }} />;
  const guests = (inventory.data?.clusters || []).flatMap(cluster => cluster.vms.filter(vm => !vm.fleet_server_id).map(vm => ({ vm, connectionId: cluster.connections?.[0]?.id, cluster: cluster.endpoint })));
  const filtered = guests.filter(({ vm }) => `${vm.name} ${vm.node_name} ${vm.vm_id}`.toLowerCase().includes(search.toLowerCase()));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Import from Proxmox</DialogTitle></DialogHeader>
    <Input placeholder="Search VMs" aria-label="Search VMs" value={search} onChange={event => setSearch(event.target.value)} />
    {inventory.data?.warnings?.length ? <div role="alert" className="text-sm text-destructive">{inventory.data.warnings.join(' ' )}<Button variant="outline" size="sm" onClick={() => void inventory.refetch()}>Try again</Button></div> : null}
    {inventory.isError ? <QueryErrorState error={inventory.error} onRetry={() => void inventory.refetch()} /> : inventory.isPending || inventory.data?.refreshing ? <p role="status">Loading VMs…</p> : <div className="max-h-96 space-y-2 overflow-y-auto">
      {filtered.map(({ vm, connectionId, cluster }) => <Button key={`${cluster}/${vm.node_name}/${vm.vm_id}`} variant="outline" className="h-auto w-full justify-between py-3" disabled={!connectionId} onClick={() => connectionId && setSelection({ connectionId, vm })}><span>{vm.name}</span><span className="text-xs text-muted-foreground">{vm.node_name} · {vm.vm_id}</span></Button>)}
      {!filtered.length && <p className="py-4 text-sm text-muted-foreground">No VMs available to import.</p>}
    </div>}
  </DialogContent></Dialog>;
}
