import {
  canAccessDeployments,
  canAccessInfrastructure,
  canAccessNetworks,
  canAccessOperations,
  hasCap,
  useProfile,
  useEnvironments,
} from "@/lib/queries";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  FileCode2,
  GripVertical,
  HelpCircle,
  Network,
  Server,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

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

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const { t } = useTranslation();
  const environmentId = useUi(state => state.environmentId);
  const {data: environments} = useEnvironments();
  const activeEnvironment = environments?.find(environment => environment.id === environmentId)?.name || environmentId;
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const sidebarWidth = useUi((state) => state.sidebarWidth);
  const setSidebarWidth = useUi((state) => state.setSidebarWidth);
  const location = useRouterState({ select: (state) => state.location });
  const path = location.pathname;
  const { data: profile } = useProfile();
  const previousPath = useRef(path);
  const canViewServers = hasCap(profile, "canViewServers");
  const canViewPlaybooks = hasCap(profile, "canViewPlaybooks");
  const canManageConsole = profile?.role === "admin";
  const canViewDeployments = canAccessDeployments(profile);
  const canViewInfrastructure = canAccessInfrastructure(profile);
  const canViewNetworks = canAccessNetworks(profile);
  const canViewOperations = canAccessOperations(profile);

  useEffect(() => {
    if (path === previousPath.current) return;
    previousPath.current = path;
    onMobileClose?.();
  }, [path, onMobileClose]);

  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (collapsed || window.matchMedia("(max-width: 1023px)").matches) return;
    resizeCleanup.current?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => setSidebarWidth(startWidth + moveEvent.clientX - startX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      resizeCleanup.current = null;
    };
    resizeCleanup.current = stop;
    window.addEventListener("pointercancel", stop);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(85vw,18rem)] -translate-x-full flex-col border-r border-border-strong/70 bg-[hsl(var(--surface-2))] shadow-2xl transition-[width,transform] duration-200 lg:max-w-[28vw] lg:relative lg:top-0 lg:z-auto lg:h-full lg:translate-x-0 lg:shadow-none",
        mobileOpen && "translate-x-0",
        collapsed && "lg:w-16",
      )}
      style={{ width: collapsed ? undefined : `min(85vw, ${sidebarWidth}px)` }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3 lg:hidden">
        <span className="min-w-0"><span className="block font-mono text-xs font-semibold uppercase tracking-[0.16em]">Shipyard</span><span className="block truncate text-xs text-muted-foreground" title={String(activeEnvironment)}>{String(activeEnvironment)}</span></span>
          <button type="button" onClick={onMobileClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("shell.closeNavigation")} title={t("shell.closeNavigation")}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="min-h-0 flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Main navigation">
        {(canViewInfrastructure || canViewServers || canViewDeployments) && <NavItem to="/infrastructure" label="Infrastructure" icon={Server} active={path === "/" || /^\/(infrastructure|servers|deployments)(\/|$)/.test(path)} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canViewPlaybooks && <NavItem to="/playbooks" label="Automations" icon={FileCode2} active={path === "/playbooks"} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canViewNetworks && <NavItem to="/networks" label="Networks" icon={Network} active={path.startsWith("/networks")} collapsed={collapsed} onNavigate={onMobileClose} />}
        {canViewOperations && <NavItem to="/operations" search={{ section: "tasks" }} label="Jobs" icon={Activity} active={path.startsWith("/operations")} collapsed={collapsed} onNavigate={onMobileClose} />}
      </nav>

      <div className="shrink-0 space-y-1 border-t p-2">
        {canManageConsole && <NavItem to="/settings" label="Settings" icon={Settings2} active={path === "/settings" || path.startsWith("/settings/")} collapsed={collapsed} onNavigate={onMobileClose} />}
        <a href="https://github.com/tobayashi-san/Shipyard" target="_blank" rel="noreferrer" title={t("nav.help")} className={cn("group flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", collapsed && "justify-center px-2")}>
          <HelpCircle className="h-4 w-4 shrink-0" />
          {!collapsed && <span>{t("nav.help")}</span>}
        </a>
      </div>

      {!collapsed && <button type="button" role="separator" aria-orientation="vertical" aria-valuemin={224} aria-valuemax={384} aria-valuenow={sidebarWidth} onKeyDown={(event) => {
        const next = event.key === 'ArrowLeft' ? sidebarWidth - 16 : event.key === 'ArrowRight' ? sidebarWidth + 16 : event.key === 'Home' ? 224 : event.key === 'End' ? 384 : null;
        if (next !== null) { event.preventDefault(); setSidebarWidth(next); }
      }} onPointerDown={startResize} className="absolute inset-y-0 -right-2 hidden w-4 cursor-col-resize items-center justify-center text-transparent hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring lg:flex" aria-label={t("nav.resizeSidebar")} title={t("nav.resizeSidebar")}><GripVertical className="h-4 w-4" /></button>}
    </aside>
  );
}
