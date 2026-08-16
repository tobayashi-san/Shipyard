import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Anchor, ArrowLeft, ArrowRight, Check, Key, Lock, Palette, Rocket, ServerCog } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
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

const STEP_ICONS = [ServerCog, Lock, Palette, Key, Rocket];

function Stepper({ current }: { current: number }) {
  const { t } = useTranslation();
  const labels = [t('ob.welcome'), t('ob.passwordStep'), t('ob.appearance'), t('ob.sshStep'), t('ob.done')];
  return (
    <>
      <div className="flex items-center gap-1.5 lg:hidden" aria-label={`Step ${current + 1} of ${STEPS}`}>
        {Array.from({ length: STEPS }).map((_, index) => (
          <span key={index} className={`h-1 flex-1 rounded-[1px] ${index <= current ? 'bg-primary' : 'bg-muted'}`} />
        ))}
      </div>
      <ol className="hidden space-y-1 lg:block" aria-label="Setup progress">
        {labels.map((label, index) => {
          const Icon = STEP_ICONS[index];
          const complete = index < current;
          const active = index === current;
          return (
            <li key={label} className={`flex items-center gap-3 rounded-[3px] border px-3 py-2.5 ${active ? 'border-primary/35 bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground'}`} aria-current={active ? 'step' : undefined}>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border ${complete ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-500' : active ? 'border-primary/35 bg-background text-primary' : 'border-border-strong/70 bg-background/50'}`}>
                {complete ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0"><span className="block text-[10px] font-semibold uppercase tracking-[0.08em] opacity-70">Step {index + 1}</span><span className="block truncate text-sm font-medium">{label}</span></span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [branding, setBranding] = useState<Branding>({
    appName: 'Fleet',
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

  const NavRow = (props: {
    onPrev?: () => void;
    onSkip?: () => void;
    nextLabel?: string;
    onNext?: () => void;
    nextDisabled?: boolean;
    extra?: React.ReactNode;
  }) => (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border-strong/70 pt-4">
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
    <div className="flex min-h-svh items-center justify-center bg-[hsl(var(--surface-1))] p-3 sm:p-6">
      <main className="grid w-full max-w-5xl overflow-hidden rounded-[3px] border border-border-strong bg-card shadow-xl lg:min-h-[620px] lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="border-b border-border-strong/80 bg-[hsl(var(--surface-2))] p-4 lg:border-b-0 lg:border-r lg:p-5">
          <div className="flex items-center gap-3 border-b border-border-strong/70 pb-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-primary"><Anchor className="h-4 w-4" /></div>
            <div className="min-w-0"><div className="truncate font-mono text-[12px] font-bold tracking-[0.12em]">{branding.appName.toUpperCase()}</div><div className="truncate text-xs text-muted-foreground">{branding.appTagline}</div></div>
          </div>
          <div className="mt-4 hidden lg:block">
            <div className="mb-3 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Initial configuration</div>
            <Stepper current={step} />
          </div>
          <div className="mt-4 lg:hidden"><Stepper current={step} /></div>
          <div className="mt-5 hidden rounded-[3px] border border-border-strong/70 bg-background/40 p-3 text-xs leading-5 text-muted-foreground lg:block">
            Configuration is saved as each section is completed. Optional sections can be changed later in Settings.
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="flex items-center justify-between border-b border-border-strong/80 bg-muted/15 px-5 py-3 sm:px-7">
            <div><div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Setup wizard</div><div className="mt-0.5 text-sm font-medium">Step {step + 1} of {STEPS}</div></div>
            <span className="rounded-[2px] border border-border-strong/70 bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">{Math.round(((step + 1) / STEPS) * 100)}%</span>
          </header>
          <div className="flex flex-1 flex-col p-5 sm:p-7 lg:p-8">
            <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center">
              {step === 0 && <WelcomeStep onNext={() => setStep(1)} NavRow={NavRow} />}
              {step === 1 && <PasswordStep onNext={() => setStep(2)} NavRow={NavRow} onPrev={() => setStep(0)} />}
              {step === 2 && (
                <AppearanceStep branding={branding} setBranding={setBranding} onNext={() => setStep(3)} onPrev={() => setStep(1)} onSkip={() => setStep(3)} NavRow={NavRow} />
              )}
              {step === 3 && <SshStep onNext={() => setStep(4)} onPrev={() => setStep(2)} onSkip={() => setStep(4)} NavRow={NavRow} />}
              {step === 4 && <DoneStep onFinish={async () => { try { await api.markOnboardingDone(); } catch { /* non-critical */ } await navigate({ to: '/' }); }} />}
            </div>
          </div>
        </section>
      </main>
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
      <div className="flex h-10 w-10 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-primary"><ServerCog className="h-5 w-5" /></div>
      <h2 className="mt-4 text-2xl font-semibold tracking-tight">{t('ob.welcome')}</h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{t('ob.welcomeDesc')}</p>
      <div className="mt-5 rounded-[3px] border border-border-strong/80 bg-muted/15 p-4 text-sm leading-6 text-muted-foreground">{t('ob.setupHelper')}</div>
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
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u)) { setError(t('ob.usernameInvalid')); return; }
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
      <div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-primary"><Lock className="h-4 w-4" /></div><div><h2 className="text-xl font-semibold tracking-tight">{t('ob.passwordStep')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('ob.passwordHint')}</p></div></div>

      <div className="mt-5 grid gap-4 rounded-[3px] border border-border-strong/80 bg-muted/10 p-4 sm:grid-cols-2">
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
        {error && <p className="rounded-[3px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:col-span-2">{error}</p>}
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
  const [name, setName] = useState(branding.appName === 'Fleet' ? '' : branding.appName);
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
      setBranding({ ...branding, appName: name || 'Fleet', appTagline: tagline || 'Infrastructure', accentColor: accent });
    } catch { /* non-critical */ }
    setBusy(false);
    onNext();
  };

  return (
    <>
      <div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-primary"><Palette className="h-4 w-4" /></div><div><h2 className="text-xl font-semibold tracking-tight">{t('ob.appearance')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('ob.appearanceHint')}</p></div></div>

      <div className="mt-5 grid gap-4 rounded-[3px] border border-border-strong/80 bg-muted/10 p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ob-name">{t('set.appName')}</Label>
          <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fleet" />
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
                className={`h-7 w-7 rounded-[2px] border transition ${accent === c ? 'border-foreground ring-2 ring-foreground/15' : 'border-border-strong/60'}`}
                style={{ background: c }}
              />
            ))}
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-7 w-7 cursor-pointer rounded-[2px] border bg-transparent p-0.5" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>{t('set.theme')}</Label>
          <div className="inline-flex rounded-sm border border-border-strong p-0.5">
            {THEMES.map((th) => (
              <button
                key={th}
                type="button"
                onClick={() => setTheme(th)}
                className={`rounded-sm px-3 py-1 text-xs capitalize ${theme === th ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
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
      <div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] border border-primary/25 bg-primary/10 text-primary"><Key className="h-4 w-4" /></div><div><h2 className="text-xl font-semibold tracking-tight">{t('ob.sshStep')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('ob.sshDesc')}</p></div></div>

      <div className="mt-5 rounded-[3px] border border-border-strong/80 bg-muted/10 p-4">
        {state === 'checking' && <div className="flex items-center gap-2 text-sm text-muted-foreground"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />{t('ob.checkingKey')}</div>}
        {state === 'exists' && (
          <div className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-emerald-600">
              <Check className="h-4 w-4" /> {t('ob.keyExists')}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{publicKey.substring(0, 80)}…</div>
          </div>
        )}
        {state === 'missing' && (
          <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
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
    <div className="mx-auto max-w-lg text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[3px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-500"><Check className="h-6 w-6" /></div>
      <h2 className="mt-5 text-2xl font-semibold tracking-tight">{t('ob.done')}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('ob.doneDesc')}</p>
      <div className="mt-6 border-t border-border-strong/70 pt-4"><Button onClick={onFinish} className="mx-auto">
        <Rocket className="h-4 w-4" /> {t('ob.openApp')}
      </Button></div>
    </div>
  );
}
