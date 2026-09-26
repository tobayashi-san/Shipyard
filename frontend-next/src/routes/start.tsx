import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUpCircle, CircleCheck, CircleHelp, CircleX, Clock3, LoaderCircle, Plus, Rocket, RotateCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { canAccessDeployments, canAccessOperations, hasCap, useEnvironments, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Timestamp } from '@/components/ui/timestamp';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { CreateDeploymentDialog } from '@/features/deployments/CreateDeploymentDialog';
import type { ServerRow } from '@/features/servers/server-list-utils';
import type { OperationRow } from './operations';

interface Jobs { items: OperationRow[]; total: number; counts?: { all: number; active: number; failed: number; failed_total?: number } }
interface Schedule { id: string; name: string; enabled: boolean | number; next_run?: string; registration_status?: string }
interface Vm { id: string; name: string; deployment?: { status: string; deployment_phase?: string }; last_run?: { status: string; deployment_phase?: string } }
interface Entry { id: string; title: string; detail: string; link: ReactNode; time?: string; objectType: string; status: string; acknowledged?: boolean }
function failedDeployment(vm:Vm) { return [vm.deployment,vm.last_run].find(run=>run && ['failed','interrupted'].includes(run.status)); }
const phases: Record<string, string> = { register_host: 'Waiting for IP', connect_host: 'Checking host connection', pre_deploy: 'Running pre-deploy', deploy: 'Creating VM', post_deploy: 'Running post-deploy', ready: 'Ready' };

function Section({ title, children, all }: { title: string; children: ReactNode; all: ReactNode }) {
  return <Card role="region" aria-label={title}><CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="text-base">{title}</CardTitle>{all}</CardHeader><CardContent>{children}</CardContent></Card>;
}
function entryStatus(status: string, acknowledged = false): { label: string; tone: StatusTone; icon: typeof CircleX } {
  // An acknowledged failure is history, not an alert: keep it neutral.
  if (['failed', 'error'].includes(status)) return acknowledged ? { label: 'Failed · acknowledged', tone: 'muted', icon: CircleX } : { label: 'Failed', tone: 'danger', icon: CircleX };
  if (['success', 'successful', 'completed'].includes(status)) return { label: 'Successful', tone: 'success', icon: CircleCheck };
  if (status === 'online') return { label: 'Connected', tone: 'success', icon: CircleCheck };
  if (status === 'updates') return { label: 'Updates', tone: 'warning', icon: ArrowUpCircle };
  if (status === 'reboot') return { label: 'Reboot', tone: 'warning', icon: RotateCw };
  if (['offline', 'error'].includes(status)) return { label: 'Unreachable', tone: 'danger', icon: CircleX };
  if (['scheduled', 'queued', 'pending'].includes(status)) return { label: status === 'scheduled' ? 'Scheduled' : status === 'queued' ? 'Queued' : 'Pending', tone: 'info', icon: Clock3 };
  if (status === 'interrupted') return { label: 'Interrupted', tone: 'muted', icon: CircleHelp };
  if (['running', 'cancelling'].includes(status)) return { label: status === 'running' ? 'Running' : 'Cancelling', tone: 'neutral', icon: LoaderCircle };
  return { label: 'Check', tone: 'muted', icon: CircleHelp };
}
function Entries({ entries, empty }: { entries: Entry[]; empty: string }) {
  return entries.length ? <ul className="-my-1 divide-y">{entries.slice(0,5).map(entry => {
    const status = entryStatus(entry.status, entry.acknowledged);
    const Icon = status.icon;
    return <li key={entry.id} className={cn('flex min-w-0 flex-col items-start justify-between gap-2 py-2.5 sm:flex-row sm:items-center', status.tone === 'danger' && '-mx-3 rounded-md border-l-2 border-l-destructive bg-destructive/5 px-3')}>
      <div className="min-w-0 w-full flex-1 space-y-0.5 sm:w-auto">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><p className="break-words font-medium text-foreground">{entry.title}</p><StatusBadge tone={status.tone}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{status.label}</StatusBadge></div>
        <p className="break-words text-xs text-muted-foreground">{entry.objectType} · {entry.detail}{entry.time && <> · <Timestamp value={entry.time} /></>}</p>
      </div>{entry.link}
    </li>;
  })}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>;
}

