import { Timestamp } from '@/components/ui/timestamp';
import { MfaPolicyOverview } from '@/features/users/MfaPolicyOverview';
import { InvitationsPanel, InvitationLink, type Invitation } from '@/features/users/invitations';
import { RoleAccessChanges, RoleAccessSummary, matchesRolePreset, editableCapabilities } from '@/features/users/role-access-changes';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Users, ShieldCheck, UserPlus, Pencil, KeyRound, Trash2, ShieldAlert,
  Plus, Lock, Server as ServerIcon, ArrowUp, Terminal, Clock, SlidersHorizontal,
  Puzzle, MoreHorizontal,
  UserX, UserCheck, LogOut,
} from 'lucide-react';
import { api, apiFetch, ApiError } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { useProfile } from '@/lib/queries';
import { asArray, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { SkeletonRow } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OverflowItem, OverflowMenu, OverflowSep } from '@/components/ui/overflow-menu';
import { useUi } from '@/lib/store';
import { SettingsRow, SettingsSection } from '../_row';
import { useUrlTab } from '@/lib/use-url-tab';

// -------------------- types --------------------

interface UserRow {
  id: string | number;
  username: string;
  display_name?: string;
  email?: string;
  role: string;
  totp_enabled?: boolean;
  disabled?: boolean;
  last_login_at?: string | null;
}

interface RoleRow {
  id: string;
  revision?: string;
  name: string;
  is_system?: boolean;
  permissions?: RolePermissions;
  effectivePermissions?: RolePermissions;
}

interface RolePermissions {
  servers?: 'all' | { groups?: (string | number)[]; servers?: (string | number)[] };
  playbooks?: 'all' | string[];
  plugins?: 'all' | string[];
  [cap: string]: unknown;
}

interface ServerRow { id: string | number; name: string; ip_address?: string; status?: string }
interface GroupRow { id: string | number; name: string; color?: string }
interface PlaybookRow { filename: string }

// -------------------- root --------------------

const USER_ROLE_TABS = ['users', 'roles'] as const;

