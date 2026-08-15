import { useEffect, useRef } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Boxes,
  ClipboardList,
  Database,
  FileCode2,
  LayoutDashboard,
  Network,
  Puzzle,
  Settings2,
  Workflow,
  X,
} from "lucide-react";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  canAccessDeployments,
  canAccessOperations,
  canSeePlugin,
  hasCap,
  usePlugins,
  useProfile,
  type PluginInfo,
} from "@/lib/queries";
import { InfrastructureTree } from "./InfrastructureTree";

interface NavItemProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
  params?: Record<string, string>;
}

function NavItem({
  to,
  label,
  icon: Icon,
  active,
  collapsed,
  onNavigate,
  params,
}: NavItemProps) {
  return (
    <Link
      to={to as never}
      params={params as never}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={cn(
        "group relative flex min-h-8 items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-primary/[0.09] font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        collapsed && "justify-center px-2",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active
            ? "text-primary"
            : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

export function Sidebar({
  mobileOpen = false,
  onMobileClose,
}: {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { data: profile } = useProfile();
  const { data: pluginData } = usePlugins();
  const previousPath = useRef(path);
  const plugins = Array.isArray(pluginData) ? pluginData : [];
  const canViewServers = hasCap(profile, "canViewServers");
  const canViewPlaybooks = hasCap(profile, "canViewPlaybooks");
  const canManageConsole = profile?.role === "admin";
  const canViewDeployments = canAccessDeployments(profile);
  const canViewOperations = canAccessOperations(profile);
  const otherPlugins = plugins.filter(
    (plugin) =>
      plugin.enabled &&
      canSeePlugin(profile, plugin.id),
  );

  useEffect(() => {
    if (path === previousPath.current) return;
    previousPath.current = path;
    onMobileClose?.();
  }, [path, onMobileClose]);

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-screen w-72 -translate-x-full flex-col border-r border-border-strong/70 bg-[hsl(var(--surface-2))] shadow-2xl transition-[width,transform] duration-200 md:sticky md:top-11 md:z-auto md:h-[calc(100vh-2.75rem)] md:translate-x-0 md:shadow-none",
        mobileOpen && "translate-x-0",
        collapsed && "md:w-16",
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          Fleet
        </span>
        <button
          type="button"
          onClick={onMobileClose}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close navigation"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <nav className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-2 md:flex md:flex-col md:gap-3.5 md:space-y-0 md:overflow-hidden">
        <section className="shrink-0 space-y-1">
          {!collapsed && (
            <div className="section-label px-2.5 pb-1">Overview</div>
          )}
          <NavItem
            to="/"
            label="Dashboard"
            icon={LayoutDashboard}
            active={path === "/"}
            collapsed={collapsed}
            onNavigate={onMobileClose}
          />
        </section>
        <section
          className={cn(
            "border-y border-border-strong/60 bg-muted/25 -mx-2 px-3 py-2",
            !collapsed && "md:flex md:min-h-0 md:flex-1 md:flex-col",
            collapsed && "px-2",
          )}
        >
          {!collapsed && (
            <div className="section-label px-1 pb-1">Browse resources</div>
          )}
          {canViewServers && (
            <div
              className={cn(
                "mt-1 max-h-[min(46vh,470px)] overflow-y-auto pr-1 md:min-h-0 md:max-h-none md:flex-1",
                collapsed && "hidden",
              )}
            >
              <InfrastructureTree onNavigate={onMobileClose} />
            </div>
          )}
          {canViewServers && collapsed && (
            <Link
              to="/servers"
              title="Browse resources"
              className="flex h-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <Boxes className="h-4 w-4" />
            </Link>
          )}
        </section>
        <section className="shrink-0 space-y-1">
          {!collapsed && (
            <div className="section-label px-2.5 pb-1">Operate</div>
          )}
          {canViewServers && (
            <NavItem
              to="/servers"
              label="Manage hosts"
              icon={Boxes}
              active={path === "/servers" || path.startsWith("/servers/")}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
          {canViewPlaybooks && (
            <NavItem
              to="/playbooks"
              label="Playbook workflows"
              icon={FileCode2}
              active={path === "/playbooks"}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
          {canViewOperations && (
            <NavItem
              to="/operations"
              label="Operations"
              icon={ClipboardList}
              active={path === "/operations"}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
        </section>

        {otherPlugins.length > 0 && (
          <section className="shrink-0 space-y-1">
            {!collapsed && (
              <div className="section-label px-2.5 pb-1">Integrations</div>
            )}
            {otherPlugins.map((plugin: PluginInfo) => (
              <NavItem
                key={plugin.id}
                to="/plugins/$id"
                params={{ id: plugin.id }}
                label={plugin.sidebar?.label || plugin.name || plugin.id}
                icon={Puzzle}
                active={path === `/plugins/${plugin.id}`}
                collapsed={collapsed}
                onNavigate={onMobileClose}
              />
            ))}
          </section>
        )}

        <section className="shrink-0 space-y-1">
          {!collapsed && (
            <div className="section-label px-2.5 pb-1">Provision</div>
          )}
          {canViewServers && (
            <NavItem
              to="/infrastructure"
              label="Manage platforms"
              icon={Database}
              active={path === "/infrastructure" || path.startsWith("/infrastructure/")}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
          {canViewDeployments && (
            <NavItem
              to="/deployments"
              label="Deployments"
              icon={Workflow}
              active={path === "/deployments" || path.startsWith("/deployments/")}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
          {canViewServers && (
            <NavItem
              to="/networks"
              label="Networks & IPAM"
              icon={Network}
              active={path === "/networks" || path.startsWith("/networks/")}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
        </section>

        {canManageConsole && (
          <section className="shrink-0 space-y-1">
            {!collapsed && (
              <div className="section-label px-2.5 pb-1">Administration</div>
            )}
          {canManageConsole && (
            <NavItem
              to="/settings"
              label="Settings"
              icon={Settings2}
              active={path === "/settings" || path.startsWith("/settings/")}
              collapsed={collapsed}
              onNavigate={onMobileClose}
            />
          )}
          </section>
        )}
      </nav>
    </aside>
  );
}
