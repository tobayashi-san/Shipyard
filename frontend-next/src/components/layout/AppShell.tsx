import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bug, ChevronDown, Github, HelpCircle, LogOut, Menu, Moon, PanelLeft, Pencil, Search, Sun, Trash2, User, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sidebar } from './Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { ActivityCenter } from '@/components/ActivityCenter';
import { canAccessDeployments, useProfile, useSettings } from '@/lib/queries';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { applyWhiteLabel, type WhiteLabelSettings } from '@/lib/whitelabel';
import { resolveVisibleEnvironmentId, useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { setToken } from '@/lib/auth';

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const environmentId = useUi((s) => s.environmentId);
  const setEnvironmentId = useUi((s) => s.setEnvironmentId);
  const { data: environmentsData } = useQuery({ queryKey: ['environments'], queryFn: () => api.getEnvironments() });
  const environments = Array.isArray(environmentsData) ? environmentsData : [];
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [newEnvironmentName, setNewEnvironmentName] = useState('');
  const [environmentToRename, setEnvironmentToRename] = useState<{ id: string; name: string } | null>(null);
  const [environmentToDelete, setEnvironmentToDelete] = useState<{ id: string; name: string } | null>(null);
  const environmentMenuRef = useRef<HTMLDivElement>(null);
  const switchEnvironment = (id: string) => {
    if (!id || id === environmentId) return;
    setEnvironmentId(id);
    queryClient.removeQueries({
      predicate: (query) => !['profile', 'settings', 'plugins', 'environments'].includes(String(query.queryKey[0] || '')),
    });
    void navigate({ to: '/' });
  };
  const createEnvironment = useMutation({
    mutationFn: (name: string) => api.createEnvironment(name),
    onSuccess: (environment) => {
      void queryClient.invalidateQueries({ queryKey: ['environments'] });
      switchEnvironment(String(environment.id));
      setNewEnvironmentName('');
    },
  });
  const renameEnvironment = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateEnvironment(id, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['environments'] }),
  });
  const removeEnvironment = useMutation({
    mutationFn: (id: string) => api.deleteEnvironment(id),
    onSuccess: (_, id) => {
      if (environmentId === id) switchEnvironment('default');
      void queryClient.invalidateQueries({ queryKey: ['environments'] });
    },
  });

  useEffect(() => {
    if (settings) applyWhiteLabel(settings as unknown as WhiteLabelSettings);
  }, [settings]);

  useEffect(() => {
    const visibleEnvironmentId = resolveVisibleEnvironmentId(environmentId, environments);
    if (visibleEnvironmentId && visibleEnvironmentId !== environmentId) {
      setEnvironmentId(visibleEnvironmentId);
    }
  }, [environmentId, environments, setEnvironmentId]);

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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setEnvironmentOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [environmentOpen]);

  const appName = (settings as Record<string, unknown> | undefined)?.appName as string | undefined;
  const displayName = (profile?.displayName as string) || (profile?.username as string) || 'User';
  const isAdmin = profile?.role === 'admin';
  const canViewDeployments = canAccessDeployments(profile);
  const activeEnvironment = environments.find((item) => String(item.id) === environmentId) || environments[0];

  const openCommandPalette = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }));
  };
  const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-11 shrink-0 items-center border-b border-border-strong/80 bg-[hsl(var(--surface-2))] shadow-[0_1px_2px_hsl(var(--foreground)/0.06)]">
        <div className={cn('hidden h-full shrink-0 items-center border-r border-border-strong/70 px-4 md:flex', collapsed ? 'w-16 justify-center px-2' : 'w-72')}>
          {!collapsed && <span className="truncate font-mono text-[12px] font-bold tracking-[0.15em] text-foreground">{(appName || 'Shipyard').toUpperCase()}</span>}
          {collapsed && <span className="font-mono text-sm font-semibold tracking-[0.08em]">F</span>}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 md:px-3">
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
            <Menu className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden h-8 w-8 md:inline-flex" onClick={toggleSidebar} aria-label="Toggle navigation">
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm font-semibold md:hidden">{appName || 'Shipyard'}</span>
          <select
            aria-label="Environment"
            value={environmentId}
            onChange={(event) => switchEnvironment(event.target.value)}
            className="ml-auto h-8 min-w-0 max-w-[9rem] rounded-md border border-input bg-background px-2 text-xs text-foreground md:hidden"
          >
            {environments.length === 0 && (
              <option value={environmentId}>Loading environments…</option>
            )}
            {environments.map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.name)}
              </option>
            ))}
          </select>
          <button type="button" onClick={openCommandPalette} className="hidden h-7 max-w-xl flex-1 items-center gap-2 rounded-sm border border-input bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted/45 md:flex">
            <Search className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Search or enter a command…</span>
            <span className="kbd">⌘K</span>
          </button>
          <div ref={environmentMenuRef} className="relative ml-auto hidden md:block">
            <button type="button" onClick={() => setEnvironmentOpen((open) => !open)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" aria-haspopup="menu" aria-expanded={environmentOpen}>
              {String(activeEnvironment?.name || 'Default environment')} <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {environmentOpen && <div className="absolute right-0 top-9 z-50 w-56 rounded-md border border-border/90 bg-popover p-1.5 shadow-xl" role="menu" aria-label="Environments">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Environments</div>
              {environments.map((item) => {
                const id = String(item.id);
                const name = String(item.name);
                return <div key={id} className={cn('group flex items-center rounded-sm hover:bg-accent', id === environmentId && 'bg-accent')}>
                  <button type="button" onClick={() => { switchEnvironment(id); setEnvironmentOpen(false); }} className={cn('flex min-w-0 flex-1 items-center justify-between px-2 py-2 text-sm', id === environmentId && 'font-medium')}><span className="truncate">{name}</span><span className="ml-2 shrink-0 text-xs text-muted-foreground">{String(item.server_count ?? 0)} hosts{canViewDeployments ? ` · ${String(item.deployment_count ?? 0)} deployments` : ''}</span></button>
                  {isAdmin && <div className="mr-1 hidden items-center gap-0.5 group-hover:flex">
                    <button type="button" title="Rename environment" aria-label={`Rename ${name}`} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => { setEnvironmentToRename({ id, name }); setEnvironmentOpen(false); }}><Pencil className="h-3 w-3" /></button>
                    {id !== 'default' && <button type="button" title="Delete environment" aria-label={`Delete ${name}`} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => { setEnvironmentToDelete({ id, name }); setEnvironmentOpen(false); }}><Trash2 className="h-3 w-3" /></button>}
                  </div>}
                </div>;
              })}
              {isAdmin && <form className="mt-1.5 flex gap-1 border-t pt-1.5" onSubmit={(event) => { event.preventDefault(); const name = newEnvironmentName.trim(); if (name) createEnvironment.mutate(name); }}>
                <input value={newEnvironmentName} onChange={(event) => setNewEnvironmentName(event.target.value)} placeholder="New environment" aria-label="New environment name" className="h-8 min-w-0 flex-1 rounded-sm border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                <Button type="submit" size="sm" className="h-8 px-2 text-xs" disabled={!newEnvironmentName.trim() || createEnvironment.isPending} aria-label="Create environment">+</Button>
              </form>}
            </div>}
          </div>
          <div ref={helpMenuRef} className="relative hidden md:block">
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Help" aria-label="Help" onClick={() => { setHelpOpen((open) => !open); setProfileOpen(false); }} aria-expanded={helpOpen} aria-haspopup="menu">
              <HelpCircle className="h-4 w-4" />
            </Button>
            {helpOpen && (
              <div className="absolute right-0 top-10 z-50 w-64 rounded-md border border-border/90 bg-popover p-2 text-popover-foreground shadow-xl shadow-black/30">
                <div className="border-b px-2.5 py-2">
                  <div className="text-sm font-medium">Help & resources</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Shipyard project and support</div>
                </div>
                <div className="space-y-0.5 py-1.5">
                  <button type="button" onClick={() => openExternal('https://github.com/tobayashi-san/Shipyard')} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm hover:bg-accent">
                    <Github className="h-4 w-4 text-muted-foreground" /> GitHub repository
                  </button>
                  <button type="button" onClick={() => openExternal('https://github.com/tobayashi-san/Shipyard/issues')} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm hover:bg-accent">
                    <Bug className="h-4 w-4 text-muted-foreground" /> Report an issue
                  </button>
                </div>
              </div>
            )}
          </div>
          <ActivityCenter placement="header" />
          <div ref={profileMenuRef} className="relative">
            <button type="button" onClick={() => { setProfileOpen((open) => !open); setHelpOpen(false); setMobileNavOpen(false); }} aria-expanded={profileOpen} aria-haspopup="menu" aria-label="Profile menu" className="flex h-8 w-8 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <User className="h-4 w-4" />
            </button>
            {profileOpen && (
              <div className="fixed inset-x-3 top-14 z-[60] w-auto rounded-md border border-border/90 bg-popover p-2 text-popover-foreground shadow-2xl shadow-black/40 md:absolute md:inset-x-auto md:right-0 md:top-10 md:w-72 md:max-w-[calc(100vw-1rem)]">
                <div className="flex items-center gap-3 border-b px-3 py-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><User className="h-5 w-5" /></div>
                  <div className="min-w-0">
                    <div className="truncate text-lg font-medium">{displayName}</div>
                    <div className="truncate text-sm text-muted-foreground">{isAdmin ? 'Administrator' : (profile?.username as string) || ''}</div>
                  </div>
                </div>
                <div className="border-b py-2">
                  <Link to="/profile" onClick={() => setProfileOpen(false)} className="flex items-center gap-3 rounded-sm px-3 py-2 text-sm hover:bg-accent">
                    <UserRoundCog className="h-4 w-4 text-muted-foreground" /> Account & security
                  </Link>
                </div>
                <div className="space-y-2 border-b bg-background/10 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5 text-muted-foreground">{theme === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} Theme</span>
                    <div className="inline-flex rounded-sm border p-0.5">
                      {(['light', 'dark', 'system'] as const).map((value) => <button key={value} type="button" onClick={() => setTheme(value)} className={cn('rounded-sm px-2 py-1 text-xs font-medium', theme === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{value === 'light' ? 'Light' : value === 'dark' ? 'Dark' : 'System'}</button>)}
                    </div>
                  </div>
                </div>
                <div className="pt-2">
                  <button type="button" onClick={() => { setToken(null); window.location.assign('/login'); }} className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-destructive/10">
                    <LogOut className="h-4 w-4" /> Sign out
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
      <main className="min-w-0 flex-1 overflow-auto bg-[hsl(var(--surface-1))] px-3 py-3 sm:px-4 md:px-5 md:py-4 lg:px-6 lg:py-5">{children}</main>
      </div>
      <CommandPalette />
      <RenameEnvironmentDialog environment={environmentToRename} isPending={renameEnvironment.isPending} onClose={() => setEnvironmentToRename(null)} onRename={(name) => renameEnvironment.mutate({ id: environmentToRename!.id, name }, { onSuccess: () => setEnvironmentToRename(null) })} />
      <ConfirmDialog open={Boolean(environmentToDelete)} onOpenChange={(open) => !open && setEnvironmentToDelete(null)} title="Delete environment?" description={environmentToDelete ? <>The environment <strong>“{environmentToDelete.name}”</strong> will be deleted. All associated resources will be moved to the default environment. Conflicting IPAM prefixes, variables, or platform connections must be resolved first.</> : ''} confirmLabel="Delete environment" cancelLabel="Cancel" variant="destructive" confirmTextValue={environmentToDelete?.name} confirmInputLabel="Enter the environment name to confirm" onConfirm={() => { if (environmentToDelete) removeEnvironment.mutate(environmentToDelete.id); }} isPending={removeEnvironment.isPending} />
    </div>
  );
}

function RenameEnvironmentDialog({ environment, isPending, onClose, onRename }: { environment: { id: string; name: string } | null; isPending: boolean; onClose: () => void; onRename: (name: string) => void }) {
  const [name, setName] = useState('');
  useEffect(() => setName(environment?.name || ''), [environment]);
  return <Dialog open={Boolean(environment)} onOpenChange={(open) => !open && onClose()}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Rename environment</DialogTitle><DialogDescription>The name appears in the selector and throughout the console.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (next && next !== environment?.name) onRename(next); }}><div className="space-y-1.5"><Label htmlFor="environment-rename">Name</Label><Input id="environment-rename" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></div><DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button><Button type="submit" disabled={isPending || !name.trim() || name.trim() === environment?.name}>Save</Button></DialogFooter></form></DialogContent></Dialog>;
}
