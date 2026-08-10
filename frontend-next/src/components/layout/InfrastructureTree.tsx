import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, CircleDot, Database, Folder, FolderTree, HardDrive, Server, ServerCog } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch } from '@/lib/api';
import { asArray, cn } from '@/lib/utils';
import { useUi } from '@/lib/store';
import { buildGroupTree, normalizeServer, type GroupNode, type ServerGroup, type ServerRow } from '@/features/servers/server-list-utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/lib/toast';

const STORAGE_KEY = 'fleet.console.infrastructure-tree.collapsed';

function initialCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set<string>(); }
}

function saveCollapsed(next: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* storage unavailable */ }
}

function StatusDot({ status }: { status?: string }) {
  return <span aria-label={status === 'online' ? 'Online' : 'Offline'} className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status === 'online' ? 'bg-emerald-500' : status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground/50')} />;
}

interface TreeProps { compact?: boolean; onNavigate?: () => void; }
interface ProxmoxNode { name?: string; status?: string }
interface ProxmoxVm { name?: string; node_name?: string; vm_id?: number | string; status?: string; fleet_server_id?: string | null }
interface ProxmoxCluster { id?: string; endpoint?: string; connections?: Array<{ name?: string }>; nodes?: ProxmoxNode[]; vms?: ProxmoxVm[] }
interface InfrastructureResponse { clusters?: ProxmoxCluster[] }

