import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Clock, RotateCw, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsRow, SettingsSection } from '../_row';

interface ManifestResp {
  version?: number;
  content?: unknown;
}
interface ManifestHistoryEntry {
  version?: number;
  changelog?: string;
  created_at?: string;
}

export function AgentManifestTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const manifestQ = useQuery<ManifestResp>({
    queryKey: ['agent-manifest'],
    queryFn: () => api.getAgentManifest() as unknown as Promise<ManifestResp>,
  });
  const historyQ = useQuery<ManifestHistoryEntry[]>({
    queryKey: ['agent-manifest-history'],
    queryFn: () => api.getAgentManifestHistory(30) as unknown as Promise<ManifestHistoryEntry[]>,
  });

  const [json, setJson] = useState('');
  const [changelog, setChangelog] = useState('');

  useEffect(() => {
    const c = manifestQ.data?.content;
    if (c === undefined) return;
    setJson(JSON.stringify(c ?? {}, null, 2));
  }, [manifestQ.data]);

  const save = useMutation({
    mutationFn: (body: { parsed: unknown; changelog: string }) =>
      api.saveAgentManifest(body.parsed as unknown as string, body.changelog),
    onSuccess: () => {
      showToast(t('set.agentManifestSaved'), 'success');
      setChangelog('');
      qc.invalidateQueries({ queryKey: ['agent-manifest'] });
      qc.invalidateQueries({ queryKey: ['agent-manifest-history'] });
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error'),
  });

  const onSave = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(json || '{}'); }
    catch { showToast(t('set.agentManifestInvalidJson'), 'error'); return; }
    save.mutate({ parsed, changelog });
  };

  if (manifestQ.isError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {t('set.agentManifestLoadError')}: {(manifestQ.error as Error)?.message}
      </div>
    );
  }

  const history = historyQ.data || [];

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={<Bot className="h-4 w-4" />}
        title={t('set.agentManifestTitle')}
        description={t('set.agentManifestHint')}
      >
        <div className="flex justify-end pt-3">
          <Button
            variant="secondary" size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ['agent-manifest'] })}
            disabled={manifestQ.isFetching}
          >
            <RotateCw className="h-4 w-4" /> {t('set.agentManifestReload')}
          </Button>
        </div>

        <SettingsRow label={t('set.agentManifestVersion', { version: manifestQ.data?.version || 1 })}>
          <span className="text-xs text-muted-foreground">
            {manifestQ.isLoading ? t('common.loading') : ''}
          </span>
        </SettingsRow>

        <SettingsRow label="JSON" align="start">
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={16}
            className="w-full max-w-3xl font-mono text-xs leading-relaxed"
            spellCheck={false}
          />
        </SettingsRow>

        <SettingsRow label={t('set.agentManifestChangelog')} noBorder>
          <Input
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder={t('set.agentManifestChangelogPlaceholder')}
            className="max-w-md"
          />
          <Button size="sm" onClick={onSave} disabled={save.isPending}>
            <Save className="h-4 w-4" /> {save.isPending ? t('set.saving') : t('set.agentManifestSave')}
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection icon={<Clock className="h-4 w-4" />} title={t('set.agentManifestHistory')}>
        {historyQ.isLoading ? (
          <SettingsRow noBorder>
            <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
          </SettingsRow>
        ) : history.length === 0 ? (
          <SettingsRow noBorder>
            <span className="text-sm text-muted-foreground">{t('set.agentManifestNoHistory')}</span>
          </SettingsRow>
        ) : (
          history.map((h, i) => (
            <div
              key={`${h.version}-${i}`}
              className={`flex items-start justify-between gap-3 py-3 ${i === history.length - 1 ? '' : 'border-b border-border/60'}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">v{String(h.version)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{h.changelog || '—'}</div>
              </div>
              <div className="flex-shrink-0 text-[11px] text-muted-foreground">{h.created_at || ''}</div>
            </div>
          ))
        )}
      </SettingsSection>
    </div>
  );
}
