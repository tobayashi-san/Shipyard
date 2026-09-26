import { api, apiFetch } from "@/lib/api";
import { hasCap, useProfile, useSettings } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { showToast } from "@/lib/toast";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { ws } from "@/lib/ws";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { bindActionHistory, receiveActionEvent, type TrackedAction } from './action-events';
import type {
  CustomTask,
  IpamReservation,
  ManagedDeploymentResponse,
  ServerDetail,
  ServerInfo
} from "./server-detail-model";
import { parseArrayValue } from "./server-detail-model";
import { useHostCustomUpdates } from './useHostCustomUpdates';
import { useHostHistory } from './useHostHistory';
import { useHostNotes } from './useHostNotes';
import { useHostUpdates } from './useHostUpdates';
import { useHostWorkloads } from './useHostWorkloads';

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
  }, [actionRun, id, qc]);
  
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
  
  const {
    notesData,
    notesFailed,
    refetchNotes,
    notes,
    notesEditing,
    setNotes,
    setNotesEditing,
    renderedNotes,
    notesBase,
    notesDirty,
    saveNotesMut,
    reloadNotesMut,
  } = useHostNotes({ id, server, profile });
  const {
    HIST_PAGE_SIZE,
    histPage,
    setHistPage,
    historyFilters,
    setHistoryFilters,
    historyLoading,
    historyFetching,
    historyFailed,
    refetchHistory,
    history,
    historyCount,
    historyMatchCount,
    historyActions,
    histItems,
    histTotal,
    histSafe,
    histPage_,
  } = useHostHistory({ id, server, profile });
  const {
    customTasks,
    customTasksLoading,
    customTasksFailed,
    refetchCustomTasks,
    customTaskList,
    taskDialog,
    setTaskDialog,
    taskForm,
    setTaskForm,
    taskDirty,
    taskContextChanged,
    saveTaskMut,
    deleteTaskMut,
    checkTaskMut,
    runTaskMut,
  } = useHostCustomUpdates({ id, server, profile, startActionRun, setActionRun });
  const {
    rawUpdates,
    runUpdateMut,
    checkSystemUpdatesMut,
    updatesList,
    phasedList,
  } = useHostUpdates({ id, server, profile, startActionRun, setActionRun });
  const {
    dockerContainers,
    fetchingDocker,
    imageUpdates,
    setImageUpdates,
    checkedImages,
    imageExclusionMut,
    imageCatalog,
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
    checkImageMut,
    composeActionMut,
    composeDialog,
    setComposeDialog,
    confirmDeleteStack,
    setConfirmDeleteStack,
    deleteStackMut,
    openEditCompose,
    saveComposeMut,
    containers,
    activeLogContainer,
    stacks,
  } = useHostWorkloads({ id, server, profile, startActionRun, setActionRun });
  useUnsavedChanges(notesDirty || taskDirty);

  // ── Mutations ───────────────────────────────────────────────
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
    checkedImages,
    imageExclusionMut,
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
