import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Network, Plus, Search } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useUi } from '@/lib/store';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';

interface Prefix {
  id: string; name: string; cidr: string; gateway?: string; vlan_id?: number | null; bridge?: string; description?: string; status: string; role?: string;
  parent_id?: string | null; child_prefix_count: number; child_prefix_address_count?: number; usable_address_count: number; used_address_count: number; free_address_count: number; reservation_count: number; range_count: number;
}
const statusLabel: Record<string, string> = { active: 'Aktiv', container: 'Container', reserved: 'Reserviert', deprecated: 'Veraltet' };
const statusClass: Record<string, string> = { active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', container: 'bg-blue-500/10 text-blue-700 dark:text-blue-400', reserved: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', deprecated: 'bg-muted text-muted-foreground' };

export function NetworksPage() {
  const environmentId = useUi(state => state.environmentId);
  const [createOpen, setCreateOpen] = useState(false); const [search, setSearch] = useState(''); const [status, setStatus] = useState('all');
  const query = useQuery({ queryKey: ['ipam', 'subnets', environmentId], queryFn: () => apiFetch<Prefix[]>(`/ipam/subnets?environment_id=${encodeURIComponent(environmentId)}`) });
  const prefixes = Array.isArray(query.data) ? query.data : [];
  const rows = useMemo(() => prefixes.filter(prefix => (status === 'all' || prefix.status === status) && `${prefix.name} ${prefix.cidr} ${prefix.description || ''}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.cidr.localeCompare(b.cidr, undefined, { numeric: true })), [prefixes, search, status]);
  const hierarchicalRows = useMemo(() => {
    const byParent = new Map<string | null, Prefix[]>();
    rows.forEach(prefix => {
      const parent = prefix.parent_id && rows.some(candidate => candidate.id === prefix.parent_id) ? prefix.parent_id : null;
      byParent.set(parent, [...(byParent.get(parent) || []), prefix]);
    });
    const sort = (items: Prefix[]) => items.sort((left, right) => left.cidr.localeCompare(right.cidr, undefined, { numeric: true }));
    const visit = (parentId: string | null, depth: number): Array<{ prefix: Prefix; depth: number }> => sort(byParent.get(parentId) || []).flatMap(prefix => [{ prefix, depth }, ...visit(prefix.id, depth + 1)]);
    return visit(null, 0);
  }, [rows]);
  // Only top-level prefixes belong in the environment total. Child prefixes
  // already consume capacity inside their parent and must not be counted twice.
  const rootPrefixes = prefixes.filter(prefix => !prefix.parent_id);
  const totalAddresses = rootPrefixes.reduce((sum, prefix) => sum + prefix.usable_address_count, 0); const usedAddresses = rootPrefixes.reduce((sum, prefix) => sum + prefix.used_address_count, 0);
  return <div className="space-y-5">
    <PageHeader title="IP-Adressverwaltung" description="Prefixe, IP-Adressen und reservierte Bereiche je Umgebung." actions={<Button onClick={() => setCreateOpen(true)}><Plus />Prefix hinzufügen</Button>} />
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3"><Metric label="Prefixe" value={prefixes.length} /><Metric label="Verwendbare Adressen" value={totalAddresses} /><Metric label="Belegt" value={`${usedAddresses} · ${totalAddresses ? Math.round((usedAddresses / totalAddresses) * 100) : 0}%`} /></div>
    <Card>
      <CardHeader className="gap-4 border-b py-4 sm:flex-row sm:items-center sm:justify-between"><CardTitle className="flex items-center gap-2 text-base"><Network className="h-4 w-4" />Prefixe <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">{rows.length}</span></CardTitle><div className="flex flex-col gap-2 sm:flex-row"><label className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} className="pl-8 sm:w-64" placeholder="Prefix suchen…" /></label><select value={status} onChange={event => setStatus(event.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="all">Alle Status</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></CardHeader>
      <CardContent className="p-0"><div className="hidden grid-cols-[minmax(250px,1.5fr)_130px_150px_minmax(160px,1fr)_minmax(160px,1fr)_auto] gap-4 border-b bg-muted/30 px-5 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground lg:grid"><span>Prefix</span><span>Status</span><span>VLAN / Bridge</span><span>Auslastung</span><span>Beschreibung</span><span /></div>{hierarchicalRows.length === 0 ? <p className="p-10 text-sm text-muted-foreground">Keine Prefixe gefunden.</p> : hierarchicalRows.map(({ prefix, depth }) => <PrefixRow key={prefix.id} prefix={prefix} depth={depth} />)}</CardContent>
    </Card>
    <CreatePrefixDialog open={createOpen} onOpenChange={setCreateOpen} environmentId={environmentId} />
  </div>;
}

function PrefixRow({ prefix, depth }: { prefix: Prefix; depth: number }) {
  const usage = prefix.usable_address_count ? Math.min(100, Math.round((prefix.used_address_count / prefix.usable_address_count) * 100)) : 0;
  return <Link to="/networks/$id" params={{ id: prefix.id }} style={{ paddingLeft: `${20 + Math.min(depth, 6) * 20}px` }} className="grid gap-3 border-b py-4 pr-5 transition-colors last:border-0 hover:bg-muted/40 lg:grid-cols-[minmax(250px,1.5fr)_130px_150px_minmax(160px,1fr)_minmax(160px,1fr)_auto] lg:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><Network className="h-4 w-4 shrink-0 text-brand" /><span className="font-mono font-medium">{prefix.cidr}</span>{prefix.child_prefix_count > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{prefix.child_prefix_count} Unterprefixe</span>}</div><div className="mt-1 truncate pl-6 text-sm text-muted-foreground">{prefix.name}</div></div><div><Badge className={statusClass[prefix.status] || statusClass.active} variant="secondary">{statusLabel[prefix.status] || prefix.status}</Badge>{prefix.role && <div className="mt-1 text-xs text-muted-foreground">{prefix.role}</div>}</div><div className="text-sm"><div>{prefix.vlan_id ? `VLAN ${prefix.vlan_id}` : '—'}</div><div className="font-mono text-xs text-muted-foreground">{prefix.bridge || '—'}</div></div><div><div className="mb-1 flex justify-between text-xs tabular-nums"><span>{prefix.free_address_count} frei</span><span className="text-muted-foreground">{usage}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={usage > 90 ? 'h-full bg-destructive' : usage > 70 ? 'h-full bg-amber-500' : 'h-full bg-emerald-500'} style={{ width: `${usage}%` }} /></div><div className="mt-1 text-[11px] text-muted-foreground">{prefix.reservation_count} IPs · {prefix.range_count} Bereiche{prefix.child_prefix_address_count ? ` · ${prefix.child_prefix_address_count} durch Unterprefixe` : ''}</div></div><div className="min-w-0 truncate text-sm text-muted-foreground">{prefix.description || '—'}</div><ChevronRight className="hidden h-4 w-4 text-muted-foreground lg:block" /></Link>;
}

function CreatePrefixDialog({ open, onOpenChange, environmentId }: { open: boolean; onOpenChange: (open: boolean) => void; environmentId: string }) {
  const queryClient = useQueryClient(); const [name, setName] = useState(''); const [cidr, setCidr] = useState(''); const [gateway, setGateway] = useState(''); const [dns, setDns] = useState(''); const [vlan, setVlan] = useState(''); const [bridge, setBridge] = useState(''); const [description, setDescription] = useState(''); const [status, setStatus] = useState('active'); const [role, setRole] = useState('');
  const create = useMutation({ mutationFn: () => apiFetch('/ipam/subnets', { method: 'POST', body: { environment_id: environmentId, name, cidr, gateway, vlan_id: vlan, bridge, description, status, role, dns_servers: dns.split(',').map(value => value.trim()).filter(Boolean) } }), onSuccess: () => { showToast('Prefix angelegt.', 'success'); onOpenChange(false); void queryClient.invalidateQueries({ queryKey: ['ipam'] }); }, onError: (error: Error) => showToast(error.message, 'error') });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Prefix hinzufügen</DialogTitle><DialogDescription>Unterprefixe werden automatisch anhand ihres CIDR dem passenden übergeordneten Prefix zugeordnet.</DialogDescription></DialogHeader><form className="grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); create.mutate(); }}><Field label="Name"><Input required value={name} onChange={event => setName(event.target.value)} placeholder="Produktionsnetz" /></Field><Field label="IPv4-Prefix"><Input required value={cidr} onChange={event => setCidr(event.target.value)} placeholder="10.20.10.0/24" /></Field><Field label="Status"><select value={status} onChange={event => setStatus(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Rolle"><Input value={role} onChange={event => setRole(event.target.value)} placeholder="z. B. Produktion" /></Field><Field label="Gateway"><Input value={gateway} onChange={event => setGateway(event.target.value)} placeholder="10.20.10.1" /></Field><Field label="DNS-Server"><Input value={dns} onChange={event => setDns(event.target.value)} placeholder="10.20.10.10, 10.20.10.11" /></Field><Field label="VLAN-ID"><Input value={vlan} onChange={event => setVlan(event.target.value)} inputMode="numeric" placeholder="2010" /></Field><Field label="Bridge"><Input value={bridge} onChange={event => setBridge(event.target.value)} placeholder="vmbr0" /></Field><div className="sm:col-span-2"><Field label="Beschreibung"><Input value={description} onChange={event => setDescription(event.target.value)} placeholder="Applikationsnetz für Produktion" /></Field></div><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={create.isPending}>Prefix hinzufügen</Button></DialogFooter></form></DialogContent></Dialog>;
}
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-xl font-semibold">{value}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }
