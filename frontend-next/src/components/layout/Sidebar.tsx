import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRouterState, useNavigate } from '@tanstack/react-router';
import {
  Anchor, LayoutDashboard, Server, FileCode2, Settings, Puzzle,
  ChevronLeft, ChevronRight, Globe, Moon, Sun, Monitor, Clock,
  LogOut, UserPen, User, Search, Box, Terminal, Shield, Boxes, Network,
} from 'lucide-react';
import { useUi } from '@/lib/store';
import { LOGO_ICONS } from '@/routes/settings/tabs/appearance';
import { cn } from '@/lib/utils';
import { useProfile, usePlugins, useSettings, hasCap, canSeePlugin } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';

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

/* ── Toggle button group (language / theme / timeFormat) ──────────────── */
function ToggleGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex rounded-md border bg-muted/40 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={(e) => { e.stopPropagation(); onChange(o.value); }}
          className={cn(
            'flex-1 rounded px-2 py-0.5 text-[11px] font-medium transition-all',
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Profile Popover ──────────────────────────────────────────────────── */
function ProfilePopover({
  open,
  onClose,
  anchor,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data: profile } = useProfile();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const language = useUi((s) => s.language);
  const setLanguage = useUi((s) => s.setLanguage);
  const popRef = useRef<HTMLDivElement>(null);

  const timeFormat = useUi((s) => s.timeFormat);
  const setTimeFormat = useUi((s) => s.setTimeFormat);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        popRef.current && !popRef.current.contains(e.target as Node) &&
        anchor.current && !anchor.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler); };
  }, [open, onClose, anchor]);

  if (!open) return null;

  const displayName = (profile?.displayName as string) || (profile?.username as string) || 'User';
  const username = (profile?.username as string) || '';
  const email = (profile?.email as string) || '';
  const isAdmin = profile?.role === 'admin';

  return (
    <div
      ref={popRef}
      className="absolute bottom-full left-0 mb-2 w-[280px] max-w-[calc(100vw-24px)] rounded-lg border bg-popover text-popover-foreground shadow-lg z-50"
    >
      {/* User info header */}
      <div className="flex items-center gap-3 border-b p-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm">
          <User className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{displayName}</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {(profile?.displayName as string)
              ? <span className="font-mono">@{username}</span>
              : (email || <span className="opacity-50">{t('profile.noEmail')}</span>)}
            {isAdmin && (
              <span className="rounded bg-primary px-1.5 py-px text-[9px] font-semibold uppercase text-primary-foreground">
                {t('profile.adminBadge')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="py-1">
        {/* Profile settings link */}
        <button
          className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-accent/50 transition-colors"
          onClick={() => { onClose(); navigate({ to: '/profile' }); }}
        >
          <UserPen className="h-4 w-4 opacity-70" />
          <span>{t('profile.settings')}</span>
        </button>

        {/* Language toggle */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3 text-sm">
            <Globe className="h-4 w-4 opacity-70" />
            <span>{t('profile.language')}</span>
          </div>
          <ToggleGroup
            options={[
              { value: 'de', label: 'DE' },
              { value: 'en', label: 'EN' },
            ]}
            value={language}
            onChange={(v) => { setLanguage(v as 'de' | 'en'); i18n.changeLanguage(v); }}
          />
        </div>

        {/* Theme toggle */}
        <div className="flex items-center justify-between px-4 py-1.5">
          <div className="flex items-center gap-3 text-sm">
            <Moon className="h-4 w-4 opacity-70" />
            <span>{t('profile.theme')}</span>
          </div>
          <ToggleGroup
            options={[
              { value: 'light', label: <Sun className="h-3 w-3" /> },
              { value: 'dark', label: <Moon className="h-3 w-3" /> },
              { value: 'system', label: <Monitor className="h-3 w-3" /> },
            ]}
            value={theme}
            onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
          />
        </div>

        {/* Time format toggle */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3 text-sm">
            <Clock className="h-4 w-4 opacity-70" />
            <span>{t('profile.timeFormat')}</span>
          </div>
          <ToggleGroup
            options={[
              { value: '24h', label: '24h' },
              { value: '12h', label: '12h' },
            ]}
            value={timeFormat}
            onChange={(v) => setTimeFormat(v as '24h' | '12h')}
          />
        </div>
      </div>

      {/* Sign out */}
      <div className="border-t py-1">
        <button
          className="flex w-full items-center gap-3 px-4 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => {
            onClose();
            setToken(null);
            window.location.reload();
          }}
        >
          <LogOut className="h-4 w-4" />
          <span>{t('profile.signOut')}</span>
        </button>
      </div>
    </div>
  );
}

/* ── Sidebar ──────────────────────────────────────────────────────────── */
export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: profile } = useProfile();
  const { data: plugins = [] } = usePlugins();
  const { data: settings } = useSettings();

  // Online server count for badge
  const { data: rawServers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers() as Promise<{ status?: string }[]>,
    staleTime: 30_000,
  });
  const onlineCount = (rawServers ?? []).filter(s => s.status === 'online').length;

  // Branding from settings
  const wl = settings as Record<string, unknown> | undefined;
  const appName = (wl?.appName as string) || 'Shipyard';
  const appTagline = (wl?.appTagline as string) || '';
  const logoImage = (wl?.logoImage as string) || '';
  const showIcon = wl?.showIcon !== false;
  const logoIconValue = (wl?.logoIcon as string) || 'anchor';
  const logoIconEntry = LOGO_ICONS.find(i => i.value === logoIconValue) ?? LOGO_ICONS[0];
  const LogoIcon = logoIconEntry.Icon;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const profileBtnRef = useRef<HTMLButtonElement>(null);

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

  const displayName = (profile?.displayName as string) || (profile?.username as string) || 'User';

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen flex-col border-r surface-1 transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b px-3">
        {logoImage ? (
          <img src={logoImage} alt={appName} className="h-6 w-6 object-contain" />
        ) : showIcon ? (
          <LogoIcon className="h-6 w-6 text-brand" />
        ) : null}
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">{appName}</span>
            {appTagline && <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{appTagline}</span>}
          </div>
        )}
      </div>

      {/* Cmd+K trigger */}
      {!collapsed && (
        <div className="px-2 pt-2">
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
        <div className="px-2 pt-2">
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
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  collapsed && 'justify-center px-2'
                )}
                title={collapsed ? t(label) : undefined}
              >
                {active && !collapsed && (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />
                )}
                <Icon className={cn('h-4 w-4 transition-colors', active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')} />
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
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground font-medium'
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

      {/* Profile section at bottom */}
      <div className={cn('relative border-t p-2', !isAdmin && 'border-t')}>
        <ProfilePopover open={popoverOpen} onClose={() => setPopoverOpen(false)} anchor={profileBtnRef} />
        <button
          ref={profileBtnRef}
          onClick={() => setPopoverOpen((v) => !v)}
          aria-expanded={popoverOpen}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
            'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            collapsed && 'justify-center px-2'
          )}
          title={collapsed ? displayName : undefined}
        >
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px]">
            <User className="h-3 w-3" />
          </div>
          {!collapsed && <span className="truncate text-left">{displayName}</span>}
        </button>
      </div>

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
