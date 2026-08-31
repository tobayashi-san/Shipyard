import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { History, Play, Search, Terminal, X } from "lucide-react";
import { api } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { ws } from "@/lib/ws";
import { buildAllExceptTargets } from "./playbook-utils";
import type { AnsibleVar, HistoryEntry, Playbook } from "./playbook-types";
import { HistoryTab } from "./PlaybookHistory";

export function RunsTab({ initialPlaybook }: { initialPlaybook?: string }) {
  const { data: profile } = useProfile();
  const canRun = hasCap(profile, "canRunPlaybooks");
  const canViewRuns = hasCap(profile, "canViewSchedules");
  return (
    <div className="space-y-4">
      {canRun && <QuickRunTab initialPlaybook={initialPlaybook} />}
      {canViewRuns && <HistoryTab />}
      {!canRun && !canViewRuns && (
        <EmptyState icon={<History className="h-5 w-5" />} title="Run access is not enabled for your role" />
      )}
    </div>
  );
}

export function QuickRunTab({ initialPlaybook = "" }: { initialPlaybook?: string }) {
  const { t } = useTranslation();
  const environmentId = useUi((state) => state.environmentId);
  const { data: playbooks } = useQuery<Playbook[]>({
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
  const environmentVars = useQuery<AnsibleVar[]>({
    queryKey: ["ansibleVars", environmentId],
    queryFn: () => api.getAnsibleVars(environmentId) as unknown as Promise<AnsibleVar[]>,
  });
  const srvList = useMemo(() => asArray<Record<string, unknown>>(servers.data), [servers.data]);
  const groupList = useMemo(() => asArray<Record<string, unknown>>(serverGroups.data), [serverGroups.data]);
  const userPbs = asArray<Playbook>(playbooks).filter((p) => !p.isInternal);

  const [selPb, setSelPb] = useState(initialPlaybook);
  const [allChecked, setAllChecked] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [extraVars, setExtraVars] = useState("");
  const [busy, setBusy] = useState(false);
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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const addLine = (text: string, cls: string) => {
    setLines((prev) => [...prev, { text, cls }]);
  };
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [lines]);
  useEffect(() => {
    if (initialPlaybook) setSelPb(initialPlaybook);
  }, [initialPlaybook]);
  const activeRunStorageKey = `fleet.active-playbook-run.${environmentId}`;
  useEffect(() => {
    const stored = window.sessionStorage.getItem(activeRunStorageKey);
    if (!stored) return;
    setActiveRunId(stored);
    setBusy(true);
    setStarted(true);
  }, [activeRunStorageKey]);
  useEffect(() => {
    if (!activeRunId) return;
    let stopped = false;
    const refreshRun = async () => {
      try {
        const entry = await api.getScheduleHistoryEntry(activeRunId) as unknown as HistoryEntry;
        if (stopped) return;
        if (entry.output) setLines([{ text: entry.output, cls: "" }]);
        if (entry.status !== "running") {
          setBusy(false);
          setActiveRunId(null);
          window.sessionStorage.removeItem(activeRunStorageKey);
          showToast(entry.status === "success" ? "Playbook run completed." : `Playbook run ${entry.status}.`, entry.status === "success" ? "success" : "warning");
        }
      } catch {
        // A temporary reconnect failure must not lose the active run marker.
      }
    };
    void refreshRun();
    const timer = window.setInterval(() => void refreshRun(), 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeRunId, activeRunStorageKey]);

  const allTags = useMemo(() => [...new Set(srvList.flatMap((server) => (
    Array.isArray(server.tags) ? server.tags.map(String) : []
  )))].sort((a, b) => a.localeCompare(b)), [srvList]);
  const visibleServers = useMemo(() => {
    const needle = hostSearch.trim().toLowerCase();
    return srvList.filter((server) => {
      const tags = Array.isArray(server.tags) ? server.tags.map(String) : [];
      const searchable = [server.name, server.hostname, server.ip_address, ...tags]
        .map(String)
        .join(" ")
        .toLowerCase();
      return (!needle || searchable.includes(needle)) &&
        (!groupFilter || String(server.group_id || "") === groupFilter) &&
        (!tagFilter || tags.includes(tagFilter));
    });
  }, [groupFilter, hostSearch, srvList, tagFilter]);
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
    if (extraVars.trim()) {
      try {
        overrides = JSON.parse(extraVars);
        if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") throw new Error();
      } catch {
        showToast(t("run.invalidJson"), "error");
        return;
      }
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
    if (extraVars.trim()) {
      try {
        ev = JSON.parse(extraVars);
      } catch {
        showToast(t("run.invalidJson"), "error");
        return;
      }
    }
    setBusy(true);
    setStarted(true);
    setLines([]);
    try {
      const res = (await api.runPlaybook(selPb, targets, ev, {
        environment_id: environmentId,
        checkMode,
        forks,
      })) as unknown as {
        historyId?: string;
        runId?: string;
      };
      addLine(t("pb.started"), "text-green-500");
      if (res?.historyId) {
        setActiveRunId(res.runId || null);
        if (res.runId) window.sessionStorage.setItem(activeRunStorageKey, res.runId);
        const unsub = ws.subscribe((msg: unknown) => {
          const m = msg as Record<string, unknown>;
          if (m.historyId !== res.historyId) return;
          if (m.type === "ansible_output")
            addLine(
              String(m.data ?? ""),
              m.stream === "stderr" ? "text-red-400" : "",
            );
          else if (m.type === "ansible_complete") {
            addLine(
              m.success ? t("ws.completed") : t("ws.failed"),
              m.success ? "text-green-500" : "text-red-400",
            );
            unsub();
            setBusy(false);
            setActiveRunId(null);
            window.sessionStorage.removeItem(activeRunStorageKey);
          } else if (m.type === "ansible_error") {
            addLine(
              t("ws.error", { msg: String(m.error ?? "") }),
              "text-red-400",
            );
            unsub();
            setBusy(false);
            setActiveRunId(null);
            window.sessionStorage.removeItem(activeRunStorageKey);
          }
        });
        ws.connect();
      } else {
        setBusy(false);
      }
    } catch (e: unknown) {
      addLine((e as Error).message, "text-red-400");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Left: form */}
      <Card className="min-h-0">
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Play className="h-4 w-4" /> {t("qr.title")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="quick-run-playbook">{t("run.playbook")}</Label>
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
            <Label>{t("qr.targets")}</Label>
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
              <select
                aria-label="Filter hosts by group"
                className="flex h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
              >
                <option value="">All groups</option>
                {groupList.map((group) => <option key={String(group.id)} value={String(group.id)}>{String(group.name)}</option>)}
              </select>
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
            <div className="max-h-80 min-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
              <label className="flex items-center gap-2 text-sm font-medium">
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
              <Separator />
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
                      <span className="block truncate font-medium">{nm}</span>
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
                    <span className={`ml-auto flex shrink-0 items-center gap-1 text-xs ${s.status === "online" ? "text-muted-foreground" : "text-destructive"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${s.status === "online" ? "bg-emerald-500" : "bg-destructive"}`} />
                      {s.status === "online" ? t("common.online") : t("common.offline")}
                    </span>
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
                <span>localhost</span>
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
            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
              {shortTargetPreview.join(", ") || "Select at least one host."}
              {selectedTargets.length > shortTargetPreview.length ? ` +${selectedTargets.length - shortTargetPreview.length} more` : ""}
            </p>
          </div>
          <div className="space-y-1">
            <Label>
              {t("qr.extraVars")}{" "}
              <span className="text-muted-foreground font-normal">
                ({t("common.optional")})
              </span>
            </Label>
            <Input
              value={extraVars}
              onChange={(e) => setExtraVars(e.target.value)}
              placeholder='{"key": "value"}'
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Environment variables and encrypted secrets are merged automatically. Values entered here override them for this run.</p>
          </div>
          <details className="rounded-md border bg-muted/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced options</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
                <span><span className="block font-medium">Dry run</span><span className="text-xs text-muted-foreground">Ansible check mode with diff</span></span>
                <Switch aria-label="Dry run" checked={checkMode} onCheckedChange={setCheckMode} />
              </label>
              <div className="space-y-1">
                <Label htmlFor="playbook-forks">Parallel hosts</Label>
                <Input id="playbook-forks" type="number" min={1} max={50} value={forks} onChange={(event) => setForks(Math.min(50, Math.max(1, Number(event.target.value) || 1)))} />
                <p className="text-xs text-muted-foreground">Set to 1 for serial execution.</p>
              </div>
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={busy}>
              <Play className="h-4 w-4" /> {busy ? t("qr.running") : checkMode ? "Start dry run" : t("qr.run")}
            </Button>
            {busy && activeRunId && (
              <Button variant="destructive" onClick={() => void api.cancelPlaybookRun(activeRunId)}>
                <X className="h-4 w-4" /> Cancel run
              </Button>
            )}
          </div>
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
            <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Review playbook run</DialogTitle>
                <DialogDescription>Verify the exact hosts and merged variables before starting Ansible.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 text-sm">
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
              <DialogFooter>
                <Button variant="outline" onClick={() => setReviewOpen(false)}>Back</Button>
                <Button onClick={() => { setReviewOpen(false); void startRun(reviewAllMode); }} disabled={busy}><Play className="h-4 w-4" /> Start run</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {/* Right: output */}
      <Card className="min-h-0">
        <CardContent className="flex min-h-[28rem] flex-col p-4">
          <div className="flex items-center gap-2 text-sm font-semibold mb-3">
            <Terminal className="h-4 w-4" /> {t("pb.output")}
          </div>
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
      </Card>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Variables
// ═════════════════════════════════════════════════════════════════════════════
