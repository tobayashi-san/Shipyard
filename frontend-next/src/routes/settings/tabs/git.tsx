import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitBranch, GitCommit, ArrowDown, ArrowUp, Plug, Unplug, Save, RotateCw, User,
} from 'lucide-react';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Skeleton, SkeletonRow } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { SettingsRow, SettingsSection } from '../_row';

interface GitConfig {
  repoUrl?: string;
  branch?: string;
  autoPull?: boolean;
  autoPush?: boolean;
  userName?: string;
  userEmail?: string;
}

export function GitTab() {
  const cfgQ = useQuery<GitConfig>({
    queryKey: ['git-config'],
    queryFn: async () => {
      try { return (await api.getGitConfig()) as GitConfig; }
      catch { return {}; }
    },
  });

  if (cfgQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  const cfg = cfgQ.data || {};
  return cfg.repoUrl ? <GitDashboard cfg={cfg} /> : <GitSetup />;
}

// ─────────────────────────────────────────────────────────────
// Setup (no repo connected)
// ─────────────────────────────────────────────────────────────

function GitSetup() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [repoUrl, setRepoUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [autoPull, setAutoPull] = useState(true);
  const [autoPush, setAutoPush] = useState(true);

  const setup = useMutation({
    mutationFn: () => api.gitSetup({
      repoUrl: repoUrl.trim(),
      authToken: authToken.trim(),
      sshKey: sshKey.trim(),
      userName: userName.trim(),
      userEmail: userEmail.trim(),
      autoPull,
      autoPush,
    }),
    onSuccess: () => {
      showToast(t('git.connected'), 'success');
      qc.invalidateQueries({ queryKey: ['git-config'] });
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error'),
  });

  return (
    <SettingsSection
      icon={<GitBranch className="h-4 w-4" />}
      title={t('git.title')}
      description={t('git.setupHint')}
    >
      <SettingsRow label={t('git.repoUrl')} hint={t('git.repoUrlSmallHint')}>
        <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('git.authToken')} hint={t('git.authTokenHint')}>
        <Input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="ghp_xxxxxxxxxxxx" autoComplete="off" className="max-w-md" />
      </SettingsRow>
      <SettingsRow label={t('git.sshKey')} hint={t('git.sshKeyHint')} align="start">
        <Textarea
          value={sshKey}
          onChange={(e) => setSshKey(e.target.value)}
          rows={5}
          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
          className="max-w-md font-mono text-xs"
        />
      </SettingsRow>
      <SettingsRow label={t('git.userName')} hint={t('git.userNameHint')}>
        <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Shipyard Bot" className="max-w-xs" />
      </SettingsRow>
      <SettingsRow label={t('git.userEmail')} hint={t('git.userEmailHint')}>
        <Input type="email" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="bot@example.com" className="max-w-sm" />
      </SettingsRow>
      <SettingsRow label={t('git.autoPull')} hint={t('git.autoPullHint')}>
        <Switch checked={autoPull} onCheckedChange={setAutoPull} />
      </SettingsRow>
      <SettingsRow label={t('git.autoPush')} hint={t('git.autoPushHint')}>
        <Switch checked={autoPush} onCheckedChange={setAutoPush} />
      </SettingsRow>
      <SettingsRow noBorder>
        <Button size="sm" onClick={() => setup.mutate()} disabled={setup.isPending || !repoUrl}>
          <Plug className="h-4 w-4" /> {setup.isPending ? t('git.connecting') : t('git.connectRepo')}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard (repo connected)
// ─────────────────────────────────────────────────────────────

interface GitBranches { local?: string[]; remote?: string[] }

function GitDashboard({ cfg }: { cfg: GitConfig }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [statusMsg, setStatusMsg] = useState('');
  const [autoPull, setAutoPull] = useState(cfg.autoPull !== false);
  const [autoPush, setAutoPush] = useState(cfg.autoPush !== false);
  const [selectedBranch, setSelectedBranch] = useState(cfg.branch || 'main');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    setAutoPull(cfg.autoPull !== false);
    setAutoPush(cfg.autoPush !== false);
    setSelectedBranch(cfg.branch || 'main');
  }, [cfg.autoPull, cfg.autoPush, cfg.branch]);

  const branchesQ = useQuery<GitBranches>({
    queryKey: ['git-branches'],
    queryFn: () => api.getGitBranches() as unknown as Promise<GitBranches>,
  });

  const allBranches = (() => {
    const b = branchesQ.data;
    if (!b) return [cfg.branch || 'main'];
    const list = new Set<string>([
      ...(b.local || []),
      ...((b.remote || []).map((x) => x.replace(/^origin\//, ''))),
    ]);
    return Array.from(list);
  })();

  const disconnect = useMutation({
    mutationFn: () => api.gitDisconnect(),
    onSuccess: () => {
      showToast(t('git.disconnected'), 'success');
      qc.invalidateQueries({ queryKey: ['git-config'] });
    },
  });

  const pull = useMutation({
    mutationFn: () => api.gitPull(),
    onMutate: () => setStatusMsg(t('git.pulling')),
    onSuccess: () => { setStatusMsg(t('git.pullSuccess')); qc.invalidateQueries({ queryKey: ['git-log'] }); },
    onError: (e) => setStatusMsg(t('git.pullFailed', { msg: (e as Error).message })),
  });

  const push = useMutation({
    mutationFn: () => api.gitPush(),
    onMutate: () => setStatusMsg(t('git.pushing')),
    onSuccess: () => { setStatusMsg(t('git.pushSuccess')); qc.invalidateQueries({ queryKey: ['git-log'] }); },
    onError: (e) => setStatusMsg(t('git.pushFailed', { msg: (e as Error).message })),
  });

  const checkout = useMutation({
    mutationFn: (branch: string) => api.gitCheckout(branch),
    onMutate: (branch) => setStatusMsg(t('git.switchingTo', { branch })),
    onSuccess: (_d, branch) => {
      setStatusMsg(t('git.switchedTo', { branch }));
      qc.invalidateQueries({ queryKey: ['git-config'] });
      qc.invalidateQueries({ queryKey: ['git-log'] });
    },
    onError: (e) => setStatusMsg(t('git.checkoutFailed') + (e as Error).message),
  });

  const saveSettings = useMutation({
    mutationFn: () => api.saveGitSettings({ autoPull, autoPush }),
    onSuccess: () => {
      showToast(t('git.saved'), 'success');
      qc.invalidateQueries({ queryKey: ['git-config'] });
    },
    onError: (e) => showToast(t('common.errorPrefix', { msg: (e as Error).message }), 'error'),
  });

  return (
    <div className="space-y-4">
      <SettingsSection icon={<GitBranch className="h-4 w-4" />} title={t('git.syncTitle')}>
        <div className="flex justify-end pt-3">
          <Button variant="destructive" size="sm" onClick={() => setConfirmDisconnect(true)}>
            <Unplug className="h-4 w-4" /> {t('git.disconnectBtn')}
          </Button>
        </div>

        <SettingsRow label={t('git.connectedRemote')} hint={t('git.connectedRemoteSmall')}>
          <code className="break-all text-xs text-muted-foreground">{cfg.repoUrl}</code>
        </SettingsRow>

        <SettingsRow label={t('git.branch')} hint={t('git.activeBranchSmall')}>
          <select
            value={selectedBranch}
            onChange={(e) => setSelectedBranch(e.target.value)}
            className="h-9 min-w-[160px] rounded-md border border-input bg-background px-2 text-sm"
          >
            {allBranches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <Button variant="secondary" size="sm" onClick={() => checkout.mutate(selectedBranch)} disabled={checkout.isPending}>
            {t('git.switchBranch')}
          </Button>
        </SettingsRow>

        <SettingsRow label={t('git.syncManual')} hint={t('git.syncManualSmall')}>
          <Button variant="secondary" size="sm" onClick={() => pull.mutate()} disabled={pull.isPending}>
            <ArrowDown className="h-4 w-4" /> {t('git.pull')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => push.mutate()} disabled={push.isPending}>
            <ArrowUp className="h-4 w-4" /> {t('git.push')}
          </Button>
          {statusMsg && <span className="ml-1 text-xs text-muted-foreground">{statusMsg}</span>}
        </SettingsRow>

        <SettingsRow label={t('git.autoPull')} hint={t('git.autoPullHint')}>
          <Switch checked={autoPull} onCheckedChange={setAutoPull} />
        </SettingsRow>
        <SettingsRow label={t('git.autoPush')} hint={t('git.autoPushHint')}>
          <Switch checked={autoPush} onCheckedChange={setAutoPush} />
        </SettingsRow>
        <SettingsRow noBorder>
          <Button size="sm" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
            <Save className="h-4 w-4" /> {t('git.saveSettings')}
          </Button>
        </SettingsRow>
      </SettingsSection>

      <GitLogPanel />

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('git.disconnectBtn')}</DialogTitle></DialogHeader>
          <p className="text-sm">{t('git.disconnectConfirm')}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => { setConfirmDisconnect(false); disconnect.mutate(); }}
            >{t('git.disconnectBtn')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Git log (paginated)
// ─────────────────────────────────────────────────────────────

interface GitCommitItem {
  hash: string;
  message: string;
  author: string;
  date: string;
}
interface GitLogResp {
  items?: GitCommitItem[];
  pagination?: {
    page?: number; limit?: number; total?: number; total_pages?: number;
    has_prev?: boolean; has_next?: boolean;
  };
}

function GitLogPanel() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const logQ = useQuery<GitLogResp>({
    queryKey: ['git-log', page, limit],
    queryFn: () => api.getGitLog(page, limit) as unknown as Promise<GitLogResp>,
  });

  const commits = logQ.data?.items || [];
  const pag = logQ.data?.pagination || { has_prev: false, has_next: false, total: 0 };

  let metaText = '';
  if (logQ.isLoading) metaText = t('git.loadingCommits');
  else if (logQ.isError) metaText = t('git.loadFailed');
  else if (!pag.total) metaText = t('git.noCommitsYet');
  else {
    const start = (page - 1) * limit + 1;
    const end = start + commits.length - 1;
    metaText = t('git.showingRange', { start, end, total: pag.total });
  }

  return (
    <SettingsSection icon={<GitCommit className="h-4 w-4" />} title={t('git.recentCommits')}>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-3 pb-2">
        <span className="text-xs text-muted-foreground">{metaText}</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t('git.perPage')}</span>
            <select
              value={limit}
              onChange={(e) => { setLimit(parseInt(e.target.value, 10) || 10); setPage(1); }}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
            >
              {[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={!pag.has_prev}>
            {t('git.prev')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!pag.has_next}>
            {t('git.next')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => logQ.refetch()} disabled={logQ.isFetching}>
            <RotateCw className="h-4 w-4" /> {t('git.refresh')}
          </Button>
        </div>
      </div>

      {logQ.isError ? (
        <div className="py-4 text-xs text-destructive">{t('git.logLoadFailed')}{(logQ.error as Error)?.message}</div>
      ) : logQ.isLoading && commits.length === 0 ? (
        <div className="py-2">
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
        </div>
      ) : commits.length === 0 ? (
        <EmptyState
          compact
          icon={<GitCommit className="h-5 w-5" />}
          title={t('git.noCommitsYet')}
        />
      ) : (
        <div className="font-mono text-xs">
          {commits.map((c, i) => (
            <div key={c.hash + i} className="flex items-start gap-2.5 border-b border-border/60 py-2 last:border-b-0">
              <code className="flex-shrink-0 text-[11px] text-primary">{c.hash}</code>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground">{c.message}</div>
                <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <User className="h-2.5 w-2.5" /> {c.author} · {c.date}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