export function UsersRolesTab() {
  const { t } = useTranslation();
  const userRoleTabs = useUrlTab('users', USER_ROLE_TABS);
  return (
    <Tabs value={userRoleTabs.value} onValueChange={userRoleTabs.onValueChange} className="space-y-4">
      <TabsList>
        <TabsTrigger value="users">
          <Users className="mr-2 h-4 w-4" /> {t('set.userManagement')}
        </TabsTrigger>
        <TabsTrigger value="roles">
          <ShieldCheck className="mr-2 h-4 w-4" /> {t('set.roleManagement')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="users"><UsersPanel /></TabsContent>
      <TabsContent value="roles"><RolesPanel /></TabsContent>
    </Tabs>
  );
}

// ============================================================
// USERS
// ============================================================

function UsersPanel() {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const usersQ = useQuery<UserRow[]>({
    queryKey: ['users'],
    queryFn: () => api.getUsers() as unknown as Promise<UserRow[]>,
  });
  const rolesQ = useQuery<RoleRow[]>({
    queryKey: ['roles'],
    queryFn: () => api.getRoles() as unknown as Promise<RoleRow[]>,
  });

  const [editing, setEditing] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  const [confirm2fa, setConfirm2fa] = useState<UserRow | null>(null);
  const [statusTarget, setStatusTarget] = useState<UserRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserRow | null>(null);

  const users = usersQ.data || [];
  const roles = rolesQ.data || [];
  const usersLoading = usersQ.isLoading || rolesQ.isLoading;
  const usersError = usersQ.error || rolesQ.error;

  return (
    <SettingsSection
      icon={<Users className="h-4 w-4" />}
      title="Users"
      headerRight={
        <div className="flex items-center gap-3">
          {usersQ.isSuccess && <span className="text-xs text-muted-foreground">{users.length} {users.length === 1 ? 'user' : 'users'}</span>}
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlus className="h-4 w-4" /> {t('set.addUser')}
          </Button>
        </div>
      }
    >
      {usersLoading && (
        <div className="py-2">
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
        </div>
      )}
      {usersError && (
        <QueryErrorState
          compact
          error={usersError}
          title="Users and roles could not be loaded"
          onRetry={() => void Promise.all([usersQ.refetch(), rolesQ.refetch()])}
        />
      )}
      {usersQ.isSuccess && rolesQ.isSuccess && users.length === 0 && (
        <EmptyState
          compact
          icon={<Users className="h-5 w-5" />}
          title={t('set.noUsersFound')}
        />
      )}
      {usersQ.isSuccess && rolesQ.isSuccess && users.map((u, i) => {
        const roleName = roles.find(r => r.id === u.role)?.name || u.role;
        const shown = u.display_name || u.username;
        const initial = (shown || '?')[0].toUpperCase();
        const isSelf = String(u.id) === String(profile?.id ?? '');
        return (
          <SettingsRow
            key={u.id}
            noBorder={i === users.length - 1}
            label={
              <span className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {initial}
                </span>
                <span className="flex flex-col">
                  <span className={cn(u.disabled && 'text-muted-foreground line-through')}>{shown}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">@{u.username}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {u.last_login_at
                      ? <>{t('set.lastLogin', { date: '' })}<Timestamp value={u.last_login_at} /></>
                      : t('set.neverLoggedIn')}
                  </span>
                </span>
              </span>
            }
          >
            <StatusBadge tone={u.role === 'admin' ? 'info' : 'neutral'}>{roleName}</StatusBadge>
            <StatusBadge tone={u.totp_enabled ? 'success' : 'muted'}>{u.totp_enabled ? '2FA on' : '2FA off'}</StatusBadge>
            {Boolean(u.disabled) && <StatusBadge tone="danger">{t('set.disabled')}</StatusBadge>}
            <OverflowMenu title={`Actions for ${shown}`}>
              <OverflowItem icon={Pencil} onClick={() => setEditing(u)}>
                {t('common.edit')}
              </OverflowItem>
              <OverflowItem icon={KeyRound} onClick={() => setResetTarget(u)}>
                {t('set.resetPassword')}
              </OverflowItem>
              {Boolean(u.totp_enabled) && (
                <OverflowItem icon={ShieldAlert} warning onClick={() => setConfirm2fa(u)}>
                  {t('set.disable2fa')}
                </OverflowItem>
              )}
              <OverflowItem icon={LogOut} onClick={() => setRevokeTarget(u)}>
                {t('set.revokeSessions')}
              </OverflowItem>
              {!isSelf && (
                <>
                  <OverflowSep />
                  <OverflowItem icon={u.disabled ? UserCheck : UserX} warning={!u.disabled} onClick={() => setStatusTarget(u)}>
                    {u.disabled ? t('set.enableUser') : t('set.disableUser')}
                  </OverflowItem>
                  <OverflowItem icon={Trash2} danger onClick={() => setConfirmDelete(u)}>
                    {t('common.delete')}
                  </OverflowItem>
                </>
              )}
            </OverflowMenu>
          </SettingsRow>
        );
      })}
      <MfaPolicyOverview />
      <InvitationsPanel roles={roles} />

      {(creating || editing) && (
        <UserFormDialog
          user={editing}
          roles={roles}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
      {resetTarget && (
        <ResetPasswordDialog user={resetTarget} onClose={() => setResetTarget(null)} />
      )}
      {confirm2fa && (
        <Disable2FADialog user={confirm2fa} onClose={() => setConfirm2fa(null)} />
      )}
      {confirmDelete && (
        <DeleteUserDialog user={confirmDelete} onClose={() => setConfirmDelete(null)} />
      )}
      {statusTarget && (
        <UserStatusDialog user={statusTarget} onClose={() => setStatusTarget(null)} />
      )}
      {revokeTarget && (
        <RevokeSessionsDialog user={revokeTarget} onClose={() => setRevokeTarget(null)} />
      )}
    </SettingsSection>
  );
}

function UserStatusDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const disabling = !user.disabled;
  const m = useMutation({
    mutationFn: () => api.setUserDisabled(user.id, disabling),
    onSuccess: () => {
      showToast(t(disabling ? 'set.userDisabled' : 'set.userEnabled') as string, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => showToast((e as Error).message, 'error'),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t(disabling ? 'set.disableUser' : 'set.enableUser')}
      description={t(disabling ? 'set.disableUserConfirm' : 'set.enableUserConfirm', { username: user.username })}
      confirmLabel={t(disabling ? 'set.disableUser' : 'set.enableUser')}
      variant={disabling ? 'destructive' : 'warning'}
      onConfirm={() => m.mutate()}
      isPending={m.isPending}
    />
  );
}

function RevokeSessionsDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const m = useMutation({
    mutationFn: () => api.revokeUserSessions(user.id),
    onSuccess: () => { showToast(t('set.sessionsRevoked') as string, 'success'); onClose(); },
    onError: (e) => showToast((e as Error).message, 'error'),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t('set.revokeSessions')}
      description={t('set.revokeSessionsConfirm', { username: user.username })}
      confirmLabel={t('set.revokeSessions')}
      variant="destructive"
      onConfirm={() => m.mutate()}
      isPending={m.isPending}
    />
  );
}

function useAccessResources() {
  const environmentId = useUi((state) => state.environmentId);

  const serversQ = useQuery<ServerRow[]>({ queryKey: ['servers', environmentId], queryFn: () => api.getServers(environmentId) as unknown as Promise<ServerRow[]> });
  // Resolve host and folder names within the selected environment, using
  // the same cache keys as the infrastructure views.
  const groupsQ = useQuery<GroupRow[]>({ queryKey: ['server-groups', environmentId], queryFn: () => api.getServerGroups(environmentId) as unknown as Promise<GroupRow[]> });
  const playbooksQ = useQuery<PlaybookRow[]>({ queryKey: ['playbooks'], queryFn: () => api.getPlaybooks() as unknown as Promise<PlaybookRow[]> });

  const labels = {
    servers: Object.fromEntries((serversQ.data || []).map(item => [String(item.id), item.name])),
    groups: Object.fromEntries((groupsQ.data || []).map(item => [String(item.id), item.name])),
    playbooks: Object.fromEntries((playbooksQ.data || []).map(item => [item.filename, item.filename])),
  };
  return {serversQ, groupsQ, playbooksQ, labels};
}

export function UserFormDialog({
  user, roles, onClose,
}: { user: UserRow | null; roles: RoleRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isEdit = !!user;
  const [invite, setInvite] = useState(true);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const {labels} = useAccessResources();
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(user?.role ?? '');
  const previousPermissions = user?.role === 'admin' ? {full:true} : roles.find(item => item.id === user?.role)?.effectivePermissions;
  const selectedPermissions = role === 'admin' ? {full:true} : roles.find(item => item.id === role)?.effectivePermissions;
  const roleChanged = !user || role !== user.role;
  const accessReviewAvailable = !roleChanged || (!!selectedPermissions && (!user || !!previousPermissions));
  const [roleConflict, setRoleConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!roles.some((item) => item.id === role)) throw new Error('Select a role before saving.');
      if (!accessReviewAvailable || roleConflict) throw new Error('Reload and review role permissions before saving.');
      if (!username.trim()) throw new Error(t('set.usernameRequired') as string);
      if (!isEdit && !invite && password.length < 12) throw new Error(t('set.passwordTooShort') as string);
      if (isEdit) {
        return api.updateUser(user!.id, { username, displayName, email, role, expectedRole:user!.role, roleRevision:roles.find(item => item.id === role)?.revision });
      }
      if (invite) return apiFetch<Invitation>('/users/invitations', {method: 'POST', body: {username, displayName, email, role, roleRevision: roles.find(item => item.id === role)?.revision}});
      return api.createUser({ username, displayName, email, password, role, roleRevision:roles.find(item => item.id === role)?.revision });
    },
    onSuccess: (result) => {
      if (!isEdit && invite) { setInvitation(result as Invitation); void qc.invalidateQueries({queryKey: ['user-invitations']}); return; }
      showToast(isEdit ? (t('user.updated') as string) : (t('user.created') as string), 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => {
      setError((e as Error).message);
      if (e instanceof ApiError && e.field === 'role_revision') {
        setRoleConflict(true);
        void qc.invalidateQueries({queryKey:['roles']});
        void qc.invalidateQueries({queryKey:['users']});
      }
    },
  });

  if (invitation) return <Dialog open onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Invitation created</DialogTitle></DialogHeader><InvitationLink invitation={invitation}/><DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter></DialogContent></Dialog>;

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !save.isPending) onClose(); }}>
      <DialogContent className="flex max-w-lg max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isEdit ? t('set.editUser') : t('set.addUser')}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={save.isPending} className="min-h-0 space-y-3 overflow-y-auto pr-1">
          {!isEdit && <div><Label htmlFor="user-creation-method">Account setup</Label><select id="user-creation-method" value={invite ? 'invite' : 'direct'} onChange={event => { setInvite(event.target.value === 'invite'); setPassword(''); }} className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"><option value="invite">Invite with a link (recommended)</option><option value="direct">Create with an initial password</option></select><p className="mt-1 text-xs text-muted-foreground">An invitation lets the recipient choose their password. Review the role below before creating the link.</p></div>}
          <div>
            <Label htmlFor="user-username">{t('set.username')}</Label>
            <Input id="user-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
            <p className="mt-1 text-[11px] text-muted-foreground">{t('set.usernameHint')}</p>
          </div>
          <div>
            <Label htmlFor="user-display-name">{t('set.displayName')}</Label>
            <Input id="user-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} autoComplete="off" />
            <p className="mt-1 text-[11px] text-muted-foreground">{t('set.displayNameHint')}</p>
          </div>
          <div>
            <Label htmlFor="user-email">{t('set.email')}</Label>
            <Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          {!isEdit && !invite && (
            <div>
              <Label htmlFor="user-password">{t('set.password')}</Label>
              <Input id="user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={t('set.passwordMinHint') as string} autoComplete="new-password" />
            </div>
          )}
          <div>
            <Label htmlFor="user-role">{t('set.role') ?? 'Role'}</Label>
            <select id="user-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="" disabled>Select a role…</option>
              {roles.map(r => (
                <option key={r.id} value={r.id}>
                {r.name}{r.is_system ? '' : ` ${t('set.roleCustomSuffix')}`}
                </option>
              ))}
            </select>
          </div>
          {!isEdit && <details className="rounded-md border p-3 text-xs">
            <summary className="cursor-pointer font-medium">Choose by role preset</summary>
            <p className="mt-2 text-muted-foreground">Choose an existing role with matching capabilities, then review its resource scope below. Selecting a preset does not create or modify a shared role.</p>
            <div className="mt-3 space-y-3">{ROLE_PRESETS.map(preset => {
              const matchingRoles = roles.filter(item => item.id !== 'admin' && matchesRolePreset(item.effectivePermissions, preset.caps));
              return <div key={preset.id}>
                <p className="font-medium">{preset.label}</p>
                <p className="text-muted-foreground">{preset.description}</p>
                {matchingRoles.length ? <div className="mt-1 flex flex-wrap gap-2">{matchingRoles.map(item => <Button key={item.id} type="button" size="sm" variant={role === item.id ? 'default' : 'outline'} onClick={() => setRole(item.id)} aria-pressed={role === item.id}>Select {item.name}</Button>)}</div>
                  : <p className="mt-1 text-muted-foreground">No existing role matches. Create one from this preset in Role Management.</p>}
              </div>;
            })}</div>
          </details>}
          {isEdit && roleChanged && <RoleAccessChanges labels={labels} before={previousPermissions} after={selectedPermissions} capabilityKeys={ALL_CAPS.map(cap => cap.key)} />}
          {role && <RoleAccessSummary permissions={selectedPermissions} labels={labels} sensitiveCapabilityKeys={ALL_CAPS.filter(cap => DANGEROUS_CAPS.has(cap.key)).map(cap => cap.key)} />}
        </fieldset>
        {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
        <DialogFooter className="shrink-0">
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || roleConflict || !role || !accessReviewAvailable}>
            {save.isPending ? 'Saving…' : isEdit ? t('set.saveBtn') : invite ? 'Create invitation' : t('set.createBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      if (pw.length < 12) throw new Error(t('set.passwordTooShort') as string);
      return api.resetUserPassword(user.id, pw);
    },
    onSuccess: () => { showToast(t('user.pwReset') as string, 'success'); onClose(); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('set.resetPasswordFor')} <em>{user.username}</em></DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t('set.password')}</Label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
            placeholder={t('set.passwordMinHint') as string} autoComplete="new-password" />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            <KeyRound className="h-4 w-4" /> {t('set.resetPassword')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Disable2FADialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.disableUserTotp(user.id),
    onSuccess: () => {
      showToast(t('set.2faDisabled') as string, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }) as string, 'error'),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('set.disable2faTitle')}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t('set.disable2faConfirm', { username: user.username })}</p>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={() => m.mutate()} disabled={m.isPending}>
            {t('set.disable2faBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: () => {
      showToast(t('user.deleted') as string, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }) as string, 'error'),
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t('common.delete')}
      description={t('set.deleteUserConfirm', { username: user.username })}
      confirmLabel={t('common.delete')}
      variant="destructive"
      confirmTextValue={user.username}
      confirmInputLabel="Confirm username"
      onConfirm={() => m.mutate()}
      isPending={m.isPending}
    />
  );
}

