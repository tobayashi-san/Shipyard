import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import {
  FileText, Plus, Save, Trash2, Play, History, Search, ChevronDown,
  FolderCog, Folder, ArrowLeft, X, Eye, Undo2, Clock, SlidersHorizontal,
  GitBranch, ArrowDown, ArrowUp, Settings2, Terminal,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useUi } from '@/lib/store';
import { useProfile, hasCap } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { ws } from '@/lib/ws';
import { useNavigate } from '@tanstack/react-router';

// ── Types ────────────────────────────────────────────────────────────────────

interface Playbook {
  filename: string;
  description?: string;
  category?: string;
  isInternal?: boolean;
}

interface AnsibleVar {
  id: string;
  key: string;
  value: string;
  description?: string;
}

interface Schedule {
  id: string;
  name: string;
  playbook: string;
  targets?: string;
  cron_expression: string;
  enabled: boolean;
  last_run?: string;
  last_status?: string;
}

interface HistoryEntry {
  id: string;
  schedule_id?: string | null;
  schedule_name?: string;
  playbook: string;
  targets?: string;
  started_at: string;
  status: string;
  output?: string;
}

interface PlaybookVersion {
  version: number;
  modifiedAt?: string;
  content?: string;
}

// ── Target helpers ───────────────────────────────────────────────────────────

function buildAllExceptTargets(excluded: string[]): string {
  const u = [...new Set(excluded.map(n => String(n || '').trim()).filter(Boolean))];
  if (u.length === 0) return 'all';
  return `all:${u.map(n => `!${n}`).join(':')}`;
}

function parsePlaybookTargets(targets: string) {
  const raw = String(targets || '').trim();
  if (!raw || raw === 'all') return { mode: 'all' as const, excluded: [] as string[], included: [] as string[] };
  const parts = raw.split(':').map(t => t.trim()).filter(Boolean);
  if (parts[0] === 'all' && parts.slice(1).every(t => t.startsWith('!') && t.length > 1)) {
    return { mode: 'all' as const, excluded: parts.slice(1).map(t => t.slice(1)), included: [] as string[] };
  }
  return { mode: 'list' as const, excluded: [] as string[], included: raw.split(',').map(t => t.trim()).filter(Boolean) };
}

// ── Cron helpers (matching old frontend 1:1) ─────────────────────────────────

interface IntervalDef { value: string; labelKey: string; needsTime: boolean; needsWeekday: boolean; needsMonthday: boolean }
const INTERVALS: IntervalDef[] = [
  { value: 'daily', labelKey: 'sc.daily', needsTime: true, needsWeekday: false, needsMonthday: false },
  { value: 'weekly', labelKey: 'sc.weekly', needsTime: true, needsWeekday: true, needsMonthday: false },
  { value: 'monthly', labelKey: 'sc.monthly', needsTime: true, needsWeekday: false, needsMonthday: true },
  { value: 'every_6h', labelKey: 'sc.every6h', needsTime: false, needsWeekday: false, needsMonthday: false },
  { value: 'every_12h', labelKey: 'sc.every12h', needsTime: false, needsWeekday: false, needsMonthday: false },
];
const WEEKDAYS = [
  { value: 1, labelKey: 'sc.mon' }, { value: 2, labelKey: 'sc.tue' }, { value: 3, labelKey: 'sc.wed' },
  { value: 4, labelKey: 'sc.thu' }, { value: 5, labelKey: 'sc.fri' }, { value: 6, labelKey: 'sc.sat' },
  { value: 0, labelKey: 'sc.sun' },
];

