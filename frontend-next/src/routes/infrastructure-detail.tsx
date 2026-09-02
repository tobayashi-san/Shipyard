import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Boxes,
  CheckSquare2,
  ClipboardList,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  Server,
  ServerCog,
  TriangleAlert,
  X,
} from "lucide-react";
import { api, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImportProxmoxVmDialog } from "@/features/infrastructure/ImportProxmoxVmDialog";
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
import { hasCap, useProfile } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { asArray, formatDateTime } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { CreateServerDialog } from "@/components/CreateServerDialog";
import { ClusterPage } from "@/features/infrastructure/ClusterDetail";
import { NodePage } from "@/features/infrastructure/NodeDetail";
import { BulkImportProxmoxVmsDialog } from "@/features/infrastructure/DetailPanels";
import {
  type AuditTask,
  type Cluster,
  type InfrastructureResponse,
  type Node,
  type Vm,
  tasksForObject,
} from "@/features/infrastructure/detail-model";


export function InfrastructureDetailPage() {
  const { clusterId, nodeName } = useParams({ strict: false }) as {
    clusterId: string;
    nodeName?: string;
  };
  const environmentId = useUi((state) => state.environmentId);
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const query = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId],
    queryFn: () =>
      apiFetch<InfrastructureResponse>(
        `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}`,
    ),
    staleTime: 15_000,
    refetchInterval: 2_500,
  });
  const summaryQuery = useQuery({
    queryKey: ["opentofu", "infrastructure", environmentId, "summary"],
    queryFn: () => apiFetch<InfrastructureResponse>(
      `/opentofu/infrastructure-summary?environment_id=${encodeURIComponent(environmentId)}`,
    ),
    staleTime: 30_000,
  });
  const refreshInventory = async () => {
    const data = await apiFetch<InfrastructureResponse>(
      `/opentofu/infrastructure?environment_id=${encodeURIComponent(environmentId)}&refresh=1`,
    );
    queryClient.setQueryData(["opentofu", "infrastructure", environmentId], data);
  };
  const [vmToImport, setVmToImport] = useState<{
    connectionId: string;
    vm: Vm;
  } | null>(null);
  const [vmsToImport, setVmsToImport] = useState<{
    connectionId: string;
    vms: Vm[];
  } | null>(null);
  const fullCluster = (Array.isArray(query.data?.clusters) ? query.data!.clusters! : []).find((item) => item.id === clusterId);
  const summaryCluster = (Array.isArray(summaryQuery.data?.clusters) ? summaryQuery.data!.clusters! : []).find((item) => item.id === clusterId);
  // A summary snapshot is a failure fallback, not an intermediate shape for
  // the live detail request. Waiting for the complete live payload keeps
  // nodes, VMs and datastores atomic on first render.
  const usingCachedSnapshot = !fullCluster && query.isError && Boolean(summaryCluster);
  const cluster = fullCluster || (query.isError ? summaryCluster : undefined);
  const node = cluster?.nodes.find((item) => item.name === nodeName);
  // Audit visibility is a distinct operator capability.  Restricting this
  // object-level task view to the literal admin role made the vSphere-like
  // "recent tasks" area disappear for read-only operations roles that were
  // deliberately granted audit access.
  const canViewAudit = hasCap(profile, "canViewAudit");
  const auditQuery = useQuery<AuditTask[]>({
    queryKey: ["audit-log", "infrastructure-object", environmentId],
    queryFn: () =>
      api.getAuditLog({ limit: 300 }) as unknown as Promise<AuditTask[]>,
    enabled: Boolean(cluster) && canViewAudit,
    staleTime: 15_000,
  });

  const objectMissing = !cluster || Boolean(nodeName && !node);
  if (objectMissing && (query.isLoading || summaryQuery.isLoading))
    return (
      <div className="space-y-5">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-56 animate-pulse rounded-lg border bg-muted/30" />
      </div>
    );
  if (objectMissing && query.isError && summaryQuery.isError)
    return (
      <QueryErrorState
        error={query.error || summaryQuery.error}
        title="Infrastructure inventory could not be loaded"
        onRetry={() => void Promise.all([query.refetch(), summaryQuery.refetch()])}
      />
    );
  if (!cluster || (nodeName && !node))
    return (
      <EmptyState
        icon={<Database className="h-5 w-5" />}
        title="Infrastructure object not found"
        description="The platform was removed, is in a different environment, or the inventory changed."
        action={
          <Button asChild variant="outline">
            <Link to="/infrastructure">
              <ArrowLeft />
              Back to infrastructure
            </Link>
          </Button>
        }
      />
    );

  const importVm = (vm: Vm) => {
    const connectionId = cluster.connections?.[0]?.id;
    if (connectionId) setVmToImport({ connectionId, vm });
  };
  const canImportVm = hasCap(profile, "canEditServers");
  const canRunUpdates = hasCap(profile, "canRunUpdates");
  const auditRows = asArray<AuditTask>(auditQuery.data);
  const importVms = (vms: Vm[]) => {
    const connectionId = cluster.connections?.[0]?.id;
    if (connectionId && vms.length) setVmsToImport({ connectionId, vms });
  };
  const page = node ? (
    <NodePage
      cluster={cluster}
      node={node}
      onImportVm={importVm}
      onImportVms={importVms}
      canImportVm={canImportVm}
      canRunUpdates={canRunUpdates}
      onRefresh={() => void refreshInventory()}
      refreshing={query.isFetching}
      showAudit={canViewAudit}
      auditTasks={
        canViewAudit && auditQuery.isSuccess ? tasksForObject(auditRows, cluster, node.name) : undefined
      }
      auditLoading={canViewAudit && auditQuery.isLoading}
      auditError={canViewAudit && auditQuery.isError ? auditQuery.error : undefined}
      onRetryAudit={() => void auditQuery.refetch()}
    />
  ) : (
    <ClusterPage
      cluster={cluster}
      onImportVm={importVm}
      onImportVms={importVms}
      canImportVm={canImportVm}
      canRunUpdates={canRunUpdates}
      onRefresh={() => void refreshInventory()}
      refreshing={query.isFetching}
      showAudit={canViewAudit}
      auditTasks={canViewAudit && auditQuery.isSuccess ? tasksForObject(auditRows, cluster) : undefined}
      auditLoading={canViewAudit && auditQuery.isLoading}
      auditError={canViewAudit && auditQuery.isError ? auditQuery.error : undefined}
      onRetryAudit={() => void auditQuery.refetch()}
    />
  );
  return (
    <>
      {usingCachedSnapshot && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span>
            Live platform data is unavailable. Showing the complete cached snapshot
            {summaryQuery.data?.updated_at ? ` from ${formatDateTime(summaryQuery.data.updated_at)}` : ""}.
          </span>
          <Button className="ml-auto" size="sm" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw /> Retry live data
          </Button>
        </div>
      )}
      {page}
      {vmToImport && (
        <ImportProxmoxVmDialog
          connectionId={vmToImport.connectionId}
          environmentId={environmentId}
          vm={vmToImport.vm}
          open
          onOpenChange={(open) => !open && setVmToImport(null)}
        />
      )}
      {vmsToImport && (
        <BulkImportProxmoxVmsDialog
          connectionId={vmsToImport.connectionId}
          environmentId={environmentId}
          vms={vmsToImport.vms}
          open
          onOpenChange={(open) => !open && setVmsToImport(null)}
        />
      )}
    </>
  );
}
