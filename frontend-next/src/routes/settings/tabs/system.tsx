import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Terminal, Clock, Bot, CheckCircle2, XCircle, Save, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { useSettings } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { SettingsRow, SettingsSection } from '../_row';

export function SystemTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <SettingsSection icon={<Terminal className="h-4 w-4" />} title={t('set.ansible')}>
        <AnsibleStatus />
      </SettingsSection>

      <SettingsSection
        icon={<Terminal className="h-4 w-4" />}
        title={t('set.openTofu')}
        description={t('set.openTofuHint')}
      >
        <OpenTofuStatus />
      </SettingsSection>

      <SettingsSection
        icon={<Clock className="h-4 w-4" />}
        title={t('set.scheduler')}
        description={t('set.schedulerHint')}
      >
        <SchedulerTimezone />
      </SettingsSection>

      <SettingsSection
        icon={<Clock className="h-4 w-4" />}
        title={t('set.polling')}
        description={t('set.pollingHint')}
      >
        <PollingConfig />
      </SettingsSection>

      <SettingsSection
        icon={<Bot className="h-4 w-4" />}
        title={t('set.agentFeature')}
        description={t('set.agentFeatureHint')}
      >
        <AgentToggle />
      </SettingsSection>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// OpenTofu installation
// ─────────────────────────────────────────────────────────────

interface OpenTofuStatusResp {
  installed: boolean;
  binary: string | null;
  version: string | null;
  installing: boolean;
}

interface OpenTofuReleasesResp { releases: string[] }

