import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { User, KeyRound, ShieldCheck, ShieldOff, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/* ── Section wrapper ──────────────────────────────────────────────────── */
function Section({ icon: Icon, title, children, className }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border bg-card', className)}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}

/* ── Profile page ─────────────────────────────────────────────────────── */
export function ProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // ─ Profile data
  const { data: profile } = useQuery<Record<string, unknown>>({
    queryKey: ['profile'],
    queryFn: () => api.getProfile() as Promise<Record<string, unknown>>,
    staleTime: 5 * 60_000,
  });

  const username = (profile?.username as string) || '';
  const isAdmin = profile?.role === 'admin';

  // ─ Account form
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (profile) {
      setDisplayName((profile.displayName as string) || '');
      setEmail((profile.email as string) || '');
    }
  }, [profile]);

  const saveAccount = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      await api.updateProfile({ displayName, email });
      return {};
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      showToast(t('auth.profileSaved'), 'success');
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ─ Password form
  const [pwOpen, setPwOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showCurPw, setShowCurPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);

  const changePw = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      if (newPw.length < 12) throw new Error(t('set.pwTooShort'));
      if (newPw !== confirmPw) throw new Error(t('set.pwMismatch'));
      await api.authChangePassword(curPw, newPw);
      return {};
    },
    onSuccess: () => {
      showToast(t('auth.pwChangedSignOut'), 'success');
      setTimeout(() => { setToken(null); window.location.reload(); }, 1500);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  // ─ 2FA
  const totpStatus = useQuery<{ enabled: boolean }>({
    queryKey: ['totp-status'],
    queryFn: () => api.totpStatus() as unknown as Promise<{ enabled: boolean }>,
  });

  const [setupData, setSetupData] = useState<{ qrDataUrl?: string; otpauthUrl?: string; secret: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  const startSetup = useMutation({
    mutationFn: async (): Promise<{ qrDataUrl?: string; otpauthUrl?: string; secret: string }> => {
      const res = await api.totpSetup() as unknown as { qrDataUrl?: string; otpauthUrl?: string; secret: string };
      return res;
    },
    onSuccess: (data) => setSetupData(data),
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const confirmTotp = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      await api.totpConfirm(totpCode.replace(/\s/g, ''));
      return {};
    },
    onSuccess: () => {
      showToast(t('auth.2faEnabled'), 'success');
      setSetupData(null);
      setTotpCode('');
      qc.invalidateQueries({ queryKey: ['totp-status'] });
    },
    onError: (e: Error) => showToast(e.message || t('set.totpInvalid'), 'error'),
  });

  const disableTotp = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      if (!disablePw) throw new Error(t('profile.passwordRequired'));
      await api.totpDisable(disablePw);
      return {};
    },
    onSuccess: () => {
      showToast(t('auth.2faDisabled'), 'success');
      setShowDisable(false);
      setDisablePw('');
      qc.invalidateQueries({ queryKey: ['totp-status'] });
    },
    onError: (e: Error) => showToast(e.message || t('profile.incorrectPassword'), 'error'),
  });

  const totpEnabled = totpStatus.data?.enabled ?? false;
  // Use qrDataUrl (old backend) or otpauthUrl (api.ts declares this)
  const qrSrc = setupData?.qrDataUrl || setupData?.otpauthUrl || '';

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Page header */}
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground text-lg">
          <User className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {(profile?.displayName as string) || username}
          </h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {(profile?.displayName as string) && (
              <span className="font-mono text-xs">@{username}</span>
            )}
            {!((profile?.displayName as string)) && email && <span>{email}</span>}
            {!((profile?.displayName as string)) && !email && (
              <span className="opacity-50">{t('profile.noEmail')}</span>
            )}
            {isAdmin && (
              <span className="rounded bg-primary px-1.5 py-px text-[9px] font-semibold uppercase text-primary-foreground">
                {t('profile.adminBadge')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Account ──────────────────────────────────────────────────── */}
      <Section icon={User} title={t('profile.account')}>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.displayName')}</label>
            <input
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={username}
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.username')}</label>
            <div className="flex flex-1 items-center gap-2">
              <input
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm opacity-55 cursor-default"
                value={username}
                readOnly
                tabIndex={-1}
              />
              <span className="whitespace-nowrap text-xs text-muted-foreground">{t('profile.readOnly')}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.email')}</label>
            <input
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="flex justify-end">
            <button
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={() => saveAccount.mutate()}
              disabled={saveAccount.isPending}
            >
              {t('profile.saveChanges')}
            </button>
          </div>
        </div>
      </Section>

      {/* ── Password ─────────────────────────────────────────────────── */}
      <Section icon={KeyRound} title={t('profile.passwordSection')}>
        {!pwOpen ? (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{t('profile.passwordDots')}</span>
            <button
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => setPwOpen(true)}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {t('profile.changePassword')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <input
                className="w-full rounded-md border bg-background px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                type={showCurPw ? 'text' : 'password'}
                placeholder={t('profile.currentPassword')}
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowCurPw((v) => !v)}
                tabIndex={-1}
              >
                {showCurPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="relative">
              <input
                className="w-full rounded-md border bg-background px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                type={showNewPw ? 'text' : 'password'}
                placeholder={t('profile.newPassword')}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowNewPw((v) => !v)}
                tabIndex={-1}
              >
                {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              type="password"
              placeholder={t('profile.confirmPassword')}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              autoComplete="new-password"
            />
            <div className="flex justify-end gap-2">
              <button
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => { setPwOpen(false); setCurPw(''); setNewPw(''); setConfirmPw(''); }}
              >
                {t('profile.cancel')}
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                onClick={() => changePw.mutate()}
                disabled={changePw.isPending}
              >
                {t('profile.updatePassword')}
              </button>
            </div>
          </div>
        )}
      </Section>

      {/* ── Two-Factor Authentication ────────────────────────────────── */}
      <Section icon={ShieldCheck} title={t('profile.twoFactor')}>
        {totpStatus.isLoading ? (
          <span className="text-sm text-muted-foreground">{t('profile.checking')}</span>
        ) : totpEnabled ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                {t('profile.twoFactorEnabled')}
              </span>
              <button
                className="inline-flex items-center gap-2 rounded-md border border-destructive/30 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                onClick={() => setShowDisable((v) => !v)}
              >
                <ShieldOff className="h-3.5 w-3.5" />
                {t('profile.disable2fa')}
              </button>
            </div>
            {showDisable && (
              <div className="space-y-3 rounded-md border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t('profile.twoFactorDisableHint')}</p>
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  type="password"
                  placeholder={t('profile.currentPassword')}
                  value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)}
                  autoComplete="current-password"
                />
                <div className="flex gap-2">
                  <button
                    className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    onClick={() => disableTotp.mutate()}
                    disabled={disableTotp.isPending}
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    {t('profile.disable2fa')}
                  </button>
                  <button
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                    onClick={() => { setShowDisable(false); setDisablePw(''); }}
                  >
                    {t('profile.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('profile.twoFactorDisabled')}</span>
              <button
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => startSetup.mutate()}
                disabled={startSetup.isPending}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {t('profile.enable2fa')}
              </button>
            </div>
            {setupData && (
              <div className="space-y-4 rounded-md border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t('set.totpScanQR')}</p>
                {qrSrc && (
                  <img
                    src={qrSrc}
                    alt="QR Code"
                    className="h-40 w-40 rounded-lg border bg-white p-2"
                  />
                )}
                <p className="text-sm text-muted-foreground">
                  {t('set.totpSecret')}<br />
                  <code className="break-all font-mono text-xs">{setupData.secret}</code>
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    className="w-36 rounded-md border bg-background px-3 py-2 text-center text-xl tracking-[8px] font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    placeholder="______"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                  />
                  <button
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    onClick={() => confirmTotp.mutate()}
                    disabled={confirmTotp.isPending}
                  >
                    {t('set.totpVerify')}
                  </button>
                  <button
                    className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => { setSetupData(null); setTotpCode(''); }}
                  >
                    {t('profile.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
