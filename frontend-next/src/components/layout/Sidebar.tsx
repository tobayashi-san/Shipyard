import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  GripVertical,
  HelpCircle,
  LayoutDashboard,
  Monitor,
  Network,
  Puzzle,
  Server,
  Settings2,
  X,
} from "lucide-react";
import { useUi, type NavigationWorkspace } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  canAccessDeployments,
  canAccessInfrastructure,
  canAccessNetworks,
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
  search?: Record<string, unknown>;
}

function NavItem({ to, label, icon: Icon, active, collapsed, onNavigate, params, search }: NavItemProps) {
  return (
    <Link
      to={to as never}
      params={params as never}
      search={search as never}
      onClick={onNavigate}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex min-h-9 min-w-0 items-center gap-2.5 overflow-hidden rounded-sm px-2.5 py-2 text-sm transition-colors",
        active
          ? "bg-primary/[0.09] font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-primary"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        collapsed && "justify-center px-2",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
    </Link>
  );
}

function WorkspaceSwitcher({ value, onChange, collapsed }: { value: NavigationWorkspace; onChange: (workspace: NavigationWorkspace) => void; collapsed: boolean }) {
  const { t } = useTranslation();
  const options: Array<{ value: NavigationWorkspace; label: string; icon: typeof Activity }> = [
    { value: "operations", label: t("nav.operations"), icon: Activity },
    { value: "infrastructure", label: t("nav.infrastructure"), icon: Database },
  ];
  return (
    <div className={cn("grid gap-1 border-b p-2", collapsed ? "grid-cols-1" : "grid-cols-2")} role="group" aria-label={t("nav.workspace")}>
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            title={option.label}
            className={cn(
              "flex min-h-9 items-center justify-center gap-2 rounded-sm border px-2 text-xs font-semibold transition-colors",
              selected ? "border-primary/30 bg-primary/10 text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { t } = useTranslation();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const sidebarWidth = useUi((state) => state.sidebarWidth);
  const setSidebarWidth = useUi((state) => state.setSidebarWidth);
  const treeCollapsed = useUi((state) => state.infrastructureTreeCollapsed);
  const toggleTree = useUi((state) => state.toggleInfrastructureTree);
  const workspace = useUi((state) => state.navigationWorkspace);
  const setWorkspace = useUi((state) => state.setNavigationWorkspace);
  const location = useRouterState({ select: (state) => state.location });
  const path = location.pathname;
  const section = (location.search as Record<string, unknown>).section;
  const { data: profile } = useProfile();
  const { data: pluginData } = usePlugins();
  const previousPath = useRef(path);
  const plugins = Array.isArray(pluginData) ? pluginData : [];
  const canViewServers = hasCap(profile, "canViewServers");
  const canViewPlaybooks = hasCap(profile, "canViewPlaybooks");
  const canManageConsole = profile?.role === "admin";
  const canViewDeployments = canAccessDeployments(profile);
  const canViewInfrastructure = canAccessInfrastructure(profile);
  const canViewNetworks = canAccessNetworks(profile);
  const canViewOperations = canAccessOperations(profile);
  const otherPlugins = plugins.filter((plugin) => plugin.enabled && canSeePlugin(profile, plugin.id));

  useEffect(() => {
    if (path.startsWith("/infrastructure") || path.startsWith("/networks")) {
      setWorkspace("infrastructure");
    } else if (path === "/" || path.startsWith("/servers") || path.startsWith("/deployments") || path.startsWith("/operations") || path.startsWith("/playbooks")) {
      setWorkspace("operations");
    }
  }, [path, setWorkspace]);

  useEffect(() => {
    if (path === previousPath.current) return;
    previousPath.current = path;
    onMobileClose?.();
  }, [path, onMobileClose]);

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (collapsed || window.matchMedia("(max-width: 767px)").matches) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => setSidebarWidth(startWidth + moveEvent.clientX - startX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-screen w-[min(85vw,18rem)] -translate-x-full flex-col border-r border-border-strong/70 bg-[hsl(var(--surface-2))] shadow-2xl transition-[width,transform] duration-200 md:sticky md:top-11 md:z-auto md:h-[calc(100vh-2.75rem)] md:translate-x-0 md:shadow-none",
        mobileOpen && "translate-x-0",
        collapsed && "md:w-16",
      )}
      style={{ width: collapsed ? undefined : `${sidebarWidth}px` }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3 md:hidden">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">Shipyard</span>
          <button type="button" onClick={onMobileClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("shell.closeNavigation")} title={t("shell.closeNavigation")}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <WorkspaceSwitcher value={workspace} onChange={setWorkspace} collapsed={collapsed} />

      <nav
        className={cn(
          "min-h-0 flex-1 p-2",
          workspace === "operations"
            ? "space-y-1 overflow-y-auto"
            : "flex flex-col gap-1 overflow-hidden",
        )}
        aria-label={workspace === "operations" ? t("nav.operations") : t("nav.infrastructure")}
      >
        {workspace === "operations" ? (
          <>
            {canViewServers && <NavItem to="/" label={t("nav.dashboard")} icon={LayoutDashboard} active={path === "/"} collapsed={collapsed} onNavigate={onMobileClose} />}
            {canViewOperations && <NavItem to="/operations" search={{ section: "tasks" }} label={t("nav.activity")} icon={Activity} active={path === "/operations" && section !== "maintenance" && section !== "audit"} collapsed={collapsed} onNavigate={onMobileClose} />}
            {canViewServers && <NavItem to="/servers" label={t("nav.managedHosts")} icon={Server} active={path === "/servers" || path.startsWith("/servers/")} collapsed={collapsed} onNavigate={onMobileClose} />}
            {canViewDeployments && <NavItem to="/deployments" label={t("nav.managedVirtualMachines")} icon={Monitor} active={path === "/deployments" || path.startsWith("/deployments/")} collapsed={collapsed} onNavigate={onMobileClose} />}
            {canViewPlaybooks && <NavItem to="/playbooks" label={t("nav.playbooks")} icon={FileCode2} active={path === "/playbooks"} collapsed={collapsed} onNavigate={onMobileClose} />}
            {canViewOperations && <NavItem to="/operations" search={{ section: "maintenance" }} label={t("nav.maintenance")} icon={CalendarClock} active={path === "/operations" && section === "maintenance"} collapsed={collapsed} onNavigate={onMobileClose} />}
            {otherPlugins.length > 0 && (
              <section className="space-y-1 border-t pt-2">
                {!collapsed && <div className="section-label px-2.5 pb-1">{t("nav.integrations")}</div>}
                {otherPlugins.map((plugin: PluginInfo) => (
                  <NavItem key={plugin.id} to="/plugins/$id" params={{ id: plugin.id }} label={plugin.sidebar?.label || plugin.name || plugin.id} icon={Puzzle} active={path === `/plugins/${plugin.id}`} collapsed={collapsed} onNavigate={onMobileClose} />
                ))}
              </section>
            )}
          </>
        ) : (
          <>
            {canViewNetworks && <NavItem to="/networks" label={t("nav.networksIpam")} icon={Network} active={path === "/networks" || path.startsWith("/networks/")} collapsed={collapsed} onNavigate={onMobileClose} />}
            {(canViewServers || canViewInfrastructure) && (
              <section
                className={cn(
                  "-mx-2 flex shrink-0 flex-col border-y border-border-strong/60 bg-muted/20 px-2 py-1",
                  !collapsed && !treeCollapsed && "min-h-0 flex-1",
                )}
              >
                <button type="button" onClick={toggleTree} className={cn("flex min-h-9 w-full items-center gap-2 rounded-sm px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground", collapsed && "justify-center px-2")} aria-expanded={!treeCollapsed} title={t("nav.infrastructureTree")}>
                  <Boxes className="h-4 w-4 shrink-0" />
                  {!collapsed && <><span className="min-w-0 flex-1 text-left">{t("nav.infrastructureTree")}</span>{treeCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</>}
                </button>
                {!collapsed && !treeCollapsed && <div data-testid="infrastructure-tree-scroll" className="min-h-0 flex-1 overflow-y-auto py-1"><InfrastructureTree onNavigate={onMobileClose} /></div>}
              </section>
            )}
          </>
        )}
      </nav>

      <div className="shrink-0 space-y-1 border-t p-2">
        {canManageConsole && <NavItem to="/settings" label={t("nav.administration")} icon={Settings2} active={path === "/settings" || path.startsWith("/settings/")} collapsed={collapsed} onNavigate={onMobileClose} />}
        <a href="https://github.com/tobayashi-san/Shipyard" target="_blank" rel="noreferrer" title={t("nav.help")} className={cn("group flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", collapsed && "justify-center px-2")}>
          <HelpCircle className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t("nav.help")}</span>}
        </a>
      </div>

      {!collapsed && <button type="button" onPointerDown={startResize} className="absolute inset-y-0 -right-2 hidden w-4 cursor-col-resize items-center justify-center text-transparent hover:text-muted-foreground md:flex" aria-label={t("nav.resizeSidebar")} title={t("nav.resizeSidebar")}><GripVertical className="h-4 w-4" /></button>}
    </aside>
  );
}
