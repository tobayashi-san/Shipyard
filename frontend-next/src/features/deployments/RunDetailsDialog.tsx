import { useQuery } from '@tanstack/react-query';
import { Check, Clipboard, FileOutput, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';

interface RunDetails {
  id: string;
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  output?: string;
}

function tone(status?: string): StatusTone {
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'error') return 'danger';
  if (status === 'running' || status === 'queued') return 'info';
  return 'muted';
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

export function RunDetailsDialog({ workspaceId, runId, open, onOpenChange }: { workspaceId: string; runId?: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const runQuery = useQuery({
    queryKey: ['opentofu', 'workspace', workspaceId, 'run', runId],
    queryFn: () => apiFetch<RunDetails>(`/plugin/opentofu/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId || '')}`),
    enabled: open && Boolean(runId),
    refetchInterval: query => ['running', 'queued'].includes(String(query.state.data?.status || '')) ? 2_000 : false,
  });
  const run = runQuery.data;
  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(run?.output || '');
      showToast('Ausgabe kopiert.', 'success');
    } catch {
      showToast('Ausgabe konnte nicht kopiert werden.', 'error');
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-4xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2"><FileOutput className="h-5 w-5" />{run?.action || 'OpenTofu-Lauf'}{run && <StatusBadge tone={tone(run.status)} dot>{run.status || '—'}</StatusBadge>}</DialogTitle>
        <DialogDescription>{run ? `Gestartet: ${formatDate(run.started_at)}${run.completed_at ? ` · Beendet: ${formatDate(run.completed_at)}` : ''}` : 'Lauf wird geladen…'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-48 flex-1 overflow-auto rounded-md border bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100 dark:bg-zinc-950 dark:text-zinc-100">
        {runQuery.isLoading ? <div className="flex h-32 items-center justify-center gap-2 text-zinc-400"><RefreshCw className="h-4 w-4 animate-spin" />Lauf wird geladen…</div> : runQuery.isError ? <p className="text-red-300">Die Laufdetails konnten nicht geladen werden.</p> : <pre className="whitespace-pre-wrap break-words">{run?.output || (run?.status === 'running' ? 'Warte auf Ausgabe…' : 'Keine Ausgabe vorhanden.')}</pre>}
      </div>
      <DialogFooter><Button type="button" variant="outline" onClick={() => void runQuery.refetch()} disabled={runQuery.isFetching}><RefreshCw className={runQuery.isFetching ? 'animate-spin' : undefined} />Aktualisieren</Button><Button type="button" variant="outline" onClick={() => void copyOutput()} disabled={!run?.output}><Clipboard />Ausgabe kopieren</Button><Button type="button" onClick={() => onOpenChange(false)}><Check />Schließen</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
