import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Boxes,
  CheckSquare2,
  ClipboardList,
  Download,
  HardDrive,
  RefreshCw,
  Server,
  ServerCog,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUi } from "@/lib/store";
import { asArray } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { useUrlTab } from "@/lib/use-url-tab";
import { NodeUpdatesCard } from "./ClusterDetail";
import {
  DatastoresCard,
  NodeConfiguration,
  ObjectInventoryPreview,
  ObjectTasksCard,
  RecentObjectTasks,
  VmTable,
} from "./DetailPanels";
import {
  type AuditTask,
  type Bridge,
  type Cluster,
  type Datastore,
  type Folder,
  type Node,
  type Vm,
  bytes,
  CapacityCell,
  CompactUsage,
  ObjectOverview,
  pct,
  preferredDatastores,
  statusLabel,
  taskDate,
  tone,
  uptime,
} from "./detail-model";

export function NodePage({
  cluster,
  node,
  onImportVm,
  onImportVms,
  canImportVm,
  canRunUpdates,
  onRefresh,
  refreshing,
  showAudit,
  auditTasks,
  auditLoading,
  auditError,
  onRetryAudit,
}: {
  cluster: Cluster;
  node: Node;
  onImportVm: (vm: Vm) => void;
  onImportVms: (vms: Vm[]) => void;
  canImportVm: boolean;
  canRunUpdates: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  showAudit: boolean;
  auditTasks?: AuditTask[];
  auditLoading?: boolean;
  auditError?: unknown;
  onRetryAudit?: () => void;
}) {
  const vms = cluster.vms.filter((vm) => vm.node_name === node.name);
  const platformName = cluster.connections?.[0]?.name || "Proxmox";
  const availableTabs = useMemo(
    () => ["overview", "configuration", "vms", "datastores", "updates", ...(showAudit ? ["tasks"] : [])],
    [showAudit],
  );
  const nodeTabs = useUrlTab("overview", availableTabs);
  return (
    <div className="space-y-5">
      <PageHeader
        title={node.name}
        eyebrow="Compute Node"
        badge={
          <StatusBadge tone={tone(node.status)} dot>
            {statusLabel(node.status)}
          </StatusBadge>
        }
        description={`${platformName} · ${cluster.endpoint.replace(/^https?:\/\//, "")}`}
        breadcrumbs={
          <>
            <Link
              to="/infrastructure"
              className="hover:text-foreground hover:underline"
            >
              Infrastructure
            </Link>
            <span aria-hidden="true">/</span>
            <Link
              to="/infrastructure/$clusterId"
              params={{ clusterId: cluster.id }}
              className="hover:text-foreground hover:underline"
            >
              {platformName}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="font-mono text-foreground">{node.name}</span>
          </>
        }
        back={
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Back to platform"
          >
            <Link
              to="/infrastructure/$clusterId"
              params={{ clusterId: cluster.id }}
            >
              <ArrowLeft />
            </Link>
          </Button>
        }
        actions={
          <>
            <Button asChild type="button" size="sm" variant="outline">
              <Link to="/operations">
                <ClipboardList />
                Tasks
              </Link>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </>
        }
      />
      <Tabs value={nodeTabs.value} onValueChange={nodeTabs.onValueChange} className="space-y-4">
        <TabsList aria-label="Node sections" className="console-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="configuration">
            <ServerCog className="h-4 w-4" />
            Configuration
          </TabsTrigger>
          <TabsTrigger value="vms">
            <Boxes className="h-4 w-4" />
            Virtual machines{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {vms.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="datastores">
            <HardDrive className="h-4 w-4" />
            Datastores{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {node.datastores?.length ?? 0}
            </span>
          </TabsTrigger>
          <TabsTrigger value="updates">
            <Download className="h-4 w-4" />
            Updates{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {node.update_count || 0}
            </span>
          </TabsTrigger>
          {showAudit && (
            <TabsTrigger value="tasks">
              <ClipboardList className="h-4 w-4" />
              Tasks
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          <NodeOverview
            cluster={cluster}
            node={node}
            showAudit={showAudit}
            auditTasks={auditTasks}
            auditLoading={auditLoading}
            auditError={auditError}
            onRetryAudit={onRetryAudit}
            onOpenVms={() => nodeTabs.onValueChange("vms")}
          />
        </TabsContent>
        <TabsContent value="configuration" className="mt-0">
          <NodeConfiguration node={node} vms={vms} />
        </TabsContent>
        <TabsContent value="vms" className="mt-0">
          <VmTable
            cluster={cluster}
            vms={vms}
            onImportVm={onImportVm}
            onImportVms={onImportVms}
            canImportVm={canImportVm}
          />
        </TabsContent>
        <TabsContent value="datastores" className="mt-0">
          <DatastoresCard
            stores={node.datastores ?? []}
            emptyText="No datastores reported for this node."
          />
        </TabsContent>
        <TabsContent value="updates" className="mt-0">
          <NodeUpdatesCard cluster={cluster} node={node} canRunUpdates={canRunUpdates} canAddFleetHost={canImportVm} />
        </TabsContent>
        {showAudit && (
          <TabsContent value="tasks" className="mt-0">
            <ObjectTasksCard tasks={auditTasks} loading={auditLoading} error={auditError} onRetry={onRetryAudit} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function NodeOverview({
  cluster,
  node,
  showAudit,
  auditTasks,
  auditLoading,
  auditError,
  onRetryAudit,
  onOpenVms,
}: {
  cluster: Cluster;
  node: Node;
  showAudit: boolean;
  auditTasks?: AuditTask[];
  auditLoading?: boolean;
  auditError?: unknown;
  onRetryAudit?: () => void;
  onOpenVms: () => void;
}) {
  return (
    <div className="space-y-4">
      <ObjectOverview cluster={cluster} node={node} />
      <ObjectInventoryPreview
        cluster={cluster}
        node={node}
        onOpenInventory={onOpenVms}
      />
      {showAudit && <RecentObjectTasks tasks={auditTasks} loading={auditLoading} error={auditError} onRetry={onRetryAudit} />}
    </div>
  );
}

/**
 * The overview must answer the operator's first question without recreating
 * the entire Nodes/VMs pages.  This is the vCenter-like inventory strip: a
 * compact, directly navigable preview with the full inventory kept in its own
 * tab.  It deliberately contains no duplicate capacity bars.
 */
