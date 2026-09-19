import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { hasCap, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { CreateSnapshotDialog } from '@/features/infrastructure/CreateSnapshotDialog';
import { DeleteSnapshotDialog } from '@/features/infrastructure/DeleteSnapshotDialog';
import { RestoreSnapshotDialog } from '@/features/infrastructure/RestoreSnapshotDialog';
import type { ManagedDeployment } from './server-detail-model';

type Snapshot = { name: string; description?: string; snaptime?: number };
export function HostSnapshots({ mapping }: { mapping?: ManagedDeployment }) {
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  const [createOpen, setCreateOpen] = useState(false);
  const [remove, setRemove] = useState<Snapshot | null>(null);
  const [restore, setRestore] = useState<Snapshot | null>(null);
  const vm = mapping?.vm;
  const apiRoot = mapping?.connection_id && vm?.node_name && vm.vm_id != null
    ? `/opentofu/proxmox-connections/${encodeURIComponent(mapping.connection_id)}/vms/${encodeURIComponent(vm.node_name)}/${encodeURIComponent(vm.vm_id)}` : null;
  const snapshots = useQuery({ queryKey: ['host-snapshots', environmentId, apiRoot], queryFn: () => apiFetch<{ snapshots?: Snapshot[] }>(`${apiRoot}/snapshots`, { environmentId }), enabled: Boolean(apiRoot), retry: false });
  if (!apiRoot) return <p className="py-6 text-sm text-muted-foreground">Snapshots are available for hosts linked to a Proxmox guest.</p>;
  const canEdit = hasCap(profile, 'canEditServers');
  const guestName = vm?.name || '';
  const refresh = () => { void snapshots.refetch(); };
  return <div className="space-y-4">
    {canEdit && <Button onClick={() => setCreateOpen(true)}>Create snapshot</Button>}
    {snapshots.isError ? <QueryErrorState error={snapshots.error} onRetry={refresh} /> : snapshots.isPending ? <p role="status">Loading snapshots…</p> : <div className="divide-y rounded-md border">
      {(snapshots.data?.snapshots || []).filter(snapshot => snapshot.name !== 'current').map(snapshot => <div key={snapshot.name} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-medium">{snapshot.name}</p><p className="text-xs text-muted-foreground">{snapshot.snaptime ? formatDateTime(snapshot.snaptime * 1000) : 'Time unavailable'}{snapshot.description && ` · ${snapshot.description}`}</p></div>{canEdit && <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setRestore(snapshot)} disabled={!guestName || !hasCap(profile, 'canRebootServers')}>Restore</Button><Button variant="ghost" size="sm" onClick={() => setRemove(snapshot)}>Delete</Button></div>}</div>)}
      {!snapshots.data?.snapshots?.some(snapshot => snapshot.name !== 'current') && <p className="p-6 text-sm text-muted-foreground">No snapshots yet.</p>}
    </div>}
    <CreateSnapshotDialog open={createOpen} onOpenChange={setCreateOpen} apiRoot={apiRoot} environmentId={environmentId} guestName={guestName} guestType={vm?.guest_type} onAccepted={refresh} />
    <DeleteSnapshotDialog snapshotName={remove?.name ?? null} apiRoot={apiRoot} environmentId={environmentId} guestName={guestName} onClose={() => setRemove(null)} onAccepted={refresh} />
    <RestoreSnapshotDialog snapshotName={restore?.name ?? null} snapshotTime={restore?.snaptime ?? null} apiRoot={apiRoot} environmentId={environmentId} guestName={guestName} onClose={() => setRestore(null)} onAccepted={refresh} />
  </div>;
}
