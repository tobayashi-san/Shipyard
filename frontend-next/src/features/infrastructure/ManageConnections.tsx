import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useUi } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { PlatformConnectionsDialog } from './PlatformConnectionsDialog';
import { ProxmoxConnectionDialog, type ProxmoxConnection } from './ProxmoxConnectionDialog';
import { ConfirmDeleteConnection } from './ConfirmDeleteConnection';

export function ManageConnections({ inline = false }: { inline?: boolean }) {
  const environmentId = useUi(state => state.environmentId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProxmoxConnection | null | undefined>();
  const [removing, setRemoving] = useState<ProxmoxConnection | null>(null);
  const connections = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<ProxmoxConnection[]>(`/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`, { environmentId }), enabled: inline || open });
  const content = <div className="space-y-3"><Button onClick={() => setEditing(null)}>Add connection</Button>
        {connections.isError ? <QueryErrorState error={connections.error} onRetry={() => void connections.refetch()} /> : connections.isPending ? <p role="status">Loading connections…</p> : connections.data?.length ? connections.data.map(connection => <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="font-medium">{connection.name}</p><p className="font-mono text-xs text-muted-foreground">{connection.endpoint.replace(/\/+$/, '')} · {connection.api_token_configured ? 'Token stored' : 'Token missing'}</p>{connection.insecure && <button className="text-xs text-warning underline" onClick={() => setEditing(connection)}>Certificate verification off</button>}</div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setEditing(connection)}>Edit</Button><Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoving(connection)}>Delete</Button></div></div>) : <p className="text-sm text-muted-foreground">Add a Proxmox connection to import or deploy hosts.</p>}
      </div>;
  return <>
    {inline ? <section className="space-y-4 rounded-md border p-4" aria-label="Proxmox connections"><div><h2 className="font-semibold">Proxmox connections</h2><p className="text-sm text-muted-foreground">Configure the API endpoint, credentials and automatic IPAM synchronization for this environment.</p></div>{content}</section> : <><Button variant="outline" onClick={() => setOpen(true)}>Manage connections</Button><PlatformConnectionsDialog open={open && editing === undefined && !removing} onOpenChange={setOpen}>{content}</PlatformConnectionsDialog></>}
    <ProxmoxConnectionDialog key={`${environmentId}:${editing?.id || "new"}`} environmentId={environmentId} connection={editing || null} open={editing !== undefined} onOpenChange={next => { if (!next) setEditing(undefined); }} />
    <ConfirmDeleteConnection connection={removing} onOpenChange={next => { if (!next) setRemoving(null); }} onDeleted={() => { setRemoving(null); void queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', environmentId] }); }} />
  </>;
}
