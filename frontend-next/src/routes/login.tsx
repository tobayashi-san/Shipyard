import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Anchor, Lock, LogIn } from 'lucide-react';
import { useEffect } from 'react';
import { api, ApiError } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  const appName = status?.appName || 'Shipyard';
  const appTagline = status?.appTagline || 'Infrastructure';

  // Redirect unconfigured installs to /onboarding for the richer wizard.
  useEffect(() => {
    if (isSetup) {
      navigate({ to: '/onboarding', replace: true });
    }
  }, [isSetup, navigate]);

  const [username, setUsername] = useState(isSetup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [tempToken, setTempToken] = useState<string | null>(null);
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
        setTempToken(res.tempToken);
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
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-background via-background to-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Anchor className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">{appName}</CardTitle>
          <CardDescription>{tempToken ? t('login.totpTitle') : isSetup ? t('login.setup') : t('login.signin')}</CardDescription>
        </CardHeader>

        <CardContent>
          {!tempToken ? (
            <form onSubmit={onSubmit} className="space-y-4">
              {isSetup && <p className="text-sm text-muted-foreground">{t('login.hint')}</p>}
              <div className="space-y-1.5">
                <Label htmlFor="username">{t('login.username')}</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">{isSetup ? t('login.newPassword') : t('login.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSetup ? t('login.minChars') : ''}
                />
              </div>
              {isSetup && (
                <div className="space-y-1.5">
                  <Label htmlFor="password2">{t('login.confirmPassword')}</Label>
                  <Input
                    id="password2"
                    type="password"
                    autoComplete="new-password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                  />
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting} className="w-full">
                {isSetup ? <Lock className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                {isSetup ? t('login.setPassword') : t('login.loginBtn')}
              </Button>
            </form>
          ) : (
            <form onSubmit={onTotpSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('login.totpHint')}</p>
              <div className="space-y-1.5">
                <Label htmlFor="totp">000 000</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  maxLength={7}
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                    setTotpCode(digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);
                  }}
                  className="text-center text-lg tracking-widest"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting} className="w-full">{t('login.totpBtn')}</Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setTempToken(null); setTotpCode(''); }}>
                {t('login.totpBack')}
              </Button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground">{appTagline}</p>
        </CardContent>
      </Card>
    </div>
  );
}
