import { describePlaybookTargets } from "../playbook-utils";

export function PlaybookTargetSummary({ targets }: { targets?: string }) {
  const summary = describePlaybookTargets(targets || "all");
  if (!summary.hasDetails) return <span>{summary.label}</span>;
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        {summary.label}
      </summary>
      <div className="mt-1 max-w-72 break-all text-[11px] text-muted-foreground">
        Raw target: <code>{summary.raw}</code>
      </div>
    </details>
  );
}
