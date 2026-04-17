import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { FileText, Plus, Save, Trash2, PlayCircle, History, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { useUi } from '@/lib/store';

interface Playbook {
  filename: string;
  description?: string;
  isInternal?: boolean;
}

interface HistoryEntry {
  version: string | number;
  created_at?: string;
  message?: string;
}

const TEMPLATE = `---
- name: New playbook
  hosts: all
  become: true
  tasks:
    - name: Example task
      ansible.builtin.debug:
        msg: "Hello from Shipyard"
`;

export function PlaybooksPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const theme = useUi((s) => s.theme);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ['playbooks'],
    queryFn: async () => (await api.getPlaybooks()) as unknown as Playbook[],
  });

  const { data: pbData } = useQuery({
    queryKey: ['playbook', selected],
    queryFn: () => api.getPlaybook(selected!),
    enabled: !!selected,
  });

  useEffect(() => {
    if (pbData?.content !== undefined) {
      setContent(pbData.content);
      setOriginalContent(pbData.content);
    }
  }, [pbData?.content]);

  const dirty = content !== originalContent;

  const filtered = useMemo(() => {
    const list = playbooks ?? [];
    const q = filter.trim().toLowerCase();
    const f = q ? list.filter((p) =>
      p.filename.toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q),
    ) : list;
    return {
      user: f.filter((p) => !p.isInternal),
      internal: f.filter((p) => !!p.isInternal),
    };
  }, [playbooks, filter]);

  const selectedPb = playbooks?.find((p) => p.filename === selected);

  const saveMut = useMutation({
    mutationFn: () => api.savePlaybook(selected!, content),
    onSuccess: () => {
      setOriginalContent(content);
      qc.invalidateQueries({ queryKey: ['playbooks'] });
      qc.invalidateQueries({ queryKey: ['playbook', selected] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.deletePlaybook(selected!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playbooks'] });
      setSelected(null);
      setContent('');
      setOriginalContent('');
    },
  });

  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('nav.playbooks')}</h1>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4" /> {t('pb.new')}</Button>
          </DialogTrigger>
          <CreatePlaybookDialog
            onCreated={(filename) => {
              setCreateOpen(false);
              qc.invalidateQueries({ queryKey: ['playbooks'] });
              setSelected(filename);
            }}
          />
        </Dialog>
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
          <CardContent className="p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('common.search')} className="pl-8" />
            </div>

            <PbSection title={t('pb.user')} items={filtered.user} selected={selected} onSelect={setSelected} />
            {filtered.internal.length > 0 && (
              <PbSection title={t('pb.internal')} items={filtered.internal} selected={selected} onSelect={setSelected} muted />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            {!selected ? (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <FileText className="h-8 w-8" />
                <span className="text-sm">{t('pb.selectOne')}</span>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{selectedPb?.description || selected}</div>
                    <div className="truncate text-xs text-muted-foreground">{selected}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
                      <History className="h-4 w-4" /> {t('pb.history')}
                    </Button>
                    {!selectedPb?.isInternal && (
                      <Button variant="outline" size="sm" onClick={() => setRunOpen(true)}>
                        <PlayCircle className="h-4 w-4" /> {t('common.run')}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending || !!selectedPb?.isInternal}>
                      <Trash2 className="h-4 w-4" /> {t('common.delete')}
                    </Button>
                    <Button size="sm" onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending}>
                      <Save className="h-4 w-4" /> {dirty ? t('common.save') : t('pb.saved')}
                    </Button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border">
                  <CodeMirror
                    value={content}
                    onChange={setContent}
                    extensions={[yaml()]}
                    theme={isDark ? 'dark' : 'light'}
                    height="calc(100vh - 18rem)"
                    basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <RunPlaybookDialog filename={selected || ''} onClose={() => setRunOpen(false)} />
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <PlaybookHistoryDialog
          filename={selected || ''}
          onRestore={(version) => {
            qc.invalidateQueries({ queryKey: ['playbook', selected] });
            qc.invalidateQueries({ queryKey: ['playbookHistory', selected] });
            setHistoryOpen(false);
            // version tag for debug
            void version;
          }}
        />
      </Dialog>
    </div>
  );
}

function PbSection({ title, items, selected, onSelect, muted }: {
  title: string;
  items: Playbook[];
  selected: string | null;
  onSelect: (f: string) => void;
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <div className={`mb-1 px-1 text-xs font-medium uppercase tracking-wider ${muted ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>{title}</div>
      <div className="space-y-0.5">
        {items.map((p) => (
          <button
            key={p.filename}
            type="button"
            onClick={() => onSelect(p.filename)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition ${
              selected === p.filename ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
            }`}
          >
            <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate">{p.description || p.filename}</div>
              {p.description && <div className="truncate text-xs text-muted-foreground">{p.filename}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Sub-dialogs ─────────────────────────────────────────────────────────────

function CreatePlaybookDialog({ onCreated }: { onCreated: (filename: string) => void }) {
  const { t } = useTranslation();
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    let name = filename.trim();
    if (!name) { setError(t('pb.nameRequired')); return; }
    if (!/\.ya?ml$/i.test(name)) name += '.yml';
    setBusy(true);
    try {
      await api.savePlaybook(name, TEMPLATE);
      onCreated(name);
    } catch (err) {
      setError((err as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t('pb.new')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-pb">{t('pb.filename')}</Label>
            <Input id="new-pb" autoFocus value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="deploy.yml" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy}>{t('common.create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RunPlaybookDialog({ filename, onClose }: { filename: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.runPlaybook(filename, target.trim() || 'all', {});
      onClose();
    } catch (err) {
      setError((err as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t('pb.runTitle', { name: filename })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="pb-target">{t('pb.target')}</Label>
            <Input id="pb-target" autoFocus value={target} onChange={(e) => setTarget(e.target.value)} placeholder="all" />
            <p className="text-xs text-muted-foreground">{t('pb.targetHint')}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy}>
            <PlayCircle className="h-4 w-4" /> {t('common.run')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function PlaybookHistoryDialog({ filename, onRestore }: { filename: string; onRestore: (version: string | number) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<HistoryEntry[]>({
    queryKey: ['playbookHistory', filename],
    queryFn: async () => (await api.getPlaybookHistory(filename)) as unknown as HistoryEntry[],
    enabled: !!filename,
  });

  const restore = useMutation({
    mutationFn: (version: string | number) => api.restorePlaybook(filename, version),
    onSuccess: (_d, version) => onRestore(version),
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('pb.historyTitle', { name: filename })}</DialogTitle>
      </DialogHeader>
      <div className="max-h-96 space-y-1 overflow-y-auto py-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pb.noHistory')}</p>
        ) : data.map((h) => (
          <div key={String(h.version)} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{h.message || `v${h.version}`}</div>
              <div className="truncate text-xs text-muted-foreground">{h.created_at}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => restore.mutate(h.version)} disabled={restore.isPending}>
              {t('pb.restore')}
            </Button>
          </div>
        ))}
      </div>
    </DialogContent>
  );
}
