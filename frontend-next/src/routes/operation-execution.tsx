import { CopyButton } from '@/features/server-detail/components/summary-cards';
import { hostResultSummary, workflowFacts } from '@/features/operations/model';
import { filterExecutionLog, stripTerminalCodes } from '@/lib/execution-log';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Timestamp } from '@/components/ui/timestamp';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api';
import { useEnvironments } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/store';
import { statusLabel } from '@/lib/history-labels';
import { PageHeader } from '@/components/ui/page-header';
import { QueryErrorState } from '@/components/ui/query-error-state';
import { StatusBadge } from '@/components/ui/status-badge';
import type { OperationRow } from './operations';

interface Execution extends OperationRow {
  host_results?: Array<{ name: string; server_id: string | null; status: string; ok: number | null; changed: number | null; failed: number | null; unreachable: number | null; duration_seconds: number | null }>;
  execution_id: string;
  duration_seconds: number | null;
  summary: string;
  output: string;
  output_truncated: boolean;
}

export function OperationExecutionPage() {
  const [logSearch, setLogSearch] = useState('');
  const [logHost, setLogHost] = useState('');
  const { id } = useParams({ strict: false }) as { id: string };
  const selectedEnvironmentId = useUi(state => state.environmentId);
  const setEnvironmentId = useUi(state => state.setEnvironmentId);
  const search = useSearch({ strict: false }) as { environment?: string };
  const environmentId = search.environment || selectedEnvironmentId;
  const environments = useEnvironments();
  const environment = environments.data?.find(item => item.id === environmentId);
  const environmentName = String(environment?.name || environmentId);

  const { t } = useTranslation();
  const details = useQuery({
    queryKey: ['operation-details', environmentId, id],
    queryFn: () => apiFetch<Execution>(`/operations/${encodeURIComponent(id)}/details`, { environmentId }),
    refetchInterval: query => ['running', 'queued', 'pending', 'cancelling'].includes(query.state.data?.status || '') ? 3000 : false,
  });
  const row = details.isError ? undefined : details.data;
  const hostResults = row?.host_results || [];
  const logLines = stripTerminalCodes(row?.output || '').split(/\r?\n/);
  const filteredLog = filterExecutionLog(row?.output || '', logSearch, logHost);
  const visibleLog = filteredLog ? filteredLog.split('\n') : [];
  return <div className="space-y-4">
    <PageHeader back={<Button variant="ghost" size="icon" asChild><Link to="/operations" aria-label={environmentId === selectedEnvironmentId ? 'Back to jobs' : 'Back to current environment jobs'}><ArrowLeft /></Link></Button>} breadcrumbs={<><Link to="/operations" className="hover:text-foreground hover:underline">Jobs</Link><span>/</span><span className="text-foreground">Execution</span></>} title={row?.name || 'Execution details'} description={row ? `${row.source} · ${hostResults.length ? `${hostResults.length} ${hostResults.length === 1 ? 'host' : 'hosts'}` : row.target}` : 'Inspect the selected execution and its recorded output.'} />
    {environmentId !== selectedEnvironmentId && <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-sm" role="status">
      <span>Execution environment: <strong>{environmentName}</strong></span>
      <span className="text-muted-foreground">This link uses a different environment from the console selection.</span>
      {environment && <Button size="sm" variant="outline" onClick={() => setEnvironmentId(environmentId)}>Use this environment in the console</Button>}
    </div>}
    {details.isPending && <p role="status">Loading execution details…</p>}
    {details.isError && <QueryErrorState error={details.error} title="Execution details unavailable" onRetry={() => void details.refetch()} />}
    {row && !details.isError && <>
      <section aria-label="Execution summary" className="space-y-3 rounded-md border bg-card p-4">
        <StatusBadge tone={row.status === 'failed' ? 'danger' : row.status === 'success' ? 'success' : ['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 'info' : 'muted'}>{statusLabel(t, row.status)}</StatusBadge>
        <p className="break-words">{hostResults.length ? hostResultSummary(hostResults) : row.summary}</p>
        {row.source === 'Workflow' && workflowFacts(row) && <p className="text-sm text-muted-foreground">{workflowFacts(row)}</p>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <div><dt className="text-muted-foreground">Target</dt><dd className="flex flex-wrap gap-1">{hostResults.length ? hostResults.map(host => host.server_id ? <Link key={host.name} to="/servers/$id" params={{id: host.server_id}} className="rounded border px-2 py-0.5 text-primary hover:underline">{host.name}</Link> : <span key={host.name} className="rounded border px-2 py-0.5">{host.name}</span>) : row.target}{row.target_deleted ? ' (deleted host)' : ''}{!hostResults.length && row.target_detail ? ` · ${row.target_detail}` : ''}</dd></div>
          <div><dt className="text-muted-foreground">Triggered by</dt><dd>{row.initiator}</dd></div>
          <div><dt className="text-muted-foreground">Started</dt><dd>{row.started_at ? <Timestamp value={row.started_at} /> : 'Not recorded'}</dd></div>
          <div><dt className="text-muted-foreground">Completed</dt><dd>{row.completed_at ? <Timestamp value={row.completed_at} /> : (['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 'Pending completion' : 'Not recorded')}</dd></div>
          <div><dt className="text-muted-foreground">Duration</dt><dd>{row.duration_seconds === null ? (['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 'Pending completion' : 'Not recorded') : `${row.duration_seconds}s`}</dd></div>
          <div><dt className="text-muted-foreground">Execution ID</dt><dd className="flex items-center gap-1 font-mono text-xs" title={row.execution_id}><span className="break-all">{row.execution_id}</span><CopyButton value={row.execution_id} label="Execution ID" /></dd></div>
        </dl>

      </section>
      {hostResults.length > 0 && <section aria-label="Host results" className="space-y-3 rounded-md border bg-card p-4">
        <h2 className="font-semibold">Host results</h2>
        <p className="text-xs text-muted-foreground" title="Duration is the observed task time per host; older runs may not include it.">— means the run did not report a count.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Host', 'Result', 'OK', 'Changed', 'Failed', 'Unreachable', 'Duration', 'Log'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{hostResults.map(host => <tr key={host.name} className="border-t">
          <td className="p-2">{host.server_id ? <Link to="/servers/$id" params={{id: host.server_id}} className="text-primary hover:underline">{host.name}</Link> : host.name}</td>
          <td className="p-2"><StatusBadge tone={host.status === 'failed' ? 'danger' : host.status === 'success' ? 'success' : 'muted'}>{statusLabel(t, host.status)}</StatusBadge></td>
          <td className="p-2">{host.ok ?? '—'}</td><td className="p-2">{host.changed ?? '—'}</td><td className="p-2">{host.failed ?? '—'}</td><td className="p-2">{host.unreachable ?? '—'}</td><td className="p-2">{host.duration_seconds === null ? 'Not recorded' : `${host.duration_seconds}s`}</td>
          <td className="p-2"><Button variant="outline" size="sm" onClick={() => { setLogHost(host.name); document.getElementById('execution-log')?.scrollIntoView({behavior: 'smooth'}); }}>Filter log</Button></td>
        </tr>)}</tbody></table></div>
      </section>}
      <section id="execution-log" aria-label="Execution log" className="space-y-2 rounded-md border bg-card p-4">
        <h2 className="font-semibold">Execution log</h2>
        <div className="flex flex-wrap gap-3">
          <Input aria-label="Search execution log" placeholder="Search log text…" value={logSearch} onChange={event => setLogSearch(event.target.value)} className="max-w-sm" />
          <select aria-label="Filter log by host" value={logHost} onChange={event => setLogHost(event.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="">All hosts</option>{hostResults.map(host => <option key={host.name} value={host.name}>{host.name}</option>)}</select>
          {(logSearch || logHost) && <Button variant="ghost" onClick={() => {setLogSearch(''); setLogHost('');}}>Clear filters</Button>}
        </div>
        {logHost && <p className="text-xs text-muted-foreground">Showing recorded messages for this host with task headings and multiline context. Clear filters to inspect the complete log.</p>}
        <p className="text-xs text-muted-foreground">{visibleLog.length} of {logLines.length} lines</p>
        {row.output_truncated && <p className="text-sm text-muted-foreground">Showing the last 200,000 characters.</p>}
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{visibleLog.join('\n') || (row.output ? 'No matching log lines.' : 'No output recorded.')}</pre>
      </section>
    </>}
  </div>;
}
