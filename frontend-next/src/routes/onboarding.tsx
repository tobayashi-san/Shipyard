import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Anchor, ArrowLeft, ArrowRight, Check, Key, Rocket } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const STEPS = 5;
const ACCENTS = ['#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#14b8a6', '#22c55e'];
const THEMES = ['light', 'auto', 'dark'] as const;
type Theme = (typeof THEMES)[number];

interface Branding {
  appName: string;
  appTagline: string;
  accentColor: string;
  showIcon: boolean;
  logoIcon: string;
}

function Stepper({ current }: { current: number }) {
  return (
    <div className="mb-4 flex items-center justify-center gap-2">
      {Array.from({ length: STEPS }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? 'w-8 bg-primary' : i < current ? 'w-4 bg-primary/60' : 'w-4 bg-muted'
          }`}
        />
      ))}
    </div>
  );
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [branding, setBranding] = useState<Branding>({
    appName: 'Shipyard',
    appTagline: 'Infrastructure',
    accentColor: '#3b82f6',
    showIcon: true,
    logoIcon: 'fa-ship',
  });

  // Load existing branding (auth status is public)
  useEffect(() => {
    api.authStatus().then((s) => {
      setBranding((b) => ({
        ...b,
        appName: s.appName || b.appName,
        appTagline: s.appTagline || b.appTagline,
        accentColor: s.accentColor || b.accentColor,
        showIcon: s.showIcon !== false,
        logoIcon: s.logoIcon || b.logoIcon,
      }));
    }).catch(() => {});
  }, []);

  const Logo = (
    <div className="mb-4 flex items-center gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Anchor className="h-6 w-6" />
      </div>
      <div>
        <div className="text-xl font-semibold">{branding.appName}</div>
        <div className="text-sm text-muted-foreground">{branding.appTagline}</div>
      </div>
    </div>
  );

  const NavRow = (props: {
    onPrev?: () => void;
    onSkip?: () => void;
    nextLabel?: string;
    onNext?: () => void;
    nextDisabled?: boolean;
    extra?: React.ReactNode;
  }) => (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
      {props.onPrev && (
        <Button variant="ghost" onClick={props.onPrev}>
          <ArrowLeft className="h-4 w-4" /> {t('ob.prev')}
        </Button>
      )}
      {props.onSkip && (
        <Button variant="ghost" onClick={props.onSkip}>{t('common.skip')}</Button>
      )}
      {props.extra}
      {props.onNext && (
        <Button onClick={props.onNext} disabled={props.nextDisabled}>
          {props.nextLabel || t('ob.next')} <ArrowRight className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-background via-background to-muted/40 p-4">
      <Card className="w-full max-w-lg shadow-lg">
        <CardContent className="p-6">
          {Logo}
          <Stepper current={step} />
          {step === 0 && <WelcomeStep onNext={() => setStep(1)} NavRow={NavRow} />}
          {step === 1 && <PasswordStep onNext={() => setStep(2)} NavRow={NavRow} onPrev={() => setStep(0)} />}
          {step === 2 && (
            <AppearanceStep
              branding={branding}
              setBranding={setBranding}
              onNext={() => setStep(3)}
              onPrev={() => setStep(1)}
              onSkip={() => setStep(3)}
              NavRow={NavRow}
            />
          )}
          {step === 3 && <SshStep onNext={() => setStep(4)} onPrev={() => setStep(2)} onSkip={() => setStep(4)} NavRow={NavRow} />}
          {step === 4 && (
            <DoneStep
              onFinish={async () => {
                try { await api.markOnboardingDone(); } catch { /* non-critical */ }
                await navigate({ to: '/' });
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

type NavRowComponent = React.FC<{
  onPrev?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  onNext?: () => void;
  nextDisabled?: boolean;
  extra?: React.ReactNode;
}>;

function WelcomeStep({ onNext, NavRow }: { onNext: () => void; NavRow: NavRowComponent }) {
  const { t } = useTranslation();
  return (
    <>
      <h2 className="text-xl font-semibold">{t('ob.welcome')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('ob.welcomeDesc')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('ob.setupHelper')}</p>
      <NavRow onNext={onNext} nextLabel={t('ob.letsGo')} />
    </>
  );
}

function PasswordStep({ onNext, onPrev, NavRow }: { onNext: () => void; onPrev: () => void; NavRow: NavRowComponent }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const u = username.trim() || 'admin';
    if (!/^[a-zA-Z0-9_-]+$/.test(u)) { setError(t('ob.usernameInvalid')); return; }
    if (pw1.length < 12) { setError(t('login.errorShort')); return; }
    if (pw1 !== pw2) { setError(t('login.errorMismatch')); return; }
    setBusy(true);
    try {
      const res = await api.authSetup(u, pw1);
      setToken(res.token);
      if (displayName.trim()) {
        try { await api.updateProfile({ displayName: displayName.trim() }); } catch { /* non-critical */ }
      }
      onNext();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.errorGeneral'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="text-lg font-semibold">{t('ob.passwordStep')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('ob.passwordHint')}</p>

      <div className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ob-user">{t('ob.username')}</Label>
          <Input id="ob-user" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-display">{t('ob.displayName')}</Label>
          <Input id="ob-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('ob.displayNamePlaceholder')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-pw1">{t('login.password')}</Label>
          <Input id="ob-pw1" type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder={t('login.minChars')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-pw2">{t('login.confirmPassword')}</Label>
          <Input id="ob-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <NavRow onPrev={onPrev} onNext={submit} nextDisabled={busy} nextLabel={t('login.setPassword')} />
    </>
  );
}

function AppearanceStep({
  branding, setBranding, onNext, onPrev, onSkip, NavRow,
}: {
  branding: Branding;
  setBranding: (b: Branding) => void;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  NavRow: NavRowComponent;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(branding.appName === 'Shipyard' ? '' : branding.appName);
  const [tagline, setTagline] = useState(branding.appTagline === 'Infrastructure' ? '' : branding.appTagline);
  const [accent, setAccent] = useState(branding.accentColor);
  const [theme, setTheme] = useState<Theme>('auto');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.saveSettings({
        appName: name,
        appTagline: tagline,
        accentColor: accent,
        logoIcon: branding.logoIcon,
        showIcon: branding.showIcon,
        theme,
      });
      setBranding({ ...branding, appName: name || 'Shipyard', appTagline: tagline || 'Infrastructure', accentColor: accent });
    } catch { /* non-critical */ }
    setBusy(false);
    onNext();
  };

  return (
    <>
      <h2 className="text-lg font-semibold">{t('ob.appearance')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('ob.appearanceHint')}</p>

      <div className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ob-name">{t('set.appName')}</Label>
          <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shipyard" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-tag">{t('set.tagline')}</Label>
          <Input id="ob-tag" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Infrastructure" />
        </div>

        <div className="space-y-1.5">
          <Label>{t('set.accentColor')}</Label>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setAccent(c)}
                className={`h-7 w-7 rounded-full border-2 transition ${accent === c ? 'border-foreground' : 'border-transparent'}`}
                style={{ background: c }}
              />
            ))}
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-7 w-7 cursor-pointer rounded-full border bg-transparent p-0.5" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>{t('set.theme')}</Label>
          <div className="inline-flex rounded-md border p-1">
            {THEMES.map((th) => (
              <button
                key={th}
                type="button"
                onClick={() => setTheme(th)}
                className={`rounded px-3 py-1 text-xs capitalize ${theme === th ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
              >
                {t(`set.${th}` as 'set.light' | 'set.auto' | 'set.dark')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <NavRow onPrev={onPrev} onSkip={onSkip} onNext={submit} nextDisabled={busy} nextLabel={t('ob.saveNext')} />
    </>
  );
}

function SshStep({ onNext, onPrev, onSkip, NavRow }: { onNext: () => void; onPrev: () => void; onSkip: () => void; NavRow: NavRowComponent }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'exists' | 'missing' | 'error'>('checking');
  const [publicKey, setPublicKey] = useState<string>('');
  const [generating, setGenerating] = useState(false);

  const check = async () => {
    setState('checking');
    try {
      const res = await api.getSSHKey();
      if (res?.publicKey) {
        setPublicKey(res.publicKey);
        setState('exists');
      } else {
        setState('missing');
      }
    } catch {
      setState('error');
    }
  };

  useEffect(() => { check(); }, []);

  const generate = async () => {
    setGenerating(true);
    try {
      await api.generateSSHKey('shipyard');
      await check();
    } catch { /* keep state */ }
    setGenerating(false);
  };

  return (
    <>
      <h2 className="text-lg font-semibold">{t('ob.sshStep')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('ob.sshDesc')}</p>

      <div className="mt-4">
        {state === 'checking' && <div className="text-sm text-muted-foreground">{t('ob.checkingKey')}</div>}
        {state === 'exists' && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-emerald-600">
              <Check className="h-4 w-4" /> {t('ob.keyExists')}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{publicKey.substring(0, 80)}…</div>
          </div>
        )}
        {state === 'missing' && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            {t('ob.noKey')}
          </div>
        )}
        {state === 'error' && (
          <div className="text-sm text-muted-foreground">{t('ob.checkFailed')}</div>
        )}
      </div>

      <NavRow
        onPrev={onPrev}
        onSkip={onSkip}
        extra={state === 'missing' && (
          <Button onClick={generate} disabled={generating}>
            <Key className="h-4 w-4" /> {generating ? t('ob.generating') : t('ob.generateKey')}
          </Button>
        )}
        onNext={state === 'exists' || state === 'error' ? onNext : undefined}
      />
    </>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 text-center">
      <div className="text-3xl">🎉</div>
      <h2 className="text-xl font-semibold">{t('ob.done')}</h2>
      <p className="text-sm text-muted-foreground">{t('ob.doneDesc')}</p>
      <Button onClick={onFinish} className="mx-auto">
        <Rocket className="h-4 w-4" /> {t('ob.openApp')}
      </Button>
    </div>
  );
}
