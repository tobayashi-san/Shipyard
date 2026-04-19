import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft, RefreshCw, CircleDot, Cpu, HardDrive, MemoryStick, Clock,
  HeartPulse, Box, Satellite, Boxes, ExternalLink, Copy, Info,
  Terminal, Pencil, ArrowUp, Key, Power,
  Play, Square, CloudDownload, FileText, RotateCw, Plus, Trash2,
  ChevronDown, ChevronRight, Layers, Settings2, StickyNote, Eye, Bot,
  Download, Shield, Sliders, History,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useProfile, useSettings, hasCap } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { showToast } from '@/lib/toast';
import { SshTerminal } from '@/components/SshTerminal';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { PageHeader, SectionLabel } from '@/components/ui/page-header';
import { StatusBadge, LiveDot } from '@/components/ui/status-badge';
import { Skeleton, SkeletonRow } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { OverflowMenu, OverflowItem, OverflowSep } from '@/components/ui/overflow-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MetricBar, metricTextClass } from '@/components/ui/metric-bar';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ─── Types ────────────────────────────────────────────────────
interface ServerDetail {
  id: string;
  name: string;
  ip_address?: string;
  hostname?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: string;
  group_name?: string;
  tags?: string[];
  services?: string[];
  links?: { name: string; url: string }[];
  storage_mounts?: { name: string; path: string }[];
  notes?: string;
  [k: string]: unknown;
}

interface ServerInfo {
  os?: string;
  kernel?: string;
  cpu?: string;
  cpu_cores?: number;
  cpu_usage_pct?: number | null;
  uptime_seconds?: number;
  ram_used_mb?: number | null;
  ram_total_mb?: number | null;
  disk_used_gb?: number;
  disk_total_gb?: number;
  load_avg?: string;
  updates_count?: number;
  _cached?: boolean;
  storage_mount_metrics?: StorageMount[];
  zfs_pools?: ZfsPool[];
}

interface StorageMount {
  name?: string; path: string; filesystem?: string;
  used_gb?: number; total_gb?: number; usage_pct?: number;
}

interface ZfsPool {
  name: string; health: string; alloc_gb?: number; size_gb?: number; scrub?: string;
}

interface HistoryRow {
  id: string; action?: string; status?: string; started_at?: string; completed_at?: string;
  triggered_by?: string; playbook_name?: string; _type?: string;
}

interface ContainerRow {
  container_name: string; image: string; status?: string; state?: string;
  compose_project?: string; compose_working_dir?: string;
}

interface CustomTask {
  id: string; name: string; type?: string; github_repo?: string;
  check_command?: string; update_command?: string; trigger_output?: string; latest_command?: string;
  current_version?: string; last_version?: string; has_update?: boolean; last_checked_at?: string;
}

interface AgentStatus {
  installed?: boolean; mode?: string; lastSeen?: string; runnerVersion?: string;
  manifestVersion?: number; latestManifestVersion?: number; interval?: number;
  shipyardUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────
function formatUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(mb: number | null | undefined): string {
  if (mb == null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatDate(d?: string, hour12?: boolean): string {
  if (!d) return '—';
  const utc = !d.endsWith('Z') ? d.replace(' ', 'T') + 'Z' : d;
  try { return new Date(utc).toLocaleString(undefined, hour12 !== undefined ? { hour12 } : undefined); } catch { return d; }
}

function ThresholdBar({ pct }: { pct: number | null }) {
  return <MetricBar pct={pct} size="md" showTicks />;
}

function StatCard({ icon, label, value, hint, variant }: {
  icon: React.ReactNode; label: string; value: string; hint?: string;
  variant?: 'ok' | 'warning' | 'error' | 'muted';
}) {
  const valColor = variant === 'ok' ? 'text-emerald-500' : variant === 'warning' ? 'text-amber-500' : variant === 'error' ? 'text-destructive' : '';
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-md ${variant === 'ok' ? 'bg-emerald-500/10 text-emerald-500' : variant === 'warning' ? 'bg-amber-500/10 text-amber-500' : variant === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className={`truncate font-semibold ${valColor}`}>{value}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="icon" className="h-6 w-6"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); showToast(`${label} ${t('common.copied')}`, 'success'); }
        catch { showToast(t('common.error'), 'error'); }
      }}>
      <Copy className="h-3 w-3" />
    </Button>
  );
}

