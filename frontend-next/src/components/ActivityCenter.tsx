import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, CheckCircle2, CircleDashed, Clock, FileCode2, Hammer,
  Layers3, MinusCircle, RefreshCw, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, apiFetch, ApiError } from '@/lib/api';
import { canAccessOperations, canViewActivity, hasCap, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { ws } from '@/lib/ws';
import { cn, formatDateTime } from '@/lib/utils';

type ActivityStatus = 'running' | 'success' | 'failed' | 'interrupted';

interface ActivityItem {
  id: string;
  kind: 'update' | 'playbook' | 'schedule' | 'tofu' | 'task';
  title: string;
  subtitle?: string;
  status: ActivityStatus;
  startedAt: number;
  completedAt?: number;
  executionId?: string;
  lastLine?: string;
}

const ACTIVITY_STORAGE_KEY = 'fleet.activity.v2';

function activityStorageKey(environmentId: string, viewerKey: string) {
  return `${ACTIVITY_STORAGE_KEY}.${viewerKey}.${environmentId}`;
}

function loadActivities(environmentId: string, viewerKey: string): ActivityItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem(activityStorageKey(environmentId, viewerKey)) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is ActivityItem => Boolean(item && typeof item.id === 'string' && typeof item.startedAt === 'number'))
      .slice(0, 30);
  } catch { return []; }
}

function now() {
  return Date.now();
}

function text(value: unknown) {
  return String(value ?? '').trim();
}

function compactLine(value: unknown) {
  const lines = String(value ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

function statusIcon(status: ActivityStatus) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === 'interrupted') return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
  return <CircleDashed className="h-4 w-4 animate-spin text-primary" />;
}

function kindIcon(kind: ActivityItem['kind']) {
  if (kind === 'playbook') return <FileCode2 className="h-4 w-4" />;
  if (kind === 'schedule') return <Clock className="h-4 w-4" />;
  if (kind === 'tofu') return <Layers3 className="h-4 w-4" />;
  if (kind === 'task') return <Hammer className="h-4 w-4" />;
  return <RefreshCw className="h-4 w-4" />;
}

function eventId(data: Record<string, unknown>) {
  if (data.scheduleId) return `schedule:${data.scheduleId}`;
  if (data.runId) return `tofu:${data.runId}`;
  if (data.historyId) return `history:${data.historyId}`;
  return null;
}

function describeEvent(data: Record<string, unknown>, serverNames: Map<string, string>, existing?: ActivityItem): Partial<ActivityItem> | null {
  const type = text(data.type);
  if (!type) return null;

  if (type.startsWith('tofu_')) {
    return {
      kind: 'tofu',
      title: existing?.title || `OpenTofu ${text(data.action) || 'run'}`,
      subtitle: data.vmName ? `VM ${text(data.vmName)}` : data.workspaceName ? `Deployment ${text(data.workspaceName)}` : existing?.subtitle || 'Infrastructure deployment',
    };
  }

  if (type.startsWith('ansible_')) {
    return {
      kind: 'playbook',
      title: existing?.title || 'Playbook run',
      subtitle: data.playbook ? `Playbook ${text(data.playbook)}` : existing?.subtitle || 'Playbook execution',
    };
  }

  if (type.startsWith('bulk_update_')) {
    return {
      kind: 'update',
      title: existing?.title || 'Bulk update',
      subtitle: existing?.subtitle || 'Multiple managed hosts',
    };
  }

  if (type.startsWith('schedule_') || data.scheduleId) {
    return {
      kind: 'schedule',
      title: existing?.title || 'Scheduled playbook',
      subtitle: data.name ? text(data.name) : existing?.subtitle || 'Scheduled workflow',
    };
  }

  if (type.startsWith('update_')) {
    return {
      kind: data.historyId && String(data.historyId).includes('custom') ? 'task' : 'update',
      title: existing?.title || 'Server action',
      subtitle: data.serverId ? `Host ${serverNames.get(text(data.serverId)) || 'Managed host'}` : existing?.subtitle,
    };
  }

  return null;
}

function eventStatus(data: Record<string, unknown>, current: ActivityStatus): ActivityStatus {
  const type = text(data.type);
  if (type.endsWith('_error')) return 'failed';
  if (type.endsWith('_complete') || type === 'tofu_done') return data.success === false ? 'failed' : 'success';
  if (type.endsWith('_start') || type.endsWith('_output')) return 'running';
  return current;
}

function eventLine(data: Record<string, unknown>) {
  if (data.error) return text(data.error);
  if (data.data) return compactLine(data.data);
  if (data.type === 'tofu_done') return data.success === false ? '' : 'OpenTofu completed';
  if (String(data.type || '').endsWith('_complete')) return data.success === false ? '' : 'Completed';
  return '';
}

