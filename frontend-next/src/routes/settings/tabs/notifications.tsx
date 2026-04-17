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
}

export function NotificationsTab() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const wl = ((settings?.whiteLabel as WhiteLabel) || {});

  return (
    <div className="space-y-6">
      <SettingsSection icon={<Globe className="h-4 w-4" />} title={t('set.webhooks')}>
        <WebhookForm wl={wl} />
      </SettingsSection>

      <SettingsSection icon={<Mail className="h-4 w-4" />} title={t('set.smtp')}>
        <SmtpForm wl={wl} />
      </SettingsSection>

      <SettingsSection
        icon={<Bell className="h-4 w-4" />}
        title="Notification Events"
        description="Choose which failures trigger a notification. Notifications are sent only if webhook or email is configured above."
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
    <>
      <SettingsRow label={t('set.webhookUrl')} hint={t('set.webhookUrlHint')}>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow label={t('set.webhookSecret')} hint={t('set.webhookSecretHint')}>
        <Input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="optional"
          autoComplete="off"
          className="max-w-md"
        />
      </SettingsRow>

      <SettingsRow noBorder>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="h-4 w-4" /> {t('set.webhookSave')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          <Send className="h-4 w-4" /> {t('set.webhookTest')}
        </Button>
      </SettingsRow>
    </>
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
    <>
      <SettingsRow label={t('set.smtpHost')}>
        <div className="grid w-full max-w-md grid-cols-[1fr_90px] gap-2">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
          <Input value={port} onChange={(e) => setPort(e.target.value)} type="number" placeholder="587" />
        </div>
      </SettingsRow>
      <SettingsRow label={t('set.smtpUser')}>
        <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="user@example.com" autoComplete="off" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpPass')}>
        <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" autoComplete="new-password" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpFrom')}>
        <Input type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="shipyard@example.com" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('set.smtpTo')} hint={t('set.smtpToHint')}>
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="admin@example.com" className="max-w-md" />
      </SettingsRow>
      <SettingsRow noBorder>
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="h-4 w-4" /> {t('common.save')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          <Send className="h-4 w-4" /> {t('set.webhookTest')}
        </Button>
      </SettingsRow>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Notification toggles
// ─────────────────────────────────────────────────────────────

function NotificationToggles({ wl }: { wl: WhiteLabel }) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const items: { key: 'notifPlaybookFailed' | 'notifUpdateFailed'; label: string; hint: string }[] = [
    { key: 'notifPlaybookFailed', label: 'Playbook failure', hint: 'Notify when an Ansible playbook fails' },
    { key: 'notifUpdateFailed',   label: 'Update failure',   hint: 'Notify when a system or bulk update fails' },
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
            checked={wl[it.key] !== false}
            onCheckedChange={(v) => save.mutate({ [it.key]: v })}
          />
        </SettingsRow>
      ))}
    </>
  );
}
