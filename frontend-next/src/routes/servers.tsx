import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Search, Server as ServerIcon, Plus, RefreshCw,
  FolderPlus, Tags, FileJson, FileSpreadsheet, FileUp, Download,
  Play, ChevronRight, ChevronDown, Folder, FolderOpen,
  Pencil, Trash2, FolderTree, CircleDot, Info,
  X, Rows3, Rows2, AlignJustify, CheckCircle2, Hash,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useProfile, hasCap } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { LiveDot, StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRow } from '@/components/ui/skeleton';
import { OverflowMenu, OverflowItem, OverflowSep } from '@/components/ui/overflow-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

function buildAllExceptTargets(excluded: string[]): string {
  const unique = [...new Set(excluded.map(v => String(v || '').trim()).filter(Boolean))];
  if (unique.length === 0) return 'all';
  return `all:${unique.map(v => `!${v}`).join(':')}`;
}

// ─── Types ────────────────────────────────────────────────────
interface ServerRow {
  id: string;
  name: string;
  ip_address?: string;
  hostname?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: 'online' | 'offline' | string;
  group_id?: string | null;
  group_name?: string;
  tags?: string[];
  services?: string[];
  links?: { name: string; url: string }[];
  storage_mounts?: { name: string; path: string }[];
  last_seen?: string;
  [k: string]: unknown;
}

interface ServerGroup {
  id: string;
  name: string;
  color?: string;
  parent_id?: string | null;
}

interface GroupNode extends ServerGroup {
  children: GroupNode[];
}

interface ServerInfo {
  os?: string;
  cpu_usage_pct?: number;
  ram_used_mb?: number;
  ram_total_mb?: number;
  disk_used_gb?: number;
  disk_total_gb?: number;
}

// ─── Constants ────────────────────────────────────────────────
const PAGE_SIZE = 20;
const STORAGE_KEY_COLLAPSED = 'shipyard.ui.servers.collapsedGroups';
const PRESET_COLORS = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];

function normalizeServer(s: Record<string, unknown>): ServerRow {
  return {
    ...s,
    id: String(s.id),
    name: String(s.name ?? ''),
    tags: typeof s.tags === 'string' ? JSON.parse(s.tags) : (s.tags as string[]) || [],
    services: typeof s.services === 'string' ? JSON.parse(s.services) : (s.services as string[]) || [],
    links: typeof s.links === 'string' ? JSON.parse(s.links) : (s.links as { name: string; url: string }[]) || [],
    storage_mounts: typeof s.storage_mounts === 'string' ? JSON.parse(s.storage_mounts) : (s.storage_mounts as { name: string; path: string }[]) || [],
  } as ServerRow;
}

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === 'string') : []);
  } catch { return new Set(); }
}
function saveCollapsedGroups(s: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify([...s])); } catch { /* */ }
}
function buildGroupTree(groups: ServerGroup[], parentId: string | null = null, visited = new Set<string>()): GroupNode[] {
  if (parentId !== null && visited.has(parentId)) return [];
  if (parentId !== null) visited.add(parentId);
  return groups
    .filter(g => (g.parent_id || null) === parentId)
    .map(g => ({ ...g, children: buildGroupTree(groups, g.id, new Set(visited)) }));
}

function countDescendantServers(node: GroupNode, byGroup: Record<string, ServerRow[]>, visited = new Set<string>()): number {
  if (visited.has(node.id)) return 0;
  visited.add(node.id);
  let count = 0;
  for (const child of node.children) {
    count += (byGroup[child.id] || []).length + countDescendantServers(child, byGroup, visited);
  }
  return count;
}

function getDescendantIds(groups: ServerGroup[], id: string): Set<string> {
  const ids = new Set([id]);
  const add = (pid: string) => groups.filter(g => g.parent_id === pid).forEach(g => {
    if (!ids.has(g.id)) { ids.add(g.id); add(g.id); }
  });
  add(id);
  return ids;
}

function formatRelativeTime(dateStr: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const utc = dateStr && !dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
  const diff = Math.floor((Date.now() - new Date(utc).getTime()) / 1000);
  if (diff < 60) return t('dash.justNow');
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function parseCsvServers(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const fields: string[] = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { inQ = false; continue; }
        cur += ch;
      } else {
        if (ch === '"') { inQ = true; }
        else if (ch === ',') { fields.push(cur); cur = ''; }
        else { cur += ch; }
      }
    }
    fields.push(cur);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => { obj[h] = fields[i] ?? ''; });
    try { obj.tags = JSON.parse((obj.tags as string) || '[]'); } catch { obj.tags = []; }
    try { obj.services = JSON.parse((obj.services as string) || '[]'); } catch { obj.services = []; }
    try { obj.links = JSON.parse((obj.links as string) || '[]'); } catch { obj.links = []; }
    try { obj.storage_mounts = JSON.parse((obj.storage_mounts as string) || '[]'); } catch { obj.storage_mounts = []; }
    obj.ssh_port = parseInt(String(obj.ssh_port)) || 22;
    return obj;
  }).filter(o => o.name && o.ip_address);
}

// ─── MetricBar Component ──────────────────────────────────────
function MetricBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-muted-foreground tabular-nums">—</span>;
  const vis = pct > 0 ? Math.max(pct, 4) : 0;
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${vis}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">{pct}%</span>
    </div>
  );
}