/** Status recorded by the server for an execution this browser still shows as running. */
function recordedStatus(status: unknown): ActivityStatus | null {
  const value = text(status).toLowerCase();
  if (['success', 'successful', 'completed'].includes(value)) return 'success';
  if (['failed', 'error'].includes(value)) return 'failed';
  if (['interrupted', 'cancelled', 'canceled', 'skipped', 'unknown'].includes(value)) return 'interrupted';
  return null;
}

function formatAge(ts: number) {
  const diff = Math.max(0, now() - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function EnvironmentActivityCenter({
  environmentId,
  viewerKey,
  showOperationsLink,
  placement,
  canLoadHostNames,
}: {
  environmentId: string;
  viewerKey: string;
  showOperationsLink: boolean;
  placement: 'floating' | 'header';
  canLoadHostNames: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>(() => loadActivities(environmentId, viewerKey));
  const panelRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const serversQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['servers', environmentId],
    queryFn: () => api.getServers(environmentId) as unknown as Promise<Array<{ id: string; name: string }>>,
    enabled: canLoadHostNames,
  });
  const serverNames = useMemo(
    () => new Map((serversQuery.data || []).map(server => [String(server.id), server.name])),
    [serversQuery.data],
  );

  useEffect(() => {
    ws.connect();
    return ws.subscribe((raw) => {
      const data = raw as Record<string, unknown>;
      const id = eventId(data);
      if (!id) return;

      setItems(prev => {
        const idx = prev.findIndex(item => item.id === id);
        const existing = idx >= 0 ? prev[idx] : undefined;
        const desc = describeEvent(data, serverNames, existing);
        if (!desc) return prev;

        const status = eventStatus(data, existing?.status || 'running');
        const line = eventLine(data) || existing?.lastLine;
        const nextItem: ActivityItem = {
          id,
          kind: desc.kind || existing?.kind || 'task',
          title: desc.title || existing?.title || t('activity.itemFallback'),
          subtitle: desc.subtitle || existing?.subtitle,
          status,
          startedAt: existing?.startedAt || now(),
          completedAt: status === 'running' ? undefined : (existing?.completedAt || now()),
          lastLine: line,
          executionId: text(data.type).startsWith('tofu_') && data.dbRunId ? `deployment-${text(data.dbRunId)}` : text(data.type).startsWith('ansible_') && data.historyId ? `workflow-${text(data.historyId)}` : text(data.type).startsWith('schedule_') && data.runId ? `workflow-${text(data.runId)}` : text(data.type).startsWith('update_') && data.historyId && !text(data.historyId).includes('custom') ? `host-${text(data.historyId)}` : existing?.executionId,
        };

        const next = idx >= 0
          ? [nextItem, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
          : [nextItem, ...prev];
        return next.slice(0, 30);
      });
    });
  }, [serverNames, t]);

  // Live events stop when Fleet restarts (for example after restarting its own
  // container), so a running entry may never receive its completion. Ask the
  // server for the recorded status on load and whenever the drawer opens.
  useEffect(() => {
    if (!showOperationsLink) return;
    const pending = itemsRef.current.filter(item => item.status === 'running' && item.executionId);
    if (!pending.length) return;
    let cancelled = false;
    void Promise.all(pending.map(async item => {
      try {
        const row = await apiFetch<{ status?: string }>(`/operations/${encodeURIComponent(item.executionId!)}/details`, { environmentId });
        return [item.id, recordedStatus(row.status)] as const;
      } catch (error) {
        // A pruned or deleted execution will never report a result.
        return [item.id, error instanceof ApiError && error.status === 404 ? 'interrupted' as const : null] as const;
      }
    })).then(results => {
      if (cancelled) return;
      const resolved = new Map(results.filter(([, status]) => status));
      if (!resolved.size) return;
      setItems(prev => prev.map(item => {
        const status = item.status === 'running' ? resolved.get(item.id) : undefined;
        return status ? { ...item, status, completedAt: now(), lastLine: status === 'interrupted' ? 'No live completion received; see the recorded execution.' : item.lastLine } : item;
      }));
    });
    return () => { cancelled = true; };
  }, [open, environmentId, showOperationsLink]);

  // Keep the activity drawer useful after a page reload, but never retain an
  // unbounded amount of operational data in the browser or mix environments.
  useEffect(() => {
    try { localStorage.setItem(activityStorageKey(environmentId, viewerKey), JSON.stringify(items.slice(0, 30))); } catch { /* storage unavailable */ }
  }, [environmentId, items, viewerKey]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const runningCount = items.filter(item => item.status === 'running').length;
  const completedCount = items.length - runningCount;
  const visibleItems = useMemo(() => items.slice(0, 20), [items]);

  return (
    <div ref={panelRef} className={cn('z-40 flex flex-col items-end', placement === 'header' ? 'relative' : 'fixed bottom-4 right-4')}>
      {open && (
        <div className={cn('w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-panel border border-border-strong bg-popover text-popover-foreground shadow-xl', placement === 'header' ? 'fixed inset-x-3 top-12 md:absolute md:inset-x-auto md:right-0 md:top-9' : 'mb-2')}>
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <div className="text-sm font-semibold">{t('activity.title')}</div>
              <div className="text-xs text-muted-foreground">
                {t('activity.counts', { running: runningCount, recent: completedCount })}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t('activity.clearCompleted')} aria-label={t('activity.clearCompleted')}
              onClick={() => setItems(prev => prev.filter(item => item.status === 'running'))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <p className="border-b px-3 py-2 text-xs text-muted-foreground">Live events received by this browser for your account and current environment. Keeps 30 events; displays the latest 20. Open Operations for the complete recorded history.</p>
          <div className="max-h-[420px] overflow-y-auto">
            {visibleItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
                <Activity className="h-6 w-6 opacity-50" />
                <span>{t('activity.empty')}</span>
              </div>
            ) : (
              visibleItems.map(item => (
                <div key={item.id} className="flex gap-2.5 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/25">
                  <div className={cn(
                    'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-sm',
                    item.status === 'running' ? 'bg-primary/10 text-primary' :
                      item.status === 'success' ? 'bg-emerald-500/10 text-emerald-500' :
                        item.status === 'interrupted' ? 'bg-muted text-muted-foreground' :
                          'bg-destructive/10 text-destructive'
                  )}>
                    {kindIcon(item.kind)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      {statusIcon(item.status)}
                    </div>
                    {showOperationsLink && item.executionId && <Link to="/operations/executions/$id" params={{id: item.executionId}} search={{environment: environmentId}} onClick={() => setOpen(false)} className="text-xs text-primary hover:underline">Open execution</Link>}
                    {item.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                    )}
                    {(item.lastLine || item.status === 'failed') && (
                      <div
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={item.status === 'failed' ? (item.lastLine || 'No failure detail was reported') : item.lastLine}
                      >
                        {item.status === 'failed'
                          ? `Cause: ${item.lastLine && item.lastLine !== 'Completed with errors' ? item.lastLine : 'No detail reported; open Operations for the recorded log.'}`
                          : item.lastLine}
                      </div>
                    )}
                  </div>
                  <div className="whitespace-nowrap pt-0.5 text-[11px] text-muted-foreground" title={`First observed in this browser: ${formatDateTime(item.startedAt)}${item.completedAt ? ` · Completion received: ${formatDateTime(item.completedAt)}` : ''}`}>
                    {item.completedAt ? 'Completion received ' : 'Observed '}{formatAge(item.completedAt || item.startedAt)}
                  </div>
                </div>
              ))
            )}
          </div>
          {showOperationsLink && <div className="border-t bg-muted/20 px-3 py-2">
            <Link to="/operations" onClick={() => setOpen(false)} className="block rounded-sm px-1 py-1 text-xs font-medium text-primary hover:underline">
              Open all tasks & events
            </Link>
          </div>}
        </div>
      )}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(v => !v)}
        className={cn('relative gap-2 border bg-background/90 shadow-sm backdrop-blur', placement === 'header' ? 'h-8 w-8 px-0' : 'h-9')}
        title={t('activity.title')}
      >
        <Activity className="h-4 w-4" />
        {placement === 'floating' && <span className="hidden sm:inline">{t('activity.trigger')}</span>}
        {runningCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {runningCount}
          </span>
        )}
      </Button>
    </div>
  );
}

export function ActivityCenter({ placement = 'floating' }: { placement?: 'floating' | 'header' }) {
  const environmentId = useUi(state => state.environmentId);
  const { data: profile } = useProfile();
  if (!canViewActivity(profile)) return null;

  const capabilityFingerprint = [
    'canViewDeployments', 'canManageDeployments', 'canViewSchedules',
    'canViewPlaybooks', 'canViewUpdates', 'canViewDocker', 'canViewCustomUpdates',
  ].map(capability => hasCap(profile, capability) ? '1' : '0').join('');
  const viewerKey = `${String(profile?.id ?? profile?.username ?? 'anonymous')}.${capabilityFingerprint}`;
  const instanceKey = `${viewerKey}.${environmentId}`;
  return <EnvironmentActivityCenter key={instanceKey} environmentId={environmentId} viewerKey={viewerKey} showOperationsLink={canAccessOperations(profile)} placement={placement} canLoadHostNames={hasCap(profile, 'canViewServers')} />;
}
