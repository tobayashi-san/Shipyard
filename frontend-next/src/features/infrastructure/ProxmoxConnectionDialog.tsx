import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Network, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ProxmoxConnection {
  id: string;
  environment_id: string;
  name: string;
  endpoint: string;
  insecure: boolean;
  api_token_configured: boolean;
  ssh_public_key_configured: boolean;
}

export function ProxmoxConnectionDialog({ environmentId, connection, open, onOpenChange }: { environmentId: string; connection?: ProxmoxConnection | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [insecure, setInsecure] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(connection?.name || ''); setEndpoint(connection?.endpoint || ''); setApiToken(''); setSshKey(''); setInsecure(Boolean(connection?.insecure));
  }, [connection, open]);
  const save = useMutation({
    mutationFn: () => apiFetch<ProxmoxConnection>(connection ? `/plugin/opentofu/proxmox-connections/${encodeURIComponent(connection.id)}` : '/plugin/opentofu/proxmox-connections', {
      method: connection ? 'PUT' : 'POST', body: { environment_id: environmentId, name, endpoint, api_token: apiToken, ssh_public_key: sshKey, insecure },
    }),
    onSuccess: () => {
      showToast(connection ? 'Plattform-Verbindung gespeichert.' : 'Proxmox-Plattform verbunden.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', environmentId] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', environmentId] });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const isEdit = Boolean(connection);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Network className="h-5 w-5" />{isEdit ? 'Plattform-Verbindung bearbeiten' : 'Proxmox-Plattform verbinden'}</DialogTitle><DialogDescription>Die Verbindung gehört zur Umgebung, nicht zu einem einzelnen Deployment. Deployments können sie anschließend wiederverwenden.</DialogDescription></DialogHeader>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <div className="space-y-1.5"><Label htmlFor="platform-name">Anzeigename</Label><Input id="platform-name" required value={name} onChange={event => setName(event.target.value)} placeholder="Produktivcluster" /></div>
        <div className="space-y-1.5"><Label htmlFor="platform-endpoint">Proxmox API-Endpunkt</Label><Input id="platform-endpoint" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://pve.example.com:8006/" inputMode="url" /></div>
        <div className="space-y-1.5"><Label htmlFor="platform-token">Proxmox API-Token</Label><Input id="platform-token" required={!isEdit} value={apiToken} onChange={event => setApiToken(event.target.value)} type="password" autoComplete="new-password" placeholder={connection?.api_token_configured ? 'Gespeichert – nur zum Ändern eingeben' : 'root@pam!fleet=…'} /><p className="text-xs text-muted-foreground">Der Token wird verschlüsselt gespeichert und nie wieder an den Browser gesendet.</p></div>
        <div className="space-y-1.5"><Label htmlFor="platform-ssh-key">Standard SSH Public Key <span className="font-normal text-muted-foreground">(optional)</span></Label><textarea id="platform-ssh-key" value={sshKey} onChange={event => setSshKey(event.target.value)} rows={3} className="flex w-full rounded-md border bg-background px-3 py-2 font-mono text-xs shadow-sm outline-none" placeholder={connection?.ssh_public_key_configured ? 'Gespeichert – nur zum Ändern eingeben' : 'ssh-ed25519 AAAA…'} /><p className="text-xs text-muted-foreground">Wird als Vorgabe an neue VM-Definitionen dieser Plattform weitergereicht.</p></div>
        <label className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm"><input type="checkbox" checked={insecure} onChange={event => setInsecure(event.target.checked)} className="mt-0.5" /><span><span className="font-medium">TLS-Zertifikat nicht prüfen</span><span className="mt-0.5 block text-xs text-muted-foreground">Nur für selbstsignierte Zertifikate.</span></span></label>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? <RefreshCw className="animate-spin" /> : <KeyRound />}{isEdit ? 'Speichern' : 'Verbindung herstellen'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