// ─── useServerInfo hook ───────────────────────────────────────
function useServerInfoMap(serverIds: string[]) {
  const [infoMap, setInfoMap] = useState<Record<string, ServerInfo>>({});

  const loadInfos = useCallback((ids: string[], force = false) => {
    if (ids.length === 0) return;
    ids.forEach(id => {
      api.getServerInfo(id, force).then(info => {
        if (!info) return;
        setInfoMap(prev => ({ ...prev, [id]: info as unknown as ServerInfo }));
      }).catch(() => { /* ignore */ });
    });
  }, []);

  useEffect(() => {
    if (serverIds.length === 0) return;
    let cancelled = false;
    serverIds.forEach(id => {
      api.getServerInfo(id).then(info => {
        if (cancelled || !info) return;
        setInfoMap(prev => ({ ...prev, [id]: info as unknown as ServerInfo }));
      }).catch(() => { /* ignore */ });
    });
    return () => { cancelled = true; };
  }, [serverIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return { infoMap, loadInfos };
}

// ─── GroupDialog Component ────────────────────────────────────
interface GroupDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; color: string; parentId: string | null }) => void;
  title: string;
  confirmText: string;
  groups: ServerGroup[];
  editId?: string | null;
  defaultName?: string;
  defaultColor?: string;
  defaultParentId?: string | null;
}

