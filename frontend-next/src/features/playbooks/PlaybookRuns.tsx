import { ScheduleDialog } from './PlaybookSchedules';
import { completionStatus } from '@/lib/execution-status';
import { statusLabel } from '@/lib/history-labels';
import { getRunStart, subscribeRunStart, trackRunStart, clearRunStart } from './run-start-tracker';
import { activeRunKey } from './active-run-key';
import { CancelRunDialog, type CancelRunTarget } from './components/CancelRunDialog';
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { History, Play, Plus, Search, Terminal, X } from "lucide-react";
import { api } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { ws } from "@/lib/ws";
import { filterTargetHosts } from "./target-hosts";
import { buildAllExceptTargets } from "./playbook-utils";
import { parseRunVariableDrafts, type RunVariableDraft, type RunVariableType } from "./run-extra-vars";
import type { AnsibleVar, HistoryEntry, Playbook } from "./playbook-types";
import { HistoryTab } from "./PlaybookHistory";

export function RunsTab({ initialPlaybook }: { initialPlaybook?: string }) {
  const { data: profile } = useProfile();
  const canRun = hasCap(profile, "canRunPlaybooks") || hasCap(profile, "canAddSchedules");
  const canViewRuns = hasCap(profile, "canViewSchedules");
  return (
    <div className="space-y-4">
      {canRun && <QuickRunTab initialPlaybook={initialPlaybook} />}

      {!canRun && !canViewRuns && (
        <EmptyState icon={<History className="h-5 w-5" />} title="Run access is not enabled for your role" />
      )}
    </div>
  );
}

export function QuickRunTab({ initialPlaybook = "" }: { initialPlaybook?: string }) {
  const environmentId = useUi(state => state.environmentId);
  const profile = useProfile();
  if (profile.isError) return <QueryErrorState compact title="Account context unavailable" error={profile.error} onRetry={() => void profile.refetch()} />;
  if (profile.isPending) return <p role="status">Loading account context…</p>;
  const userId = profile.data?.id;
  if (userId === undefined || userId === null || String(userId) === '') return <p role="alert">Account identity is unavailable. Reload the page before starting a playbook.</p>;
  const storageKey = activeRunKey(userId, environmentId);
  return <QuickRunSession key={storageKey} initialPlaybook={initialPlaybook} environmentId={environmentId} storageKey={storageKey} />;
}

