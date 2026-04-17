import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Server, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface DashboardData {
  totalServers?: number;
  online?: number;
  offline?: number;
  updatesAvailable?: number;
  recentActivity?: Array<{ id?: number | string; message?: string; created_at?: string; type?: string }>;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.getDashboard()) as unknown as DashboardData,
    refetchInterval: 30_000,
  });

  const stats = [
    { label: t('dashboard.totalServers'),      value: data?.totalServers ?? 0,      Icon: Server,        accent: 'text-primary' },
    { label: t('dashboard.online'),            value: data?.online ?? 0,            Icon: CheckCircle2,  accent: 'text-emerald-500' },
    { label: t('dashboard.offline'),           value: data?.offline ?? 0,           Icon: XCircle,       accent: 'text-rose-500' },
    { label: t('dashboard.updatesAvailable'),  value: data?.updatesAvailable ?? 0,  Icon: RefreshCw,     accent: 'text-amber-500' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, Icon, accent }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className={`h-4 w-4 ${accent}`} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">{isLoading ? '—' : value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.recentActivity')}</CardTitle>
          <CardDescription>{isLoading ? t('common.loading') : null}</CardDescription>
        </CardHeader>
        <CardContent>
          {data?.recentActivity?.length ? (
            <ul className="divide-y">
              {data.recentActivity.slice(0, 10).map((entry, i) => (
                <li key={entry.id ?? i} className="flex items-center justify-between py-3">
                  <span className="text-sm">{entry.message || entry.type || '—'}</span>
                  {entry.created_at && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !isLoading && <p className="text-sm text-muted-foreground">{t('dashboard.empty')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
