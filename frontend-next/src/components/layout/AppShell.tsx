import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Bug, ChevronDown, Github, HelpCircle, Languages, LogOut, Menu, Moon, Palette, PanelLeft, Search, Sun, User, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sidebar } from './Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { ActivityCenter } from '@/components/ActivityCenter';
import { useProfile, useSettings } from '@/lib/queries';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { applyWhiteLabel, type WhiteLabelSettings } from '@/lib/whitelabel';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { setToken } from '@/lib/auth';

export function AppShell({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { i18n } = useTranslation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const language = useUi((s) => s.language);
  const setLanguage = useUi((s) => s.setLanguage);
  const environmentId = useUi((s) => s.environmentId);
  const setEnvironmentId = useUi((s) => s.setEnvironmentId);
  const { data: environments = [] } = useQuery({ queryKey: ['environments'], queryFn: () => api.getEnvironments() });
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [newEnvironmentName, setNewEnvironmentName] = useState('');
  const environmentMenuRef = useRef<HTMLDivElement>(null);
  const createEnvironment = useMutation({
    mutationFn: (name: string) => api.createEnvironment(name),
    onSuccess: (environment) => {
      void queryClient.invalidateQueries({ queryKey: ['environments'] });
      setEnvironmentId(String(environment.id));
      setNewEnvironmentName('');
    },
  });

  useEffect(() => {
    if (settings) applyWhiteLabel(settings as unknown as WhiteLabelSettings);
  }, [settings]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileNavOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!profileOpen) return;
    const close = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setProfileOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [profileOpen]);

  useEffect(() => {
    if (!helpOpen) return;
    const close = (event: MouseEvent) => {
      if (!helpMenuRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [helpOpen]);
  useEffect(() => {
    if (!environmentOpen) return;
    const close = (event: MouseEvent) => { if (!environmentMenuRef.current?.contains(event.target as Node)) setEnvironmentOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [environmentOpen]);

  const appName = (settings as Record<string, unknown> | undefined)?.appName as string | undefined;
  const displayName = (profile?.displayName as string) || (profile?.username as string) || 'User';
  const isAdmin = profile?.role === 'admin';
  const activeEnvironment = environments.find((item) => String(item.id) === environmentId) || environments[0];

  const openCommandPalette = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }));
  };
  const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b bg-card">
        <div className={cn('hidden h-full shrink-0 items-center border-r px-3 md:flex', collapsed ? 'w-16 justify-center px-2' : 'w-60')}>
          {!collapsed && <span className="truncate font-mono text-[13px] font-semibold tracking-[0.16em]">{(appName || 'Fleet').toUpperCase()}</span>}
          {collapsed && <span className="font-mono text-sm font-semibold tracking-[0.08em]">F</span>}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 md:px-4">
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
            <Menu className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden h-8 w-8 md:inline-flex" onClick={toggleSidebar} aria-label="Toggle navigation">
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm font-semibold md:hidden">{appName || 'Fleet'}</span>
          <button type="button" onClick={openCommandPalette} className="hidden h-8 max-w-md flex-1 items-center gap-2 rounded-md border bg-muted/30 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted md:flex">
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Suchen oder Befehl eingeben…</span>
            <span className="kbd">⌘K</span>
          </button>
          <div ref={environmentMenuRef} className="relative ml-auto hidden md:block">
            <button type="button" onClick={() => setEnvironmentOpen((open) => !open)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
              {String(activeEnvironment?.name || 'Standardumgebung')} <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {environmentOpen && <div className="absolute right-0 top-9 z-50 w-56 rounded-md border border-border/90 bg-popover p-1.5 shadow-xl dark:bg-[#242424]">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Umgebungen</div>
              {environments.map((item) => <button key={String(item.id)} type="button" onClick={() => { setEnvironmentId(String(item.id)); setEnvironmentOpen(false); }} className={cn('flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm hover:bg-accent', String(item.id) === environmentId && 'bg-accent font-medium')}><span>{String(item.name)}</span><span className="text-xs text-muted-foreground">{String(item.server_count ?? 0)}</span></button>)}
              {isAdmin && <form className="mt-1.5 flex gap-1 border-t pt-1.5" onSubmit={(event) => { event.preventDefault(); const name = newEnvironmentName.trim(); if (name) createEnvironment.mutate(name); }}>
                <input value={newEnvironmentName} onChange={(event) => setNewEnvironmentName(event.target.value)} placeholder="Neue Umgebung" className="h-8 min-w-0 flex-1 rounded-sm border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                <Button type="submit" size="sm" className="h-8 px-2 text-xs" disabled={!newEnvironmentName.trim() || createEnvironment.isPending}>+</Button>
              </form>}
            </div>}
          </div>
          <div ref={helpMenuRef} className="relative hidden md:block">
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Hilfe" onClick={() => { setHelpOpen((open) => !open); setProfileOpen(false); }} aria-expanded={helpOpen}>
              <HelpCircle className="h-4 w-4" />
            </Button>
            {helpOpen && (
              <div className="absolute right-0 top-10 z-50 w-64 rounded-md border border-border/90 bg-popover p-2 text-popover-foreground shadow-xl shadow-black/30 dark:bg-[#242424]">
                <div className="border-b px-2.5 py-2">
                  <div className="text-sm font-medium">Hilfe & Ressourcen</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Shipyard Projekt und Support</div>
                </div>
                <div className="space-y-0.5 py-1.5">
                  <button type="button" onClick={() => openExternal('https://github.com/tobayashi-san/Shipyard')} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm hover:bg-accent">
                    <Github className="h-4 w-4 text-muted-foreground" /> GitHub-Repository
                  </button>
                  <button type="button" onClick={() => openExternal('https://github.com/tobayashi-san/Shipyard/issues')} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm hover:bg-accent">
                    <Bug className="h-4 w-4 text-muted-foreground" /> Problem melden
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="hidden md:block"><ActivityCenter placement="header" /></div>
          <div ref={profileMenuRef} className="relative">
            <button type="button" onClick={() => { setProfileOpen((open) => !open); setHelpOpen(false); }} aria-expanded={profileOpen} aria-label="Profilmenü" className="flex h-8 w-8 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <User className="h-4 w-4" />
            </button>
            {profileOpen && (
              <div className="absolute right-0 top-10 z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border/90 bg-popover p-2.5 text-popover-foreground shadow-2xl shadow-black/40 dark:bg-[#242424]">
                <div className="flex items-center gap-3.5 border-b px-3 py-3.5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#0f6cbd]/10 text-[#0f6cbd]"><User className="h-5 w-5" /></div>
                  <div className="min-w-0">
                    <div className="truncate text-lg font-medium">{displayName}</div>
                    <div className="truncate text-sm text-muted-foreground">{isAdmin ? 'Administrator' : (profile?.username as string) || ''}</div>
                  </div>
                </div>
                <div className="border-b py-2.5">
                  <Link to="/profile" onClick={() => setProfileOpen(false)} className="flex items-center gap-3.5 rounded-sm px-3 py-2.5 text-base hover:bg-accent">
                    <UserRoundCog className="h-4 w-4 text-muted-foreground" /> Konto & Sicherheit
                  </Link>
                  {isAdmin && (
                    <Link to="/settings/$tab" params={{ tab: 'appearance' }} onClick={() => setProfileOpen(false)} className="flex items-center gap-3.5 rounded-sm px-3 py-2.5 text-base hover:bg-accent">
                      <Palette className="h-4 w-4 text-muted-foreground" /> Console-Einstellungen
                    </Link>
                  )}
                </div>
                <div className="space-y-2.5 border-b bg-background/10 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5 text-muted-foreground"><Languages className="h-4 w-4" /> Sprache</span>
                    <div className="inline-flex rounded-sm border p-0.5">
                      {(['de', 'en'] as const).map((value) => <button key={value} type="button" onClick={() => { setLanguage(value); void i18n.changeLanguage(value); }} className={cn('rounded-sm px-2 py-1 text-xs font-medium', language === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{value.toUpperCase()}</button>)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5 text-muted-foreground">{theme === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} Farbschema</span>
                    <div className="inline-flex rounded-sm border p-0.5">
                      {(['light', 'dark', 'system'] as const).map((value) => <button key={value} type="button" onClick={() => setTheme(value)} className={cn('rounded-sm px-2 py-1 text-xs font-medium', theme === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{value === 'light' ? 'Hell' : value === 'dark' ? 'Dunkel' : 'Auto'}</button>)}
                    </div>
                  </div>
                </div>
                <div className="pt-2">
                  <button type="button" onClick={() => { setToken(null); window.location.assign('/login'); }} className="flex w-full items-center gap-3.5 rounded-sm px-3 py-2.5 text-base text-destructive hover:bg-destructive/10">
                    <LogOut className="h-4 w-4" /> Abmelden
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
      {mobileNavOpen && <button className="fixed inset-0 z-40 bg-black/50 md:hidden" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <main className="min-w-0 flex-1 overflow-auto p-4 md:p-5 lg:p-6">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}
