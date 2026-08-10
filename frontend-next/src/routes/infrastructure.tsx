import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Cpu, Database, HardDrive, MemoryStick, Pencil, Plus, RefreshCw, Server, Trash2, TriangleAlert } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { useUi } from '@/lib/store';
import { useProfile } from '@/lib/queries';
import { ProxmoxConnectionDialog, type ProxmoxConnection } from '@/features/infrastructure/ProxmoxConnectionDialog';

interface NodeInfo { name: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number }
interface VmInfo { name: string; node_name: string; vm_id: number; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number }
interface Cluster { id: string; endpoint: string; status: string; connections?: Array<{ id: string; name: string }>; deployments: Array<{ id: string; name: string }>; nodes: NodeInfo[]; vms: VmInfo[] }
interface InfrastructureResponse { clusters?: Cluster[]; warnings?: string[] }
interface FleetHost { id: string; name: string; ip_address?: string; status?: string; environment_id?: string }
interface FleetHostInfo { cpu_usage_pct?: number; ram_total_mb?: number; ram_used_mb?: number; disk_total_gb?: number; disk_used_gb?: number; uptime_seconds?: number }

function tone(status: string): StatusTone {
  if (status === 'online' || status === 'running') return 'success';
  if (status === 'offline' || status === 'stopped') return 'danger';
  return 'muted';
}

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function percent(value: number, maximum: number) {
  if (!maximum) return '—';
  return `${Math.round((value / maximum) * 100)} %`;
}

function uptime(seconds: number) {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  if (days) return `${days} d`;
  return `${Math.floor(seconds / 3600)} h`;
}

