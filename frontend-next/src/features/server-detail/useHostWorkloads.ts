import { api } from "@/lib/api";
import { hasCap } from "@/lib/queries";
import { showToast } from "@/lib/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { bindActionHistory } from './action-events';
import { imageCheckSummary } from './image-check-summary';
import type {
  ContainerRow
} from "./server-detail-model";

import type { HostActionContext } from './host-controller-context';

export function useHostWorkloads({ id, server, profile, startActionRun, setActionRun }: HostActionContext) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const updateCheckView = useRef({ host: id });
  if (updateCheckView.current.host !== id) updateCheckView.current = { host: id };
  // ── Stat card queries (lazy-ish but auto) ───────────────────
  const { data: dockerContainers, isFetching: fetchingDocker } = useQuery({
    queryKey: ["server", id, "docker"],
    queryFn: () =>
      api.getServerDocker(id) as unknown as Promise<ContainerRow[]>,
    enabled:
      !!id && hasCap(profile, "canViewDocker") && !!server?.docker_enabled,
    staleTime: 60_000,
  });
  // ── Image update cache ──────────────────────────────────────
  const [imageCatalogRevision, setImageCatalogRevision] = useState(0);
  const [imageCatalog, setImageCatalog] = useState<{ updated_at?: string | null; source?: string; stale?: boolean } | null>(null);
  const [imageUpdates, setImageUpdates] = useState<Record<string, string>>({});
  // Container name → image reference as reported by the check; exclusions are keyed by it.
  const [checkedImages, setCheckedImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    // The host query resolves after the first render on a browser reload. By
    // depending on the resolved host ID (not only the URL ID), the persisted
    // image-update cache is loaded once the host is actually available.
    setImageUpdates({});
    setCheckedImages({});
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
        const images: Record<string, string> = {};
        (res?.results || []).forEach((result) => {
          m[result.image] = result.status;
          images[result.image] = result.image;
          if (result.container_name) { m[result.container_name] = result.status; images[result.container_name] = result.image; }
        });
        setImageUpdates(m);
        setCheckedImages(images);
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
  const emptyComposeDraft = useMemo<ComposeDraft>(() => ({ open: false, mode: "add", dir: "", content: "", loading: false }), []);
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

  const containers = useMemo(() => Array.isArray(dockerContainers) ? dockerContainers : [], [dockerContainers]);
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

  const imageExclusionMut = useMutation({
    mutationFn: ({ image, excluded }: { image: string; excluded: boolean }) => api.setImageCheckExclusion(id, image, excluded),
    onSuccess: (_result, { image, excluded }) => {
      setImageCatalogRevision(value => value + 1);
      void qc.invalidateQueries({ queryKey: ["server", id] });
      void qc.invalidateQueries({ queryKey: ["update-dashboard"] });
      showToast(excluded ? `${image} is excluded from update checks` : `${image} is checked for updates again`, { kind: "success" });
    },
    onError: (e: Error) => showToast(e.message || "Update check setting could not be saved", { kind: "error" }),
  });

  const resetImageCheck = checkImageMut.reset;
  useEffect(() => { resetImageCheck(); }, [id, resetImageCheck]);

  return {
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
  };
}