export function InfrastructureTree({ compact = false, onNavigate }: TreeProps) {
  const navigate = useNavigate();
  const path = useRouterState({ select: state => state.location.pathname });
  const environmentId = useUi(state => state.environmentId);
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(initialCollapsed);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderParentId, setFolderParentId] = useState('');
  const { data: rawServers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers() as Promise<Record<string, unknown>[]>,
    staleTime: 30_000,
  });
  const { data: rawGroups } = useQuery({
    queryKey: ['server-groups'],
    queryFn: () => api.getServerGroups() as Promise<Record<string, unknown>[]>,
    staleTime: 30_000,
  });
  const { data: inventory } = useQuery({
    queryKey: ['opentofu', 'infrastructure', environmentId],
    queryFn: () => apiFetch<InfrastructureResponse>(`/plugin/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`),
    staleTime: 30_000,
    retry: false,
  });

  const servers = useMemo(() => asArray<Record<string, unknown>>(rawServers)
    .map(normalizeServer)
    .filter(server => String(server.environment_id || 'default') === environmentId), [rawServers, environmentId]);
  const groups = useMemo(() => asArray<Record<string, unknown>>(rawGroups).map(group => ({
    id: String(group.id), name: String(group.name || ''), color: typeof group.color === 'string' ? group.color : undefined,
    parent_id: group.parent_id == null ? null : String(group.parent_id),
  } satisfies ServerGroup)), [rawGroups]);
  const groupsById = useMemo(() => new Set(groups.map(group => group.id)), [groups]);
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const byGroup = useMemo(() => servers.reduce<Record<string, ServerRow[]>>((result, server) => {
    const key = server.group_id && groupsById.has(server.group_id) ? server.group_id : '__ungrouped__';
    (result[key] ||= []).push(server);
    return result;
  }, {}), [servers, groupsById]);
  const groupTree = useMemo(() => buildGroupTree(groups), [groups]);
  const ungrouped = byGroup.__ungrouped__ || [];
  const clusters = useMemo(() => Array.isArray(inventory?.clusters) ? inventory.clusters : [], [inventory]);
  const createFolder = useMutation({
    mutationFn: () => api.createServerGroup(folderName.trim(), '#64748b', folderParentId || null),
    onSuccess: () => { showToast('Ordner erstellt.', 'success'); setFolderOpen(false); setFolderName(''); setFolderParentId(''); void queryClient.invalidateQueries({ queryKey: ['server-groups'] }); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  useEffect(() => {
    // Expand a selected resource automatically. It makes direct links and
    // Cmd+K navigation feel like part of the tree rather than a separate UI.
    const selected = servers.find(server => path === `/servers/${server.id}`);
    if (!selected?.group_id) return;
    setCollapsed(previous => {
      const openIds: string[] = [];
      let current = groupById.get(selected.group_id!);
      while (current) {
        openIds.push(current.id);
        current = current.parent_id ? groupById.get(current.parent_id) : undefined;
      }
      if (!openIds.some(groupId => previous.has(groupId))) return previous;
      const next = new Set(previous);
      openIds.forEach(groupId => next.delete(groupId));
      saveCollapsed(next);
      return next;
    });
  }, [groupById, path, servers]);

  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveCollapsed(next); return next;
  });
  const selectServer = (server: ServerRow) => {
    onNavigate?.();
    void navigate({ to: '/servers/$id', params: { id: server.id } });
  };
  const serverRow = (server: ServerRow, depth = 0) => {
    const active = path === `/servers/${server.id}`;
    return <button key={server.id} type="button" onClick={() => selectServer(server)} title={server.ip_address || server.name}
      className={cn('group flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-xs transition-colors', active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}
      style={{ paddingLeft: `${12 + depth * 14}px` }}>
      <StatusDot status={server.status} /><Server className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{server.name}</span>
      {!compact && <span className="max-w-[82px] truncate font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{server.ip_address}</span>}
    </button>;
  };
  const groupNode = (node: GroupNode, depth = 0): ReactNode => {
    const open = !collapsed.has(node.id);
    const members = byGroup[node.id] || [];
    const hasChildren = members.length > 0 || node.children.length > 0;
    return <div key={node.id}>
      <button type="button" onClick={() => hasChildren && toggle(node.id)} className={cn('group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1.5 pr-2 text-left text-xs text-foreground transition-colors hover:bg-accent/60', !hasChildren && 'cursor-default')}
        style={{ paddingLeft: `${8 + depth * 14}px` }}>
        {hasChildren ? (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />) : <span className="w-3.5" />}
        <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: node.color || undefined }} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-[10px] text-muted-foreground">{members.length}</span>
      </button>
      {open && <div>{members.map(server => serverRow(server, depth + 1))}{node.children.map(child => groupNode(child, depth + 1))}</div>}
    </div>;
  };
  const clusterNode = (cluster: ProxmoxCluster) => {
    const clusterId = `proxmox:${cluster.id || cluster.endpoint || 'cluster'}`;
    const open = !collapsed.has(clusterId);
    const nodes = Array.isArray(cluster.nodes) ? cluster.nodes : [];
    const vms = Array.isArray(cluster.vms) ? cluster.vms : [];
    const clusterName = cluster.connections?.map(connection => connection.name).filter(Boolean).join(', ') || cluster.endpoint || 'Proxmox-Cluster';
    return <div key={clusterId}>
      <button type="button" onClick={() => toggle(clusterId)} className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent/60">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <Database className="h-3.5 w-3.5 shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate">{clusterName}</span><span className="text-[10px] text-muted-foreground">{vms.length}</span>
      </button>
      {open && <div>{nodes.map(node => {
        const nodeId = `${clusterId}:node:${node.name || 'node'}`;
        const nodeOpen = !collapsed.has(nodeId);
        const members = vms.filter(vm => vm.node_name === node.name);
        return <div key={nodeId}>
          <button type="button" onClick={() => toggle(nodeId)} className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1.5 pr-2 text-left text-xs text-muted-foreground hover:bg-accent/60" style={{ paddingLeft: '26px' }}>
            {nodeOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}<StatusDot status={node.status} /><ServerCog className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{node.name || 'Node'}</span><span className="text-[10px]">{members.length}</span>
          </button>
          {nodeOpen && members.map(vm => vm.fleet_server_id ? <Link key={`${nodeId}:vm:${vm.vm_id || vm.name}`} to="/servers/$id" params={{ id: vm.fleet_server_id }} onClick={onNavigate} title={`Fleet-Host · VM ${vm.vm_id || '—'} · ${vm.status || 'unknown'}`} className="group flex min-w-0 items-center gap-2 rounded-sm py-1.5 pr-2 text-xs text-foreground transition-colors hover:bg-accent/60" style={{ paddingLeft: '50px' }}><StatusDot status={vm.status} /><HardDrive className="h-3.5 w-3.5 shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate">{vm.name || `VM ${vm.vm_id || ''}`}</span><span className="rounded-sm bg-brand/10 px-1 font-mono text-[9px] text-brand">Fleet</span></Link> : <Link key={`${nodeId}:vm:${vm.vm_id || vm.name}`} to="/infrastructure" onClick={onNavigate} title={`VM ${vm.vm_id || '—'} · ${vm.status || 'unknown'}`} className="group flex min-w-0 items-center gap-2 rounded-sm py-1.5 pr-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground" style={{ paddingLeft: '50px' }}><StatusDot status={vm.status} /><HardDrive className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{vm.name || `VM ${vm.vm_id || ''}`}</span><span className="font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100">{vm.vm_id || '—'}</span></Link>)}
        </div>;
      })}</div>}
    </div>;
  };

  return <div className="space-y-1">
    <Link to="/" onClick={onNavigate} className={cn('flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors', path === '/' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
      <CircleDot className="h-3.5 w-3.5 text-brand" /><span className="truncate">Umgebungsübersicht</span>
    </Link>
    <div className="pt-1">
      <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"><FolderTree className="h-3.5 w-3.5" /> Ressourcen{!compact && <button type="button" onClick={() => setFolderOpen(true)} className="ml-auto rounded-sm px-1 text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Ordner erstellen">+</button>}</div>
      <Link to="/infrastructure" onClick={onNavigate} className={cn('flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors', path === '/infrastructure' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}><Database className="h-3.5 w-3.5 text-brand" /><span className="truncate">Proxmox-Cluster</span></Link>
      {clusters.map(cluster => clusterNode(cluster))}
      {groupTree.map(group => groupNode(group))}
      {ungrouped.length > 0 && <div>
        <button type="button" onClick={() => toggle('__ungrouped__')} className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-foreground hover:bg-accent/60">
          {collapsed.has('__ungrouped__') ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}<Server className="h-3.5 w-3.5" /><span className="flex-1 text-left">VMs & Server</span><span className="text-[10px] text-muted-foreground">{ungrouped.length}</span>
        </button>
        {!collapsed.has('__ungrouped__') && ungrouped.map(server => serverRow(server, 1))}
      </div>}
      {!servers.length && <p className="px-2 py-2 text-xs text-muted-foreground">Noch keine Ressourcen in dieser Umgebung.</p>}
    </div>
    <Dialog open={folderOpen} onOpenChange={setFolderOpen}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Ordner erstellen</DialogTitle><DialogDescription>Strukturiere VMs und Fleet-Hosts wie in einer vCenter-Baumansicht.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); createFolder.mutate(); }}><div className="space-y-1.5"><Label htmlFor="tree-folder-name">Name</Label><Input id="tree-folder-name" required autoFocus value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="Produktion" /></div><div className="space-y-1.5"><Label htmlFor="tree-folder-parent">Übergeordneter Ordner</Label><select id="tree-folder-parent" value={folderParentId} onChange={event => setFolderParentId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Stammordner</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div><DialogFooter><Button type="button" variant="outline" onClick={() => setFolderOpen(false)}>Abbrechen</Button><Button type="submit" disabled={createFolder.isPending}>Ordner erstellen</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
