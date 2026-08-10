import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Boxes, CheckCircle2, Clock3, Cpu, FileCode2, HardDrive, History, MemoryStick, Pencil, Play, Plus, RefreshCw, Server, Settings2, Trash2, Workflow } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { VmFormDialog } from '@/features/deployments/VmFormDialog';
import { DeploymentConnectionDialog } from '@/features/deployments/DeploymentConnectionDialog';
import { RunDetailsDialog } from '@/features/deployments/RunDetailsDialog';
import { DeploymentSettingsDialog } from '@/features/deployments/DeploymentSettingsDialog';
import { useUi } from '@/lib/store';

interface Workspace { id: string; name: string; path?: string; description?: string }
interface Run { id: string; action?: string; status?: string; started_at?: string; completed_at?: string }
interface RunsResponse { items?: Run[] }
interface Vm {
  id: string;
  name: string;
  node_name?: string;
  vm_id?: string | number;
  started?: boolean;
  cpu_cores?: number;
  memory_mb?: number;
  disk_size_gb?: number;
  post_deploy_playbooks?: string[];
  [key: string]: unknown;
}
interface VmsResponse { vms?: Vm[] }
interface VmTemplateConfig {
  cpu_cores?: string | number;
  memory_mb?: string | number;
  disk_size_gb?: string | number;
  clone_vm_id?: string | number;
}
interface VmTemplate { id: string; name: string; config?: VmTemplateConfig }
interface VmTemplatesResponse { templates?: VmTemplate[] }
interface ResourceOverview {
  desired?: { vm_count?: number; cpu_cores?: number; memory_mb?: number; disk_gb?: number; nodes?: Array<{ name?: string; vm_count?: number }> };
  actual?: { available?: boolean; reason?: string; vm_count?: number; resources?: Array<{ address?: string; name?: string; node_name?: string; vm_id?: string | number; status?: string; ip_addresses?: string[] }> };
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function tone(status?: string): StatusTone {
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'error') return 'danger';
  if (status === 'running' || status === 'queued') return 'info';
  return 'muted';
}

function total(vms: Vm[], field: 'cpu_cores' | 'memory_mb' | 'disk_size_gb') {
  return vms.reduce((sum, vm) => sum + (Number(vm[field]) || 0), 0);
}

