import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QueryErrorState } from '@/components/ui/query-error-state';
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
  const [sourceId, setSourceId] = useState('');
  const configQuery = useQuery({
    queryKey: ['opentofu', 'workspace', workspaceId, 'proxmox-connection'],
    queryFn: () => apiFetch<ConnectionConfig>(`/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-connection`),
    enabled: open,
    staleTime: 15_000,
  });
  const sourcesQuery = useQuery({ queryKey: ['opentofu', 'proxmox-connections', environmentId], queryFn: () => apiFetch<ProxmoxConnection[]>(`/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`), enabled: open, staleTime: 15_000 });
  const sources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : [];

  useEffect(() => {
    if (!open || !configQuery.data) return;
    setSourceId(configQuery.data.source_id || '');
  }, [configQuery.data, open]);

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/workspaces/${encodeURIComponent(workspaceId)}/proxmox-connection`, {
      method: 'PUT', body: { proxmox_connection_id: sourceId },
    }),
    onSuccess: () => {
      showToast('Proxmox connection saved.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', workspaceId] });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const promoteMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/workspaces/${encodeURIComponent(workspaceId)}/promote-proxmox-connection`, { method: 'POST' }),
    onSuccess: () => {
      showToast('Workspace connection adopted as a central platform.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', workspaceId, 'proxmox-connection'] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'proxmox-connections', environmentId] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'infrastructure', environmentId] });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const config = configQuery.data;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Infrastructure source</DialogTitle>
        <DialogDescription>Deployments use a central platform connection. Credentials are managed from Virtual machines.</DialogDescription>
      </DialogHeader>
      {configQuery.isLoading || sourcesQuery.isLoading ? <div className="space-y-3 py-4"><div className="h-10 animate-pulse rounded-md bg-muted" /><div className="h-10 animate-pulse rounded-md bg-muted" /></div> : configQuery.isError || sourcesQuery.isError ? (
        <QueryErrorState compact error={configQuery.error || sourcesQuery.error} title="Infrastructure source could not be loaded" onRetry={() => void Promise.all([configQuery.refetch(), sourcesQuery.refetch()])} />
      ) : <form className="space-y-5" onSubmit={event => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-2"><Status label="API token" configured={config?.api_token_configured} /><Status label="Default SSH key" configured={config?.ssh_public_key_configured} /></div>
        <div className="space-y-1.5"><Label htmlFor="deployment-source">Proxmox platform</Label><select id="deployment-source" value={sourceId} onChange={event => setSourceId(event.target.value)} className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]" disabled={sourcesQuery.isLoading || sources.length === 0}><option value="">{sourcesQuery.isLoading ? 'Loading…' : 'Select platform…'}</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.endpoint}</option>)}</select><p className="text-xs text-muted-foreground">Changes to the token, TLS, and default SSH key are made centrally from Virtual machines.</p></div>
        {!config?.source_id && config?.api_token_configured && <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3"><div className="text-sm font-medium">Existing workspace connection found</div><p className="mt-1 text-xs text-muted-foreground">Adopt it once as a central platform. The deployment is then linked to it directly.</p><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => promoteMutation.mutate()} disabled={promoteMutation.isPending}>{promoteMutation.isPending ? <RefreshCw className="animate-spin" /> : <ArrowRightLeft />}Adopt centrally now</Button></div>}
        {sourceId && <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">This configuration comes from the selected platform connection.</div>}
        {sources.length === 0 && <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">There is no platform connection in this environment yet. Create one from Virtual machines first.</div>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saveMutation.isPending || !sourceId}>{saveMutation.isPending ? <RefreshCw className="animate-spin" /> : <KeyRound />}Assign platform</Button></DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>;
}

function Status({ label, configured }: { label: string; configured?: boolean }) {
  return <div className="rounded-md border bg-muted/20 px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className={configured ? 'mt-1 text-sm font-medium text-emerald-600 dark:text-emerald-400' : 'mt-1 text-sm font-medium text-muted-foreground'}>{configured ? 'Configured' : 'Not set'}</div></div>;
}
