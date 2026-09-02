import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  CheckSquare,
  Box,
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderInput,
  FolderTree,
  Loader2,
  Server,
  Settings2,
  Square,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiFetch } from "@/lib/api";
import { asArray, cn } from "@/lib/utils";
import { useUi } from "@/lib/store";
import {
  buildGroupTree,
  getDescendantIds,
  normalizeServer,
  type GroupNode,
  type ServerGroup,
  type ServerRow,
} from "@/features/servers/server-list-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showToast } from "@/lib/toast";
import { canAccessInfrastructure, useProfile } from "@/lib/queries";

const STORAGE_KEY = "fleet.console.infrastructure-tree.collapsed";
const SERVER_GROUP_QUERY_KEY = "server-groups";

function initialCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(
      Array.isArray(saved)
        ? saved.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function saveCollapsed(next: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* storage unavailable */
  }
}

// Router locations are normally encoded while the IDs returned by the API are
// not. Compare both representations so an endpoint-like platform ID and a
// conventional UUID behave identically in the inventory tree.
function decodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function StatusDot({ status }: { status?: string }) {
  const normalized = String(status || "").toLowerCase();
  const online =
    normalized === "online" ||
    normalized === "connected" ||
    normalized === "running";
  return (
    <span
      aria-label={
        online ? "Online" : normalized === "offline" ? "Offline" : "Unknown"
      }
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        online
          ? "bg-emerald-500"
          : normalized === "offline"
            ? "bg-destructive"
            : "bg-muted-foreground/50",
      )}
    />
  );
}

