import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { api, apiFetch, ApiError } from "@/lib/api";
import { ws } from "@/lib/ws";
import { hasCap, useProfile, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { OutputLine, RunStatus } from "@/components/ui/action-run-dialog";
import type {
  AgentStatus,
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
  const [confirmAgentInstall, setConfirmAgentInstall] = useState(false);
  const [confirmAgentRemove, setConfirmAgentRemove] = useState(false);
  const [confirmRestartContainer, setConfirmRestartContainer] = useState<
    string | null
  >(null);
  const [actionRun, setActionRun] = useState<{
    title: string;
    status: RunStatus;
    lines: OutputLine[];
    historyId?: string;
  } | null>(null);
  const { data: profile } = useProfile();
  const { data: settings } = useSettings();
  const agentEnabled = !!(settings as Record<string, unknown>)?.agentEnabled;
  const timeFormat = useUi((s) => s.timeFormat);
  const hour12 = timeFormat === "12h";
  // Do not start detail sub-queries until the primary host exists. Besides
  // reducing requests, this keeps a stale browser URL from producing a wall
  // of 404s while the normal not-found state is rendered.
  const serverKnown = Boolean(qc.getQueryData(["server", id]));
  const openTofuAvailable = hasCap(profile, "canViewDeployments") || hasCap(profile, "canManageDeployments");
  const { data: deploymentData } = useQuery<ManagedDeploymentResponse>({
    queryKey: ["server", id, "deployment-context"],
    queryFn: () =>
      apiFetch(`/opentofu/managed-servers/${encodeURIComponent(id)}`),
    enabled: Boolean(id && serverKnown && openTofuAvailable),
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
    setActionRun({ title, status: "running", lines: [], historyId });
  }, []);
  
  // WS listener for action output/completion
  useEffect(() => {
    ws.connect();
    const unsub = ws.subscribe((raw) => {
      const data = raw as Record<string, unknown>;
      setActionRun((prev) => {
        if (!prev || prev.status !== "running") return prev;
        if (prev.historyId && data.historyId !== prev.historyId) return prev;
  
        if (data.type === "update_output") {
          const text = String(data.data ?? "");
          const lines = text.split("\n").filter((l) => l !== "");
          return {
            ...prev,
            lines: [
              ...prev.lines,
              ...lines.map((l) => ({
                text: l,
                cls: data.stream === "stderr" ? "text-amber-400" : undefined,
              })),
            ],
          };
        }
        if (data.type === "update_complete") {
          const success = !!data.success;
          return { ...prev, status: success ? "success" : "failed" };
        }
        if (data.type === "update_error") {
          return {
            ...prev,
            status: "failed",
            lines: [
              ...prev.lines,
              {
                text: String(data.error ?? "Unknown error"),
                cls: "text-red-400",
              },
            ],
          };
        }
        return prev;
      });
    });
    return unsub;
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
      api.getServerUpdates(id) as unknown as Promise<
        Record<string, unknown>[] | { updates: Record<string, unknown>[] }
      >,
    enabled: !!server && hasCap(profile, "canViewUpdates"),
    staleTime: 60_000,
  });
  const { data: history } = useQuery({
    queryKey: ["server", id, "history"],
    queryFn: () => api.getServerHistory(id) as unknown as Promise<HistoryRow[]>,
    enabled: !!server && hasCap(profile, "canViewServerHistory"),
  });
  const { data: notesData } = useQuery({
    queryKey: ["server", id, "notes"],
    queryFn: () => api.getServerNotes(id),
    enabled: !!server && hasCap(profile, "canViewNotes"),
  });
  const { data: customTasks } = useQuery({
    queryKey: ["server", id, "customTasks"],
    queryFn: () =>
      api.getCustomUpdateTasks(id) as unknown as Promise<CustomTask[]>,
    enabled: !!server && hasCap(profile, "canViewCustomUpdates"),
  });
  // Older installations returned an object for an empty task list. Keep the
  // detail view usable while those instances are being upgraded.
  const customTaskList = Array.isArray(customTasks) ? customTasks : [];
  const { data: agentStatus, refetch: refetchAgent } = useQuery({
    queryKey: ["server", id, "agent"],
    queryFn: () => api.getAgentStatus(id) as unknown as Promise<AgentStatus>,
    enabled: !!server && agentEnabled && profile?.role === "admin",
    staleTime: 30_000,
  });
  // ── Image update cache ──────────────────────────────────────
  const [imageUpdates, setImageUpdates] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    // The host query resolves after the first render on a browser reload. By
    // depending on the resolved host ID (not only the URL ID), the persisted
    // image-update cache is loaded once the host is actually available.
    setImageUpdates({});
    if (!server?.id || !hasCap(profile, "canViewDocker"))
      return () => {
        cancelled = true;
      };
  
    api
      .getCachedImageUpdates(id)
      .then((r: unknown) => {
        if (cancelled) return;
        const res = r as {
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
      })
      .catch(() => {
        // A failed cache read must not reuse results from a previously viewed
        // host. The last valid cache is still kept server-side for the next read.
        if (!cancelled) setImageUpdates({});
      });
    return () => {
      cancelled = true;
    };
  }, [id, profile, server?.id]);
  
  // ── Notes state ─────────────────────────────────────────────
  const [notes, setNotes] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const renderedNotes = useMemo(() => {
    if (!notes.trim()) return "";
    return DOMPurify.sanitize(marked.parse(notes, { async: false }) as string);
  }, [notes]);
  const notesTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (notesData?.notes !== undefined) setNotes(notesData.notes);
  }, [notesData?.notes]);
  const saveNotesMut = useMutation({
    mutationFn: (text: string) => api.saveServerNotes(id, text),
    onSuccess: () => showToast(t("det.notesSaved"), "success"),
    onError: () => showToast(t("det.notesError"), "error"),
  });
  const autoSaveNotes = useCallback(
    (text: string) => {
      clearTimeout(notesTimer.current);
      notesTimer.current = setTimeout(() => saveNotesMut.mutate(text), 800);
    },
    [saveNotesMut],
  );
  
  // ── Mutations ───────────────────────────────────────────────
  const runUpdateMut = useMutation({
    mutationFn: () =>
      api.runUpdate(id) as unknown as Promise<{ historyId: string }>,
    onMutate: () =>
      startActionRun(`${t("det.updates")} · ${server?.name || ""}`),
    onSuccess: (data) => {
      setActionRun((prev) =>
        prev ? { ...prev, historyId: data.historyId } : prev,
      );
      void qc.invalidateQueries({ queryKey: ["server", id] });
    },
    onError: (e: Error) => {
      setActionRun((prev) =>
        prev
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
    onSuccess: (data) => {
      setActionRun((prev) =>
        prev ? { ...prev, historyId: data.historyId } : prev,
      );
      showToast(t("det.rebootStarted"), "success");
    },
    onError: (e: Error) => {
      setActionRun((prev) =>
        prev
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
    onSuccess: (data) => {
      setActionRun((prev) =>
        prev ? { ...prev, historyId: data.historyId } : prev,
      );
    },
    onError: (e: Error) => {
      setActionRun((prev) =>
        prev
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
  const [taskForm, setTaskForm] = useState({
    name: "",
    type: "script",
    github_repo: "",
    check_command: "",
    update_command: "",
    trigger_output: "",
    latest_command: "",
  });
  
  useEffect(() => {
    if (taskDialog.open) {
      const t = taskDialog.task;
      setTaskForm({
        name: t?.name || "",
        type: t?.type || "script",
        github_repo: t?.github_repo || "",
        check_command: t?.check_command || "",
        update_command: t?.update_command || "",
        trigger_output: t?.trigger_output || "",
        latest_command: t?.latest_command || "",
      });
    }
  }, [taskDialog]);
  
  const saveTaskMut = useMutation({
    mutationFn: async () => {
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
    onSuccess: () =>
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
      startActionRun(
        `${t("det.output")} · ${task?.name || t("det.customUpdates")}`,
      );
    },
    onSuccess: (data) => {
      setActionRun((prev) =>
        prev ? { ...prev, historyId: data.historyId } : prev,
      );
    },
    onError: (e: Error) => {
      setActionRun((prev) =>
        prev
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
    mutationFn: () =>
      api.checkImageUpdates(id) as unknown as Promise<
        { container_name?: string; image: string; status: string }[]
      >,
    onSuccess: (results) => {
      const m: Record<string, string> = {};
      results.forEach((r) => {
        m[r.image] = r.status;
        if (r.container_name) m[r.container_name] = r.status;
      });
      setImageUpdates(m);
      const available = results.filter(
        (r) => r.status === "update_available",
      ).length;
      showToast(
        t("det.imageUpdatesChecked", { checked: results.length, available }),
        available > 0 ? "warning" : "success",
      );
      void qc.invalidateQueries({ queryKey: ["server", id, "docker"] });
    },
    onError: (e: Error) =>
      showToast(t("det.imageUpdatesCheckFailed"), {
        kind: "error",
        description: e.message,
      }),
  });
  
  // A manual package check deliberately bypasses the stale-while-revalidate
  // cache. The status panel below stays visible until this exact request has
  // either returned fresh data or reported an error.
  const checkSystemUpdatesMut = useMutation({
    mutationFn: () =>
      api.getServerUpdates(id, true) as unknown as Promise<
        Record<string, unknown>[] | { updates: Record<string, unknown>[] }
      >,
    onSuccess: (results) => {
      qc.setQueryData(["server", id, "updates"], results);
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
    onError: (e: Error) =>
      showToast(t("det.systemUpdatesCheckFailed"), {
        kind: "error",
        description: e.message,
      }),
  });
  
  // ── Compose actions ─────────────────────────────────────────
  const composeActionMut = useMutation({
    mutationFn: ({ dir, action }: { dir: string; action: string }) =>
      api.composeAction(id, dir, action) as unknown as Promise<{
        historyId: string;
      }>,
    onMutate: ({ action }) =>
      startActionRun(`docker compose ${action} · ${server?.name || ""}`),
    onSuccess: (data) => {
      setActionRun((prev) =>
        prev ? { ...prev, historyId: data.historyId } : prev,
      );
    },
    onError: (e: Error) => {
      setActionRun((prev) =>
        prev
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
  const [composeDialog, setComposeDialog] = useState<{
    open: boolean;
    mode: "edit" | "add";
    dir: string;
    content: string;
    loading: boolean;
  }>({ open: false, mode: "add", dir: "", content: "", loading: false });
  
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
      setComposeDialog({
        open: true,
        mode: "edit",
        dir,
        content: "",
        loading: true,
      });
      try {
        const r = (await api.getDockerCompose(id, dir)) as unknown as {
          content: string;
        };
        setComposeDialog((prev) => ({
          ...prev,
          content: r.content || "",
          loading: false,
        }));
      } catch (e) {
        showToast(
          t("common.errorPrefix", { msg: (e as Error).message }),
          "error",
        );
        setComposeDialog((prev) => ({ ...prev, loading: false }));
      }
    },
    [id, t],
  );
  
  const saveComposeMut = useMutation({
    mutationFn: () =>
      api.writeDockerCompose(id, composeDialog.dir, composeDialog.content),
    onSuccess: () => {
      showToast(t("det.composeSaved"), "success");
      setComposeDialog((prev) => ({ ...prev, open: false }));
      void qc.invalidateQueries({ queryKey: ["server", id, "docker"] });
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  
  // ── Latency ping ────────────────────────────────────────────
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);
  
  // ── Agent mutations ─────────────────────────────────────────
  const [agentUrl, setAgentUrl] = useState("");
  const [agentCa, setAgentCa] = useState("");
  useEffect(() => {
    if (agentStatus?.shipyardUrl) setAgentUrl(agentStatus.shipyardUrl);
    else setAgentUrl(window.location.origin);
  }, [agentStatus]);
  
  const agentInstallMut = useMutation({
    mutationFn: () =>
      api.installAgent(id, {
        mode: "push",
        interval: 30,
        shipyard_url: agentUrl,
        shipyard_ca_cert_pem: agentCa,
      }),
    onSuccess: () => {
      showToast(t("det.agentInstallStarted"), "success");
      void refetchAgent();
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const agentUpdateMut = useMutation({
    mutationFn: () => api.updateAgent(id),
    onSuccess: () => {
      showToast(t("det.agentUpdateStarted"), "success");
      void refetchAgent();
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const agentConfigMut = useMutation({
    mutationFn: () =>
      api.configureAgent(id, {
        mode: agentStatus?.mode || "push",
        interval: agentStatus?.interval || 30,
        shipyard_url: agentUrl,
        shipyard_ca_cert_pem: agentCa,
      }),
    onSuccess: () => {
      showToast(t("det.agentConfigureStarted"), "success");
      void refetchAgent();
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const agentRotateMut = useMutation({
    mutationFn: () =>
      api.rotateAgentToken(id, {
        shipyard_url: agentUrl,
        shipyard_ca_cert_pem: agentCa,
      }),
    onSuccess: () => {
      showToast(t("det.agentTokenRotated"), "success");
      void refetchAgent();
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const agentRemoveMut = useMutation({
    mutationFn: () => api.removeAgent(id),
    onSuccess: () => {
      showToast(t("det.agentRemoved"), "success");
      void refetchAgent();
    },
    onError: (e: Error) =>
      showToast(t("common.errorPrefix", { msg: e.message }), "error"),
  });
  const agentBusy =
    agentInstallMut.isPending ||
    agentUpdateMut.isPending ||
    agentConfigMut.isPending ||
    agentRotateMut.isPending ||
    agentRemoveMut.isPending;
  
  // ── History pagination ──────────────────────────────────────
  const HIST_PAGE_SIZE = 25;
  const [histPage, setHistPage] = useState(1);
  const histItems = Array.isArray(history) ? history : [];
  const histTotal = Math.max(1, Math.ceil(histItems.length / HIST_PAGE_SIZE));
  const histSafe = Math.min(histPage, histTotal);
  const histPage_ = histItems.slice(
    (histSafe - 1) * HIST_PAGE_SIZE,
    histSafe * HIST_PAGE_SIZE,
  );
  
  // ── Derived ─────────────────────────────────────────────────
  const ramPct = info?.ram_total_mb
    ? Math.round(((info.ram_used_mb ?? 0) / info.ram_total_mb) * 100)
    : null;
  const diskPct = info?.disk_total_gb
    ? Math.round(((info.disk_used_gb ?? 0) / info.disk_total_gb) * 100)
    : null;
  const cpuPct = info?.cpu_usage_pct ?? null;
  // These visual thresholds are fixed, deliberately local health hints.
  // Shipyard no longer exposes a monitoring/alerting subsystem per host.
  const healthThresholds = { cpu: 90, ram: 85, disk: 85, storage: 85 };
  
  const updatesList = useMemo(() => {
    if (!rawUpdates) return [];
    const nested = !Array.isArray(rawUpdates)
      ? (rawUpdates as Record<string, unknown>).updates
      : [];
    const arr = Array.isArray(rawUpdates)
      ? rawUpdates
      : Array.isArray(nested)
        ? nested
        : [];
    return arr.filter((u: Record<string, unknown>) => !u.phased) as {
      package: string;
      version?: string;
      phased?: boolean;
      _cached?: boolean;
    }[];
  }, [rawUpdates]);
  const phasedList = useMemo(() => {
    if (!rawUpdates) return [];
    const nested = !Array.isArray(rawUpdates)
      ? (rawUpdates as Record<string, unknown>).updates
      : [];
    const arr = Array.isArray(rawUpdates)
      ? rawUpdates
      : Array.isArray(nested)
        ? nested
        : [];
    return arr.filter((u: Record<string, unknown>) => u.phased) as {
      package: string;
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
    confirmAgentInstall,
    setConfirmAgentInstall,
    confirmAgentRemove,
    setConfirmAgentRemove,
    confirmRestartContainer,
    setConfirmRestartContainer,
    actionRun,
    setActionRun,
    profile,
    settings,
    agentEnabled,
    timeFormat,
    hour12,
    serverKnown,
    openTofuAvailable,
    deploymentData,
    managedDeployments,
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
    customTasks,
    customTaskList,
    agentStatus,
    refetchAgent,
    imageUpdates,
    setImageUpdates,
    notes,
    setNotes,
    notesEditing,
    setNotesEditing,
    renderedNotes,
    notesTimer,
    saveNotesMut,
    autoSaveNotes,
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
    agentUrl,
    setAgentUrl,
    agentCa,
    setAgentCa,
    agentInstallMut,
    agentUpdateMut,
    agentConfigMut,
    agentRotateMut,
    agentRemoveMut,
    agentBusy,
    HIST_PAGE_SIZE,
    histPage,
    setHistPage,
    histItems,
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