function QuickRunSession({ initialPlaybook, environmentId, storageKey }: { initialPlaybook: string; environmentId: string; storageKey: string }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const unsubscribeRun = useRef<(() => void) | null>(null);
  const [runConnectionError, setRunConnectionError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; unsubscribeRun.current?.(); unsubscribeRun.current = null; };
  }, []);
  const playbooksQuery = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]>,
  });
  const servers = useQuery<Record<string, unknown>[]>({
    queryKey: ["servers", environmentId],
    queryFn: () =>
      api.getServers(environmentId) as unknown as Promise<Record<string, unknown>[]>,
  });
  const serverGroups = useQuery<Record<string, unknown>[]>({
    queryKey: ["server-groups", environmentId],
    queryFn: () => api.getServerGroups(environmentId) as unknown as Promise<Record<string, unknown>[]>,
  });
  const {data: profile} = useProfile();
  const environmentVars = useQuery<AnsibleVar[]>({
    queryKey: ["ansibleVars", environmentId],
    queryFn: () => api.getAnsibleVars(environmentId) as unknown as Promise<AnsibleVar[]>,
    enabled: hasCap(profile, "canViewVars"),
  });
  const playbooks = playbooksQuery.data;
  const srvList = useMemo(() => asArray<Record<string, unknown>>(servers.data), [servers.data]);
  const groupList = useMemo(() => asArray<Record<string, unknown>>(serverGroups.data), [serverGroups.data]);
  const userPbs = asArray<Playbook>(playbooks).filter((p) => !p.isInternal);

  const [scheduleVariables, setScheduleVariables] = useState<Record<string, unknown>>({});
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<{dirty: boolean; busy: boolean}>({dirty:false,busy:false});
  const [discardSchedule, setDiscardSchedule] = useState(false);
  const [selPb, setSelPb] = useState(initialPlaybook);
  const [allChecked, setAllChecked] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [extraVars, setExtraVars] = useState<RunVariableDraft[]>([]);
  const [extraVarsError, setExtraVarsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outputRestricted, setOutputRestricted] = useState(false);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [lines, setLines] = useState<{ text: string; cls: string }[]>([]);
  const [started, setStarted] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewAllMode, setReviewAllMode] = useState(false);
  const [reviewVars, setReviewVars] = useState<Record<string, unknown>>({});
  const [checkMode, setCheckMode] = useState(false);
  const [forks, setForks] = useState(5);
  const [hostSearch, setHostSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [cancelTarget, setCancelTarget] = useState<CancelRunTarget | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nextVariableId = useRef(0);

  const addExtraVariable = () => {
    nextVariableId.current += 1;
    setExtraVars((rows) => [...rows, { id: `run-var-${nextVariableId.current}`, key: "", value: "", type: "string" }]);
    setExtraVarsError(null);
  };
  const updateExtraVariable = (id: string, patch: Partial<RunVariableDraft>) => {
    setExtraVars((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
    setExtraVarsError(null);
  };

  const addLine = (text: string, cls: string) => {
    setLines((prev) => [...prev, { text, cls }]);
  };
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [lines]);
  useEffect(() => {
    if (initialPlaybook) setSelPb(initialPlaybook);
  }, [initialPlaybook]);
  const activeRunStorageKey = storageKey;
  useEffect(() => {
    const restore = () => {
      const starting = getRunStart(activeRunStorageKey);
      setStartingRun(Boolean(starting?.pending));
      if (starting?.pending) {
        setRunStatus(null);
        setRunConnectionError(null);
        setBusy(true); setStarted(true); setActiveRunId(null);
        return;
      }
      const stored = starting?.runId || window.sessionStorage.getItem(activeRunStorageKey);
      if (stored) { setActiveRunId(stored); setBusy(true); setStarted(true); }
      else if (starting?.error) { setBusy(false); setRunConnectionError(starting.error); }
    };
    restore();
    return subscribeRunStart(activeRunStorageKey, restore);
  }, [activeRunStorageKey]);
  useEffect(() => {
    if (!activeRunId) return;
    let stopped = false;
    let refreshing = false;
    const refreshRun = async () => {
      if (refreshing || stopped) return;
      refreshing = true;
      try {
        const entry = await api.getPlaybookRunStatus(activeRunId, environmentId) as unknown as HistoryEntry & {output_available?: boolean};
        if (stopped) return;
        setRunConnectionError(null);
        setRunStatus(entry.status);
        setOutputRestricted(entry.output_available === false);
        if (entry.output_available === false) setLines([]);
        if (entry.output) setLines([{ text: entry.output, cls: "" }]);
        const terminal = ['success','successful','completed','failed','error','cancelled','canceled'].includes(entry.status);
        if (!terminal && !['running','queued','pending'].includes(entry.status)) setRunConnectionError(`Unrecognized run state: ${entry.status}`);
        if (terminal) {
          setBusy(false);
          setActiveRunId(null);
          window.sessionStorage.removeItem(activeRunStorageKey);
          clearRunStart(activeRunStorageKey);
          showToast(entry.status === "success" ? "Playbook run completed." : `Playbook run ${entry.status}.`, entry.status === "success" ? "success" : "warning");
        }
      } catch (error) {
        if (!stopped) setRunConnectionError(error instanceof Error ? error.message : 'Run status unavailable');
        // Preserve the active marker until an authoritative terminal state.
      } finally { refreshing = false; }
    };
    void refreshRun();
    const timer = window.setInterval(() => void refreshRun(), 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeRunId, activeRunStorageKey]);

  const allTags = useMemo(() => [...new Set(srvList.flatMap((server) => (
    Array.isArray(server.tags) ? server.tags.map(String) : []
  )))].sort((a, b) => a.localeCompare(b)), [srvList]);
  const visibleServers = useMemo(() => filterTargetHosts(srvList, {search:hostSearch,group:groupFilter,tag:tagFilter}), [groupFilter,hostSearch,srvList,tagFilter]);
  const previewTargets = allChecked
    ? srvList.map((server) => String(server.name)).filter((name) => !checked.has(name))
    : [...checked].filter((name) => name !== "localhost");
  const selectedTargets = allChecked ? previewTargets : [...checked];
  const shortTargetPreview = selectedTargets.slice(0, 8);

  const toggleServer = (name: string) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  };

  const applyVisibleSelection = () => {
    const names = visibleServers.map((server) => String(server.name)).filter(Boolean);
    setChecked((previous) => {
      const next = new Set(previous);
      names.forEach((name) => next.add(name));
      return next;
    });
  };

  const run = async () => {
    if (!selPb) {
      showToast(t("qr.selectPlaybook"), "warning");
      return;
    }
    if (allChecked) {
      setConfirmAllOpen(true);
      return;
    }
    prepareReview(false);
  };

  const prepareReview = (allMode: boolean) => {
    const targets = allMode ? previewTargets : [...checked];
    if (targets.length === 0) {
      showToast(t("run.needTarget"), "warning");
      return;
    }
    let overrides: Record<string, unknown> = {};
    try {
      overrides = parseRunVariableDrafts(extraVars);
      setExtraVarsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("run.invalidJson");
      setExtraVarsError(message);
      showToast(message, "error");
      return;
    }
    const inherited = Object.fromEntries(asArray<AnsibleVar>(environmentVars.data).map((variable) => [
      variable.key,
      variable.is_secret ? "••••••••" : variable.value,
    ]));
    setReviewVars({ ...inherited, ...overrides });
    setReviewAllMode(allMode);
    setReviewOpen(true);
  };

  const startRun = async (allMode: boolean) => {
    let targets: string;
    if (allMode) {
      const excl = [...checked].filter((v) => v !== "localhost");
      targets = buildAllExceptTargets(excl);
    } else {
      if (checked.size === 0) {
        showToast(t("run.needTarget"), "warning");
        return;
      }
      targets = [...checked].join(",");
    }
    let ev: Record<string, unknown> = {};
    try {
      ev = parseRunVariableDrafts(extraVars);
      setExtraVarsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("run.invalidJson");
      setExtraVarsError(message);
      showToast(message, "error");
      return;
    }
    setBusy(true);
    setStarted(true);
    setLines([]);
    try {
      const res = await trackRunStart(activeRunStorageKey, async () => (await api.runPlaybook(selPb, targets, ev, {
        environment_id: environmentId,
        checkMode,
        forks,
      })) as unknown as {
        historyId?: string;
        runId?: string;
      });
      if (!mounted.current) return;
      addLine(t("pb.started"), "text-green-500");
      if (res?.historyId) {
        setActiveRunId(res.runId || null);
        unsubscribeRun.current?.();
        const unsub = ws.subscribe((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          if (!mounted.current || m.historyId !== res.historyId) return;
          if (m.type === "ansible_output")
            addLine(
              String(m.data ?? ""),
              m.stream === "stderr" ? "text-red-400" : "",
            );
          else if (m.type === "ansible_complete") {
            const status = completionStatus(m);
            addLine(statusLabel(t, status), status === 'success' ? 'text-green-500' : status === 'failed' ? 'text-red-400' : 'text-muted-foreground');
            setRunStatus(status);
            if (status === 'unknown') { setRunConnectionError('Completion state is unknown; checking persisted status'); return; }
            unsub();
            setBusy(false);
            setActiveRunId(null);
            window.sessionStorage.removeItem(activeRunStorageKey);
            clearRunStart(activeRunStorageKey);
          } else if (m.type === "ansible_error") {
            addLine(
              t("ws.error", { msg: String(m.error ?? "") }),
              "text-red-400",
            );
            unsub();
            setBusy(false);
            setActiveRunId(null);
            window.sessionStorage.removeItem(activeRunStorageKey);
            clearRunStart(activeRunStorageKey);
          }
        });
        unsubscribeRun.current = unsub;
        ws.connect();
      } else {
        setBusy(false);
      }
    } catch (e: unknown) {
      if (!mounted.current) return;
      addLine((e as Error).message, "text-red-400");
      setBusy(false);
    }
  };

  const referenceError = playbooksQuery.error || servers.error || serverGroups.error || environmentVars.error;
  if (referenceError) {
    return (
      <Card>
        <QueryErrorState
          error={referenceError}
          title="Playbook run references could not be loaded"
          onRetry={() => void Promise.all([
            playbooksQuery.refetch(),
            servers.refetch(),
            serverGroups.refetch(),
            environmentVars.refetch(),
          ])}
        />
      </Card>
    );
  }

  return (
    <div className={started ? "grid items-start gap-4 lg:grid-cols-2" : "space-y-4"}>
      {/* Left: form */}
      <Card className="min-h-0">
        <CardContent className="space-y-4 p-4">
          <div className="space-y-1">
            <Label htmlFor="quick-run-playbook">1. Choose action</Label>
            <select
              id="quick-run-playbook"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={selPb}
              onChange={(e) => setSelPb(e.target.value)}
            >
              <option value="">{t("qr.selectPlaybook")}</option>
              {userPbs.map((p) => (
                <option key={p.filename} value={p.filename}>
                  {p.description || p.filename}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>2. Choose targets</Label>
            <p className="text-xs text-muted-foreground">
              {allChecked ? t("run.excludeHint") : t("run.includeHint")}
            </p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search hosts"
                  value={hostSearch}
                  onChange={(event) => setHostSearch(event.target.value)}
                  placeholder="Search name, IP, or tag"
                  className="pl-8"
                />
              </div>
              {(groupList.length > 0 || groupFilter) && <select
                aria-label="Filter hosts by group"
                className="flex h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
              >
                <option value="">All groups</option>
                {groupList.map((group) => <option key={String(group.id)} value={String(group.id)}>{String(group.name)}</option>)}
              </select>}
              <select
                aria-label="Filter hosts by tag"
                className="flex h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
              >
                <option value="">All tags</option>
                {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{visibleServers.length} of {srvList.length} managed hosts</span>
              {visibleServers.length > 0 && (
                <Button type="button" variant="ghost" size="sm" className="h-7" onClick={applyVisibleSelection}>
                  {allChecked ? "Exclude filtered" : "Select filtered"}
                </Button>
              )}
            </div>
            <div className="grid max-h-[26rem] min-h-24 content-start gap-x-2 gap-y-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-[repeat(auto-fill,minmax(15rem,18rem))]">
              <label className="col-span-full flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => {
                    setAllChecked(e.target.checked);
                    setChecked(new Set());
                  }}
                />
                {t("pb.allServers")}
              </label>
              <Separator className="col-span-full" />
              {visibleServers.map((s) => {
                const nm = String(s.name);
                const dis = allChecked && nm === "localhost";
                const isExcluded = allChecked && checked.has(nm);
                const tags = Array.isArray(s.tags) ? s.tags.map(String) : [];
                return (
                  <label
                    key={nm}
                    className={`flex min-h-9 items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${dis ? "opacity-40" : ""} ${isExcluded ? "bg-destructive/10 text-destructive" : "hover:bg-muted/50"}`}
                  >
                    <input
                      type="checkbox"
                      disabled={dis}
                      checked={checked.has(nm)}
                      onChange={() => toggleServer(nm)}
                      className={isExcluded ? "accent-destructive" : ""}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{nm}</span>
                        {s.status !== "online" && (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
                            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                            {t("common.offline")}
                          </span>
                        )}
                      </span>
                      <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                        {s.ip_address ? <span className="truncate font-mono">{String(s.ip_address)}</span> : null}
                        {tags.slice(0, 2).map((tag) => <span key={tag} className="max-w-24 truncate rounded bg-muted px-1">{tag}</span>)}
                        {tags.length > 2 ? <span>+{tags.length - 2}</span> : null}
                      </span>
                    </span>
                    {isExcluded && (
                      <span className="text-xs font-medium text-destructive">
                        {t("run.excluded")}
                      </span>
                    )}
                  </label>
                );
              })}
              <label
                className={`flex items-center gap-2 text-sm rounded px-1 py-0.5 transition-colors ${allChecked && checked.has("localhost") ? "bg-destructive/10 text-destructive" : allChecked ? "opacity-40" : ""}`}
              >
                <input
                  type="checkbox"
                  disabled={allChecked}
                  checked={checked.has("localhost")}
                  onChange={() => toggleServer("localhost")}
                />
                <span className="min-w-0 flex-1"><span className="block font-medium">localhost</span><span className="block text-[11px] text-muted-foreground">Runs inside the Fleet runtime, not on a remote host.</span></span>
                {allChecked && checked.has("localhost") && (
                  <span className="text-xs font-medium text-destructive">
                    {t("run.excluded")}
                  </span>
                )}
              </label>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="font-medium">Target preview · {selectedTargets.length} host{selectedTargets.length === 1 ? "" : "s"}</div>
            <p className={`mt-1 break-words text-xs text-muted-foreground ${shortTargetPreview.length ? "font-mono" : ""}`}>
              {shortTargetPreview.join(", ") || "Select at least one host."}
              {selectedTargets.length > shortTargetPreview.length ? ` +${selectedTargets.length - shortTargetPreview.length} more` : ""}
            </p>
          </div>
          <h3 className="text-sm font-semibold">3. Run now or schedule</h3>
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 shadow-sm">
            <p className="min-w-0 flex-1 text-sm"><strong className="break-all">{selPb || "Select a playbook"}</strong><span className="block text-muted-foreground">{selectedTargets.length} {selectedTargets.length === 1 ? "host" : "hosts"} selected · {checkMode ? "Dry run" : "Live run"}</span></p>
            {hasCap(profile, 'canAddSchedules') && <Button variant="outline" disabled={busy || !selPb || selectedTargets.length === 0} onClick={() => { try { const variables = parseRunVariableDrafts(extraVars); setScheduleVariables(variables); setExtraVarsError(null); setScheduleOpen(true); } catch (error) { setExtraVarsError((error as Error).message); showToast((error as Error).message, 'error'); } }}>Schedule</Button>}
            <Button onClick={run} disabled={!hasCap(profile, "canRunPlaybooks") || busy || !selPb || selectedTargets.length === 0}>
              <Play className="h-4 w-4" /> {busy ? (startingRun ? "Starting…" : t("qr.running")) : checkMode ? "Start dry run" : t("qr.run")}
            </Button>
            {busy && activeRunId && (
              <Button variant="destructive" onClick={() => setCancelTarget({id:activeRunId,environment:environmentId})}>
                <X className="h-4 w-4" /> Cancel run
              </Button>
            )}
          </div>
          <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Variables and execution options</summary><div className="mt-3 space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Run-specific variables <span className="font-normal text-muted-foreground">({t("common.optional")})</span></Label>
              <Button type="button" variant="outline" size="sm" onClick={addExtraVariable}><Plus className="h-4 w-4" /> Add variable</Button>
            </div>
            {extraVars.length === 0 ? <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No overrides.</p> : (
              <div className="space-y-2">
                {extraVars.map((row, index) => (
                  <div key={row.id} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[minmax(8rem,1fr)_8rem_minmax(8rem,1.4fr)_2.25rem]">
                    <Input aria-label={`Variable ${index + 1} key`} value={row.key} onChange={(event) => updateExtraVariable(row.id, { key: event.target.value })} placeholder="variable_name" className="font-mono text-sm" />
                    <select aria-label={`Variable ${index + 1} type`} value={row.type} onChange={(event) => updateExtraVariable(row.id, { type: event.target.value as RunVariableType, value: event.target.value === "boolean" ? "false" : row.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                      <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="json">JSON</option>
                    </select>
                    {row.type === "boolean" ? <select aria-label={`Variable ${index + 1} value`} value={row.value || "false"} onChange={(event) => updateExtraVariable(row.id, { value: event.target.value })} className="h-9 rounded-md border border-input bg-background px-2 text-sm"><option value="false">false</option><option value="true">true</option></select> : <Input aria-label={`Variable ${index + 1} value`} value={row.value} onChange={(event) => updateExtraVariable(row.id, { value: event.target.value })} placeholder={row.type === "json" ? '{"enabled":true}' : "Value"} className="font-mono text-sm" />}
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${index + 1}`} onClick={() => { setExtraVars((rows) => rows.filter((item) => item.id !== row.id)); setExtraVarsError(null); }}><X className="h-4 w-4" /></Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Overrides environment variables.</p>
            {extraVarsError && <p role="alert" className="text-xs text-destructive">{extraVarsError}</p>}
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2 text-sm">
            <span><span className="block font-medium">Dry run</span><span className="text-xs text-muted-foreground">Ansible check mode with diff; review changes without applying them where modules support it.</span></span>
            <Switch aria-label="Dry run" checked={checkMode} onCheckedChange={setCheckMode} />
          </label>
          <details className="rounded-md border bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced execution options</summary>
            <div className="mt-3">
              <div className="space-y-1">
                <Label htmlFor="playbook-forks">Parallel hosts</Label>
                <Input id="playbook-forks" type="number" min={1} max={50} value={forks} onChange={(event) => setForks(Math.min(50, Math.max(1, Number(event.target.value) || 1)))} />
                <p className="text-xs text-muted-foreground">Set to 1 for serial execution.</p>
              </div>
            </div>
          </details>
          </div></details>
          <Dialog open={scheduleOpen} onOpenChange={open => { if (open) setScheduleOpen(true); else if (!scheduleDraft.busy) { if (scheduleDraft.dirty) setDiscardSchedule(true); else setScheduleOpen(false); } }}>
            {scheduleOpen && <ScheduleDialog editId={null} schedules={[]} environmentId={environmentId} initialDraft={{playbook:selPb, targets: allChecked ? buildAllExceptTargets([...checked].filter(name => name !== 'localhost')) : [...checked].join(','), check_mode:checkMode, forks, extra_vars: scheduleVariables}} onDraftStateChange={setScheduleDraft} onSaved={() => { setScheduleOpen(false); setScheduleDraft({dirty:false,busy:false}); }} />}
          </Dialog>
          <ConfirmDialog open={discardSchedule} onOpenChange={setDiscardSchedule} title="Discard schedule changes?" description="The unsaved schedule will be lost." confirmLabel="Discard" onConfirm={() => {setDiscardSchedule(false); setScheduleOpen(false); setScheduleDraft({dirty:false,busy:false});}} />
          {runConnectionError && <p role="alert" className="text-sm text-destructive">Run status could not be refreshed: {runConnectionError}. The run is still tracked; status will be retried.</p>}
          <CancelRunDialog target={cancelTarget} onClose={() => setCancelTarget(null)} />
          <ConfirmDialog
            open={confirmAllOpen}
            onOpenChange={setConfirmAllOpen}
            title={t("run.confirmAllServersTitle")}
            description={t("run.confirmAllServersMessage")}
            confirmLabel={t("common.run")}
            variant="destructive"
            confirmTextValue="all"
            confirmInputLabel="Confirm target"
            onConfirm={() => {
              setConfirmAllOpen(false);
              prepareReview(true);
            }}
            isPending={busy}
          />
          <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
            <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col overflow-hidden">
              <DialogHeader>
                <DialogTitle>Review playbook run</DialogTitle>
                <DialogDescription>Verify the exact hosts and merged variables before starting Ansible.</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 space-y-4 overflow-y-auto p-1 text-sm" data-dialog-body>
                <div className="rounded-md border p-3">
                  <div className="font-medium">{selPb}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{checkMode ? "Dry run" : "Live run"} · {forks} parallel hosts</div>
                </div>
                <div>
                  <div className="mb-2 font-medium">Hosts ({(reviewAllMode ? previewTargets : [...checked]).length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(reviewAllMode ? previewTargets : [...checked]).slice(0, 12).map((host) => <StatusBadge key={host} tone="neutral">{host}</StatusBadge>)}
                    {(reviewAllMode ? previewTargets : [...checked]).length > 12 && <StatusBadge tone="muted">+{(reviewAllMode ? previewTargets : [...checked]).length - 12} more</StatusBadge>}
                  </div>
                  {(reviewAllMode ? previewTargets : [...checked]).length > 12 && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Show full host list</summary>
                      <p className="mt-2 max-h-28 overflow-auto break-words rounded bg-muted/40 p-2 font-mono">{(reviewAllMode ? previewTargets : [...checked]).join(", ")}</p>
                    </details>
                  )}
                </div>
                <div>
                  <div className="mb-2 font-medium">Variables passed to every selected host</div>
                  {Object.keys(reviewVars).length ? (
                    <div className="overflow-hidden rounded-md border">
                      <table className="w-full text-xs"><tbody className="divide-y">
                        {Object.entries(reviewVars).map(([key, value]) => <tr key={key}><td className="px-3 py-2 font-mono font-medium">{key}</td><td className="px-3 py-2 font-mono text-muted-foreground">{String(value)}</td></tr>)}
                      </tbody></table>
                    </div>
                  ) : <p className="text-xs text-muted-foreground">No environment or run variables.</p>}
                </div>
              </div>
              <DialogFooter className="shrink-0 border-t pt-3">
                <Button variant="outline" onClick={() => setReviewOpen(false)}>Back</Button>
                <Button onClick={() => { setReviewOpen(false); void startRun(reviewAllMode); }} disabled={busy}><Play className="h-4 w-4" /> Start run</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {/* Output only takes space once a run has started. */}
      {started && <Card className="min-h-0">
        <CardContent className="flex min-h-[28rem] flex-col p-4">
          <div className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Terminal className="h-4 w-4" /> {t("pb.output")}
          </div>
          {runStatus && <p role="status" className="mb-2 text-sm">Run status: {runStatus}</p>}
          {outputRestricted && <p className="mb-3 text-sm text-muted-foreground">Your role can track this run. Viewing its output requires workflow history access.</p>}
          {!started ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                compact
                icon={<Play className="h-5 w-5" />}
                title={t("pb.quickRunPlaceholder")}
              />
            </div>
          ) : (
            <div
              ref={bodyRef}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >
              {lines.map((l, i) => (
                <div key={i} className={l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Variables
// ═════════════════════════════════════════════════════════════════════════════
