import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search, Server as ServerIcon, CircleDot } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CreateServerDialog } from '@/components/CreateServerDialog';

interface ServerRow {
  id: number | string;
  name: string;
  ip_address?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: 'online' | 'offline' | string;
  group_name?: string;
  tags?: string[] | string;
}

export function ServersPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<ServerRow[]>({
    queryKey: ['servers'],
    queryFn: async () => (await api.getServers()) as unknown as ServerRow[],
  });

  const rows = (data ?? []).filter((s) => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      s.name?.toLowerCase().includes(needle) ||
      s.ip_address?.toLowerCase().includes(needle) ||
      s.group_name?.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('servers.title')}</h1>
        <CreateServerDialog />
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} className="pl-8" />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <ServerIcon className="h-8 w-8" />
              <span className="text-sm">{t('servers.noServers')}</span>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">{t('common.name')}</th>
                  <th className="px-4 py-2">{t('servers.host')}</th>
                  <th className="px-4 py-2">{t('servers.user')}</th>
                  <th className="px-4 py-2">{t('servers.group')}</th>
                  <th className="px-4 py-2">{t('common.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((s) => (
                  <tr key={s.id} className="hover:bg-accent/40">
                    <td className="px-4 py-3 font-medium">
                      <Link to="/servers/$id" params={{ id: String(s.id) }} className="hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {s.ip_address}{s.ssh_port ? `:${s.ssh_port}` : ''}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{s.ssh_user || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.group_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <CircleDot className={`h-3 w-3 ${s.status === 'online' ? 'text-emerald-500' : s.status === 'offline' ? 'text-rose-500' : 'text-muted-foreground'}`} />
                        {s.status ? t(`common.${s.status}` as 'common.online' | 'common.offline') : t('common.unknown')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
