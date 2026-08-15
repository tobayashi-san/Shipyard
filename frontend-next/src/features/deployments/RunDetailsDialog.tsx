import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, FileOutput, RefreshCw, Square } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";

interface RunDetails {
  id: string;
  action?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
  output?: string;
  plan_summary?: string | { create?: number; update?: number; delete?: number; replace?: number } | null;
}

function tone(status?: string): StatusTone {
  if (status === "success" || status === "completed") return "success";
  if (status === "failed" || status === "error" || status === "interrupted") return "danger";
  if (status === "running" || status === "queued" || status === "cancelling") return "info";
  return "muted";
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date);
}

export function RunDetailsDialog({
  workspaceId,
  runId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  runId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["opentofu", "workspace", workspaceId, "run", runId],
    queryFn: () =>
      apiFetch<RunDetails>(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId || "")}`,
      ),
    enabled: open && Boolean(runId),
    refetchInterval: (query) =>
      ["running", "queued"].includes(String(query.state.data?.status || ""))
        ? 2_000
        : false,
  });
  const run = runQuery.data;
  const summary = (() => {
    if (!run?.plan_summary) return null;
    if (typeof run.plan_summary === "object") return run.plan_summary;
    try { return JSON.parse(run.plan_summary) as { create?: number; update?: number; delete?: number; replace?: number }; } catch { return null; }
  })();
  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch(
        `/opentofu/workspaces/${encodeURIComponent(workspaceId)}/cancel/${encodeURIComponent(runId || "")}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      showToast(
        "Cancellation requested. The run will stop safely.",
        "success",
      );
      void runQuery.refetch();
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "workspace", workspaceId, "runs"],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(run?.output || "");
      showToast("Output copied.", "success");
    } catch {
      showToast("Output could not be copied.", "error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <FileOutput className="h-5 w-5" />
            {run?.action || "OpenTofu run"}
            {run && (
              <StatusBadge tone={tone(run.status)} dot>
                {run.status || "—"}
              </StatusBadge>
            )}
          </DialogTitle>
          <DialogDescription>
            {run
              ? `Started: ${formatDate(run.started_at)}${run.completed_at ? ` · Completed: ${formatDate(run.completed_at)}` : ""}`
              : "Loading run…"}
          </DialogDescription>
        </DialogHeader>
        {summary && (
          <div className="grid grid-cols-4 gap-2 rounded-md border bg-muted/20 p-3 text-center text-xs">
            <div><strong className="block text-base">{summary.create || 0}</strong>Create</div>
            <div><strong className="block text-base">{summary.update || 0}</strong>Update</div>
            <div><strong className="block text-base">{summary.delete || 0}</strong>Delete</div>
            <div><strong className="block text-base">{summary.replace || 0}</strong>Replace</div>
          </div>
        )}
        <div className="min-h-48 flex-1 overflow-auto rounded-md border bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-100 dark:bg-zinc-950 dark:text-zinc-100">
          {runQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-zinc-400">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading run…
            </div>
          ) : runQuery.isError ? (
            <p className="text-red-300">
              Run details could not be loaded.
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words">
              {run?.output ||
                (run?.status === "running"
                  ? "Waiting for output…"
                  : "No output available.")}
            </pre>
          )}
        </div>
        <DialogFooter>
          {["running", "cancelling"].includes(String(run?.status || "")) && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending || run?.status === "cancelling"}
            >
              <Square />
              Cancel run
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => void runQuery.refetch()}
            disabled={runQuery.isFetching}
          >
            <RefreshCw
              className={runQuery.isFetching ? "animate-spin" : undefined}
            />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyOutput()}
            disabled={!run?.output}
          >
            <Clipboard />
            Copy output
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            <Check />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
