import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Anchor, Lock, LogIn, Server, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { applyWhiteLabel } from '@/lib/whitelabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const MFA_TOKEN_KEY = 'shipyard.login.mfa-token';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: status, isLoading } = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.authStatus(),
    retry: false,
    staleTime: 0,
  });

  const isSetup = status ? !status.configured : false;
  const appName = status?.appName || 'Fleet';
  const appTagline = status?.appTagline || 'Infrastructure';

  // Apply branding from auth status (no settings query on login)
  useEffect(() => {
    if (status) applyWhiteLabel({ appName: status.appName, appTagline: status.appTagline, accentColor: status.accentColor, logoImage: status.logoImage, showIcon: status.showIcon, logoIcon: status.logoIcon });
  }, [status]);

  // Redirect unconfigured installs to /onboarding for the richer wizard.
  useEffect(() => {
    if (isSetup) {
      navigate({ to: '/onboarding', replace: true });
    }
  }, [isSetup, navigate]);

  const [username, setUsername] = useState(isSetup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [tempToken, setTempToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const isMfaStep = new URLSearchParams(window.location.search).has('mfa');
    return isMfaStep ? window.sessionStorage.getItem(MFA_TOKEN_KEY) : null;
  });
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) {
    return <div className="grid min-h-screen place-items-center text-muted-foreground">{t('common.loading')}</div>;
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSetup) {
      if (password.length < 12) { setError(t('login.errorShort')); return; }
      if (password !== password2) { setError(t('login.errorMismatch')); return; }
    }

    setSubmitting(true);
    try {
      const res = isSetup
        ? await api.authSetup(username || 'admin', password)
        : await api.authLogin(username, password);

      if ('requires2FA' in res && res.requires2FA && res.tempToken) {
        // MFA is intentionally a real second page step. Password managers often only
        // inspect OTP fields on page load, not when React inserts them after login.
        window.sessionStorage.setItem(MFA_TOKEN_KEY, res.tempToken);
        window.location.assign(`${window.location.pathname}?mfa=1`);
        return;
      } else if (res.token) {
        setToken(res.token);
        await navigate({ to: '/' });
      } else {
        setError(t('login.errorGeneral'));
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t('login.errorGeneral');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempToken) return;
    const code = totpCode.replace(/[^0-9]/g, '');
    if (code.length < 6) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.totpLogin(tempToken, code);
      window.sessionStorage.removeItem(MFA_TOKEN_KEY);
      setToken(res.token);
      await navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.totpInvalid'));
      setTotpCode('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-[hsl(var(--surface-1))] p-4 sm:p-6">
      <main className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-[3px] border border-border-strong bg-card shadow-xl md:min-h-[500px] md:grid-cols-[0.8fr_1fr]">
        <aside className="relative flex h-48 min-h-0 flex-col justify-between overflow-hidden text-white md:h-auto">
          <img src="/login-infrastructure.webp" alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-slate-950/55 md:bg-slate-950/45" />
          <div className="relative p-5 md:p-7">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-sm border border-white/25 bg-slate-950/35 backdrop-blur-sm md:h-10 md:w-10">
                <Anchor className="h-4 w-4 md:h-5 md:w-5" />
              </div>
              <div>
                <div className="text-base font-semibold tracking-tight md:text-lg">{appName}</div>
                <div className="text-xs text-white/75 md:text-sm">{appTagline}</div>
              </div>
            </div>
            <div className="mt-6 max-w-xs md:mt-12">
              <h1 className="text-xl font-semibold leading-tight tracking-tight md:text-2xl">{t('login.consoleTitle')}</h1>
              <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-white/80 md:mt-3 md:text-sm md:leading-6">{t('login.consoleDescription')}</p>
            </div>
          </div>
          </div>
          <div className="relative m-7 hidden space-y-3 border-t border-white/20 pt-5 text-sm md:block">
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <div><p className="font-medium">{t('login.featureSecure')}</p><p className="mt-0.5 text-xs leading-5 text-white/75">{t('login.featureSecureDesc')}</p></div>
            </div>
            <div className="flex gap-3">
              <Server className="mt-0.5 h-4 w-4 shrink-0" />
              <div><p className="font-medium">{t('login.featureControl')}</p><p className="mt-0.5 text-xs leading-5 text-white/75">{t('login.featureControlDesc')}</p></div>
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col px-5 py-7 sm:px-10 sm:py-10 md:min-h-0 md:px-9 md:py-8">
          <div className="w-full max-w-sm md:mx-auto md:my-auto">
            <div className="mb-6">
              <h2 className="text-2xl font-semibold tracking-tight">{tempToken ? t('login.totpTitle') : isSetup ? t('login.setup') : t('login.accessHeading', { appName })}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{tempToken ? t('login.totpHint') : isSetup ? t('login.hint') : t('login.accessDescription')}</p>
            </div>
            {!tempToken ? (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="username">{t('login.username')}</Label>
                  <Input id="username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" className="h-10" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">{isSetup ? t('login.newPassword') : t('login.password')}</Label>
                  <Input id="password" type="password" autoComplete={isSetup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSetup ? t('login.minChars') : ''} className="h-10" />
                </div>
                {isSetup && (
                  <div className="space-y-1.5">
                    <Label htmlFor="password2">{t('login.confirmPassword')}</Label>
                    <Input id="password2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} className="h-10" />
                  </div>
                )}
                {error && <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={submitting} className="h-10 w-full">
                  {isSetup ? <Lock className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                  {isSetup ? t('login.setPassword') : t('login.loginBtn')}
                </Button>
              </form>
            ) : (
              <form onSubmit={onTotpSubmit} autoComplete="one-time-code" className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="totp">{t('login.totpTitle')}</Label>
                  <Input
                    id="totp"
                    name="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    autoComplete="one-time-code"
                    aria-label={t('login.totpPlaceholder')}
                    autoFocus
                    value={totpCode}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                      setTotpCode(digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);
                    }}
                    className="h-10 text-center text-lg tracking-widest"
                  />
                </div>
                {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
                <Button type="submit" disabled={submitting} className="h-10 w-full">{t('login.totpBtn')}</Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => {
                  window.sessionStorage.removeItem(MFA_TOKEN_KEY);
                  window.history.replaceState(null, '', window.location.pathname);
                  setTempToken(null);
                  setTotpCode('');
                }}>
                  {t('login.totpBack')}
                </Button>
              </form>
            )}
          </div>
          <p className="mt-8 text-xs text-muted-foreground md:mt-0">{appName} · {appTagline}</p>
        </section>
      </main>
    </div>
  );
}