export function StartPage() {
  const {data:profile,isPending:profilePending} = useProfile();
  const environmentId = useUi(state => state.environmentId);
  const {data:environments} = useEnvironments();
  const navigate = useNavigate();
  const [hostOpen,setHostOpen] = useState(false);
  const [vmOpen,setVmOpen] = useState(false);
  const viewHosts = hasCap(profile,'canViewServers');
  const viewJobs = canAccessOperations(profile);
  const viewVms = canAccessDeployments(profile);
  const viewSchedules = hasCap(profile,'canViewSchedules');
  const hosts = useQuery({queryKey:['start',environmentId,'hosts'],queryFn:()=>apiFetch<ServerRow[]>(`/servers?environment_id=${encodeURIComponent(environmentId)}`,{environmentId}),enabled:viewHosts,refetchInterval:30_000});
  const vms = useQuery({queryKey:['start',environmentId,'vms'],queryFn:()=>apiFetch<Vm[]>(`/opentofu/vms?environment_id=${encodeURIComponent(environmentId)}`,{environmentId}),enabled:viewVms,refetchInterval:30_000});
  const failed = useQuery({queryKey:['start',environmentId,'failed'],queryFn:()=>apiFetch<Jobs>('/operations?scope=failed&page_size=5',{environmentId}),enabled:viewJobs,refetchInterval:30_000});
  const active = useQuery({queryKey:['start',environmentId,'active'],queryFn:()=>apiFetch<Jobs>('/operations?scope=active&page_size=5',{environmentId}),enabled:viewJobs,refetchInterval:query=>query.state.data?.total ? 15_000 : 30_000});
  const weekStart = new Date(Date.now() - 6 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' });
  const recent = useQuery({queryKey:['start',environmentId,'week',weekStart],queryFn:()=>apiFetch<Jobs>(`/operations?from=${weekStart}&page_size=1`,{environmentId}),enabled:viewJobs,refetchInterval:60_000});
  const schedules = useQuery({queryKey:['start',environmentId,'schedules'],queryFn:()=>apiFetch<Schedule[]>(`/schedules?environment_id=${encodeURIComponent(environmentId)}`,{environmentId}),enabled:viewSchedules,refetchInterval:30_000});
  const hostRows = hosts.data || [];
  const unreachable = hostRows.filter(host=>['offline','error'].includes(host.status || ''));
  const pendingFor = (host:ServerRow) => (host.updates_count || 0) + (host.image_updates_count || 0) + (host.custom_updates_count || 0);
  const updateHosts = hostRows.filter(host=>pendingFor(host) > 0);
  const pendingPackages = updateHosts.reduce((sum,host)=>sum+pendingFor(host),0);
  const rebootHosts = hostRows.filter(host=>host.reboot_required);
  const jobLink = (job:OperationRow) => <Button asChild variant="ghost" size="sm"><Link to="/operations/executions/$id" params={{id:job.id}} search={{environment:environmentId}}>View run log<ArrowRight /></Link></Button>;
  const vmLink = (id:string) => <Button asChild variant="ghost" size="sm"><Link to="/deployments/$id" params={{id}}>Open deployment<ArrowRight /></Link></Button>;
  const attention:Entry[] = [
    ...(vms.data || []).filter(vm=>failedDeployment(vm)).map(vm=>({id:`vm:${vm.id}`,title:vm.name,objectType:'Deployment',status:failedDeployment(vm)!.status,detail:failedDeployment(vm)?.deployment_phase ? `Deployment · ${phases[failedDeployment(vm)!.deployment_phase!] || failedDeployment(vm)!.deployment_phase}` : 'Deployment',link:vmLink(vm.id)})),
    // Several unreachable hosts are one problem to look at, not one alert each.
    ...(unreachable.length > 3
      ? [{id:'hosts:unreachable',title:`${unreachable.length} hosts unreachable`,objectType:'Hosts',status:'offline',detail:unreachable.slice(0,3).map(host=>host.name).join(', ')+' …',link:<Button asChild variant="ghost" size="sm"><Link to="/servers">Show hosts<ArrowRight /></Link></Button>}]
      : unreachable.map(host=>({id:`host:${host.id}`,title:host.name,objectType:'Host',status:host.status || 'unknown',detail:'Host is unreachable',link:<Button asChild variant="ghost" size="sm"><Link to="/servers/$id" params={{id:host.id}}>Check host<ArrowRight /></Link></Button>}))),
    // Pending patches are routine work: one summary line each, the details live on Updates.
    ...(rebootHosts.length ? [{id:'hosts:reboot',title:`${rebootHosts.length} ${rebootHosts.length === 1 ? 'host needs' : 'hosts need'} a reboot`,objectType:'Updates',status:'reboot',detail:rebootHosts.slice(0,3).map(host=>host.name).join(', ')+(rebootHosts.length > 3 ? ' …' : ''),link:<Button asChild variant="ghost" size="sm"><Link to="/updates">Review<ArrowRight /></Link></Button>}] : []),
    ...(updateHosts.length ? [{id:'hosts:updates',title:`${updateHosts.length} ${updateHosts.length === 1 ? 'host has' : 'hosts have'} updates`,objectType:'Updates',status:'updates',detail:`${pendingPackages} ${pendingPackages === 1 ? 'update' : 'updates'} waiting`,link:<Button asChild variant="ghost" size="sm"><Link to="/updates">Review<ArrowRight /></Link></Button>}] : []),
    ...(failed.data?.items || []).filter(job=>job.source !== 'Deployment' || !(vms.data || []).some(vm=>vm.id===job.params?.id && failedDeployment(vm))).map(job=>({id:job.id,title:job.target,objectType:job.source,status:job.status,acknowledged:job.acknowledged,detail:job.name,time:job.time,link:jobLink(job)})),
  ];
  const current:Entry[] = [
    ...(active.data?.items || []).map(job=>({id:job.id,title:job.target,objectType:job.source,status:job.status,detail:job.name,time:job.time,link:job.href === '/deployments/$id' && job.params?.id ? vmLink(job.params.id) : jobLink(job)})),
    ...(schedules.data || []).filter(schedule=>schedule.enabled && schedule.next_run && new Date(schedule.next_run).getTime() >= Date.now()).sort((a,b)=>new Date(a.next_run!).getTime()-new Date(b.next_run!).getTime()).map(schedule=>({id:`schedule:${schedule.id}`,title:schedule.name,objectType:'Automation',status:'scheduled',detail:'Scheduled automation',time:schedule.next_run,link:<Button asChild variant="ghost" size="sm"><Link to="/playbooks" hash={`tab=schedules&schedule=${encodeURIComponent(schedule.id)}`}>Open automation<ArrowRight /></Link></Button>})),
  ];
  const errors = [{allowed:viewHosts,query:hosts,label:'Hosts'},{allowed:viewVms,query:vms,label:'Deployments'},{allowed:viewJobs,query:failed,label:'Failed jobs'},{allowed:viewJobs,query:active,label:'Current jobs'},{allowed:viewJobs,query:recent,label:'Job summary'},{allowed:viewSchedules,query:schedules,label:'Schedules'}];
  const pending = errors.some(item=>item.allowed && item.query.isPending);
  const incomplete = errors.some(item=>item.allowed && item.query.isError);
  const emptyOverview = !pending && !incomplete && viewHosts && !hostRows.length && !vms.data?.length && !active.data?.total && !failed.data?.total && !recent.data?.counts?.all && !(schedules.data || []).some(schedule=>schedule.enabled);
  const connected = hostRows.filter(host=>host.status==='online').length;
  const unchecked = hostRows.filter(host=>!['online','offline','error'].includes(host.status || '')).length;
  const environmentName = String(environments?.find(item=>item.id===environmentId)?.name || environmentId);
  if (profilePending) return <p role="status">Loading your overview…</p>;
  return <div className="space-y-5">
    <PageHeader title="Start" description={<><span>Environment: {environmentName}</span>{viewHosts && hosts.isSuccess ? <> · <span>{hostRows.length} hosts · <span className="[color:hsl(var(--success))]">{connected} connected</span> · <span className={unreachable.length ? 'text-destructive' : undefined}>{unreachable.length} unreachable</span>{unchecked ? ` · ${unchecked} not checked` : ''}</span></> : null}</>} />
    {errors.filter(item=>item.allowed && item.query.isError).map(item=><QueryErrorState key={item.label} compact title={`${item.label} could not be loaded`} error={item.query.error} onRetry={()=>void item.query.refetch()} />)}
    {pending && <p role="status" className="text-sm text-muted-foreground">Loading your overview…</p>}
    {viewHosts && hosts.isSuccess && !hostRows.length && <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p>{hasCap(profile,'canAddServers') ? 'Add your first host.' : 'No hosts are available in your scope.'}</p>{hasCap(profile,'canAddServers') && <Button onClick={()=>setHostOpen(true)}><Plus />Add host</Button>}</CardContent></Card>}
    {!emptyOverview && (viewHosts || viewJobs || viewVms) && <Section title="Needs attention" all={viewJobs && failed.data?.total ? <Link className="inline-flex items-center gap-1 text-sm text-primary hover:underline" to="/operations" search={{section:'tasks',scope:'failed'}}>All failed jobs<ArrowRight className="size-4" /></Link> : null}><Entries entries={attention} empty={pending ? 'Checking saved status…' : incomplete ? 'Some status information is unavailable.' : 'Nothing needs your attention.'} /></Section>}
    {!emptyOverview && (viewJobs || viewSchedules) && <Section title="Current & upcoming" all={viewSchedules ? <Link className="inline-flex items-center gap-1 text-sm text-primary hover:underline" to="/playbooks" hash="tab=schedules">All schedules<ArrowRight className="size-4" /></Link> : null}><Entries entries={current} empty={pending ? 'Loading activity…' : incomplete ? 'Some activity information is unavailable.' : 'No running or scheduled work.'} /></Section>}
    {!emptyOverview && hostRows.length < 3 && (hasCap(profile,'canAddServers') || hasCap(profile,'canEditDeployments') || (hasCap(profile,'canViewPlaybooks') && hasCap(profile,'canRunPlaybooks'))) && <section aria-label="Quick access" className="space-y-3"><h2 className="text-base font-semibold">Quick access</h2><div className="flex flex-wrap gap-2">{hasCap(profile,'canAddServers') && <Button variant="outline" onClick={()=>setHostOpen(true)}><Plus />Add host</Button>}{hasCap(profile,'canEditDeployments') && <Button variant="outline" onClick={()=>setVmOpen(true)}><Rocket />Create VM</Button>}{hasCap(profile,'canViewPlaybooks') && hasCap(profile,'canRunPlaybooks') && <Button asChild variant="outline"><Link to="/playbooks" hash="tab=runs">Run automation<ArrowRight /></Link></Button>}</div></section>}
    {!emptyOverview && viewJobs && recent.data && <section aria-label="Last 7 days" className="flex flex-wrap items-center justify-between gap-3 rounded-panel border bg-card px-4 py-3 text-sm">
      <p><span className="font-medium">Last 7 days:</span> {recent.data.counts?.all ?? recent.data.total} {(recent.data.counts?.all ?? recent.data.total) === 1 ? 'job' : 'jobs'}{recent.data.counts?.failed ? <> · <Link className="text-destructive hover:underline" to="/operations" search={{section:'tasks',scope:'failed'}}>{recent.data.counts.failed} failed</Link></> : ' · none failed'}</p>
      <Link className="inline-flex items-center gap-1 text-primary hover:underline" to="/operations" search={{ from: weekStart }}>All jobs<ArrowRight className="size-4" /></Link>
    </section>}
    {hasCap(profile,'canAddServers') && <CreateServerDialog key={`host-${environmentId}`} open={hostOpen} onOpenChange={setHostOpen} />}
    {hasCap(profile,'canEditDeployments') && <CreateDeploymentDialog key={`vm-${environmentId}`} environmentId={environmentId} open={vmOpen} onOpenChange={setVmOpen} onConfigurePlatforms={()=>void navigate({to:'/settings/$tab',params:{tab:'connections'}})} />}
  </div>;
}
