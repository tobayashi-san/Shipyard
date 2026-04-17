import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Terminal, Clock, Bot, CheckCircle2, XCircle, Save, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { useSettings } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SettingsRow, SettingsSection } from '../_row';

export function SystemTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <SettingsSection icon={<Terminal className="h-4 w-4" />} title={t('set.ansible')}>
        <AnsibleStatus />
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
        <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
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
          <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> {t('set.installed')}</Badge>
        ) : (
          <Badge variant="muted"><XCircle className="h-3 w-3" /> {t('set.notInstalled')}</Badge>
        )}
      </SettingsRow>
      {data?.version && (
        <SettingsRow label="Version" noBorder={installed}>
          <span className="font-mono text-xs">{data.version}</span>
        </SettingsRow>
      )}
      {!installed && (
        <SettingsRow noBorder>
          <Alert variant="warning" className="w-full">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <span dangerouslySetInnerHTML={{ __html: t('set.ansibleInstallHint') }} />
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
        <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
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
                checked={cfg.enabled}
                onCheckedChange={(v) => update(p.key, { enabled: v })}
              />
              <Input
                type="number"
                min={1}
                max={9999}
                value={cfg.intervalMin}
                disabled={!cfg.enabled}
                onChange={(e) => update(p.key, { intervalMin: parseInt(e.target.value, 10) || cfg.intervalMin })}
                className="w-20 text-center"
              />
              <span className="text-xs text-muted-foreground">min</span>
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
  const wl = (settings?.whiteLabel as { agentEnabled?: boolean } | undefined) || {};
  const [checked, setChecked] = useState<boolean>(!!wl.agentEnabled);

  useEffect(() => { setChecked(!!wl.agentEnabled); }, [wl.agentEnabled]);

  const save = useMutation({
    mutationFn: (v: boolean) => api.saveSettings({ agentEnabled: v }),
    onSuccess: () => {
      showToast(t('set.agentFeatureSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['settings'] });
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
        onCheckedChange={(v) => { setChecked(v); save.mutate(v); }}
        disabled={save.isPending}
      />
    </SettingsRow>
  );
}
