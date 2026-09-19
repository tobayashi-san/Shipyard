import {useEffect, useRef, useState} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {apiFetch} from '@/lib/api';
import {Button} from '@/components/ui/button';

interface Prefix {
  id: string;
  name: string;
  cidr: string;
  environment_id: string;
  status: string;
  next_free_address?: string | null;
  gateway?: string;
  bridge?: string;
  proxmox_connection_id?: string;
  vlan_id?: number | null;
}
export interface Selection {address: string; prefix: string; gateway: string; bridge: string; connectionId: string; vlan: string}

export function VmIpamSelection({environmentId, onUse, onNetwork}: {environmentId: string; onUse: (selection: Selection) => void; onNetwork?: (selection: Pick<Selection, "bridge" | "connectionId" | "vlan">) => void}) {
  const active = useRef(true);
  useEffect(() => {active.current = true; return () => {active.current = false;};}, []);
  const [selected, setSelected] = useState('');
  const [applied, setApplied] = useState('');
  const query = useQuery({
    queryKey: ['ipam', 'vm-prefix-selection', environmentId],
    queryFn: () => apiFetch<Prefix[]>('/ipam/subnets', {environmentId}),
    staleTime: 0,
  });
  const prefixes = (Array.isArray(query.data) ? query.data : []).filter(prefix => prefix.environment_id === environmentId && prefix.status !== 'deprecated');
  const choice = prefixes.find(prefix => prefix.id === selected);
  const useAddress = useMutation({
    mutationFn: async () => {
      const prefix = await apiFetch<Prefix>(`/ipam/subnets/${encodeURIComponent(selected)}`, {environmentId});
      if (prefix.environment_id !== environmentId || prefix.status === 'deprecated') throw Error('This prefix is no longer available in the selected environment. Refresh the list.');
      if (!prefix.next_free_address) throw Error('This prefix has no available address. Select another prefix.');
      const length = prefix.cidr.split('/')[1];
      if (!length || !Number.isInteger(Number(length)) || Number(length) < 0 || Number(length) > 32) throw Error('The prefix has an unsupported address format.');
      return {address: prefix.next_free_address, prefix: length, gateway: prefix.gateway || '', bridge: prefix.bridge || '', connectionId: prefix.proxmox_connection_id || '', vlan: String(prefix.vlan_id || '')};
    },
    onSuccess: selection => {if (active.current) {onUse(selection); setApplied(selection.address);}},
  });
  return <div className="col-span-full space-y-2 rounded-md border p-3 text-sm">
    <p className="font-medium">Choose an address from IPAM</p>
    <p className="text-xs text-muted-foreground">Environment: {environmentId}. This copies the next available address into the VM configuration; it does not reserve it or apply the VM. The mapped bridge is selected automatically when available on the chosen platform and node.</p>
    {query.isError ? <p role="alert">IPAM prefixes could not be loaded. {query.error.message} <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : <>
      <label className="block">IPAM prefix<select className="mt-1 h-9 w-full rounded-md border bg-background px-3" value={selected} disabled={query.isPending || useAddress.isPending} onChange={event => {setSelected(event.target.value); setApplied(''); useAddress.reset(); const prefix = prefixes.find(item => item.id === event.target.value); if (prefix) onNetwork?.({bridge:prefix.bridge || '',connectionId:prefix.proxmox_connection_id || '',vlan:String(prefix.vlan_id || '')});}}>
        <option value="">{query.isPending ? 'Loading prefixes…' : 'Select a prefix'}</option>
        {prefixes.map(prefix => <option key={prefix.id} value={prefix.id}>{prefix.name} · {prefix.cidr}</option>)}
      </select></label>
      {query.isSuccess && !prefixes.length && <p>No current IPAM prefixes are available in this environment. You can enter the network settings manually.</p>}
      {choice && <p className="text-xs text-muted-foreground">Gateway: {choice.gateway || 'not configured'} · Bridge: {choice.bridge || 'not configured'} · VLAN: {choice.vlan_id ?? 'not configured'}</p>}
      <Button type="button" size="sm" variant="outline" disabled={!choice || query.isFetching || useAddress.isPending} onClick={() => {setApplied(''); useAddress.mutate();}}>{useAddress.isPending ? 'Checking current availability…' : 'Use next available address'}</Button>
    </>}
    {useAddress.isError && <p role="alert" className="text-destructive">{useAddress.error.message}</p>}
    {applied && <p role="status">Copied {applied}. Availability can change until the address is reserved in IPAM.</p>}
  </div>;
}
