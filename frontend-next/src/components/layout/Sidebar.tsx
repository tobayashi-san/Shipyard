import { useTranslation } from 'react-i18next';
import { Link, useRouterState } from '@tanstack/react-router';
import { Anchor, LayoutDashboard, Server, FileCode2, Calendar, Settings, ScrollText, Cpu, Plug, ChevronLeft, ChevronRight } from 'lucide-react';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

const items = [
  { to: '/',          label: 'nav.dashboard',  Icon: LayoutDashboard },
  { to: '/servers',   label: 'nav.servers',    Icon: Server },
  { to: '/playbooks', label: 'nav.playbooks',  Icon: FileCode2 },
  { to: '/schedules', label: 'nav.schedules',  Icon: Calendar },
  { to: '/audit',     label: 'nav.audit',      Icon: ScrollText },
  { to: '/agent',     label: 'nav.agent',      Icon: Cpu },
  { to: '/plugins',   label: 'nav.plugins',    Icon: Plug },
  { to: '/settings',  label: 'nav.settings',   Icon: Settings },
] as const;

export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const path = useRouterState({ select: (s) => s.location.pathname });

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

      <nav className="flex-1 space-y-1 p-2">
        {items.map(({ to, label, Icon }) => {
          const active = path === to || (to !== '/' && path.startsWith(to));
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                collapsed && 'justify-center px-2'
              )}
              title={collapsed ? t(label) : undefined}
            >
              <Icon className="h-4 w-4" />
              {!collapsed && <span>{t(label)}</span>}
            </Link>
          );
        })}
      </nav>

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
