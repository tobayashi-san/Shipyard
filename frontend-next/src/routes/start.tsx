import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Rocket } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { canAccessDeployments, canAccessOperations, hasCap, useEnvironments, useProfile } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { CreateServerDialog } from '@/components/CreateServerDialog';
import { CreateDeploymentDialog } from '@/features/deployments/CreateDeploymentDialog';
import type { ServerRow } from '@/features/servers/server-list-utils';
import type { OperationRow } from './operations';

interface Jobs { items: OperationRow[]; total: number }
interface Schedule { id: string; name: string; enabled: boolean | number; next_run?: string; registration_status?: string }
interface Vm { id: string; name: string; deployment?: { status: string; deployment_phase?: string }; last_run?: { status: string; deployment_phase?: string } }
interface Entry { id: string; title: string; detail: string; link: ReactNode; time?: string }
function failedDeployment(vm:Vm) { return [vm.deployment,vm.last_run].find(run=>run && ['failed','interrupted'].includes(run.status)); }
const phases: Record<string, string> = { register_host: 'Waiting for IP', connect_host: 'Checking host connection', pre_deploy: 'Running pre-deploy', deploy: 'Creating VM', post_deploy: 'Running post-deploy', ready: 'Ready' };

function Section({ title, children, all }: { title: string; children: ReactNode; all: ReactNode }) {
  return <Card role="region" aria-label={title}><CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="text-base">{title}</CardTitle>{all}</CardHeader><CardContent>{children}</CardContent></Card>;
}
function Entries({ entries, empty }: { entries: Entry[]; empty: string }) {
  return entries.length ? <ul className="divide-y">{entries.slice(0,5).map(entry => <li key={entry.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3 first:pt-0"><div className="min-w-0 flex-1"><p className="break-words font-medium">{entry.title}</p><p className="break-words text-sm text-muted-foreground">{entry.detail}{entry.time ? ` · ${formatDateTime(entry.time)}` : ''}</p></div>{entry.link}</li>)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>;
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
  const recent = useQuery({queryKey:['start',environmentId,'recent'],queryFn:()=>apiFetch<Jobs>('/operations?scope=completed&page_size=5',{environmentId}),enabled:viewJobs,refetchInterval:30_000});
  const schedules = useQuery({queryKey:['start',environmentId,'schedules'],queryFn:()=>apiFetch<Schedule[]>(`/schedules?environment_id=${encodeURIComponent(environmentId)}`,{environmentId}),enabled:viewSchedules,refetchInterval:30_000});
  const hostRows = hosts.data || [];
  const jobLink = (job:OperationRow) => <Button asChild variant="ghost" size="sm"><Link to="/operations/executions/$id" params={{id:job.id}} search={{environment:environmentId}}>Open job<ArrowRight /></Link></Button>;
  const vmLink = (id:string) => <Button asChild variant="ghost" size="sm"><Link to="/deployments/$id" params={{id}}>Open deployment<ArrowRight /></Link></Button>;
  const attention:Entry[] = [
    ...(vms.data || []).filter(vm=>failedDeployment(vm)).map(vm=>({id:`vm:${vm.id}`,title:vm.name,detail:failedDeployment(vm)?.deployment_phase ? `Deployment failed · ${phases[failedDeployment(vm)!.deployment_phase!] || failedDeployment(vm)!.deployment_phase}` : 'Deployment failed',link:vmLink(vm.id)})),
    ...hostRows.filter(host=>['offline','error'].includes(host.status || '')).map(host=>({id:`host:${host.id}`,title:host.name,detail:'Host is unreachable',link:<Button asChild variant="ghost" size="sm"><Link to="/servers/$id" params={{id:host.id}}>Check host<ArrowRight /></Link></Button>})),
    ...(failed.data?.items || []).filter(job=>job.source !== 'Deployment' || !(vms.data || []).some(vm=>vm.id===job.params?.id && failedDeployment(vm))).map(job=>({id:job.id,title:job.target,detail:job.name,link:jobLink(job)})),
  ];
  const current:Entry[] = [
    ...(active.data?.items || []).map(job=>({id:job.id,title:job.name,detail:`${job.target} · ${job.status}`,link:job.href === '/deployments/$id' && job.params?.id ? vmLink(job.params.id) : jobLink(job)})),
    ...(schedules.data || []).filter(schedule=>schedule.enabled && schedule.next_run && new Date(schedule.next_run).getTime() >= Date.now()).sort((a,b)=>new Date(a.next_run!).getTime()-new Date(b.next_run!).getTime()).map(schedule=>({id:`schedule:${schedule.id}`,title:schedule.name,detail:'Scheduled automation',time:schedule.next_run,link:<Button asChild variant="ghost" size="sm"><Link to="/playbooks" hash={`tab=schedules&schedule=${encodeURIComponent(schedule.id)}`}>Open automation<ArrowRight /></Link></Button>})),
  ];
  const errors = [{allowed:viewHosts,query:hosts,label:'Hosts'},{allowed:viewVms,query:vms,label:'Deployments'},{allowed:viewJobs,query:failed,label:'Failed jobs'},{allowed:viewJobs,query:active,label:'Current jobs'},{allowed:viewJobs,query:recent,label:'Recent jobs'},{allowed:viewSchedules,query:schedules,label:'Schedules'}];
  const pending = errors.some(item=>item.allowed && item.query.isPending);
  const incomplete = errors.some(item=>item.allowed && item.query.isError);
  const emptyOverview = !pending && !incomplete && viewHosts && !hostRows.length && !vms.data?.length && !active.data?.total && !failed.data?.total && !recent.data?.total && !(schedules.data || []).some(schedule=>schedule.enabled);
  const hour = new Date().getHours();
  if (profilePending) return <p role="status">Loading your overview…</p>;
  return <div className="space-y-5">
    <PageHeader title="Start" description={`Environment: ${environments?.find(item=>item.id===environmentId)?.name || environmentId}`} />
    <div className="space-y-2"><h2 className="text-2xl font-semibold">{hour<12 ? 'Good morning' : hour<18 ? 'Good afternoon' : 'Good evening'}</h2>{viewHosts && hosts.isSuccess && <p className="text-muted-foreground">{hostRows.length} hosts · {hostRows.filter(host=>host.status==='online').length} connected · {hostRows.filter(host=>['offline','error'].includes(host.status || '')).length} unreachable{hostRows.some(host=>!['online','offline','error'].includes(host.status || '')) ? ` · ${hostRows.filter(host=>!['online','offline','error'].includes(host.status || '')).length} not checked` : ''}</p>}</div>
    {errors.filter(item=>item.allowed && item.query.isError).map(item=><QueryErrorState key={item.label} compact title={`${item.label} could not be loaded`} error={item.query.error} onRetry={()=>void item.query.refetch()} />)}
    {pending && <p role="status" className="text-sm text-muted-foreground">Loading your overview…</p>}
    {viewHosts && hosts.isSuccess && !hostRows.length && <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p>{hasCap(profile,'canAddServers') ? 'Add your first host.' : 'No hosts are available in your scope.'}</p>{hasCap(profile,'canAddServers') && <Button onClick={()=>setHostOpen(true)}><Plus />Add host</Button>}</CardContent></Card>}
    {!emptyOverview && (viewHosts || viewJobs || viewVms) && <Section title="Needs attention" all={<div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-sm">{viewVms && <Link className="text-primary" to="/deployments">All deployments</Link>}{viewHosts && <Link className="text-primary" to="/servers">All hosts</Link>}{viewJobs && <Link className="text-primary" to="/operations" search={{section:'tasks',scope:'failed'}}>All failed jobs</Link>}</div>}><Entries entries={attention} empty={pending ? 'Checking saved status…' : incomplete ? 'Some status information is unavailable.' : 'Nothing needs your attention.'} /></Section>}
    {!emptyOverview && (viewJobs || viewSchedules) && <Section title="Current & upcoming" all={<div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-sm">{viewJobs && <Link className="text-primary" to="/operations" search={{section:'tasks',scope:'active'}}>All active jobs</Link>}{viewSchedules && <Link className="text-primary" to="/playbooks" hash="tab=schedules">All schedules</Link>}</div>}><Entries entries={current} empty={pending ? 'Loading activity…' : incomplete ? 'Some activity information is unavailable.' : 'No running or scheduled work.'} /></Section>}
    {!emptyOverview && (hasCap(profile,'canAddServers') || hasCap(profile,'canEditDeployments') || (hasCap(profile,'canViewPlaybooks') && hasCap(profile,'canRunPlaybooks'))) && <section aria-label="Quick access" className="space-y-3"><h2 className="text-base font-semibold">Quick access</h2><div className="flex flex-wrap gap-2">{hasCap(profile,'canAddServers') && <Button variant="outline" onClick={()=>setHostOpen(true)}><Plus />Add host</Button>}{hasCap(profile,'canEditDeployments') && <Button variant="outline" onClick={()=>setVmOpen(true)}><Rocket />Create VM</Button>}{hasCap(profile,'canViewPlaybooks') && hasCap(profile,'canRunPlaybooks') && <Button asChild variant="outline"><Link to="/playbooks" hash="tab=runs">Run automation<ArrowRight /></Link></Button>}</div></section>}
    {!emptyOverview && viewJobs && <Section title="Recent jobs" all={<Link className="text-sm text-primary" to="/operations">All jobs</Link>}><Entries entries={(recent.data?.items || []).map(job=>({id:job.id,title:job.name,detail:`${job.target} · ${job.status}`,time:job.time,link:jobLink(job)}))} empty={recent.isPending ? 'Loading recent jobs…' : recent.isError ? 'Recent jobs are unavailable.' : 'No completed jobs yet.'} /></Section>}
    {hasCap(profile,'canAddServers') && <CreateServerDialog key={`host-${environmentId}`} open={hostOpen} onOpenChange={setHostOpen} />}
    {hasCap(profile,'canEditDeployments') && <CreateDeploymentDialog key={`vm-${environmentId}`} environmentId={environmentId} open={vmOpen} onOpenChange={setVmOpen} onConfigurePlatforms={()=>void navigate({to:'/settings/$tab',params:{tab:'connections'}})} />}
  </div>;
}
