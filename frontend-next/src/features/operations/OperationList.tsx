import { Button } from "@/components/ui/button";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Timestamp } from '@/components/ui/timestamp';
import { OperationRow, operationDisplayLabel, operationDisplayTone, operationSourceLabel, workflowFacts } from '@/features/operations/model';
import { apiFetch } from "@/lib/api";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
	useQuery
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	CheckCircle2,
	ExternalLink,
	Info,
	X
} from "lucide-react";

export function TaskScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

/** Accepts the className a Button passes through `asChild`, so it can render as a button. */
export function OperationLink({
  row,
  children,
  className,
}: {
  row: OperationRow;
  children: React.ReactNode;
  className?: string;
}) {
  if (!row.href) return <>{children}</>;
  const linkClass = className || "hover:text-primary hover:underline";
  if (row.href === "/deployments/$id" || row.href === "/servers/$id")
    return (
      <Link
        to={row.href}
        params={row.params as { id: string }}
        className={linkClass}
      >
        {children}
      </Link>
    );
  return (
    <Link to={row.href} className={linkClass}>
      {children}
    </Link>
  );
}

export function OperationDetail({
  row,
  acknowledging,
  onAcknowledge,
  className,
  showHeading = true,
  onClose,
}: {
  row: OperationRow | null;
  acknowledging: boolean;
  onAcknowledge: (id: string) => void;
  className?: string;
  showHeading?: boolean;
  onClose?: () => void;
}) {
  const environmentId = useUi(state => state.environmentId);
  const details = useQuery({
    queryKey: ['operation-details', environmentId, row?.id],
    queryFn: () => apiFetch<{ execution_id: string; duration_seconds: number | null; summary: string; output: string; output_truncated: boolean }>(`/operations/${encodeURIComponent(row!.id)}/details`),
    enabled: Boolean(row),
    refetchInterval: row && ['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 3000 : false,
  });
  if (!row) return null;
  return (
    <aside className={cn("border-t bg-muted/[0.12] p-4 xl:border-l xl:border-t-0", className)}>
      {showHeading && <div className="flex items-center gap-2 text-sm font-semibold">
        <Info className="h-4 w-4 text-brand" />
        Task details
        {onClose && <button type="button" onClick={onClose} aria-label="Close task details" className="ml-auto rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>}
      </div>}
      <div className={cn(showHeading && "mt-3")}>
        <h3 className="break-words text-base font-semibold leading-snug">
          {row.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {operationSourceLabel(row.source)} · {row.initiator}
        </p>
      </div>
      <div className="console-properties mt-3 overflow-hidden rounded-md border bg-card">
        <div className="console-property">
          <span>Status</span>
          <b>
            <StatusBadge tone={operationDisplayTone(row)} dot>
              {operationDisplayLabel(row)}
            </StatusBadge>
          </b>
        </div>
        <div className="console-property">
          <span>Type</span>
          <b>{operationSourceLabel(row.source)}</b>
        </div>
        <div className="console-property items-start">
          <span className="pt-0.5">Target</span>
          <div className="!overflow-visible !whitespace-normal !break-words font-semibold leading-relaxed sm:text-right">
            <OperationTarget row={row} />
          </div>
        </div>
        <div className="console-property items-start">
          <span className="pt-0.5">Triggered by</span>
          <b className="!overflow-visible !whitespace-normal !break-words leading-relaxed sm:text-right">
            {row.initiator}
          </b>
        </div>
        <div className="console-property">
          <span>{row.completed_at ? "Completed" : "Started"}</span>
          <b className="whitespace-normal text-right">
            <Timestamp value={row.time} />
          </b>
        </div>
        {row.acknowledged && (
          <>
            <div className="console-property">
              <span>Acknowledged by</span>
              <b>{row.acknowledged_by || "Unknown operator"}</b>
            </div>
            <div className="console-property">
              <span>Acknowledged at</span>
              <b className="whitespace-normal text-right">
                <Timestamp value={row.acknowledged_at} />
              </b>
            </div>
          </>
        )}
      </div>
      <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} className="mt-3 inline-block text-sm text-primary hover:underline">Open execution page</Link>
      <section className="mt-3 space-y-3 rounded-md border bg-card p-3" aria-label="Execution result">
        {row.source === "Workflow" && workflowFacts(row) && <p className="text-sm">{workflowFacts(row)}</p>}
        {row.started_at && <p className="text-xs text-muted-foreground">Started <Timestamp value={row.started_at} /></p>}
        {details.isPending && <p role="status" className="text-sm">Loading execution details…</p>}
        {details.isError && <QueryErrorState compact error={details.error} title="Execution details unavailable" onRetry={() => void details.refetch()} />}
        {details.data && !details.isError && <>
          <p className="text-xs text-muted-foreground" title={`Execution ID ${details.data.execution_id}`}>{details.data.duration_seconds !== null ? `Took ${details.data.duration_seconds}s` : (['running', 'queued', 'pending', 'cancelling'].includes(row.status) ? 'Still running' : 'Duration not recorded')}</p>
          <p className="break-words text-sm">{details.data.summary}</p>
          <details><summary className="cursor-pointer text-sm font-medium">Execution log</summary>
            {details.data.output_truncated && <p className="text-xs text-muted-foreground">Showing the last 200,000 characters.</p>}
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{details.data.output || 'No output recorded.'}</pre>
          </details>
          {row.action && <p className="text-xs text-muted-foreground">Action identifier: {row.action}</p>}
        </>}
      </section>
      {row.statusTone === "danger" && !row.acknowledged && (
        <Button
          type="button"
          className="mt-3 w-full"
          size="sm"
          variant="secondary"
          disabled={acknowledging}
          onClick={() => onAcknowledge(row.id)}
        >
          <CheckCircle2 />
          {acknowledging ? "Acknowledging…" : "Acknowledge failure"}
        </Button>
      )}
      {row.href && (
        <Button asChild className="mt-3 w-full" size="sm" variant="outline">
          <OperationLink row={row}>
            Open resource
            <ExternalLink />
          </OperationLink>
        </Button>
      )}
    </aside>
  );
}

export function GroupedExecutionLinks({ row }: { row: OperationRow }) {
  const environmentId = useUi(state => state.environmentId);
  if (!row.executions?.length) return null;
  return <details className="mt-2 text-xs" onClick={event => event.stopPropagation()}>
    <summary className="cursor-pointer font-medium">View all {row.executions.length} executions</summary>
    <ul className="mt-2 max-h-60 space-y-2 overflow-auto">{row.executions.map(execution => <li key={execution.id}>
      <Link to="/operations/executions/$id" params={{ id: execution.id }} search={{ environment: environmentId }} className="text-primary hover:underline">
        {execution.time ? <Timestamp value={execution.time} /> : execution.id}
      </Link>
    </li>)}</ul>
  </details>;
}

export function OperationList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: OperationRow[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const environmentId = useUi(state => state.environmentId);
  return (
    <>
      <div className="divide-y md:hidden">
        {rows.map((row) => (
          <div key={row.id} className={selectedId === row.id ? "bg-primary/[0.07]" : "hover:bg-muted/45"}>
            <button
              type="button"
              onClick={() => onSelect(row.id)}
              className="block w-full space-y-2 px-4 py-3 text-left"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="line-clamp-2 break-words font-medium">{row.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {operationSourceLabel(row.source)} · {row.initiator}
                  </div>
                </div>
                <StatusBadge tone={operationDisplayTone(row)} dot>
                  {operationDisplayLabel(row)}
                </StatusBadge>
              </div>
              <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                <span className="truncate">{row.target}</span>
                <span className="whitespace-normal break-words">{row.completed_at ? "Completed" : "Started"}: <Timestamp value={row.time} /></span>
              </div>
            </button>
            <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} onClick={event => event.stopPropagation()} className="mx-4 mb-3 inline-block text-xs text-primary hover:underline" aria-label={`${row.executions?.length ? "Open latest execution" : "Open execution"}: ${row.name}`}>{row.executions?.length ? "Open latest execution" : "Open execution"}</Link>
            <div className="px-4 pb-2"><GroupedExecutionLinks row={row} /></div>
            {row.target_detail && (
              <div className="px-4 pb-3 text-xs">
                <OperationTarget row={row} detailsOnly />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="table-scroll hidden md:block">
        <table data-density="compact" className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr>
              <th className="w-32">Time</th>
              <th>Task</th>
              <th className="w-52">Target</th>
              <th className="w-32">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onSelect(row.id)}
                className={`cursor-pointer ${selectedId === row.id ? "bg-primary/[0.07] shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-muted/45"}`}
                aria-selected={selectedId === row.id}
              >
                <td className="whitespace-nowrap text-xs text-muted-foreground" title={row.completed_at ? "Completed" : "Started"}>
                  <Timestamp value={row.time} />
                </td>
                <td className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                    <button type="button" className="block min-w-0 text-left font-medium leading-snug hover:underline" aria-label={`Show task details: ${row.name}`} onClick={event => { event.stopPropagation(); onSelect(row.id); }}><span className="line-clamp-2 break-words">{row.name}</span></button>
                    <Link to="/operations/executions/$id" params={{ id: row.id }} search={{ environment: environmentId }} onClick={event => event.stopPropagation()} className="shrink-0 rounded-sm text-muted-foreground hover:text-primary" title={row.executions?.length ? "Open latest execution" : "Open execution"} aria-label={`${row.executions?.length ? "Open latest execution" : "Open execution"}: ${row.name}`}><ExternalLink className="h-3.5 w-3.5" /></Link>
                    <span className="text-xs text-muted-foreground">
                      {operationSourceLabel(row.source)} · {row.initiator}
                    </span>
                  </div>
                  <GroupedExecutionLinks row={row} />
                </td>
                <td className="max-w-[13rem] break-words">
                  <OperationTarget row={row} />
                </td>
                <td className="whitespace-nowrap" title={operationDisplayLabel(row)}>
                  <StatusBadge tone={operationDisplayTone(row)} dot>
                    {operationDisplayLabel(row)}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function OperationTarget({
  row,
  align = "left",
  detailsOnly = false,
}: {
  row: OperationRow;
  align?: "left" | "right";
  detailsOnly?: boolean;
}) {
  if (!row.target_detail) return detailsOnly ? null : <span>{row.target}{row.target_deleted && <span className="ml-1 text-xs text-muted-foreground">(deleted host)</span>}</span>;
  return (
    <details
      className={cn("group min-w-0 font-normal", align === "right" && "text-right")}
      onClick={(event) => event.stopPropagation()}
    >
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        {detailsOnly ? "Show target details" : row.target}
      </summary>
      <div className="mt-1 break-all text-[11px] text-muted-foreground">
        Raw target: <code>{row.target_detail}</code>
      </div>
    </details>
  );
}
