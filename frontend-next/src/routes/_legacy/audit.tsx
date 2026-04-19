import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ScrollText } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

interface AuditRow {
  action?: string;
  user?: string;
  detail?: string;
  ip?: string;
  success?: 0 | 1 | boolean;
  created_at?: string;
}

interface AuditMeta {
  actions: string[];
  users: string[];
  count: number;
}

interface Filters {
  action: string;
  user: string;
  success: string;
  from: string;
  to: string;
}

const PAGE_SIZE = 100;

const EMPTY_FILTERS: Filters = { action: '', user: '', success: '', from: '', to: '' };

export function AuditPage() {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [accumulated, setAccumulated] = useState<AuditRow[]>([]);

  const { data: meta } = useQuery<AuditMeta>({
    queryKey: ['audit', 'meta'],
    queryFn: async () =>
      ((await api.getAuditMeta()) as unknown as AuditMeta) ?? { actions: [], users: [], count: 0 },
  });

  const queryParams = { ...filters, limit: PAGE_SIZE, offset };

  const { data: rows, isLoading, isFetching, refetch } = useQuery<AuditRow[]>({
    queryKey: ['audit', queryParams],
    queryFn: async () => {
      const res = (await api.getAuditLog(queryParams)) as unknown as AuditRow[];
      const list = Array.isArray(res) ? res : [];
      if (offset === 0) {
        setAccumulated(list);
      } else {
        setAccumulated((prev) => prev.concat(list));
      }
      return list;
    },
  });

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setOffset(0);
    setAccumulated([]);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const reset = () => {
    setOffset(0);
    setAccumulated([]);
    setFilters(EMPTY_FILTERS);
  };

  const loadMore = () => setOffset((o) => o + PAGE_SIZE);

  const list = accumulated;
  const hasMore = (rows?.length ?? 0) === PAGE_SIZE;

  const selectClass =
    'flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('audit.title')}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t('audit.total', { n: meta?.count ?? 0 })} · {t('audit.retention')}
            </span>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('audit.filterAction')}</label>
              <select
                className={selectClass}
                value={filters.action}
                onChange={(e) => updateFilter('action', e.target.value)}
              >
                <option value="">{t('audit.filterAll')}</option>
                {meta?.actions?.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('audit.filterUser')}</label>
              <select
                className={selectClass}
                value={filters.user}
                onChange={(e) => updateFilter('user', e.target.value)}
              >
                <option value="">{t('audit.filterAll')}</option>
                {meta?.users?.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('audit.filterStatus')}</label>
              <select
                className={selectClass}
                value={filters.success}
                onChange={(e) => updateFilter('success', e.target.value)}
              >
                <option value="">{t('audit.filterAll')}</option>
                <option value="1">{t('audit.statusOk')}</option>
                <option value="0">{t('audit.statusFailed')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('audit.filterFrom')}</label>
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => updateFilter('from', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('audit.filterTo')}</label>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => updateFilter('to', e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button variant="outline" size="sm" onClick={reset} className="w-full">
                {t('audit.filterReset')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && list.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <ScrollText className="h-8 w-8 opacity-60" />
              <span className="text-sm">{t('audit.empty')}</span>
            </div>
          ) : (
            <ul className="divide-y">
              {list.map((r, i) => {
                const ok = !!r.success;
                return (
                  <li key={i} className="flex items-start justify-between gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{r.action || '—'}</span>
                        {r.user && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {r.user}
                          </span>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {r.detail || '—'}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {t('audit.ip')}: {r.ip || '—'}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          ok
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : 'bg-red-500/15 text-red-600 dark:text-red-400'
                        }`}
                      >
                        {ok ? t('audit.statusOk') : t('audit.statusFailed')}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{r.created_at || ''}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={isFetching}>
                {t('audit.loadMore')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
