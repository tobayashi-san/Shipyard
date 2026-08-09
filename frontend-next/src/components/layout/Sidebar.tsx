import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Anchor, LayoutDashboard, Server, FileCode2, Puzzle,
  Search, Box, Terminal, Shield, Boxes, Network,
} from 'lucide-react';
import { useUi } from '@/lib/store';
import { LOGO_ICONS } from '@/routes/settings/tabs/appearance';
import { cn } from '@/lib/utils';
import { useProfile, usePlugins, useSettings, hasCap, canSeePlugin } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface NavEntry {
  to: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  cap?: string;
  matchPrefix?: string;
}

const mainEntries: NavEntry[] = [
  { to: '/',          label: 'nav.dashboard', Icon: LayoutDashboard },
  { to: '/servers',   label: 'nav.servers',   Icon: Server,   cap: 'canViewServers',   matchPrefix: '/servers' },
  { to: '/playbooks', label: 'nav.playbooks', Icon: FileCode2, cap: 'canViewPlaybooks', matchPrefix: '/playbooks' },
];

function pluginIconFromClass(iconClass?: string) {
  const icon = String(iconClass || '').trim();
  if (!icon) return Puzzle;
  if (icon.includes('fa-cube')) return Box;
  if (icon.includes('fa-terminal')) return Terminal;
  if (icon.includes('fa-server')) return Server;
  if (icon.includes('fa-shield')) return Shield;
  if (icon.includes('fa-cubes')) return Boxes;
  if (icon.includes('fa-network')) return Network;
  if (icon.includes('fa-anchor') || icon.includes('fa-ship')) return Anchor;
  return Puzzle;
}

/* ── Sidebar ──────────────────────────────────────────────────────────── */
export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { t } = useTranslation();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: profile } = useProfile();
  const { data: pluginsData } = usePlugins();
  const { data: settings } = useSettings();

  // Online server count for badge
  const { data: rawServers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers() as Promise<{ status?: string }[]>,
    staleTime: 30_000,
  });
  const onlineCount = (Array.isArray(rawServers) ? rawServers : []).filter(s => s.status === 'online').length;
  const plugins = Array.isArray(pluginsData) ? pluginsData : [];

  // Branding from settings
  const wl = settings as Record<string, unknown> | undefined;
  const appName = (wl?.appName as string) || 'Fleet';
  const appTagline = (wl?.appTagline as string) || '';
  const logoImage = (wl?.logoImage as string) || '';
  const showIcon = wl?.showIcon !== false;
  const logoIconValue = (wl?.logoIcon as string) || 'anchor';
  const logoIconEntry = LOGO_ICONS.find(i => i.value === logoIconValue) ?? LOGO_ICONS[0];
  const LogoIcon = logoIconEntry.Icon;

  const previousPath = useRef(path);

  useEffect(() => {
    if (path !== previousPath.current) {
      previousPath.current = path;
      onMobileClose?.();
    }
  }, [path, onMobileClose]);

  const isActive = (entry: NavEntry) => {
    if (entry.to === '/') return path === '/';
    if (entry.matchPrefix) return path === entry.to || path.startsWith(entry.matchPrefix);
    return path === entry.to;
  };

  const visibleMain = mainEntries.filter((e) => !e.cap || hasCap(profile, e.cap));
  const sidebarPlugins = plugins.filter(
    (p) => p.enabled && p.sidebar && canSeePlugin(profile, p.id)
  );
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex h-screen w-60 -translate-x-full flex-col border-r bg-card transition-[width,transform] duration-200 md:sticky md:top-12 md:z-auto md:h-[calc(100vh-3rem)] md:translate-x-0',
        mobileOpen && 'translate-x-0',
        collapsed && 'md:w-16'
      )}
    >
      <div className={cn('flex h-14 items-center gap-2 border-b px-3 md:hidden', collapsed && 'justify-center px-2')}>
        {logoImage ? (
          <img src={logoImage} alt={appName} className="h-4 w-4 flex-shrink-0 object-contain" />
        ) : showIcon ? (
          <LogoIcon className="h-4 w-4 flex-shrink-0 text-brand" />
        ) : null}
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">{appName}</span>
            {appTagline && <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{appTagline}</span>}
          </div>
        )}
      </div>

      {/* Cmd+K trigger */}
      {!collapsed && (
        <div className="px-2 pt-2 md:hidden">
          <button
            onClick={() => {
              const evt = new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true });
              document.dispatchEvent(evt);
            }}
            className="flex w-full items-center gap-2 rounded-md border bg-background/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:border-strong hover:bg-background transition-colors"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">{t('cmd.search')}</span>
            <span className="kbd">⌘K</span>
          </button>
        </div>
      )}
      {collapsed && (
        <div className="px-2 pt-2 md:hidden">
          <button
            title={t('cmd.search')}
            onClick={() => {
              const evt = new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true });
              document.dispatchEvent(evt);
            }}
            className="flex w-full items-center justify-center rounded-md border bg-background/60 py-1.5 text-muted-foreground hover:bg-background"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <div className="space-y-1">
          {!collapsed && (
            <div className="section-label px-3 pb-1">
              {t('nav.main')}
            </div>
          )}
          {visibleMain.map(({ to, label, Icon, ...rest }) => {
            const active = isActive({ to, label, Icon, ...rest });
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent text-foreground font-medium before:absolute before:left-0 before:h-5 before:w-0.5 before:rounded-r before:bg-[#0f6cbd]'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  collapsed && 'justify-center px-2'
                )}
                title={collapsed ? t(label) : undefined}
              >
                <Icon className={cn('h-4 w-4 transition-colors', active ? 'text-[#0f6cbd]' : 'text-muted-foreground group-hover:text-foreground')} />
                {!collapsed && (
                  <span className="flex items-center gap-2">
                    {t(label)}
                    {to === '/servers' && onlineCount > 0 && (
                      <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-500">
                        {onlineCount}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {sidebarPlugins.length > 0 && (
          <div className="space-y-1">
            {!collapsed && (
              <div className="section-label px-3 pb-1">
                {t('nav.plugins')}
              </div>
            )}
            {sidebarPlugins.map((p) => {
              const to = `/plugins/${p.id}`;
              const active = path === to;
              const label = p.sidebar?.label || p.name || p.id;
              const PluginIcon = pluginIconFromClass(p.sidebar?.icon);
              return (
                <Link
                  key={p.id}
                  to="/plugins/$id"
                  params={{ id: p.id }}
                  className={cn(
                    'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent text-foreground font-medium before:absolute before:left-0 before:h-5 before:w-0.5 before:rounded-r before:bg-[#0f6cbd]'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    collapsed && 'justify-center px-2'
                  )}
                  title={collapsed ? label : undefined}
                >
                  <PluginIcon className="h-4 w-4" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </Link>
              );
            })}
          </div>
        )}

      </nav>

    </aside>
  );
}
