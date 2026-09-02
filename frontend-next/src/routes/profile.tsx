import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { User, KeyRound, ShieldCheck, ShieldOff, Eye, EyeOff, Paintbrush } from 'lucide-react';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { showToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { THEME_PRESETS, useUi } from '@/lib/store';

/* ── Section wrapper ──────────────────────────────────────────────────── */
function Section({ icon: Icon, title, children, className }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-[3px] border border-border-strong/80 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]', className)}>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-sm border border-primary/15 bg-primary/10 text-primary">
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
  const profileQuery = useQuery<Record<string, unknown>>({
    queryKey: ['profile'],
    queryFn: () => api.getProfile() as Promise<Record<string, unknown>>,
    staleTime: 5 * 60_000,
  });
  const profile = profileQuery.data;

  const username = (profile?.username as string) || '';
  const isAdmin = profile?.role === 'admin';
  const themePreset = useUi((state) => state.themePreset);
  const setThemePreset = useUi((state) => state.setThemePreset);
  const [showAllThemes, setShowAllThemes] = useState(false);

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
    mutationFn: () => api.totpConfirm(totpCode.replace(/\s/g, '')),
    onSuccess: (result) => {
      setToken(result.token);
      showToast(t('auth.2faEnabled'), 'success');
      setSetupData(null);
      setTotpCode('');
      qc.invalidateQueries({ queryKey: ['totp-status'] });
    },
    onError: (e: Error) => showToast(e.message || t('set.totpInvalid'), 'error'),
  });

  const disableTotp = useMutation({
    mutationFn: async () => {
      if (!disablePw) throw new Error(t('profile.passwordRequired'));
      return api.totpDisable(disablePw);
    },
    onSuccess: (result) => {
      setToken(result.token);
      showToast(t('auth.2faDisabled'), 'success');
      setShowDisable(false);
      setDisablePw('');
      qc.invalidateQueries({ queryKey: ['totp-status'] });
    },
    onError: (e: Error) => showToast(e.message || t('profile.incorrectPassword'), 'error'),
  });

  if (profileQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <QueryErrorState
          error={profileQuery.error}
          title="Profile could not be loaded"
          onRetry={() => void profileQuery.refetch()}
        />
      </div>
    );
  }

  const totpEnabled = totpStatus.data?.enabled ?? false;
  // Use qrDataUrl (old backend) or otpauthUrl (api.ts declares this)
  const qrSrc = setupData?.qrDataUrl || setupData?.otpauthUrl || '';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* Page header */}
      <PageHeader
        eyebrow={t('profile.account')}
        title={(profile?.displayName as string) || username}
        description={<span className="flex flex-wrap items-center gap-2">
            {(profile?.displayName as string) && (
              <span className="font-mono text-xs">@{username}</span>
            )}
            {!((profile?.displayName as string)) && email && <span>{email}</span>}
            {!((profile?.displayName as string)) && !email && (
              <span className="opacity-50">{t('profile.noEmail')}</span>
            )}
            {isAdmin && (
              <StatusBadge tone="info">{t('profile.adminBadge')}</StatusBadge>
            )}
        </span>}
        badge={<div className="flex h-8 w-8 items-center justify-center rounded-sm border border-primary/20 bg-primary/10 text-primary"><User className="h-4 w-4" /></div>}
      />

      {/* ── Account ──────────────────────────────────────────────────── */}
      <Section icon={User} title={t('profile.account')}>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <label htmlFor="profile-display-name" className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.displayName')}</label>
            <input
              id="profile-display-name"
              className="flex-1 h-8 rounded-sm border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={username}
            />
          </div>
          <div className="flex items-center gap-4">
            <label htmlFor="profile-username" className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.username')}</label>
            <div className="flex flex-1 items-center gap-2">
              <input
                id="profile-username"
                className="flex-1 h-8 rounded-sm border border-input bg-background px-2.5 text-[13px] opacity-55 cursor-default"
                value={username}
                readOnly
                tabIndex={-1}
              />
              <span className="whitespace-nowrap text-xs text-muted-foreground">{t('profile.readOnly')}</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label htmlFor="profile-email" className="w-24 flex-shrink-0 text-sm text-muted-foreground">{t('profile.email')}</label>
            <input
              id="profile-email"
              className="flex-1 h-8 rounded-sm border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="h-8 w-full rounded-sm border border-input bg-background px-2.5 pr-9 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="h-8 w-full rounded-sm border border-input bg-background px-2.5 pr-9 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
              className="w-full h-8 rounded-sm border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
        ) : totpStatus.isError ? (
          <QueryErrorState
            compact
            error={totpStatus.error}
            title="Two-factor authentication status could not be loaded"
            onRetry={() => void totpStatus.refetch()}
          />
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
                  className="w-full h-8 rounded-sm border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
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
                    id="totp-confirm-code"
                    name="otp"
                    className="w-36 rounded-md border bg-background px-3 py-2 text-center text-xl tracking-[8px] font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    autoComplete="one-time-code"
                    aria-label={t('set.totpEnterCode')}
                    placeholder="______"
                    value={totpCode}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                      setTotpCode(digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);
                    }}
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

      <Section icon={Paintbrush} title="Personal appearance">
        <p className="mb-3 text-sm text-muted-foreground">This preference applies only to your browser. Global Shipyard branding remains in Administration.</p>
        <div className="space-y-5">
          {(showAllThemes ? (['light', 'dark'] as const) : (['recommended'] as const)).map((mode) => {
            const presets = mode === 'recommended'
              ? THEME_PRESETS.filter((preset) => preset.recommended)
              : THEME_PRESETS.filter((preset) => preset.mode === mode);
            return (
              <div key={mode}>
                <div className="mb-2 flex items-center gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{mode} themes</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setThemePreset(preset.id)}
                      aria-pressed={themePreset === preset.id}
                      aria-label={`${preset.name} theme, ${preset.mode} mode`}
                      className={cn(
                        'rounded-sm border p-3 text-left transition-colors hover:border-primary/50',
                        themePreset === preset.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-muted/30',
                      )}
                    >
                      <span className="relative mb-2 flex h-9 overflow-hidden rounded-sm border" style={{ backgroundColor: preset.preview.canvas }}>
                        <span className="w-1/4 shrink-0 border-r" style={{ backgroundColor: preset.preview.surface, borderRightColor: preset.preview.accent }} />
                        <span className="flex flex-1 items-center px-2">
                          <span className="h-4 w-full rounded-[2px] border" style={{ backgroundColor: preset.preview.card, borderColor: `${preset.preview.accent}66` }} />
                        </span>
                        <span className="absolute inset-x-0 bottom-0 h-0.5" style={{ backgroundColor: preset.preview.accent }} />
                      </span>
                      <span className="block text-sm font-medium">{preset.name}</span>
                      {preset.style && <span className="mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{preset.style}</span>}
                      <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setShowAllThemes((value) => !value)}>
            {showAllThemes ? 'Show recommended themes' : 'More themes'}
          </button>
        </div>
      </Section>
    </div>
  );
}