function OpenTofuStatus() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery<OpenTofuStatusResp>({
    queryKey: ['opentofu', 'status'],
    queryFn: () => api.getOpenTofuStatus() as unknown as Promise<OpenTofuStatusResp>,
    refetchInterval: (query) => query.state.data?.installing ? 2_000 : false,
    staleTime: 15_000,
  });
  const releases = useQuery<OpenTofuReleasesResp>({
    queryKey: ['opentofu', 'releases'],
    queryFn: () => api.getOpenTofuReleases(),
    staleTime: 5 * 60_000,
  });
  const available = releases.data?.releases || [];
  const [selectedVersion, setSelectedVersion] = useState('');

  useEffect(() => {
    if (available.length && !available.includes(selectedVersion)) setSelectedVersion(available[0]);
  }, [available, selectedVersion]);

  const install = useMutation({
    mutationFn: (version: string) => api.installOpenTofu(version),
    onSuccess: (result) => {
      const installedVersion = String((result as Record<string, unknown>)?.version || selectedVersion);
      showToast(t('set.openTofuInstalled', { version: installedVersion }), 'success');
      void qc.invalidateQueries({ queryKey: ['opentofu'] });
    },
    onError: (err) => showToast((err as Error).message, 'error'),
  });

  if (status.isLoading) {
    return <SettingsRow noBorder><Skeleton className="h-4 w-full max-w-sm" /></SettingsRow>;
  }
  if (status.isError) {
    return <SettingsRow noBorder><span className="text-sm text-destructive">{(status.error as Error)?.message || t('common.error')}</span></SettingsRow>;
  }

  const installed = Boolean(status.data?.installed);
  const busy = install.isPending || Boolean(status.data?.installing);
  const isUpdate = installed && Boolean(selectedVersion) && selectedVersion !== status.data?.version;

  return (
    <>
      <SettingsRow label={t('set.openTofuInstallation')}>
        {installed ? (
          <StatusBadge tone="success"><CheckCircle2 className="h-3 w-3" /> {t('set.installed')}</StatusBadge>
        ) : (
          <StatusBadge tone="muted"><XCircle className="h-3 w-3" /> {t('set.notInstalled')}</StatusBadge>
        )}
      </SettingsRow>
      <SettingsRow label={t('set.version')}>
        <span className="font-mono text-xs">{status.data?.version || '—'}</span>
      </SettingsRow>
      <SettingsRow label={t('set.openTofuBinary')} hint={t('set.openTofuBinaryHint')}>
        <span className="break-all font-mono text-xs">{status.data?.binary || t('set.openTofuBinaryMissing')}</span>
      </SettingsRow>
      <SettingsRow label={t('set.openTofuTargetVersion')} noBorder>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            aria-label={t('set.openTofuTargetVersion')}
            value={selectedVersion}
            onChange={(event) => setSelectedVersion(event.target.value)}
            disabled={releases.isLoading || busy || available.length === 0}
            className="h-9 w-full rounded-sm border border-input bg-background px-3 text-sm sm:w-40"
          >
            {available.length === 0 && <option value="">{releases.isError ? t('set.openTofuReleasesUnavailable') : t('common.loading')}</option>}
            {available.map(version => <option key={version} value={version}>{version}</option>)}
          </select>
          <Button
            size="sm"
            onClick={() => install.mutate(selectedVersion)}
            disabled={!selectedVersion || releases.isError || busy}
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {busy
              ? t('set.openTofuInstalling')
              : isUpdate
                ? t('set.openTofuUpdate')
                : installed
                  ? t('set.openTofuReinstall')
                  : t('set.openTofuInstall')}
          </Button>
        </div>
      </SettingsRow>
      {!installed && (
        <SettingsRow noBorder>
          <Alert variant="warning" className="w-full">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t('set.openTofuMissingHint')}</AlertDescription>
          </Alert>
        </SettingsRow>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Scheduler timezone
// ─────────────────────────────────────────────────────────────

const COMMON_TIMEZONES = [
  'Europe/Zurich',
  'Europe/Berlin',
  'Europe/Vienna',
  'Europe/London',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function SchedulerTimezone() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const current = String((settings as Record<string, unknown> | undefined)?.schedulerTimezone || 'Europe/Zurich');
  const [timezone, setTimezone] = useState(current);

  useEffect(() => { setTimezone(current); }, [current]);

  const save = useMutation({
    mutationFn: (value: string) => api.saveSettings({ schedulerTimezone: value.trim() }),
    onSuccess: () => {
      showToast(t('set.schedulerSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => showToast((err as Error).message, 'error'),
  });

  return (
    <>
      <SettingsRow label={t('set.schedulerTimezone')} hint={t('set.schedulerTimezoneHint')}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            aria-label={t('set.schedulerTimezone')}
            name="schedulerTimezone"
            list="shipyard-timezones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Europe/Zurich"
            className="w-full sm:w-64"
          />
          <datalist id="shipyard-timezones">
            {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
          </datalist>
          <Button size="sm" onClick={() => save.mutate(timezone)} disabled={save.isPending || !timezone.trim()}>
            <Save className="h-4 w-4" /> {t('common.save')}
          </Button>
        </div>
      </SettingsRow>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Ansible status panel
// ─────────────────────────────────────────────────────────────

interface AnsibleStatusResp { installed?: boolean; version?: string }

function AnsibleStatus() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery<AnsibleStatusResp>({
    queryKey: ['ansible-status'],
    queryFn: () => api.getAnsibleStatus() as Promise<AnsibleStatusResp>,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <SettingsRow label={t('set.ansibleLabel')} noBorder>
        <Skeleton className="h-4 w-32" />
      </SettingsRow>
    );
  }
  if (isError) {
    return (
      <SettingsRow noBorder>
        <span className="text-sm text-destructive">{(error as Error)?.message || t('common.error')}</span>
      </SettingsRow>
    );
  }
  const installed = !!data?.installed;
  return (
    <>
      <SettingsRow label={t('set.ansibleLabel')} noBorder={!data?.version && installed}>
        {installed ? (
          <StatusBadge tone="success"><CheckCircle2 className="h-3 w-3" /> {t('set.installed')}</StatusBadge>
        ) : (
          <StatusBadge tone="muted"><XCircle className="h-3 w-3" /> {t('set.notInstalled')}</StatusBadge>
        )}
      </SettingsRow>
      {data?.version && (
        <SettingsRow label={t('set.version')} noBorder={installed}>
          <span className="font-mono text-xs">{data.version}</span>
        </SettingsRow>
      )}
      {!installed && (
        <SettingsRow noBorder>
          <Alert variant="warning" className="w-full">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t('set.ansibleInstallHint')}{' '}
              <code className="font-mono rounded bg-muted px-1.5 py-0.5 text-xs">{t('set.ansibleInstallCmd')}</code>
            </AlertDescription>
          </Alert>
        </SettingsRow>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Polling configuration
// ─────────────────────────────────────────────────────────────

interface PollerCfg { enabled: boolean; intervalMin: number }
interface PollingConfigResp {
  info: PollerCfg;
  updates: PollerCfg;
  imageUpdates: PollerCfg;
  customUpdates: PollerCfg;
}

type PollerKey = 'info' | 'updates' | 'imageUpdates' | 'customUpdates';

function PollingConfig() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<PollingConfigResp>({
    queryKey: ['polling-config'],
    queryFn: () => api.getPollingConfig() as unknown as Promise<PollingConfigResp>,
  });

  const [draft, setDraft] = useState<PollingConfigResp | null>(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);

  const save = useMutation({
    mutationFn: (body: PollingConfigResp) => api.savePollingConfig(body as unknown as Record<string, unknown>),
    onSuccess: () => {
      showToast(t('set.pollSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['polling-config'] });
    },
    onError: (err) => showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error'),
  });

  if (isLoading || !draft) {
    return (
      <SettingsRow noBorder>
        <Skeleton className="h-4 w-full max-w-sm" />
      </SettingsRow>
    );
  }
  if (isError) {
    return (
      <SettingsRow noBorder>
        <span className="text-sm text-destructive">{(error as Error)?.message || t('common.error')}</span>
      </SettingsRow>
    );
  }

  const pollers: { key: PollerKey; label: string; hint: string }[] = [
    { key: 'info',          label: t('set.pollSysInfo'),       hint: t('set.pollSysInfoHint') },
    { key: 'updates',       label: t('set.pollOsUpdates'),     hint: t('set.pollOsUpdatesHint') },
    { key: 'imageUpdates',  label: t('set.pollImageUpdates'),  hint: t('set.pollImageUpdatesHint') },
    { key: 'customUpdates', label: t('set.pollCustomUpdates'), hint: t('set.pollCustomUpdatesHint') },
  ];

  const update = (key: PollerKey, patch: Partial<PollerCfg>) =>
    setDraft((prev) => (prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev));

  return (
    <>
      {pollers.map((p) => {
        const cfg = draft[p.key];
        return (
          <SettingsRow key={p.key} label={p.label} hint={p.hint}>
            <div className="flex items-center gap-3">
              <Switch
                aria-label={p.label}
                checked={cfg.enabled}
                onCheckedChange={(v) => update(p.key, { enabled: v })}
              />
              <Input
                aria-label={`${p.label} ${t('set.minutesShort')}`}
                name={`${p.key}IntervalMinutes`}
                type="number"
                min={1}
                max={9999}
                value={cfg.intervalMin}
                disabled={!cfg.enabled}
                onChange={(e) => update(p.key, { intervalMin: parseInt(e.target.value, 10) || cfg.intervalMin })}
                className="w-20 text-center"
              />
              <span className="text-xs text-muted-foreground">{t('set.minutesShort')}</span>
            </div>
          </SettingsRow>
        );
      })}

      <SettingsRow noBorder>
        <Button
          size="sm"
          onClick={() => save.mutate(draft)}
          disabled={save.isPending}
        >
          <Save className="h-4 w-4" /> {t('common.save')}
        </Button>
      </SettingsRow>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Agent feature toggle
// ─────────────────────────────────────────────────────────────

function AgentToggle() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const agentEnabled = Boolean((settings as Record<string, unknown>)?.agentEnabled);
  const [checked, setChecked] = useState<boolean>(agentEnabled);

  useEffect(() => { setChecked(agentEnabled); }, [agentEnabled]);

  const save = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ agentEnabled: v }),
    onSuccess: () => {
      showToast(t('set.agentFeatureSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => {
      setChecked((c) => !c); // revert
      showToast((err as Error).message, 'error');
    },
  });

  return (
    <SettingsRow label={t('set.agentFeatureToggle')} noBorder>
      <Switch
        checked={checked}
        aria-label={t('set.agentFeatureToggle')}
        onCheckedChange={(v) => { setChecked(v); save.mutate(v); }}
        disabled={save.isPending}
      />
    </SettingsRow>
  );
}
