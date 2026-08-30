import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Mail, Bell, Save, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { useSettings } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsRow, SettingsSection } from '../_row';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';

interface WhiteLabel {
  webhookUrl?: string;
  webhookSecret?: string;
  smtpHost?: string;
  smtpPort?: string | number;
  smtpUser?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifPlaybookFailed?: boolean;
  notifUpdateFailed?: boolean;
  notifResourceAlerts?: boolean;
}

export function NotificationsTab() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const wl = (settings as unknown as WhiteLabel) || {};

  return (
    <div className="space-y-4">
      <SettingsSection icon={<Globe className="h-4 w-4" />} title={t('set.webhooks')}>
        <WebhookForm wl={wl} />
      </SettingsSection>

      <SettingsSection icon={<Mail className="h-4 w-4" />} title={t('set.smtp')}>
        <SmtpForm wl={wl} />
      </SettingsSection>

      <SettingsSection
        icon={<Bell className="h-4 w-4" />}
        title={t('set.notificationEvents')}
        description={t('set.notificationEventsHint')}
      >
        <NotificationToggles wl={wl} />
      </SettingsSection>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────

function WebhookForm({ wl }: { wl: WhiteLabel }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [url, setUrl] = useState(wl.webhookUrl || '');
  const [secret, setSecret] = useState(wl.webhookSecret || '');
  const dirty = url !== (wl.webhookUrl || '') || secret !== (wl.webhookSecret || '');
  useUnsavedChanges(dirty);

  useEffect(() => { setUrl(wl.webhookUrl || ''); setSecret(wl.webhookSecret || ''); }, [wl.webhookUrl, wl.webhookSecret]);

  const save = useMutation({
    mutationFn: () => api.saveSettings({ webhookUrl: url.trim(), webhookSecret: secret }),
    onSuccess: () => {
      showToast(t('set.webhookSaved'), 'success');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: () => showToast(t('set.toastErrorSave'), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.testWebhook(),
    onSuccess: () => showToast(t('set.webhookTestOk'), 'success'),
    onError: (e) => showToast(t('set.webhookTestFail') + ((e as Error).message ? ': ' + (e as Error).message : ''), 'error'),
  });

  return (
    <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }} className="contents">
      <SettingsRow label={t('set.webhookUrl')} hint={t('set.webhookUrlHint')}>
        <Input
          aria-label={t('set.webhookUrl')}
          name="webhookUrl"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow label={t('set.webhookSecret')} hint={t('set.webhookSecretHint')}>
        <Input
          aria-label={t('set.webhookSecret')}
          name="webhookSecret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="optional"
          autoComplete="new-password"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow noBorder>
        <Button type="submit" size="sm" disabled={save.isPending || !dirty}>
          <Save className="h-4 w-4" /> {t('set.webhookSave')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          <Send className="h-4 w-4" /> {t('set.webhookTest')}
        </Button>
      </SettingsRow>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// SMTP
// ─────────────────────────────────────────────────────────────

function SmtpForm({ wl }: { wl: WhiteLabel }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [host, setHost] = useState(wl.smtpHost || '');
  const [port, setPort] = useState(String(wl.smtpPort || '587'));
  const [user, setUser] = useState(wl.smtpUser || '');
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState(wl.smtpFrom || '');
  const [to, setTo]     = useState(wl.smtpTo || '');
  const dirty = host !== (wl.smtpHost || '') || port !== String(wl.smtpPort || '587') || user !== (wl.smtpUser || '') || from !== (wl.smtpFrom || '') || to !== (wl.smtpTo || '') || Boolean(pass);
  useUnsavedChanges(dirty);

  useEffect(() => {
    setHost(wl.smtpHost || ''); setPort(String(wl.smtpPort || '587'));
    setUser(wl.smtpUser || ''); setFrom(wl.smtpFrom || ''); setTo(wl.smtpTo || '');
  }, [wl.smtpHost, wl.smtpPort, wl.smtpUser, wl.smtpFrom, wl.smtpTo]);

  const save = useMutation({
    mutationFn: () => api.saveSettings({
      smtpHost: host.trim(),
      smtpPort: port.trim(),
      smtpUser: user.trim(),
      smtpFrom: from.trim(),
      smtpTo:   to.trim(),
      ...(pass ? { smtpPass: pass } : {}),
    }),
    onSuccess: () => {
      showToast(t('set.smtpSaved'), 'success');
      setPass('');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: () => showToast(t('set.toastErrorSave'), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.testSmtp(),
    onSuccess: () => showToast(t('set.smtpTestOk'), 'success'),
    onError: (e) => showToast(t('set.smtpTestFail') + ((e as Error).message ? ': ' + (e as Error).message : ''), 'error'),
  });

  return (
    <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }} className="contents">
      <SettingsRow label={t('set.smtpHost')}>
        <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-[1fr_90px]">
          <Input aria-label={t('set.smtpHost')} name="smtpHost" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
          <Input aria-label={`${t('set.smtpHost')} port`} name="smtpPort" value={port} onChange={(e) => setPort(e.target.value)} type="number" placeholder="587" />
        </div>
      </SettingsRow>
      <SettingsRow label={t('set.smtpUser')}>
        <Input aria-label={t('set.smtpUser')} name="smtpUsername" value={user} onChange={(e) => setUser(e.target.value)} placeholder="user@example.com" autoComplete="username" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpPass')}>
        <Input aria-label={t('set.smtpPass')} name="smtpPassword" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" autoComplete="new-password" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpFrom')}>
        <Input aria-label={t('set.smtpFrom')} name="smtpFrom" type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="shipyard@example.com" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpTo')} hint={t('set.smtpToHint')}>
        <Input aria-label={t('set.smtpTo')} name="smtpTo" value={to} onChange={(e) => setTo(e.target.value)} placeholder="admin@example.com" className="max-w-md" />
      </SettingsRow>
      <SettingsRow noBorder>
        <Button type="submit" size="sm" disabled={save.isPending || !dirty}>
          <Save className="h-4 w-4" /> {t('common.save')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          <Send className="h-4 w-4" /> {t('set.smtpTest')}
        </Button>
      </SettingsRow>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Notification toggles
// ─────────────────────────────────────────────────────────────

function NotificationToggles({ wl }: { wl: WhiteLabel }) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const items: { key: 'notifPlaybookFailed' | 'notifUpdateFailed' | 'notifResourceAlerts'; label: string; hint: string }[] = [
    { key: 'notifPlaybookFailed', label: t('set.notifyPlaybookFailure'), hint: t('set.notifyPlaybookFailureHint') },
    { key: 'notifUpdateFailed',   label: t('set.notifyUpdateFailure'),   hint: t('set.notifyUpdateFailureHint') },
    { key: 'notifResourceAlerts', label: t('set.notifyResourceAlerts'),  hint: t('set.notifyResourceAlertsHint') },
  ];

  const save = useMutation({
    mutationFn: (patch: Partial<WhiteLabel>) => api.saveSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: () => showToast(t('set.toastErrorSave'), 'error'),
  });

  return (
    <>
      {items.map((it, i) => (
        <SettingsRow
          key={it.key}
          label={it.label}
          hint={it.hint}
          noBorder={i === items.length - 1}
        >
          <Switch
            aria-label={it.label}
            checked={wl[it.key] !== false}
            onCheckedChange={(v) => save.mutate({ [it.key]: v })}
          />
        </SettingsRow>
      ))}
    </>
  );
}
