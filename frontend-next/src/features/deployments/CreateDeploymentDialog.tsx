import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ProxmoxConnection } from '@/features/infrastructure/ProxmoxConnectionDialog';

function workspaceSlug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

interface CreateResult { id: string }

export function CreateDeploymentDialog({ environmentId, open, onOpenChange }: { environmentId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const connectionsQuery = useQuery({
    queryKey: ['opentofu', 'proxmox-connections', environmentId],
    queryFn: () => apiFetch<ProxmoxConnection[]>(`/plugin/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`),
    enabled: open,
    staleTime: 15_000,
  });
  const connections = Array.isArray(connectionsQuery.data) ? connectionsQuery.data : [];

  useEffect(() => {
    if (!open) return;
    setName(''); setPath(''); setPathEdited(false); setDescription(''); setConnectionId('');
  }, [open]);
  useEffect(() => {
    if (!open || connectionId || connections.length === 0) return;
    setConnectionId(connections[0].id);
  }, [connectionId, connections, open]);
  const updateName = (value: string) => {
    setName(value);
    if (!pathEdited) setPath(value ? `/workspaces/${workspaceSlug(value) || 'neues-deployment'}` : '');
  };
  const createMutation = useMutation({
    mutationFn: () => {
      return apiFetch<CreateResult>('/plugin/opentofu/workspaces', { method: 'POST', body: { name: name.trim(), path: path.trim(), description: description.trim(), environment_id: environmentId, proxmox_connection_id: connectionId, env_vars: {}, scaffold: { provider: 'proxmox' } } });
    },
    onSuccess: result => {
      showToast('Deployment wurde mit einem Proxmox-Grundgerüst angelegt.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
      onOpenChange(false);
      void navigate({ to: '/deployments/$id', params: { id: result.id } });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FolderPlus className="h-5 w-5" />Neues Deployment</DialogTitle>
        <DialogDescription>Fleet erstellt einen isolierten OpenTofu-Workspace mit dem Proxmox-Provider. Ressourcen definierst du danach direkt über die Konsole.</DialogDescription>
      </DialogHeader>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); createMutation.mutate(); }}>
        <section className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="deployment-name">Name</Label><Input id="deployment-name" required value={name} onChange={event => updateName(event.target.value)} placeholder="hr01-app-erpnext" pattern="[A-Za-z0-9][A-Za-z0-9._ -]{0,62}" /></div><div className="space-y-1.5"><Label htmlFor="deployment-path">Workspace-Pfad</Label><Input id="deployment-path" required value={path} onChange={event => { setPathEdited(true); setPath(event.target.value); }} placeholder="/workspaces/hr01-app-erpnext" /><p className="text-xs text-muted-foreground">Muss innerhalb von <code>/workspaces</code> liegen.</p></div></section>
        <div className="space-y-1.5"><Label htmlFor="deployment-description">Beschreibung <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="deployment-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="ERP-Anwendung in Produktion" /></div>
        <section className="space-y-4 rounded-lg border bg-muted/20 p-4"><div><h3 className="text-sm font-semibold">Infrastrukturquelle</h3><p className="mt-1 text-xs text-muted-foreground">Ein Deployment automatisiert Ressourcen auf einer bestehenden Plattform. Zugangsdaten werden hier nicht gespeichert.</p></div><div className="space-y-1.5"><Label htmlFor="deployment-connection">Proxmox-Plattform</Label><select id="deployment-connection" required value={connectionId} onChange={event => setConnectionId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={connectionsQuery.isLoading || connections.length === 0}><option value="">{connectionsQuery.isLoading ? 'Wird geladen…' : 'Plattform auswählen…'}</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.endpoint}</option>)}</select>{connections.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Lege zuerst unter Infrastruktur eine Proxmox-Plattform an.</p>}</div>{connectionId && <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">Token, TLS-Einstellung und Standard-SSH-Key werden zentral von der gewählten Plattform verwendet.</div>}</section>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={createMutation.isPending || !connectionId}>{createMutation.isPending ? <RefreshCw className="animate-spin" /> : <FolderPlus />}Deployment anlegen</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
