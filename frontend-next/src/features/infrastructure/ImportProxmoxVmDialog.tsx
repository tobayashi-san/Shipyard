import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw, ServerCog } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Folder { id: string; name: string; environment_id?: string }
interface GuestIp { ip_address?: string | null }

export function ImportProxmoxVmDialog({ connectionId, environmentId, vm, open, onOpenChange }: { connectionId: string; environmentId: string; vm: { name: string; node_name: string; vm_id: number }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(vm.name);
  const [ipAddress, setIpAddress] = useState('');
  const [sshUser, setSshUser] = useState('root');
  const [sshPort, setSshPort] = useState('22');
  const [groupId, setGroupId] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const groupsQuery = useQuery({ queryKey: ['server-groups'], queryFn: () => apiFetch<Folder[]>('/servers/groups'), enabled: open, staleTime: 30_000 });
  const groups = (Array.isArray(groupsQuery.data) ? groupsQuery.data : []).filter(group => String(group.environment_id || environmentId) === environmentId);
  const guestIpQuery = useQuery({ queryKey: ['opentofu', 'proxmox-guest-ip', connectionId, vm.node_name, vm.vm_id], queryFn: () => apiFetch<GuestIp>(`/plugin/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/guest-ip?node=${encodeURIComponent(vm.node_name)}&vm_id=${vm.vm_id}`), enabled: open && Boolean(connectionId), retry: false });
  useEffect(() => { if (open) { setName(vm.name); setIpAddress(''); setSshUser('root'); setSshPort('22'); setGroupId(''); setTemporaryPassword(''); } }, [open, vm.name]);
  useEffect(() => { if (guestIpQuery.data?.ip_address && !ipAddress) setIpAddress(guestIpQuery.data.ip_address); }, [guestIpQuery.data?.ip_address, ipAddress]);
  const importMutation = useMutation({
    mutationFn: async () => {
      const result = await apiFetch<{ server: { id: string; ip_address: string } }>(`/plugin/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/import-vm`, { method: 'POST', body: { name, node_name: vm.node_name, vm_id: vm.vm_id, ip_address: ipAddress, ssh_user: sshUser, ssh_port: Number(sshPort), group_id: groupId || undefined } });
      if (!temporaryPassword) return { ...result, keyDeployError: '' };
      try {
        await apiFetch('/system/deploy', { method: 'POST', body: { server_id: result.server.id, ip_address: result.server.ip_address, ssh_user: sshUser, ssh_port: Number(sshPort), password: temporaryPassword } });
        return { ...result, keyDeployError: '' };
      } catch (error) {
        // Importing inventory is a successful, independent operation. Keep
        // the adopted host visible even when password based key deployment is
        // unavailable, and tell the user exactly what remains to be done.
        return { ...result, keyDeployError: error instanceof Error ? error.message : 'SSH-Schlüssel konnte nicht installiert werden.' };
      }
    },
    onSuccess: result => { showToast(result.keyDeployError ? `VM wurde übernommen. SSH-Key: ${result.keyDeployError}` : temporaryPassword ? 'VM wurde übernommen und der Fleet-SSH-Key installiert.' : 'VM wurde als Fleet-Host übernommen.', result.keyDeployError ? 'warning' : 'success'); void queryClient.invalidateQueries({ queryKey: ['servers'] }); void queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', environmentId] }); onOpenChange(false); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto"><DialogHeader><DialogTitle className="flex items-center gap-2"><ServerCog className="h-5 w-5" />VM in Fleet übernehmen</DialogTitle><DialogDescription>Die bestehende Proxmox-VM wird nur als Fleet-Host verknüpft. Es werden keine VM-Einstellungen geändert oder Ressourcen erstellt.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); importMutation.mutate(); }}><div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-3"><div><span className="text-xs text-muted-foreground">VM</span><div className="font-medium">{vm.name}</div></div><div><span className="text-xs text-muted-foreground">Node</span><div className="font-mono">{vm.node_name}</div></div><div><span className="text-xs text-muted-foreground">VM-ID</span><div className="font-mono">{vm.vm_id}</div></div></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Fleet-Name"><Input required value={name} onChange={event => setName(event.target.value)} /></Field><Field label="IP-Adresse"><div className="flex gap-2"><Input required value={ipAddress} onChange={event => setIpAddress(event.target.value)} placeholder="10.20.1.10" /><Button type="button" size="icon" variant="outline" onClick={() => void guestIpQuery.refetch()} disabled={guestIpQuery.isFetching} aria-label="IP aus Gast-Agent lesen"><RefreshCw className={guestIpQuery.isFetching ? 'animate-spin' : undefined} /></Button></div><p className="mt-1 text-xs text-muted-foreground">Aus dem QEMU Guest Agent gelesen oder manuell eingeben.</p></Field><Field label="SSH-Benutzer"><Input required value={sshUser} onChange={event => setSshUser(event.target.value)} placeholder="ubuntu" /></Field><Field label="SSH-Port"><Input required value={sshPort} onChange={event => setSshPort(event.target.value)} inputMode="numeric" /></Field></div><Field label="Ordner"><select value={groupId} onChange={event => setGroupId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Kein Ordner</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field><div className="rounded-md border border-primary/20 bg-primary/5 p-3"><div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4" />Fleet-SSH-Key</div><p className="mt-1 text-xs text-muted-foreground">Mit einem temporären Passwort installiert Fleet seinen hinterlegten SSH-Key. Das Passwort wird nur für diese Aktion verwendet und nicht gespeichert.</p><Label className="mt-3 block" htmlFor="import-vm-password">Temporäres Passwort <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="import-vm-password" className="mt-1.5" value={temporaryPassword} onChange={event => setTemporaryPassword(event.target.value)} type="password" autoComplete="new-password" /></div><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={importMutation.isPending}>{importMutation.isPending ? <RefreshCw className="animate-spin" /> : <ServerCog />}In Fleet übernehmen</Button></DialogFooter></form></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
