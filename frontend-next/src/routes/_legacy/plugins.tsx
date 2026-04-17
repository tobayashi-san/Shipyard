import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { Puzzle, RefreshCw, ArrowLeft } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { ws } from '@/lib/ws';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface PluginInfo {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  enabled?: boolean;
  hasUi?: boolean;
}

interface PluginCtxState {
  currentView: string;
  selectedServerId: string | number | null;
  servers: unknown[];
  plugins: PluginInfo[];
  user: unknown;
  whiteLabel: Record<string, unknown>;
}

interface PluginCtx {
  api: { request: typeof apiFetch } & typeof api;
  pluginApi: { request: (path: string, options?: Parameters<typeof apiFetch>[1]) => Promise<unknown> };
  state: PluginCtxState;
  navigate: (to: string) => void;
  refreshServersState: () => Promise<unknown[]>;
  showToast: (msg: string, kind?: string) => void;
  showConfirm: (msg: string) => Promise<boolean>;
  onWsMessage: (fn: (data: unknown) => void) => () => void;
}

interface PluginModule {
  mount?: (container: HTMLElement, ctx: PluginCtx) => void | Promise<void>;
  unmount?: () => void | Promise<void>;
}

export function PluginsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: plugins, isLoading } = useQuery<PluginInfo[]>({
    queryKey: ['plugins'],
    queryFn: async () => ((await api.getPlugins()) as unknown as PluginInfo[]) ?? [],
  });

  const enable = useMutation({
    mutationFn: (id: string) => api.enablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.disablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
  const reload = useMutation({
    mutationFn: () => api.reloadPlugins(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t('plugins.title')}</h1>
        <Button variant="outline" size="sm" onClick={() => reload.mutate()} disabled={reload.isPending}>
          <RefreshCw className={`h-4 w-4 ${reload.isPending ? 'animate-spin' : ''}`} />
          {t('plugins.reload')}
        </Button>
      </div>

      {isLoading ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">{t('common.loading')}</CardContent></Card>
      ) : !plugins || plugins.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <Puzzle className="h-8 w-8 opacity-60" />
            <span className="text-sm">{t('plugins.empty')}</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {plugins.map((p) => (
            <Card key={p.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium">{p.name || p.id}</h3>
                    <p className="text-xs text-muted-foreground">{p.id}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      p.enabled
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {p.enabled ? t('common.online') : t('common.offline')}
                  </span>
                </div>
                {p.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                )}
                <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  {p.version && <span>{t('plugins.version')}: {p.version}</span>}
                  {p.author && <span>{t('plugins.author')}: {p.author}</span>}
                </div>
                <div className="flex gap-2 pt-1">
                  {p.enabled ? (
                    <Button variant="outline" size="sm" onClick={() => disable.mutate(p.id)} disabled={disable.isPending}>
                      {t('plugins.disable')}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => enable.mutate(p.id)} disabled={enable.isPending}>
                      {t('plugins.enable')}
                    </Button>
                  )}
                  {p.enabled && p.hasUi !== false && (
                    <Link to="/plugins/$id" params={{ id: p.id }}>
                      <Button size="sm">{t('plugins.open')}</Button>
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function PluginHostPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/_protected/plugins/$id' });
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const moduleRef = useRef<PluginModule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { data: plugins } = useQuery<PluginInfo[]>({
    queryKey: ['plugins'],
    queryFn: async () => ((await api.getPlugins()) as unknown as PluginInfo[]) ?? [],
  });

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);

    (async () => {
      try {
        const mod: PluginModule = await import(/* @vite-ignore */ `/plugins/${id}/ui.js?v=${Date.now()}`);
        if (cancelled) return;
        moduleRef.current = mod;

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = '';

        if (typeof mod.mount !== 'function') {
          setError(t('plugins.noUi'));
          setLoading(false);
          return;
        }

        const ctx: PluginCtx = {
          api: { request: apiFetch, ...api },
          pluginApi: {
            request: (path, options) => apiFetch(`/plugin/${id}${path}`, options),
          },
          state: {
            currentView: 'plugin',
            selectedServerId: null,
            servers: [],
            plugins: plugins ?? [],
            user: null,
            whiteLabel: {},
          },
          navigate: (to: string) => navigate({ to }),
          refreshServersState: async () => {
            try { return ((await api.getServers()) as unknown as unknown[]) ?? []; }
            catch { return []; }
          },
          showToast: (msg) => { console.info('[plugin toast]', msg); },
          showConfirm: async (msg) => window.confirm(msg),
          onWsMessage: (fn) => ws.subscribe(fn),
        };

        await mod.mount(container, ctx);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.error(`[plugins] failed to load "${id}"`, e);
        setError(`${t('plugins.loadError')}: ${(e as Error).message}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      const mod = moduleRef.current;
      moduleRef.current = null;
      if (mod && typeof mod.unmount === 'function') {
        try {
          const r = mod.unmount();
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            (r as Promise<unknown>).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      }
      const container = containerRef.current;
      if (container) container.innerHTML = '';
    };
  }, [id, navigate, t, plugins]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/settings/$tab" params={{ tab: 'plugins' }}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" /> {t('plugins.back')}
          </Button>
        </Link>
        <h1 className="text-lg font-medium">{id}</h1>
        <div className="w-24" />
      </div>

      {loading && !error && (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">{t('common.loading')}</CardContent></Card>
      )}
      {error && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <Puzzle className="h-8 w-8 opacity-60" />
            <span className="text-sm">{error}</span>
          </CardContent>
        </Card>
      )}
      <div ref={containerRef} className="plugin-host" />
    </div>
  );
}