// ═══════════════════════════════════════════════════════════════
export function ServerDetailPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? '';
  const navigate = useNavigate();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmRunUpdate, setConfirmRunUpdate] = useState(false);
  const [confirmResetHostKey, setConfirmResetHostKey] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<CustomTask | null>(null);
  const [actionOutput, setActionOutput] = useState<{ title: string; lines: { text: string; cls?: string }[] } | null>(null);
  const { data: profile } = useProfile();
  const { data: settings } = useSettings();
  const agentEnabled = !!(settings as Record<string, unknown>)?.agentEnabled;
  const timeFormat = useUi((s) => s.timeFormat);
  const hour12 = timeFormat === '12h';

  // ── Data queries ────────────────────────────────────────────
  const { data: rawServer, isLoading } = useQuery({
    queryKey: ['server', id],
    queryFn: () => api.getServer(id) as unknown as Promise<ServerDetail>,
    enabled: !!id,
  });
  const server = useMemo(() => {
    if (!rawServer) return null;
    const s = rawServer as Record<string, unknown>;
    return {
      ...s,
      id: String(s.id),
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags as string) : s.tags || [],
      services: typeof s.services === 'string' ? JSON.parse(s.services as string) : s.services || [],
      links: typeof s.links === 'string' ? JSON.parse(s.links as string) : s.links || [],
      storage_mounts: typeof s.storage_mounts === 'string' ? JSON.parse(s.storage_mounts as string) : s.storage_mounts || [],
    } as ServerDetail;
  }, [rawServer]);

  const { data: info, refetch: refetchInfo, isFetching: fetchingInfo } = useQuery<ServerInfo>({
    queryKey: ['server', id, 'info'],
    queryFn: () => api.getServerInfo(id) as unknown as Promise<ServerInfo>,
    enabled: !!id,
  });

  // ── Stat card queries (lazy-ish but auto) ───────────────────
  const { data: dockerContainers, isFetching: fetchingDocker } = useQuery({
    queryKey: ['server', id, 'docker'],
    queryFn: () => api.getServerDocker(id) as unknown as Promise<ContainerRow[]>,
    enabled: !!id && hasCap(profile, 'canViewDocker'),
    staleTime: 60_000,
  });
  const { data: rawUpdates, isFetching: fetchingUpdates } = useQuery({
    queryKey: ['server', id, 'updates'],
    queryFn: () => api.getServerUpdates(id) as unknown as Promise<Record<string, unknown>[] | { updates: Record<string, unknown>[] }>,
    enabled: !!id && hasCap(profile, 'canViewUpdates'),
    staleTime: 60_000,
  });
  const { data: history } = useQuery({
    queryKey: ['server', id, 'history'],
    queryFn: () => api.getServerHistory(id) as unknown as Promise<HistoryRow[]>,
    enabled: !!id,
  });
  const { data: notesData } = useQuery({
    queryKey: ['server', id, 'notes'],
    queryFn: () => api.getServerNotes(id),
    enabled: !!id,
  });
  const { data: customTasks } = useQuery({
    queryKey: ['server', id, 'customTasks'],
    queryFn: () => api.getCustomUpdateTasks(id) as unknown as Promise<CustomTask[]>,
    enabled: !!id && hasCap(profile, 'canViewCustomUpdates'),
  });
  const { data: agentStatus, refetch: refetchAgent } = useQuery({
    queryKey: ['server', id, 'agent'],
    queryFn: () => api.getAgentStatus(id) as unknown as Promise<AgentStatus>,
    enabled: !!id && agentEnabled && profile?.role === 'admin',
    staleTime: 30_000,
  });

  // ── Image update cache ──────────────────────────────────────
  const [imageUpdates, setImageUpdates] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!id || !hasCap(profile, 'canViewDocker')) return;
    api.getCachedImageUpdates(id).then((r: unknown) => {
      const res = r as { results?: { image: string; status: string }[] };
      if (res?.results?.length) {
        const m: Record<string, string> = {};
        res.results.forEach(r => { m[r.image] = r.status; });
        setImageUpdates(m);
      }
    }).catch(() => {});
  }, [id, profile]);

  // ── Notes state ─────────────────────────────────────────────
  const [notes, setNotes] = useState('');
  const [notesEditing, setNotesEditing] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { if (notesData?.notes !== undefined) setNotes(notesData.notes); }, [notesData?.notes]);
  const saveNotesMut = useMutation({
    mutationFn: (text: string) => api.saveServerNotes(id, text),
    onSuccess: () => showToast(t('det.notesSaved'), 'success'),
    onError: () => showToast(t('det.notesError'), 'error'),
  });
  const autoSaveNotes = useCallback((text: string) => {
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => saveNotesMut.mutate(text), 800);
  }, [saveNotesMut]);

  // ── Mutations ───────────────────────────────────────────────
  const runUpdateMut = useMutation({
    mutationFn: () => api.runUpdate(id),
    onMutate: () => setActionOutput({ title: `${t('det.updates')} · ${server?.name || ''}`, lines: [{ text: t('det.updateStarted'), cls: 'text-green-500' }] }),
    onSuccess: () => { showToast(t('det.updateStarted'), 'success'); void qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (e: Error) => {
      setActionOutput(prev => prev ? { ...prev, lines: [...prev.lines, { text: t('common.errorPrefix', { msg: e.message }), cls: 'text-red-400' }] } : prev);
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    },
  });
  const runRebootMut = useMutation({
    mutationFn: () => api.runReboot(id),
    onSuccess: () => showToast(t('det.rebootStarted'), 'success'),
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const testConnMut = useMutation({
    mutationFn: () => api.testConnection(id),
    onSuccess: () => { showToast(t('det.reachable'), 'success'); void qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const resetHostKeyMut = useMutation({
    mutationFn: () => api.resetServerHostKey(id) as unknown as Promise<{ removed?: string[] }>,
    onSuccess: (r) => showToast(t('srv.resetHostKeyDone', { entries: r.removed?.join(', ') || t('srv.resetHostKeyNoEntries') }), 'success'),
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const deleteServerMut = useMutation({
    mutationFn: () => api.deleteServer(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void navigate({ to: '/servers' });
      showToast(t('srv.deleted'), 'success');
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const restartContainerMut = useMutation({
    mutationFn: (name: string) => api.restartContainer(id, name),
    onMutate: (name) => setActionOutput({ title: `${t('det.output')} · ${name}`, lines: [{ text: t('det.containerRestarted'), cls: 'text-green-500' }] }),
    onSuccess: () => { showToast(t('det.containerRestarted'), 'success'); setTimeout(() => qc.invalidateQueries({ queryKey: ['server', id, 'docker'] }), 3000); },
    onError: (e: Error) => {
      setActionOutput(prev => prev ? { ...prev, lines: [...prev.lines, { text: t('common.errorPrefix', { msg: e.message }), cls: 'text-red-400' }] } : prev);
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    },
  });

  // ── Container logs state ────────────────────────────────────
  const [logsContainer, setLogsContainer] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState('');
  const [logsTail, setLogsTail] = useState(200);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadLogs = useCallback(async (container: string, tail = 200) => {
    setLogsContainer(container);
    setLogsLoading(true);
    try {
      const r = await api.getContainerLogs(id, container, tail);
      setLogsContent((r as { logs: string }).logs || '');
    } catch (e) {
      setLogsContent(`Error: ${(e as Error).message}`);
    }
    setLogsLoading(false);
  }, [id]);

  // ── Custom task dialog ──────────────────────────────────────
  const [taskDialog, setTaskDialog] = useState<{ open: boolean; task: CustomTask | null }>({ open: false, task: null });
  const [taskForm, setTaskForm] = useState({ name: '', type: 'script', github_repo: '', check_command: '', update_command: '', trigger_output: '', latest_command: '' });

  useEffect(() => {
    if (taskDialog.open) {
      const t = taskDialog.task;
      setTaskForm({
        name: t?.name || '', type: t?.type || 'script', github_repo: t?.github_repo || '',
        check_command: t?.check_command || '', update_command: t?.update_command || '',
        trigger_output: t?.trigger_output || '', latest_command: t?.latest_command || '',
      });
    }
  }, [taskDialog]);

  const saveTaskMut = useMutation({
    mutationFn: async () => {
      const data = { ...taskForm, github_repo: taskForm.github_repo || null, trigger_output: taskForm.trigger_output || null, latest_command: taskForm.latest_command || null, check_command: taskForm.check_command || null };
      if (taskDialog.task) await api.updateCustomUpdateTask(id, taskDialog.task.id, data);
      else await api.createCustomUpdateTask(id, data);
    },
    onSuccess: () => { showToast(t('det.taskSaved'), 'success'); setTaskDialog({ open: false, task: null }); void qc.invalidateQueries({ queryKey: ['server', id, 'customTasks'] }); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const deleteTaskMut = useMutation({
    mutationFn: (taskId: string) => api.deleteCustomUpdateTask(id, taskId),
    onSuccess: () => { showToast(t('det.taskDeleted'), 'success'); void qc.invalidateQueries({ queryKey: ['server', id, 'customTasks'] }); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const checkTaskMut = useMutation({
    mutationFn: (taskId: string) => api.checkCustomUpdateTask(id, taskId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['server', id, 'customTasks'] }),
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const runTaskMut = useMutation({
    mutationFn: (taskId: string) => api.runCustomUpdateTask(id, taskId),
    onMutate: (taskId) => {
      const task = (customTasks ?? []).find(t2 => t2.id === taskId);
      setActionOutput({ title: `${t('det.output')} · ${task?.name || t('det.customUpdates')}`, lines: [{ text: t('det.runUpdateStarted', { name: task?.name || '' }), cls: 'text-green-500' }] });
    },
    onSuccess: () => showToast(t('det.runUpdateStarted', { name: '' }), 'success'),
    onError: (e: Error) => {
      setActionOutput(prev => prev ? { ...prev, lines: [...prev.lines, { text: t('common.errorPrefix', { msg: e.message }), cls: 'text-red-400' }] } : prev);
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    },
  });

  // ── Check image updates ─────────────────────────────────────
  const checkImageMut = useMutation({
    mutationFn: () => api.checkImageUpdates(id) as unknown as Promise<{ image: string; status: string }[]>,
    onSuccess: (results) => {
      const m: Record<string, string> = {};
      results.forEach(r => { m[r.image] = r.status; });
      setImageUpdates(m);
      void qc.invalidateQueries({ queryKey: ['server', id, 'docker'] });
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  // ── Compose actions ─────────────────────────────────────────
  const composeActionMut = useMutation({
    mutationFn: ({ dir, action }: { dir: string; action: string }) => api.composeAction(id, dir, action),
    onMutate: ({ dir, action }) => setActionOutput({ title: `${t('det.output')} · docker compose ${action}`, lines: [{ text: dir, cls: 'text-muted-foreground' }, { text: t('det.composeActionDone', { action }), cls: 'text-green-500' }] }),
    onSuccess: (_, { action }) => {
      showToast(t('det.composeActionDone', { action }), 'success');
      setTimeout(() => qc.invalidateQueries({ queryKey: ['server', id, 'docker'] }), 3000);
    },
    onError: (e: Error) => {
      setActionOutput(prev => prev ? { ...prev, lines: [...prev.lines, { text: t('common.errorPrefix', { msg: e.message }), cls: 'text-red-400' }] } : prev);
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    },
  });

  // ── Compose editor dialog ───────────────────────────────────
  const [composeDialog, setComposeDialog] = useState<{ open: boolean; mode: 'edit' | 'add'; dir: string; content: string; loading: boolean }>({ open: false, mode: 'add', dir: '', content: '', loading: false });

  const openEditCompose = useCallback(async (dir: string) => {
    setComposeDialog({ open: true, mode: 'edit', dir, content: '', loading: true });
    try {
      const r = await api.getDockerCompose(id, dir) as unknown as { content: string };
      setComposeDialog(prev => ({ ...prev, content: r.content || '', loading: false }));
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error');
      setComposeDialog(prev => ({ ...prev, loading: false }));
    }
  }, [id, t]);

  const saveComposeMut = useMutation({
    mutationFn: () => api.writeDockerCompose(id, composeDialog.dir, composeDialog.content),
    onSuccess: () => {
      showToast(t('det.composeSaved'), 'success');
      setComposeDialog(prev => ({ ...prev, open: false }));
      void qc.invalidateQueries({ queryKey: ['server', id, 'docker'] });
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  // ── Latency ping ────────────────────────────────────────────
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        try {
          await api.ping();
          times.push(performance.now() - start);
        } catch { /* ignore */ }
      }
      if (!cancelled && times.length > 0) {
        setLatencyMs(Math.round(times.reduce((a, b) => a + b, 0) / times.length));
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // ── Agent mutations ─────────────────────────────────────────
  const [agentUrl, setAgentUrl] = useState('');
  const [agentCa, setAgentCa] = useState('');
  useEffect(() => { if (agentStatus?.shipyardUrl) setAgentUrl(agentStatus.shipyardUrl); else setAgentUrl(window.location.origin); }, [agentStatus]);

  const agentInstallMut = useMutation({
    mutationFn: () => api.installAgent(id, { mode: 'push', interval: 30, shipyard_url: agentUrl, shipyard_ca_cert_pem: agentCa }),
    onSuccess: () => { showToast(t('det.agentInstallStarted'), 'success'); void refetchAgent(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const agentUpdateMut = useMutation({
    mutationFn: () => api.updateAgent(id),
    onSuccess: () => { showToast(t('det.agentUpdateStarted'), 'success'); void refetchAgent(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const agentConfigMut = useMutation({
    mutationFn: () => api.configureAgent(id, { mode: agentStatus?.mode || 'push', interval: agentStatus?.interval || 30, shipyard_url: agentUrl, shipyard_ca_cert_pem: agentCa }),
    onSuccess: () => { showToast(t('det.agentConfigureStarted'), 'success'); void refetchAgent(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const agentRotateMut = useMutation({
    mutationFn: () => api.rotateAgentToken(id, { shipyard_url: agentUrl, shipyard_ca_cert_pem: agentCa }),
    onSuccess: () => { showToast(t('det.agentTokenRotated'), 'success'); void refetchAgent(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const agentRemoveMut = useMutation({
    mutationFn: () => api.removeAgent(id),
    onSuccess: () => { showToast(t('det.agentRemoved'), 'success'); void refetchAgent(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });
  const agentBusy = agentInstallMut.isPending || agentUpdateMut.isPending || agentConfigMut.isPending || agentRotateMut.isPending || agentRemoveMut.isPending;

  // ── History pagination ──────────────────────────────────────
  const HIST_PAGE_SIZE = 25;
  const [histPage, setHistPage] = useState(1);
  const histItems = history ?? [];
  const histTotal = Math.max(1, Math.ceil(histItems.length / HIST_PAGE_SIZE));
  const histSafe = Math.min(histPage, histTotal);
  const histPage_ = histItems.slice((histSafe - 1) * HIST_PAGE_SIZE, histSafe * HIST_PAGE_SIZE);

  // ── Derived ─────────────────────────────────────────────────
  const ramPct = info?.ram_total_mb ? Math.round(((info.ram_used_mb ?? 0) / info.ram_total_mb) * 100) : null;
  const diskPct = info?.disk_total_gb ? Math.round(((info.disk_used_gb ?? 0) / info.disk_total_gb) * 100) : null;
  const cpuPct = info?.cpu_usage_pct ?? null;

  const updatesList = useMemo(() => {
    if (!rawUpdates) return [];
    const arr = Array.isArray(rawUpdates) ? rawUpdates : ((rawUpdates as Record<string, unknown>).updates as Record<string, unknown>[]) ?? [];
    return arr.filter((u: Record<string, unknown>) => !u.phased) as { package: string; version?: string; phased?: boolean; _cached?: boolean }[];
  }, [rawUpdates]);
  const phasedList = useMemo(() => {
    if (!rawUpdates) return [];
    const arr = Array.isArray(rawUpdates) ? rawUpdates : ((rawUpdates as Record<string, unknown>).updates as Record<string, unknown>[]) ?? [];
    return arr.filter((u: Record<string, unknown>) => u.phased) as { package: string; version?: string }[];
  }, [rawUpdates]);

  const containers = (dockerContainers ?? []) as ContainerRow[];
  const stacks = useMemo(() => {
    const map: Record<string, { dir: string; containers: ContainerRow[] }> = {};
    const standalone: ContainerRow[] = [];
    containers.forEach(c => {
      if (c.compose_project && c.compose_working_dir) {
        if (!map[c.compose_project]) map[c.compose_project] = { dir: c.compose_working_dir, containers: [] };
        map[c.compose_project].containers.push(c);
      } else standalone.push(c);
    });
    return { map, standalone };
  }, [containers]);

  // ── Loading / not found ─────────────────────────────────────
  if (isLoading) return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
  if (!server) return (
    <EmptyState
      icon={<ArrowLeft className="h-6 w-6" />}
      title={t('det.notFound')}
      action={<Button variant="secondary" size="sm" asChild><Link to="/servers"><ArrowLeft className="h-4 w-4 mr-1" />{t('common.back')}</Link></Button>}
    />
  );

  // ═══════════════════════════════════════════════════════════
  return (
    <div className="space-y-4">
      {/* ── Header ──────────────────────────────────────────── */}
      <PageHeader
        back={<Button variant="ghost" size="icon" onClick={() => navigate({ to: (sessionStorage.getItem('shipyard.lastNonDetailRoute') as '/' | '/servers' | '/playbooks' | '/settings' | '/profile' | null) ?? '/servers' })}><ArrowLeft className="h-4 w-4" /></Button>}
        title={server.name}
        badge={
          server.status === 'online' ? (
            <StatusBadge tone="success"><LiveDot tone="success" />{t('common.online')}</StatusBadge>
          ) : server.status === 'offline' ? (
            <StatusBadge tone="danger">{t('common.offline')}</StatusBadge>
          ) : (
            <StatusBadge tone="muted">{t('common.unknown')}</StatusBadge>
          )
        }
        description={`${server.ip_address}${server.hostname && server.hostname !== server.ip_address ? ` · ${server.hostname}` : ''}`}
        actions={
          <>
            {hasCap(profile, 'canUseTerminal') && (
              <Button size="sm" onClick={() => setTerminalOpen(true)}><Terminal className="h-3.5 w-3.5 mr-1" />{t('common.terminal')}</Button>
            )}
            <OverflowMenu width="w-52">
              {hasCap(profile, 'canEditServers') && (
                <>
                  <OverflowItem icon={Pencil} onClick={() => setEditOpen(true)}>
                    {t('common.edit')}
                  </OverflowItem>
                  <OverflowSep />
                </>
              )}
              {hasCap(profile, 'canRunUpdates') && (
                <OverflowItem icon={ArrowUp}
                  onClick={() => setConfirmRunUpdate(true)}>
                  {t('det.updates')}
                </OverflowItem>
              )}
              {hasCap(profile, 'canUseTerminal') && (
                <OverflowItem icon={Key} onClick={() => setConfirmResetHostKey(true)}>
                  {t('srv.resetHostKey')}
                </OverflowItem>
              )}
              {hasCap(profile, 'canRebootServers') && (
                <>
                  <OverflowSep />
                  <OverflowItem icon={Power} warning onClick={() => setConfirmReboot(true)}>
                    {t('det.reboot')}
                  </OverflowItem>
                </>
              )}
              {hasCap(profile, 'canDeleteServers') && (
                <>
                  <OverflowSep />
                  <OverflowItem icon={Trash2} danger onClick={() => setConfirmDelete(true)}>
                    {t('common.delete')}
                  </OverflowItem>
                </>
              )}
            </OverflowMenu>
            {hasCap(profile, 'canEditServers') && (
              <CreateServerDialog
                editServer={server}
                open={editOpen}
                onOpenChange={setEditOpen}
                onSuccess={() => { qc.invalidateQueries({ queryKey: ['server', id] }); }}
              />
            )}
            <ConfirmDialog
              open={confirmRunUpdate}
              onOpenChange={setConfirmRunUpdate}
              title={t('det.updates')}
              description={t('det.confirmUpdate', { name: server.name })}
              confirmLabel={t('det.updates')}
              onConfirm={() => runUpdateMut.mutate()}
              isPending={runUpdateMut.isPending}
            />
            <ConfirmDialog
              open={confirmResetHostKey}
              onOpenChange={setConfirmResetHostKey}
              title={t('srv.resetHostKeyConfirmTitle')}
              description={t('srv.resetHostKeyConfirmBody')}
              confirmLabel={t('srv.resetHostKeyConfirmText')}
              variant="destructive"
              onConfirm={() => resetHostKeyMut.mutate()}
              isPending={resetHostKeyMut.isPending}
            />
            <ConfirmDialog
              open={confirmReboot}
              onOpenChange={setConfirmReboot}
              title={t('det.reboot')}
              description={t('det.confirmReboot', { name: server.name })}
              confirmLabel={t('det.reboot')}
              variant="warning"
              onConfirm={() => runRebootMut.mutate()}
              isPending={runRebootMut.isPending}
            />
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={t('common.delete')}
              description={t('det.confirmDeleteServer', { name: server.name })}
              confirmLabel={t('common.delete')}
              variant="destructive"
              onConfirm={() => deleteServerMut.mutate()}
              isPending={deleteServerMut.isPending}
            />
          </>
        }
      />

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">{t('det.tabOverview')}</TabsTrigger>
          {hasCap(profile, 'canViewDocker') && <TabsTrigger value="docker">{t('det.tabDocker')}</TabsTrigger>}
          {(hasCap(profile, 'canViewUpdates') || hasCap(profile, 'canRunUpdates') || hasCap(profile, 'canRebootServers') || hasCap(profile, 'canViewCustomUpdates') || hasCap(profile, 'canRunCustomUpdates') || hasCap(profile, 'canEditCustomUpdates') || hasCap(profile, 'canDeleteCustomUpdates')) && <TabsTrigger value="updates">{t('det.tabUpdates')}</TabsTrigger>}
          <TabsTrigger value="history">{t('det.tabHistory')}</TabsTrigger>
          {agentEnabled && profile?.role === 'admin' && <TabsTrigger value="agent">{t('det.tabAgent')}</TabsTrigger>}
          {hasCap(profile, 'canViewNotes') && (
            <TabsTrigger value="notes" className="gap-1">
              <StickyNote className="h-3 w-3" />{t('det.tabNotes')}
              {server.notes?.trim() && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
            </TabsTrigger>
          )}
        </TabsList>

        {/* ════ OVERVIEW ════ */}
        <TabsContent value="overview" className="space-y-3">
          {/* Stat cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<HeartPulse className="h-5 w-5" />} label={t('det.health')}
              value={server.status === 'offline' ? t('common.offline') : info?._cached ? t('det.statusCached') : (info?.updates_count ?? 0) > 0 ? t('det.statusAttention') : t('det.statusHealthy')}
              variant={server.status === 'offline' ? 'error' : info?._cached || (info?.updates_count ?? 0) > 0 ? 'warning' : 'ok'} />
            <StatCard icon={<Box className="h-5 w-5" />} label={t('det.tabUpdates')}
              value={server.status === 'offline' ? '—' : String(updatesList.length)} variant={server.status === 'offline' ? 'muted' : updatesList.length > 0 ? 'warning' : 'ok'} />
            <StatCard icon={<Satellite className="h-5 w-5" />} label={t('det.latency')} value={server.status === 'offline' ? '—' : latencyMs !== null ? `${latencyMs} ms` : '—'} variant={server.status === 'offline' ? 'muted' : latencyMs !== null ? (latencyMs > 500 ? 'warning' : 'ok') : 'muted'} />
            <StatCard icon={<Boxes className="h-5 w-5" />} label={t('det.tabDocker')}
              value={server.status === 'offline' ? '—' : containers.length ? String(containers.length) : t('det.statusIdle')} variant={server.status === 'offline' ? 'muted' : containers.length ? undefined : 'muted'} />
          </div>

          {/* Quick links */}
          {(server.links || []).length > 0 && (
            <Card>
              <CardHeader className="px-4 py-3"><CardTitle className="text-sm">{t('det.quickLinks')}</CardTitle></CardHeader>
              <CardContent className="px-4 pb-4 pt-0 flex flex-wrap gap-2">
                {server.links!.map((l, i) => (
                  <a key={i} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                    {l.name} <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            {/* System info */}
            <Card>
              <CardHeader className="px-4 py-3"><CardTitle className="text-sm flex items-center gap-2"><Info className="h-4 w-4" />{t('det.sysinfo')}</CardTitle></CardHeader>
              <CardContent className="px-4 pb-4 pt-0 space-y-1">
                <dl className="grid gap-y-1.5 text-sm">
                  {([
                    [t('det.os'), info?.os],
                    [t('det.kernel'), info?.kernel],
                    [t('det.cpu'), info?.cpu],
                    [t('det.cores'), info?.cpu_cores ? `${info.cpu_cores} ${t('det.cores')}` : null],
                    [t('det.uptime'), info?.uptime_seconds ? formatUptime(info.uptime_seconds) : null],
                    [t('det.loadAvg'), info?.load_avg],
                  ] as [string, string | number | null | undefined][]).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between border-b border-dashed py-1 last:border-0">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium tabular-nums">{v ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 -mx-4 border-t px-4 pt-3">
                <SectionLabel className="mb-2">{t('det.network')}</SectionLabel>
                <dl className="grid gap-y-1.5 text-sm">
                  <div className="flex items-center justify-between border-b border-dashed py-1">
                    <dt className="text-muted-foreground">{t('det.ipAddress')}</dt>
                    <dd className="flex items-center gap-1 font-mono text-xs">{server.ip_address}<CopyButton value={server.ip_address || ''} label={t('det.ipAddress')} /></dd>
                  </div>
                  {server.hostname && (
                    <div className="flex items-center justify-between border-b border-dashed py-1">
                      <dt className="text-muted-foreground">{t('det.hostname')}</dt>
                      <dd className="flex items-center gap-1 font-mono text-xs">{server.hostname}<CopyButton value={server.hostname} label={t('det.hostname')} /></dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between border-b border-dashed py-1">
                    <dt className="text-muted-foreground">{t('det.sshPort')}</dt>
                    <dd className="font-mono text-xs">{server.ssh_port || 22}</dd>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <dt className="text-muted-foreground">{t('det.sshUser')}</dt>
                    <dd className="font-mono text-xs">{server.ssh_user || 'root'}</dd>
                  </div>
                 </dl>
                </div>
              </CardContent>
            </Card>

            {/* Resources */}
            <Card>
              <CardHeader className="px-4 py-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">{t('det.resources')}</CardTitle>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetchInfo()} disabled={fetchingInfo}>
                  <RefreshCw className={`h-3.5 w-3.5 ${fetchingInfo ? 'animate-spin' : ''}`} />
                </Button>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0 space-y-4">
                {cpuPct === null && info?.ram_used_mb == null ? (
                  <p className="text-sm text-muted-foreground text-center py-4">{t('det.offline')}</p>
                ) : (
                  <>
                    {cpuPct !== null && (
                      <div>
                        <div className="flex justify-between text-sm mb-1"><span>{t('det.cpu')}</span><span className={`font-medium ${metricTextClass(cpuPct)}`}>{cpuPct}%</span></div>
                        <ThresholdBar pct={cpuPct} />
                      </div>
                    )}
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{t('det.ram')}</span>
                        <span className={`font-medium ${metricTextClass(ramPct)}`}>
                          {formatBytes(info?.ram_used_mb)} / {formatBytes(info?.ram_total_mb)} · {ramPct ?? 0}%
                        </span>
                      </div>
                      <ThresholdBar pct={ramPct} />
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{t('det.disk')}</span>
                        <span className={`font-medium ${metricTextClass(diskPct)}`}>
                          {info?.disk_used_gb?.toFixed(1) ?? '—'} / {info?.disk_total_gb?.toFixed(1) ?? '—'} GB · {diskPct ?? 0}%
                        </span>
                      </div>
                      <ThresholdBar pct={diskPct} />
                    </div>

                    {/* Storage mounts */}
                    {(info?.storage_mount_metrics ?? []).length > 0 && (
                      <>
                        <SectionLabel className="pt-2">{t('det.storageMounts')}</SectionLabel>
                        {info!.storage_mount_metrics!.map((m, i) => {
                          const pct = m.usage_pct ?? null;
                          return (
                            <div key={i}>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="font-medium">{m.name || m.path}{m.filesystem ? ` · ${m.filesystem}` : ''}</span>
                                <span>{m.used_gb?.toFixed(1) ?? '—'} / {m.total_gb?.toFixed(1) ?? '—'} GB{pct != null ? ` · ${pct}%` : ''}</span>
                              </div>
                              <ThresholdBar pct={pct} />
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* ZFS pools */}
                    {(info?.zfs_pools ?? []).length > 0 && (
                      <>
                        <SectionLabel className="pt-2">{t('det.zfsPools')}</SectionLabel>
                        {info!.zfs_pools!.map((p, i) => {
                          const pct = p.size_gb ? Math.round((p.alloc_gb! / p.size_gb) * 100) : 0;
                          return (
                            <div key={i}>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="font-medium">{p.name} <StatusBadge tone={p.health === 'ONLINE' ? 'success' : 'danger'} className="ml-1">{p.health}</StatusBadge></span>
                                <span>{p.alloc_gb?.toFixed(1)} / {p.size_gb?.toFixed(1)} GB · {pct}%</span>
                              </div>
                              {p.scrub && <div className="mb-1 text-[11px] text-muted-foreground">Last scrub: {p.scrub}</div>}
                              <ThresholdBar pct={pct} />
                            </div>
                          );
                        })}
                      </>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ════ DOCKER ════ */}
        {hasCap(profile, 'canViewDocker') && (
          <TabsContent value="docker" className="space-y-4">
            <Card>
              <CardHeader className="px-4 py-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2"><Boxes className="h-4 w-4" />{t('det.docker')}</CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => qc.invalidateQueries({ queryKey: ['server', id, 'docker'] })} disabled={fetchingDocker}>
                    <RefreshCw className={`h-3.5 w-3.5 ${fetchingDocker ? 'animate-spin' : ''}`} />
                  </Button>
                  {hasCap(profile, 'canManageDockerCompose') && (
                    <Button size="sm" variant="secondary" onClick={() => setComposeDialog({ open: true, mode: 'add', dir: '', content: '', loading: false })}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> {t('det.addComposeStack')}
                    </Button>
                  )}
                  {hasCap(profile, 'canPullDocker') && (
                    <Button size="sm" variant="secondary" disabled={checkImageMut.isPending}
                      onClick={() => checkImageMut.mutate()}>
                      <CloudDownload className="h-3.5 w-3.5 mr-1" /> {checkImageMut.isPending ? t('det.checkingUpdates') : t('det.checkUpdates')}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {containers.length === 0 ? (
                  <EmptyState compact icon={<Boxes className="h-5 w-5" />} title={t('det.noContainers')} description={t('det.noContainersHint')} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 w-2"></th>
                          <th className="px-3 py-2">{t('common.name')}</th>
                          <th className="px-3 py-2">{t('common.image')}</th>
                          <th className="px-3 py-2">{t('common.status')}</th>
                          <th className="px-3 py-2">{t('det.checkUpdates')}</th>
                          <th className="px-3 py-2">{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {/* Stacks */}
                        {Object.entries(stacks.map).map(([proj, data]) => {
                          const allDown = data.containers.every(c => !c.status?.startsWith('Up'));
                          return [
                            <tr key={`stack-${proj}`} className="bg-muted/20">
                              <td colSpan={5} className="px-3 py-2">
                                <span className="inline-flex items-center gap-2">
                                  <Layers className="h-3.5 w-3.5 text-primary" />
                                  <strong className="text-sm">{proj}</strong>
                                  <span className="font-mono text-[10px] text-muted-foreground">{data.dir}</span>
                                  {allDown && <StatusBadge tone="danger">{t('common.offline')}</StatusBadge>}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-0.5">
                                  {hasCap(profile, 'canManageDockerCompose') && <Button variant="ghost" size="icon" className="h-6 w-6" title={t('det.editCompose')} onClick={() => openEditCompose(data.dir)}><FileText className="h-3 w-3" /></Button>}
                                  {hasCap(profile, 'canPullDocker') && <Button variant="ghost" size="icon" className="h-6 w-6" title="pull" onClick={() => composeActionMut.mutate({ dir: data.dir, action: 'pull' })} disabled={composeActionMut.isPending}><CloudDownload className="h-3 w-3" /></Button>}
                                  {hasCap(profile, 'canManageDockerCompose') && <Button variant="ghost" size="icon" className="h-6 w-6" title="up -d" onClick={() => composeActionMut.mutate({ dir: data.dir, action: 'up' })} disabled={composeActionMut.isPending}><Play className="h-3 w-3" /></Button>}
                                  {hasCap(profile, 'canManageDockerCompose') && <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="down" onClick={() => composeActionMut.mutate({ dir: data.dir, action: 'down' })} disabled={composeActionMut.isPending}><Square className="h-3 w-3" /></Button>}
                                </div>
                              </td>
                            </tr>,
                            ...data.containers.filter(c => c.container_name !== '[Stack Offline]').map(c => renderContainerRow(c)),
                          ];
                        })}
                        {/* Standalone */}
                        {stacks.standalone.length > 0 && (
                          <tr className="bg-muted/20">
                            <td colSpan={6} className="px-3 py-2"><span className="inline-flex items-center gap-2"><Box className="h-3.5 w-3.5 text-muted-foreground" /><strong className="text-sm">{t('det.standalone')}</strong></span></td>
                          </tr>
                        )}
                        {stacks.standalone.map(c => renderContainerRow(c))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Logs panel */}
                {logsContainer && (
                  <div className="border-t">
                    <div className="flex items-center justify-between px-4 py-2 bg-muted/30">
                      <span className="text-sm font-medium">{t('det.logs')}: <span className="font-mono">{logsContainer}</span></span>
                      <div className="flex items-center gap-2">
                        <select value={logsTail} onChange={e => { setLogsTail(Number(e.target.value)); loadLogs(logsContainer!, Number(e.target.value)); }}
                          className="h-7 rounded border bg-background px-2 text-xs">
                          <option value={100}>100</option><option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option>
                        </select>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadLogs(logsContainer!, logsTail)}><RefreshCw className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setLogsContainer(null)}>×</Button>
                      </div>
                    </div>
                    <pre className="overflow-auto bg-black p-3 text-xs text-green-400 font-mono max-h-[400px]">
                      {logsLoading ? t('common.loading') : logsContent || t('det.noOutput')}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ════ UPDATES ════ */}
        {(hasCap(profile, 'canViewUpdates') || hasCap(profile, 'canRunUpdates') || hasCap(profile, 'canRebootServers') || hasCap(profile, 'canViewCustomUpdates') || hasCap(profile, 'canRunCustomUpdates') || hasCap(profile, 'canEditCustomUpdates') || hasCap(profile, 'canDeleteCustomUpdates')) && (
          <TabsContent value="updates" className="space-y-4">
            {hasCap(profile, 'canViewUpdates') && (
              <Card>
                <CardHeader className="px-4 py-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">{t('det.tabUpdates')}</CardTitle>
                  <Button variant="ghost" size="icon" className="h-7 w-7"
                    onClick={() => qc.invalidateQueries({ queryKey: ['server', id, 'updates'] })} disabled={fetchingUpdates}>
                    <RefreshCw className={`h-3.5 w-3.5 ${fetchingUpdates ? 'animate-spin' : ''}`} />
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  {updatesList.length === 0 ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-sm text-emerald-500">
                      <span>✓</span> {t('det.allUpToDate')}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-600 text-xs border-b">
                        <span>⚠</span> {t('det.updatesAvail', { count: updatesList.length })}
                      </div>
                      <div className="divide-y max-h-64 overflow-auto">
                        {updatesList.map((u, i) => (
                          <div key={i} className="flex items-center justify-between px-4 py-1.5 text-sm">
                            <span className="font-mono text-xs">{u.package}</span>
                            <span className="text-xs text-muted-foreground">{u.version || ''}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {phasedList.length > 0 && (
                    <>
                      <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 text-muted-foreground text-xs border-t">
                        <span>⏸</span> {t('det.phasedCount', { count: phasedList.length })}
                      </div>
                      <div className="divide-y opacity-50 max-h-40 overflow-auto">
                        {phasedList.map((u, i) => (
                          <div key={i} className="flex items-center justify-between px-4 py-1.5 text-sm">
                            <span className="font-mono text-xs">{u.package}</span>
                            <span className="text-xs text-muted-foreground">{u.version || ''}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {hasCap(profile, 'canRunUpdates') && updatesList.length > 0 && (
                    <div className="p-3 border-t">
                      <Button size="sm" onClick={() => setConfirmRunUpdate(true)} disabled={runUpdateMut.isPending}>
                        <ArrowUp className="h-3.5 w-3.5 mr-1" /> {t('det.runUpdate')}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Custom tasks */}
            {(hasCap(profile, 'canViewCustomUpdates') || hasCap(profile, 'canRunCustomUpdates') || hasCap(profile, 'canEditCustomUpdates') || hasCap(profile, 'canDeleteCustomUpdates')) && (
              <Card>
                <CardHeader className="px-4 py-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">{t('det.customUpdates')}</CardTitle>
                  {hasCap(profile, 'canEditCustomUpdates') && (
                    <Button size="sm" onClick={() => setTaskDialog({ open: true, task: null })}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> {t('det.addTask')}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  {(!customTasks || customTasks.length === 0) ? (
                    <div className="p-4 text-sm text-muted-foreground">{t('det.noCustomTasks')}</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">{t('common.name')}</th>
                          <th className="px-3 py-2">{t('det.taskType')}</th>
                          <th className="px-3 py-2">{t('det.currentVersion')}</th>
                          <th className="px-3 py-2">{t('det.latestVersion')}</th>
                          <th className="px-3 py-2">{t('common.status')}</th>
                          <th className="px-3 py-2">{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {customTasks.map(task => (
                          <tr key={task.id}>
                            <td className="px-3 py-2 font-medium">{task.name}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{task.type === 'github' ? 'GitHub' : task.type === 'trigger' ? t('det.taskTypeTriggerShort') : 'Script'}</td>
                            <td className="px-3 py-2 font-mono text-xs">{task.current_version || '—'}</td>
                            <td className="px-3 py-2 font-mono text-xs">{task.type === 'trigger' ? (task.trigger_output || task.last_version || '—') : (task.last_version || '—')}</td>
                            <td className="px-3 py-2">
                              {task.has_update ? <StatusBadge tone="warning">{t('det.imageUpdateAvail')}</StatusBadge>
                                : task.last_checked_at ? <span className="text-xs text-emerald-500">✓ {t('det.imageUpToDate')}</span>
                                : <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-0.5">
                                {hasCap(profile, 'canRunCustomUpdates') && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => checkTaskMut.mutate(task.id)}><RefreshCw className="h-3 w-3" /></Button>}
                                {hasCap(profile, 'canRunCustomUpdates') && task.update_command && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => runTaskMut.mutate(task.id)}><Play className="h-3 w-3" /></Button>}
                                {hasCap(profile, 'canEditCustomUpdates') && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setTaskDialog({ open: true, task })}><Pencil className="h-3 w-3" /></Button>}
                                {hasCap(profile, 'canDeleteCustomUpdates') && <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setConfirmDeleteTask(task)}><Trash2 className="h-3 w-3" /></Button>}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}

        {/* ════ HISTORY ════ */}
        <TabsContent value="history">
          <Card>
            <CardContent className="p-0">
              {histItems.length === 0 ? (
                <EmptyState compact icon={<History className="h-5 w-5" />} title={t('det.noHistory')} />
              ) : (
                <>
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">{t('det.colAction')}</th>
                        <th className="px-3 py-2">{t('det.colTrigger')}</th>
                        <th className="px-3 py-2">{t('common.status')}</th>
                        <th className="px-3 py-2">{t('det.colStarted')}</th>
                        <th className="px-3 py-2">{t('det.colDone')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {histPage_.map(h => (
                        <tr key={h.id}>
                          <td className="px-3 py-2 font-mono text-xs">
                            {h._type === 'schedule' && <StatusBadge tone="muted" className="mr-1">{t('det.playbookBadge')}</StatusBadge>}
                            {h.action || h.playbook_name || '—'}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{h.triggered_by || 'system'}</td>
                          <td className="px-3 py-2">
                            <StatusBadge tone={h.status === 'success' ? 'success' : h.status === 'failed' ? 'danger' : 'muted'}>
                              {h.status || '—'}
                            </StatusBadge>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{formatDate(h.started_at, hour12)}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{formatDate(h.completed_at, hour12)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {histTotal > 1 && (
                    <div className="flex items-center justify-between border-t px-4 py-2">
                      <span className="text-xs text-muted-foreground">
                        {t('det.histPageInfo', { from: (histSafe - 1) * HIST_PAGE_SIZE + 1, to: Math.min(histSafe * HIST_PAGE_SIZE, histItems.length), total: histItems.length })}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" disabled={histSafe === 1} onClick={() => setHistPage(histSafe - 1)}>‹</Button>
                        {Array.from({ length: histTotal }, (_, i) => i + 1).filter(i => histTotal <= 7 || Math.abs(i - histSafe) <= 2 || i === 1 || i === histTotal).map((i, idx, arr) => (
                          <span key={i}>
                            {idx > 0 && i - arr[idx - 1] > 1 && <span className="px-1 text-muted-foreground">…</span>}
                            <Button size="sm" variant={i === histSafe ? 'default' : 'ghost'} onClick={() => setHistPage(i)}>{i}</Button>
                          </span>
                        ))}
                        <Button size="sm" variant="ghost" disabled={histSafe === histTotal} onClick={() => setHistPage(histSafe + 1)}>›</Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ════ AGENT ════ */}
        {agentEnabled && profile?.role === 'admin' && (
          <TabsContent value="agent" className="space-y-4">
            <Card>
              <CardContent className="px-4 pb-4 pt-4 space-y-4">
                <p className="text-sm text-muted-foreground">{t('det.agentDescription')}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard icon={<Settings2 className="h-5 w-5" />} label={t('det.agentMode')} value={agentStatus?.mode || 'legacy'} />
                  <StatCard icon={<Clock className="h-5 w-5" />} label={t('det.agentLastSeen')} value={agentStatus?.lastSeen || '—'} />
                  <StatCard icon={<Shield className="h-5 w-5" />} label={t('det.agentRunnerVersion')} value={agentStatus?.runnerVersion || '—'} />
                  <StatCard icon={<FileText className="h-5 w-5" />} label={t('det.agentManifestVersion')} value={String(agentStatus?.manifestVersion || agentStatus?.latestManifestVersion || '—')} />
                </div>
                <div className="flex flex-wrap gap-2">
                  {!agentStatus?.installed ? (
                    <Button size="sm" onClick={() => { if (confirm(t('det.agentInstallConfirm'))) agentInstallMut.mutate(); }} disabled={agentBusy}>
                      <Download className="h-3.5 w-3.5 mr-1" /> {t('det.agentInstall')}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => agentUpdateMut.mutate()} disabled={agentBusy}><RotateCw className="h-3.5 w-3.5 mr-1" />{t('det.agentUpdate')}</Button>
                      <Button size="sm" variant="secondary" onClick={() => agentConfigMut.mutate()} disabled={agentBusy}><Sliders className="h-3.5 w-3.5 mr-1" />{t('det.agentConfigure')}</Button>
                      <Button size="sm" variant="secondary" onClick={() => agentRotateMut.mutate()} disabled={agentBusy}><Key className="h-3.5 w-3.5 mr-1" />{t('det.agentRotateToken')}</Button>
                      <Button size="sm" variant="destructive" onClick={() => { if (confirm(t('det.agentRemoveConfirm'))) agentRemoveMut.mutate(); }} disabled={agentBusy}><Trash2 className="h-3.5 w-3.5 mr-1" />{t('det.agentRemove')}</Button>
                    </>
                  )}
                </div>
                {agentStatus?.installed && (
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p><strong>{t('det.agentUpdate')}:</strong> {t('det.agentUpdateHint')}</p>
                    <p><strong>{t('det.agentConfigure')}:</strong> {t('det.agentConfigureHint')}</p>
                  </div>
                )}
                <div className="space-y-2 max-w-xl">
                  <Label className="text-xs">{t('det.agentShipyardUrl')}</Label>
                  <Input value={agentUrl} onChange={e => setAgentUrl(e.target.value)} placeholder={t('det.agentUrlPlaceholder')} />
                  <Label className="text-xs">{t('det.agentCaPem')}</Label>
                  <Textarea value={agentCa} onChange={e => setAgentCa(e.target.value)} rows={4} className="font-mono text-xs" placeholder={t('det.agentCaPemPlaceholder')} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* ════ NOTES ════ */}
        {hasCap(profile, 'canViewNotes') && (
          <TabsContent value="notes">
            <Card>
              <CardHeader className="px-4 py-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">{t('det.tabNotes')}</CardTitle>
                {hasCap(profile, 'canEditNotes') && (
                  <Button size="sm" variant="secondary" onClick={() => setNotesEditing(!notesEditing)}>
                    {notesEditing ? <><Eye className="h-3.5 w-3.5 mr-1" />{t('det.notesView')}</> : <><Pencil className="h-3.5 w-3.5 mr-1" />{t('det.notesEdit')}</>}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0">
                {notesEditing ? (
                  <Textarea value={notes} rows={16} placeholder={t('det.notesPlaceholder')} className="font-mono text-sm"
                    onChange={e => { setNotes(e.target.value); autoSaveNotes(e.target.value); }} />
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none min-h-[200px]">
                    {notes.trim() ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(notes) as string) }} /> : <p className="text-muted-foreground">{t('det.notesEmpty')}</p>}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Custom task dialog */}
      <Dialog open={taskDialog.open} onOpenChange={v => { if (!v) setTaskDialog({ open: false, task: null }); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{taskDialog.task ? t('det.editTask') : t('det.addTask')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>{t('det.taskName')}</Label><Input value={taskForm.name} onChange={e => setTaskForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="space-y-1">
              <Label>{t('det.taskType')}</Label>
              <select value={taskForm.type} onChange={e => setTaskForm(f => ({ ...f, type: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="script">{t('det.taskTypeScript')}</option>
                <option value="github">{t('det.taskTypeGithub')}</option>
                <option value="trigger">{t('det.taskTypeTrigger')}</option>
              </select>
              <p className="text-xs text-muted-foreground">{taskForm.type === 'github' ? t('det.taskTypeGithubDesc') : taskForm.type === 'trigger' ? t('det.taskTypeTriggerDesc') : t('det.taskTypeScriptDesc')}</p>
            </div>
            {taskForm.type === 'github' && <div className="space-y-1"><Label>{t('det.taskGithubRepo')}</Label><Input value={taskForm.github_repo} onChange={e => setTaskForm(f => ({ ...f, github_repo: e.target.value }))} placeholder="owner/repo" className="font-mono" /></div>}
            {taskForm.type === 'trigger' && <div className="space-y-1"><Label>{t('det.taskTriggerOutput')}</Label><Input value={taskForm.trigger_output} onChange={e => setTaskForm(f => ({ ...f, trigger_output: e.target.value }))} placeholder="AVAILABLE" className="font-mono" /></div>}
            {taskForm.type === 'script' && <div className="space-y-1"><Label>{t('det.taskLatestCommand')}</Label><Input value={taskForm.latest_command} onChange={e => setTaskForm(f => ({ ...f, latest_command: e.target.value }))} className="font-mono" /></div>}
            <div className="space-y-1"><Label>{t('det.taskCheckCommand')}</Label><Input value={taskForm.check_command} onChange={e => setTaskForm(f => ({ ...f, check_command: e.target.value }))} className="font-mono" /></div>
            <div className="space-y-1"><Label>{t('det.taskUpdateCommand')}</Label><Input value={taskForm.update_command} onChange={e => setTaskForm(f => ({ ...f, update_command: e.target.value }))} className="font-mono" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTaskDialog({ open: false, task: null })}>{t('common.cancel')}</Button>
            <Button onClick={() => { if (!taskForm.name.trim()) { showToast(t('det.taskNameRequired'), 'error'); return; } saveTaskMut.mutate(); }} disabled={saveTaskMut.isPending}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Compose editor dialog */}
      <Dialog open={composeDialog.open} onOpenChange={v => { if (!v) setComposeDialog(prev => ({ ...prev, open: false })); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{composeDialog.mode === 'edit' ? t('det.editCompose') : t('det.addComposeStack')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {composeDialog.mode === 'add' && (
              <div className="space-y-1">
                <Label>{t('det.composePath')}</Label>
                <Input value={composeDialog.dir} onChange={e => setComposeDialog(prev => ({ ...prev, dir: e.target.value }))} placeholder="/opt/myapp" className="font-mono" />
              </div>
            )}
            <div className="space-y-1">
              <Label>docker-compose.yml</Label>
              {composeDialog.loading ? (
                <div className="space-y-1 py-2"><SkeletonRow cols={3} /><SkeletonRow cols={3} /><SkeletonRow cols={3} /></div>
              ) : (
                <Textarea value={composeDialog.content} onChange={e => setComposeDialog(prev => ({ ...prev, content: e.target.value }))}
                  rows={20} className="font-mono text-xs" />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setComposeDialog(prev => ({ ...prev, open: false }))}>{t('common.cancel')}</Button>
            <Button onClick={() => { if (!composeDialog.dir.trim()) { showToast(t('det.composePathRequired'), 'error'); return; } saveComposeMut.mutate(); }}
              disabled={saveComposeMut.isPending || composeDialog.loading}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SSH Terminal overlay */}
      {terminalOpen && (
        <SshTerminal server={server} onClose={() => setTerminalOpen(false)} />
      )}
      <Dialog open={!!actionOutput} onOpenChange={(open) => { if (!open) setActionOutput(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{actionOutput?.title || t('det.output')}</DialogTitle></DialogHeader>
          <div className="rounded-md border bg-muted/30">
            <div className="max-h-96 overflow-y-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {(actionOutput?.lines ?? []).map((line, i) => <div key={i} className={line.cls}>{line.text}</div>)}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionOutput(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!confirmDeleteTask}
        onOpenChange={(open) => { if (!open) setConfirmDeleteTask(null); }}
        title={t('common.delete')}
        description={t('det.confirmDeleteTask', { name: confirmDeleteTask?.name || '' })}
        confirmLabel={t('common.delete')}
        variant="destructive"
        onConfirm={() => { if (confirmDeleteTask) deleteTaskMut.mutate(confirmDeleteTask.id); }}
        isPending={deleteTaskMut.isPending}
      />
    </div>
  );

  // ── Container row helper ────────────────────────────────────
  function renderContainerRow(c: ContainerRow) {
    const isUp = c.status?.startsWith('Up');
    const upd = imageUpdates[c.image] || imageUpdates[c.image + ':latest'];
    return (
      <tr key={c.container_name}>
        <td className="px-3 py-2 pl-6">{isUp ? <LiveDot tone="success" /> : <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />}</td>
        <td className="px-3 py-2 font-mono text-xs">{c.container_name}</td>
        <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{c.image}</td>
        <td className="px-3 py-2"><span className={`text-xs ${isUp ? 'text-emerald-500' : 'text-rose-500'}`}>{c.status || c.state}</span></td>
        <td className="px-3 py-2">
          {upd === 'update_available' ? <StatusBadge tone="warning">{t('det.imageUpdateAvail')}</StatusBadge>
            : upd === 'up_to_date' ? <span className="text-xs text-muted-foreground">✓ {t('det.imageUpToDate')}</span>
            : upd === 'updated' ? <StatusBadge tone="success">{t('det.imageUpdated')}</StatusBadge>
            : <span className="text-xs text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-0.5">
            {hasCap(profile, 'canViewDocker') && (
              <Button variant="ghost" size="icon" className="h-6 w-6" title={t('det.showLogs')} onClick={() => loadLogs(c.container_name, logsTail)}>
                <FileText className="h-3 w-3" />
              </Button>
            )}
            {hasCap(profile, 'canRestartDocker') && (
              <Button variant="ghost" size="icon" className="h-6 w-6" title={t('common.restart')}
                onClick={() => { if (confirm(t('det.confirmRestartContainer', { name: c.container_name }))) restartContainerMut.mutate(c.container_name); }}>
                <RotateCw className="h-3 w-3" />
              </Button>
            )}
          </div>
        </td>
      </tr>
    );
  }
}