// ============================================================
// ROLES
// ============================================================

function RolesPanel() {
  const { t } = useTranslation();
  const rolesQ = useQuery<RoleRow[]>({
    queryKey: ['roles'],
    queryFn: () => api.getRoles() as unknown as Promise<RoleRow[]>,
  });
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RoleRow | null>(null);

  const roles = rolesQ.data || [];
  const builtIn = roles.filter(r => r.is_system);
  const custom = roles.filter(r => !r.is_system);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={<ShieldCheck className="h-4 w-4" />}
        title={t('set.roleManagement')}
        description={t('set.roleBuiltInHint')}
      >
        {rolesQ.isLoading && <div className="py-2"><SkeletonRow cols={2} /><SkeletonRow cols={2} /></div>}
        {rolesQ.isError && (
          <QueryErrorState
            compact
            error={rolesQ.error}
            title="Roles could not be loaded"
            onRetry={() => void rolesQ.refetch()}
          />
        )}
        {rolesQ.isSuccess && builtIn.map((r, i) => (
          <SettingsRow
            key={r.id}
            noBorder={i === builtIn.length - 1}
            label={<span className="flex items-center gap-2"><Lock className="h-3 w-3 text-muted-foreground" /> {r.name}</span>}
            hint={r.id === 'admin' ? 'Full access to everything' : 'All regular capabilities and resources. No administration, Git management or role management.'}
          >
            <Badge variant="secondary">{t('set.builtIn')}</Badge>
          </SettingsRow>
        ))}
      </SettingsSection>

      {rolesQ.isSuccess && <details className="rounded-md border bg-card p-4">
        <summary className="cursor-pointer font-medium">Compare role permissions</summary>
        <p className="my-3 text-sm text-muted-foreground">Capabilities below use effective server-provided permissions. Resource restrictions still apply. Administration is reserved for administrators.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Capability</th>{roles.map(role => <th key={role.id} className="p-2">{role.name}</th>)}</tr></thead><tbody>
          <tr><th className="p-2 font-normal">Administration / Git / roles</th>{roles.map(role => <td key={role.id} className="p-2">{role.id === 'admin' ? 'Allowed' : 'Not allowed'}</td>)}</tr>
          {ALL_CAPS.map(cap => <tr key={cap.key} className="border-t"><th className="p-2 font-normal">{[...SERVER_CAPS].includes(cap) ? "Hosts" : DOCKER_CAPS.includes(cap) ? "Workloads" : UPDATE_CAPS.includes(cap) ? "Updates" : PLAYBOOK_CAPS.includes(cap) ? "Playbooks" : SCHEDULE_CAPS.includes(cap) ? "Schedules" : VAR_CAPS.includes(cap) ? "Variables" : "Other"}: {cap.label}</th>{roles.map(role => <td key={role.id} className="p-2">{role.id === 'admin' ? 'Allowed' : role.effectivePermissions ? role.effectivePermissions[cap.key] === true ? 'Allowed' : 'Not allowed' : 'Not reported'}</td>)}</tr>)}
        </tbody></table></div>
      </details>}

      <SettingsSection
        icon={<ShieldCheck className="h-4 w-4" />}
        title={t('set.customRoles')}
        headerRight={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('set.newRole')}
          </Button>
        }
      >
        {rolesQ.isLoading && (
          <div className="py-2">
            <SkeletonRow cols={3} />
            <SkeletonRow cols={3} />
          </div>
        )}
        {rolesQ.isSuccess && custom.length === 0 && (
          <EmptyState
            compact
            icon={<ShieldCheck className="h-5 w-5" />}
            title={t('set.noCustomRoles')}
            description={t('set.noCustomRolesHint')}
          />
        )}
        {rolesQ.isSuccess && custom.map((r, i) => {
          const p = r.effectivePermissions || {};
          const serverSummary = p.full === true || p.servers === 'all'
            ? t('set.allServers')
            : `${p.servers?.groups?.length || 0} group(s), ${p.servers?.servers?.length || 0} server(s)`;
          const pbSummary = p.full === true || p.playbooks === 'all'
            ? t('set.allPlaybooks') : `${(p.playbooks as string[] | undefined)?.length || 0} playbook(s)`;
          return (
            <SettingsRow
              key={r.id}
              noBorder={i === custom.length - 1}
              label={r.name}
              hint={r.effectivePermissions ? `${serverSummary} · ${pbSummary}` : 'Effective permission details unavailable'}
            >
              <OverflowMenu title={`Actions for ${r.name}`}>
                <OverflowItem icon={Pencil} onClick={() => setEditing(r)}>
                  {t('common.edit')}
                </OverflowItem>
                <OverflowSep />
                <OverflowItem icon={Trash2} danger onClick={() => setConfirmDelete(r)}>
                  {t('common.delete')}
                </OverflowItem>
              </OverflowMenu>
            </SettingsRow>
          );
        })}
      </SettingsSection>

      {(creating || editing) && (
        <RoleFormDialog role={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
      {confirmDelete && (
        <DeleteRoleDialog role={confirmDelete} onClose={() => setConfirmDelete(null)} />
      )}
    </div>
  );
}

function DeleteRoleDialog({ role, onClose }: { role: RoleRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.deleteRole(role.id, role.revision || ''),
    onSuccess: () => {
      showToast(t('role.deleted') as string, 'success');
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
    onError: async (e) => {
      showToast(t('common.errorPrefix', {msg:(e as Error).message}) as string, 'error');
      if (e instanceof ApiError && e.field === 'revision') {
        await qc.invalidateQueries({queryKey:['roles']});
        onClose();
      }
    },
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t('common.delete')}
      description={t('set.deleteRoleConfirm', { name: role.name })}
      confirmLabel={t('common.delete')}
      variant="destructive"
      confirmTextValue={role.name}
      confirmInputLabel="Confirm role name"
      onConfirm={() => m.mutate()}
      isPending={m.isPending}
    />
  );
}

// -------------------- Role form --------------------

interface CapDef { key: string; label: string }
interface RolePreset {
  id: string;
  label: string;
  description: string;
  caps: string[];
  serversMode: 'all' | 'restricted';
  pbMode: 'all' | 'restricted';
}

const SERVER_CAPS: CapDef[] = [
  { key: 'canViewServers', label: 'View' },
  { key: 'canAddServers', label: 'Add' },
  { key: 'canEditServers', label: 'Edit' },
  { key: 'canDeleteServers', label: 'Delete' },
  { key: 'canViewServerHistory', label: 'View host history' },
  { key: 'canUseTerminal', label: 'SSH Terminal' },
  { key: 'canViewFiles', label: 'View & download files' },
  { key: 'canManageFiles', label: 'Upload & transfer files' },
  { key: 'canViewNotes', label: 'View notes' },
  { key: 'canEditNotes', label: 'Edit notes' },
  { key: 'canExportImportServers', label: 'Export / Import' },
];
const DOCKER_CAPS: CapDef[] = [
  { key: 'canViewDocker', label: 'View containers & logs' },
  { key: 'canPullDocker', label: 'Pull & check updates' },
  { key: 'canRestartDocker', label: 'Restart containers' },
  { key: 'canManageDockerCompose', label: 'Manage Compose stacks' },
];
const UPDATE_CAPS: CapDef[] = [
  { key: 'canViewUpdates', label: 'View updates' },
  { key: 'canRunUpdates', label: 'Run update' },
  { key: 'canRebootServers', label: 'Reboot servers' },
  { key: 'canViewCustomUpdates', label: 'View custom tasks' },
  { key: 'canRunCustomUpdates', label: 'Run / check custom tasks' },
  { key: 'canEditCustomUpdates', label: 'Add / edit custom tasks' },
  { key: 'canDeleteCustomUpdates', label: 'Delete custom tasks' },
];
const PLAYBOOK_CAPS: CapDef[] = [
  { key: 'canViewPlaybooks', label: 'View' },
  { key: 'canEditPlaybooks', label: 'Create / Edit' },
  { key: 'canDeletePlaybooks', label: 'Delete' },
  { key: 'canRunPlaybooks', label: 'Run & ad-hoc' },
];
const SCHEDULE_CAPS: CapDef[] = [
  { key: 'canViewSchedules', label: 'View' },
  { key: 'canAddSchedules', label: 'Add' },
  { key: 'canEditSchedules', label: 'Edit' },
  { key: 'canDeleteSchedules', label: 'Delete' },
  { key: 'canToggleSchedules', label: 'Enable / Disable' },
];
const VAR_CAPS: CapDef[] = [
  { key: 'canViewVars', label: 'View' },
  { key: 'canAddVars', label: 'Add' },
  { key: 'canEditVars', label: 'Edit' },
  { key: 'canDeleteVars', label: 'Delete' },
];
const OTHER_CAPS: CapDef[] = [
  { key: 'canViewInfrastructure', label: 'View virtual infrastructure and platforms' },
  { key: 'canViewNetworks', label: 'View networks and IPAM' },
  { key: 'canEditNetworks', label: 'Manage networks and IPAM' },
  { key: 'canViewDeployments', label: 'View deployments' },
  { key: 'canEditDeployments', label: 'Edit deployment definitions' },
  { key: 'canPlanDeployments', label: 'Create deployment plans' },
  { key: 'canApplyDeployments', label: 'Apply deployment plans' },
  { key: 'canDestroyDeployments', label: 'Destroy deployment resources' },
  { key: 'canManageDeploymentPlatforms', label: 'Manage deployment platforms and secrets' },
  { key: 'canViewAudit', label: 'View audit log' },
];

const ALL_CAPS = [
  ...SERVER_CAPS, ...DOCKER_CAPS, ...UPDATE_CAPS, ...PLAYBOOK_CAPS,
  ...SCHEDULE_CAPS, ...VAR_CAPS, ...OTHER_CAPS,
];

const DANGEROUS_CAPS = new Set([
  'canUseTerminal',
  'canManageFiles',
  'canDeleteServers',
  'canManageDockerCompose',
  'canRunUpdates',
  'canRebootServers',
  'canRunCustomUpdates',
  'canEditCustomUpdates',
  'canDeleteCustomUpdates',
  'canEditPlaybooks',
  'canDeletePlaybooks',
  'canRunPlaybooks',
  'canDeleteSchedules',
  'canAddVars',
  'canEditVars',
  'canDeleteVars',
  'canEditDeployments',
  'canPlanDeployments',
  'canApplyDeployments',
  'canDestroyDeployments',
  'canManageDeploymentPlatforms',
  'canEditNetworks',
  'canViewAudit',
]);

const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'viewer',
    label: 'Viewer',
    description: 'Read-only access for inventory, updates, playbooks and schedules.',
    serversMode: 'all',
    pbMode: 'all',
    caps: ['canViewServers', 'canViewDocker', 'canViewUpdates', 'canViewCustomUpdates', 'canViewPlaybooks', 'canViewSchedules', 'canViewVars', 'canViewNotes'],
  },
  {
    id: 'operator',
    label: 'Operator',
    description: 'Can run selected playbooks and routine update actions.',
    serversMode: 'all',
    pbMode: 'all',
    caps: ['canViewServers', 'canViewDocker', 'canViewUpdates', 'canRunUpdates', 'canViewPlaybooks', 'canRunPlaybooks', 'canViewSchedules', 'canViewVars', 'canViewNotes', 'canEditNotes'],
  },
  {
    id: 'maintainer',
    label: 'Maintainer',
    description: 'Can maintain servers, compose stacks, schedules and custom update tasks.',
    serversMode: 'all',
    pbMode: 'all',
    caps: ALL_CAPS.map(c => c.key).filter(k => k !== 'canDeleteServers' && k !== 'canViewAudit'),
  },
  {
    id: 'adminLike',
    label: 'Power user',
    description: 'All regular capabilities, but no Admin settings, Git or role management.',
    serversMode: 'all',
    pbMode: 'all',
    caps: ALL_CAPS.map(c => c.key),
  },
];

