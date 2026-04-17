import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Save, History, Download, Trash2, Key,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

interface ManifestResponse {
  content?: string;
  manifest?: unknown;
  version?: number | string;
}

interface ManifestVersion {
  version?: number | string;
  changelog?: string;
  created_at?: string;
}

interface ServerRow {
  id: number | string;
  name: string;
  ip_address?: string;
}

interface AgentStatus {
  installed?: boolean;
  version?: string;
  manifestVersion?: number | string;
  latestManifestVersion?: number | string;
  lastSeen?: string;
  state?: string;
  error?: string;
}

export function AgentPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('nav.agent')}</h1>
      <ManifestCard />
      <ServersCard />
    </div>
  );
}

function ManifestCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [version, setVersion] = useState<number | string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [changelog, setChangelog] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery<ManifestResponse>({
    queryKey: ['agent', 'manifest'],
    queryFn: async () => (await api.getAgentManifest()) as ManifestResponse,
  });

  useEffect(() => {
    if (!data) return;
    const content =
      typeof data.content === 'string'
        ? data.content
        : data.manifest != null
          ? JSON.stringify(data.manifest, null, 2)
          : '';
    setText(content);
    setVersion(data.version);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      try {
        JSON.parse(text);
      } catch {
        throw new Error(t('agent.manifestInvalidJson'));
      }
      return api.saveAgentManifest(text, changelog);
    },
    onSuccess: () => {
      setError(null);
      setSuccess(t('agent.manifestSaved'));
      setChangelog('');
      setSaveOpen(false);
      qc.invalidateQueries({ queryKey: ['agent', 'manifest'] });
      qc.invalidateQueries({ queryKey: ['agent', 'manifest-history'] });
      setTimeout(() => setSuccess(null), 3500);
    },
    onError: (err: unknown) => {
      setSuccess(null);
      setError((err as Error).message || t('agent.manifestLoadError'));
    },
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">{t('agent.manifestTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('agent.manifestHint')}</p>
            {version != null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('agent.manifestVersion', { version: String(version) })}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" /> {t('agent.manifestHistory')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              {t('agent.manifestReload')}
            </Button>
            <Button size="sm" onClick={() => setSaveOpen(true)} disabled={isLoading}>
              <Save className="h-4 w-4" /> {t('agent.manifestSave')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="min-h-[360px] font-mono text-xs"
          />
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {success && <p className="text-sm text-emerald-600 dark:text-emerald-400">{success}</p>}
      </CardContent>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agent.manifestSave')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="changelog">{t('agent.manifestChangelog')}</Label>
            <Input
              id="changelog"
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder={t('agent.manifestChangelogPlaceholder')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManifestHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </Card>
  );
}

function ManifestHistoryDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<ManifestVersion[]>({
    queryKey: ['agent', 'manifest-history'],
    queryFn: async () => ((await api.getAgentManifestHistory(50)) as unknown as ManifestVersion[]) ?? [],
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('agent.manifestHistory')}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('agent.manifestNoHistory')}</p>
          ) : (
            <ul className="divide-y">
              {data.map((v, i) => (
                <li key={i} className="py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-mono">v{String(v.version ?? '?')}</span>
                    <span className="text-xs text-muted-foreground">{v.created_at}</span>
                  </div>
                  {v.changelog && (
                    <p className="mt-1 text-xs text-muted-foreground">{v.changelog}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServersCard() {
  const { t } = useTranslation();
  const { data: servers, isLoading } = useQuery<ServerRow[]>({
    queryKey: ['servers'],
    queryFn: async () => (await api.getServers()) as unknown as ServerRow[],
  });

  return (
    <Card>
      <CardContent className="p-0">
        <div className="border-b p-4">
          <h2 className="text-lg font-medium">{t('agent.serversTitle')}</h2>
        </div>
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : !servers || servers.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">{t('agent.noServers')}</div>
        ) : (
          <ul className="divide-y">
            {servers.map((s) => <ServerAgentRow key={s.id} server={s} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ServerAgentRow({ server }: { server: ServerRow }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: status, refetch, isFetching } = useQuery<AgentStatus>({
    queryKey: ['agent', 'status', server.id],
    queryFn: async () => ((await api.getAgentStatus(server.id)) as unknown as AgentStatus) ?? {},
  });

  const installed = !!status?.installed;
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['agent', 'status', server.id] });
  };

  const install = useMutation({
    mutationFn: () => api.installAgent(server.id, {}),
    onSuccess: refreshAll,
  });
  const update = useMutation({
    mutationFn: () => api.updateAgent(server.id),
    onSuccess: refreshAll,
  });
  const rotate = useMutation({
    mutationFn: () => api.rotateAgentToken(server.id),
    onSuccess: refreshAll,
  });
  const remove = useMutation({
    mutationFn: () => api.removeAgent(server.id),
    onSuccess: refreshAll,
  });

  const onRemove = () => {
    if (window.confirm(t('agent.confirmRemove', { name: server.name }))) remove.mutate();
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{server.name}</span>
          <span className="text-xs text-muted-foreground">{server.ip_address}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 ${
              installed
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : status?.error
                  ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {installed
              ? t('agent.statusInstalled')
              : status?.error
                ? t('agent.statusError')
                : t('agent.statusNotInstalled')}
          </span>
          {installed && status?.version && (
            <span className="text-muted-foreground">
              {t('agent.version')}: <span className="font-mono">{status.version}</span>
            </span>
          )}
          {installed && status?.lastSeen && (
            <span className="text-muted-foreground">
              {t('agent.lastSeen')}: {status.lastSeen}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching} title={t('common.refresh')}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        {!installed ? (
          <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
            <Download className="h-4 w-4" /> {t('agent.install')}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => update.mutate()} disabled={update.isPending}>
              <Download className="h-4 w-4" /> {t('agent.update')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
              <Key className="h-4 w-4" /> {t('agent.rotate')}
            </Button>
            <Button variant="outline" size="sm" onClick={onRemove} disabled={remove.isPending}>
              <Trash2 className="h-4 w-4" /> {t('agent.remove')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
