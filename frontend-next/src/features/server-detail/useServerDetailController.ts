import { verifiedOsCheck } from './os-check-result';
import { imageCheckSummary } from './image-check-summary';
import { newestNotesRevision } from "./notes-revision";
import { receiveActionEvent, bindActionHistory, type TrackedAction } from './action-events';
import { customTaskDraft, customTaskDirty } from './custom-task-draft';
interface UpdateCatalog { updates: Record<string, unknown>[]; source: string; updated_at: string | null; cached: boolean; stale: boolean; stale_after_seconds: number }
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { api, apiFetch, ApiError } from "@/lib/api";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { type HistoryFilters } from "@/lib/history-filter";
import { actionLabel } from "@/lib/history-labels";
import { ws } from "@/lib/ws";
import { hasCap, useProfile, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type {
  ContainerRow,
  CustomTask,
  HistoryRow,
  IpamReservation,
  ManagedDeploymentResponse,
  ServerDetail,
  ServerInfo,
} from "./server-detail-model";
import { parseArrayValue } from "./server-detail-model";

export function useServerDetailController() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? "";
  const navigate = useNavigate();
  const updateCheckView = useRef({ host: id });
  if (updateCheckView.current.host !== id) updateCheckView.current = { host: id };
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmRunUpdate, setConfirmRunUpdate] = useState(false);
  const [confirmResetHostKey, setConfirmResetHostKey] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<CustomTask | null>(
    null,
  );
  const [confirmComposeDown, setConfirmComposeDown] = useState<{
    proj: string;
    dir: string;
  } | null>(null);
  const [confirmRestartContainer, setConfirmRestartContainer] = useState<
    string | null
  >(null);
  const [actionRun, setActionRun] = useState<TrackedAction | null>(null);
  const actionSequence = useRef(0);
  const { data: profile } = useProfile();
  const { data: settings } = useSettings();
  const timeFormat = useUi((s) => s.timeFormat);
  const hour12 = timeFormat === "12h";
  // Do not start detail sub-queries until the primary host exists. Besides
  // reducing requests, this keeps a stale browser URL from producing a wall
  // of 404s while the normal not-found state is rendered.
  const serverKnown = Boolean(qc.getQueryData(["server", id]));
  const canViewManagementRelationships = hasCap(profile, "canViewServers");
  const { data: deploymentData, isPending: deploymentContextLoading, isError: deploymentContextFailed, refetch: refetchDeploymentContext } = useQuery<ManagedDeploymentResponse>({
    queryKey: ["server", id, "deployment-context"],
    queryFn: () =>
      apiFetch(`/opentofu/managed-servers/${encodeURIComponent(id)}`),
    enabled: Boolean(id && serverKnown && canViewManagementRelationships),
    staleTime: 30_000,
  });
  const managedDeployments = Array.isArray(deploymentData?.resources)
    ? deploymentData.resources
    : [];
  const managedProxmoxDeployment = managedDeployments.find(
    (deployment) => deployment.vm?.node_name && deployment.vm?.vm_id != null,
  );
  // ── Action run helpers ───────────────────────────────────────
  const startActionRun = useCallback((title: string, historyId?: string) => {
    const requestId = ++actionSequence.current;
    setActionRun({ title, status: "running", lines: [], historyId, serverId: id, requestId });
    return requestId;
  }, [id]);

  useEffect(() => {
    ws.connect();
    return ws.subscribe(raw => setActionRun(prev => receiveActionEvent(prev, raw as Record<string, unknown>)));
  }, []);

  // Listen for backend docker inventory refreshes (e.g. after compose up/down/pull)
  // and invalidate the docker query for this server so the UI reflects the new state.
  useEffect(() => {
    ws.connect();
    const unsub = ws.subscribe((raw) => {
      const data = raw as { type?: string; serverId?: string | number };
      if (data?.type !== "docker_refreshed") return;
      if (String(data.serverId) !== String(id)) return;
      void qc.invalidateQueries({ queryKey: ["server", id, "docker"] });
    });
    return unsub;
  }, [id, qc]);
  
  useEffect(() => {
    ws.connect();
    const unsub = ws.subscribe((raw) => {
      const data = raw as { type?: string; serverId?: string | number };
      if (
        data?.type !== "resource_alert_triggered" &&
        data?.type !== "resource_alert_updated"
      )
        return;
      if (String(data.serverId) !== String(id)) return;
      void qc.invalidateQueries({ queryKey: ["alerts"] });
      void qc.invalidateQueries({ queryKey: ["server", id, "info"] });
    });
    return unsub;
  }, [id, qc]);
  
  // Refresh relevant queries when an action run finishes
  useEffect(() => {
    if (!actionRun || actionRun.status === "running") return;
    void qc.invalidateQueries({ queryKey: ["server", id] });
    void qc.invalidateQueries({ queryKey: ["server", id, "docker"] });
    void qc.invalidateQueries({ queryKey: ["server", id, "history"] });
    void qc.invalidateQueries({ queryKey: ["server", id, "updates"] });
    void qc.invalidateQueries({ queryKey: ["server", id, "customTasks"] });
  }, [actionRun?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  
  // ── Data queries ────────────────────────────────────────────
  const { data: rawServer, isLoading } = useQuery({
    queryKey: ["server", id],
    queryFn: () => api.getServer(id) as unknown as Promise<ServerDetail>,
    enabled: !!id,
  });
  const server = useMemo(() => {
    if (!rawServer) return null;
    const s = rawServer as Record<string, unknown>;
    return {
      ...s,
      id: String(s.id),
      tags: parseArrayValue<string>(s.tags),
      services: parseArrayValue<string>(s.services),
      links: parseArrayValue<{ name: string; url: string }>(s.links),
      storage_mounts: parseArrayValue<{ name: string; path: string }>(
        s.storage_mounts,
      ),
    } as ServerDetail;
  }, [rawServer]);
  
  const {
    data: info,
    refetch: refetchInfo,
    isFetching: fetchingInfo,
    isError: infoFailed,
    error: infoError,
  } = useQuery<ServerInfo>({
    queryKey: ["server", id, "info"],
    queryFn: () => api.getServerInfo(id) as unknown as Promise<ServerInfo>,
    enabled: !!server,
  });
  const { data: ipamReservationData } = useQuery<IpamReservation[]>({
    queryKey: ["server", id, "ipam-reservations"],
    queryFn: () =>
      apiFetch(`/ipam/reservations?server_id=${encodeURIComponent(id)}`),
    enabled: !!server && hasCap(profile, "canViewNetworks"),
    staleTime: 30_000,
  });
  const ipamReservations = Array.isArray(ipamReservationData)
    ? ipamReservationData
    : [];
  
  // ── Stat card queries (lazy-ish but auto) ───────────────────
  const { data: dockerContainers, isFetching: fetchingDocker } = useQuery({
    queryKey: ["server", id, "docker"],
    queryFn: () =>
      api.getServerDocker(id) as unknown as Promise<ContainerRow[]>,
    enabled:
      !!id && hasCap(profile, "canViewDocker") && !!server?.docker_enabled,
    staleTime: 60_000,
  });
  const { data: rawUpdates } = useQuery({
    queryKey: ["server", id, "updates"],
    queryFn: () =>
      apiFetch<UpdateCatalog>(`/servers/${encodeURIComponent(id)}/updates?include_meta=1`),
    enabled: !!server && hasCap(profile, "canViewUpdates"),
    staleTime: 60_000,
  });
  const HIST_PAGE_SIZE = 25;
  const [histPage, setHistPage] = useState(1);
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({ query: '', status: '', from: '', to: '' });
  useEffect(() => setHistPage(1), [historyFilters, id]);
  const historyParams = new URLSearchParams({page:String(histPage),page_size:String(HIST_PAGE_SIZE),action:historyFilters.action || '',status:historyFilters.status,search:historyFilters.query,from:historyFilters.from,to:historyFilters.to});
  const { data: historyResponse, isLoading: historyLoading, isFetching: historyFetching, isError: historyFailed, refetch: refetchHistory } = useQuery({
    queryKey: ["server", id, "history", histPage, historyFilters],
    queryFn: () => apiFetch<{items:HistoryRow[];actions:string[];total_unfiltered:number;pagination:{page:number;total:number;total_pages:number}}>(`/servers/${encodeURIComponent(id)}/history?${historyParams}`),
    refetchInterval: query => query.state.data?.items?.some(run => ["running", "pending", "queued", "cancelling"].includes(run.status || "")) ? 3000 : false,
    enabled: !!server && hasCap(profile, "canViewServerHistory"),
  });
  const history = historyResponse?.items || [];
  const historyCount = historyResponse?.total_unfiltered || 0;
  const historyMatchCount = historyResponse?.pagination.total || 0;
  const historyActions = historyResponse?.actions || [];
  const histItems = history;
  const histTotal = historyResponse?.pagination.total_pages || 1;
  const histSafe = historyResponse?.pagination.page || histPage;
  const histPage_ = history;
  const { data: notesData, isError: notesFailed, refetch: refetchNotes } = useQuery({
    queryKey: ["server", id, "notes"],
    queryFn: () => api.getServerNotes(id),
    enabled: !!server && hasCap(profile, "canViewNotes"),
  });
  const { data: customTasks, isPending: customTasksLoading, isError: customTasksFailed, refetch: refetchCustomTasks } = useQuery({
    queryKey: ["server", id, "customTasks"],
    queryFn: () =>
      api.getCustomUpdateTasks(id) as unknown as Promise<CustomTask[]>,
    enabled: !!server && hasCap(profile, "canViewCustomUpdates"),
  });
  // Older installations returned an object for an empty task list. Keep the
  // detail view usable while those instances are being upgraded.
  const customTaskList = Array.isArray(customTasks) ? customTasks : [];
  // ── Image update cache ──────────────────────────────────────
  const [imageCatalogRevision, setImageCatalogRevision] = useState(0);
  const [imageCatalog, setImageCatalog] = useState<{ updated_at?: string | null; source?: string; stale?: boolean } | null>(null);
  const [imageUpdates, setImageUpdates] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    // The host query resolves after the first render on a browser reload. By
    // depending on the resolved host ID (not only the URL ID), the persisted
    // image-update cache is loaded once the host is actually available.
    setImageUpdates({});
    setImageCatalog(null);
    if (!server?.id || !hasCap(profile, "canViewDocker") || !hasCap(profile, "canViewUpdates"))
      return () => {
        cancelled = true;
      };
  
    api
      .getCachedImageUpdates(id)
      .then((r: unknown) => {
        if (cancelled) return;
        const res = r as {
          updated_at?: string | null; source?: string; stale?: boolean;
          results?: {
            container_name?: string;
            image: string;
            status: string;
          }[];
        };
        const m: Record<string, string> = {};
        (res?.results || []).forEach((result) => {
          m[result.image] = result.status;
          if (result.container_name) m[result.container_name] = result.status;
        });
        setImageUpdates(m);
        setImageCatalog(res);
      })
      .catch(() => {
        // A failed cache read must not reuse results from a previously viewed
        // host. The last valid cache is still kept server-side for the next read.
        if (!cancelled) setImageUpdates({});
      });
    return () => {
      cancelled = true;
    };
  }, [id, profile, server?.id, imageCatalogRevision]);
  
  // ── Notes state ─────────────────────────────────────────────
  const [notes, setNotes] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const renderedNotes = useMemo(() => {
    if (!notes.trim()) return "";
    return DOMPurify.sanitize(marked.parse(notes, { async: false }) as string);
  }, [notes]);
  const [notesBase, setNotesBase] = useState<(Awaited<ReturnType<typeof api.getServerNotes>> & { host: string }) | null>(null);
  const notesDirty = Boolean(notesBase?.host === id && notes !== notesBase.notes);

  useEffect(() => {
    if (notesData && (!notesBase || notesBase.host !== id)) {
      setNotes(notesData.notes);
      setNotesBase({ ...notesData, host: id });
    }
  }, [id, notesData, notesBase]);
  const notesViewRef = useRef({ host: id });
  if (notesViewRef.current.host !== id) notesViewRef.current = { host: id };
  const saveNotesMut = useMutation({
    mutationFn: async (text: string) => {
      const view = notesViewRef.current;
      const host = view.host;
      const result = await api.saveServerNotes(host, text, notesBase?.revision ?? -1);
      return { host, view, result };
    },
    onSuccess: ({ host, view, result }) => {
      qc.setQueryData<typeof result>(['server', host, 'notes'], current => newestNotesRevision(current, result));
      qc.invalidateQueries({ queryKey: ['server', host, 'notes-history'] });
      if (notesViewRef.current !== view) return;
      setNotesBase({ ...result, host });
      showToast(t('det.notesSaved'), 'success');
    },
    onMutate: () => notesViewRef.current,
    onError: (error: Error, _variables, view) => { if (notesViewRef.current === view) showToast(error.message, 'error'); },
  });
  const reloadNotesMut = useMutation({
    mutationFn: async () => {
      const view = notesViewRef.current;
      const host = view.host;
      return { host, view, result: await api.getServerNotes(host) };
    },
    onSuccess: ({ host, view, result }) => {
      qc.setQueryData<typeof result>(['server', host, 'notes'], current => newestNotesRevision(current, result));
      if (notesViewRef.current !== view) return;
      setNotes(result.notes);
      setNotesBase({ ...result, host });
      saveNotesMut.reset();
    },
    onMutate: () => notesViewRef.current,
    onError: (error: Error, _variables, view) => { if (notesViewRef.current === view) showToast(error.message, 'error'); },
  });

  // ── Mutations ───────────────────────────────────────────────
  const runUpdateMut = useMutation({
    mutationFn: () =>
      api.runUpdate(id) as unknown as Promise<{ historyId: string }>,
    onMutate: () =>
      startActionRun(`${t("det.updates")} · ${server?.name || ""}`),
    onSuccess: (data, _variables, requestId) => {
      setActionRun((prev) =>
        bindActionHistory(prev, requestId, data.historyId),
      );
      void qc.invalidateQueries({ queryKey: ["server", id] });
    },
    onError: (e: Error, _variables, requestId) => {
      setActionRun((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              status: "failed",
              lines: [
                ...prev.lines,
                {
                  text: t("common.errorPrefix", { msg: e.message }),
                  cls: "text-red-400",
                },
              ],
            }
          : prev,
      );
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  const runRebootMut = useMutation({
    mutationFn: () =>
      api.runReboot(id) as unknown as Promise<{ historyId: string }>,
    onMutate: () =>
      startActionRun(`${t("det.reboot")} · ${server?.name || ""}`),
    onSuccess: (data, _variables, requestId) => {
      setActionRun((prev) =>
        bindActionHistory(prev, requestId, data.historyId),
      );
      showToast(t("det.rebootStarted"), "success");
    },
    onError: (e: Error, _variables, requestId) => {
      setActionRun((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              status: "failed",
              lines: [
                ...prev.lines,
                {
                  text: t("common.errorPrefix", { msg: e.message }),
                  cls: "text-red-400",
                },
              ],
            }
          : prev,
      );
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  const proxmoxRebootMut = useMutation({
    mutationFn: () =>
      apiFetch(`/opentofu/managed-servers/${encodeURIComponent(id)}/power`, {
        method: "POST",
        body: { action: "reboot" },
      }),
    onSuccess: () => {
      showToast("Proxmox restart started.", "success");
      void qc.invalidateQueries({ queryKey: ["server", id] });
      void qc.invalidateQueries({ queryKey: ["opentofu", "infrastructure"] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const testConnMut = useMutation({
    mutationFn: () => api.testConnection(id),
    onSuccess: () => {
      showToast(t("det.reachable"), "success");
      void qc.invalidateQueries({ queryKey: ["server", id] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const resetHostKeyMut = useMutation({
    mutationFn: () =>
      api.resetServerHostKey(id) as unknown as Promise<{ removed?: string[] }>,
    onSuccess: (r) =>
      showToast(
        t("srv.resetHostKeyDone", {
          entries: r.removed?.join(", ") || t("srv.resetHostKeyNoEntries"),
        }),
        "success",
      ),
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const deleteServerMut = useMutation({
    mutationFn: () => api.deleteServer(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers" });
      showToast(t("srv.deleted"), "success");
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const restartContainerMut = useMutation({
    mutationFn: (name: string) =>
      api.restartContainer(id, name) as unknown as Promise<{
        historyId: string;
      }>,
    onMutate: (name) => startActionRun(`${t("det.output")} · ${name}`),
    onSuccess: (data, _variables, requestId) => {
      setActionRun((prev) =>
        bindActionHistory(prev, requestId, data.historyId),
      );
    },
    onError: (e: Error, _variables, requestId) => {
      setActionRun((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              status: "failed",
              lines: [
                ...prev.lines,
                {
                  text: t("common.errorPrefix", { msg: e.message }),
                  cls: "text-red-400",
                },
              ],
            }
          : prev,
      );
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  
  // ── Container logs state ────────────────────────────────────
  const [logsContainer, setLogsContainer] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState("");
  const [logsTail, setLogsTail] = useState(200);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const logsRequestRef = useRef(0);
  
  const loadLogs = useCallback(
    async (container: string, tail = 200) => {
      const requestId = ++logsRequestRef.current;
      setLogsContainer(container);
      setLogsContent("");
      setLogsError(null);
      setLogsLoading(true);
      try {
        const r = await api.getContainerLogs(id, container, tail);
        if (requestId === logsRequestRef.current) {
          setLogsContent((r as { logs: string }).logs || "");
        }
      } catch (e) {
        if (requestId === logsRequestRef.current) {
          setLogsError((e as Error).message);
        }
      }
      if (requestId === logsRequestRef.current) setLogsLoading(false);
    },
    [id],
  );
  
  // ── Custom task dialog ──────────────────────────────────────
  const [taskDialog, setTaskDialog] = useState<{
    open: boolean;
    task: CustomTask | null;
  }>({ open: false, task: null });
  const [taskForm, setTaskForm] = useState(() => customTaskDraft());
  const taskEnvironment = useUi(state => state.environmentId);
  const taskContext = useRef<{ dialog: typeof taskDialog | null; host: string; environment: string }>({ dialog: null, host: id, environment: taskEnvironment });
  useEffect(() => {
    if (taskDialog.open && taskContext.current.dialog !== taskDialog) {
      taskContext.current = { dialog: taskDialog, host: id, environment: taskEnvironment };
      setTaskForm(customTaskDraft(taskDialog.task));
    }
  }, [taskDialog, id, taskEnvironment]);
  const taskDirty = taskDialog.open && customTaskDirty(taskForm, taskDialog.task);
  const taskContextChanged = taskDialog.open && (taskContext.current.host !== id || taskContext.current.environment !== taskEnvironment);
  useUnsavedChanges(notesDirty || taskDirty);

  const saveTaskMut = useMutation({
    mutationFn: async () => {
      if (taskContextChanged) throw new Error('Host or environment changed. Return to the original context or reopen this form.');
      const data = {
        ...taskForm,
        github_repo: taskForm.github_repo || null,
        trigger_output: taskForm.trigger_output || null,
        latest_command: taskForm.latest_command || null,
        check_command: taskForm.check_command || null,
      };
      if (taskDialog.task)
        await api.updateCustomUpdateTask(id, taskDialog.task.id, data);
      else await api.createCustomUpdateTask(id, data);
    },
    onSuccess: () => {
      showToast(t("det.taskSaved"), "success");
      setTaskDialog({ open: false, task: null });
      void qc.invalidateQueries({ queryKey: ["server", id, "customTasks"] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  
  const deleteTaskMut = useMutation({
    mutationFn: (taskId: string) => api.deleteCustomUpdateTask(id, taskId),
    onSuccess: () => {
      showToast(t("det.taskDeleted"), "success");
      void qc.invalidateQueries({ queryKey: ["server", id, "customTasks"] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  
  const checkTaskMut = useMutation({
    mutationFn: (taskId: string) => api.checkCustomUpdateTask(id, taskId),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["server", id, "customTasks"] }),
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  
  const runTaskMut = useMutation({
    mutationFn: (taskId: string) =>
      api.runCustomUpdateTask(id, taskId) as unknown as Promise<{
        historyId: string;
      }>,
    onMutate: (taskId) => {
      const task = (Array.isArray(customTasks) ? customTasks : []).find(
        (t2) => t2.id === taskId,
      );
      return startActionRun(
        `${t("det.output")} · ${task?.name || t("det.customUpdates")}`,
      );
    },
    onSuccess: (data, _variables, requestId) => {
      setActionRun((prev) =>
        bindActionHistory(prev, requestId, data.historyId),
      );
    },
    onError: (e: Error, _variables, requestId) => {
      setActionRun((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              status: "failed",
              lines: [
                ...prev.lines,
                {
                  text: t("common.errorPrefix", { msg: e.message }),
                  cls: "text-red-400",
                },
              ],
            }
          : prev,
      );
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  
  // ── Check image updates ─────────────────────────────────────
  const checkImageMut = useMutation({
    onMutate: () => updateCheckView.current,
    mutationFn: () =>
      api.checkImageUpdates(id) as unknown as Promise<
        { container_name?: string; image: string; status: string }[]
      >,
    onSuccess: (results, _variables, origin) => {
      if (!origin) return;
      void qc.invalidateQueries({ queryKey: ["server", origin.host] });
      if (updateCheckView.current !== origin) return;
      const m: Record<string, string> = {};
      results.forEach((r) => {
        m[r.image] = r.status;
        if (r.container_name) m[r.container_name] = r.status;
      });
      setImageUpdates(m);
      setImageCatalog(null);
      setImageCatalogRevision(value => value + 1);
      const summary = imageCheckSummary(results);
      showToast(summary.message, { kind: summary.kind, description: summary.description });
    },
    onError: (e: Error, _variables, origin) => {
      if (updateCheckView.current !== origin) return;
      showToast(t("det.imageUpdatesCheckFailed"), {
        kind: "error",
        description: e.message,
      });
    },
  });
  
  // A manual package check deliberately bypasses the stale-while-revalidate
  // cache. The status panel below stays visible until this exact request has
  // either returned fresh data or reported an error.
  const checkSystemUpdatesMut = useMutation({
    onMutate: () => updateCheckView.current,
    mutationFn: () =>
      apiFetch<UpdateCatalog>(`/servers/${encodeURIComponent(id)}/updates?include_meta=1&force=1`).then(verifiedOsCheck),
    onSuccess: (results, _variables, origin) => {
      if (!origin) return;
      qc.setQueryData(["server", origin.host, "updates"], results);
      if (updateCheckView.current !== origin) return;
      const nested = !Array.isArray(results) ? results.updates : [];
      const rows = Array.isArray(results)
        ? results
        : Array.isArray(nested)
          ? nested
          : [];
      const available = rows.filter((update) => !update.phased).length;
      showToast(
        t("det.systemUpdatesChecked", { count: available }),
        available > 0 ? "warning" : "success",
      );
    },
    onError: (e: Error, _variables, origin) => {
      if (updateCheckView.current !== origin) return;
      showToast(t("det.systemUpdatesCheckFailed"), {
        kind: "error",
        description: e.message,
      });
    },
  });
  
  // Mutation observers belong to the visible host; resetting does not cancel
  // the remote check or its origin-scoped cache update.
  const resetImageCheck = checkImageMut.reset;
  const resetSystemCheck = checkSystemUpdatesMut.reset;
  useEffect(() => {
    resetImageCheck();
    resetSystemCheck();
  }, [id, resetImageCheck, resetSystemCheck]);

  // ── Compose actions ─────────────────────────────────────────
  const composeActionMut = useMutation({
    mutationFn: ({ dir, action }: { dir: string; action: string }) =>
      api.composeAction(id, dir, action) as unknown as Promise<{
        historyId: string;
      }>,
    onMutate: ({ action, dir }) =>
      startActionRun(`${action === "up" ? "Start stack / apply changes" : action === "down" ? "Stop and remove stack containers" : action === "pull" ? "Pull stack images" : action} · ${server?.name || ""} · ${dir}`),
    onSuccess: (data, _variables, requestId) => {
      setActionRun((prev) =>
        bindActionHistory(prev, requestId, data.historyId),
      );
    },
    onError: (e: Error, _variables, requestId) => {
      setActionRun((prev) =>
        prev && prev.requestId === requestId
          ? {
              ...prev,
              status: "failed",
              lines: [
                ...prev.lines,
                {
                  text: t("common.errorPrefix", { msg: e.message }),
                  cls: "text-red-400",
                },
              ],
            }
          : prev,
      );
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  
  // ── Compose editor dialog ───────────────────────────────────
  type ComposeDraft = { open: boolean; mode: "edit" | "add"; dir: string; content: string; loading: boolean; loadError?: string };
  const [composeDrafts, setComposeDrafts] = useState<Record<string, ComposeDraft>>({});
  const emptyComposeDraft = useMemo<ComposeDraft>(() => ({ open: false, mode: "add", dir: "", content: "", loading: false }), [id]);
  const composeDialog = composeDrafts[id] || emptyComposeDraft;
  const setComposeDialog = useCallback((action: ComposeDraft | ((previous: ComposeDraft) => ComposeDraft)) => {
    setComposeDrafts(previous => {
      const current = previous[id] || emptyComposeDraft;
      const next = typeof action === "function" ? action(current) : action;
      return next === current ? previous : { ...previous, [id]: next };
    });
  }, [id, emptyComposeDraft]);
  useEffect(() => () => {
    // An abandoned file read has no editable content to preserve. Its late
    // response is rejected by the view guard; discard the pending placeholder.
    setComposeDrafts(previous => {
      if (!previous[id]?.loading) return previous;
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, [id]);

  const [confirmDeleteStack, setConfirmDeleteStack] = useState<{
    proj: string;
    dir: string;
  } | null>(null);
  const deleteStackMut = useMutation({
    mutationFn: (dir: string) => api.deleteComposeStack(id, dir),
    onSuccess: () => {
      showToast(t("det.stackRemoved"), "success");
      setConfirmDeleteStack(null);
      void qc.invalidateQueries({ queryKey: ["server", id, "docker"] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  
  const openEditCompose = useCallback(
    async (dir: string) => {
      const origin = updateCheckView.current;
      const draft = { open: true, mode: "edit" as const, dir, content: "", loading: true };
      setComposeDialog(draft);
      try {
        const r = (await api.getDockerCompose(id, dir)) as unknown as { content: string };
        if (!r || typeof r.content !== "string") throw new Error("Compose response did not contain file content.");
        if (updateCheckView.current !== origin) return;
        setComposeDialog(previous => previous === draft ? { ...previous, content: r.content || "", loading: false } : previous);
      } catch (e) {
        if (updateCheckView.current !== origin) return;
        showToast(t("common.errorPrefix", { msg: (e as Error).message }), "error");
        setComposeDialog(previous => previous === draft ? { ...previous, loading: false, loadError: (e as Error).message || "Compose file could not be loaded." } : previous);
      }
    },
    [id, t, setComposeDialog],
  );

  const saveComposeMut = useMutation({
    onMutate: () => ({ view: updateCheckView.current, draft: composeDialog }),
    mutationFn: () => {
      if (composeDialog.loading || composeDialog.loadError) throw new Error("Load the Compose file successfully before saving.");
      return api.writeDockerCompose(id, composeDialog.dir, composeDialog.content);
    },
    onSuccess: (_result, _variables, origin) => {
      if (!origin) return;
      void qc.invalidateQueries({ queryKey: ["server", origin.view.host, "docker"] });
      if (updateCheckView.current !== origin.view) return;
      showToast(t("det.composeSaved"), "success");
      setComposeDialog(previous => previous === origin.draft ? { ...previous, open: false } : previous);
    },
    onError: (e: Error, _variables, origin) => {
      if (updateCheckView.current !== origin?.view) return;
      showToast(t("common.errorPrefix", { msg: e.message }), "error");
    },
  });
  const resetComposeSave = saveComposeMut.reset;
  useEffect(() => { resetComposeSave(); }, [id, resetComposeSave]);

  // ── Latency ping ────────────────────────────────────────────
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyCheckedAt, setLatencyCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLatencyMs(null);
    setLatencyCheckedAt(null);
    (async () => {
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        try {
          await api.ping();
          times.push(performance.now() - start);
        } catch {
          /* ignore */
        }
      }
      if (!cancelled && times.length > 0) {
        setLatencyMs(
          Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        );
        setLatencyCheckedAt(new Date().toISOString());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);
  
  // ── Derived ─────────────────────────────────────────────────
  const ramPct = info?.ram_total_mb
    ? Math.round(((info.ram_used_mb ?? 0) / info.ram_total_mb) * 100)
    : null;
  const diskPct = info?.disk_total_gb
    ? Math.round(((info.disk_used_gb ?? 0) / info.disk_total_gb) * 100)
    : null;
  const cpuPct = info?.cpu_usage_pct ?? null;
  const healthThresholds = {
    cpu: server?.attention?.thresholds?.warning?.cpu ?? 90,
    ram: server?.attention?.thresholds?.warning?.ram ?? 85,
    disk: server?.attention?.thresholds?.warning?.disk ?? 85,
    storage: server?.attention?.thresholds?.warning?.storage ?? 85,
  };
  
  const updatesList = useMemo(() => {
    if (!rawUpdates) return [];
    const nested = !Array.isArray(rawUpdates)
      ? rawUpdates.updates
      : [];
    const arr = Array.isArray(rawUpdates)
      ? rawUpdates
      : Array.isArray(nested)
        ? nested
        : [];
    return arr.filter((u: Record<string, unknown>) => !u.phased) as {
      package: string;
      current_version?: string | null;
      version?: string;
      phased?: boolean;
      _cached?: boolean;
    }[];
  }, [rawUpdates]);
  const phasedList = useMemo(() => {
    if (!rawUpdates) return [];
    const nested = !Array.isArray(rawUpdates)
      ? rawUpdates.updates
      : [];
    const arr = Array.isArray(rawUpdates)
      ? rawUpdates
      : Array.isArray(nested)
        ? nested
        : [];
    return arr.filter((u: Record<string, unknown>) => u.phased) as {
      package: string;
      current_version?: string | null;
      version?: string;
    }[];
  }, [rawUpdates]);
  
  const containers = Array.isArray(dockerContainers)
    ? (dockerContainers as ContainerRow[])
    : [];
  const activeLogContainer = logsContainer
    ? containers.find((container) => container.container_name === logsContainer)
    : undefined;
  const stacks = useMemo(() => {
    const map: Record<string, { dir: string; containers: ContainerRow[] }> = {};
    const standalone: ContainerRow[] = [];
    containers.forEach((c) => {
      if (c.compose_project && c.compose_working_dir) {
        if (!map[c.compose_project])
          map[c.compose_project] = {
            dir: c.compose_working_dir,
            containers: [],
          };
        map[c.compose_project].containers.push(c);
      } else standalone.push(c);
    });
    return { map, standalone };
  }, [containers]);
  
  
  return {
    t,
    qc,
    params,
    id,
    navigate,
    terminalOpen,
    setTerminalOpen,
    editOpen,
    setEditOpen,
    confirmRunUpdate,
    setConfirmRunUpdate,
    confirmResetHostKey,
    setConfirmResetHostKey,
    confirmReboot,
    setConfirmReboot,
    confirmDelete,
    setConfirmDelete,
    confirmDeleteTask,
    setConfirmDeleteTask,
    confirmComposeDown,
    setConfirmComposeDown,
    confirmRestartContainer,
    setConfirmRestartContainer,
    actionRun,
    setActionRun,
    profile,
    settings,
    timeFormat,
    hour12,
    serverKnown,
    canViewManagementRelationships,
    deploymentData,
    managedDeployments,
    deploymentContextLoading,
    deploymentContextFailed,
    refetchDeploymentContext,
    managedProxmoxDeployment,
    startActionRun,
    rawServer,
    isLoading,
    server,
    info,
    refetchInfo,
    fetchingInfo,
    infoFailed,
    infoError,
    ipamReservationData,
    ipamReservations,
    dockerContainers,
    fetchingDocker,
    rawUpdates,
    history,
    notesData,
    notesBaseline: notesBase?.host === id ? notesBase : null,
    notesFailed,
    refetchNotes,
    notesReady: notesBase?.host === id && Boolean(notesData),
    notesDirty,
    reloadNotesMut,
    customTasks,
    customTasksLoading,
    customTasksFailed,
    refetchCustomTasks,
    customTaskList,
    imageUpdates,
    setImageUpdates,
    imageCatalog,
    notes,
    setNotes,
    notesEditing,
    setNotesEditing,
    renderedNotes,
    saveNotesMut,
    runUpdateMut,
    runRebootMut,
    proxmoxRebootMut,
    testConnMut,
    resetHostKeyMut,
    deleteServerMut,
    restartContainerMut,
    logsContainer,
    setLogsContainer,
    logsContent,
    setLogsContent,
    logsTail,
    setLogsTail,
    logsLoading,
    setLogsLoading,
    logsError,
    setLogsError,
    logsRequestRef,
    loadLogs,
    taskDialog,
    setTaskDialog,
    taskForm,
    taskDirty,
    taskContextChanged,
    setTaskForm,
    saveTaskMut,
    deleteTaskMut,
    checkTaskMut,
    runTaskMut,
    checkImageMut,
    checkSystemUpdatesMut,
    composeActionMut,
    composeDialog,
    setComposeDialog,
    confirmDeleteStack,
    setConfirmDeleteStack,
    deleteStackMut,
    openEditCompose,
    saveComposeMut,
    latencyMs,
    setLatencyMs,
    latencyCheckedAt,
    HIST_PAGE_SIZE,
    histPage,
    setHistPage,
    histItems,
    historyFilters,
    historyActions,
    setHistoryFilters,
    historyCount,
    historyMatchCount,
    historyLoading,
    historyFetching,
    historyRows: Array.isArray(history) ? history : [],
    historyFailed,
    refetchHistory,
    histTotal,
    histSafe,
    histPage_,
    ramPct,
    diskPct,
    cpuPct,
    healthThresholds,
    updatesList,
    phasedList,
    containers,
    activeLogContainer,
    stacks,
  } as const;
}

export type ServerDetailController = ReturnType<typeof useServerDetailController>;
