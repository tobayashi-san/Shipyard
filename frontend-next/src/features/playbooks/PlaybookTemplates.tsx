import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  Eye,
  FileText,
  Folder,
  FolderCog,
  GitCommit,
  History,
  Play,
  Save,
  Search,
  Terminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { api } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonRow } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useUi } from "@/lib/store";
import { hasCap, useProfile } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { ws } from "@/lib/ws";
import {
  buildAllExceptTargets,
  formatDate as fmtDate,
  loadCollapsedCategories as loadCollapsed,
  saveCollapsedCategories as saveCollapsed,
  TEMPLATE_YAML,
} from "./playbook-utils";
import type { Playbook, PlaybookVersion } from "./playbook-types";

const PlaybookEditor = lazy(() => import("./components/PlaybookEditor"));

export function TemplatesTab({ onRun, createRequest = 0 }: { onRun: (filename: string) => void; createRequest?: number }) {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const qc = useQueryClient();
  const theme = useUi((s) => s.theme);
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "editor">("none");
  const [content, setContent] = useState("");
  const [origContent, setOrigContent] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [filenameInput, setFilenameInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const handledCreateRequest = useRef(0);

  const {
    data: playbooks,
    isError: playbooksFailed,
    error: playbooksError,
    refetch: refetchPlaybooks,
  } = useQuery<Playbook[]>({
    queryKey: ["playbooks"],
    queryFn: () => api.getPlaybooks() as unknown as Promise<Playbook[]>,
  });

  // Fetch content when selecting existing playbook
  const playbookContentQuery = useQuery({
    queryKey: ["playbook", selected],
    queryFn: () => api.getPlaybook(selected!),
    enabled: !!selected && !isNew,
  });
  const pbData = playbookContentQuery.data;
  useEffect(() => {
    if (pbData?.content !== undefined && !isNew) {
      setContent(pbData.content);
      setOrigContent(pbData.content);
    }
  }, [pbData?.content, isNew]);

  const dirty = content !== origContent;
  const selectedPb = playbooks?.find((p) => p.filename === selected);

  // Grouped + filtered
  const grouped = useMemo(() => {
    const list = asArray<Playbook>(playbooks);
    const q = filter.trim().toLowerCase();
    const f = q
      ? list.filter(
          (p) =>
            p.filename.toLowerCase().includes(q) ||
            (p.description ?? "").toLowerCase().includes(q) ||
            (p.category ?? "").toLowerCase().includes(q),
        )
      : list;
    const user = f.filter((p) => !p.isInternal);
    const internal = f.filter((p) => !!p.isInternal);
    const catMap: Record<string, Playbook[]> = {};
    user.forEach((p) => {
      const c = p.category || t("pb.custom");
      (catMap[c] ??= []).push(p);
    });
    return { catMap, internal };
  }, [playbooks, filter, t]);
  const canOpenTemplates =
    hasCap(profile, "canEditPlaybooks") ||
    hasCap(profile, "canDeletePlaybooks");

  const toggleCat = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  // Select existing playbook for editing
  const selectPb = (filename: string, isInternal: boolean) => {
    setSelected(filename);
    setIsNew(false);
    setPanel("editor");
    setFilenameInput(filename.replace(/\.ya?ml$/, ""));
    setContent("");
    setOrigContent("");
    void isInternal;
  };

  useEffect(() => {
    if (createRequest <= handledCreateRequest.current) return;
    handledCreateRequest.current = createRequest;
    setSelected(null);
    setIsNew(true);
    setFilenameInput("");
    setContent(TEMPLATE_YAML);
    setOrigContent("");
    setYamlError(null);
    setPanel("editor");
  }, [createRequest]);

  // Save
  const saveMut = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      const fn = selected || filenameInput.trim() + ".yml";
      if (!fn.trim()) throw new Error(t("pb.needFilename"));
      if (!content.trim()) throw new Error(t("pb.needContent"));
      return api.savePlaybook(fn, content) as unknown as Promise<
        Record<string, unknown>
      >;
    },
    onSuccess: (res: Record<string, unknown>) => {
      const fn =
        (res as { filename?: string }).filename ??
        selected ??
        filenameInput.trim() + ".yml";
      showToast(t("pb.saved", { name: fn }), "success");
      setSelected(fn);
      setIsNew(false);
      setOrigContent(content);
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      qc.invalidateQueries({ queryKey: ["playbook", fn] });
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  // Delete
  const deleteMut = useMutation({
    mutationFn: () => api.deletePlaybook(selected!),
    onSuccess: () => {
      showToast(t("pb.deleted", { name: selected }), "success");
      setDeleteConfirmOpen(false);
      setPanel("none");
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["playbooks"] });
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  const closePanel = () => {
    setPanel("none");
    setSelected(null);
  };

  return (
    <div className="grid gap-4 lg:h-[calc(100vh-15rem)] lg:max-h-[48rem] lg:min-h-[34rem] lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* ── List panel ─────────────────────────── */}
      <Card
        className={`${panel === "none" ? "flex" : "hidden lg:flex"} h-[calc(100dvh-15rem)] min-h-[24rem] flex-col overflow-hidden lg:h-full`}
      >
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="flex items-center justify-between border-b bg-muted/15 px-3 py-2.5">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">Playbook inventory</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {asArray<Playbook>(playbooks).length}
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Select a playbook to inspect or edit it.
              </p>
            </div>
          </div>
          <div className="relative border-b bg-background/70 px-3 py-2">
            <label className="sr-only" htmlFor="playbook-search">Search playbooks</label>
            <Search className="pointer-events-none absolute left-5 top-4 h-4 w-4 text-muted-foreground" />
            <Input
              id="playbook-search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("common.search")}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {playbooksFailed ? (
              <QueryErrorState
                compact
                error={playbooksError}
                onRetry={() => {
                  void refetchPlaybooks();
                }}
                title="Playbooks could not be loaded"
              />
            ) : (
              <>
                {Object.keys(grouped.catMap)
                  .sort()
                  .map((cat) => {
                    const key = `user:${cat}`;
                    const open = !collapsed.has(key);
                    return (
                      <div key={key}>
                        <button
                          onClick={() => toggleCat(key)}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                        >
                          <ChevronDown
                            className={`h-3 w-3 transition ${open ? "" : "-rotate-90"}`}
                          />
                          <Folder className="h-3 w-3" />
                          <span className="flex-1 text-left">{cat}</span>
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0"
                          >
                            {grouped.catMap[cat].length}
                          </Badge>
                        </button>
                        {open &&
                          grouped.catMap[cat].map((p) => (
                            <PlaybookListItem
                              key={p.filename}
                              p={p}
                              active={selected === p.filename}
                              onSelect={
                                canOpenTemplates
                                  ? () => selectPb(p.filename, false)
                                  : undefined
                              }
                              onRun={
                                hasCap(profile, "canRunPlaybooks")
                                  ? () => onRun(p.filename)
                                  : undefined
                              }
                            />
                          ))}
                      </div>
                    );
                  })}
                {grouped.internal.length > 0 &&
                  (() => {
                    const key = `internal:${t("pb.internal")}`;
                    const open = !collapsed.has(key);
                    return (
                      <div>
                        <button
                          onClick={() => toggleCat(key)}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                        >
                          <ChevronDown
                            className={`h-3 w-3 transition ${open ? "" : "-rotate-90"}`}
                          />
                          <FolderCog className="h-3 w-3" />
                          <span className="flex-1 text-left">
                            {t("pb.internal")}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0"
                          >
                            {grouped.internal.length}
                          </Badge>
                        </button>
                        {open &&
                          grouped.internal.map((p) => (
                            <PlaybookListItem
                              key={p.filename}
                              p={p}
                              active={selected === p.filename}
                              onSelect={
                                canOpenTemplates
                                  ? () => selectPb(p.filename, true)
                                  : undefined
                              }
                            />
                          ))}
                      </div>
                    );
                  })()}
                {Object.keys(grouped.catMap).length === 0 &&
                  grouped.internal.length === 0 && (
                    <div className="py-4 text-center text-sm text-muted-foreground">
                      {t("pb.noPlaybooks")}
                    </div>
                  )}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Right panel ────────────────────────── */}
      {panel === "none" && (
        <Card className="min-h-0">
          <CardContent className="flex min-h-[22rem] items-center justify-center p-6">
            <EmptyState
              icon={<Terminal className="h-5 w-5" />}
              title="Select a playbook"
              description="Select an item on the left to inspect it. Use New playbook in the page header to create one."
            />
          </CardContent>
        </Card>
      )}

      {panel === "editor" && (
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden lg:self-start">
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
            {/* Editor header */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/15 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">
                  {isNew ? t("pb.new") : (selected ?? "")}
                </span>
                {dirty && (
                  <Badge variant="secondary" className="shrink-0">
                    {t("pb.unsaved")}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="lg:hidden"
                  onClick={closePanel}
                >
                  <ArrowLeft className="h-4 w-4" /> {t("common.back")}
                </Button>
                {!isNew && !selectedPb?.isInternal && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setHistoryOpen(true)}
                  >
                    <History className="h-4 w-4" /> {t("pb.history")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={closePanel}>
                  {t("common.cancel")}
                </Button>
                {hasCap(profile, "canEditPlaybooks") && (
                  <Button
                    size="sm"
                    onClick={() => saveMut.mutate()}
                    disabled={
                      saveMut.isPending ||
                      !!yamlError ||
                      (!isNew &&
                        (playbookContentQuery.isPending ||
                          playbookContentQuery.isError))
                    }
                  >
                    <Save className="h-4 w-4" /> {t("common.save")}
                  </Button>
                )}
                {!isNew &&
                  !selectedPb?.isInternal &&
                  hasCap(profile, "canDeletePlaybooks") && (
                    <>
                      <Separator orientation="vertical" className="mx-1 h-6" />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setDeleteConfirmOpen(true)}
                        disabled={deleteMut.isPending}
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
              </div>
            </div>
            {/* Filename field (hidden for internal) */}
            {!selectedPb?.isInternal && (
              <div className="px-4 pt-3">
                <div className="space-y-1">
                  <Label>{t("pb.filename")}</Label>
                  <Input
                    value={filenameInput}
                    onChange={(e) => setFilenameInput(e.target.value)}
                    placeholder={t("pb.filenamePlaceholder")}
                    className="font-mono text-sm"
                    disabled={!isNew && !!selected}
                  />
                </div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col space-y-1 px-4 pb-4">
              <Label>{t("pb.yaml")}</Label>
              {!isNew && playbookContentQuery.isPending ? (
                <Skeleton className="h-[420px] w-full" />
              ) : !isNew && playbookContentQuery.isError ? (
                <QueryErrorState
                  error={playbookContentQuery.error}
                  onRetry={() => {
                    void playbookContentQuery.refetch();
                  }}
                  title="Playbook content could not be loaded"
                />
              ) : (
                <Suspense fallback={<Skeleton className="h-[420px] w-full" />}>
                  <PlaybookEditor
                    value={content}
                    onChange={setContent}
                    onValidityChange={setYamlError}
                    dark={isDark}
                  />
                </Suspense>
              )}
            </div>
          </CardContent>
        </Card>
      )}


      {/* History dialog */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <PlaybookHistoryDialog
          filename={selected ?? ""}
          onRestore={(c: string) => {
            setContent(c);
            setHistoryOpen(false);
          }}
        />
      </Dialog>
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t("common.delete")}
        description={
          <>
            <div>{t("pb.confirmDelete", { name: selected ?? "" })}</div>
            <div className="mt-2 text-xs">{t("pb.confirmDeleteHint")}</div>
          </>
        }
        confirmLabel={t("common.delete")}
        variant="destructive"
        confirmTextValue={selected ?? ""}
        confirmInputLabel="Confirm playbook filename"
        onConfirm={() => deleteMut.mutate()}
        isPending={deleteMut.isPending}
      />
    </div>
  );
}

export function PlaybookListItem({
  p,
  active,
  onSelect,
  onRun,
}: {
  p: Playbook;
  active: boolean;
  onSelect?: () => void;
  onRun?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${onSelect ? "cursor-pointer" : ""} ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
      onClick={onSelect}
    >
      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={p.filename}>
        {p.description || p.filename}
      </span>
      {onRun && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
          aria-label={`${t("common.run")} ${p.filename}`}
          title={t("common.run")}
        >
          <Play className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

// ── Template Run Panel (right side of Templates tab) ─────────────────────────

export function TemplateRunPanel({
  filename,
  description,
  onClose,
}: {
  filename: string;
  description: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data: profile } = useProfile();
  const environmentId = useUi((state) => state.environmentId);
  const servers = useQuery<Record<string, unknown>[]>({
    queryKey: ["servers", environmentId],
    queryFn: () =>
      api.getServers(environmentId) as unknown as Promise<Record<string, unknown>[]>,
  });
  const srvList = asArray<Record<string, unknown>>(servers.data);

  const [target, setTarget] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; cls: string }[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const addLine = (text: string, cls: string) => {
    setLines((prev) => [...prev, { text, cls }]);
  };
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [lines]);

  const run = async () => {
    if (!target) {
      showToast(t("run.needTarget"), "warning");
      return;
    }
    if (target === "all") {
      setConfirmAllOpen(true);
      return;
    }
    await startRun(target);
  };

  const startRun = async (targetValue: string) => {
    setBusy(true);
    setShowOutput(true);
    setLines([]);
    const finalTarget =
      targetValue === "all"
        ? buildAllExceptTargets([...excluded])
        : targetValue;
    try {
      const res = (await api.runPlaybook(
        filename,
        finalTarget,
        {},
      )) as unknown as { historyId?: string };
      addLine(t("pb.started"), "text-green-500");
      if (res?.historyId) {
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
          } else if (m.type === "ansible_error") {
            addLine(
              t("ws.error", { msg: String(m.error ?? "") }),
              "text-red-400",
            );
            unsub();
            setBusy(false);
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

  if (servers.isError) {
    return (
      <Card className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <span className="truncate font-medium">{description || filename}</span>
            <Button variant="outline" size="sm" onClick={onClose}>{t("common.close")}</Button>
          </div>
          <QueryErrorState
            error={servers.error}
            title="Playbook targets could not be loaded"
            onRetry={() => void servers.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-1 flex-col space-y-0 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/15 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Play className="h-4 w-4 text-muted-foreground" />
            <span className="truncate font-medium">
              {description || filename}
            </span>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="lg:hidden"
              onClick={onClose}
            >
              <ArrowLeft className="h-4 w-4" /> {t("common.back")}
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        </div>

        <div className="space-y-1 px-4 pt-4">
          <Label>{t("pb.target")}</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{t("run.selectTarget")}</option>
            <option value="all">{t("pb.allServers")}</option>
            {srvList.map((s) => (
              <option key={String(s.name)} value={String(s.name)}>
                {String(s.name)}
              </option>
            ))}
            <option value="localhost">localhost</option>
          </select>
        </div>

        {target === "all" && (
          <div className="space-y-1 px-4 pt-3">
            <Label>{t("run.excludeServers")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("run.excludeHint")}
            </p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {srvList.map((s) => {
                const nm = String(s.name);
                const isExcluded = excluded.has(nm);
                return (
                  <label
                    key={nm}
                    className={`flex items-center gap-2 text-sm rounded px-1 py-0.5 transition-colors ${isExcluded ? "bg-destructive/10 text-destructive" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isExcluded}
                      onChange={(e) => {
                        setExcluded((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(nm);
                          else n.delete(nm);
                          return n;
                        });
                      }}
                      className={isExcluded ? "accent-destructive" : ""}
                    />
                    <span className="min-w-0 truncate">{nm}</span>
                    {isExcluded && (
                      <span className="ml-1 text-xs font-medium text-destructive">
                        {t("run.excluded")}
                      </span>
                    )}
                    <StatusBadge
                      tone={s.status === "online" ? "success" : "muted"}
                      className="ml-auto flex-shrink-0"
                    >
                      {s.status === "online"
                        ? t("common.online")
                        : t("common.offline")}
                    </StatusBadge>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 py-4">
          <Button onClick={run} disabled={busy}>
            <Play className="h-4 w-4" />{" "}
            {busy ? t("run.starting") : t("common.run")}
          </Button>
          <span className="text-xs text-muted-foreground">
            Output is recorded live while the run is in progress.
          </span>
        </div>

        {showOutput && (
          <div className="mt-0 flex min-h-0 flex-1 flex-col border-t bg-muted/10">
            <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {t("pb.output")}
            </div>
            <div
              ref={bodyRef}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden break-words p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >
              {lines.map((l, i) => (
                <div key={i} className={l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        )}
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
            void startRun("all");
          }}
          isPending={busy}
        />
      </CardContent>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab: Quick Run
// ═════════════════════════════════════════════════════════════════════════════

export function PlaybookHistoryDialog({
  filename,
  onRestore,
}: {
  filename: string;
  onRestore: (content: string) => void;
}) {
  const { t } = useTranslation();
  const { data: versions, isLoading, isError, error, refetch } = useQuery<PlaybookVersion[]>({
    queryKey: ["playbookHistory", filename],
    queryFn: () =>
      api.getPlaybookHistory(filename) as unknown as Promise<PlaybookVersion[]>,
    enabled: !!filename,
  });
  const [previewVer, setPreviewVer] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);

  const loadPreview = async (v: number) => {
    if (previewVer === v) {
      setPreviewVer(null);
      setPreviewContent(null);
      return;
    }
    setPreviewVer(v);
    setPreviewLoading(true);
    try {
      const data = (await api.getPlaybookVersion(filename, v)) as unknown as {
        content: string;
      };
      setPreviewContent(data.content);
    } catch (e: unknown) {
      setPreviewContent((e as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const restoreMut = useMutation({
    mutationFn: (v: number) => api.restorePlaybook(filename, v),
    onSuccess: async () => {
      setRestoreVersion(null);
      showToast(t("pb.restored"), "success");
      try {
        const data = await api.getPlaybook(filename);
        onRestore(data.content);
      } catch {
        /* */
      }
    },
    onError: (e: Error) => showToast(e.message, "error"),
  });

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("pb.historyTitle")}</DialogTitle>
      </DialogHeader>
      <div className="max-h-96 space-y-2 overflow-y-auto py-2">
        {isLoading ? (
          <div className="space-y-2">
            <SkeletonRow cols={2} />
            <SkeletonRow cols={2} />
            <SkeletonRow cols={2} />
          </div>
        ) : isError ? (
          <QueryErrorState
            compact
            error={error}
            title="Playbook version history could not be loaded"
            onRetry={() => void refetch()}
          />
        ) : !versions || versions.length === 0 ? (
          <EmptyState
            compact
            icon={<GitCommit className="h-5 w-5" />}
            title={t("pb.noHistory")}
          />
        ) : (
          versions.map((v) => (
            <div key={v.version} className="rounded-md border p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {t("pb.historyVersion", { n: v.version })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDate(v.modifiedAt)}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => loadPreview(v.version)}
                    title={t("pb.historyPreview")}
                  >
                    <Eye
                      className={`h-3.5 w-3.5 ${previewVer === v.version ? "text-primary" : ""}`}
                    />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setRestoreVersion(v.version)}
                    disabled={restoreMut.isPending}
                    title={t("pb.restore")}
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {previewVer === v.version && (
                <div className="mt-2">
                  {previewLoading ? (
                    <p className="text-xs text-muted-foreground">
                      {t("pb.loading")}
                    </p>
                  ) : (
                    <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre">
                      {previewContent}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <ConfirmDialog
        open={restoreVersion !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreVersion(null);
        }}
        title={t("pb.history")}
        description={t("pb.restoreConfirm")}
        confirmLabel={t("common.save")}
        variant="warning"
        confirmTextValue={filename}
        confirmInputLabel="Confirm playbook filename"
        onConfirm={() => {
          if (restoreVersion !== null) restoreMut.mutate(restoreVersion);
        }}
        isPending={restoreMut.isPending}
      />
    </DialogContent>
  );
}
