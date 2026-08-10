import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Box, Layers3, Network, Pencil, Plus, RefreshCw, ServerCog, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useUi } from '@/lib/store';

interface Prefix { id: string; environment_id: string; name: string; cidr: string; gateway?: string; dns_servers?: string[]; vlan_id?: number | null; bridge?: string; description?: string; status: string; role?: string; parent_id?: string | null; parent_cidr?: string | null; child_prefix_count: number; usable_address_count: number; used_address_count: number; free_address_count: number; reservation_count: number; range_count: number; next_free_address?: string | null }
interface Reservation { id: string; address: string; hostname?: string; server_id?: string; server_name?: string; mac_address?: string; status: string; role?: string; description?: string; source_type?: string; last_synced_at?: string | null }
interface Allocation extends Partial<Reservation> { id: string; kind: 'address' | 'range'; start_address: string; end_address: string; address_count: number; status: string; role?: string; description?: string }
interface Server { id: string; name: string; ip_address?: string }
interface ProxmoxConnection { id: string; name: string }

const statusLabel: Record<string, string> = { active: 'Aktiv', reserved: 'Reserviert', dhcp: 'DHCP', deprecated: 'Veraltet', container: 'Container' };

export function NetworkDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const environmentId = useUi(state => state.environmentId);
  const [address, setAddress] = useState('');
  const [hostname, setHostname] = useState('');
  const [description, setDescription] = useState('');
  const [serverId, setServerId] = useState('');
  const [addressStatus, setAddressStatus] = useState('active');
  const [addressRole, setAddressRole] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [rangeDescription, setRangeDescription] = useState('');
  const [editing, setEditing] = useState<Reservation | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [connectionId, setConnectionId] = useState('');

  const detail = useQuery({ queryKey: ['ipam', 'network', id], queryFn: () => apiFetch<Prefix>(`/ipam/subnets/${encodeURIComponent(id)}`) });
  const allocations = useQuery({ queryKey: ['ipam', 'allocations', id], queryFn: () => apiFetch<Allocation[]>(`/ipam/subnets/${encodeURIComponent(id)}/allocations`) });
  const children = useQuery({ queryKey: ['ipam', 'children', id], queryFn: () => apiFetch<Prefix[]>(`/ipam/subnets/${encodeURIComponent(id)}/children`) });
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => apiFetch<Server[]>('/servers') });
  const connections = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<ProxmoxConnection[]>(`/plugin/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`), retry: false });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['ipam'] });

  const reserve = useMutation({
    mutationFn: () => apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/reservations`, { method: 'POST', body: { address, hostname, description, server_id: serverId || undefined, status: addressStatus, role: addressRole } }),
    onSuccess: () => { setAddress(''); setHostname(''); setDescription(''); setServerId(''); showToast('IP-Adresse angelegt.', 'success'); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const reserveRange = useMutation({
    mutationFn: () => apiFetch<{ count: number }>(`/ipam/subnets/${encodeURIComponent(id)}/reservations/range`, { method: 'POST', body: { start_address: rangeStart, end_address: rangeEnd, description: rangeDescription, status: 'reserved' } }),
    onSuccess: result => { setRangeStart(''); setRangeEnd(''); setRangeDescription(''); showToast(`Bereich mit ${result.count} Adressen reserviert.`, 'success'); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const removeReservation = useMutation({ mutationFn: (reservationId: string) => apiFetch(`/ipam/reservations/${encodeURIComponent(reservationId)}`, { method: 'DELETE' }), onSuccess: () => { showToast('IP-Adresse freigegeben.', 'success'); refresh(); }, onError: (error: Error) => showToast(error.message, 'error') });
  const removeRange = useMutation({ mutationFn: (rangeId: string) => apiFetch(`/ipam/ranges/${encodeURIComponent(rangeId)}`, { method: 'DELETE' }), onSuccess: () => { showToast('IP-Bereich freigegeben.', 'success'); refresh(); }, onError: (error: Error) => showToast(error.message, 'error') });
  const updateReservation = useMutation({ mutationFn: (reservation: Reservation) => apiFetch(`/ipam/reservations/${encodeURIComponent(reservation.id)}`, { method: 'PUT', body: reservation }), onSuccess: () => { showToast('IP-Adresse gespeichert.', 'success'); setEditing(null); refresh(); }, onError: (error: Error) => showToast(error.message, 'error') });
  const syncProxmox = useMutation({
    mutationFn: () => apiFetch<{ created: number; updated: number; conflicts: number; failed: number }>(`/plugin/opentofu/proxmox-connections/${encodeURIComponent(connectionId)}/sync-ipam`, { method: 'POST', body: { subnet_id: id } }),
    onSuccess: result => { showToast(`${result.created} neue, ${result.updated} aktualisierte IPs${result.conflicts ? ` · ${result.conflicts} Konflikte` : ''}`, result.failed || result.conflicts ? 'warning' : 'success'); setSyncOpen(false); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const network = detail.data;
  const allocationRows = Array.isArray(allocations.data) ? allocations.data : [];
  const childRows = Array.isArray(children.data) ? children.data : [];
  const serverRows = Array.isArray(servers.data) ? servers.data : [];
  const connectionRows = Array.isArray(connections.data) ? connections.data : [];
  if (!network) return <div className="p-6 text-sm text-muted-foreground">Prefix wird geladen…</div>;

  return <div className="space-y-5">
    <PageHeader
      back={<Button variant="ghost" size="icon" asChild><Link to="/networks" aria-label="Zurück zu Prefixen"><ArrowLeft /></Link></Button>}
      title={network.cidr}
      description={<span>{network.name}{network.description ? ` · ${network.description}` : ''}</span>}
      actions={<div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => { setConnectionId(connectionRows[0]?.id || ''); setSyncOpen(true); }} disabled={connectionRows.length === 0}><RefreshCw />Proxmox synchronisieren</Button><Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{statusLabel[network.status] || network.status}</Badge></div>}
    />
    {network.parent_id && <Link to="/networks/$id" params={{ id: network.parent_id }} className="inline-flex text-sm text-brand hover:underline">Übergeordnetes Prefix: {network.parent_cidr}</Link>}
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4"><Metric label="Verwendbare IPs" value={network.usable_address_count} /><Metric label="Frei" value={network.free_address_count} tone="text-emerald-600 dark:text-emerald-400" /><Metric label="Einzeladressen" value={network.reservation_count} /><Metric label="Reservierte Bereiche" value={network.range_count} /></div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"><Card><CardHeader className="border-b"><CardTitle className="flex items-center gap-2 text-base"><Network className="h-4 w-4" />Prefix-Informationen</CardTitle></CardHeader><CardContent className="grid gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2"><Info label="VLAN / Bridge" value={`${network.vlan_id ? `VLAN ${network.vlan_id}` : '—'} · ${network.bridge || '—'}`} /><Info label="Gateway" value={network.gateway || '—'} /><Info label="DNS" value={(network.dns_servers || []).join(', ') || '—'} /><Info label="Rolle" value={network.role || '—'} /></CardContent></Card><Card><CardHeader><CardTitle className="text-base">Nächste freie Adresse</CardTitle></CardHeader><CardContent>{network.next_free_address ? <button type="button" onClick={() => setAddress(network.next_free_address || '')} className="font-mono text-sm text-brand hover:underline">{network.next_free_address} übernehmen</button> : <span className="text-sm text-muted-foreground">Keine freie Adresse gefunden.</span>}</CardContent></Card></div>
    <Tabs defaultValue="allocations"><TabsList className="h-auto max-w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0"><TabsTrigger value="allocations" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-brand">Adressraum <Badge variant="secondary">{allocationRows.length}</Badge></TabsTrigger><TabsTrigger value="children" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-brand">Unterprefixe <Badge variant="secondary">{childRows.length}</Badge></TabsTrigger></TabsList>
      <TabsContent value="allocations"><div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"><AllocationTable rows={allocationRows} onEdit={setEditing} onDeleteAddress={value => removeReservation.mutate(value)} onDeleteRange={value => removeRange.mutate(value)} /><div className="space-y-4"><AddressForm address={address} hostname={hostname} description={description} serverId={serverId} status={addressStatus} role={addressRole} servers={serverRows} submitting={reserve.isPending} onAddress={setAddress} onHostname={setHostname} onDescription={setDescription} onServer={setServerId} onStatus={setAddressStatus} onRole={setAddressRole} onSubmit={() => reserve.mutate()} /><RangeForm start={rangeStart} end={rangeEnd} description={rangeDescription} submitting={reserveRange.isPending} onStart={setRangeStart} onEnd={setRangeEnd} onDescription={setRangeDescription} onSubmit={() => reserveRange.mutate()} /></div></div></TabsContent>
      <TabsContent value="children"><Card><CardContent className="p-0">{childRows.length === 0 ? <p className="p-8 text-sm text-muted-foreground">Keine direkten Unterprefixe.</p> : childRows.map(child => <Link key={child.id} to="/networks/$id" params={{ id: child.id }} className="flex items-center gap-3 border-b px-5 py-4 hover:bg-muted/40"><Box className="h-4 w-4 text-brand" /><div className="min-w-0 flex-1"><div className="font-mono font-medium">{child.cidr}</div><div className="text-sm text-muted-foreground">{child.name}</div></div><span className="text-sm text-muted-foreground">{child.free_address_count} frei</span></Link>)}</CardContent></Card></TabsContent>
    </Tabs>
    <EditAddressDialog reservation={editing} servers={serverRows} open={Boolean(editing)} onOpenChange={open => !open && setEditing(null)} onSave={value => updateReservation.mutate(value)} saving={updateReservation.isPending} />
    <Dialog open={syncOpen} onOpenChange={setSyncOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Proxmox-IP-Adressen synchronisieren</DialogTitle><DialogDescription>Gastadressen werden aus dem QEMU Guest Agent gelesen. Manuell gepflegte Einträge und Bereiche bleiben unverändert.</DialogDescription></DialogHeader><select value={connectionId} onChange={event => setConnectionId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">{connectionRows.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select><DialogFooter><Button variant="outline" onClick={() => setSyncOpen(false)}>Abbrechen</Button><Button onClick={() => syncProxmox.mutate()} disabled={!connectionId || syncProxmox.isPending}>{syncProxmox.isPending ? <RefreshCw className="animate-spin" /> : <ServerCog />}Synchronisieren</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function AllocationTable({ rows, onEdit, onDeleteAddress, onDeleteRange }: { rows: Allocation[]; onEdit: (row: Reservation) => void; onDeleteAddress: (id: string) => void; onDeleteRange: (id: string) => void }) {
  return <Card><CardHeader className="border-b"><CardTitle className="flex items-center gap-2 text-base"><Layers3 className="h-4 w-4" />Belegte und reservierte Adressen</CardTitle><p className="text-sm font-normal text-muted-foreground">Einzeladressen und Bereiche in aufsteigender IP-Reihenfolge.</p></CardHeader><CardContent className="overflow-x-auto p-0"><div className="min-w-[800px]"><div className="grid grid-cols-[minmax(170px,1.1fr)_105px_105px_minmax(140px,1fr)_minmax(150px,1fr)_80px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><span>Adresse / Bereich</span><span>Typ</span><span>Status</span><span>Zugewiesen</span><span>Beschreibung</span><span /></div>{rows.map(row => { const isAddress = row.kind === 'address'; const label = isAddress ? row.start_address : `${row.start_address} – ${row.end_address}`; return <div key={`${row.kind}:${row.id}`} className="grid grid-cols-[minmax(170px,1.1fr)_105px_105px_minmax(140px,1fr)_minmax(150px,1fr)_80px] items-center gap-3 border-b px-4 py-3 text-sm last:border-0"><div><span className="font-mono">{label}</span>{!isAddress && <div className="mt-1 text-[11px] text-muted-foreground">{row.address_count} Adressen</div>}{isAddress && row.source_type === 'proxmox' && <div className="mt-1 text-[10px] text-muted-foreground">Proxmox-Sync</div>}</div><Badge variant="outline" className="w-fit">{isAddress ? 'Einzel-IP' : 'Bereich'}</Badge><Badge variant="secondary" className="w-fit">{statusLabel[row.status] || row.status}</Badge><span className="truncate">{isAddress ? row.server_name || row.hostname || '—' : row.role || '—'}</span><span className="truncate text-muted-foreground">{row.description || '—'}</span><div className="flex">{isAddress && <Button variant="ghost" size="icon" onClick={() => onEdit(row as Reservation)} aria-label={`${row.start_address} bearbeiten`}><Pencil className="h-4 w-4" /></Button>}<Button variant="ghost" size="icon" onClick={() => isAddress ? onDeleteAddress(row.id) : onDeleteRange(row.id)} aria-label={`${label} freigeben`}><Trash2 className="h-4 w-4 text-destructive" /></Button></div></div>; })}{rows.length === 0 && <p className="p-8 text-sm text-muted-foreground">In diesem Prefix sind noch keine Adressen oder Bereiche belegt.</p>}</div></CardContent></Card>;
}

function AddressForm({ address, hostname, description, serverId, status, role, servers, submitting, onAddress, onHostname, onDescription, onServer, onStatus, onRole, onSubmit }: { address: string; hostname: string; description: string; serverId: string; status: string; role: string; servers: Server[]; submitting: boolean; onAddress: (value: string) => void; onHostname: (value: string) => void; onDescription: (value: string) => void; onServer: (value: string) => void; onStatus: (value: string) => void; onRole: (value: string) => void; onSubmit: () => void }) {
  return <Card><CardHeader><CardTitle className="text-base">Einzeladresse reservieren</CardTitle></CardHeader><CardContent><form className="space-y-3" onSubmit={event => { event.preventDefault(); onSubmit(); }}><Input required value={address} onChange={event => onAddress(event.target.value)} placeholder="10.20.10.25" /><Input value={hostname} onChange={event => onHostname(event.target.value)} placeholder="Hostname" /><Input value={description} onChange={event => onDescription(event.target.value)} placeholder="Beschreibung" /><select value={status} onChange={event => onStatus(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="active">Aktiv</option><option value="reserved">Reserviert</option><option value="dhcp">DHCP</option><option value="deprecated">Veraltet</option></select><select value={role} onChange={event => onRole(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Keine Rolle</option><option value="gateway">Gateway</option><option value="vip">VIP</option><option value="secondary">Sekundär</option><option value="loopback">Loopback</option></select><select value={serverId} onChange={event => onServer(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Nicht zugewiesen</option>{servers.map(server => <option key={server.id} value={server.id}>{server.name}{server.ip_address ? ` · ${server.ip_address}` : ''}</option>)}</select><Button className="w-full" type="submit" disabled={submitting}><Plus />IP-Adresse hinzufügen</Button></form></CardContent></Card>;
}

function RangeForm({ start, end, description, submitting, onStart, onEnd, onDescription, onSubmit }: { start: string; end: string; description: string; submitting: boolean; onStart: (value: string) => void; onEnd: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void }) {
  return <Card><CardHeader><CardTitle className="text-base">Bereich reservieren</CardTitle></CardHeader><CardContent><form className="space-y-3" onSubmit={event => { event.preventDefault(); onSubmit(); }}><div className="grid grid-cols-2 gap-2"><Input required value={start} onChange={event => onStart(event.target.value)} placeholder="Von" /><Input required value={end} onChange={event => onEnd(event.target.value)} placeholder="Bis" /></div><Input value={description} onChange={event => onDescription(event.target.value)} placeholder="z. B. DHCP-Pool" /><p className="text-xs text-muted-foreground">Der Bereich bleibt ein eigenes IPAM-Objekt und erscheint zusammen mit Einzeladressen in der Liste.</p><Button className="w-full" type="submit" variant="secondary" disabled={submitting}><Plus />Bereich reservieren</Button></form></CardContent></Card>;
}

function EditAddressDialog({ reservation, servers, open, onOpenChange, onSave, saving }: { reservation: Reservation | null; servers: Server[]; open: boolean; onOpenChange: (open: boolean) => void; onSave: (reservation: Reservation) => void; saving: boolean }) {
  const [value, setValue] = useState<Reservation | null>(reservation);
  useEffect(() => { setValue(reservation); }, [reservation]);
  if (!value) return null;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>IP-Adresse bearbeiten</DialogTitle><DialogDescription>Stammdaten, Zuweisung und Status dieser Adresse ändern.</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2"><Field label="IP-Adresse"><Input value={value.address} onChange={event => setValue({ ...value, address: event.target.value })} /></Field><Field label="Status"><select value={value.status} onChange={event => setValue({ ...value, status: event.target.value })} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="active">Aktiv</option><option value="reserved">Reserviert</option><option value="dhcp">DHCP</option><option value="deprecated">Veraltet</option></select></Field><Field label="Hostname"><Input value={value.hostname || ''} onChange={event => setValue({ ...value, hostname: event.target.value })} placeholder="app-01" /></Field><Field label="MAC-Adresse"><Input value={value.mac_address || ''} onChange={event => setValue({ ...value, mac_address: event.target.value })} placeholder="52:54:00:12:34:56" /></Field><Field label="Rolle"><select value={value.role || ''} onChange={event => setValue({ ...value, role: event.target.value })} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Keine Rolle</option><option value="gateway">Gateway</option><option value="vip">VIP</option><option value="secondary">Sekundär</option><option value="loopback">Loopback</option></select></Field><Field label="Fleet-Host"><select value={value.server_id || ''} onChange={event => setValue({ ...value, server_id: event.target.value || undefined })} className="h-10 w-full rounded-md border bg-background px-3 text-sm"><option value="">Nicht zugewiesen</option>{servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></Field><div className="sm:col-span-2"><Field label="Beschreibung"><Input value={value.description || ''} onChange={event => setValue({ ...value, description: event.target.value })} /></Field></div></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button onClick={() => onSave(value)} disabled={saving}><Pencil />Speichern</Button></DialogFooter></DialogContent></Dialog>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
function Metric({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) { return <div className="bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className={`mt-1 font-mono text-xl font-semibold ${tone}`}>{value}</div></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 break-words font-mono text-sm">{value}</div></div>; }
