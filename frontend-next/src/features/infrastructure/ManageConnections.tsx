import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useUi } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { PlatformConnectionsDialog } from './PlatformConnectionsDialog';
import { ProxmoxConnectionDialog, type ProxmoxConnection } from './ProxmoxConnectionDialog';
import { ConfirmDeleteConnection } from './ConfirmDeleteConnection';

export function ManageConnections() {
  const environmentId = useUi(state => state.environmentId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProxmoxConnection | null | undefined>();
  const [removing, setRemoving] = useState<ProxmoxConnection | null>(null);
  const connections = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<ProxmoxConnection[]>(`/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`, { environmentId }), enabled: open });
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}>Manage connections</Button>
    <PlatformConnectionsDialog open={open && editing === undefined && !removing} onOpenChange={setOpen}>
      <div className="space-y-3"><Button onClick={() => setEditing(null)}>Add connection</Button>
        {connections.isError ? <QueryErrorState error={connections.error} onRetry={() => void connections.refetch()} /> : connections.isPending ? <p role="status">Loading connections…</p> : connections.data?.length ? connections.data.map(connection => <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="font-medium">{connection.name}</p><p className="text-sm text-muted-foreground">{connection.endpoint}</p><p className="text-xs text-muted-foreground">{connection.api_token_configured ? 'Token stored' : 'Token missing'}</p>{connection.insecure && <button className="text-xs text-warning underline" onClick={() => setEditing(connection)}>Certificate verification off</button>}</div><div className="flex gap-2"><Button variant="outline" onClick={() => setEditing(connection)}>Edit</Button><Button variant="ghost" onClick={() => setRemoving(connection)}>Delete</Button></div></div>) : <p className="text-sm text-muted-foreground">Add a Proxmox connection to import or deploy hosts.</p>}
      </div>
    </PlatformConnectionsDialog>
    <ProxmoxConnectionDialog key={environmentId} environmentId={environmentId} connection={editing || null} open={editing !== undefined} onOpenChange={next => { if (!next) setEditing(undefined); }} />
    <ConfirmDeleteConnection connection={removing} onOpenChange={next => { if (!next) setRemoving(null); }} onDeleted={() => { setRemoving(null); void queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', environmentId] }); }} />
  </>;
}
