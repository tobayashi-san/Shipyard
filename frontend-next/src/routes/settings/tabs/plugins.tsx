import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Puzzle, RotateCw, AlertTriangle, CircleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { usePlugins, type PluginInfo } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SettingsRow, SettingsSection } from '../_row';

export function PluginsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: plugins, isLoading, isError, error } = usePlugins();

  const reload = useMutation({
    mutationFn: () => api.reloadPlugins(),
    onSuccess: () => {
      showToast(t('set.pluginsReloaded'), 'success');
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error'),
  });

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={<Puzzle className="h-4 w-4" />}
        title={t('set.plugins')}
        description={t('set.pluginsHint')}
      >
        <div className="flex justify-end pt-3">
          <Button variant="secondary" size="sm" onClick={() => reload.mutate()} disabled={reload.isPending}>
            <RotateCw className="h-4 w-4" /> {t('set.pluginsReload')}
          </Button>
        </div>

        {isLoading && (
          <SettingsRow noBorder>
            <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
          </SettingsRow>
        )}
        {isError && (
          <SettingsRow noBorder>
            <span className="text-sm text-destructive">{(error as Error)?.message || t('common.error')}</span>
          </SettingsRow>
        )}
        {!isLoading && !isError && plugins && plugins.length === 0 && (
          <SettingsRow noBorder>
            <div className="flex w-full flex-col items-center gap-2 py-6 text-sm text-muted-foreground">
              <Puzzle className="h-6 w-6 opacity-40" />
              <span>{t('set.pluginsEmpty')}</span>
            </div>
          </SettingsRow>
        )}
        {!isLoading && plugins && plugins.length > 0 && (
          <PluginList plugins={plugins} />
        )}
      </SettingsSection>

      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('set.pluginsWarningTitle')}</AlertTitle>
        <AlertDescription>{t('set.pluginsWarningText')}</AlertDescription>
      </Alert>
    </div>
  );
}

function PluginList({ plugins }: { plugins: PluginInfo[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirmTarget, setConfirmTarget] = useState<PluginInfo | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const apply = async (p: PluginInfo, enable: boolean) => {
    setBusyId(p.id);
    try {
      if (enable) await api.enablePlugin(p.id);
      else await api.disablePlugin(p.id);
      showToast(
        enable
          ? t('set.pluginsEnabledToast', { name: p.name || p.id })
          : t('set.pluginsDisabledToast', { name: p.name || p.id }),
        'success'
      );
      await qc.invalidateQueries({ queryKey: ['plugins'] });
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: (err as Error).message }), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = (p: PluginInfo, v: boolean) => {
    if (v) {
      setConfirmTarget(p);
    } else {
      void apply(p, false);
    }
  };

  return (
    <>
      {plugins.map((p, i) => (
        <SettingsRow
          key={p.id}
          noBorder={i === plugins.length - 1}
          label={
            <span className="flex items-center gap-2">
              {p.name || p.id}
              {p.version && (
                <span className="text-xs font-normal text-muted-foreground">v{String(p.version)}</span>
              )}
            </span>
          }
          hint={
            <>
              {p.description && <span className="block">{p.description}</span>}
              {!p.loaded && (
                <span className="mt-1 flex items-center gap-1 text-destructive">
                  <CircleAlert className="h-3 w-3" />
                  {p.error || t('set.pluginsLoadError')}
                </span>
              )}
            </>
          }
        >
          <Switch
            checked={!!p.enabled}
            disabled={!p.loaded || busyId === p.id}
            onCheckedChange={(v) => onToggle(p, v)}
          />
          <span className="text-xs text-muted-foreground">
            {p.enabled ? t('set.pluginsEnabled') : t('set.pluginsDisabled')}
          </span>
        </SettingsRow>
      ))}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(v) => { if (!v) setConfirmTarget(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('set.pluginsEnableTitle')}</DialogTitle>
          </DialogHeader>
          <div
            className="text-sm text-muted-foreground"
            dangerouslySetInnerHTML={{
              __html: t('set.pluginsEnableWarning', { name: confirmTarget?.name || confirmTarget?.id || '' }),
            }}
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const p = confirmTarget;
                setConfirmTarget(null);
                if (p) void apply(p, true);
              }}
            >
              {t('set.pluginsEnableConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
