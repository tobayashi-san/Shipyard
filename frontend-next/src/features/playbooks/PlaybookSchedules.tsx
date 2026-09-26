import { useLocation } from '@tanstack/react-router';
import { statusLabel } from '@/lib/history-labels';
import { scheduleNameMismatch } from './schedule-name';
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Clock, Plus, Settings2, Trash2 } from "lucide-react";
import { filterTargetHosts, scheduleTargetPreview } from "./target-hosts";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { api, apiFetch } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { SkeletonRow } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowItem, OverflowMenu } from "@/components/ui/overflow-menu";
import { Separator } from "@/components/ui/separator";
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import {
  buildAllExceptTargets,
  cronToSelectors,
  formatDate as fmtDate,
  INTERVALS,
  isPresetCron,
  parsePlaybookTargets,
  selectorsToCron,
  WEEKDAYS,
} from "./playbook-utils";
import type { Playbook, Schedule } from "./playbook-types";
import { PlaybookTargetSummary } from "./components/PlaybookTargetSummary";

export function useCronLabel() {
  const { t } = useTranslation();
  return useCallback(
    (cron: string) => {
      if (!isPresetCron(cron)) return cron;
      const { interval, hour, minute, weekday, monthday } =
        cronToSelectors(cron);
      const iv = INTERVALS.find((i) => i.value === interval);
      if (!iv) return cron;
      const lbl = t(iv.labelKey);
      if (!iv.needsTime) return lbl;
      const ts = `${String(hour).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
      if (interval === "weekly") {
        const wd2 = WEEKDAYS.find((w2) => w2.value === weekday);
        return `${lbl} (${wd2 ? t(wd2.labelKey) : weekday}), ${ts}`;
      }
      if (interval === "monthly") return `${lbl} (${monthday}.), ${ts}`;
      return `${lbl}, ${ts}`;
    },
    [t],
  );
}

export function SchedulesTab() {
  const location = useLocation();
  const highlightedSchedule = new URLSearchParams(location.hash.replace(/^#/, '')).get('schedule');
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const environmentId = useUi((state) => state.environmentId);
  const cronLabel = useCronLabel();
  const schedulesQuery = useQuery<Schedule[]>({
    queryKey: ["schedules", environmentId],
    queryFn: () => api.getSchedules(environmentId) as unknown as Promise<Schedule[]>,
  });
  const schedules = schedulesQuery.data;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [draftState, setDraftState] = useState({dirty:false,busy:false});
  useUnsavedChanges(dialogOpen && (draftState.dirty || draftState.busy));
  const changeDialogOpen = (open: boolean) => {
    if (!open && draftState.busy) return;
    if (!open && draftState.dirty) { setDiscardOpen(true); return; }
    setDialogOpen(open);
    if (!open) setDraftState({dirty:false,busy:false});
  };
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteSchedule, setDeleteSchedule] = useState<Schedule | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const registrationMut = useMutation({
    mutationFn: ({id, environment}: {id:string; environment:string}) => apiFetch(`/schedules/${encodeURIComponent(id)}/retry-registration`, {method:'POST',environmentId:environment}),
    onSuccess: (_data, variables) => qc.invalidateQueries({queryKey:['schedules',variables.environment]}),
    onError: (error: Error) => showToast(error.message,'error'),
  });

  const toggleMut = useMutation({
    mutationFn: (id: string) => api.toggleSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules", environmentId] }),
    onError: (e: Error) => showToast(e.message, "error"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      showToast(t("sc.deleted"), "success");
      setDeleteSchedule(null);
      qc.invalidateQueries({ queryKey: ["schedules", environmentId] });
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  const bulkMut = useMutation({
    mutationFn: async ({
      action,
      ids,
    }: {
      action: "enable" | "disable" | "delete";
      ids: string[];
    }) => {
      if (action === "delete") {
        await Promise.all(ids.map((id) => api.deleteSchedule(id)));
        return;
      }
      const enabled = action === "enable";
      await Promise.all(
        ids.map(async (id) => {
          const schedule = asArray<Schedule>(schedules).find(
            (item) => item.id === id,
          );
          if (schedule && schedule.enabled !== enabled)
            await api.toggleSchedule(id);
        }),
      );
    },
    onSuccess: (_, variables) => {
      showToast(
        variables.action === "delete"
          ? "Workflows deleted"
          : variables.action === "enable"
            ? "Workflows enabled"
            : "Workflows paused",
        "success",
      );
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      qc.invalidateQueries({ queryKey: ["schedules", environmentId] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  const openNew = () => {
    setEditId(null);
    setDialogOpen(true);
  };
  const openEdit = (id: string) => {
    setEditId(id);
    setDialogOpen(true);
  };
  const list = asArray<Schedule>(schedules);
  useEffect(() => {
    if (highlightedSchedule && schedules) document.getElementById(`schedule-${highlightedSchedule}`)?.scrollIntoView({block:'center'});
  }, [highlightedSchedule, schedules]);
  const selected = list.filter((schedule) => selectedIds.has(schedule.id));
  const toggleSelected = (id: string) =>
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds((previous) =>
      previous.size === list.length
        ? new Set()
        : new Set(list.map((schedule) => schedule.id)),
    );

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Clock className="h-4 w-4" /> {t("pb.schedules")}
            </div>
            {hasCap(profile, "canAddSchedules") && (
              <Button size="sm" onClick={openNew}>
                <Plus className="h-4 w-4" /> {t("pb.newSchedule")}
              </Button>
            )}
          </div>
          {schedulesQuery.isLoading ? (
            <div className="space-y-1">
              <SkeletonRow cols={3} />
              <SkeletonRow cols={3} />
              <SkeletonRow cols={3} />
            </div>
          ) : schedulesQuery.isError ? (
            <QueryErrorState
              compact
              error={schedulesQuery.error}
              title="Scheduled workflows could not be loaded"
              onRetry={() => void schedulesQuery.refetch()}
            />
          ) : list.length === 0 ? (
            <EmptyState
              compact
              icon={<Calendar className="h-5 w-5" />}
              title={t("sc.noSchedules")}
            />
          ) : (
            <>
              {selected.length > 0 && (
                <div
                  className="console-action-strip mb-3"
                  aria-label="Manage selected workflows"
                >
                  <span className="font-medium text-foreground">
                    {selected.length} selected
                  </span>
                  {hasCap(profile, "canToggleSchedules") && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          bulkMut.mutate({
                            action: "enable",
                            ids: selected.map((schedule) => schedule.id),
                          })
                        }
                        disabled={bulkMut.isPending}
                      >
                        Enable
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          bulkMut.mutate({
                            action: "disable",
                            ids: selected.map((schedule) => schedule.id),
                          })
                        }
                        disabled={bulkMut.isPending}
                      >
                        Pause
                      </Button>
                    </>
                  )}
                  {hasCap(profile, "canDeleteSchedules") && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="sm:ml-auto"
                      onClick={() => setBulkDeleteOpen(true)}
                      disabled={bulkMut.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              )}
              <div className="table-scroll rounded-md border">
                <table
                  className="w-full min-w-[760px] text-sm"
                  data-density="compact"
                >
                  <thead>
                    <tr>
                      <th className="w-10 px-3">
                        <input
                          aria-label="Select all workflows"
                          type="checkbox"
                          checked={
                            list.length > 0 && selectedIds.size === list.length
                          }
                          onChange={toggleAll}
                        />
                      </th>
                      <th className="px-3">Workflow</th>
                      <th className="px-3">Playbook</th>
                      <th className="px-3">Targets</th>
                      <th className="px-3">Schedule</th>
                      <th className="px-3">Last run</th>
                      <th className="w-24 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr
                        key={s.id}
                        id={`schedule-${s.id}`}
                        aria-current={highlightedSchedule === s.id ? "true" : undefined}
                        className={
                          selectedIds.has(s.id) || highlightedSchedule === s.id ? "bg-accent/45" : undefined
                        }
                      >
                        <td className="px-3">
                          <input
                            aria-label={`Select ${s.name}`}
                            type="checkbox"
                            checked={selectedIds.has(s.id)}
                            onChange={() => toggleSelected(s.id)}
                          />
                        </td>
                        <td className="px-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{s.name}</span>
                            {hasCap(profile, "canToggleSchedules") && (
                              <Switch
                                aria-label={`Toggle ${s.name}`}
                                checked={s.enabled}
                                onCheckedChange={() => toggleMut.mutate(s.id)}
                              />
                            )}
                          </div>
                        </td>
                        <td className="px-3 font-mono text-xs">{s.playbook}</td>
                        <td className="px-3 text-xs text-muted-foreground">
                          <PlaybookTargetSummary targets={s.targets} />
                        </td>
                        <td className="px-3 text-xs">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            {cronLabel(s.cron_expression)}
                            {scheduleNameMismatch(s.name, s.cron_expression) && <p className="mt-1 text-xs text-warning">{scheduleNameMismatch(s.name, s.cron_expression)}</p>}
                          </span>
                          {Boolean(s.enabled) && s.registration_status === 'unregistered' && <div className="my-1 space-y-1">
                            <p role="alert" className="text-warning">Saved but not registered · will not run automatically.</p>
                            {hasCap(profile,'canToggleSchedules') && <Button size="sm" variant="outline" disabled={registrationMut.isPending} onClick={() => registrationMut.mutate({id:s.id,environment:environmentId})}>{registrationMut.isPending && registrationMut.variables?.id === s.id ? 'Retrying…' : 'Retry registration'}</Button>}
                            {registrationMut.isError && registrationMut.variables?.id === s.id && registrationMut.variables.environment === environmentId && <p role="alert" className="text-destructive">{registrationMut.error.message}</p>}
                          </div>}
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {Boolean(s.enabled) && s.next_run ? `Next ${fmtDate(s.next_run)}` : s.enabled ? (s.registration_status === "unregistered" ? "No automatic start registered" : "Next run pending") : "Paused"} · {s.timezone || "server timezone"}
                          </span>
                        </td>
                        <td className="px-3 text-xs">
                          {s.last_run ? (
                            <span className="inline-flex items-center gap-1.5">
                              <StatusBadge
                                tone={
                                  s.last_status === "success"
                                    ? "success"
                                    : "danger"
                                }
                              >
                                {statusLabel(t, s.last_status)}
                              </StatusBadge>
                              <span className="text-muted-foreground">
                                {fmtDate(s.last_run)}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3">
                          <div className="flex justify-end">
                            {(hasCap(profile, "canEditSchedules") || hasCap(profile, "canDeleteSchedules")) && (
                            <OverflowMenu title={`Actions for ${s.name}`}>
                              {hasCap(profile, "canEditSchedules") && (
                                <OverflowItem icon={Settings2} onClick={() => openEdit(s.id)}>
                                  Edit workflow
                                </OverflowItem>
                              )}
                              {hasCap(profile, "canDeleteSchedules") && (
                                <OverflowItem icon={Trash2} danger onClick={() => setDeleteSchedule(s)}>
                                  Delete workflow
                                </OverflowItem>
                              )}
                            </OverflowMenu>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={changeDialogOpen}>
        {dialogOpen && <ScheduleDialog
          editId={editId}
        schedules={asArray<Schedule>(schedules)}
        environmentId={environmentId}
          onDraftStateChange={setDraftState}
          onSaved={() => {
            setDraftState({dirty:false,busy:false});
            setDialogOpen(false);
            qc.invalidateQueries({ queryKey: ["schedules"] });
          }}
        />}
      </Dialog>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard schedule changes?"
        description="Your unsaved changes will be lost. The saved schedule will remain unchanged."
        confirmLabel="Discard changes"
        variant="destructive"
        onConfirm={() => {
          setDiscardOpen(false);
          setDialogOpen(false);
          setDraftState({dirty:false,busy:false});
        }}
      />
      <ConfirmDialog
        open={!!deleteSchedule}
        onOpenChange={(open) => {
          if (!open) setDeleteSchedule(null);
        }}
        title={t("common.delete")}
        description={t("sc.confirmDelete")}
        confirmLabel={t("common.delete")}
        variant="destructive"
        confirmTextValue={deleteSchedule?.name ?? ""}
        confirmInputLabel="Confirm schedule name"
        onConfirm={() => {
          if (deleteSchedule) delMut.mutate(deleteSchedule.id);
        }}
        isPending={delMut.isPending}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete selected workflows"
        description={`${selected.length} scheduled workflows will be permanently deleted.`}
        confirmLabel="Delete workflows"
        variant="destructive"
        confirmTextValue={String(selected.length)}
        confirmInputLabel="Enter the number of selected workflows"
        onConfirm={() =>
          bulkMut.mutate({
            action: "delete",
            ids: selected.map((schedule) => schedule.id),
          })
        }
        isPending={bulkMut.isPending}
      />
    </>
  );
}

// ── Schedule Dialog ──────────────────────────────────────────────────────────

export function ScheduleDialog({
  initialDraft,
  editId,
  schedules,
  environmentId,
  onSaved,
  onDraftStateChange,
}: {
  initialDraft?: { playbook: string; targets: string; extra_vars?: Record<string, unknown>; check_mode?: boolean; forks?: number };
  editId: string | null;
  schedules: Schedule[];
  environmentId: string;
  onSaved: () => void;
  onDraftStateChange?: (state: {dirty:boolean;busy:boolean}) => void;
}) {
  const { t } = useTranslation();
  const existing = editId ? schedules.find((s) => s.id === editId) : null;
  const playbooksQuery = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]>,
  });
  const servers = useQuery<Record<string, unknown>[]>({
    queryKey: ["servers", environmentId],
    queryFn: () =>
      api.getServers(environmentId) as unknown as Promise<Record<string, unknown>[]>,
  });
  const srvList = asArray<Record<string, unknown>>(servers.data);
  const userPbs = asArray<Playbook>(playbooksQuery.data).filter((p) => !p.isInternal);

  const parsed = existing
    ? cronToSelectors(existing.cron_expression)
    : { interval: "daily", hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const parsedTargets = existing || initialDraft
    ? parsePlaybookTargets(existing?.targets ?? initialDraft?.targets ?? "")
    : { mode: "explicit" as const, included: [] as string[], excluded: [] as string[] };

  const [formEnvironment] = useState(environmentId);
  const [name, setName] = useState(existing?.name ?? initialDraft?.playbook.replace(/\.ya?ml$/, "") ?? "");
  const [playbook, setPlaybook] = useState(existing?.playbook ?? initialDraft?.playbook ?? "");
  const [allChecked, setAllChecked] = useState(parsedTargets.mode === "all");
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (parsedTargets.mode === "all") return new Set(parsedTargets.excluded);
    return new Set(parsedTargets.included);
  });
  const [interval, setInterval2] = useState(parsed.interval);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [weekday, setWeekday] = useState(parsed.weekday);
  const [monthday, setMonthday] = useState(parsed.monthday);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [extraVars, setExtraVars] = useState(() => JSON.stringify(existing?.extra_vars || initialDraft?.extra_vars || {}, null, 2));
  const [checkMode, setCheckMode] = useState(Boolean(existing?.check_mode ?? initialDraft?.check_mode));
  const [forks, setForks] = useState(existing?.forks || initialDraft?.forks || 5);
  const [hostSearch, setHostSearch] = useState("");
  const [hostStatus, setHostStatus] = useState("");
  const [allConfirmed, setAllConfirmed] = useState(false);
  const [customCronMode, setCustomCronMode] = useState(Boolean(existing && !isPresetCron(existing.cron_expression)));
  const [customCron, setCustomCron] = useState(existing?.cron_expression || "0 3 * * *");
  const effectiveCron = customCronMode ? customCron.trim() : selectorsToCron(interval, hour, minute, weekday, Math.min(28, Math.max(1, monthday)));
  const [previewCron, setPreviewCron] = useState(effectiveCron);
  useEffect(() => { const timer = setTimeout(() => setPreviewCron(effectiveCron), 300); return () => clearTimeout(timer); }, [effectiveCron]);
  const preview = useQuery({ queryKey: ['schedule-preview', previewCron], queryFn: () => apiFetch<{ timezone: string; runs: string[]; computedAt: string }>(`/schedules/preview?expression=${encodeURIComponent(previewCron)}`), retry: false, staleTime: 30_000, refetchInterval: 60_000 });


  // The parent mounts one dialog per editing session. Polling must not replace its draft.
  const draft = JSON.stringify({name,playbook,allChecked,checked:[...checked].sort(),interval,hour,minute,weekday,monthday,extraVars,checkMode,forks,customCronMode,customCron});
  const baseline = useRef(draft);
  const dirty = draft !== baseline.current;
  useEffect(() => { onDraftStateChange?.({dirty,busy}); }, [dirty,busy,onDraftStateChange]);

  const referenceError = playbooksQuery.error || servers.error;
  if (referenceError) {
    return (
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing ? t("sc.editTitle") : t("sc.newTitle")}
          </DialogTitle>
        </DialogHeader>
        <QueryErrorState
          compact
          error={referenceError}
          title="Workflow references could not be loaded"
          onRetry={() => void Promise.all([playbooksQuery.refetch(), servers.refetch()])}
        />
      </DialogContent>
    );
  }

  const iv = INTERVALS.find((i) => i.value === interval);

  const visibleHosts = filterTargetHosts(srvList, {search:hostSearch,status:hostStatus});
  const targetPreview = scheduleTargetPreview(srvList, checked, allChecked);

  const toggleSrv = (nm: string) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(nm)) n.delete(nm);
      else n.add(nm);
      return n;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    if (formEnvironment !== environmentId) {
      setSaveError('Switch back to the draft environment before saving this schedule.');
      return;
    }
    if (!name.trim() || !playbook) {
      showToast(t("sc.required"), "error");
      return;
    }
    const targets = allChecked
      ? buildAllExceptTargets(
          [...checked].filter((v) => v !== "all" && v !== "localhost"),
        )
      : [...checked].filter((v) => v !== "all").join(",");
    if (!targets) {
      showToast("Select at least one target. All hosts must be selected explicitly.", "error");
      return;
    }
    if (allChecked && !allConfirmed) {
      showToast("Confirm the all-host target before saving this schedule.", "error");
      return;
    }
    if (!Number.isInteger(forks) || forks < 1 || forks > 50) {
      setSaveError("Parallel hosts must be an integer from 1 to 50.");
      return;
    }
    let parsedExtraVars: Record<string, unknown> = {};
    if (extraVars.trim()) {
      try {
        parsedExtraVars = JSON.parse(extraVars);
        if (!parsedExtraVars || Array.isArray(parsedExtraVars) || typeof parsedExtraVars !== "object" || JSON.stringify(parsedExtraVars).length > 4096 || !Object.values(parsedExtraVars).every(item => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))) throw new Error();
      } catch {
        setSaveError("Extra variables must be a flat JSON object with text, finite numbers or Boolean values (maximum 4,096 characters).");
        return;
      }
    }
    const md = Math.min(28, Math.max(1, monthday));
    const cronExpression = customCronMode
      ? customCron.trim()
      : selectorsToCron(interval, hour, minute, weekday, md);
    if (!/^(\S+\s+){4}\S+$/.test(cronExpression)) {
      showToast("Cron expression must contain exactly five fields.", "error");
      return;
    }
    setBusy(true);
    try {
      if (existing) {
        await api.updateSchedule(existing.id, {
          name,
          playbook,
          targets,
          cronExpression,
          extraVars: parsedExtraVars,
          checkMode,
          forks,
        });
        showToast(t("sc.updated"), "success");
      } else {
        await api.createSchedule({ name, playbook, targets, cronExpression, extraVars: parsedExtraVars, checkMode, forks, environment_id: environmentId });
        showToast(t("sc.created"), "success");
      }
      onSaved();
    } catch (err: unknown) {
      setSaveError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-5xl max-h-[90dvh] overflow-hidden p-0 sm:p-0">
      <form onSubmit={submit} className="flex min-h-0 max-h-[90dvh] flex-col">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <DialogTitle>
            {existing ? t("sc.editTitle") : t("sc.newTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 gap-6 overflow-y-auto p-5 md:grid-cols-2">
          <section className="min-w-0 space-y-3" aria-label="Workflow and targets">
          <h3 className="text-sm font-semibold">Workflow and targets</h3>
          <div className="space-y-1">
            <Label htmlFor="schedule-name">{t("sc.name")}</Label>
            <Input
              id="schedule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("sc.namePlaceholder")}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="schedule-playbook">{t("sc.playbook")}</Label>
            <select
              id="schedule-playbook"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={playbook}
              onChange={(e) => setPlaybook(e.target.value)}
              required
            >
              <option value="">{t("sc.selectPlaybook")}</option>
              {userPbs.map((p) => (
                <option key={p.filename} value={p.filename}>
                  {p.description
                    ? `${p.description} (${p.filename})`
                    : p.filename}
                </option>
              ))}
            </select>
          </div>

          {/* Target servers */}
          <div className="space-y-1">
            <Label>{t("sc.target")}</Label>
            <p className="text-xs text-muted-foreground">
              {allChecked ? t("run.excludeHint") : t("run.includeHint")}
            </p>
            <div className="flex gap-2"><Input aria-label="Search schedule targets" placeholder="Search name, IP or tag" value={hostSearch} onChange={event=>setHostSearch(event.target.value)} /><select aria-label="Target status" className="rounded-md border bg-background px-2 text-xs" value={hostStatus} onChange={event=>setHostStatus(event.target.value)}><option value="">All statuses</option><option value="online">Online</option><option value="offline">Offline</option><option value="unknown">Unknown</option></select></div>
            <p className="text-xs text-muted-foreground">{visibleHosts.length} of {srvList.length} hosts shown. Filtering does not change the selection.</p>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => {
                    setAllChecked(e.target.checked);
                    setAllConfirmed(false);
                    setChecked(new Set());
                  }}
                />
                {t("pb.allServers")}
              </label>
              <Separator />
              {visibleHosts.map((s) => {
                const nm = String(s.name);
                const isExcluded = allChecked && checked.has(nm);
                return (
                  <label
                    key={nm}
                    className={`flex items-start gap-2 text-sm rounded px-1 py-0.5 transition-colors ${allChecked && nm === "localhost" ? "opacity-40" : ""} ${isExcluded ? "bg-destructive/10 text-destructive" : ""}`}
                  >
                    <input
                      type="checkbox"
                      disabled={allChecked && nm === "localhost"}
                      checked={checked.has(nm)}
                      onChange={() => toggleSrv(nm)}
                      className={isExcluded ? "accent-destructive" : ""}
                    />
                    <span className="min-w-0 flex-1"><span className="block">{nm}</span><span className="block text-xs text-muted-foreground">{String(s.ip_address || "No IP")} · {String(s.status || "unknown")}</span></span>
                    {isExcluded && (
                      <span className="text-xs font-medium text-destructive">
                        {t("run.excluded")}
                      </span>
                    )}
                  </label>
                );
              })}
              <label
                className={`flex items-start gap-2 text-sm rounded px-1 py-0.5 transition-colors ${allChecked && checked.has("localhost") ? "bg-destructive/10 text-destructive" : allChecked ? "opacity-40" : ""}`}
              >
                <input
                  type="checkbox"
                  disabled={allChecked}
                  checked={checked.has("localhost")}
                  onChange={() => toggleSrv("localhost")}
                />
                <span>localhost <span className="block text-xs text-muted-foreground">Runs inside the Fleet runtime, not on a remote host.</span></span>
                {allChecked && checked.has("localhost") && (
                  <span className="text-xs font-medium text-destructive">
                    {t("run.excluded")}
                  </span>
                )}
              </label>
            </div>
            <div className="rounded-md border bg-muted/20 p-3 text-xs"><p className="font-medium">Current target preview · {targetPreview.targets.length} {targetPreview.targets.length === 1 ? 'target' : 'targets'}</p><p className="mt-1 break-words">{targetPreview.targets.slice(0,8).join(', ') || 'No targets selected'}{targetPreview.targets.length>8?` · +${targetPreview.targets.length-8} more`:''}</p>{targetPreview.targets.length>8&&<details><summary className="cursor-pointer">Show all targets</summary><p className="max-h-24 overflow-auto break-words">{targetPreview.targets.join(', ')}</p></details>}{allChecked&&<p className="mt-1 text-muted-foreground">Dynamic scope: future hosts in this environment are included unless excluded.</p>}{targetPreview.unavailable.length>0&&<p role="alert" className="mt-1 text-warning">Saved {allChecked?'exclusions':'targets'} not found in this inventory: {targetPreview.unavailable.join(', ')}. Check renamed, removed or restricted hosts before saving.</p>}</div>
            {targetPreview.unavailable.length > 0 && <Button type="button" variant="outline" size="sm" onClick={() => setChecked(previous => new Set([...previous].filter(value => !targetPreview.unavailable.includes(value))))}>Remove unavailable {allChecked ? 'exclusions' : 'targets'} from this draft</Button>}
            {allChecked && (
              <label className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                <input type="checkbox" className="mt-0.5" checked={allConfirmed} onChange={(event) => setAllConfirmed(event.target.checked)} />
                <span><span className="block font-medium">Run on every host in this environment</span><span className="text-xs text-muted-foreground">New hosts added later will also be included unless explicitly excluded.</span></span>
              </label>
            )}
          </div>

          </section>
          <section className="min-w-0 space-y-3 md:border-l md:pl-6" aria-label="Timing and execution preview">
          <h3 className="text-sm font-semibold">Timing and execution preview</h3>
          {/* Interval + time */}
          <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <span><span className="block font-medium">Custom cron expression</span><span className="text-xs text-muted-foreground">Use ranges, lists and steps for schedules not covered by presets.</span></span>
            <Switch aria-label="Custom cron expression" checked={customCronMode} onCheckedChange={(checked) => {
              setCustomCronMode(checked);
              if (checked && !customCron.trim()) setCustomCron(selectorsToCron(interval, hour, minute, weekday, monthday));
            }} />
          </label>
          {customCronMode && (
            <div className="space-y-1">
              <Label htmlFor="schedule-custom-cron">Cron expression</Label>
              <Input id="schedule-custom-cron" className="font-mono" value={customCron} onChange={(event) => setCustomCron(event.target.value)} placeholder="0 2 * * 1-5" />
              <p className="text-xs text-muted-foreground">Five fields: minute, hour, day of month, month, weekday. Example: 0 2 * * 1-5.</p>
            </div>
          )}
          {!customCronMode && <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("sc.interval")}</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                aria-label="Schedule interval"
                value={interval}
                onChange={(e) => setInterval2(e.target.value)}
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {t(i.labelKey)}
                  </option>
                ))}
              </select>
            </div>
            {iv?.needsTime && (
              <div className="space-y-1">
                <Label>{t("sc.time")}</Label>
                <div className="flex items-center gap-1">
                  <select
                    className="flex h-9 w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    aria-label="Schedule hour"
                    value={hour}
                    onChange={(e) => setHour(+e.target.value)}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground">:</span>
                  <select
                    className="flex h-9 w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    aria-label="Schedule minute"
                    value={minute}
                    onChange={(e) => setMinute(+e.target.value)}
                  >
                    {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                      <option key={m} value={m}>
                        {String(m).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>}
          {!customCronMode && iv?.needsWeekday && (
            <div className="space-y-1">
              <Label>{t("sc.weekday")}</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                aria-label="Schedule weekday"
                value={weekday}
                onChange={(e) => setWeekday(+e.target.value)}
              >
                {WEEKDAYS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {t(w.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!customCronMode && iv?.needsMonthday && (
            <div className="space-y-1">
              <Label>{t("sc.dayOfMonth")}</Label>
              <Input
                type="number"
                min={1}
                max={28}
                value={monthday}
                onChange={(e) => setMonthday(+e.target.value)}
                placeholder="1–28"
              />
            </div>
          )}
          <section className="rounded-md border bg-muted/20 p-3 text-xs" aria-label="Next executions">
            <p className="font-medium">Next three executions</p>
            <p className="my-1 font-mono">{effectiveCron}</p>
            {scheduleNameMismatch(name, effectiveCron) && <p role="status" className="text-warning">{scheduleNameMismatch(name, effectiveCron)}</p>}
            {previewCron !== effectiveCron || preview.isFetching ? <p>Calculating…</p> : preview.isError ? <p role="alert" className="text-destructive">{preview.error.message}</p> : preview.data && <><p>Scheduler timezone: {preview.data.timezone}</p><ol className="my-2 list-decimal pl-5">{preview.data.runs.map(run=><li key={run}>{new Intl.DateTimeFormat('en-GB', {timeZone:preview.data.timezone,dateStyle:'medium',timeStyle:'long'}).format(new Date(run))}</li>)}</ol><p className="text-muted-foreground">If a run is still active, the next one is skipped. Failed runs are not retried.</p></>}
          </section>
          <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Variables and execution options</summary><div className="mt-3 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="schedule-extra-vars">Extra variables <span className="font-normal text-muted-foreground">(optional JSON)</span></Label>
            <textarea id="schedule-extra-vars" className="min-h-20 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs" value={extraVars} onChange={(event) => setExtraVars(event.target.value)} />
            <p className="text-xs text-muted-foreground">Stored encrypted with the schedule. Environment variables and secrets are merged automatically.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span><span className="block font-medium">Dry run</span><span className="text-xs text-muted-foreground">Use check mode and show diffs</span></span>
              <Switch aria-label="Dry run" checked={checkMode} onCheckedChange={setCheckMode} />
            </label>
            <div className="space-y-1">
              <Label htmlFor="schedule-forks">Parallel hosts</Label>
              <Input id="schedule-forks" aria-invalid={!Number.isInteger(forks) || forks < 1 || forks > 50} aria-describedby="schedule-forks-help" onInvalid={() => setSaveError("Parallel hosts must be an integer from 1 to 50.")} type="number" min={1} max={50} step={1} value={Number.isNaN(forks) ? '' : forks} onChange={(event) => setForks(event.target.valueAsNumber)} />
              <p id="schedule-forks-help" className="text-xs text-muted-foreground">Enter a whole number from 1 to 50. Set to 1 for serial execution.</p>
            </div>
          </div>

          </div></details>
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t px-5 py-3 sm:items-center">
          {formEnvironment !== environmentId && <p role="alert" className="mr-auto text-sm text-warning">Switch back to the draft environment to save.</p>}
          {dirty && !saveError && formEnvironment === environmentId && <p className="mr-auto text-xs text-muted-foreground">Unsaved changes</p>}
          {saveError && <p role="alert" className="mr-auto text-sm text-destructive">{saveError}</p>}
          <Button type="submit" disabled={busy || formEnvironment !== environmentId}>
            {existing ? t("common.save") : t("common.create")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: History
// ═════════════════════════════════════════════════════════════════════════════
