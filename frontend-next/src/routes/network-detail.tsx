import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Network, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';

interface NetworkDetail {
  id: string; name: string; cidr: string; gateway?: string; dns_servers?: string[];
  vlan_id?: number | null; bridge?: string; description?: string;
  usable_address_count: number; free_address_count: number; reservation_count: number; next_free_address?: string | null;
}
interface Reservation { id: string; address: string; hostname?: string; server_name?: string; description?: string }

export function NetworkDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const queryClient = useQueryClient();
  const [address, setAddress] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [description, setDescription] = useState('');
  const detail = useQuery({ queryKey: ['ipam', 'network', id], queryFn: () => apiFetch<NetworkDetail>(`/ipam/subnets/${encodeURIComponent(id)}`) });
  const reservations = useQuery({ queryKey: ['ipam', 'reservations', id], queryFn: () => apiFetch<Reservation[]>(`/ipam/subnets/${encodeURIComponent(id)}/reservations`) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['ipam'] });

  const reserve = useMutation({
    mutationFn: () => apiFetch(`/ipam/subnets/${encodeURIComponent(id)}/reservations`, { method: 'POST', body: { address, description } }),
    onSuccess: () => { setAddress(''); setDescription(''); showToast('IP-Adresse reserviert.', 'success'); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const reserveRange = useMutation({
    mutationFn: () => apiFetch<{ count: number }>(`/ipam/subnets/${encodeURIComponent(id)}/reservations/range`, { method: 'POST', body: { start_address: rangeStart, end_address: rangeEnd, description } }),
    onSuccess: result => { setRangeStart(''); setRangeEnd(''); setDescription(''); showToast(`${result.count} IP-Adressen reserviert.`, 'success'); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (reservationId: string) => apiFetch(`/ipam/reservations/${encodeURIComponent(reservationId)}`, { method: 'DELETE' }),
    onSuccess: () => { showToast('Reservierung freigegeben.', 'success'); refresh(); },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const network = detail.data;
  const rows = Array.isArray(reservations.data) ? reservations.data : [];
  if (!network) return <div className="p-6 text-sm text-muted-foreground">Netzwerk wird geladen…</div>;

  return <div className="space-y-6">
    <PageHeader
      back={<Button variant="ghost" size="icon" asChild><Link to="/networks" aria-label="Zurück zu Netzwerken"><ArrowLeft /></Link></Button>}
      title={network.name}
      description={`${network.cidr}${network.description ? ` · ${network.description}` : ''}`}
      actions={<span className="font-mono text-sm text-muted-foreground">{network.gateway || 'ohne Gateway'}</span>}
    />
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
      <Metric label="Verwendbare IPs" value={network.usable_address_count} />
      <Metric label="Frei" value={network.free_address_count} accent="text-emerald-600 dark:text-emerald-400" />
      <Metric label="Reserviert" value={network.reservation_count} />
      <Metric label="VLAN / Bridge" value={network.vlan_id ? `${network.vlan_id} · ${network.bridge || '—'}` : network.bridge || '—'} />
    </div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader className="border-b"><CardTitle className="flex items-center gap-2 text-base"><Network className="h-4 w-4" />Reservierte IP-Adressen</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[150px_minmax(0,1fr)_auto] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground"><span>Adresse</span><span>Beschreibung / Zuordnung</span><span /></div>
          {rows.map(row => <div key={row.id} className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-sm last:border-0"><span className="font-mono">{row.address}</span><span className="min-w-0 truncate text-muted-foreground">{row.description || row.hostname || row.server_name || 'Reserviert'}</span><Button variant="ghost" size="icon" onClick={() => remove.mutate(row.id)} aria-label={`${row.address} freigeben`}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>)}
          {rows.length === 0 && <p className="p-8 text-sm text-muted-foreground">Noch keine IP-Adressen reserviert. Freie Adressen werden oben gezählt.</p>}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card><CardHeader><CardTitle className="text-base">Einzelne IP reservieren</CardTitle></CardHeader><CardContent><form className="space-y-3" onSubmit={event => { event.preventDefault(); reserve.mutate(); }}><Input required value={address} onChange={event => setAddress(event.target.value)} placeholder="10.20.10.25" /><Input value={description} onChange={event => setDescription(event.target.value)} placeholder="Beschreibung, z. B. ERP" />{network.next_free_address && <button type="button" onClick={() => setAddress(network.next_free_address || '')} className="text-left text-xs text-brand hover:underline">Nächste freie Adresse übernehmen: <span className="font-mono">{network.next_free_address}</span></button>}<Button className="w-full" type="submit" disabled={reserve.isPending}><Plus />IP reservieren</Button></form></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">IP-Bereich reservieren</CardTitle></CardHeader><CardContent><form className="space-y-3" onSubmit={event => { event.preventDefault(); reserveRange.mutate(); }}><div className="grid grid-cols-2 gap-2"><Input required value={rangeStart} onChange={event => setRangeStart(event.target.value)} placeholder="Von" /><Input required value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} placeholder="Bis" /></div><Label className="text-xs text-muted-foreground">Maximal 512 IPs pro Bereich. Bereits belegte IPs verhindern die Reservierung.</Label><Button className="w-full" type="submit" variant="secondary" disabled={reserveRange.isPending}><Plus />Bereich reservieren</Button></form></CardContent></Card>
      </div>
    </div>
  </div>;
}

function Metric({ label, value, accent = '' }: { label: string; value: string | number; accent?: string }) {
  return <div className="bg-card p-4"><div className="text-xs text-muted-foreground">{label}</div><div className={`mt-1 font-mono text-xl font-semibold ${accent}`}>{value}</div></div>;
}
