import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUi } from '@/lib/store';
import type { ProxmoxConnection } from '@/features/infrastructure/ProxmoxConnectionDialog';

interface ConnectionConfig {
  source?: ProxmoxConnection | null;
  source_id?: string | null;
  endpoint?: string;
  insecure?: boolean;
  api_token_configured?: boolean;
  ssh_public_key_configured?: boolean;
}

export function DeploymentConnectionDialog({ workspaceId, open, onOpenChange }: { workspaceId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const environmentId = useUi(state => state.environmentId);
  const [endpoint, setEndpoint] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sourceId, setSourceId] = useState('');
  const configQuery = useQuery({
    queryKey: ['opentofu', 'workspace', workspaceId, 'proxmox-connection'],
    queryFn: () => apiFetch<ConnectionConfig>(`/plugin/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-connection`),
    enabled: open,
    staleTime: 15_000,
  });
  const sourcesQuery = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<ProxmoxConnection[]>(`/plugin/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`), enabled: open, staleTime: 15_000 });
  const sources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : [];

  useEffect(() => {
    if (!open || !configQuery.data) return;
    setEndpoint(configQuery.data.endpoint || '');
    setInsecure(Boolean(configQuery.data.insecure));
    setApiToken('');
    setSshKey('');
    setSourceId(configQuery.data.source_id || '');
  }, [configQuery.data, open]);

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/plugin/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-connection`, {
      method: 'PUT', body: sourceId ? { proxmox_connection_id: sourceId } : { detach_source: Boolean(configQuery.data?.source_id), endpoint, insecure, api_token: apiToken, ssh_public_key: sshKey },
    }),
    onSuccess: () => {
      showToast('Proxmox-Verbindung gespeichert.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', workspaceId] });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const config = configQuery.data;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Proxmox-Verbindung</DialogTitle>
        <DialogDescription>Ordne das Deployment einer Infrastrukturquelle zu. Nur für ältere Deployments ist eine lokale Verbindung weiterhin möglich.</DialogDescription>
      </DialogHeader>
      {configQuery.isLoading ? <div className="space-y-3 py-4"><div className="h-10 animate-pulse rounded-md bg-muted" /><div className="h-10 animate-pulse rounded-md bg-muted" /></div> : <form className="space-y-5" onSubmit={event => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2"><Status label="API-Token" configured={config?.api_token_configured} /><Status label="Standard-SSH-Key" configured={config?.ssh_public_key_configured} /></div>
        <div className="space-y-1.5"><Label htmlFor="deployment-source">Infrastrukturquelle</Label><select id="deployment-source" value={sourceId} onChange={event => setSourceId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Eigene Verbindung (Legacy)</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.endpoint}</option>)}</select><p className="text-xs text-muted-foreground">Eine Plattform-Verbindung wird von mehreren Deployments wiederverwendet.</p></div>
        {!sourceId && <><div className="space-y-1.5"><Label htmlFor="proxmox-endpoint">Proxmox API-Endpunkt</Label><Input id="proxmox-endpoint" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://pve.example.com:8006/" inputMode="url" /><p className="text-xs text-muted-foreground">Wird für Templates, freie VM-IDs, Datastores, Bridges und den Gast-Agent verwendet.</p></div>
        <div className="space-y-1.5"><Label htmlFor="proxmox-token">Proxmox API-Token</Label><Input id="proxmox-token" value={apiToken} onChange={event => setApiToken(event.target.value)} type="password" autoComplete="new-password" placeholder={config?.api_token_configured ? 'Gespeichert – nur zum Ändern eingeben' : 'root@pam!fleet=…'} /><p className="text-xs text-muted-foreground">Ein leeres Feld behält den bestehenden Token bei.</p></div>
        <div className="space-y-1.5"><Label htmlFor="default-ssh-key">Standard SSH Public Key <span className="font-normal text-muted-foreground">(optional)</span></Label><textarea id="default-ssh-key" value={sshKey} onChange={event => setSshKey(event.target.value)} rows={3} className="flex w-full rounded-md border bg-background px-3 py-2 font-mono text-xs shadow-sm outline-none" placeholder={config?.ssh_public_key_configured ? 'Gespeichert – nur zum Ändern eingeben' : 'ssh-ed25519 AAAA…'} /><p className="text-xs text-muted-foreground">Wird bei neuen VMs per Cloud-Init für die ausgewählte Key-Variable verwendet.</p></div>
        <label className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm"><input type="checkbox" checked={insecure} onChange={event => setInsecure(event.target.checked)} className="mt-0.5" /><span><span className="font-medium">TLS-Zertifikat nicht prüfen</span><span className="mt-0.5 block text-xs text-muted-foreground">Nur für Proxmox mit selbstsigniertem Zertifikat verwenden.</span></span></label></>}
        {sourceId && <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">Diese Konfiguration kommt aus der ausgewählten Plattform-Verbindung. Änderungen erfolgen zentral unter Infrastruktur.</div>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? <RefreshCw className="animate-spin" /> : <KeyRound />}Verbindung speichern</Button></DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>;
}

function Status({ label, configured }: { label: string; configured?: boolean }) {
  return <div className="rounded-md border bg-muted/20 px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className={configured ? 'mt-1 text-sm font-medium text-emerald-600 dark:text-emerald-400' : 'mt-1 text-sm font-medium text-muted-foreground'}>{configured ? 'Konfiguriert' : 'Nicht gesetzt'}</div></div>;
}
