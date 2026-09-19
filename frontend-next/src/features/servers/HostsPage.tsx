import { lazy, Suspense, useState } from 'react';
const HostManagement = lazy(() => import('./ServersPage').then(module => ({default:module.ServersPage})));
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { useUi } from '@/lib/store';
import { hasCap, canAccessInfrastructure, useProfile } from '@/lib/queries';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { ImportProxmoxVmDialog } from '@/features/infrastructure/ImportProxmoxVmDialog';
import type { InfrastructureResponse, Vm } from '@/features/infrastructure/detail-model';
import type { ServerRow, ServerGroup } from './server-list-utils';

export function HostsPage() {
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const [management, setManagement] = useState(false);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const hosts = useQuery({ queryKey: ['servers', environmentId], queryFn: () => api.getServers(environmentId) as unknown as Promise<ServerRow[]>, refetchInterval: 30_000 });
  const groups = useQuery({ queryKey: ['server-groups', environmentId], queryFn: () => api.getServerGroups(environmentId) as unknown as Promise<ServerGroup[]> });
  const rows = (hosts.data || []).filter(host => (!group || host.group_id === group) && [host.name, host.ip_address, host.hostname].some(value => String(value || '').toLowerCase().includes(search.trim().toLowerCase())));
  if (management) return <div className="space-y-4"><Button variant="outline" onClick={() => setManagement(false)}>Back to hosts</Button><Suspense fallback={<p role="status">Loading host tools…</p>}><HostManagement /></Suspense></div>;
  return <div className="space-y-4">
    <PageHeader title="Hosts" actions={hasCap(profile, 'canEditServers') && <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />Add host</Button>} />
    <div className="flex flex-wrap gap-2">
      <Input className="max-w-sm" aria-label="Search hosts" placeholder="Search hosts" value={search} onChange={event => setSearch(event.target.value)} />
      <select className="rounded-md border bg-background px-3 text-sm" aria-label="Filter by group" value={group} onChange={event => setGroup(event.target.value)}>
        <option value="">All groups</option>{(groups.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {hasCap(profile, 'canEditServers') && <Button variant="ghost" onClick={() => setManagement(true)}>Groups and bulk actions</Button>}
    </div>
    {groups.isError && <QueryErrorState compact title="Groups could not be loaded" error={groups.error} onRetry={() => void groups.refetch()} />}
    {hosts.isError ? <QueryErrorState error={hosts.error} onRetry={() => void hosts.refetch()} /> : hosts.isPending ? <p role="status">Loading hosts…</p> : <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm"><thead className="border-b bg-muted/40"><tr>{['Name', 'Address', 'Connection', 'Last successful check', 'Group'].map(label => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(host => <tr key={host.id} className="border-b last:border-0 hover:bg-muted/30">
          <td className="px-4 py-3"><Link className="font-medium text-primary hover:underline" to="/servers/$id" params={{ id: host.id }}>{host.name}</Link>{host.deployment && <Link className="block text-xs text-muted-foreground hover:underline" to="/deployments/$id" params={{id:host.deployment.id}}>Deployment</Link>}</td>
          <td className="px-4 py-3 font-mono text-xs">{host.ip_address || host.hostname || 'Not configured'}</td>
          <td className="px-4 py-3"><StatusBadge tone={host.status === 'online' ? 'success' : ['offline','error'].includes(host.status || '') ? 'danger' : 'muted'}>{host.deployment && host.deployment.deployment_phase !== 'ready' ? !host.ip_address ? 'Waiting for IP' : host.deployment.status === 'failed' ? 'Connection or deployment failed' : host.deployment.deployment_phase === 'connect_host' ? 'Checking connection' : 'Finishing deployment' : host.status === 'online' ? 'Connected' : ['offline','error'].includes(host.status || '') ? 'Unreachable' : 'Not checked'}</StatusBadge></td>
          <td className="px-4 py-3 text-muted-foreground">{host.last_seen ? formatDateTime(host.last_seen) : 'Not checked'}</td>
          <td className="px-4 py-3">{host.group_name || groups.data?.find(item => item.id === host.group_id)?.name || '—'}</td>
        </tr>)}{!rows.length && <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">{search || group ? 'No hosts match these filters.' : 'Add a host to get started.'}</td></tr>}</tbody>
      </table>
    </div>}
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
