import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Search, LayoutDashboard, Server, FileCode2, Settings, User,
  HelpCircle, Sun, Moon, LogOut, Puzzle,
} from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { api } from '@/lib/api';
import { useProfile, usePlugins, hasCap, canSeePlugin } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { setToken } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface ServerListItem { id: string; name: string; ip_address?: string; status?: string }
interface PlaybookListItem { id: string; name?: string; filename?: string }

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: profile } = useProfile();
  const { data: plugins = [] } = usePlugins();
  const setTheme = useUi(s => s.setTheme);
  const [open, setOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Toggle on Cmd+K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setShowHelp(s => !s);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Lightweight g-prefix navigation: g s, g d, g p
  useEffect(() => {
    let prefix = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (prefix) {
        if (e.key === 's') navigate({ to: '/servers' });
        else if (e.key === 'd') navigate({ to: '/' });
        else if (e.key === 'p') navigate({ to: '/playbooks' });
        else if (e.key === ',') navigate({ to: '/settings' });
        prefix = false;
        return;
      }
      if (e.key === 'g') {
        prefix = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { prefix = false; }, 1200);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Fetch search data only when open
  const { data: servers = [] } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.getServers() as unknown as Promise<ServerListItem[]>,
    enabled: open && hasCap(profile, 'canViewServers'),
    staleTime: 30_000,
  });
  const { data: playbooks = [] } = useQuery({
    queryKey: ['playbooks'],
    queryFn: () => api.getPlaybooks() as unknown as Promise<PlaybookListItem[]>,
    enabled: open && hasCap(profile, 'canViewPlaybooks'),
    staleTime: 30_000,
  });

  const sidebarPlugins = useMemo(
    () => plugins.filter(p => p.enabled && p.sidebar && canSeePlugin(profile, p.id)),
    [plugins, profile]
  );

  const close = () => setOpen(false);
  const go = (path: string) => { close(); navigate({ to: path }); };

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className={cn(
              'fixed left-1/2 top-[20%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover shadow-pop',
              'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
            )}
          >
            <DialogPrimitive.Title className="sr-only">{t('cmd.title')}</DialogPrimitive.Title>
            <Command label={t('cmd.title')} className="flex flex-col">
              <div className="flex items-center border-b px-3">
                <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <Command.Input
                  placeholder={t('cmd.placeholder')}
                  className="flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground focus:outline-none border-none ring-0 focus:ring-0 shadow-none"
                />
                <span className="kbd ml-2">ESC</span>
              </div>
              <Command.List className="max-h-[420px] overflow-y-auto p-2">
                <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
                  {t('cmd.empty')}
                </Command.Empty>

                <Command.Group heading={t('cmd.navigate')} className="text-[10.5px] uppercase tracking-wider text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  <PaletteItem icon={<LayoutDashboard className="h-4 w-4" />} label={t('nav.dashboard')} shortcut="g d" onSelect={() => go('/')} />
                  {hasCap(profile, 'canViewServers') && <PaletteItem icon={<Server className="h-4 w-4" />} label={t('nav.servers')} shortcut="g s" onSelect={() => go('/servers')} />}
                  {hasCap(profile, 'canViewPlaybooks') && <PaletteItem icon={<FileCode2 className="h-4 w-4" />} label={t('nav.playbooks')} shortcut="g p" onSelect={() => go('/playbooks')} />}
                  <PaletteItem icon={<User className="h-4 w-4" />} label={t('profile.settings')} onSelect={() => go('/profile')} />
                  {profile?.role === 'admin' && <PaletteItem icon={<Settings className="h-4 w-4" />} label={t('nav.settings')} shortcut="g ," onSelect={() => go('/settings')} />}
                </Command.Group>

                {servers.length > 0 && (
                  <Command.Group heading={t('cmd.servers')} className="mt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                    {servers.slice(0, 30).map(s => (
                      <PaletteItem
                        key={s.id}
                        icon={<span className={cn('h-1.5 w-1.5 rounded-full', s.status === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />}
                        label={s.name}
                        sublabel={s.ip_address}
                        keywords={[s.name, s.ip_address || '']}
                        onSelect={() => go(`/servers/${s.id}`)}
                      />
                    ))}
                  </Command.Group>
                )}

                {playbooks.length > 0 && (
                  <Command.Group heading={t('cmd.playbooks')} className="mt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                    {playbooks.slice(0, 20).map(p => (
                      <PaletteItem
                        key={p.id}
                        icon={<FileCode2 className="h-4 w-4" />}
                        label={p.filename || p.name || p.id}
                        onSelect={() => go(`/playbooks`)}
                      />
                    ))}
                  </Command.Group>
                )}

                {sidebarPlugins.length > 0 && (
                  <Command.Group heading={t('nav.plugins')} className="mt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                    {sidebarPlugins.map(p => (
                      <PaletteItem
                        key={p.id}
                        icon={<Puzzle className="h-4 w-4" />}
                        label={p.sidebar?.label || p.name || p.id}
                        onSelect={() => go(`/plugins/${p.id}`)}
                      />
                    ))}
                  </Command.Group>
                )}

                <Command.Group heading={t('cmd.actions')} className="mt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
                  <PaletteItem icon={<Sun className="h-4 w-4" />} label={t('cmd.themeLight')} onSelect={() => { setTheme('light'); close(); }} />
                  <PaletteItem icon={<Moon className="h-4 w-4" />} label={t('cmd.themeDark')} onSelect={() => { setTheme('dark'); close(); }} />
                  <PaletteItem icon={<HelpCircle className="h-4 w-4" />} label={t('cmd.shortcutsHelp')} shortcut="?" onSelect={() => { close(); setShowHelp(true); }} />
                  <PaletteItem icon={<LogOut className="h-4 w-4" />} label={t('profile.signOut')} onSelect={() => { setToken(null); window.location.reload(); }} />
                </Command.Group>
              </Command.List>
              <div className="flex items-center justify-between border-t px-3 py-2 text-[10.5px] text-muted-foreground">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1"><span className="kbd">↑</span><span className="kbd">↓</span> {t('cmd.navigate2')}</span>
                  <span className="flex items-center gap-1"><span className="kbd">↵</span> {t('cmd.open')}</span>
                </div>
                <span className="flex items-center gap-1"><span className="kbd">?</span> {t('cmd.shortcuts')}</span>
              </div>
            </Command>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Shortcut help dialog */}
      <ShortcutsDialog open={showHelp} onClose={() => setShowHelp(false)} />
    </>
  );
}

