import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Cpu, Database, HardDrive, MemoryStick, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { useUi } from '@/lib/store';

interface NodeInfo { name: string; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number; disk: number; maxdisk: number; uptime: number }
interface VmInfo { name: string; node_name: string; vm_id: number; status: string; cpu: number; maxcpu: number; mem: number; maxmem: number }
interface Cluster { id: string; endpoint: string; status: string; deployments: Array<{ id: string; name: string }>; nodes: NodeInfo[]; vms: VmInfo[] }
interface InfrastructureResponse { clusters?: Cluster[]; warnings?: string[] }

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
  const inventoryQuery = useQuery({
    queryKey: ['opentofu', 'infrastructure', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/plugin/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 15_000,
  });
  const clusters = Array.isArray(inventoryQuery.data?.clusters) ? inventoryQuery.data!.clusters! : [];
  const totals = useMemo(() => clusters.reduce((result, cluster) => ({
    clusters: result.clusters + 1,
    nodes: result.nodes + cluster.nodes.length,
    vms: result.vms + cluster.vms.length,
    online: result.online + cluster.vms.filter(vm => vm.status === 'running').length,
  }), { clusters: 0, nodes: 0, vms: 0, online: 0 }), [clusters]);

  return <div className="space-y-6">
    <PageHeader title="Infrastruktur" description="Zentrale Proxmox-Übersicht über Cluster, Nodes und virtuelle Maschinen der gewählten Umgebung." actions={<Button type="button" variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', environmentId] })} disabled={inventoryQuery.isFetching}><RefreshCw className={inventoryQuery.isFetching ? 'animate-spin' : undefined} />Aktualisieren</Button>} />

    {inventoryQuery.isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map(item => <Skeleton key={item} className="h-24" />)}</div> : <>
      {inventoryQuery.data?.warnings?.length ? <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"><div className="flex items-center gap-2 font-medium"><TriangleAlert className="h-4 w-4" />Nicht alle Proxmox-Verbindungen sind erreichbar</div><ul className="mt-1 list-disc pl-6 text-xs">{inventoryQuery.data.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div> : null}
      {inventoryQuery.isError ? <Card><EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Infrastruktur konnte nicht geladen werden" description="Prüfe die Proxmox-Verbindung eines Deployments und versuche es erneut." /></Card> : clusters.length === 0 ? <Card><EmptyState icon={<Database className="h-5 w-5" />} title="Keine Proxmox-Infrastruktur verbunden" description="Hinterlege in einem Deployment eine Proxmox-Verbindung. Fleet gruppiert identische API-Endpunkte danach automatisch als Cluster." action={<Button asChild><Link to="/deployments">Zu Deployments</Link></Button>} /></Card> : <>
        <div className="grid overflow-hidden rounded-lg border bg-card sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={Database} label="Cluster" value={totals.clusters} />
          <Metric icon={Server} label="Nodes" value={totals.nodes} />
          <Metric icon={Boxes} label="VMs" value={totals.vms} />
          <Metric icon={Cpu} label="VMs gestartet" value={`${totals.online}/${totals.vms}`} />
        </div>
        {clusters.map(cluster => <ClusterCard key={cluster.id} cluster={cluster} />)}
      </>}
    </>}
  </div>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string | number }) {
  return <div className="flex min-w-0 items-center gap-3 border-b p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><div className="rounded-md bg-muted p-2 text-muted-foreground"><Icon className="h-4 w-4" /></div><div className="min-w-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{value}</div></div></div>;
}

function ClusterCard({ cluster }: { cluster: Cluster }) {
  return <Card>
    <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 border-b">
      <div className="min-w-0"><CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />{cluster.endpoint}<StatusBadge tone={tone(cluster.status)} dot>{cluster.status === 'online' ? 'Verbunden' : 'Nicht erreichbar'}</StatusBadge></CardTitle><p className="mt-1 text-xs text-muted-foreground">Verwendet von: {cluster.deployments.map(deployment => deployment.name).join(', ') || '—'}</p></div>
      <div className="flex gap-2">{cluster.deployments.map(deployment => <Button key={deployment.id} asChild size="sm" variant="outline"><Link to="/deployments/$id" params={{ id: deployment.id }}>{deployment.name}</Link></Button>)}</div>
    </CardHeader>
    <CardContent className="space-y-5 p-0">
      <section><div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><Server className="h-4 w-4" />Nodes</div><div className="overflow-x-auto"><table className="w-full min-w-[780px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">Node</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">CPU</th><th className="px-4 py-2.5 font-medium">Arbeitsspeicher</th><th className="px-4 py-2.5 font-medium">Disk</th><th className="px-4 py-2.5 font-medium">Uptime</th></tr></thead><tbody className="divide-y">{cluster.nodes.map(node => <tr key={node.name} className="hover:bg-muted/20"><td className="px-4 py-3 font-mono font-medium">{node.name}</td><td className="px-4 py-3"><StatusBadge tone={tone(node.status)} dot>{node.status}</StatusBadge></td><td className="px-4 py-3 tabular-nums">{node.maxcpu ? `${percent(node.cpu, 1)} · ${node.maxcpu} Kerne` : '—'}</td><td className="px-4 py-3 tabular-nums">{node.maxmem ? `${bytes(node.mem)} / ${bytes(node.maxmem)} · ${percent(node.mem, node.maxmem)}` : '—'}</td><td className="px-4 py-3 tabular-nums">{node.maxdisk ? `${bytes(node.disk)} / ${bytes(node.maxdisk)} · ${percent(node.disk, node.maxdisk)}` : '—'}</td><td className="px-4 py-3 font-mono text-xs">{uptime(node.uptime)}</td></tr>)}{cluster.nodes.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Keine Nodes gemeldet.</td></tr>}</tbody></table></div></section>
      <section><div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold"><Boxes className="h-4 w-4" />Virtuelle Maschinen</div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2.5 font-medium">VM</th><th className="px-4 py-2.5 font-medium">Node</th><th className="px-4 py-2.5 font-medium">VM-ID</th><th className="px-4 py-2.5 font-medium">Status</th><th className="px-4 py-2.5 font-medium">vCPU</th><th className="px-4 py-2.5 font-medium">Arbeitsspeicher</th></tr></thead><tbody className="divide-y">{cluster.vms.map(vm => <tr key={`${vm.node_name}-${vm.vm_id}`} className="hover:bg-muted/20"><td className="px-4 py-3 font-medium">{vm.name}</td><td className="px-4 py-3 font-mono text-xs">{vm.node_name}</td><td className="px-4 py-3 font-mono text-xs">{vm.vm_id}</td><td className="px-4 py-3"><StatusBadge tone={tone(vm.status)} dot>{vm.status}</StatusBadge></td><td className="px-4 py-3 tabular-nums">{vm.maxcpu || '—'}</td><td className="px-4 py-3 tabular-nums">{vm.maxmem ? `${bytes(vm.mem)} / ${bytes(vm.maxmem)}` : '—'}</td></tr>)}{cluster.vms.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Keine VMs gemeldet.</td></tr>}</tbody></table></div></section>
    </CardContent>
  </Card>;
}
