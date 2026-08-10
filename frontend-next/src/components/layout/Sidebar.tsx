import { useEffect, useRef } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Boxes, FileCode2, Network, Puzzle, Settings2, Workflow, X } from 'lucide-react';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { canSeePlugin, hasCap, usePlugins, useProfile, type PluginInfo } from '@/lib/queries';
import { InfrastructureTree } from './InfrastructureTree';

interface NavItemProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
  params?: Record<string, string>;
}

function NavItem({ to, label, icon: Icon, active, collapsed, onNavigate, params }: NavItemProps) {
  return <Link to={to as never} params={params as never} onClick={onNavigate} title={collapsed ? label : undefined}
    className={cn('group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors', active ? 'bg-accent font-medium text-foreground before:absolute before:left-0 before:h-5 before:w-0.5 before:rounded-r before:bg-brand' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground', collapsed && 'justify-center px-2')}>
    <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-brand' : 'text-muted-foreground group-hover:text-foreground')} />
    {!collapsed && <span className="truncate">{label}</span>}
  </Link>;
}

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const collapsed = useUi(state => state.sidebarCollapsed);
  const path = useRouterState({ select: state => state.location.pathname });
  const { data: profile } = useProfile();
  const { data: pluginData } = usePlugins();
  const previousPath = useRef(path);
  const plugins = Array.isArray(pluginData) ? pluginData : [];
  const canViewServers = hasCap(profile, 'canViewServers');
  const canViewPlaybooks = hasCap(profile, 'canViewPlaybooks');
  const canViewAudit = hasCap(profile, 'canViewAudit');
  const canManageConsole = profile?.role === 'admin';
  const opentofu = plugins.find(plugin => plugin.id === 'opentofu' && plugin.enabled && canSeePlugin(profile, plugin.id));
  const otherPlugins = plugins.filter(plugin => plugin.enabled && plugin.id !== 'opentofu' && canSeePlugin(profile, plugin.id));

  useEffect(() => {
    if (path === previousPath.current) return;
    previousPath.current = path;
    onMobileClose?.();
  }, [path, onMobileClose]);

  return <aside className={cn(
    'fixed inset-y-0 left-0 z-50 flex h-screen w-72 -translate-x-full flex-col border-r bg-card transition-[width,transform] duration-200 md:sticky md:top-12 md:z-auto md:h-[calc(100vh-3rem)] md:translate-x-0',
    mobileOpen && 'translate-x-0', collapsed && 'md:w-16',
  )}>
    <div className="flex h-12 shrink-0 items-center justify-between border-b px-4 md:hidden">
      <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">Fleet</span>
      <button type="button" onClick={onMobileClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Navigation schließen">
        <X className="h-4 w-4" />
      </button>
    </div>
    <div className={cn('border-b px-3 py-3', collapsed && 'px-2')}>
      {!collapsed && <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Infrastruktur</div>}
      {canViewServers && <div className={cn('mt-1 max-h-[min(46vh,470px)] overflow-y-auto pr-1', collapsed && 'hidden')}>
        <InfrastructureTree onNavigate={onMobileClose} />
      </div>}
      {canViewServers && collapsed && <Link to="/servers" title="Infrastruktur" className="flex h-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"><Boxes className="h-4 w-4" /></Link>}
    </div>

    <nav className="flex-1 space-y-4 overflow-y-auto p-2">
      <section className="space-y-1">
        {!collapsed && <div className="section-label px-3 pb-1">Automatisierung</div>}
        {opentofu && <NavItem to="/deployments" label="Deployments" icon={Workflow} active={path === '/deployments'} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canViewPlaybooks && <NavItem to="/playbooks" label="Playbook-Workflows" icon={FileCode2} active={path === '/playbooks'} collapsed={collapsed} onNavigate={onMobileClose} />}
      </section>

      {otherPlugins.length > 0 && <section className="space-y-1">
        {!collapsed && <div className="section-label px-3 pb-1">Integrationen</div>}
        {otherPlugins.map((plugin: PluginInfo) => <NavItem key={plugin.id} to="/plugins/$id" params={{ id: plugin.id }} label={plugin.sidebar?.label || plugin.name || plugin.id} icon={Puzzle} active={path === `/plugins/${plugin.id}`} collapsed={collapsed} onNavigate={onMobileClose} />)}
      </section>}

      <section className="space-y-1">
        {!collapsed && <div className="section-label px-3 pb-1">Verwaltung</div>}
        {canViewServers && <NavItem to="/servers" label="Ressourcenliste" icon={Boxes} active={path === '/servers'} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canViewAudit && <NavItem to="/settings/$tab" params={{ tab: 'audit' }} label="Aufgaben & Audit-Log" icon={Network} active={path === '/settings/audit'} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canManageConsole && <NavItem to="/settings" label="Einstellungen" icon={Settings2} active={path === '/settings' || path.startsWith('/settings/')} collapsed={collapsed} onNavigate={onMobileClose} />}
      </section>
    </nav>
  </aside>;
}