export function DeploymentDetailPage() {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id || '';
  const environmentId = useUi(state => state.environmentId);
  const queryClient = useQueryClient();
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [vmDialogOpen, setVmDialogOpen] = useState(false);
  const [editingVm, setEditingVm] = useState<Vm | null>(null);
  const [vmToDelete, setVmToDelete] = useState<Vm | null>(null);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<VmTemplate | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const workspacesQuery = useQuery({ queryKey: ['opentofu', 'workspaces', environmentId], queryFn: () => apiFetch<Workspace[]>(`/plugin/opentofu/workspaces?environment_id=${encodeURIComponent(environmentId)}`) });
  const workspace = (Array.isArray(workspacesQuery.data) ? workspacesQuery.data : []).find(item => item.id === id);
  const runsQuery = useQuery({ queryKey: ['opentofu', 'workspace', id, 'runs'], queryFn: () => apiFetch<RunsResponse>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/runs?page_size=8`), enabled: Boolean(id), refetchInterval: query => query.state.data?.items?.some(run => run.status === 'running') ? 2_500 : false });
  const vmsQuery = useQuery({ queryKey: ['opentofu', 'workspace', id, 'vms'], queryFn: () => apiFetch<VmsResponse>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vms`), enabled: Boolean(id) });
  const templatesQuery = useQuery({ queryKey: ['opentofu', 'workspace', id, 'vm-templates'], queryFn: () => apiFetch<VmTemplatesResponse>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vm-templates`), enabled: Boolean(id) });
  const resourceOverviewQuery = useQuery({ queryKey: ['opentofu', 'workspace', id, 'resources-overview'], queryFn: () => apiFetch<ResourceOverview>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/resources-overview`), enabled: Boolean(id), staleTime: 15_000 });
  const vms = Array.isArray(vmsQuery.data?.vms) ? vmsQuery.data!.vms! : [];
  const vmTemplates = Array.isArray(templatesQuery.data?.templates) ? templatesQuery.data!.templates! : [];
  const runs = Array.isArray(runsQuery.data?.items) ? runsQuery.data!.items! : [];

  const runMutation = useMutation({
    mutationFn: (action: 'init' | 'validate' | 'plan' | 'apply') => apiFetch<{ dbRunId?: string }>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/run`, { method: 'POST', body: { action } }),
    onSuccess: (_result, action) => {
      showToast(`${action} wurde gestartet.`, 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'runs'] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const destroyMutation = useMutation({
    mutationFn: () => apiFetch<{ dbRunId?: string }>(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/run`, { method: 'POST', body: { action: 'destroy', confirm_destroy: `DESTROY ${workspace?.name || ''}` } }),
    onSuccess: () => {
      showToast('Destroy wurde gestartet. Der Lauf bleibt in der Historie nachvollziehbar.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'runs'] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'resources-overview'] });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id] });
    void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
  };
  const deleteTemplateMutation = useMutation({
    mutationFn: (templateId: string) => apiFetch(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vm-templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      showToast('VM-Vorlage gelöscht.', 'success');
      setTemplateToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'vm-templates'] });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const deleteVmMutation = useMutation({
    mutationFn: (vmId: string) => apiFetch(`/plugin/opentofu/workspaces/${encodeURIComponent(id)}/proxmox-vms/${encodeURIComponent(vmId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      showToast('VM-Definition entfernt. Der laufende Server wird erst durch einen bestätigten OpenTofu-Apply geändert.', 'success');
      setVmToDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'vms'] });
      void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspaces'] });
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const openNewVmDialog = () => { setEditingVm(null); setVmDialogOpen(true); };
  const openEditVmDialog = (vm: Vm) => { setEditingVm(vm); setVmDialogOpen(true); };

  if (workspacesQuery.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-60 w-full" /></div>;
  if (!workspace) return <div className="space-y-4"><PageHeader title={t('deploy.title')} back={<Button asChild size="icon" variant="ghost"><Link to="/deployments"><ArrowLeft /></Link></Button>} /><Card><EmptyState icon={<Workflow className="h-5 w-5" />} title="Deployment nicht gefunden" description="Der Workspace wurde gelöscht oder ist für deine Rolle nicht freigegeben." action={<Button asChild variant="outline"><Link to="/deployments">{t('deploy.title')}</Link></Button>} /></Card></div>;

  return <div className="space-y-6">
    <PageHeader
      title={workspace.name}
      description={workspace.description || workspace.path || t('deploy.description')}
      back={<Button asChild size="icon" variant="ghost" aria-label={t('deploy.title')}><Link to="/deployments"><ArrowLeft /></Link></Button>}
      actions={<>
        <Button type="button" variant="outline" onClick={refresh}><RefreshCw />{t('deploy.refresh')}</Button>
        <Button type="button" variant="outline" onClick={() => setSettingsDialogOpen(true)}><Pencil />Deployment bearbeiten</Button>
        <Button type="button" variant="outline" onClick={() => setConnectionDialogOpen(true)}><Settings2 />Proxmox-Verbindung</Button>
        <Button asChild variant="ghost"><Link to="/plugins/$id" params={{ id: 'opentofu' }}><FileCode2 />{t('deploy.advanced')}</Link></Button>
      </>}
    />

    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
        <div><CardTitle className="text-base">Bereitstellung</CardTitle><p className="mt-1 text-sm text-muted-foreground">Führe erst einen Plan aus und wende die Änderung danach kontrolliert an.</p></div>
        {runMutation.isPending && <StatusBadge tone="info" dot>Wird gestartet</StatusBadge>}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 p-4">
        <Button type="button" variant="outline" onClick={() => runMutation.mutate('init')} disabled={runMutation.isPending || destroyMutation.isPending}><FileCode2 />Initialisieren</Button>
        <Button type="button" variant="outline" onClick={() => runMutation.mutate('validate')} disabled={runMutation.isPending || destroyMutation.isPending}><CheckCircle2 />Prüfen</Button>
        <Button type="button" variant="outline" onClick={() => runMutation.mutate('plan')} disabled={runMutation.isPending || destroyMutation.isPending}><Play />Plan erstellen</Button>
        <Button type="button" onClick={() => setConfirmApply(true)} disabled={runMutation.isPending || destroyMutation.isPending}><ArrowRight />Änderungen anwenden</Button>
        <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setConfirmDestroy(true)} disabled={runMutation.isPending || destroyMutation.isPending}>Destroy …</Button>
      </CardContent>
    </Card>

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b"><CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" />Proxmox-VMs</CardTitle><div className="flex items-center gap-2"><StatusBadge tone="neutral">{vms.length}</StatusBadge><Button type="button" size="sm" onClick={openNewVmDialog}><Plus />VM hinzufügen</Button></div></CardHeader>
        <CardContent className="p-0">
          {vmsQuery.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : vms.length === 0 ? <EmptyState compact icon={<Server className="h-5 w-5" />} title="Keine VM-Definitionen" description="Definiere deine erste VM direkt in Fleet." action={<Button size="sm" onClick={openNewVmDialog}><Plus />VM hinzufügen</Button>} /> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">VM</th><th className="px-4 py-3 font-medium">Node</th><th className="px-4 py-3 font-medium">VM-ID</th><th className="px-4 py-3 font-medium">vCPU</th><th className="px-4 py-3 font-medium">RAM</th><th className="px-4 py-3 font-medium">Disk</th><th className="px-4 py-3 font-medium">Status</th><th className="w-24 px-4 py-3 text-right font-medium">Aktionen</th></tr></thead><tbody className="divide-y">{vms.map(vm => <tr key={vm.id} className="hover:bg-muted/20"><td className="px-4 py-3 font-medium">{vm.name}<div className="mt-0.5 text-xs text-muted-foreground">{vm.post_deploy_playbooks?.length ? `${vm.post_deploy_playbooks.length} Post-Deploy-Schritte` : 'Keine Post-Deploy-Schritte'}</div></td><td className="px-4 py-3 font-mono text-xs">{vm.node_name || '—'}</td><td className="px-4 py-3 font-mono text-xs">{vm.vm_id ?? 'Automatisch'}</td><td className="px-4 py-3 tabular-nums">{vm.cpu_cores || '—'}</td><td className="px-4 py-3 tabular-nums">{vm.memory_mb ? `${vm.memory_mb} MB` : '—'}</td><td className="px-4 py-3 tabular-nums">{vm.disk_size_gb ? `${vm.disk_size_gb} GB` : '—'}</td><td className="px-4 py-3"><StatusBadge tone={vm.started ? 'success' : 'muted'} dot>{vm.started ? 'Gestartet' : 'Aus'}</StatusBadge></td><td className="px-4 py-3"><div className="flex justify-end gap-1"><Button type="button" variant="ghost" size="icon" onClick={() => openEditVmDialog(vm)} aria-label={`${vm.name} bearbeiten`}><Pencil className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => setVmToDelete(vm)} aria-label={`${vm.name} entfernen`}><Trash2 className="h-4 w-4" /></Button></div></td></tr>)}</tbody><tfoot className="border-t bg-muted/20 text-sm"><tr><td className="px-4 py-3 font-medium">Kapazität</td><td /><td /><td className="px-4 py-3 font-mono">{total(vms, 'cpu_cores')}</td><td className="px-4 py-3 font-mono">{total(vms, 'memory_mb')} MB</td><td className="px-4 py-3 font-mono">{total(vms, 'disk_size_gb')} GB</td><td /><td /></tr></tfoot></table></div>}
        </CardContent>
    </Card>

    <Card className="xl:order-2 xl:col-span-2">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
        <div><CardTitle className="text-base">Bereitgestellte Ressourcen</CardTitle><p className="mt-1 text-sm text-muted-foreground">Abgleich zwischen der gewünschten Fleet-Konfiguration und dem aktuellen OpenTofu-State.</p></div>
        <div className="flex items-center gap-2"><StatusBadge tone={resourceOverviewQuery.data?.actual?.available ? 'success' : 'muted'} dot>{resourceOverviewQuery.data?.actual?.available ? 'State verfügbar' : 'Noch kein State'}</StatusBadge><Button type="button" size="icon" variant="ghost" onClick={() => void queryClient.invalidateQueries({ queryKey: ['opentofu', 'workspace', id, 'resources-overview'] })} aria-label="Ressourcen aktualisieren"><RefreshCw className={resourceOverviewQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button></div>
      </CardHeader>
      <CardContent className="p-0">
        {resourceOverviewQuery.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : resourceOverviewQuery.data?.actual?.available ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Ressource</th><th className="px-4 py-3 font-medium">Node</th><th className="px-4 py-3 font-medium">VM-ID</th><th className="px-4 py-3 font-medium">IP-Adresse</th><th className="px-4 py-3 font-medium">State</th></tr></thead><tbody className="divide-y">{(resourceOverviewQuery.data.actual.resources || []).map(resource => <tr key={resource.address || `${resource.name}-${resource.vm_id}`} className="hover:bg-muted/20"><td className="px-4 py-3"><div className="font-medium">{resource.name || '—'}</div><div className="mt-0.5 font-mono text-xs text-muted-foreground">{resource.address || '—'}</div></td><td className="px-4 py-3 font-mono text-xs">{resource.node_name || '—'}</td><td className="px-4 py-3 font-mono text-xs">{resource.vm_id ?? '—'}</td><td className="px-4 py-3 font-mono text-xs">{resource.ip_addresses?.length ? resource.ip_addresses.join(', ') : 'Wird ermittelt…'}</td><td className="px-4 py-3"><StatusBadge tone={resource.status === 'managed' ? 'success' : 'muted'} dot>{resource.status === 'managed' ? 'Verwaltet' : resource.status || '—'}</StatusBadge></td></tr>)}</tbody></table></div> : <EmptyState compact icon={<Boxes className="h-5 w-5" />} title="Noch keine Ressourcen aus dem State" description={resourceOverviewQuery.data?.actual?.reason || 'Führe nach dem Plan einen Apply aus, damit Fleet den tatsächlichen Zustand anzeigen kann.'} />}
      </CardContent>
    </Card>

    <Card className="xl:order-1">
        <CardHeader className="flex-row items-center justify-between border-b"><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" />Laufhistorie</CardTitle><Button type="button" size="icon" variant="ghost" onClick={refresh} aria-label={t('deploy.refresh')}><RefreshCw className="h-4 w-4" /></Button></CardHeader>
        <CardContent className="p-0">{runsQuery.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : runs.length === 0 ? <EmptyState compact icon={<Clock3 className="h-5 w-5" />} title={t('deploy.noRun')} /> : <ul className="divide-y">{runs.map(run => <li key={run.id}><button type="button" onClick={() => setSelectedRunId(run.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"><StatusBadge tone={tone(run.status)} dot>{run.status || '—'}</StatusBadge><div className="min-w-0 flex-1"><div className="font-mono text-sm font-medium">{run.action || 'tofu'}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{formatDate(run.completed_at || run.started_at)}</div></div><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="sr-only">Laufdetails öffnen</span></button></li>)}</ul>}</CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b">
        <div><CardTitle className="text-base">VM-Vorlagen</CardTitle><p className="mt-1 text-sm text-muted-foreground">Wiederverwendbare Standardwerte für neue Proxmox-VMs in diesem Deployment.</p></div>
        <Button type="button" size="sm" variant="outline" onClick={openNewVmDialog}><Plus />Vorlage anlegen</Button>
      </CardHeader>
      <CardContent className="p-0">
        {templatesQuery.isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : vmTemplates.length === 0 ? <EmptyState compact icon={<Server className="h-5 w-5" />} title="Keine VM-Vorlagen" description="Konfiguriere eine VM im Formular und speichere ihre Werte als Vorlage." /> : <ul className="divide-y">{vmTemplates.map(template => <li key={template.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"><div className="min-w-0 flex-1"><div className="font-medium">{template.name}</div><div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>{template.config?.cpu_cores || '—'} vCPU</span><span>{template.config?.memory_mb || '—'} MB RAM</span><span>{template.config?.disk_size_gb || '—'} GB Disk</span><span>{template.config?.clone_vm_id ? `Template ${template.config.clone_vm_id}` : 'Kein Clone-Template'}</span></div></div><Button type="button" size="icon" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setTemplateToDelete(template)} aria-label={`Vorlage ${template.name} löschen`}><Trash2 className="h-4 w-4" /></Button></li>)}</ul>}
      </CardContent>
    </Card>

    <ConfirmDialog open={confirmApply} onOpenChange={setConfirmApply} title="Änderungen anwenden?" description="OpenTofu wendet den zuletzt berechneten gewünschten Zustand auf die Proxmox-Umgebung an. Prüfe den Plan vorher." confirmLabel="Anwenden" cancelLabel="Abbrechen" variant="warning" onConfirm={() => runMutation.mutate('apply')} isPending={runMutation.isPending} />
    <ConfirmDialog open={confirmDestroy} onOpenChange={setConfirmDestroy} title="Deployment wirklich zerstören?" description={<>Dies startet <code>tofu destroy</code> für <strong>{workspace.name}</strong>. Alle von diesem Deployment verwalteten Ressourcen – etwa VMs, Disks und Netzwerkkonfigurationen – werden entfernt. Dieser Vorgang kann nicht rückgängig gemacht werden.</>} confirmLabel="Destroy starten" cancelLabel="Abbrechen" variant="destructive" confirmTextValue={`DESTROY ${workspace.name}`} confirmInputLabel="Zur Bestätigung eingeben" confirmInputHelp={<>Gib exakt <code className="font-mono text-foreground">DESTROY {workspace.name}</code> ein.</>} onConfirm={() => destroyMutation.mutate()} isPending={destroyMutation.isPending} />
    <ConfirmDialog open={Boolean(templateToDelete)} onOpenChange={open => !open && setTemplateToDelete(null)} title="VM-Vorlage löschen?" description={templateToDelete ? `Die Vorlage „${templateToDelete.name}“ wird gelöscht. Bereits definierte VMs bleiben unverändert.` : ''} confirmLabel="Vorlage löschen" cancelLabel="Abbrechen" variant="destructive" onConfirm={() => templateToDelete && deleteTemplateMutation.mutate(templateToDelete.id)} isPending={deleteTemplateMutation.isPending} />
    <ConfirmDialog open={Boolean(vmToDelete)} onOpenChange={open => !open && setVmToDelete(null)} title="VM-Definition entfernen?" description={vmToDelete ? `Die gewünschte Konfiguration für „${vmToDelete.name}“ wird entfernt. Der bestehende Proxmox-Server wird erst bei einem späteren, kontrollierten Apply geändert.` : ''} confirmLabel="Definition entfernen" cancelLabel="Abbrechen" variant="destructive" onConfirm={() => vmToDelete && deleteVmMutation.mutate(vmToDelete.id)} isPending={deleteVmMutation.isPending} />
    <VmFormDialog workspaceId={workspace.id} open={vmDialogOpen} onOpenChange={open => { setVmDialogOpen(open); if (!open) setEditingVm(null); }} initialVm={editingVm} />
    <DeploymentConnectionDialog workspaceId={workspace.id} open={connectionDialogOpen} onOpenChange={setConnectionDialogOpen} />
    <RunDetailsDialog workspaceId={workspace.id} runId={selectedRunId} open={Boolean(selectedRunId)} onOpenChange={open => { if (!open) setSelectedRunId(null); }} />
    <DeploymentSettingsDialog workspace={workspace} open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
  </div>;
}