function cronToSelectors(cron: string) {
  if (cron === '0 */6 * * *') return { interval: 'every_6h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  if (cron === '0 */12 * * *') return { interval: 'every_12h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const mo = cron.match(/^(\d+) (\d+) (\d+) \* \*$/);
  if (mo) return { interval: 'monthly', minute: +mo[1], hour: +mo[2], weekday: 1, monthday: +mo[3] };
  const d = cron.match(/^(\d+) (\d+) \* \* \*$/);
  if (d) return { interval: 'daily', minute: +d[1], hour: +d[2], weekday: 1, monthday: 1 };
  const w = cron.match(/^(\d+) (\d+) \* \* (\d+)$/);
  if (w) return { interval: 'weekly', minute: +w[1], hour: +w[2], weekday: +w[3], monthday: 1 };
  return { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
}

function selectorsToCron(iv: string, h: number, m: number, wd: number, md: number) {
  switch (iv) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekly': return `${m} ${h} * * ${wd}`;
    case 'monthly': return `${m} ${h} ${md} * *`;
    case 'every_6h': return `${m} */6 * * *`;
    case 'every_12h': return `${m} */12 * * *`;
    default: return `${m} ${h} * * *`;
  }
}

function useCronLabel() {
  const { t } = useTranslation();
  return useCallback((cron: string) => {
    const { interval, hour, minute, weekday, monthday } = cronToSelectors(cron);
    const iv = INTERVALS.find(i => i.value === interval);
    if (!iv) return cron;
    const lbl = t(iv.labelKey);
    if (!iv.needsTime) return lbl;
    const ts = `${String(hour).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;
    if (interval === 'weekly') { const wd2 = WEEKDAYS.find(w2 => w2.value === weekday); return `${lbl} (${wd2 ? t(wd2.labelKey) : weekday}), ${ts}`; }
    if (interval === 'monthly') return `${lbl} (${monthday}.), ${ts}`;
    return `${lbl}, ${ts}`;
  }, [t]);
}

function fmtDate(d?: string) {
  if (!d) return '';
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

// ── Collapsed categories persistence ─────────────────────────────────────────

const COLLAPSED_KEY = 'shipyard.ui.playbooks.collapsedCategories';
function loadCollapsed(): Set<string> {
  try { const r = localStorage.getItem(COLLAPSED_KEY); if (!r) return new Set(); const a = JSON.parse(r); return Array.isArray(a) ? new Set(a.filter((v: unknown) => typeof v === 'string')) : new Set(); } catch { return new Set(); }
}
function saveCollapsed(s: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s])); } catch { /* */ }
}

const TEMPLATE_YAML = `---
- name: My New Playbook
  hosts: all
  become: yes
  tasks:
    - name: Ping all hosts
      ping:
`;

// ═════════════════════════════════════════════════════════════════════════════
// Main page
// ═════════════════════════════════════════════════════════════════════════════

export function PlaybooksPage() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const navigate = useNavigate();

  const tabs: { value: string; label: string; icon: React.ReactNode; cap?: string }[] = [
    { value: 'templates', label: t('pb.tabTemplates'), icon: <FileText className="h-4 w-4" /> },
    { value: 'run', label: t('pb.tabRun'), icon: <Play className="h-4 w-4" />, cap: 'canRunPlaybooks' },
    { value: 'vars', label: t('pb.tabVars'), icon: <SlidersHorizontal className="h-4 w-4" />, cap: 'canViewVars' },
    { value: 'schedules', label: t('pb.tabSchedules'), icon: <Clock className="h-4 w-4" />, cap: 'canViewSchedules' },
    { value: 'history', label: t('pb.tabHistory'), icon: <History className="h-4 w-4" />, cap: 'canViewAudit' },
  ];
  const allowed = tabs.filter(tb => !tb.cap || hasCap(profile, tb.cap));
  const [tab, setTab] = useState(allowed[0]?.value ?? 'templates');

  // Ensure tab is still allowed after profile changes
  useEffect(() => { if (!allowed.find(a => a.value === tab)) setTab(allowed[0]?.value ?? 'templates'); }, [allowed, tab]);

  return (
    <div className="space-y-4">
      {/* Header + Git widget */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('pb.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('pb.subtitle')}</p>
        </div>
        <GitWidget onGoSettings={() => navigate({ to: '/settings' })} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {allowed.map(tb => (
            <TabsTrigger key={tb.value} value={tb.value} className="gap-1.5">
              {tb.icon} {tb.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="templates"><TemplatesTab /></TabsContent>
        <TabsContent value="run"><QuickRunTab /></TabsContent>
        <TabsContent value="vars"><VarsTab /></TabsContent>
        <TabsContent value="schedules"><SchedulesTab /></TabsContent>
        <TabsContent value="history"><HistoryTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Git Widget
// ═════════════════════════════════════════════════════════════════════════════

function GitWidget({ onGoSettings }: { onGoSettings: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: cfg } = useQuery({ queryKey: ['gitConfig'], queryFn: () => api.getGitConfig() as Promise<Record<string, unknown>> });
  const branch = (cfg?.branch as string) || 'main';
  const configured = !!cfg?.repoUrl;

  const pullMut = useMutation({
    mutationFn: () => api.gitPull(),
    onSuccess: () => { showToast(t('git.pulled'), 'success'); qc.invalidateQueries({ queryKey: ['playbooks'] }); },
    onError: (e: Error) => showToast(t('git.pullFailed', { msg: e.message }), 'error'),
  });
  const pushMut = useMutation({
    mutationFn: () => api.gitPush(),
    onSuccess: () => showToast(t('git.pushed'), 'success'),
    onError: (e: Error) => showToast(t('git.pushFailed', { msg: e.message }), 'error'),
  });

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" />
        <span>{configured ? branch : t('git.notConfigured')}</span>
      </div>
      <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => pullMut.mutate()} disabled={pullMut.isPending} title={t('git.pullRemote')}>
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
      <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => pushMut.mutate()} disabled={pushMut.isPending} title={t('git.pushRemote')}>
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button variant="outline" size="icon" className="h-7 w-7" onClick={onGoSettings} title={t('git.settings')}>
        <Settings2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Templates (split-pane: list + editor/run)
// ═════════════════════════════════════════════════════════════════════════════

function TemplatesTab() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const theme = useUi(s => s.theme);
  const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'editor' | 'run'>('none');
  const [content, setContent] = useState('');
  const [origContent, setOrigContent] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [filenameInput, setFilenameInput] = useState('');
  const [runFilename, setRunFilename] = useState('');
  const [runDescription, setRunDescription] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const { data: playbooks } = useQuery<Playbook[]>({
    queryKey: ['playbooks'],
    queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]>,
  });

  // Fetch content when selecting existing playbook
  const { data: pbData } = useQuery({
    queryKey: ['playbook', selected],
    queryFn: () => api.getPlaybook(selected!),
    enabled: !!selected && !isNew,
  });
  useEffect(() => {
    if (pbData?.content !== undefined && !isNew) {
      setContent(pbData.content);
      setOrigContent(pbData.content);
    }
  }, [pbData?.content, isNew]);

  const dirty = content !== origContent;
  const selectedPb = playbooks?.find(p => p.filename === selected);

  // Grouped + filtered
  const grouped = useMemo(() => {
    const list = playbooks ?? [];
    const q = filter.trim().toLowerCase();
    const f = q ? list.filter(p =>
      p.filename.toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q) ||
      (p.category ?? '').toLowerCase().includes(q)
    ) : list;
    const user = f.filter(p => !p.isInternal);
    const internal = f.filter(p => !!p.isInternal);
    const catMap: Record<string, Playbook[]> = {};
    user.forEach(p => { const c = p.category || t('pb.custom'); (catMap[c] ??= []).push(p); });
    return { catMap, internal };
  }, [playbooks, filter, t]);

  const toggleCat = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  // Select existing playbook for editing
  const selectPb = (filename: string, isInternal: boolean) => {
    setSelected(filename);
    setIsNew(false);
    setPanel('editor');
    setFilenameInput(filename.replace(/\.ya?ml$/, ''));
    void isInternal;
  };

  // Open run panel from list
  const openRun = (filename: string, desc: string) => {
    setSelected(filename);
    setRunFilename(filename);
    setRunDescription(desc);
    setPanel('run');
  };

  // New playbook
  const startNew = () => {
    setSelected(null);
    setIsNew(true);
    setFilenameInput('');
    setContent(TEMPLATE_YAML);
    setOrigContent('');
    setPanel('editor');
  };

  // Save
  const saveMut = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      const fn = selected || (filenameInput.trim() + '.yml');
      if (!fn.trim()) throw new Error(t('pb.needFilename'));
      if (!content.trim()) throw new Error(t('pb.needContent'));
      return api.savePlaybook(fn, content) as unknown as Promise<Record<string, unknown>>;
    },
    onSuccess: (res: Record<string, unknown>) => {
      const fn = (res as { filename?: string }).filename ?? selected ?? filenameInput.trim() + '.yml';
      showToast(t('pb.saved', { name: fn }), 'success');
      setSelected(fn);
      setIsNew(false);
      setOrigContent(content);
      qc.invalidateQueries({ queryKey: ['playbooks'] });
      qc.invalidateQueries({ queryKey: ['playbook', fn] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // Delete
  const deleteMut = useMutation({
    mutationFn: () => api.deletePlaybook(selected!),
    onSuccess: () => {
      showToast(t('pb.deleted', { name: selected }), 'success');
      setPanel('none');
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['playbooks'] });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const closePanel = () => { setPanel('none'); setSelected(null); };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      {/* ── List panel ─────────────────────────── */}
      <Card className="lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto">
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">{t('pb.title')}</span>
            {hasCap(profile, 'canEditPlaybooks') && (
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={startNew} title={t('pb.new')}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="relative px-3 py-2">
            <Search className="pointer-events-none absolute left-5 top-4 h-4 w-4 text-muted-foreground" />
            <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('common.search')} className="pl-8 h-8 text-sm" />
          </div>
          <div className="px-1 pb-2">
            {Object.keys(grouped.catMap).sort().map(cat => {
              const key = `user:${cat}`;
              const open = !collapsed.has(key);
              return (
                <div key={key}>
                  <button onClick={() => toggleCat(key)} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50">
                    <ChevronDown className={`h-3 w-3 transition ${open ? '' : '-rotate-90'}`} />
                    <Folder className="h-3 w-3" />
                    <span className="flex-1 text-left">{cat}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{grouped.catMap[cat].length}</Badge>
                  </button>
                  {open && grouped.catMap[cat].map(p => (
                    <PlaybookListItem key={p.filename} p={p} active={selected === p.filename}
                      onSelect={() => selectPb(p.filename, false)}
                      onRun={hasCap(profile, 'canRunPlaybooks') ? () => openRun(p.filename, p.description ?? p.filename) : undefined}
                    />
                  ))}
                </div>
              );
            })}
            {grouped.internal.length > 0 && (() => {
              const key = `internal:${t('pb.internal')}`;
              const open = !collapsed.has(key);
              return (
                <div>
                  <button onClick={() => toggleCat(key)} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50">
                    <ChevronDown className={`h-3 w-3 transition ${open ? '' : '-rotate-90'}`} />
                    <FolderCog className="h-3 w-3" />
                    <span className="flex-1 text-left">{t('pb.internal')}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{grouped.internal.length}</Badge>
                  </button>
                  {open && grouped.internal.map(p => (
                    <PlaybookListItem key={p.filename} p={p} active={selected === p.filename}
                      onSelect={() => selectPb(p.filename, true)} />
                  ))}
                </div>
              );
            })()}
            {Object.keys(grouped.catMap).length === 0 && grouped.internal.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">{t('pb.noPlaybooks')}</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Right panel ────────────────────────── */}
      {panel === 'none' && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <Terminal className="h-8 w-8" />
            <h3 className="font-medium">{t('pb.noPlaybooks')}</h3>
            <p className="text-sm">{t('pb.selectHint')}</p>
          </CardContent>
        </Card>
      )}

      {panel === 'editor' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            {/* Editor header */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{isNew ? t('pb.new') : (selected ?? '')}</span>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="outline" size="sm" className="lg:hidden" onClick={closePanel}>
                  <ArrowLeft className="h-4 w-4" /> {t('common.back')}
                </Button>
                {!isNew && !selectedPb?.isInternal && (
                  <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
                    <History className="h-4 w-4" /> {t('pb.history')}
                  </Button>
                )}
                {!isNew && !selectedPb?.isInternal && hasCap(profile, 'canDeletePlaybooks') && (
                  <Button variant="destructive" size="sm" onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={closePanel}>{t('common.cancel')}</Button>
                {hasCap(profile, 'canEditPlaybooks') && (
                  <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                    <Save className="h-4 w-4" /> {t('common.save')}
                  </Button>
                )}
              </div>
            </div>
            {/* Filename field (hidden for internal) */}
            {!selectedPb?.isInternal && (
              <div className="space-y-1">
                <Label>{t('pb.filename')}</Label>
                <Input value={filenameInput} onChange={e => setFilenameInput(e.target.value)}
                  placeholder={t('pb.filenamePlaceholder')} className="font-mono text-sm" disabled={!isNew && !!selected} />
              </div>
            )}
            <div className="space-y-1">
              <Label>{t('pb.yaml')}</Label>
              <div className="overflow-hidden rounded-md border">
                <CodeMirror value={content} onChange={setContent} extensions={[yaml()]}
                  theme={isDark ? 'dark' : 'light'} height="calc(100vh - 22rem)"
                  basicSetup={{ lineNumbers: true, highlightActiveLine: true }} />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {panel === 'run' && (
        <TemplateRunPanel filename={runFilename} description={runDescription} onClose={closePanel} />
      )}

      {/* History dialog */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <PlaybookHistoryDialog filename={selected ?? ''} onRestore={(c: string) => { setContent(c); setHistoryOpen(false); }} />
      </Dialog>
    </div>
  );
}

function PlaybookListItem({ p, active, onSelect, onRun }: {
  p: Playbook; active: boolean; onSelect: () => void; onRun?: () => void;
}) {
  return (
    <div className={`group flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm cursor-pointer transition ${active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
      onClick={onSelect}>
      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={p.filename}>{p.description || p.filename}</span>
      {onRun && (
        <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={e => { e.stopPropagation(); onRun(); }} title="Run">
          <Play className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

// ── Template Run Panel (right side of Templates tab) ─────────────────────────

function TemplateRunPanel({ filename, description, onClose }: { filename: string; description: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const servers = useQuery<Record<string, unknown>[]>({ queryKey: ['servers'], queryFn: () => api.getServers() as unknown as Promise<Record<string, unknown>[]> });
  const srvList = servers.data ?? [];

  const [target, setTarget] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; cls: string }[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const addLine = (text: string, cls: string) => { setLines(prev => [...prev, { text, cls }]); };
  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [lines]);

  const run = async () => {
    if (!target) { showToast(t('run.needTarget'), 'warning'); return; }
    setBusy(true);
    setShowOutput(true);
    setLines([]);
    const finalTarget = target === 'all' ? buildAllExceptTargets([...excluded]) : target;
    try {
      const res = await api.runPlaybook(filename, finalTarget, {}) as unknown as { historyId?: string };
      addLine(t('pb.started'), 'text-green-500');
      if (res?.historyId) {
        const unsub = ws.subscribe((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          if (m.historyId !== res.historyId) return;
          if (m.type === 'ansible_output') addLine(String(m.data ?? ''), m.stream === 'stderr' ? 'text-red-400' : '');
          else if (m.type === 'ansible_complete') { addLine(m.success ? t('ws.completed') : t('ws.failed'), m.success ? 'text-green-500' : 'text-red-400'); unsub(); setBusy(false); }
          else if (m.type === 'ansible_error') { addLine(t('ws.error', { msg: String(m.error ?? '') }), 'text-red-400'); unsub(); setBusy(false); }
        });
        ws.connect();
      } else { setBusy(false); }
    } catch (e: unknown) { addLine((e as Error).message, 'text-red-400'); setBusy(false); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Play className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{description || filename}</span>
          </div>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" className="lg:hidden" onClick={onClose}><ArrowLeft className="h-4 w-4" /> {t('common.back')}</Button>
            <Button variant="outline" size="sm" onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label>{t('pb.target')}</Label>
          <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">{t('run.selectTarget')}</option>
            <option value="all">{t('pb.allServers')}</option>
            {srvList.map(s => <option key={String(s.name)} value={String(s.name)}>{String(s.name)}</option>)}
            <option value="localhost">localhost</option>
          </select>
        </div>

        {target === 'all' && (
          <div className="space-y-1">
            <Label>{t('run.excludeServers')}</Label>
            <p className="text-xs text-muted-foreground">{t('run.excludeHint')}</p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {srvList.map(s => {
                const nm = String(s.name);
                return (
                  <label key={nm} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={excluded.has(nm)} onChange={e => {
                      setExcluded(prev => { const n = new Set(prev); if (e.target.checked) n.add(nm); else n.delete(nm); return n; });
                    }} />
                    <span>{nm}</span>
                    <Badge variant={s.status === 'online' ? 'default' : 'secondary'} className="ml-auto text-[10px]">
                      {s.status === 'online' ? t('common.online') : t('common.offline')}
                    </Badge>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <Button onClick={run} disabled={busy}>
          <Play className="h-4 w-4" /> {busy ? t('run.starting') : t('common.run')}
        </Button>

        {showOutput && (
          <div className="rounded-md border bg-muted/30">
            <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{t('pb.output')}</div>
            <div ref={bodyRef} className="max-h-72 overflow-y-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {lines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Quick Run
// ═════════════════════════════════════════════════════════════════════════════

function QuickRunTab() {
  const { t } = useTranslation();
  const { data: playbooks } = useQuery<Playbook[]>({ queryKey: ['playbooks'], queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]> });
  const servers = useQuery<Record<string, unknown>[]>({ queryKey: ['servers'], queryFn: () => api.getServers() as unknown as Promise<Record<string, unknown>[]> });
  const srvList = servers.data ?? [];
  const userPbs = (playbooks ?? []).filter(p => !p.isInternal);

  const [selPb, setSelPb] = useState('');
  const [allChecked, setAllChecked] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [extraVars, setExtraVars] = useState('');
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; cls: string }[]>([]);
  const [started, setStarted] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const addLine = (text: string, cls: string) => { setLines(prev => [...prev, { text, cls }]); };
  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [lines]);

  const toggleServer = (name: string) => {
    setChecked(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  const run = async () => {
    if (!selPb) { showToast(t('qr.selectPlaybook'), 'warning'); return; }
    let targets: string;
    if (allChecked) {
      const excl = [...checked].filter(v => v !== 'localhost');
      targets = buildAllExceptTargets(excl);
    } else {
      if (checked.size === 0) { showToast(t('run.needTarget'), 'warning'); return; }
      targets = [...checked].join(',');
    }
    let ev: Record<string, unknown> = {};
    if (extraVars.trim()) {
      try { ev = JSON.parse(extraVars); } catch { showToast(t('run.invalidJson'), 'error'); return; }
    }
    setBusy(true);
    setStarted(true);
    setLines([]);
    try {
      const res = await api.runPlaybook(selPb, targets, ev) as unknown as { historyId?: string };
      addLine(t('pb.started'), 'text-green-500');
      if (res?.historyId) {
        const unsub = ws.subscribe((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          if (m.historyId !== res.historyId) return;
          if (m.type === 'ansible_output') addLine(String(m.data ?? ''), m.stream === 'stderr' ? 'text-red-400' : '');
          else if (m.type === 'ansible_complete') { addLine(m.success ? t('ws.completed') : t('ws.failed'), m.success ? 'text-green-500' : 'text-red-400'); unsub(); setBusy(false); }
          else if (m.type === 'ansible_error') { addLine(t('ws.error', { msg: String(m.error ?? '') }), 'text-red-400'); unsub(); setBusy(false); }
        });
        ws.connect();
      } else { setBusy(false); }
    } catch (e: unknown) { addLine((e as Error).message, 'text-red-400'); setBusy(false); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Left: form */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Play className="h-4 w-4" /> {t('qr.title')}
          </div>
          <div className="space-y-1">
            <Label>{t('run.playbook')}</Label>
            <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" value={selPb} onChange={e => setSelPb(e.target.value)}>
              <option value="">{t('qr.selectPlaybook')}</option>
              {userPbs.map(p => <option key={p.filename} value={p.filename}>{p.description || p.filename}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t('qr.targets')}</Label>
            <p className="text-xs text-muted-foreground">{allChecked ? t('run.excludeHint') : t('run.includeHint')}</p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={allChecked} onChange={e => { setAllChecked(e.target.checked); setChecked(new Set()); }} />
                {t('pb.allServers')}
              </label>
              <Separator />
              {srvList.map(s => {
                const nm = String(s.name);
                const dis = allChecked && nm === 'localhost';
                return (
                  <label key={nm} className={`flex items-center gap-2 text-sm ${dis ? 'opacity-50' : ''}`}>
                    <input type="checkbox" disabled={dis} checked={checked.has(nm)} onChange={() => toggleServer(nm)} />
                    <span>{nm}</span>
                    <Badge variant={s.status === 'online' ? 'default' : 'secondary'} className="ml-auto text-[10px]">
                      {s.status === 'online' ? t('common.online') : t('common.offline')}
                    </Badge>
                  </label>
                );
              })}
              <label className={`flex items-center gap-2 text-sm ${allChecked ? 'opacity-50' : ''}`}>
                <input type="checkbox" disabled={allChecked} checked={checked.has('localhost')} onChange={() => toggleServer('localhost')} />
                <span>localhost</span>
              </label>
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('qr.extraVars')} <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input value={extraVars} onChange={e => setExtraVars(e.target.value)} placeholder='{"key": "value"}' className="font-mono text-sm" />
          </div>
          <Button onClick={run} disabled={busy}>
            <Play className="h-4 w-4" /> {busy ? t('qr.running') : t('qr.run')}
          </Button>
        </CardContent>
      </Card>

      {/* Right: output */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Terminal className="h-4 w-4" /> {t('pb.output')}
          </div>
          {!started ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground text-sm">
              <Play className="h-6 w-6" />
              {t('pb.quickRunPlaceholder')}
            </div>
          ) : (
            <div ref={bodyRef} className="max-h-[calc(100vh-20rem)] overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {lines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Variables
// ═════════════════════════════════════════════════════════════════════════════

function VarsTab() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const { data: vars, isLoading } = useQuery<AnsibleVar[]>({
    queryKey: ['ansibleVars'],
    queryFn: () => api.getAnsibleVars() as unknown as Promise<AnsibleVar[]>,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [desc, setDesc] = useState('');

  const openNew = () => { setEditId(null); setKey(''); setValue(''); setDesc(''); setFormOpen(true); };
  const openEdit = (v: AnsibleVar) => { setEditId(v.id); setKey(v.key); setValue(v.value); setDesc(v.description ?? ''); setFormOpen(true); };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!key.trim() || !value) throw new Error(t('common.error'));
      if (editId) return api.updateAnsibleVar(editId, { key, value, description: desc });
      return api.createAnsibleVar({ key, value, description: desc });
    },
    onSuccess: () => { showToast(t('vars.saved'), 'success'); setFormOpen(false); qc.invalidateQueries({ queryKey: ['ansibleVars'] }); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteAnsibleVar(id),
    onSuccess: () => { showToast(t('vars.deleted'), 'success'); qc.invalidateQueries({ queryKey: ['ansibleVars'] }); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="h-4 w-4" /> {t('vars.title')}
            </div>
            {hasCap(profile, 'canAddVars') && (
              <Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> {t('vars.add')}</Button>
            )}
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('pb.loading')}</p>
          ) : !vars || vars.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('vars.noVars')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">{t('vars.key')}</th>
                    <th className="py-2 pr-4 font-medium">{t('vars.value')}</th>
                    <th className="py-2 pr-4 font-medium">{t('vars.description')}</th>
                    <th className="py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {vars.map(v => (
                    <tr key={v.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs font-medium">{v.key}</td>
                      <td className="py-2 pr-4 font-mono text-xs max-w-[200px] truncate">{v.value}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{v.description}</td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {hasCap(profile, 'canEditVars') && (
                            <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => openEdit(v)}><Settings2 className="h-3.5 w-3.5" /></Button>
                          )}
                          {hasCap(profile, 'canDeleteVars') && (
                            <Button variant="destructive" size="icon" className="h-7 w-7" onClick={() => delMut.mutate(v.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {formOpen && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {editId ? <Settings2 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editId ? t('vars.edit') : t('vars.add')}
            </div>
            <div className="space-y-1">
              <Label>{t('vars.key')}</Label>
              <Input value={key} onChange={e => setKey(e.target.value)} placeholder="my_variable" className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground">{t('vars.keyHint')}</p>
            </div>
            <div className="space-y-1">
              <Label>{t('vars.value')}</Label>
              <Input value={value} onChange={e => setValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t('vars.description')}</Label>
              <Input value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setFormOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                <Save className="h-4 w-4" /> {t('common.save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Schedules
// ═════════════════════════════════════════════════════════════════════════════

function SchedulesTab() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const cronLabel = useCronLabel();
  const { data: schedules, isLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.getSchedules() as unknown as Promise<Schedule[]>,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const toggleMut = useMutation({
    mutationFn: (id: string) => api.toggleSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => { showToast(t('sc.deleted'), 'success'); qc.invalidateQueries({ queryKey: ['schedules'] }); },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const openNew = () => { setEditId(null); setDialogOpen(true); };
  const openEdit = (id: string) => { setEditId(id); setDialogOpen(true); };

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Clock className="h-4 w-4" /> {t('pb.schedules')}
            </div>
            {hasCap(profile, 'canAddSchedules') && (
              <Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> {t('pb.newSchedule')}</Button>
            )}
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('pb.loading')}</p>
          ) : !schedules || schedules.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('sc.noSchedules')}</p>
          ) : (
            <div className="space-y-2">
              {schedules.map(s => (
                <div key={s.id} className="flex items-center gap-3 rounded-md border p-3">
                  {hasCap(profile, 'canToggleSchedules') && (
                    <Switch checked={s.enabled} onCheckedChange={() => toggleMut.mutate(s.id)} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{s.name}</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                      <span className="flex items-center gap-1"><Terminal className="h-3 w-3" />{s.playbook}</span>
                      <span className="flex items-center gap-1"><Play className="h-3 w-3" />{s.targets || 'all'}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{cronLabel(s.cron_expression)}</span>
                      {s.last_run && (
                        <span>
                          <Badge variant={s.last_status === 'success' ? 'default' : 'destructive'} className="text-[10px]">{s.last_status}</Badge>
                          {' '}<span className="opacity-70">{fmtDate(s.last_run)}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {hasCap(profile, 'canEditSchedules') && (
                      <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => openEdit(s.id)}><Settings2 className="h-3.5 w-3.5" /></Button>
                    )}
                    {hasCap(profile, 'canDeleteSchedules') && (
                      <Button variant="destructive" size="icon" className="h-7 w-7" onClick={() => delMut.mutate(s.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <ScheduleDialog editId={editId} schedules={schedules ?? []} onSaved={() => { setDialogOpen(false); qc.invalidateQueries({ queryKey: ['schedules'] }); }} />
      </Dialog>
    </>
  );
}

// ── Schedule Dialog ──────────────────────────────────────────────────────────

function ScheduleDialog({ editId, schedules, onSaved }: { editId: string | null; schedules: Schedule[]; onSaved: () => void }) {
  const { t } = useTranslation();
  const existing = editId ? schedules.find(s => s.id === editId) : null;
  const { data: playbooks } = useQuery<Playbook[]>({ queryKey: ['playbooks'], queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]> });
  const servers = useQuery<Record<string, unknown>[]>({ queryKey: ['servers'], queryFn: () => api.getServers() as unknown as Promise<Record<string, unknown>[]> });
  const srvList = servers.data ?? [];
  const userPbs = (playbooks ?? []).filter(p => !p.isInternal);

  const parsed = existing ? cronToSelectors(existing.cron_expression) : { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const parsedTargets = parsePlaybookTargets(existing?.targets ?? 'all');

  const [name, setName] = useState(existing?.name ?? '');
  const [playbook, setPlaybook] = useState(existing?.playbook ?? '');
  const [allChecked, setAllChecked] = useState(parsedTargets.mode === 'all');
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (parsedTargets.mode === 'all') return new Set(parsedTargets.excluded);
    return new Set(parsedTargets.included);
  });
  const [interval, setInterval2] = useState(parsed.interval);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [weekday, setWeekday] = useState(parsed.weekday);
  const [monthday, setMonthday] = useState(parsed.monthday);
  const [busy, setBusy] = useState(false);

  const iv = INTERVALS.find(i => i.value === interval);

  const toggleSrv = (nm: string) => {
    setChecked(prev => { const n = new Set(prev); if (n.has(nm)) n.delete(nm); else n.add(nm); return n; });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !playbook) { showToast(t('sc.required'), 'error'); return; }
    const targets = allChecked
      ? buildAllExceptTargets([...checked].filter(v => v !== 'all' && v !== 'localhost'))
      : [...checked].filter(v => v !== 'all').join(',') || 'all';
    const md = Math.min(28, Math.max(1, monthday));
    const cronExpression = selectorsToCron(interval, hour, minute, weekday, md);
    setBusy(true);
    try {
      if (existing) {
        await api.updateSchedule(existing.id, { name, playbook, targets, cronExpression });
        showToast(t('sc.updated'), 'success');
      } else {
        await api.createSchedule({ name, playbook, targets, cronExpression });
        showToast(t('sc.created'), 'success');
      }
      onSaved();
    } catch (err: unknown) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{existing ? t('sc.editTitle') : t('sc.newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-3">
          <div className="space-y-1">
            <Label>{t('sc.name')}</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('sc.namePlaceholder')} required />
          </div>
          <div className="space-y-1">
            <Label>{t('sc.playbook')}</Label>
            <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" value={playbook} onChange={e => setPlaybook(e.target.value)} required>
              <option value="">{t('sc.selectPlaybook')}</option>
              {userPbs.map(p => <option key={p.filename} value={p.filename}>{p.description} ({p.filename})</option>)}
            </select>
          </div>

          {/* Target servers */}
          <div className="space-y-1">
            <Label>{t('sc.target')}</Label>
            <p className="text-xs text-muted-foreground">{allChecked ? t('run.excludeHint') : t('run.includeHint')}</p>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={allChecked} onChange={e => { setAllChecked(e.target.checked); setChecked(new Set()); }} />
                {t('pb.allServers')}
              </label>
              <Separator />
              {srvList.map(s => {
                const nm = String(s.name);
                return (
                  <label key={nm} className={`flex items-center gap-2 text-sm ${allChecked && nm === 'localhost' ? 'opacity-50' : ''}`}>
                    <input type="checkbox" disabled={allChecked && nm === 'localhost'} checked={checked.has(nm)} onChange={() => toggleSrv(nm)} />
                    <span>{nm}</span>
                  </label>
                );
              })}
              <label className={`flex items-center gap-2 text-sm ${allChecked ? 'opacity-50' : ''}`}>
                <input type="checkbox" disabled={allChecked} checked={checked.has('localhost')} onChange={() => toggleSrv('localhost')} />
                <span>localhost</span>
              </label>
            </div>
          </div>

          {/* Interval + time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t('sc.interval')}</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" value={interval} onChange={e => setInterval2(e.target.value)}>
                {INTERVALS.map(i => <option key={i.value} value={i.value}>{t(i.labelKey)}</option>)}
              </select>
            </div>
            {iv?.needsTime && (
              <div className="space-y-1">
                <Label>{t('sc.time')}</Label>
                <div className="flex items-center gap-1">
                  <select className="flex h-9 w-20 rounded-md border border-input bg-background px-2 py-1 text-sm" value={hour} onChange={e => setHour(+e.target.value)}>
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}</option>)}
                  </select>
                  <span className="text-muted-foreground">:</span>
                  <select className="flex h-9 w-20 rounded-md border border-input bg-background px-2 py-1 text-sm" value={minute} onChange={e => setMinute(+e.target.value)}>
                    {Array.from({ length: 12 }, (_, i) => i * 5).map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
          {iv?.needsWeekday && (
            <div className="space-y-1">
              <Label>{t('sc.weekday')}</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" value={weekday} onChange={e => setWeekday(+e.target.value)}>
                {WEEKDAYS.map(w => <option key={w.value} value={w.value}>{t(w.labelKey)}</option>)}
              </select>
            </div>
          )}
          {iv?.needsMonthday && (
            <div className="space-y-1">
              <Label>{t('sc.dayOfMonth')}</Label>
              <Input type="number" min={1} max={28} value={monthday} onChange={e => setMonthday(+e.target.value)} placeholder="1–28" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy}>{existing ? t('common.save') : t('common.create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: History
// ═════════════════════════════════════════════════════════════════════════════

function HistoryTab() {
  const { t } = useTranslation();
  const [filterSchedule, setFilterSchedule] = useState('');
  const [outputEntry, setOutputEntry] = useState<HistoryEntry | null>(null);

  const { data: schedules } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.getSchedules() as unknown as Promise<Schedule[]>,
  });
  const { data: history, isLoading } = useQuery<HistoryEntry[]>({
    queryKey: ['scheduleHistory', filterSchedule],
    queryFn: () => api.getScheduleHistory(100, filterSchedule || undefined) as unknown as Promise<HistoryEntry[]>,
  });

  const showOutput = async (id: string) => {
    try {
      const entry = await api.getScheduleHistoryEntry(id) as unknown as HistoryEntry;
      setOutputEntry(entry);
    } catch (e: unknown) { showToast((e as Error).message, 'error'); }
  };

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4" /> {t('hist.title')}
            </div>
            <select className="flex h-8 w-48 rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={filterSchedule} onChange={e => setFilterSchedule(e.target.value)}>
              <option value="">{t('hist.filterAll')}</option>
              {(schedules ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('pb.loading')}</p>
          ) : !history || history.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('hist.noHistory')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('hist.schedule')}</th>
                    <th className="py-2 pr-3 font-medium">{t('hist.playbook')}</th>
                    <th className="py-2 pr-3 font-medium">{t('hist.targets')}</th>
                    <th className="py-2 pr-3 font-medium">{t('hist.started')}</th>
                    <th className="py-2 pr-3 font-medium">{t('hist.status')}</th>
                    <th className="py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">
                        {h.schedule_id === null
                          ? <Badge variant="secondary" className="text-[10px]">{h.schedule_name}</Badge>
                          : h.schedule_name}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{h.playbook}</td>
                      <td className="py-2 pr-3 text-xs">{h.targets || 'all'}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{fmtDate(h.started_at)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={h.status === 'success' ? 'default' : h.status === 'running' ? 'secondary' : 'destructive'} className="text-[10px]">
                          {h.status === 'success' ? t('hist.success') : h.status === 'running' ? t('hist.running') : t('hist.failed')}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => showOutput(h.id)} title={t('hist.output')}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Output modal */}
      <Dialog open={!!outputEntry} onOpenChange={open => { if (!open) setOutputEntry(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{outputEntry?.schedule_name} — {outputEntry?.playbook}</DialogTitle>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30">
            <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{fmtDate(outputEntry?.started_at)}</div>
            <div className="max-h-96 overflow-y-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {outputEntry?.output || t('qr.noOutput')}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOutputEntry(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Playbook History Dialog
// ═════════════════════════════════════════════════════════════════════════════

function PlaybookHistoryDialog({ filename, onRestore }: { filename: string; onRestore: (content: string) => void }) {
  const { t } = useTranslation();
  const { data: versions, isLoading } = useQuery<PlaybookVersion[]>({
    queryKey: ['playbookHistory', filename],
    queryFn: () => api.getPlaybookHistory(filename) as unknown as Promise<PlaybookVersion[]>,
    enabled: !!filename,
  });
  const [previewVer, setPreviewVer] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const loadPreview = async (v: number) => {
    if (previewVer === v) { setPreviewVer(null); setPreviewContent(null); return; }
    setPreviewVer(v);
    setPreviewLoading(true);
    try {
      const data = await api.getPlaybookVersion(filename, v) as unknown as { content: string };
      setPreviewContent(data.content);
    } catch (e: unknown) { setPreviewContent((e as Error).message); }
    finally { setPreviewLoading(false); }
  };

  const restoreMut = useMutation({
    mutationFn: (v: number) => api.restorePlaybook(filename, v),
    onSuccess: async () => {
      showToast(t('pb.restored'), 'success');
      try {
        const data = await api.getPlaybook(filename);
        onRestore(data.content);
      } catch { /* */ }
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('pb.historyTitle')}</DialogTitle>
      </DialogHeader>
      <div className="max-h-96 space-y-2 overflow-y-auto py-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('pb.loading')}</p>
        ) : !versions || versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pb.noHistory')}</p>
        ) : versions.map(v => (
          <div key={v.version} className="rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('pb.historyVersion', { n: v.version })}</div>
                <div className="text-xs text-muted-foreground">{fmtDate(v.modifiedAt)}</div>
              </div>
              <div className="flex gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => loadPreview(v.version)} title={t('pb.historyPreview')}>
                  <Eye className={`h-3.5 w-3.5 ${previewVer === v.version ? 'text-primary' : ''}`} />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => restoreMut.mutate(v.version)} disabled={restoreMut.isPending} title={t('pb.restore')}>
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {previewVer === v.version && (
              <div className="mt-2">
                {previewLoading ? (
                  <p className="text-xs text-muted-foreground">{t('pb.loading')}</p>
                ) : (
                  <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {previewContent}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </DialogContent>
  );
}