interface TreeProps {
  compact?: boolean;
  onNavigate?: () => void;
}
interface ProxmoxNode {
  name?: string;
  status?: string;
  fleet_server_id?: string | null;
}
interface ProxmoxInventoryVm {
  node_name?: string;
  vm_id?: string | number;
  name?: string;
  status?: string;
  guest_type?: string;
  fleet_server_id?: string | null;
}
interface ProxmoxCluster {
  id?: string;
  endpoint?: string;
  status?: string;
  connections?: Array<{ name?: string }>;
  nodes?: ProxmoxNode[];
  vms?: ProxmoxInventoryVm[];
}
interface InfrastructureResponse {
  clusters?: ProxmoxCluster[];
  cached?: boolean;
  refreshing?: boolean;
}
export function InfrastructureTree({ compact = false, onNavigate }: TreeProps) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const environmentId = useUi((state) => state.environmentId);
  const showVmIds = useUi((state) => state.showInfrastructureVmIds);
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const canViewInfrastructure = canAccessInfrastructure(profile);
  const [collapsed, setCollapsed] = useState<Set<string>>(initialCollapsed);
  const [treeFilter, setTreeFilter] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  const [folderToManage, setFolderToManage] = useState<ServerGroup | null>(
    null,
  );
  const [managedFolderName, setManagedFolderName] = useState("");
  const [managedFolderParentId, setManagedFolderParentId] = useState("");
  const [managedServerIds, setManagedServerIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedServerIds, setSelectedServerIds] = useState<Set<string>>(
    new Set(),
  );
  const [serverToMove, setServerToMove] = useState<ServerRow | null>(null);
  const [moveTargetId, setMoveTargetId] = useState("");
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const serversQuery = useQuery({
    queryKey: ["servers", environmentId],
    queryFn: () => api.getServers(environmentId) as Promise<Record<string, unknown>[]>,
    staleTime: 30_000,
  });
  const rawServers = serversQuery.data;
  const groupsQuery = useQuery({
    // Keep this key identical to the resource list. Folder moves are made
    // from both views, so a single cache entry is essential for the tree and
    // table to update together instead of showing two temporary realities.
    queryKey: [SERVER_GROUP_QUERY_KEY, environmentId],
    queryFn: () =>
      api.getServerGroups(environmentId) as Promise<Record<string, unknown>[]>,
    staleTime: 30_000,
  });
  const rawGroups = groupsQuery.data;
  const { data: inventory, isPending: inventoryPending, isError: inventoryError } = useQuery({
    // Nest the summary below the established infrastructure key so existing
    // connection, import and power-action invalidations refresh the tree too.
    queryKey: ["opentofu", "infrastructure", environmentId, "summary"],
    queryFn: () =>
      apiFetch<InfrastructureResponse>(
        `/opentofu/infrastructure-summary?environment_id=${encodeURIComponent(environmentId)}`,
      ),
    staleTime: 30_000,
    // The endpoint normally serves its persisted snapshot without contacting
    // Proxmox. Poll it cheaply so connections and adopted-host mappings made
    // outside this component still appear promptly in the global tree.
    refetchInterval: 2_000,
    retry: false,
    enabled: canViewInfrastructure,
  });

  const clusters = useMemo(
    () => (Array.isArray(inventory?.clusters) ? inventory.clusters : []),
    [inventory],
  );
  const visibleClusters = useMemo(() => {
    const needle = treeFilter.trim().toLowerCase();
    if (!needle) return clusters;
    return clusters.flatMap((cluster) => {
      const clusterName = cluster.connections?.find((connection) => connection.name)?.name || cluster.endpoint || "";
      if (`${clusterName} ${cluster.endpoint || ""}`.toLowerCase().includes(needle)) return [cluster];
      const matchingVms = (cluster.vms || []).filter((vm) =>
        `${vm.vm_id || ""} ${vm.name || ""} ${vm.node_name || ""}`.toLowerCase().includes(needle),
      );
      const matchingNodeNames = new Set(
        (cluster.nodes || []).filter((node) => String(node.name || "").toLowerCase().includes(needle)).map((node) => node.name),
      );
      matchingVms.forEach((vm) => matchingNodeNames.add(vm.node_name));
      if (matchingNodeNames.size === 0) return [];
      return [{
        ...cluster,
        nodes: (cluster.nodes || []).filter((node) => matchingNodeNames.has(node.name)),
        vms: matchingVms.length > 0
          ? matchingVms
          : (cluster.vms || []).filter((vm) => matchingNodeNames.has(vm.node_name)),
      }];
    });
  }, [clusters, treeFilter]);
  const platformServerIds = useMemo(
    () =>
      new Set(
        clusters
          .flatMap((cluster) => [
            ...(cluster.nodes || []).map((node) => node.fleet_server_id),
            ...(cluster.vms || []).map((vm) => vm.fleet_server_id),
          ])
          .filter((id): id is string => Boolean(id)),
      ),
    [clusters],
  );
  const servers = useMemo(
    () =>
      asArray<Record<string, unknown>>(rawServers)
        .map(normalizeServer)
        .filter(
          (server) =>
            String(server.environment_id || "default") === environmentId &&
            !platformServerIds.has(server.id),
        ),
    [rawServers, environmentId, platformServerIds],
  );
  const groups = useMemo(
    () =>
      asArray<Record<string, unknown>>(rawGroups).map(
        (group) =>
          ({
            id: String(group.id),
            name: String(group.name || ""),
            color: typeof group.color === "string" ? group.color : undefined,
            parent_id: group.parent_id == null ? null : String(group.parent_id),
          }) satisfies ServerGroup,
      ),
    [rawGroups],
  );
  const managedHostsPending = serversQuery.isPending || groupsQuery.isPending;
  const managedHostsError = serversQuery.isError || groupsQuery.isError;
  const groupsById = useMemo(
    () => new Set(groups.map((group) => group.id)),
    [groups],
  );
  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const byGroup = useMemo(
    () =>
      servers.reduce<Record<string, ServerRow[]>>((result, server) => {
        const key =
          server.group_id && groupsById.has(server.group_id)
            ? server.group_id
            : "__ungrouped__";
        (result[key] ||= []).push(server);
        return result;
      }, {}),
    [servers, groupsById],
  );
  const groupTree = useMemo(() => buildGroupTree(groups), [groups]);
  const activeServer = useMemo(
    () =>
      servers.find(
        (server) =>
          path === `/servers/${server.id}` ||
          decodePath(path) === `/servers/${server.id}`,
      ),
    [path, servers],
  );
  const activeGroupIds = useMemo(() => {
    const result = new Set<string>();
    let current = activeServer?.group_id
      ? groupById.get(activeServer.group_id)
      : undefined;
    while (current) {
      result.add(current.id);
      current = current.parent_id
        ? groupById.get(current.parent_id)
        : undefined;
    }
    return result;
  }, [activeServer, groupById]);
  const groupMemberCount = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    for (const group of groups) {
      if (!group.parent_id) continue;
      const children = childrenByParent.get(group.parent_id) || [];
      children.push(group.id);
      childrenByParent.set(group.parent_id, children);
    }
    const count = (groupId: string, visited = new Set<string>()): number => {
      if (visited.has(groupId)) return 0;
      const nextVisited = new Set(visited).add(groupId);
      return (
        (byGroup[groupId] || []).length +
        (childrenByParent.get(groupId) || []).reduce(
          (total, childId) => total + count(childId, nextVisited),
          0,
        )
      );
    };
    return new Map(groups.map((group) => [group.id, count(group.id)]));
  }, [byGroup, groups]);
  const ungrouped = byGroup.__ungrouped__ || [];
  const createFolder = useMutation({
    mutationFn: () =>
      api.createServerGroup(
        folderName.trim(),
        "#64748b",
        folderParentId || null,
        environmentId,
      ),
    onSuccess: () => {
      showToast("Folder created.", "success");
      setFolderOpen(false);
      setFolderName("");
      setFolderParentId("");
      void queryClient.invalidateQueries({
        queryKey: [SERVER_GROUP_QUERY_KEY],
      });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const saveFolder = useMutation({
    mutationFn: async () => {
      if (!folderToManage) return;
      await api.updateServerGroup(
        folderToManage.id,
        managedFolderName.trim(),
        folderToManage.color,
      );
      if ((folderToManage.parent_id || "") !== managedFolderParentId)
        await api.setGroupParent(
          folderToManage.id,
          managedFolderParentId || null,
        );
      await Promise.all(
        servers
          .filter(
            (server) =>
              (server.group_id || null) === folderToManage.id ||
              managedServerIds.has(server.id),
          )
          .map((server) => {
            const nextGroupId = managedServerIds.has(server.id)
              ? folderToManage.id
              : null;
            return (server.group_id || null) === nextGroupId
              ? Promise.resolve()
              : api.setServerGroup(server.id, nextGroupId);
          }),
      );
    },
    onSuccess: () => {
      showToast("Folder saved.", "success");
      setFolderToManage(null);
      void queryClient.invalidateQueries({
        queryKey: [SERVER_GROUP_QUERY_KEY],
      });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const deleteFolder = useMutation({
    mutationFn: () =>
      folderToManage
        ? api.deleteServerGroup(folderToManage.id)
        : Promise.resolve(),
    onSuccess: () => {
      showToast("Folder removed. Contained hosts are preserved.", "success");
      setFolderToManage(null);
      void queryClient.invalidateQueries({
        queryKey: [SERVER_GROUP_QUERY_KEY],
      });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });

  useEffect(() => {
    // Expand the direct object path automatically.  Deep links, Cmd+K and
    // browser history should all reveal the active object in the same way as
    // selecting it from this vCenter-like tree.
    const selected = servers.find(
      (server) =>
        path === `/servers/${server.id}` ||
        decodePath(path) === `/servers/${server.id}`,
    );
    const platformMatch = decodePath(path).match(/^\/infrastructure\/([^/]+)/);
    const serverMatch = decodePath(path).match(/^\/servers\/([^/]+)$/);
    setCollapsed((previous) => {
      const openIds: string[] = platformMatch ? [`platform:${platformMatch[1]}`] : [];
      const linkedServerId = serverMatch?.[1];
      if (linkedServerId) {
        for (const cluster of clusters) {
          const clusterId = String(cluster.id || cluster.endpoint || "cluster");
          const linkedNode = (cluster.nodes || []).find(
            (node) => node.fleet_server_id === linkedServerId,
          );
          const linkedVm = (cluster.vms || []).find(
            (vm) => vm.fleet_server_id === linkedServerId,
          );
          if (!linkedNode && !linkedVm) continue;
          openIds.push(`platform:${clusterId}`);
          const nodeName = linkedNode?.name || linkedVm?.node_name;
          if (nodeName) openIds.push(`node:${clusterId}:${nodeName}`);
          break;
        }
      }
      let current = selected?.group_id
        ? groupById.get(selected.group_id)
        : undefined;
      while (current) {
        openIds.push(current.id);
        current = current.parent_id
          ? groupById.get(current.parent_id)
          : undefined;
      }
      if (openIds.length === 0) return previous;
      if (!openIds.some((groupId) => previous.has(groupId))) return previous;
      const next = new Set(previous);
      openIds.forEach((groupId) => next.delete(groupId));
      saveCollapsed(next);
      return next;
    });
  }, [clusters, groupById, path, servers]);

  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  const selectServer = (server: ServerRow) => {
    onNavigate?.();
    void navigate({ to: "/servers/$id", params: { id: server.id } });
  };
  const openMoveServer = (server: ServerRow) => {
    setServerToMove(server);
    setMoveTargetId(
      server.group_id && groupsById.has(server.group_id)
        ? server.group_id
        : "__root__",
    );
  };
  const moveServersToFolder = (serverIds: string[], groupId: string | null) => {
    const distinctIds = [...new Set(serverIds)].filter(Boolean);
    if (distinctIds.length === 0) return;
    // One atomic API call keeps a drag of several selected hosts consistent:
    // either all hosts are moved or none are moved (for example when a folder
    // belongs to a different environment).
    void api
      .setServersGroup(distinctIds, groupId)
      .then(() => {
        showToast(
          distinctIds.length === 1
            ? groupId
              ? "Resource moved to folder."
              : "Resource removed from folder."
            : `${distinctIds.length} resources moved.`,
          "success",
        );
        setSelectedServerIds(new Set());
        if (groupId)
          setCollapsed((current) => {
            if (!current.has(groupId)) return current;
            const next = new Set(current);
            next.delete(groupId);
            saveCollapsed(next);
            return next;
          });
        void queryClient.invalidateQueries({ queryKey: ["servers"] });
        void queryClient.invalidateQueries({
          queryKey: [SERVER_GROUP_QUERY_KEY],
        });
      })
      .catch((error: Error) => showToast(error.message, "error"));
  };
  const draggedServerIds = (serverId: string) =>
    selectedServerIds.has(serverId) ? [...selectedServerIds] : [serverId];
  const getDraggedServerIds = (event: DragEvent) => {
    const custom = event.dataTransfer.getData("application/x-fleet-server-ids");
    const legacyValue = event.dataTransfer.getData("text/plain");
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string"))
        return parsed;
    } catch {
      /* fall back to the legacy drag payload */
    }
    return /^server:([A-Za-z0-9,-]+)$/.exec(legacyValue)?.[1]?.split(",") || [];
  };
  const toggleSelection = (serverId: string) =>
    setSelectedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  const selectedServerCount = selectedServerIds.size;
  const serverRow = (server: ServerRow, depth = 0) => {
    const filterNeedle = treeFilter.trim().toLowerCase();
    if (filterNeedle && !`${server.name} ${server.ip_address || ""} ${(server.tags || []).join(" ")}`.toLowerCase().includes(filterNeedle)) return null;
    const active =
      path === `/servers/${server.id}` ||
      decodePath(path) === `/servers/${server.id}`;
    const selected = selectedServerIds.has(server.id);
    return (
      <div
        key={server.id}
        draggable={!compact}
        onDragStart={(event) => {
          const ids = draggedServerIds(server.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "application/x-fleet-server-ids",
            JSON.stringify(ids),
          );
          event.dataTransfer.setData(
            "application/x-fleet-server-id",
            server.id,
          );
          event.dataTransfer.setData("text/plain", `server:${ids.join(",")}`);
        }}
        title={`${server.name}${server.ip_address ? ` · ${server.ip_address}` : ""}`}
        className={cn(
          "group flex w-full min-w-0 items-start gap-1 rounded-sm py-0.5 pr-1 text-xs transition-colors",
          active
            ? "bg-accent font-medium text-foreground"
            : selected
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {!compact && (
          <button
            type="button"
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toggleSelection(server.id);
            }}
            aria-label={`${server.name} ${selected ? "remove from selection" : "select"}`}
            title={selected ? "Remove from selection" : "Select"}
          >
            {selected ? (
              <CheckSquare className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => selectServer(server)}
          className="flex min-w-0 flex-1 items-start gap-2 overflow-hidden rounded-sm py-1 text-left"
        >
          <span className="mt-1">
            <StatusDot status={server.status} />
          </span>
          <Server className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate leading-5 text-foreground">
            {server.name}
          </span>
        </button>
        {!compact && (
          <button
            type="button"
            onClick={() => openMoveServer(server)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"
            aria-label={`Move ${server.name}`}
            title="Move to folder"
          >
            <FolderInput className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };
  const groupNode = (node: GroupNode, depth = 0): ReactNode => {
    const open = !collapsed.has(node.id);
    const containsActiveServer = activeGroupIds.has(node.id);
    const members = byGroup[node.id] || [];
    const hasChildren = members.length > 0 || node.children.length > 0;
    const openManager = () => {
      setFolderToManage(node);
      setManagedFolderName(node.name);
      setManagedFolderParentId(node.parent_id || "");
      setManagedServerIds(new Set(members.map((server) => server.id)));
    };
    return (
      <div key={node.id}>
        <div
          className={cn(
            "group flex min-w-0 items-center gap-1 pr-1 transition-colors",
            containsActiveServer && "bg-accent/60",
            dropTargetId === node.id &&
              "rounded-sm bg-primary/10 ring-1 ring-inset ring-primary/50",
          )}
          onDragOver={(event) => {
            const types = event.dataTransfer.types;
            const isFleetHost =
              types.includes("application/x-fleet-server-id") ||
              types.includes("application/x-fleet-server-ids") ||
              types.includes("text/plain");
            if (isFleetHost) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTargetId(node.id);
            }
          }}
          onDragLeave={() =>
            setDropTargetId((current) => (current === node.id ? null : current))
          }
          onDrop={(event) => {
            event.preventDefault();
            setDropTargetId(null);
            const custom = event.dataTransfer.getData(
              "application/x-fleet-server-ids",
            );
            const legacyValue = event.dataTransfer.getData("text/plain");
            let ids: string[] = [];
            try {
              ids = JSON.parse(custom);
            } catch {
              /* fall back below */
            }
            if (
              !Array.isArray(ids) ||
              ids.some((id) => typeof id !== "string")
            ) {
              ids =
                /^server:([A-Za-z0-9,-]+)$/
                  .exec(legacyValue)?.[1]
                  ?.split(",") || [];
            }
            moveServersToFolder(ids, node.id);
          }}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggle(node.id)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent/60",
              containsActiveServer && "font-medium",
              !hasChildren && "cursor-default",
            )}
          >
            {hasChildren ? (
              open ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="w-3.5" />
            )}
            <Folder
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: node.color || undefined }}
            />
            <span className="min-w-0 flex-1 truncate" title={node.name}>{node.name}</span>
            <span className="text-[10px] text-muted-foreground">
              {groupMemberCount.get(node.id) || 0}
            </span>
          </button>
          {!compact && (
            <button
              type="button"
              onClick={openManager}
              className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Manage ${node.name}`}
              title="Manage folder"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {open && (
          <div>
            {members.map((server) => serverRow(server, depth + 1))}
            {node.children.map((child) => groupNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };
  const platformNode = (cluster: ProxmoxCluster) => {
    const clusterId = String(cluster.id || cluster.endpoint || "cluster");
    const clusterName =
      cluster.connections?.find((connection) => connection.name)?.name ||
      cluster.endpoint ||
      "Proxmox";
    const nodes = Array.isArray(cluster.nodes) ? cluster.nodes : [];
    const vms = Array.isArray(cluster.vms) ? cluster.vms : [];
    const decodedPath = decodePath(path);
    const clusterPath = `/infrastructure/${clusterId}`;
    const current = decodedPath === clusterPath;
    const linkedHostActive = [...nodes, ...vms].some(
      (resource) =>
        resource.fleet_server_id &&
        decodedPath === `/servers/${resource.fleet_server_id}`,
    );
    const active =
      current || decodedPath.startsWith(`${clusterPath}/`) || linkedHostActive;
    const open = !collapsed.has(`platform:${clusterId}`);
    return (
      <div key={clusterId}>
        <div className={cn("flex min-w-0 items-center gap-1 rounded-sm pr-1", active && !current && "bg-muted/35")}>
          {nodes.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(`platform:${clusterId}`)}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
              aria-label={`${open ? "Collapse" : "Expand"} ${clusterName}`}
              aria-expanded={open}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : <span className="h-7 w-6 shrink-0" aria-hidden="true" />}
          <Link
            to="/infrastructure/$clusterId"
            params={{ clusterId }}
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            title={`${clusterName} · ${nodes.length} PVE host${nodes.length === 1 ? "" : "s"} · ${vms.length} virtual machines`}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1.5 text-xs transition-colors",
              current
                ? "bg-primary/10 font-semibold text-primary shadow-[inset_2px_0_0_hsl(var(--primary))]"
                : active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <StatusDot status={cluster.status} />
            <Database className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{clusterName}</span>
            {!compact && <span className="shrink-0 text-[10px] text-muted-foreground">{vms.length} VM</span>}
          </Link>
        </div>
        {nodes.length > 0 && open && (
          <div className="ml-6 border-l border-border/70 pl-1">
            {nodes.map((node) => {
              const nodeName = String(node.name || "");
              const nodePath = `${clusterPath}/nodes/${nodeName}`;
              const nodeCurrent = decodedPath === nodePath;
              const nodeVms = vms.filter((vm) => vm.node_name === nodeName);
              const nodeHostCurrent = Boolean(
                node.fleet_server_id &&
                  decodedPath === `/servers/${node.fleet_server_id}`,
              );
              const nodeActive =
                nodeCurrent ||
                decodedPath.startsWith(`${nodePath}/`) ||
                nodeHostCurrent ||
                nodeVms.some(
                  (vm) =>
                    vm.fleet_server_id &&
                    decodedPath === `/servers/${vm.fleet_server_id}`,
                );
              const nodeKey = `node:${clusterId}:${nodeName}`;
              const nodeOpen = !collapsed.has(nodeKey);
              return (
                <div key={nodeName}>
                  <div className={cn("flex min-w-0 items-center gap-0.5 rounded-sm", nodeActive && !nodeCurrent && "bg-muted/30")}>
                    <button
                      type="button"
                      onClick={() => nodeVms.length && toggle(nodeKey)}
                      className="flex h-7 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
                      aria-label={`${nodeOpen ? "Collapse" : "Expand"} ${nodeName}`}
                      aria-expanded={nodeOpen}
                      disabled={nodeVms.length === 0}
                    >
                      {nodeVms.length > 0 ? (nodeOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : null}
                    </button>
                    <Link
                      to="/infrastructure/$clusterId/nodes/$nodeName"
                      params={{ clusterId, nodeName }}
                      onClick={onNavigate}
                      aria-current={nodeCurrent ? "page" : undefined}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1.5 text-xs transition-colors",
                        nodeCurrent || nodeHostCurrent ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <StatusDot status={node.status} />
                      <Server className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono">{nodeName}</span>
                      {!compact && <span className="text-[10px]">{nodeVms.length}</span>}
                    </Link>
                    {node.fleet_server_id && (
                      <Link
                        to="/servers/$id"
                        params={{ id: node.fleet_server_id }}
                        onClick={onNavigate}
                        aria-label={`Open managed host ${nodeName}`}
                        title="Open managed host"
                        className="mr-0.5 rounded-sm p-1 text-primary/80 hover:bg-accent hover:text-primary"
                      >
                        <Server className="h-3 w-3" />
                      </Link>
                    )}
                  </div>
                  {nodeOpen && nodeVms.length > 0 && (
                    <div className="ml-5 border-l border-border/60 pl-1">
                      {nodeVms.map((vm) => {
                        const vmId = String(vm.vm_id || "");
                        const vmPath = `${nodePath}/vms/${vmId}`;
                        const vmCurrent = decodedPath === vmPath;
                        const vmHostCurrent = Boolean(
                          vm.fleet_server_id &&
                            decodedPath === `/servers/${vm.fleet_server_id}`,
                        );
                        return (
                          <div
                            key={`${nodeName}:${vmId}`}
                            className={cn(
                              "flex min-w-0 items-center rounded-sm transition-colors",
                              vmCurrent || vmHostCurrent
                                ? "bg-primary/10 font-semibold text-primary"
                                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                            )}
                          >
                            {vm.fleet_server_id ? (
                              <Link
                                to="/servers/$id"
                                params={{ id: vm.fleet_server_id }}
                                onClick={onNavigate}
                                aria-current={vmHostCurrent ? "page" : undefined}
                                title={`Open managed host ${vm.name || vmId}`}
                                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-[11px]"
                              >
                                <StatusDot status={vm.status} />
                                <Server className="h-3 w-3 shrink-0" />
                                {showVmIds && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{vmId}</span>}
                                <span className="min-w-0 flex-1 truncate">{vm.name || `${vm.guest_type === "lxc" ? "CT" : "VM"} ${vmId}`}</span>
                              </Link>
                            ) : (
                              <Link
                                to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                                params={{ clusterId, nodeName, vmId }}
                                onClick={onNavigate}
                                aria-current={vmCurrent ? "page" : undefined}
                                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-[11px]"
                              >
                                <StatusDot status={vm.status} />
                                <Box className="h-3 w-3 shrink-0" />
                                {showVmIds && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{vmId}</span>}
                                <span className="min-w-0 flex-1 truncate">{vm.name || `${vm.guest_type === "lxc" ? "CT" : "VM"} ${vmId}`}</span>
                              </Link>
                            )}
                            {vm.fleet_server_id && (
                              <Link
                                to="/infrastructure/$clusterId/nodes/$nodeName/vms/$vmId"
                                params={{ clusterId, nodeName, vmId }}
                                onClick={onNavigate}
                                aria-current={vmCurrent ? "page" : undefined}
                                aria-label={`Open Proxmox virtual machine ${vm.name || vmId}`}
                                title="Open Proxmox virtual machine details"
                                className="mr-0.5 shrink-0 rounded-sm border border-transparent p-1 text-muted-foreground hover:border-border hover:bg-background hover:text-foreground"
                              >
                                <Box className="h-3 w-3" />
                              </Link>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="space-y-1">
      {!compact && (
        <div className="relative px-1 pb-1">
          <Input
            value={treeFilter}
            onChange={(event) => setTreeFilter(event.target.value)}
            aria-label="Filter infrastructure tree"
            placeholder="Filter inventory…"
            className="h-7 pr-7 text-xs"
          />
          {treeFilter && <button type="button" onClick={() => setTreeFilter("")} aria-label="Clear infrastructure filter" title="Clear infrastructure filter" className="absolute inset-y-0 right-1 inline-flex min-w-9 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>}
        </div>
      )}
      <div>
        {canViewInfrastructure && (
          <div className="mb-2 border-b pb-2">
            <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              <Database className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Proxmox</span>
              {inventoryPending ? (
                <span aria-hidden="true" className="h-4 w-5 animate-pulse rounded bg-muted" />
              ) : (
                <span className="rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal">
                  {inventoryError ? "—" : visibleClusters.length}
                </span>
              )}
            </div>
            {inventoryPending ? (
              <div
                role="status"
                aria-live="polite"
                className="mx-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>Infrastructure is loading…</span>
              </div>
            ) : inventoryError ? (
              <div className="mx-1 rounded-sm px-2 py-1.5 text-xs text-destructive">
                Infrastructure could not be loaded
              </div>
            ) : visibleClusters.length > 0 ? (
              visibleClusters.map(platformNode)
            ) : (
              <Link
                to="/deployments"
                onClick={onNavigate}
                className="mx-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                <Database className="h-3.5 w-3.5 text-primary" />
                <span>Connect Proxmox</span>
              </Link>
            )}
          </div>
        )}
        <div
          className={cn(
            "transition-colors",
            dropTargetId === "__root__" &&
              "rounded-sm bg-primary/10 ring-1 ring-inset ring-primary/50",
          )}
          onDragOver={(event) => {
            const types = event.dataTransfer.types;
            if (
              types.includes("application/x-fleet-server-id") ||
              types.includes("application/x-fleet-server-ids") ||
              types.includes("text/plain")
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTargetId("__root__");
            }
          }}
          onDragLeave={() =>
            setDropTargetId((current) =>
              current === "__root__" ? null : current,
            )
          }
          onDrop={(event) => {
            event.preventDefault();
            setDropTargetId(null);
            moveServersToFolder(getDraggedServerIds(event), null);
          }}
        >
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Link
              to="/servers"
              onClick={onNavigate}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors",
                path === "/servers"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderTree className="h-3.5 w-3.5 shrink-0" />{" "}
              <span className="truncate">Standalone hosts</span>{" "}
              <span className="rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal">
                {managedHostsPending || managedHostsError ? "—" : servers.length}
              </span>
            </Link>
            {!compact && (
              <button
                type="button"
                onClick={() => setFolderOpen(true)}
                disabled={managedHostsPending || managedHostsError}
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Create folder"
              >
                +
              </button>
            )}
          </div>
        </div>
        {!compact && selectedServerCount > 0 && (
          <div className="mx-1 mb-1 rounded-md border border-primary/20 bg-primary/5 p-1.5">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate px-1 text-[10px] font-medium text-foreground">
                {selectedServerCount} host{selectedServerCount === 1 ? "" : "s"}{" "}
                selected
              </span>
              <button
                type="button"
                onClick={() => setSelectedServerIds(new Set())}
              className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear selection"
                title="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <select
              aria-label="Move selected resources"
              defaultValue=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                moveServersToFolder(
                  [...selectedServerIds],
                  value === "__root__" ? null : value,
                );
                event.currentTarget.value = "";
              }}
              className="mt-1 h-7 w-full rounded-sm border bg-background px-1.5 text-[10px] text-foreground"
            >
              <option value="" disabled>
                Move to folder…
              </option>
              <option value="__root__">No group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {managedHostsPending ? (
          <div className="mx-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>Managed hosts are loading…</span>
          </div>
        ) : managedHostsError ? (
          <p className="mx-1 rounded-sm px-2 py-1.5 text-xs text-destructive">
            Managed hosts could not be loaded
          </p>
        ) : (
          <>
            {ungrouped.map((server) => serverRow(server))}
            {groupTree.map((group) => groupNode(group))}
          </>
        )}
        {!managedHostsPending && !managedHostsError && !servers.length && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No standalone hosts in this environment.
          </p>
        )}
      </div>
      <Dialog open={folderOpen} onOpenChange={setFolderOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Organize virtual machines and hosts in an inventory tree.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              createFolder.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="tree-folder-name">Name</Label>
              <Input
                id="tree-folder-name"
                required
                autoFocus
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="Production"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tree-folder-parent">Parent folder</Label>
              <select
                id="tree-folder-parent"
                value={folderParentId}
                onChange={(event) => setFolderParentId(event.target.value)}
                className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
              >
                <option value="">Root folder</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFolderOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createFolder.isPending}>
                Create folder
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(folderToManage)}
        onOpenChange={(open) => !open && setFolderToManage(null)}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage folder</DialogTitle>
            <DialogDescription>
              Change its name or position in the infrastructure tree.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveFolder.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="manage-folder-name">Name</Label>
              <Input
                id="manage-folder-name"
                required
                autoFocus
                value={managedFolderName}
                onChange={(event) => setManagedFolderName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manage-folder-parent">Parent folder</Label>
              <select
                id="manage-folder-parent"
                value={managedFolderParentId}
                onChange={(event) =>
                  setManagedFolderParentId(event.target.value)
                }
                className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
              >
                <option value="">Root folder</option>
                {groups
                  .filter(
                    (group) =>
                      !folderToManage ||
                      !getDescendantIds(groups, folderToManage.id).has(
                        group.id,
                      ),
                  )
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UsersRound className="h-4 w-4 text-muted-foreground" />
                Resources in this folder
              </div>
              <p className="text-xs text-muted-foreground">
                Select standalone hosts. Platform-linked nodes and virtual machines stay
                in their Proxmox hierarchy.
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {servers.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    No hosts in this environment.
                  </p>
                ) : (
                  servers.map((server) => (
                    <label
                      key={server.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={managedServerIds.has(server.id)}
                        onChange={() =>
                          setManagedServerIds((current) => {
                            const next = new Set(current);
                            if (next.has(server.id)) next.delete(server.id);
                            else next.add(server.id);
                            return next;
                          })
                        }
                      />
                      <StatusDot status={server.status} />
                      <span className="min-w-0 flex-1 truncate">
                        {server.name}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {server.ip_address || "—"}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
              Deleting a folder preserves its hosts and moves child folders to
              the root.
            </p>
            <div className="flex flex-col-reverse gap-2 border-t pt-3 sm:flex-row sm:items-center">
              <Button
                className="w-full sm:mr-auto sm:w-auto"
                type="button"
                variant="destructive"
                onClick={() => deleteFolder.mutate()}
                disabled={deleteFolder.isPending}
              >
                <Trash2 />
                Delete folder
              </Button>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button
                  className="w-full sm:w-auto"
                  type="button"
                  variant="outline"
                  onClick={() => setFolderToManage(null)}
                >
                  Cancel
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  type="submit"
                  disabled={saveFolder.isPending || !managedFolderName.trim()}
                >
                  Save
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(serverToMove)}
        onOpenChange={(open) => !open && setServerToMove(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Move resource</DialogTitle>
            <DialogDescription>
              {serverToMove
                ? `Place “${serverToMove.name}” in a Shipyard folder. The VM in Proxmox will not be changed.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!serverToMove) return;
              moveServersToFolder(
                [serverToMove.id],
                moveTargetId === "__root__" ? null : moveTargetId,
              );
              setServerToMove(null);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="tree-move-target">Destination folder</Label>
              <select
                id="tree-move-target"
                value={moveTargetId}
                onChange={(event) => setMoveTargetId(event.target.value)}
                className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"
              >
                <option value="__root__">No folder</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setServerToMove(null)}
              >
                Cancel
              </Button>
              <Button type="submit">
                <FolderInput />
                Move
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