function RoleFormDialog({ role, onClose }: { role: RoleRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isEdit = !!role;
  const {serversQ, groupsQ, playbooksQ, labels} = useAccessResources();

  const usersQ = useQuery<UserRow[]>({queryKey:['users'], queryFn:() => api.getUsers() as unknown as Promise<UserRow[]>, enabled:isEdit});
  const p = role?.effectivePermissions || {};
  const assignedUsers = (usersQ.data || []).filter(user => user.role === role?.id);
  const initServersMode = p.servers === 'all' ? 'all' : 'restricted';
  const initPbMode = p.playbooks === 'all' ? 'all' : 'restricted';

  const [name, setName] = useState(role?.name ?? '');
  const [serversMode, setServersMode] = useState<'all' | 'restricted'>(initServersMode);
  const [pbMode, setPbMode] = useState<'all' | 'restricted'>(initPbMode);
  const [groupsSel, setGroupsSel] = useState<Set<string>>(
    new Set(asArray<string | number>(typeof p.servers === 'object' && p.servers?.groups).map(String))
  );
  const [serversSel, setServersSel] = useState<Set<string>>(
    new Set(asArray<string | number>(typeof p.servers === 'object' && p.servers?.servers).map(String))
  );
  const [pbSel, setPbSel] = useState<Set<string>>(
    new Set(Array.isArray(p.playbooks) ? p.playbooks : [])
  );
  const [caps, setCaps] = useState<Record<string, boolean>>(() => editableCapabilities(p, ALL_CAPS.map(cap => cap.key)));
  const proposedPermissions: RolePermissions = {
    ...caps,
    servers: serversMode === 'all' ? 'all' : {groups:[...groupsSel],servers:[...serversSel]},
    playbooks: pbMode === 'all' ? 'all' : [...pbSel],
  };
  const [error, setError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);

  const toggleSet = (set: Set<string>, setter: (s: Set<string>) => void, val: string) => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    setter(next);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error(t('sc.nameRequired') as string);
      if (isEdit && !role?.effectivePermissions) throw new Error('Effective permission details are unavailable. Reload roles before editing access.');
      const permissions = proposedPermissions;
      if (isEdit) return api.updateRole(role!.id, { name, permissions, revision:role!.revision });
      return api.createRole({ name, permissions });
    },
    onSuccess: () => {
      showToast(isEdit ? (t('role.updated') as string) : (t('role.created') as string), 'success');
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
    onError: (e) => {
      setError((e as Error).message);
      if (e instanceof ApiError && e.field === 'revision') {
        setRevisionConflict(true);
        void qc.invalidateQueries({queryKey:['roles']});
      }
    },
  });

  const enabledCaps = ALL_CAPS.filter(c => !!caps[c.key]);
  const dangerousEnabled = enabledCaps.filter(c => DANGEROUS_CAPS.has(c.key));

  const applyPreset = (preset: RolePreset) => {
    const allowed = new Set(preset.caps);
    const nextCaps: Record<string, boolean> = {};
    ALL_CAPS.forEach(c => { nextCaps[c.key] = allowed.has(c.key); });
    setCaps(nextCaps);
    setServersMode(preset.serversMode);
    setPbMode(preset.pbMode);
  };

  const referenceQueries = [serversQ, groupsQ, playbooksQ, ...(isEdit ? [usersQ] : [])];
  const referenceError = referenceQueries.find((query) => query.isError)?.error;
  const referencesLoading = referenceQueries.some((query) => query.isLoading);
  if (referenceError || referencesLoading) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isEdit ? t('set.editRole', { name: role!.name }) : t('set.newRole')}
            </DialogTitle>
          </DialogHeader>
          {referenceError ? (
            <QueryErrorState
              compact
              error={referenceError}
              title="Role scope references could not be loaded"
              onRetry={() => void Promise.all(referenceQueries.map((query) => query.refetch()))}
            />
          ) : (
            <div className="space-y-2 py-4">
              <SkeletonRow cols={3} />
              <SkeletonRow cols={3} />
              <SkeletonRow cols={3} />
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-5 pt-5">
          <DialogTitle>
            {isEdit ? t('set.editRole', { name: role!.name }) : t('set.newRole')}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
          {/* Name */}
          <div>
            <Label>{t('set.roleName')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Team" />
          </div>

          {isEdit && <RoleAccessChanges labels={labels} before={role?.effectivePermissions} after={proposedPermissions} capabilityKeys={ALL_CAPS.map(cap => cap.key)} description={`Saved role → proposed changes. Affects ${assignedUsers.length} assigned user${assignedUsers.length === 1 ? '' : 's'}, including disabled accounts.`} />}

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Presets</div>
                <div className="text-xs text-muted-foreground">Start with a scoped baseline, then adjust resources and capabilities.</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {ROLE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="rounded-md border bg-background px-3 py-2 text-left transition hover:border-strong hover:bg-accent/50"
                >
                  <div className="text-sm font-medium">{preset.label}</div>
                  <div className="mt-1 min-h-[32px] text-xs text-muted-foreground">{preset.description}</div>
                </button>
              ))}
            </div>
          </div>

          <RolePreview
            serversMode={serversMode}
            pbMode={pbMode}
            groupsSelected={groupsSel.size}
            serversSelected={serversSel.size}
            playbooksSelected={pbSel.size}
            enabledCaps={enabledCaps}
            dangerousCaps={dangerousEnabled}
          />

          {/* Servers */}
          <Section icon={<ServerIcon className="h-3.5 w-3.5" />} title={t('set.capServers')}
            onSelectAll={() => setCaps(c => bulkToggle(c, SERVER_CAPS.concat(DOCKER_CAPS)))}>
            <RadioRow name="servers" mode={serversMode} setMode={setServersMode} />
            {serversMode === 'restricted' && (
              <div className="space-y-3 rounded-md border p-3">
                {(groupsQ.data?.length ?? 0) > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{t('set.serverGroups')}</div>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {asArray<GroupRow>(groupsQ.data).map(g => (
                        <CheckRow key={g.id}
                          checked={groupsSel.has(String(g.id))}
                          onChange={() => toggleSet(groupsSel, setGroupsSel, String(g.id))}
                          label={
                            <span className="flex items-center gap-2">
                              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: g.color || 'var(--brand, currentColor)' }} />
                              {g.name}
                            </span>
                          } />
                      ))}
                    </div>
                  </div>
                )}
                {(serversQ.data?.length ?? 0) > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">{t('set.individualServers')}</div>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {asArray<ServerRow>(serversQ.data).map(s => (
                        <CheckRow key={s.id}
                          checked={serversSel.has(String(s.id))}
                          onChange={() => toggleSet(serversSel, setServersSel, String(s.id))}
                          label={
                            <span className="flex items-center gap-2">
                              <span className={`inline-block h-2 w-2 rounded-full ${s.status === 'online' ? 'bg-emerald-500' : s.status === 'offline' ? 'bg-red-500' : 'bg-muted-foreground'}`} />
                              {s.name}
                              <span className="font-mono text-[11px] text-muted-foreground">{s.ip_address}</span>
                            </span>
                          } />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <CapGrid caps={SERVER_CAPS} caps2={caps} setCaps={setCaps} />
            <div className="mt-2 text-xs font-medium text-muted-foreground">Docker</div>
            <CapGrid caps={DOCKER_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>

          {/* Updates */}
          <Section icon={<ArrowUp className="h-3.5 w-3.5" />} title={t('set.capUpdates')}
            onSelectAll={() => setCaps(c => bulkToggle(c, UPDATE_CAPS))}>
            <CapGrid caps={UPDATE_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>

          {/* Playbooks */}
          <Section icon={<Terminal className="h-3.5 w-3.5" />} title={t('set.capPlaybooks')}
            onSelectAll={() => setCaps(c => bulkToggle(c, PLAYBOOK_CAPS))}>
            <RadioRow name="playbooks" mode={pbMode} setMode={setPbMode} />
            {pbMode === 'restricted' && (
              <div className="space-y-1 rounded-md border p-3">
                {asArray<PlaybookRow>(playbooksQ.data).map(pb => (
                  <CheckRow key={pb.filename}
                    checked={pbSel.has(pb.filename)}
                    onChange={() => toggleSet(pbSel, setPbSel, pb.filename)}
                    label={<span className="flex items-center gap-2"><Terminal className="h-3 w-3 text-muted-foreground" />{pb.filename}</span>}
                  />
                ))}
              </div>
            )}
            <CapGrid caps={PLAYBOOK_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>

          {/* Schedules */}
          <Section icon={<Clock className="h-3.5 w-3.5" />} title={t('set.capSchedules')}
            onSelectAll={() => setCaps(c => bulkToggle(c, SCHEDULE_CAPS))}>
            <CapGrid caps={SCHEDULE_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>

          {/* Variables */}
          <Section icon={<SlidersHorizontal className="h-3.5 w-3.5" />} title={t('set.capVariables')}
            onSelectAll={() => setCaps(c => bulkToggle(c, VAR_CAPS))}>
            <CapGrid caps={VAR_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>

          {/* Other */}
          <Section icon={<MoreHorizontal className="h-3.5 w-3.5" />} title={t('set.capOther')}
            onSelectAll={() => setCaps(c => bulkToggle(c, OTHER_CAPS))}>
            <CapGrid caps={OTHER_CAPS} caps2={caps} setCaps={setCaps} />
          </Section>


        </div>

        {error && <p role="alert" className="shrink-0 px-5 py-2 text-sm text-destructive">{error}</p>}
        <DialogFooter className="shrink-0 border-t bg-card px-5 py-3">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || revisionConflict || (isEdit && !role?.effectivePermissions)}>
            {isEdit ? t('set.saveBtn') : t('set.createRole')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function bulkToggle(current: Record<string, boolean>, defs: CapDef[]): Record<string, boolean> {
  const allOn = defs.every(d => current[d.key]);
  const next = { ...current };
  defs.forEach(d => { next[d.key] = !allOn; });
  return next;
}

function resourceSummary(mode: 'all' | 'restricted', selected: number, label: string) {
  if (mode === 'all') return `All ${label}`;
  if (selected === 0) return `No ${label}`;
  return `${selected} ${label}`;
}

function RolePreview({
  serversMode,
  pbMode,
  groupsSelected,
  serversSelected,
  playbooksSelected,
  enabledCaps,
  dangerousCaps,
}: {
  serversMode: 'all' | 'restricted';
  pbMode: 'all' | 'restricted';
  groupsSelected: number;
  serversSelected: number;
  playbooksSelected: number;
  enabledCaps: CapDef[];
  dangerousCaps: CapDef[];
}) {
  const serverScope = serversMode === 'all'
    ? 'All servers'
    : `${groupsSelected} groups, ${serversSelected} servers`;

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Live preview</div>
          <div className="text-xs text-muted-foreground">What users with this role can reach right now.</div>
        </div>
        <Badge variant={dangerousCaps.length > 0 ? 'destructive' : 'secondary'}>
          {dangerousCaps.length} sensitive
        </Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <PreviewMetric label="Hosts" value={serverScope} />
        <PreviewMetric label="Playbooks" value={resourceSummary(pbMode, playbooksSelected, 'playbooks')} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {enabledCaps.length === 0 ? (
          <span className="text-xs text-muted-foreground">No capabilities enabled.</span>
        ) : enabledCaps.slice(0, 12).map(cap => (
          <Badge key={cap.key} variant={DANGEROUS_CAPS.has(cap.key) ? 'destructive' : 'secondary'} className="text-[10px]">
            {cap.label}
          </Badge>
        ))}
        {enabledCaps.length > 12 && (
          <Badge variant="outline" className="text-[10px]">+{enabledCaps.length - 12}</Badge>
        )}
      </div>
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function Section({
  icon, title, onSelectAll, children,
}: { icon: React.ReactNode; title: string; onSelectAll?: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium">{icon} {title}</span>
        {onSelectAll && (
          <button type="button" onClick={onSelectAll}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
            {t('set.selectAll')}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function RadioRow({
  name, mode, setMode,
}: { name: string; mode: 'all' | 'restricted'; setMode: (m: 'all' | 'restricted') => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <label className="flex items-center gap-2">
        <input type="radio" name={`rf-${name}`} checked={mode === 'all'} onChange={() => setMode('all')} />
        {t('set.accessAll')}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name={`rf-${name}`} checked={mode === 'restricted'} onChange={() => setMode('restricted')} />
        {t('set.accessRestrict')}
      </label>
    </div>
  );
}

function CapGrid({
  caps, caps2, setCaps,
}: { caps: CapDef[]; caps2: Record<string, boolean>; setCaps: (fn: (c: Record<string, boolean>) => Record<string, boolean>) => void }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {caps.map(c => (
        <CheckRow key={c.key}
          checked={!!caps2[c.key]}
          onChange={() => setCaps(prev => ({ ...prev, [c.key]: !prev[c.key] }))}
          label={
            <span className="flex min-w-0 items-center gap-1.5">
              {DANGEROUS_CAPS.has(c.key) && <ShieldAlert className="h-3 w-3 flex-shrink-0 text-amber-500" />}
              <span className={cn('truncate', DANGEROUS_CAPS.has(c.key) && 'text-amber-700 dark:text-amber-400')}>{c.label}</span>
            </span>
          }
        />
      ))}
    </div>
  );
}

function CheckRow({
  checked, onChange, label,
}: { checked: boolean; onChange: () => void; label: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-3.5 w-3.5 rounded border-input" />
      <span className="truncate">{label}</span>
    </label>
  );
}