export function InfrastructurePage() {
  const queryClient = useQueryClient();
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionToEdit, setConnectionToEdit] = useState<ProxmoxConnection | null>(null);
  const [connectionToDelete, setConnectionToDelete] = useState<ProxmoxConnection | null>(null);
  const isAdmin = profile?.role === 'admin';
  const inventoryQuery = useQuery({
    queryKey: ['opentofu', 'infrastructure', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/plugin/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const connectionsQuery = useQuery({
    queryKey: ['opentofu', 'proxmox-connections', environmentId],
    queryFn: () => apiFetch<ProxmoxConnection[]>(`/plugin/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const connections = Array.isArray(connectionsQuery.data) ? connectionsQuery.data : [];
  const clusters = Array.isArray(inventoryQuery.data?.clusters) ? inventoryQuery.data!.clusters! : [];
  const hostsQuery = useQuery({ queryKey: ['servers'], queryFn: () => api.getServers() as unknown as Promise<FleetHost[]>, staleTime: 30_000 });
  const hosts = useMemo(() => (Array.isArray(hostsQuery.data) ? hostsQuery.data : []).filter(host => String(host.environment_id || 'default') === environmentId), [environmentId, hostsQuery.data]);
  const hostInfoQueries = useQueries({ queries: hosts.map(host => ({ queryKey: ['servers', host.id, 'info'], queryFn: () => api.getServerInfo(host.id) as unknown as Promise<FleetHostInfo>, staleTime: 30_000 })) });
  const totals = useMemo(() => clusters.reduce((result, cluster) => ({
    clusters: result.clusters + 1,
    nodes: result.nodes + cluster.nodes.length,
    vms: result.vms + cluster.vms.length,
    online: result.online + cluster.vms.filter(vm => vm.status === 'running').length,
  }), { clusters: 0, nodes: 0, vms: 0, online: 0 }), [clusters]);
  const capacity = useMemo(() => clusters.reduce((result, cluster) => cluster.nodes.reduce((next, node) => ({
    cpuUsed: next.cpuUsed + (node.cpu * node.maxcpu), cpuTotal: next.cpuTotal + node.maxcpu,
    memUsed: next.memUsed + node.mem, memTotal: next.memTotal + node.maxmem,
    diskUsed: next.diskUsed + node.disk, diskTotal: next.diskTotal + node.maxdisk,
  }), result), { cpuUsed: 0, cpuTotal: 0, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0 }), [clusters]);

  const refreshing = inventoryQuery.isFetching || hostsQuery.isFetching || hostInfoQueries.some(query => query.isFetching);
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', environmentId] }); void queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', environmentId] }); void queryClient.invalidateQueries({ queryKey: ['servers'] }); };
  return <div className="space-y-6">
    <PageHeader title="Infrastruktur" description="Host-orientierte Übersicht über angebundene Plattformen, Nodes, VMs und Fleet-Hosts der gewählten Umgebung." actions={<Button type="button" variant="outline" onClick={refresh} disabled={refreshing}><RefreshCw className={refreshing ? 'animate-spin' : undefined} />Aktualisieren</Button>} />

    {inventoryQuery.isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map(item => <Skeleton key={item} className="h-24" />)}</div> : <>
      {inventoryQuery.data?.warnings?.length ? <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"><div className="flex items-center gap-2 font-medium"><TriangleAlert className="h-4 w-4" />Nicht alle Proxmox-Verbindungen sind erreichbar</div><ul className="mt-1 list-disc pl-6 text-xs">{inventoryQuery.data.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div> : null}
      {inventoryQuery.isError && hosts.length === 0 ? <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Infrastruktur konnte nicht geladen werden" description="Prüfe die eingebundenen Plattformen oder Fleet-Hosts und versuche es erneut." /></Card> : clusters.length === 0 && hosts.length === 0 ? <Card><EmptyState icon={<Database className="h-5 w-5" />} title="Noch keine Infrastruktur verbunden" description="Füge einen Fleet-Host hinzu oder lege eine Proxmox-Verbindung in dieser Umgebung an." action={isAdmin ? <Button type="button" onClick={() => { setConnectionToEdit(null); setConnectionDialogOpen(true); }}><Plus />Proxmox verbinden</Button> : <Button asChild><Link to="/servers">Host hinzufügen</Link></Button>} /></Card> : <>
        <div className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={Database} label="Cluster" value={totals.clusters} />
          <Metric icon={Server} label="Nodes" value={totals.nodes} />
          <Metric icon={Boxes} label="VMs" value={totals.vms} />
          <Metric icon={Cpu} label="VMs gestartet" value={`${totals.online}/${totals.vms}`} />
          <Metric icon={Cpu} label="CPU (Nodes)" value={capacity.cpuTotal ? `${Math.round((capacity.cpuUsed / capacity.cpuTotal) * 100)} % · ${capacity.cpuTotal} Cores` : '—'} />
          <Metric icon={MemoryStick} label="RAM (Nodes)" value={capacity.memTotal ? `${bytes(capacity.memUsed)} / ${bytes(capacity.memTotal)}` : '—'} />
          <Metric icon={HardDrive} label="Disk (Nodes)" value={capacity.diskTotal ? `${bytes(capacity.diskUsed)} / ${bytes(capacity.diskTotal)}` : '—'} />
          <Metric icon={HardDrive} label="Fleet-Hosts" value={hosts.length} />
        </div>
        {clusters.map(cluster => <ClusterCard key={cluster.id} cluster={cluster} />)}
        {hosts.length > 0 && <FleetHostsCard hosts={hosts} infos={hostInfoQueries.map(query => query.data)} />}
      </>}
    </>}
    <ProxmoxConnectionsCard connections={connections} isAdmin={isAdmin} onAdd={() => { setConnectionToEdit(null); setConnectionDialogOpen(true); }} onEdit={connection => { setConnectionToEdit(connection); setConnectionDialogOpen(true); }} onDelete={setConnectionToDelete} />
    <ProxmoxConnectionDialog environmentId={environmentId} connection={connectionToEdit} open={connectionDialogOpen} onOpenChange={setConnectionDialogOpen} />
    <ConfirmDeleteConnection connection={connectionToDelete} onOpenChange={open => !open && setConnectionToDelete(null)} onDeleted={() => { setConnectionToDelete(null); refresh(); }} />
  </div>;
}

function ProxmoxConnectionsCard({ connections, isAdmin, onAdd, onEdit, onDelete }: { connections: ProxmoxConnection[]; isAdmin: boolean; onAdd: () => void; onEdit: (connection: ProxmoxConnection) => void; onDelete: (connection: ProxmoxConnection) => void }) {
  return <Card>
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b"><div><CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />Plattform-Verbindungen</CardTitle><p className="mt-1 text-xs text-muted-foreground">Infrastrukturquellen dieser Umgebung. Sie sind unabhängig von Deployments und können mehrfach verwendet werden.</p></div>{isAdmin && <Button type="button" size="sm" onClick={onAdd}><Plus />Proxmox verbinden</Button>}</CardHeader>
    <CardContent className="p-0">{connections.length === 0 ? <div className="px-4 py-5 text-sm text-muted-foreground">Noch keine Proxmox-Plattform verbunden.</div> : <div className="divide-y">{connections.map(connection => <div key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><div className="font-medium">{connection.name}</div><div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{connection.endpoint}</div></div><div className="flex items-center gap-2"><StatusBadge tone={connection.api_token_configured ? 'success' : 'danger'} dot>{connection.api_token_configured ? 'Zugang eingerichtet' : 'Token fehlt'}</StatusBadge>{isAdmin && <><Button type="button" size="icon" variant="ghost" onClick={() => onEdit(connection)} aria-label={`${connection.name} bearbeiten`}><Pencil className="h-4 w-4" /></Button><Button type="button" size="icon" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(connection)} aria-label={`${connection.name} entfernen`}><Trash2 className="h-4 w-4" /></Button></>}</div></div>)}</div>}</CardContent>
  </Card>;
}

function ConfirmDeleteConnection({ connection, onOpenChange, onDeleted }: { connection: ProxmoxConnection | null; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  const queryClient = useQueryClient();
  const deletion = useMutation({
    mutationFn: () => apiFetch(`/plugin/opentofu/proxmox-connections/${encodeURIComponent(connection?.id || '')}`, { method: 'DELETE' }),
    onSuccess: async () => {
      if (!connection) return;
      showToast('Plattform-Verbindung entfernt.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', connection.environment_id] });
      await queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', connection.environment_id] });
      onDeleted();
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  return <ConfirmDialog open={Boolean(connection)} onOpenChange={onOpenChange} title="Plattform-Verbindung entfernen?" description={connection ? <>Die Verbindung <strong>{connection.name}</strong> wird entfernt. Falls Deployments sie noch verwenden, schützt Fleet die Verbindung und fordert zuerst eine Umordnung.</> : ''} confirmLabel="Verbindung entfernen" cancelLabel="Abbrechen" variant="destructive" onConfirm={() => deletion.mutate()} isPending={deletion.isPending} />;
}

function FleetHostsCard({ hosts, infos }: { hosts: FleetHost[]; infos: Array<FleetHostInfo | undefined> }) {
  return <Card>
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b"><div><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" />Fleet-Hosts</CardTitle><p className="mt-1 text-xs text-muted-foreground">Einzelne VPS, Bare-Metal-Server und per Agent oder SSH verwaltete Systeme.</p></div><Button asChild size="sm" variant="outline"><Link to="/servers">Alle Hosts</Link></Button></CardHeader>
    <CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">Host</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">CPU</th><th className="px-4 py-2.5 font-medium">Arbeitsspeicher</th><th className="px-4 py-2.5 font-medium">Disk</th><th className="px-4 py-2.5 font-medium">Uptime</th></tr></thead><tbody className="divide-y">{hosts.map((host, index) => { const info = infos[index]; return <tr key={host.id} className="hover:bg-muted/20"><td className="px-4 py-3"><Link to="/servers/$id" params={{ id: host.id }} className="font-medium hover:text-primary hover:underline">{host.name}</Link><div className="mt-0.5 font-mono text-xs text-muted-foreground">{host.ip_address || '—'}</div></td><td className="px-4 py-3"><StatusBadge tone={tone(host.status || 'unknown')} dot>{host.status || 'unknown'}</StatusBadge></td><td className="px-4 py-3 tabular-nums">{Number.isFinite(info?.cpu_usage_pct) ? `${Math.round(Number(info?.cpu_usage_pct))} %` : '—'}</td><td className="px-4 py-3 tabular-nums">{info?.ram_total_mb ? `${Math.round(Number(info.ram_used_mb || 0))} / ${Math.round(Number(info.ram_total_mb))} MB · ${percent(Number(info.ram_used_mb || 0), Number(info.ram_total_mb))}` : '—'}</td><td className="px-4 py-3 tabular-nums">{info?.disk_total_gb ? `${Number(info.disk_used_gb || 0).toFixed(1)} / ${Number(info.disk_total_gb).toFixed(1)} GB · ${percent(Number(info.disk_used_gb || 0), Number(info.disk_total_gb))}` : '—'}</td><td className="px-4 py-3 font-mono text-xs">{uptime(Number(info?.uptime_seconds || 0))}</td></tr>; })}</tbody></table></div></CardContent>
  </Card>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string | number }) {
  return <div className="flex min-w-0 items-center gap-3 border-b p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><div className="rounded-md bg-muted p-2 text-muted-foreground"><Icon className="h-4 w-4" /></div><div className="min-w-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{value}</div></div></div>;
}

function ClusterCard({ cluster }: { cluster: Cluster }) {
  return <Card>
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b">
      <div className="min-w-0"><CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />{cluster.endpoint}<StatusBadge tone={tone(cluster.status)} dot>{cluster.status === 'online' ? 'Verbunden' : 'Nicht erreichbar'}</StatusBadge></CardTitle><p className="mt-1 text-xs text-muted-foreground">Quelle: {cluster.connections?.map(connection => connection.name).join(', ') || 'Legacy-Deployment'} · Automatisiert durch: {cluster.deployments.map(deployment => deployment.name).join(', ') || '—'}</p></div>
      <div className="flex gap-2">{cluster.deployments.map(deployment => <Button key={deployment.id} asChild size="sm" variant="outline"><Link to="/deployments/$id" params={{ id: deployment.id }}>{deployment.name}</Link></Button>)}</div>
    </CardHeader>
    <CardContent className="space-y-5 p-0">
      <section><div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><Server className="h-4 w-4" />Nodes</div><div className="overflow-x-auto"><table className="w-full min-w-[780px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">Node</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">CPU</th><th className="px-4 py-2.5 font-medium">Arbeitsspeicher</th><th className="px-4 py-2.5 font-medium">Disk</th><th className="px-4 py-2.5 font-medium">Uptime</th></tr></thead><tbody className="divide-y">{cluster.nodes.map(node => <tr key={node.name} className="hover:bg-muted/20"><td className="px-4 py-3 font-mono font-medium">{node.name}</td><td className="px-4 py-3"><StatusBadge tone={tone(node.status)} dot>{node.status}</StatusBadge></td><td className="px-4 py-3 tabular-nums">{node.maxcpu ? `${percent(node.cpu, 1)} · ${node.maxcpu} Kerne` : '—'}</td><td className="px-4 py-3 tabular-nums">{node.maxmem ? `${bytes(node.mem)} / ${bytes(node.maxmem)} · ${percent(node.mem, node.maxmem)}` : '—'}</td><td className="px-4 py-3 tabular-nums">{node.maxdisk ? `${bytes(node.disk)} / ${bytes(node.maxdisk)} · ${percent(node.disk, node.maxdisk)}` : '—'}</td><td className="px-4 py-3 font-mono text-xs">{uptime(node.uptime)}</td></tr>)}{cluster.nodes.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Keine Nodes gemeldet.</td></tr>}</tbody></table></div></section>
      <section><div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><Boxes className="h-4 w-4" />Virtuelle Maschinen</div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">VM</th><th className="px-4 py-2.5 font-medium">Node</th><th className="px-4 py-2.5 font-medium">VM-ID</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">vCPU</th><th className="px-4 py-2.5 font-medium">Arbeitsspeicher</th></tr></thead><tbody className="divide-y">{cluster.vms.map(vm => <tr key={`${vm.node_name}-${vm.vm_id}`} className="hover:bg-muted/20"><td className="px-4 py-3 font-medium">{vm.name}</td><td className="px-4 py-3 font-mono text-xs">{vm.node_name}</td><td className="px-4 py-3 font-mono text-xs">{vm.vm_id}</td><td className="px-4 py-3"><StatusBadge tone={tone(vm.status)} dot>{vm.status}</StatusBadge></td><td className="px-4 py-3 tabular-nums">{vm.maxcpu || '—'}</td><td className="px-4 py-3 tabular-nums">{vm.maxmem ? `${bytes(vm.mem)} / ${bytes(vm.maxmem)}` : '—'}</td></tr>)}{cluster.vms.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Keine VMs gemeldet.</td></tr>}</tbody></table></div></section>
    </CardContent>
  </Card>;
}
