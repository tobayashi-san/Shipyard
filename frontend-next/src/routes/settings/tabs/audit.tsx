import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, RotateCw, ClipboardList } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SettingsSection } from '../_row';

interface AuditMeta { actions?: string[]; users?: string[]; count?: number }
interface AuditRow {
  action?: string;
  user?: string;
  detail?: string;
  ip?: string;
  success?: 0 | 1 | boolean;
  created_at?: string;
}

interface Filters {
  action: string;
  user: string;
  success: '' | '0' | '1';
  from: string;
  to: string;
  limit: number;
  offset: number;
}

const initialFilters: Filters = { action: '', user: '', success: '', from: '', to: '', limit: 100, offset: 0 };

export function AuditTab() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [allRows, setAllRows] = useState<AuditRow[]>([]);

  const metaQ = useQuery<AuditMeta>({
    queryKey: ['audit-meta'],
    queryFn: () => api.getAuditMeta() as unknown as Promise<AuditMeta>,
    staleTime: 60_000,
  });

  // Build a stable params object excluding empty values
  const buildParams = (f: Filters): Record<string, string | number> => {
    const out: Record<string, string | number> = { limit: f.limit, offset: f.offset };
    if (f.action) out.action = f.action;
    if (f.user)   out.user = f.user;
    if (f.success !== '') out.success = f.success;
    if (f.from)   out.from = f.from;
    if (f.to)     out.to = f.to;
    return out;
  };

  const rowsQ = useQuery<AuditRow[]>({
    queryKey: ['audit-log', filters.action, filters.user, filters.success, filters.from, filters.to, filters.limit, filters.offset],
    queryFn: () => api.getAuditLog(buildParams(filters)) as unknown as Promise<AuditRow[]>,
  });

  useEffect(() => {
    if (!rowsQ.data) return;
    if (filters.offset === 0) setAllRows(rowsQ.data);
    else setAllRows((prev) => [...prev, ...rowsQ.data]);
  }, [rowsQ.data, filters.offset]);

  // Reset accumulator when filters (except offset) change
  const resetAndSet = (patch: Partial<Filters>) => {
    setAllRows([]);
    setFilters((f) => ({ ...f, ...patch, offset: 0 }));
  };

  const meta = metaQ.data || { actions: [], users: [], count: 0 };
  const hasMore = (rowsQ.data?.length || 0) >= filters.limit;

  return (
    <SettingsSection icon={<ScrollText className="h-4 w-4" />} title={t('set.auditTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 pb-2">
        <span className="text-[11px] text-muted-foreground">
          {t('set.auditTotal', { n: meta.count || 0 })} · {t('set.auditRetention')}
        </span>
        <Button
          variant="secondary" size="sm"
          onClick={() => { setAllRows([]); setFilters((f) => ({ ...f, offset: 0 })); rowsQ.refetch(); metaQ.refetch(); }}
        >
          <RotateCw className="h-4 w-4" /> {t('set.auditRefresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2 pb-3">
        <Field label={t('set.auditFilterAction')}>
          <SelectInput value={filters.action} onChange={(v) => resetAndSet({ action: v })}>
            <option value="">{t('set.auditFilterAll')}</option>
            {(meta.actions || []).map((a) => <option key={a} value={a}>{a}</option>)}
          </SelectInput>
        </Field>
        <Field label={t('set.auditFilterUser')}>
          <SelectInput value={filters.user} onChange={(v) => resetAndSet({ user: v })}>
            <option value="">{t('set.auditFilterAll')}</option>
            {(meta.users || []).map((u) => <option key={u} value={u}>{u}</option>)}
          </SelectInput>
        </Field>
        <Field label={t('set.auditFilterStatus')}>
          <SelectInput value={filters.success} onChange={(v) => resetAndSet({ success: v as Filters['success'] })}>
            <option value="">{t('set.auditFilterAll')}</option>
            <option value="1">{t('set.auditStatusOk')}</option>
            <option value="0">{t('set.auditStatusFailed')}</option>
          </SelectInput>
        </Field>
        <Field label={t('set.auditFilterFrom')}>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => resetAndSet({ from: e.target.value })}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          />
        </Field>
        <Field label={t('set.auditFilterTo')}>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => resetAndSet({ to: e.target.value })}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          />
        </Field>
        <Button
          variant="secondary" size="sm"
          onClick={() => { setAllRows([]); setFilters(initialFilters); }}
          className="h-8 text-xs"
        >
          {t('set.auditFilterReset')}
        </Button>
      </div>

      {rowsQ.isLoading && allRows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : rowsQ.isError ? (
        <div className="py-4 text-sm text-destructive">
          {t('set.auditLoadError')}: {(rowsQ.error as Error)?.message}
        </div>
      ) : allRows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
          <ClipboardList className="h-6 w-6 opacity-40" />
          <span>{t('set.auditEmpty')}</span>
        </div>
      ) : (
        <div>
          {allRows.map((r, i) => (
            <div
              key={i}
              className={`flex items-start justify-between gap-3 py-3 ${i === allRows.length - 1 ? '' : 'border-b border-border/60'}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs">{r.action || ''}</code>
                  {r.user && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{r.user}</span>
                  )}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {r.detail || '—'}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t('set.auditIp')}: {r.ip || '—'}
                </div>
              </div>
              <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                <Badge variant={r.success ? 'success' : 'destructive'} className="text-[11px]">
                  {r.success ? t('set.auditStatusOk') : t('set.auditStatusFailed')}
                </Badge>
                <span className="text-[11px] text-muted-foreground">{r.created_at || ''}</span>
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="py-3 text-center">
              <Button
                variant="secondary" size="sm"
                onClick={() => setFilters((f) => ({ ...f, offset: allRows.length }))}
                disabled={rowsQ.isFetching}
              >
                {t('set.auditShowMore')}
              </Button>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function SelectInput({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 min-w-[110px] rounded-md border border-input bg-background px-2 text-xs"
    >
      {children}
    </select>
  );
}
