import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export function PrefixConnectionSelect({ environmentId, value, onChange }: { environmentId: string; value: string; onChange: (value: string) => void }) {
  const query = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<{ id: string; name: string }[]>(`/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`, { environmentId }) });
  return <label className="space-y-1 text-sm">Proxmox connection<select className="h-9 w-full rounded-md border bg-background px-3" value={value} onChange={event => onChange(event.target.value)} disabled={query.isPending || query.isError}><option value="">No automatic network mapping</option>{(query.data || []).map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select>{query.isError && <span role="alert">Connections could not be loaded. Reopen this form to retry.</span>}</label>;
}
