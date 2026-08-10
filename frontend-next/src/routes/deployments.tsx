import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Boxes, CheckCircle2, Clock3, Cpu, FolderPlus, HardDrive, Layers3, MemoryStick, RefreshCw, Server, TriangleAlert, Workflow } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { CreateDeploymentDialog } from '@/features/deployments/CreateDeploymentDialog';

interface OpenTofuStatus {
  installed?: boolean;
  version?: string | null;
}

interface Run {
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

interface Workspace {
  id: string;
  name: string;
  path?: string;
  description?: string;
  last_run?: Run | null;
}

interface DeploymentSummary {
  vm_count: number;
  started_vm_count: number;
  post_deploy?: {
    counts?: { success?: number; running?: number; failed?: number; pending?: number };
  };
  resources?: Array<{
    id: string;
    name: string;
    node_name?: string;
    vm_id?: number | string;
    cpu_cores?: number;
    memory_mb?: number;
    disk_size_gb?: number;
  }>;
}

function runTone(status?: string): StatusTone {
  switch (String(status || '').toLowerCase()) {
    case 'success': case 'completed': return 'success';
    case 'failed': case 'error': return 'danger';
    case 'running': case 'queued': return 'info';
    default: return 'muted';
  }
}

function formatDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function capacityFor(resources: DeploymentSummary['resources'], key: 'cpu_cores' | 'memory_mb' | 'disk_size_gb') {
  return (resources || []).reduce((total, resource) => total + (Number(resource[key]) || 0), 0);
}

function Metric({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string | number }) {
  return <div className="min-w-0 border-l first:border-l-0 px-3 first:pl-0 sm:px-4">
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</div>
    <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground">{value}</div>
  </div>;
}

export function DeploymentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const statusQuery = useQuery({
    queryKey: ['opentofu', 'status'],
    queryFn: () => apiFetch<OpenTofuStatus>('/plugin/opentofu/status'),
    staleTime: 30_000,
  });
  const workspaceQuery = useQuery({
    queryKey: ['opentofu', 'workspaces'],
    queryFn: () => apiFetch<Workspace[]>('/plugin/opentofu/workspaces'),
    staleTime: 15_000,
  });
  const workspaces = Array.isArray(workspaceQuery.data) ? workspaceQuery.data : [];
  const summaryQueries = useQueries({
    queries: workspaces.map(workspace => ({
      queryKey: ['opentofu', 'workspace', workspace.id, 'deployment-summary'],
      queryFn: () => apiFetch<DeploymentSummary>(`/plugin/opentofu/workspaces/${encodeURIComponent(workspace.id)}/deployment-summary`),
      staleTime: 15_000,
    })),
  });
  const summaries = useMemo(() => new Map(workspaces.map((workspace, index) => [workspace.id, summaryQueries[index]?.data])), [summaryQueries, workspaces]);
  const isRefreshing = statusQuery.isFetching || workspaceQuery.isFetching || summaryQueries.some(query => query.isFetching);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['opentofu'] });
  };

  return <div className="space-y-6">
    <PageHeader
      title={t('deploy.title')}
      description={t('deploy.description')}
      actions={<>
        <Button type="button" variant="outline" onClick={refresh} disabled={isRefreshing}><RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />{t('deploy.refresh')}</Button>
        <Button type="button" onClick={() => setCreateOpen(true)}><FolderPlus />Deployment anlegen</Button>
      </>}
    />

    <Card className={statusQuery.data?.installed ? 'border-emerald-500/20' : 'border-amber-500/30'}>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        {statusQuery.data?.installed ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <TriangleAlert className="h-5 w-5 text-amber-500" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t('deploy.status')}</div>
          <div className="text-xs text-muted-foreground">{statusQuery.data?.installed ? `${t('deploy.ready')}${statusQuery.data.version ? ` · ${statusQuery.data.version}` : ''}` : t('deploy.unavailable')}</div>
        </div>
        {!statusQuery.data?.installed && <Button asChild size="sm" variant="outline"><Link to="/plugins/$id" params={{ id: 'opentofu' }}>{t('deploy.open')}<ArrowRight /></Link></Button>}
      </CardContent>
    </Card>

    {workspaceQuery.isLoading ? <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(item => <Card key={item}><CardContent className="h-52 animate-pulse bg-muted/40" /></Card>)}</div> : workspaces.length === 0 ? <Card><EmptyState icon={<Layers3 className="h-5 w-5" />} title={t('deploy.noWorkspaces')} description={t('deploy.noWorkspacesHint')} action={<Button onClick={() => setCreateOpen(true)}><FolderPlus />Deployment anlegen</Button>} /></Card> : <>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {workspaces.map(workspace => {
          const summary = summaries.get(workspace.id);
          const resources = summary?.resources || [];
          const lastRun = workspace.last_run;
          const postDeploy = summary?.post_deploy?.counts;
          const pending = (postDeploy?.pending || 0) + (postDeploy?.running || 0) + (postDeploy?.failed || 0);
          return <Card key={workspace.id} className="flex min-w-0 flex-col">
            <CardHeader className="space-y-2 border-b pb-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">{workspace.name}</CardTitle>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{workspace.path || '—'}</p>
                </div>
                {lastRun ? <StatusBadge tone={runTone(lastRun.status)} dot>{lastRun.status || lastRun.action || '—'}</StatusBadge> : <StatusBadge tone="muted">{t('deploy.noRun')}</StatusBadge>}
              </div>
              {workspace.description && <p className="line-clamp-2 text-sm text-muted-foreground">{workspace.description}</p>}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col p-4 pt-4">
              <div className="grid grid-cols-2 gap-y-4 sm:grid-cols-4">
                <Metric icon={Server} label={t('deploy.vms')} value={summary?.vm_count ?? '—'} />
                <Metric icon={Cpu} label={t('deploy.vcpu')} value={summary ? capacityFor(resources, 'cpu_cores') : '—'} />
                <Metric icon={MemoryStick} label={t('deploy.memory')} value={summary ? `${capacityFor(resources, 'memory_mb')} MB` : '—'} />
                <Metric icon={HardDrive} label={t('deploy.disk')} value={summary ? `${capacityFor(resources, 'disk_size_gb')} GB` : '—'} />
              </div>
              <div className="mt-5 space-y-2 border-t pt-3 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{t('deploy.lastRun')}</span><span className="truncate text-right font-mono">{formatDate(lastRun?.completed_at || lastRun?.started_at) || t('deploy.noRun')}</span></div>
                <div className="flex items-center justify-between gap-3"><span>{t('deploy.started')}</span><span className="font-mono tabular-nums">{summary ? `${summary.started_vm_count}/${summary.vm_count}` : '—'}</span></div>
                {pending > 0 && <div className="flex items-center justify-between gap-3 text-amber-600 dark:text-amber-400"><span>{t('deploy.postDeploy')}</span><span className="font-mono tabular-nums">{pending} {t('deploy.pending')}</span></div>}
              </div>
              <Button asChild variant="outline" className="mt-4 w-full"><Link to="/deployments/$id" params={{ id: workspace.id }}>{t('deploy.open')}<ArrowRight /></Link></Button>
            </CardContent>
          </Card>;
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('deploy.legacyHint')} <Link to="/plugins/$id" params={{ id: 'opentofu' }} className="font-medium text-primary hover:underline">{t('deploy.advanced')}</Link></p>
    </>}
    <CreateDeploymentDialog open={createOpen} onOpenChange={setCreateOpen} />
  </div>;
}
