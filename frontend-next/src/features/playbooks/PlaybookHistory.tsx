import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, History, X } from "lucide-react";
import { api } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { SkeletonRow } from "@/components/ui/skeleton";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { formatDate as fmtDate } from "./playbook-utils";
import type { HistoryEntry, Schedule } from "./playbook-types";

export function HistoryTab() {
  const { t } = useTranslation();
  const environmentId = useUi((state) => state.environmentId);
  const { data: profile } = useProfile();
  const queryClient = useQueryClient();
  const [filterSchedule, setFilterSchedule] = useState("");
  const [outputEntry, setOutputEntry] = useState<HistoryEntry | null>(null);

  const { data: schedules } = useQuery<Schedule[]>({
    queryKey: ["schedules", environmentId],
    queryFn: () => api.getSchedules(environmentId) as unknown as Promise<Schedule[]>,
  });
  const { data: history, isLoading } = useQuery<HistoryEntry[]>({
    queryKey: ["scheduleHistory", environmentId, filterSchedule],
    queryFn: () =>
      api.getScheduleHistory(
        100,
        filterSchedule || undefined,
        environmentId,
      ) as unknown as Promise<HistoryEntry[]>,
    refetchInterval: (query) => asArray<HistoryEntry>(query.state.data).some((entry) => entry.status === "running") ? 2_000 : false,
  });
  const cancelRun = useMutation({
    mutationFn: (id: string) => api.cancelPlaybookRun(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scheduleHistory", environmentId] }),
    onError: (error: Error) => showToast(error.message, "error"),
  });

  useEffect(() => {
    if (!outputEntry || outputEntry.status !== "running") return;
    const timer = window.setInterval(() => {
      void api.getScheduleHistoryEntry(outputEntry.id).then((entry) => setOutputEntry(entry as unknown as HistoryEntry)).catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [outputEntry?.id, outputEntry?.status]);

  const showOutput = async (id: string) => {
    try {
      const entry = (await api.getScheduleHistoryEntry(
        id,
      )) as unknown as HistoryEntry;
      setOutputEntry(entry);
    } catch (e: unknown) {
      showToast((e as Error).message, "error");
    }
  };

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <History className="h-4 w-4" /> {t("hist.title")}
            </div>
            <select
              className="flex h-8 w-48 rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={filterSchedule}
              onChange={(e) => setFilterSchedule(e.target.value)}
            >
              <option value="">{t("hist.filterAll")}</option>
              {asArray<Schedule>(schedules).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {isLoading ? (
            <div className="space-y-1">
              <SkeletonRow cols={5} />
              <SkeletonRow cols={5} />
              <SkeletonRow cols={5} />
              <SkeletonRow cols={5} />
            </div>
          ) : !history || history.length === 0 ? (
            <EmptyState
              compact
              icon={<History className="h-5 w-5" />}
              title={t("hist.noHistory")}
            />
          ) : (
            <div className="table-scroll">
              <table
                className="w-full min-w-[720px] text-sm"
                data-density="compact"
              >
                <thead>
                  <tr>
                    <th className="px-3">{t("hist.schedule")}</th>
                    <th className="px-3">{t("hist.playbook")}</th>
                    <th className="px-3">{t("hist.targets")}</th>
                    <th className="px-3">{t("hist.started")}</th>
                    <th className="px-3">{t("hist.status")}</th>
                    <th className="w-16 px-3">
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="px-3 font-medium">
                        {h.schedule_id === null ? (
                          <StatusBadge tone="muted">
                            {h.schedule_name}
                          </StatusBadge>
                        ) : (
                          h.schedule_name
                        )}
                      </td>
                      <td className="px-3 font-mono text-xs">{h.playbook}</td>
                      <td className="px-3 text-xs">{h.targets || "all"}</td>
                      <td className="px-3 text-xs text-muted-foreground">
                        {fmtDate(h.started_at)}
                      </td>
                      <td className="px-3">
                        <StatusBadge
                          tone={
                            h.status === "success"
                              ? "success"
                              : h.status === "running"
                                ? "info"
                                : h.status === "cancelled"
                                  ? "muted"
                                : "danger"
                          }
                        >
                          {h.status === "success"
                            ? t("hist.success")
                            : h.status === "running"
                              ? t("hist.running")
                              : h.status === "cancelled"
                                ? "Cancelled"
                              : t("hist.failed")}
                        </StatusBadge>
                      </td>
                      <td className="px-3 text-right">
                        <div className="flex justify-end gap-1">
                          {h.status === "running" && hasCap(profile, "canRunPlaybooks") && (
                            <Button variant="destructive" size="icon" className="h-7 w-7" onClick={() => cancelRun.mutate(h.id)} title="Cancel run" disabled={cancelRun.isPending}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => showOutput(h.id)} title={t("hist.output")}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Output modal */}
      <Dialog
        open={!!outputEntry}
        onOpenChange={(open) => {
          if (!open) setOutputEntry(null);
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-[min(900px,calc(100vw-2rem))] grid-rows-none flex-col overflow-hidden">
          <DialogHeader className="min-w-0">
            <DialogTitle>
              {outputEntry?.schedule_name} — {outputEntry?.playbook}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 min-w-0 overflow-hidden rounded-md border bg-muted/30">
            <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {fmtDate(outputEntry?.started_at)}
            </div>
            <div className="max-h-[55vh] overflow-y-auto overflow-x-hidden break-words p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {outputEntry?.output || t("qr.noOutput")}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOutputEntry(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Playbook History Dialog
// ═════════════════════════════════════════════════════════════════════════════