function PaletteItem({
  icon, label, sublabel, shortcut, keywords, onSelect,
}: {
  icon: React.ReactNode; label: string; sublabel?: string; shortcut?: string;
  keywords?: string[]; onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm',
        'aria-selected:bg-accent aria-selected:text-accent-foreground'
      )}
    >
      <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {sublabel && <span className="font-mono text-[11px] text-muted-foreground">{sublabel}</span>}
      {shortcut && <span className="kbd">{shortcut}</span>}
    </Command.Item>
  );
}

/* ── Shortcut help ──────────────────────────────────────────── */
function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const groups: { heading: string; items: { keys: string[]; label: string }[] }[] = [
    {
      heading: t('cmd.shortcutsGeneral'),
      items: [
        { keys: ['⌘', 'K'], label: t('cmd.openPalette') },
        { keys: ['?'], label: t('cmd.shortcutsHelp') },
        { keys: ['Esc'], label: t('cmd.closeDialog') },
      ],
    },
    {
      heading: t('cmd.shortcutsNav'),
      items: [
        { keys: ['g', 'd'], label: t('nav.dashboard') },
        { keys: ['g', 's'], label: t('nav.servers') },
        { keys: ['g', 'p'], label: t('nav.playbooks') },
        { keys: ['g', ','], label: t('nav.settings') },
      ],
    },
  ];

  return (
    <DialogPrimitive.Root open={open} onOpenChange={v => !v && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-5 shadow-pop data-[state=open]:animate-in data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="text-base font-semibold mb-4">{t('cmd.shortcutsTitle')}</DialogPrimitive.Title>
          <div className="space-y-4">
            {groups.map(g => (
              <div key={g.heading}>
                <div className="section-label mb-2">{g.heading}</div>
                <div className="space-y-1">
                  {g.items.map(it => (
                    <div key={it.label} className="flex items-center justify-between text-sm py-1">
                      <span className="text-muted-foreground">{it.label}</span>
                      <span className="flex items-center gap-1">
                        {it.keys.map((k, i) => <span key={i} className="kbd">{k}</span>)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
