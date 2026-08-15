import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface WorkspaceMetadata {
  id: string;
  name: string;
  path?: string;
  description?: string;
}

export function DeploymentSettingsDialog({ workspace, open, onOpenChange }: { workspace: WorkspaceMetadata; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description || '');

  useEffect(() => {
    if (!open) return;
    setName(workspace.name);
    setDescription(workspace.description || '');
  }, [open, workspace.description, workspace.name]);

  const saveMutation = useMutation({
    mutationFn: () => apiFetch(`/opentofu/workspaces/${encodeURIComponent(workspace.id)}/metadata`, { method: 'PATCH', body: { name, description } }),
    onSuccess: () => {
      showToast('Deployment information saved.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Pencil className="h-5 w-5" />Edit deployment</DialogTitle>
        <DialogDescription>Name and description are console metadata only. The workspace path and secret variables are unchanged.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className="space-y-1.5"><Label htmlFor="deployment-name">Name</Label><Input id="deployment-name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="deployment-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label><Textarea id="deployment-description" maxLength={1000} rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="Purpose and ownership of this deployment" /></div>
        <div className="rounded-md border bg-muted/20 px-3 py-2"><div className="text-xs text-muted-foreground">Workspace path</div><div className="mt-1 break-all font-mono text-xs">{workspace.path || '—'}</div></div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saveMutation.isPending || !name.trim()}>{saveMutation.isPending ? <RefreshCw className="animate-spin" /> : <Pencil />}Save</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
