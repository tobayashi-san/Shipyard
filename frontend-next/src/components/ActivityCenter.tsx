import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import {
  Activity, CheckCircle2, CircleDashed, Clock, FileCode2, Hammer,
  Layers3, RefreshCw, Trash2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { canAccessOperations, canViewActivity, hasCap, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { ws } from '@/lib/ws';
import { cn } from '@/lib/utils';

type ActivityStatus = 'running' | 'success' | 'failed';

interface ActivityItem {
  id: string;
  kind: 'update' | 'playbook' | 'schedule' | 'tofu' | 'task';
  title: string;
  subtitle?: string;
  status: ActivityStatus;
  startedAt: number;
  completedAt?: number;
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
  if (data.runId) return `tofu:${data.runId}`;
  if (data.historyId) return `history:${data.historyId}`;
  if (data.scheduleId) return `schedule:${data.scheduleId}`;
  return null;
}

function describeEvent(data: Record<string, unknown>, existing?: ActivityItem): Partial<ActivityItem> | null {
  const type = text(data.type);
  if (!type) return null;

  if (type.startsWith('tofu_')) {
    return {
      kind: 'tofu',
      title: existing?.title || `OpenTofu ${text(data.action) || 'run'}`,
      subtitle: data.vmName ? `VM ${text(data.vmName)}` : data.workspaceId ? `Legacy deployment ${text(data.workspaceId)}` : existing?.subtitle,
    };
  }

  if (type.startsWith('ansible_')) {
    return {
      kind: 'playbook',
      title: existing?.title || 'Playbook run',
      subtitle: data.historyId ? `Run ${text(data.historyId)}` : existing?.subtitle,
    };
  }

  if (type.startsWith('bulk_update_')) {
    return {
      kind: 'update',
      title: existing?.title || 'Bulk update',
      subtitle: data.historyId ? `Run ${text(data.historyId)}` : existing?.subtitle,
    };
  }

  if (type.startsWith('schedule_') || data.scheduleId) {
    return {
      kind: 'schedule',
      title: existing?.title || 'Scheduled playbook',
      subtitle: data.scheduleId ? `Schedule ${text(data.scheduleId)}` : existing?.subtitle,
    };
  }

  if (type.startsWith('update_')) {
    return {
      kind: data.historyId && String(data.historyId).includes('custom') ? 'task' : 'update',
      title: existing?.title || 'Server action',
      subtitle: data.serverId ? `Host ${text(data.serverId)}` : existing?.subtitle,
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
  if (data.type === 'tofu_done') return data.success === false ? 'OpenTofu failed' : 'OpenTofu completed';
  if (String(data.type || '').endsWith('_complete')) return data.success === false ? 'Completed with errors' : 'Completed';
  return '';
}

function formatAge(ts: number) {
  const diff = Math.max(0, now() - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  return `${Math.round(diff / 3_600_000)}h`;
}

function EnvironmentActivityCenter({
  environmentId,
  viewerKey,
  showOperationsLink,
  placement,
}: {
  environmentId: string;
  viewerKey: string;
  showOperationsLink: boolean;
  placement: 'floating' | 'header';
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>(() => loadActivities(environmentId, viewerKey));
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ws.connect();
    return ws.subscribe((raw) => {
      const data = raw as Record<string, unknown>;
      const id = eventId(data);
      if (!id) return;

      setItems(prev => {
        const idx = prev.findIndex(item => item.id === id);
        const existing = idx >= 0 ? prev[idx] : undefined;
        const desc = describeEvent(data, existing);
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
        };

        const next = idx >= 0
          ? [nextItem, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
          : [nextItem, ...prev];
        return next.slice(0, 30);
      });
    });
  }, [t]);

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
        <div className={cn('w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-[3px] border border-border-strong bg-popover text-popover-foreground shadow-xl', placement === 'header' ? 'fixed inset-x-3 top-12 md:absolute md:inset-x-auto md:right-0 md:top-9' : 'mb-2')}>
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
              title={t('activity.clearCompleted')}
              onClick={() => setItems(prev => prev.filter(item => item.status === 'running'))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

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
                        'bg-destructive/10 text-destructive'
                  )}>
                    {kindIcon(item.kind)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      {statusIcon(item.status)}
                    </div>
                    {item.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                    )}
                    {item.lastLine && (
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{item.lastLine}</div>
                    )}
                  </div>
                  <div className="whitespace-nowrap pt-0.5 text-[11px] text-muted-foreground">
                    {formatAge(item.completedAt || item.startedAt)}
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
  return <EnvironmentActivityCenter key={instanceKey} environmentId={environmentId} viewerKey={viewerKey} showOperationsLink={canAccessOperations(profile)} placement={placement} />;
}
