import { useTranslation } from 'react-i18next';
import { Link, useRouterState } from '@tanstack/react-router';
import { Anchor, LayoutDashboard, Server, FileCode2, Settings, Puzzle, ChevronLeft, ChevronRight } from 'lucide-react';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useProfile, usePlugins, hasCap, canSeePlugin } from '@/lib/queries';

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

export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: profile } = useProfile();
  const { data: plugins = [] } = usePlugins();

  const isActive = (entry: NavEntry) => {
    if (entry.to === '/') return path === '/';
    if (entry.matchPrefix) return path === entry.to || path.startsWith(entry.matchPrefix);
    return path === entry.to;
  };

  const visibleMain = mainEntries.filter((e) => !e.cap || hasCap(profile, e.cap));
  const sidebarPlugins = plugins.filter(
    (p) => p.enabled && p.sidebar && canSeePlugin(profile, p.id)
  );
  const isAdmin = profile?.role === 'admin';

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen flex-col border-r bg-card/40 backdrop-blur transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b px-3">
        <Anchor className="h-6 w-6 text-primary" />
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Shipyard</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">next</span>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        <div className="space-y-1">
          {!collapsed && (
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  collapsed && 'justify-center px-2'
                )}
                title={collapsed ? t(label) : undefined}
              >
                <Icon className="h-4 w-4" />
                {!collapsed && <span>{t(label)}</span>}
              </Link>
            );
          })}
        </div>

        {sidebarPlugins.length > 0 && (
          <div className="space-y-1">
            {!collapsed && (
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('nav.plugins')}
              </div>
            )}
            {sidebarPlugins.map((p) => {
              const to = `/plugins/${p.id}`;
              const active = path === to;
              const label = p.sidebar?.label || p.name || p.id;
              return (
                <Link
                  key={p.id}
                  to="/plugins/$id"
                  params={{ id: p.id }}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    collapsed && 'justify-center px-2'
                  )}
                  title={collapsed ? label : undefined}
                >
                  <Puzzle className="h-4 w-4" />
                  {!collapsed && <span className="truncate">{label}</span>}
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      {isAdmin && (
        <div className="border-t p-2">
          <Link
            to="/settings"
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              path.startsWith('/settings')
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              collapsed && 'justify-center px-2'
            )}
            title={collapsed ? t('nav.settings') : undefined}
          >
            <Settings className="h-4 w-4" />
            {!collapsed && <span>{t('nav.settings')}</span>}
          </Link>
        </div>
      )}

      <button
        onClick={toggle}
        className="m-2 flex items-center justify-center rounded-md border bg-background py-1.5 text-muted-foreground hover:bg-accent"
        aria-label="Toggle sidebar"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}
