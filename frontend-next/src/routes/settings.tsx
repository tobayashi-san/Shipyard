import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Trash2, AlertTriangle, UserPlus, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';

interface BrandingSettings {
  appName?: string;
  appTagline?: string;
  accentColor?: string;
  logoIcon?: string;
  showIcon?: boolean;
  agentEnabled?: boolean;
}

interface User {
  id: number | string;
  username?: string;
  display_name?: string;
  role?: string;
  totp_enabled?: boolean | 0 | 1;
  active?: boolean | 0 | 1;
}

interface PollingConfig {
  enabled?: boolean;
  intervalSeconds?: number;
  updatesIntervalSeconds?: number;
}

export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('nav.settings')}</h1>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t('set.tabGeneral')}</TabsTrigger>
          <TabsTrigger value="users">{t('set.tabUsers')}</TabsTrigger>
          <TabsTrigger value="polling">{t('set.tabPolling')}</TabsTrigger>
          <TabsTrigger value="danger">{t('set.tabDanger')}</TabsTrigger>
        </TabsList>

        <TabsContent value="general"><GeneralTab /></TabsContent>
        <TabsContent value="users"><UsersTab /></TabsContent>
        <TabsContent value="polling"><PollingTab /></TabsContent>
        <TabsContent value="danger"><DangerTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── General / Branding ──────────────────────────────────────────────────────

function GeneralTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<BrandingSettings>({
    queryKey: ['settings'],
    queryFn: async () => (await api.getSettings()) as BrandingSettings,
  });

  const [form, setForm] = useState<BrandingSettings>({});
  useEffect(() => { if (data) setForm(data); }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveSettings(form as Record<string, unknown>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('set.brandingTitle')}</CardTitle>
        <CardDescription>{t('set.brandingDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="set-name">{t('set.appName')}</Label>
          <Input id="set-name" value={form.appName ?? ''} onChange={(e) => setForm({ ...form, appName: e.target.value })} placeholder="Shipyard" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-tag">{t('set.tagline')}</Label>
          <Input id="set-tag" value={form.appTagline ?? ''} onChange={(e) => setForm({ ...form, appTagline: e.target.value })} placeholder="Infrastructure" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-accent">{t('set.accentColor')}</Label>
          <div className="flex items-center gap-2">
            <input
              id="set-accent"
              type="color"
              value={form.accentColor ?? '#3b82f6'}
              onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
              className="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
            />
            <Input
              value={form.accentColor ?? '#3b82f6'}
              onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
              className="font-mono"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 pt-6">
          <input
            id="set-show-icon"
            type="checkbox"
            checked={form.showIcon !== false}
            onChange={(e) => setForm({ ...form, showIcon: e.target.checked })}
            className="h-4 w-4"
          />
          <Label htmlFor="set-show-icon" className="cursor-pointer">{t('set.showIcon')}</Label>
        </div>

        <div className="sm:col-span-2 flex items-center gap-3 border-t pt-4">
          <input
            id="set-agent"
            type="checkbox"
            checked={!!form.agentEnabled}
            onChange={(e) => setForm({ ...form, agentEnabled: e.target.checked })}
            className="h-4 w-4"
          />
          <div>
            <Label htmlFor="set-agent" className="cursor-pointer">{t('set.agentEnabled')}</Label>
            <p className="text-xs text-muted-foreground">{t('set.agentEnabledHint')}</p>
          </div>
        </div>

        <div className="sm:col-span-2 flex justify-end">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            <Save className="h-4 w-4" /> {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

function UsersTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => (await api.getUsers()) as unknown as User[],
  });
  const [createOpen, setCreateOpen] = useState(false);

  const delMut = useMutation({
    mutationFn: (id: number | string) => api.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{t('set.usersTitle')}</CardTitle>
          <CardDescription>{t('set.usersDesc')}</CardDescription>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><UserPlus className="h-4 w-4" /> {t('set.newUser')}</Button>
          </DialogTrigger>
          <CreateUserDialog onCreated={() => { setCreateOpen(false); qc.invalidateQueries({ queryKey: ['users'] }); }} />
        </Dialog>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : !users || users.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">{t('set.noUsers')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2">{t('login.username')}</th>
                <th className="px-4 py-2">{t('ob.displayName')}</th>
                <th className="px-4 py-2">{t('set.role')}</th>
                <th className="px-4 py-2">{t('set.totp')}</th>
                <th className="px-4 py-2 text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-accent/30">
                  <td className="px-4 py-3 font-medium">{u.username}</td>
                  <td className="px-4 py-3 text-muted-foreground">{u.display_name || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{u.role || '—'}</td>
                  <td className="px-4 py-3">
                    {u.totp_enabled ? (
                      <span className="text-xs text-emerald-600">{t('common.yes')}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('common.no')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="icon" onClick={() => delMut.mutate(u.id)} disabled={delMut.isPending}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setError(t('set.usernameRequired')); return; }
    if (password.length < 12) { setError(t('login.errorShort')); return; }
    setBusy(true);
    setError(null);
    try {
      await api.createUser({ username: username.trim(), displayName: displayName.trim(), password, role });
      onCreated();
    } catch (err) {
      setError((err as Error).message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{t('set.newUser')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="cu-user">{t('login.username')}</Label>
            <Input id="cu-user" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-display">{t('ob.displayName')}</Label>
            <Input id="cu-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-pw">{t('login.newPassword')}</Label>
            <Input id="cu-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('login.minChars')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-role">{t('set.role')}</Label>
            <select
              id="cu-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy}>{t('common.create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ── Polling ─────────────────────────────────────────────────────────────────

function PollingTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<PollingConfig>({
    queryKey: ['polling'],
    queryFn: async () => (await api.getPollingConfig()) as PollingConfig,
  });

  const [form, setForm] = useState<PollingConfig>({});
  useEffect(() => { if (data) setForm(data); }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.savePollingConfig(form as Record<string, unknown>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['polling'] }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('set.pollingTitle')}</CardTitle>
        <CardDescription>{t('set.pollingDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <input
            id="poll-enabled"
            type="checkbox"
            checked={!!form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            className="h-4 w-4"
          />
          <Label htmlFor="poll-enabled" className="cursor-pointer">{t('set.pollingEnabled')}</Label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="poll-int">{t('set.pollingInterval')}</Label>
            <Input
              id="poll-int"
              type="number"
              min={30}
              value={form.intervalSeconds ?? 60}
              onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="poll-up">{t('set.pollingUpdatesInterval')}</Label>
            <Input
              id="poll-up"
              type="number"
              min={300}
              value={form.updatesIntervalSeconds ?? 3600}
              onChange={(e) => setForm({ ...form, updatesIntervalSeconds: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            <Save className="h-4 w-4" /> {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Danger Zone ─────────────────────────────────────────────────────────────

function DangerTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const reset = (kind: 'servers' | 'schedules' | 'playbooks') => async () => {
    if (!window.confirm(t('set.resetConfirm', { what: t(`nav.${kind === 'playbooks' ? 'playbooks' : kind === 'schedules' ? 'schedules' : 'servers'}`) }))) return;
    if (kind === 'servers')   { await api.resetServers();   qc.invalidateQueries({ queryKey: ['servers'] }); }
    if (kind === 'schedules') { await api.resetSchedules(); qc.invalidateQueries({ queryKey: ['schedules'] }); }
    if (kind === 'playbooks') { await api.resetPlaybooks(); qc.invalidateQueries({ queryKey: ['playbooks'] }); }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" /> {t('set.dangerTitle')}
        </CardTitle>
        <CardDescription>{t('set.dangerDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(['servers', 'schedules', 'playbooks'] as const).map((kind) => (
          <div key={kind} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <div className="font-medium">{t(`set.reset.${kind}`)}</div>
              <div className="text-xs text-muted-foreground">{t(`set.reset.${kind}Desc`)}</div>
            </div>
            <Button variant="destructive" size="sm" onClick={reset(kind)}>
              <RefreshCw className="h-4 w-4" /> {t('set.resetBtn')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
