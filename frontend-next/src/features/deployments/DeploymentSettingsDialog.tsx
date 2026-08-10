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
    mutationFn: () => apiFetch(`/plugin/opentofu/workspaces/${encodeURIComponent(workspace.id)}/metadata`, { method: 'PATCH', body: { name, description } }),
    onSuccess: () => {
      showToast('Deployment-Informationen gespeichert.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Pencil className="h-5 w-5" />Deployment bearbeiten</DialogTitle>
        <DialogDescription>Name und Beschreibung sind reine Konsolen-Metadaten. Der Workspace-Pfad und die geheimen Variablen bleiben unverändert.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className="space-y-1.5"><Label htmlFor="deployment-name">Name</Label><Input id="deployment-name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="deployment-description">Beschreibung <span className="font-normal text-muted-foreground">(optional)</span></Label><Textarea id="deployment-description" maxLength={1000} rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="Zweck und Verantwortlichkeit dieses Deployments" /></div>
        <div className="rounded-md border bg-muted/20 px-3 py-2"><div className="text-xs text-muted-foreground">Workspace-Pfad</div><div className="mt-1 break-all font-mono text-xs">{workspace.path || '—'}</div></div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button><Button type="submit" disabled={saveMutation.isPending || !name.trim()}>{saveMutation.isPending ? <RefreshCw className="animate-spin" /> : <Pencil />}Speichern</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