function GroupDialog({ open, onClose, onSubmit, title, confirmText, groups, editId, defaultName = '', defaultColor, defaultParentId = null }: GroupDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [color, setColor] = useState(defaultColor || PRESET_COLORS[0]);
  const [parentId, setParentId] = useState<string | null>(defaultParentId ?? null);

  useEffect(() => {
    if (open) { setName(defaultName); setColor(defaultColor || PRESET_COLORS[0]); setParentId(defaultParentId ?? null); }
  }, [open, defaultName, defaultColor, defaultParentId]);

  const excludeIds = editId ? getDescendantIds(groups, editId) : new Set<string>();
  const parentOptions = groups.filter(g => !excludeIds.has(g.id));

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), color, parentId: parentId || null });
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('common.name')}</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('srv.groupNamePlaceholder')}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>{t('srv.groupColor')}</Label>
            <div className="flex flex-wrap gap-1.5 items-center">
              {PRESET_COLORS.map(c => (
                <button key={c} className={`w-6 h-6 rounded-full border-2 ${c === color ? 'ring-2 ring-offset-2 ring-offset-background' : 'border-transparent'}`}
                  style={{ background: c, borderColor: c === color ? c : 'transparent' }}
                  onClick={() => setColor(c)} />
              ))}
              <input type="color" value={color} onChange={e => setColor(e.target.value)}
                className="w-6 h-6 p-0 border-none rounded-full cursor-pointer bg-transparent" title={t('common.customColor')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('srv.parentFolder')}</Label>
            <select value={parentId || ''} onChange={e => setParentId(e.target.value || null)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <option value="">{t('srv.noneTopLevel')}</option>
              {parentOptions.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit}>{confirmText}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── MoveToGroupDropdown ──────────────────────────────────────
function MoveDropdown({ groups, onSelect, anchorRef }: {
  groups: ServerGroup[];
  onSelect: (groupId: string | null) => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onSelect(undefined as unknown as null); // close without action
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [onSelect]);

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border bg-popover p-1 shadow-md">
      <button onClick={() => onSelect(null)}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
        <X className="h-3.5 w-3.5 text-muted-foreground" /> {t('srv.moveToRoot')}
      </button>
      {groups.map(g => (
        <button key={g.id} onClick={() => onSelect(g.id)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent">
          <Folder className="h-3.5 w-3.5" style={{ color: g.color || PRESET_COLORS[0] }} /> {g.name}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ─── Main ServersPage ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
export function ServersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: profile } = useProfile();
  const navigate = useNavigate();
  useEffect(() => { sessionStorage.setItem('shipyard.lastNonDetailRoute', '/servers'); }, []);

  // ── Data queries ────────────────────────────────────────────
  const { data: rawServers, isLoading } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers() as Promise<Record<string, unknown>[]>,
  });
  const { data: rawGroups } = useQuery({
    queryKey: ['serverGroups'],
    queryFn: () => api.getServerGroups() as unknown as Promise<ServerGroup[]>,
    staleTime: 30_000,
  });

  const servers = useMemo(() => (rawServers ?? []).map(normalizeServer), [rawServers]);
  const groups = useMemo(() => (rawGroups ?? []) as ServerGroup[], [rawGroups]);

  // ── Local UI state ──────────────────────────────────────────
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedGroups);
  const [groupDialog, setGroupDialog] = useState<{
    open: boolean; title: string; confirmText: string;
    name?: string; color?: string; parentId?: string | null; editId?: string | null;
  }>({ open: false, title: '', confirmText: '' });
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const moveRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [density, setDensity] = useState<'compact' | 'cozy' | 'comfortable'>(() => {
    const saved = localStorage.getItem('shipyard-next.density');
    return (saved === 'compact' || saved === 'comfortable') ? saved : 'cozy';
  });
  useEffect(() => { localStorage.setItem('shipyard-next.density', density); }, [density]);

  // ── Derived data ────────────────────────────────────────────
  const allTags = useMemo(() => [...new Set(servers.flatMap(s => s.tags || []))].sort(), [servers]);
  const filtered = useMemo(() => activeTag ? servers.filter(s => (s.tags || []).includes(activeTag!)) : servers, [servers, activeTag]);
  const useGroups = groups.length > 0;

  const totalPages = useGroups ? 1 : Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageServers = useGroups ? filtered : filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const onlineCount = servers.filter(s => s.status === 'online').length;
  const offlineCount = servers.filter(s => s.status === 'offline').length;

  // Load server info for visible rows
  const visibleIds = useMemo(() => {
    if (useGroups) return filtered.map(s => s.id);
    return pageServers.map(s => s.id);
  }, [useGroups, filtered, pageServers]);
  const { infoMap, loadInfos } = useServerInfoMap(visibleIds);

  // ── Mutations ───────────────────────────────────────────────
  const invalidateAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['serverGroups'] });
  }, [qc]);

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onSuccess: () => { showToast(t('srv.deleted'), 'success'); invalidateAll(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const moveMut = useMutation({
    mutationFn: ({ serverId, groupId }: { serverId: string; groupId: string | null }) =>
      api.setServerGroup(serverId, groupId),
    onSuccess: (_, { groupId }) => {
      if (groupId) {
        const grp = groups.find(g => g.id === groupId);
        showToast(t('srv.movedTo', { group: grp?.name || groupId }), 'success');
      } else {
        showToast(t('srv.movedOut'), 'success');
      }
      invalidateAll();
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const groupCreateMut = useMutation({
    mutationFn: (data: { name: string; color: string; parentId: string | null }) =>
      api.createServerGroup(data.name, data.color, data.parentId),
    onSuccess: () => { showToast(t('srv.folderCreated'), 'success'); invalidateAll(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const groupUpdateMut = useMutation({
    mutationFn: (data: { id: string; name: string; color: string; parentId: string | null; oldParentId: string | null }) =>
      api.updateServerGroup(data.id, data.name, data.color).then(() => {
        if (data.parentId !== data.oldParentId) return api.setGroupParent(data.id, data.parentId);
      }),
    onSuccess: () => { showToast(t('srv.folderUpdated'), 'success'); invalidateAll(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const groupDeleteMut = useMutation({
    mutationFn: (id: string) => api.deleteServerGroup(id),
    onSuccess: () => { showToast(t('srv.folderDeleted'), 'success'); invalidateAll(); },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const autoGroupMut = useMutation({
    mutationFn: () => api.autoGroupByTags() as Promise<{ moved: number; matched: number }>,
    onSuccess: (result) => {
      if (result.moved > 0) showToast(t('srv.autoGroupDone', { moved: result.moved, matched: result.matched }), 'success');
      else showToast(t('srv.autoGroupNone'), 'info');
      invalidateAll();
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  const importMut = useMutation({
    mutationFn: (servers: Record<string, unknown>[]) => api.importServers(servers) as Promise<{ created: number; skipped: number }>,
    onSuccess: (result) => {
      showToast(t('srv.importDone', { created: result.created, skipped: result.skipped }), result.created > 0 ? 'success' : 'info');
      if (result.created > 0) { setPage(1); invalidateAll(); }
    },
    onError: (e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'),
  });

  // ── Playbook run dialog state ─────────────────────────────
  const [playbookDialogOpen, setPlaybookDialogOpen] = useState(false);
  const [selectedPlaybook, setSelectedPlaybook] = useState('');
  const [playbookTargets, setPlaybookTargets] = useState<string[]>([]);
  const [playbookUseAll, setPlaybookUseAll] = useState(false);
  const [playbookExcluded, setPlaybookExcluded] = useState<Set<string>>(new Set());
  const [playbookExtraVars, setPlaybookExtraVars] = useState('');
  const [confirmDeleteServer, setConfirmDeleteServer] = useState<ServerRow | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ServerGroup | null>(null);
  const { data: playbooks } = useQuery({
    queryKey: ['playbooks'],
    queryFn: () => api.getPlaybooks() as Promise<{ filename: string; description?: string; isInternal?: boolean; [k: string]: unknown }[]>,
    enabled: playbookDialogOpen,
  });

  const handleBulkRunPlaybook = useCallback(async () => {
    if (!selectedPlaybook) return;
    const names = playbookTargets;
    if (!playbookUseAll && !names.length) return;
    try {
      let extraVars: Record<string, unknown> = {};
      if (playbookExtraVars.trim()) {
        try { extraVars = JSON.parse(playbookExtraVars); }
        catch {
          showToast(t('run.invalidJson'), 'error');
          return;
        }
      }
      const targets = playbookUseAll ? buildAllExceptTargets([...playbookExcluded]) : names.join(',');
      await api.runPlaybook(selectedPlaybook, targets, extraVars);
      showToast(t('srv.playbookStarted', { playbook: selectedPlaybook, count: playbookUseAll ? servers.length - playbookExcluded.size : names.length }), 'success');
      setPlaybookDialogOpen(false);
      setSelectedPlaybook('');
      setPlaybookTargets([]);
      setPlaybookUseAll(false);
      setPlaybookExcluded(new Set());
      setPlaybookExtraVars('');
    } catch (e: unknown) {
      showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error');
    }
  }, [playbookTargets, playbookUseAll, playbookExcluded, playbookExtraVars, selectedPlaybook, servers.length, t]);

  // ── Handlers ────────────────────────────────────────────────
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveCollapsedGroups(next);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(pageServers.map(s => s.id)));
    } else {
      setSelectedIds(new Set());
    }
  }, [pageServers]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await qc.invalidateQueries({ queryKey: ['servers'] });
      const onlineIds = visibleIds.filter(id => {
        const s = servers.find(s => s.id === id);
        return s?.status === 'online';
      });
      await Promise.allSettled(onlineIds.map(id => api.getServerInfo(id, true)));
      loadInfos(onlineIds, true);
    } catch { /* */ }
    setRefreshing(false);
  }, [qc, visibleIds, servers, loadInfos]);

  const handleImportFile = useCallback(async (file: File) => {
    const text = await file.text();
    let rows: Record<string, unknown>[] = [];
    try {
      if (file.name.endsWith('.csv')) {
        rows = parseCsvServers(text);
      } else {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      showToast(t('srv.fileReadError'), 'error');
      return;
    }
    if (rows.length === 0) {
      showToast(t('srv.noValidServers'), 'error');
      return;
    }
    importMut.mutate(rows);
  }, [importMut, t]);

  useEffect(() => {
    if (!playbookDialogOpen) return;
    setPlaybookTargets(servers.filter(s => selectedIds.has(s.id)).map(s => s.name));
    setPlaybookUseAll(false);
    setPlaybookExcluded(new Set());
    setPlaybookExtraVars('');
  }, [playbookDialogOpen, servers, selectedIds]);

  const handleDeleteServer = useCallback((id: string, name: string) => {
    setConfirmDeleteServer(servers.find(s => s.id === id) ?? { id, name } as ServerRow);
  }, [servers]);

  const handleDeleteGroup = useCallback((id: string, name: string) => {
    setConfirmDeleteGroup(groups.find(g => g.id === id) ?? { id, name } as ServerGroup);
  }, [groups]);

  const handleBulkUpdate = useCallback(async () => {
    const names = servers.filter(s => selectedIds.has(s.id)).map(s => s.name);
    if (!names.length) return;
    try {
      await api.runPlaybook('update.yml', names.join(','), {});
      showToast(t('srv.updatesStarted', { count: names.length }), 'success');
    } catch (e: unknown) {
      showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error');
    }
  }, [servers, selectedIds, t]);

  // Drag & Drop state
  const [dragItem, setDragItem] = useState<{ type: 'server' | 'group'; id: string } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  const handleDrop = useCallback(async (targetGroupId: string | null) => {
    if (!dragItem) return;
    setDragOverGroup(null);
    if (dragItem.type === 'server') {
      moveMut.mutate({ serverId: dragItem.id, groupId: targetGroupId });
    } else if (dragItem.type === 'group') {
      if (dragItem.id === targetGroupId) return;
      if (targetGroupId && getDescendantIds(groups, dragItem.id).has(targetGroupId)) {
        showToast(t('srv.cantMoveToChild'), 'warning');
        return;
      }
      try {
        await api.setGroupParent(dragItem.id, targetGroupId);
        invalidateAll();
      } catch (e: unknown) {
        showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error');
      }
    }
    setDragItem(null);
  }, [dragItem, groups, moveMut, invalidateAll, t]);

  // ── formatLastSeen ──────────────────────────────────────────
  const fmtLastSeen = useCallback((s: ServerRow): string => {
    if (s.status === 'online') return t('common.online');
    if (!s.last_seen) return '—';
    return formatRelativeTime(s.last_seen, t);
  }, [t]);

  // ── Group dialog handler ────────────────────────────────────
  const handleGroupDialogSubmit = useCallback((data: { name: string; color: string; parentId: string | null }) => {
    const editId = groupDialog.editId;
    if (editId) {
      const old = groups.find(g => g.id === editId);
      groupUpdateMut.mutate({ id: editId, name: data.name, color: data.color, parentId: data.parentId, oldParentId: old?.parent_id || null });
    } else {
      groupCreateMut.mutate(data);
    }
    setGroupDialog(prev => ({ ...prev, open: false }));
  }, [groupDialog.editId, groups, groupCreateMut, groupUpdateMut]);

  // ── Render helpers ──────────────────────────────────────────
  const allSelected = pageServers.length > 0 && pageServers.every(s => selectedIds.has(s.id));
  const someSelected = pageServers.some(s => selectedIds.has(s.id)) && !allSelected;

  function renderServerRow(s: ServerRow, depth = 0, folderColor?: string | null) {
    const info = infoMap[s.id];
    const os = info?.os?.split(' ')[0] || '—';
    const cpuPct = info?.cpu_usage_pct ?? null;
    const ramPct = info?.ram_total_mb ? Math.round((info.ram_used_mb! / info.ram_total_mb) * 100) : null;
    const diskPct = info?.disk_total_gb ? Math.round((info.disk_used_gb! / info.disk_total_gb) * 100) : null;
    const lastSeen = fmtLastSeen(s);

    return (
      <tr key={s.id}
        className={`hover:bg-accent/40 cursor-pointer ${selectedIds.has(s.id) ? 'bg-accent/20' : ''}`}
        draggable
        onDragStart={e => { e.dataTransfer.setData('text/plain', `server:${s.id}`); setDragItem({ type: 'server', id: s.id }); }}
        onDragEnd={() => setDragItem(null)}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.srv-actions') || (e.target as HTMLElement).closest('.srv-checkbox')) return;
          navigate({ to: '/servers/$id', params: { id: s.id } });
        }}
      >
        <td className="px-2 py-2.5 w-9 srv-checkbox" style={folderColor ? { borderLeft: `3px solid ${folderColor}` } : undefined}
          onClick={e => e.stopPropagation()}>
          <input type="checkbox" className="rounded" checked={selectedIds.has(s.id)}
            onChange={() => toggleSelect(s.id)} />
        </td>
        <td className="px-1 py-2.5 w-3">
          {s.status === 'online' ? (
            <LiveDot tone="success" />
          ) : (
            <CircleDot className={`h-3 w-3 ${s.status === 'offline' ? 'text-rose-500' : 'text-muted-foreground'}`} />
          )}
        </td>
        <td className="px-3 py-2.5" style={{ paddingLeft: depth > 0 ? `${14 + (depth - 1) * 14}px` : undefined }}>
                <Link to="/servers/$id" params={{ id: s.id }} className="font-medium hover:underline">{s.name}</Link>
          {(s.tags || []).length > 0 && (
            <span className="ml-2 inline-flex gap-1">
              {s.tags!.map(tag => <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>)}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-muted-foreground text-xs tabular-nums">{s.ip_address || '—'}</td>
        <td className="px-3 py-2.5 text-muted-foreground text-xs">{os}</td>
        <td className="px-3 py-2.5"><MetricBar pct={cpuPct} /></td>
        <td className="px-3 py-2.5"><MetricBar pct={ramPct} /></td>
        <td className="px-3 py-2.5"><MetricBar pct={diskPct} /></td>
        <td className="px-3 py-2.5 text-muted-foreground text-xs tabular-nums">{lastSeen}</td>
         <td className="px-3 py-2.5 w-[100px] srv-actions" onClick={e => e.stopPropagation()}>
           <div className="flex items-center justify-start gap-0.5">
            {useGroups && hasCap(profile, 'canEditServers') && (
              <div className="relative" ref={moveFor === s.id ? moveRef : undefined}>
                <Button variant="ghost" size="icon" className="h-7 w-7" title={t('srv.moveTo')}
                  onClick={() => setMoveFor(prev => prev === s.id ? null : s.id)}>
                  <FolderTree className="h-3.5 w-3.5" />
                </Button>
                {moveFor === s.id && (
                  <MoveDropdown groups={groups} anchorRef={moveRef}
                    onSelect={(gid) => { setMoveFor(null); if (gid !== undefined) moveMut.mutate({ serverId: s.id, groupId: gid }); }} />
                )}
              </div>
            )}
            {hasCap(profile, 'canEditServers') && (
              <Button variant="ghost" size="icon" className="h-7 w-7" title={t('srv.edit')} asChild>
                <Link to="/servers/$id" params={{ id: s.id }}><Pencil className="h-3.5 w-3.5" /></Link>
              </Button>
            )}
            {hasCap(profile, 'canDeleteServers') && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title={t('srv.delete')}
                onClick={() => handleDeleteServer(s.id, s.name)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  function renderGroupRow(node: GroupNode, depth: number, serversByGroup: Record<string, ServerRow[]>) {
    const members = serversByGroup[node.id] || [];
    const isCollapsed = collapsed.has(node.id);
    const color = node.color || PRESET_COLORS[0];
    const total = members.length + countDescendantServers(node, serversByGroup);
    const isDragOver = dragOverGroup === node.id;

    return (
      <tbody key={`group-${node.id}`}>
        <tr
          className={`group-row cursor-pointer hover:bg-accent/30 ${isDragOver ? 'bg-accent/50' : ''}`}
          onClick={() => toggleCollapsed(node.id)}
          draggable={hasCap(profile, 'canEditServers')}
          onDragStart={e => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', `group:${node.id}`);
            setDragItem({ type: 'group', id: node.id });
          }}
          onDragEnd={() => setDragItem(null)}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverGroup(node.id); }}
          onDragLeave={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOverGroup(null); }}
          onDrop={e => { e.preventDefault(); handleDrop(node.id); }}
        >
          <td colSpan={9} style={{ borderLeft: `3px solid ${color}` }}>
            <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: `${12 + depth * 20}px` }}>
              {isCollapsed ? <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
              {isCollapsed ? <Folder className="h-4 w-4 flex-shrink-0" style={{ color }} /> : <FolderOpen className="h-4 w-4 flex-shrink-0" style={{ color }} />}
              <span className="font-medium text-sm">{node.name}</span>
              <Badge variant="secondary" className="text-[10px] ml-1">{total}</Badge>
            </div>
          </td>
          <td className="px-3 py-1.5 w-[100px] srv-actions" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-start gap-0.5">
              {hasCap(profile, 'canAddServers') && (
                <Button variant="ghost" size="icon" className="h-7 w-7" title={t('srv.createSubfolder')}
                  onClick={() => setGroupDialog({ open: true, title: t('srv.newSubfolderIn', { parent: node.name }), confirmText: t('common.create'), parentId: node.id, editId: null })}>
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              )}
              {hasCap(profile, 'canEditServers') && (
                <Button variant="ghost" size="icon" className="h-7 w-7" title={t('srv.editFolder')}
                  onClick={() => setGroupDialog({ open: true, title: t('srv.editFolderTitle'), confirmText: t('common.save'), name: node.name, color: node.color, parentId: node.parent_id, editId: node.id })}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              {hasCap(profile, 'canDeleteServers') && (
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title={t('srv.deleteFolder')}
                  onClick={() => handleDeleteGroup(node.id, node.name)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </td>
        </tr>
        {!isCollapsed && (
          <>
            {members.length === 0 && node.children.length === 0 && (
              <tr><td colSpan={10}><div className="flex items-center gap-1.5 text-muted-foreground text-xs py-1.5" style={{ paddingLeft: `${34 + depth * 20}px` }}>
                <Info className="h-3 w-3" /> {t('srv.emptyGroup')}
              </div></td></tr>
            )}
            {members.map(s => renderServerRow(s, depth + 1, color))}
            {node.children.map(child => renderGroupRow(child, depth + 1, serversByGroup))}
          </>
        )}
      </tbody>
    );
  }

  // ── Build grouped content ───────────────────────────────────
  const serversByGroup = useMemo(() => {
    const map: Record<string, ServerRow[]> = {};
    const ungrouped: ServerRow[] = [];
    for (const s of filtered) {
      const gid = s.group_id;
      if (gid && groups.find(g => g.id === gid)) {
        (map[gid] = map[gid] || []).push(s);
      } else {
        ungrouped.push(s);
      }
    }
    return { map, ungrouped };
  }, [filtered, groups]);

  const tree = useMemo(() => buildGroupTree(groups), [groups]);

  // ═══════════════════════════════════════════════════════════
  // ─── JSX ──────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader
        title={t('srv.title')}
        description={`${t('srv.count', { total: servers.length, online: onlineCount, offline: offlineCount })}${activeTag ? ` · ${t('srv.filtered', { tag: activeTag })}` : ''}`}
        actions={
          <>
          {hasCap(profile, 'canAddServers') && (
            <CreateServerDialog />
          )}
          <div className="hidden sm:inline-flex items-center rounded-md border bg-background p-0.5">
            {([
              { val: 'compact' as const, Icon: Rows3, label: t('srv.densityCompact') },
              { val: 'cozy' as const, Icon: Rows2, label: t('srv.densityCozy') },
              { val: 'comfortable' as const, Icon: AlignJustify, label: t('srv.densityComfortable') },
            ]).map(({ val, Icon, label }) => (
              <button key={val} type="button" title={label} aria-label={label}
                onClick={() => setDensity(val)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors ${density === val ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}>
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing} title={t('common.refresh')}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          <OverflowMenu>
            <div className="sm:hidden">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('srv.density')}
              </div>
              {([
                { val: 'compact' as const, Icon: Rows3, label: t('srv.densityCompact') },
                { val: 'cozy' as const, Icon: Rows2, label: t('srv.densityCozy') },
                { val: 'comfortable' as const, Icon: AlignJustify, label: t('srv.densityComfortable') },
              ]).map(({ val, Icon, label }) => (
                <button key={val} onClick={() => setDensity(val)}
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent ${density === val ? 'bg-accent/60 text-foreground' : ''}`}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                  {density === val && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
                </button>
              ))}
              <OverflowSep />
            </div>
            {hasCap(profile, 'canAddServers') && (
              <OverflowItem icon={FolderPlus} onClick={() => setGroupDialog({ open: true, title: t('srv.createFolder'), confirmText: t('common.create'), editId: null })}>
                {t('srv.folder')}
              </OverflowItem>
            )}
            {hasCap(profile, 'canEditServers') && (
              <OverflowItem icon={Tags} onClick={() => autoGroupMut.mutate()}>
                {t('srv.autoGroupFromTags')}
              </OverflowItem>
            )}
            {hasCap(profile, 'canExportImportServers') && (
              <>
                <OverflowSep />
                <OverflowItem icon={FileJson} onClick={() => api.exportServers('json').catch((e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'))}>
                  {t('srv.export')} JSON
                </OverflowItem>
                <OverflowItem icon={FileSpreadsheet} onClick={() => api.exportServers('csv').catch((e: Error) => showToast(t('common.errorPrefix', { msg: e.message }), 'error'))}>
                  {t('srv.export')} CSV
                </OverflowItem>
                <OverflowItem icon={FileUp} onClick={() => fileInputRef.current?.click()}>
                  {t('srv.import')}
                </OverflowItem>
              </>
            )}
          </OverflowMenu>
          <input ref={fileInputRef} type="file" accept=".json,.csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
          </>
        }
      />

      {/* Bulk bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-2.5 shadow-sm animate-in fade-in slide-in-from-top-1 duration-200">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">{t('srv.selected', { count: selectedIds.size })}</span>
          <div className="ml-auto flex items-center gap-2">
            {hasCap(profile, 'canRunUpdates') && (
              <Button size="sm" onClick={handleBulkUpdate}>
                <Download className="h-3.5 w-3.5 mr-1" /> {t('srv.startUpdates')}
              </Button>
            )}
            {hasCap(profile, 'canRunPlaybooks') && (
              <Button size="sm" variant="outline" onClick={() => setPlaybookDialogOpen(true)}>
                <Play className="h-3.5 w-3.5 mr-1" /> {t('srv.runPlaybook')}
              </Button>
            )}
            <div className="h-5 w-px bg-border" />
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              <X className="h-3.5 w-3.5 mr-1" /> {t('srv.deselect')}
            </Button>
          </div>
        </div>
      )}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button"
            onClick={() => { setActiveTag(null); setPage(1); }}
            className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition-colors ${
              activeTag === null
                ? 'bg-primary text-primary-foreground border border-primary'
                : 'border border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            }`}>
            {t('srv.filterAll')}
          </button>
          {allTags.map(tag => {
            const active = activeTag === tag;
            return (
              <button key={tag} type="button"
                onClick={() => { setActiveTag(tag); setPage(1); }}
                className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground border border-primary'
                    : 'border border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}>
                <Hash className={`h-3 w-3 ${active ? '' : 'opacity-60'}`} />
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Main table card */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-2">
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={6} />)}
            </div>
          ) : servers.length === 0 ? (
            <EmptyState
              icon={<ServerIcon className="h-5 w-5" />}
              title={t('srv.noServers')}
              description={t('srv.noServersHint')}
              action={hasCap(profile, 'canAddServers') ? <CreateServerDialog /> : undefined}
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm" data-density={density}>
                  <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 w-9">
                        <input type="checkbox" className="rounded" checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected; }}
                          onChange={e => selectAll(e.target.checked)} />
                      </th>
                      <th className="px-1 py-2 w-3"></th>
                      <th className="px-3 py-2">{t('srv.colName')}</th>
                      <th className="px-3 py-2">{t('srv.colIp')}</th>
                      <th className="px-3 py-2">{t('srv.colOs')}</th>
                      <th className="px-3 py-2 w-[140px]">{t('srv.colCpu')}</th>
                      <th className="px-3 py-2 w-[140px]">{t('srv.colRam')}</th>
                      <th className="px-3 py-2 w-[140px]">{t('srv.colDisk')}</th>
                      <th className="px-3 py-2">{t('srv.colLastSeen')}</th>
                      <th className="px-3 py-2 w-[100px]">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  {useGroups ? (
                    <>
                      {/* Ungrouped */}
                      {serversByGroup.ungrouped.length > 0 && (
                        <tbody>
                          <tr className="hover:bg-accent/30"
                            onDragOver={e => { e.preventDefault(); setDragOverGroup('__root__'); }}
                            onDragLeave={() => setDragOverGroup(null)}
                            onDrop={e => { e.preventDefault(); handleDrop(null); }}>
                            <td colSpan={10}>
                              <div className={`flex items-center gap-2 py-2 px-3 ${dragOverGroup === '__root__' ? 'bg-accent/50' : ''}`}>
                                <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground text-sm">{t('srv.moveToRoot')}</span>
                                <Badge variant="secondary" className="text-[10px] ml-1">{serversByGroup.ungrouped.length}</Badge>
                              </div>
                            </td>
                          </tr>
                          {serversByGroup.ungrouped.map(s => renderServerRow(s))}
                        </tbody>
                      )}
                      {tree.map(node => renderGroupRow(node, 0, serversByGroup.map))}
                    </>
                  ) : (
                    <tbody className="divide-y">
                      {pageServers.map(s => renderServerRow(s))}
                    </tbody>
                  )}
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden">
                <div className="flex items-center gap-2 px-4 py-2 border-b">
                  <input type="checkbox" className="rounded" checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected; }}
                    onChange={e => selectAll(e.target.checked)} />
                  <span className="text-xs text-muted-foreground">{t('common.all')}</span>
                </div>
                <div className="divide-y">
                  {pageServers.map(s => {
                    const info = infoMap[s.id];
                    const cpuPct = info?.cpu_usage_pct ?? null;
                    const ramPct = info?.ram_total_mb ? Math.round((info.ram_used_mb! / info.ram_total_mb) * 100) : null;
                    const diskPct = info?.disk_total_gb ? Math.round((info.disk_used_gb! / info.disk_total_gb) * 100) : null;
                    return (
                      <div key={s.id} className={`px-4 py-3 cursor-pointer hover:bg-accent/40 ${selectedIds.has(s.id) ? 'bg-accent/20' : ''}`}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('input[type="checkbox"]') || (e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('a')) return;
                          navigate({ to: '/servers/$id', params: { id: s.id } });
                        }}>
                        <div className="flex items-start gap-2">
                          <input type="checkbox" className="rounded mt-1" checked={selectedIds.has(s.id)}
                            onChange={() => toggleSelect(s.id)} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {s.status === 'online' ? (
                                <LiveDot tone="success" className="flex-shrink-0" />
                              ) : (
                                <CircleDot className={`h-3 w-3 flex-shrink-0 ${s.status === 'offline' ? 'text-rose-500' : 'text-muted-foreground'}`} />
                              )}
                              <Link to="/servers/$id" params={{ id: s.id }} className="font-medium text-sm truncate hover:underline">{s.name}</Link>
                              <StatusBadge tone={s.status === 'online' ? 'success' : s.status === 'offline' ? 'danger' : 'muted'}>
                                {s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown')}
                              </StatusBadge>
                            </div>
                            {(s.tags || []).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {s.tags!.map(tag => <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>)}
                              </div>
                            )}
                            <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-muted-foreground">
                              <div><span className="block text-[10px] uppercase">{t('srv.colIp')}</span>{s.ip_address || '—'}</div>
                              <div><span className="block text-[10px] uppercase">{t('srv.colOs')}</span>{info?.os?.split(' ')[0] || '—'}</div>
                              <div><span className="block text-[10px] uppercase">{t('srv.colLastSeen')}</span>{fmtLastSeen(s)}</div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 mt-2">
                              <div><span className="block text-[10px] uppercase text-muted-foreground">{t('srv.colCpu')}</span><MetricBar pct={cpuPct} /></div>
                              <div><span className="block text-[10px] uppercase text-muted-foreground">{t('srv.colRam')}</span><MetricBar pct={ramPct} /></div>
                              <div><span className="block text-[10px] uppercase text-muted-foreground">{t('srv.colDisk')}</span><MetricBar pct={diskPct} /></div>
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5">
                            {hasCap(profile, 'canEditServers') && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                                <Link to="/servers/$id" params={{ id: s.id }}><Pencil className="h-3.5 w-3.5" /></Link>
                              </Button>
                            )}
                            {hasCap(profile, 'canDeleteServers') && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteServer(s.id, s.name)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Pagination (ungrouped only) */}
              {!useGroups && totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-2">
                  <span className="text-xs text-muted-foreground">
                    {t('srv.pageInfo', { from: (safePage - 1) * PAGE_SIZE + 1, to: Math.min(safePage * PAGE_SIZE, filtered.length), total: filtered.length })}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>‹</Button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                      .filter(i => totalPages <= 7 || Math.abs(i - safePage) <= 2 || i === 1 || i === totalPages)
                      .map((i, idx, arr) => {
                        const showEllipsis = idx > 0 && i - arr[idx - 1] > 1;
                        return (
                          <span key={i}>
                            {showEllipsis && <span className="px-1 text-muted-foreground">…</span>}
                            <Button size="sm" variant={i === safePage ? 'default' : 'ghost'} onClick={() => setPage(i)}>{i}</Button>
                          </span>
                        );
                      })}
                    <Button size="sm" variant="ghost" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>›</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Group dialog */}
      <GroupDialog
        open={groupDialog.open}
        onClose={() => setGroupDialog(prev => ({ ...prev, open: false }))}
        onSubmit={handleGroupDialogSubmit}
        title={groupDialog.title}
        confirmText={groupDialog.confirmText}
        groups={groups}
        editId={groupDialog.editId}
        defaultName={groupDialog.name}
        defaultColor={groupDialog.color}
        defaultParentId={groupDialog.parentId}
      />

      {/* Playbook run dialog */}
      <Dialog open={playbookDialogOpen} onOpenChange={v => {
        if (!v) {
          setPlaybookDialogOpen(false);
          setSelectedPlaybook('');
          setPlaybookTargets([]);
          setPlaybookUseAll(false);
          setPlaybookExcluded(new Set());
          setPlaybookExtraVars('');
        }
      }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('srv.runPlaybook')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('srv.runPlaybookHint', { count: selectedIds.size })}</p>
            <div className="space-y-1.5">
              <Label>{t('run.target')}</Label>
              <div className="flex flex-wrap gap-2 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={playbookUseAll}
                    onChange={(e) => {
                      setPlaybookUseAll(e.target.checked);
                      setPlaybookExcluded(new Set());
                    }}
                  />
                  {t('pb.allServers')}
                </label>
                {!playbookUseAll && playbookTargets.map(name => (
                  <span key={name} className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs">
                    {name}
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setPlaybookTargets(prev => prev.filter(v => v !== name))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {!playbookUseAll && (
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => setPlaybookTargets(servers.map(s => s.name))}>
                    {t('run.addAll')}
                  </button>
                )}
              </div>
              {playbookUseAll && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">{t('run.excludeHint')}</p>
                  <div className="max-h-44 overflow-y-auto rounded-md border p-2 space-y-1">
                    {servers.filter(s => s.name !== 'localhost').map(s => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={playbookExcluded.has(s.name)}
                          onChange={(e) => {
                            setPlaybookExcluded(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(s.name); else next.delete(s.name);
                              return next;
                            });
                          }}
                        />
                        <span>{s.name}</span>
                        <StatusBadge tone={s.status === 'online' ? 'success' : 'muted'} className="ml-auto">
                          {s.status === 'online' ? t('common.online') : t('common.offline')}
                        </StatusBadge>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('srv.selectPlaybook')}</Label>
              <select value={selectedPlaybook} onChange={e => setSelectedPlaybook(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <option value="">{t('srv.choosePlaybook')}</option>
                {(playbooks ?? []).filter(p => !p.isInternal).map(p => <option key={p.filename} value={p.filename}>{p.description || p.filename}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('run.extraVars')}</Label>
              <Input value={playbookExtraVars} onChange={e => setPlaybookExtraVars(e.target.value)} placeholder='{"key": "value"}' className="font-mono text-sm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setPlaybookDialogOpen(false); setSelectedPlaybook(''); setPlaybookTargets([]); setPlaybookUseAll(false); setPlaybookExcluded(new Set()); setPlaybookExtraVars(''); }}>{t('common.cancel')}</Button>
            <Button onClick={handleBulkRunPlaybook} disabled={!selectedPlaybook || (!playbookUseAll && playbookTargets.length === 0)}>{t('srv.runPlaybook')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!confirmDeleteServer}
        onOpenChange={(open) => { if (!open) setConfirmDeleteServer(null); }}
        title={t('common.delete')}
        description={<><div>{t('srv.confirmDelete', { name: confirmDeleteServer?.name || '' })}</div><div className="mt-2 text-xs">{t('srv.cantUndone')}</div></>}
        confirmLabel={t('common.delete')}
        variant="destructive"
        onConfirm={() => {
          if (!confirmDeleteServer) return;
          deleteMut.mutate(confirmDeleteServer.id);
          setSelectedIds(prev => { const n = new Set(prev); n.delete(confirmDeleteServer.id); return n; });
          setConfirmDeleteServer(null);
        }}
        isPending={deleteMut.isPending}
      />
      <ConfirmDialog
        open={!!confirmDeleteGroup}
        onOpenChange={(open) => { if (!open) setConfirmDeleteGroup(null); }}
        title={t('common.delete')}
        description={<><div>{t('srv.confirmDeleteFolder', { name: confirmDeleteGroup?.name || '' })}</div><div className="mt-2 text-xs">{t('srv.folderNote')}</div></>}
        confirmLabel={t('common.delete')}
        variant="destructive"
        onConfirm={() => {
          if (!confirmDeleteGroup) return;
          groupDeleteMut.mutate(confirmDeleteGroup.id);
          setConfirmDeleteGroup(null);
        }}
        isPending={groupDeleteMut.isPending}
      />
    </div>
  );
}
