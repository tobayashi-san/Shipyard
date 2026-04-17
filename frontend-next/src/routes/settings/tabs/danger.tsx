import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Unlock, Radiation, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection } from '../_row';

type DzKey = 'servers' | 'schedules' | 'playbooks' | 'auth' | 'all';

interface DzAction {
  key: DzKey;
  labelKey: string;
  hintKey: string;
  confirmKey: string;
  icon: React.ReactNode;
  fn: () => Promise<unknown>;
  reboot?: boolean;
  variant?: 'destructive';
}

export function DangerTab() {
  const { t } = useTranslation();

  const actions: DzAction[] = [
    {
      key: 'servers',
      labelKey: 'set.delServers',
      hintKey:  'set.delServersHint',
      confirmKey: 'set.confirmServers',
      icon: <Trash2 className="h-4 w-4" />,
      fn: () => api.resetServers(),
    },
    {
      key: 'schedules',
      labelKey: 'set.delSchedules',
      hintKey:  'set.delSchedulesHint',
      confirmKey: 'set.confirmSchedules',
      icon: <Trash2 className="h-4 w-4" />,
      fn: () => api.resetSchedules(),
    },
    {
      key: 'playbooks',
      labelKey: 'set.delPlaybooks',
      hintKey:  'set.delPlaybooksHint',
      confirmKey: 'set.confirmPlaybooks',
      icon: <Trash2 className="h-4 w-4" />,
      fn: () => api.resetPlaybooks(),
    },
    {
      key: 'auth',
      labelKey: 'set.resetAuth',
      hintKey:  'set.resetAuthHint',
      confirmKey: 'set.confirmAuth',
      icon: <Unlock className="h-4 w-4" />,
      fn: () => api.resetAuth(),
      reboot: true,
    },
    {
      key: 'all',
      labelKey: 'set.resetAll',
      hintKey:  'set.resetAllHint',
      confirmKey: 'set.confirmAll',
      icon: <Radiation className="h-4 w-4" />,
      fn: () => api.resetAll(),
      reboot: true,
    },
  ];

  return (
    <SettingsSection
      icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
      title={t('set.danger')}
      description={t('set.dangerHint')}
      className="border-destructive/40"
    >
      {actions.map((a, i) => (
        <DzRow key={a.key} action={a} noBorder={i === actions.length - 1} />
      ))}
    </SettingsSection>
  );
}

function DzRow({ action, noBorder }: { action: DzAction; noBorder: boolean }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle');

  const run = async () => {
    setPhase('busy');
    try {
      await action.fn();
      if (action.reboot) {
        setToken(null);
        showToast(t('set.resetRestarting'), 'success');
        setTimeout(() => location.reload(), 1200);
      } else {
        showToast(t('common.deleted'), 'success');
        setPhase('done');
      }
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error');
      setPhase('idle');
    }
  };

  return (
    <SettingsRow
      label={t(action.labelKey)}
      hint={t(action.hintKey)}
      noBorder={noBorder}
    >
      {phase === 'idle' && (
        <Button variant="destructive" size="sm" onClick={() => setPhase('confirm')}>
          {action.icon} {t('common.delete')}
        </Button>
      )}
      {phase === 'confirm' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t(action.confirmKey)}</span>
          <Button variant="secondary" size="sm" onClick={() => setPhase('idle')}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={run}>
            {t('common.yes')}, {t('common.delete')}
          </Button>
        </div>
      )}
      {phase === 'busy' && (
        <span className="text-sm text-muted-foreground">…</span>
      )}
      {phase === 'done' && (
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> {t('common.deleted')}
        </span>
      )}
    </SettingsRow>
  );
}
