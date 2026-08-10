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
  const [endpoint, setEndpoint] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [sshKey, setSshKey] = useState('');
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
    setName(''); setPath(''); setPathEdited(false); setDescription(''); setEndpoint(''); setApiToken(''); setInsecure(false); setSshKey(''); setConnectionId('');
  }, [open]);
  const updateName = (value: string) => {
    setName(value);
    if (!pathEdited) setPath(value ? `/workspaces/${workspaceSlug(value) || 'neues-deployment'}` : '');
  };
  const createMutation = useMutation({
    mutationFn: () => {
      const env_vars: Record<string, string> = { TF_VAR_proxmox_insecure: insecure ? 'true' : 'false' };
      if (endpoint.trim()) env_vars.TF_VAR_proxmox_endpoint = endpoint.trim();
      if (apiToken.trim()) env_vars.TF_VAR_proxmox_api_token = apiToken.trim();
      if (sshKey.trim()) env_vars.TF_VAR_ssh_public_key = sshKey.trim();
      return apiFetch<CreateResult>('/plugin/opentofu/workspaces', { method: 'POST', body: { name: name.trim(), path: path.trim(), description: description.trim(), environment_id: environmentId, proxmox_connection_id: connectionId || undefined, env_vars, scaffold: { provider: 'proxmox' } } });
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
        <section className="space-y-4 rounded-lg border bg-muted/20 p-4"><div><h3 className="text-sm font-semibold">Infrastrukturquelle</h3><p className="mt-1 text-xs text-muted-foreground">Wähle die Proxmox-Plattform der Umgebung. Das Deployment ist Automatisierung und besitzt keine eigene Infrastruktur.</p></div><div className="space-y-1.5"><Label htmlFor="deployment-connection">Proxmox-Verbindung</Label><select id="deployment-connection" value={connectionId} onChange={event => setConnectionId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Eigene Verbindung (Legacy)</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.endpoint}</option>)}</select>{connections.length === 0 && <p className="text-xs text-muted-foreground">Noch keine Plattform-Verbindung vorhanden. Du kannst vorübergehend eine lokale Verbindung hinterlegen.</p>}</div>{!connectionId && <><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5 sm:col-span-2"><Label htmlFor="deployment-endpoint">API-Endpunkt</Label><Input id="deployment-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://pve.example.com:8006/" inputMode="url" /></div><div className="space-y-1.5 sm:col-span-2"><Label htmlFor="deployment-token">API-Token</Label><Input id="deployment-token" value={apiToken} onChange={event => setApiToken(event.target.value)} type="password" autoComplete="new-password" placeholder="root@pam!fleet=…" /></div><div className="space-y-1.5 sm:col-span-2"><Label htmlFor="deployment-ssh-key">Standard SSH Public Key <span className="font-normal text-muted-foreground">(optional)</span></Label><textarea id="deployment-ssh-key" value={sshKey} onChange={event => setSshKey(event.target.value)} rows={3} className="flex w-full rounded-md border bg-background px-3 py-2 font-mono text-xs shadow-sm outline-none" placeholder="ssh-ed25519 AAAA…" /></div></div><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={insecure} onChange={event => setInsecure(event.target.checked)} className="mt-0.5" /><span><span className="font-medium">TLS-Zertifikat nicht prüfen</span><span className="mt-0.5 block text-xs text-muted-foreground">Nur für selbstsignierte Proxmox-Zertifikate.</span></span></label></>}{connectionId && <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">Die Zugangsdaten und der Standard-SSH-Key werden sicher aus der gewählten Plattform-Verbindung verwendet.</div>}</section>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? <RefreshCw className="animate-spin" /> : <FolderPlus />}Deployment anlegen</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
