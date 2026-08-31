import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryErrorState } from "@/components/ui/query-error-state";
import { Label } from "@/components/ui/label";
import type { ProxmoxConnection } from "@/features/infrastructure/ProxmoxConnectionDialog";
import { VmFormDialog } from "./VmFormDialog";

/** Two-step VM creation: choose a platform, then define the isolated VM. */
export function CreateDeploymentDialog({ environmentId, open, onOpenChange }: { environmentId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [connectionId, setConnectionId] = useState("");
  const [vmFormOpen, setVmFormOpen] = useState(false);
  const connectionsQuery = useQuery({
    queryKey: ["opentofu", "proxmox-connections", environmentId],
    queryFn: () => apiFetch<ProxmoxConnection[]>(`/opentofu/proxmox-connections?environment_id=${encodeURIComponent(environmentId)}`),
    enabled: open,
    staleTime: 15_000,
  });
  const connections = Array.isArray(connectionsQuery.data) ? connectionsQuery.data : [];

  useEffect(() => {
    if (!open) return;
    setConnectionId((current) => connections.some((connection) => connection.id === current) ? current : connections[0]?.id || "");
  }, [connections, open]);

  const continueToVm = () => {
    if (!connectionId) return;
    onOpenChange(false);
    setVmFormOpen(true);
  };

  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Server className="h-5 w-5" />New virtual machine</DialogTitle>
          <DialogDescription>Select the Proxmox platform. Shipyard keeps this virtual machine isolated with its own plans and run history.</DialogDescription>
        </DialogHeader>
        {connectionsQuery.isError ? (
          <QueryErrorState compact error={connectionsQuery.error} title="Proxmox platforms could not be loaded" onRetry={() => void connectionsQuery.refetch()} />
        ) : (
          <div className="space-y-2 py-2">
            <Label htmlFor="vm-platform">Proxmox platform</Label>
            <select id="vm-platform" required value={connectionId} onChange={(event) => setConnectionId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm" disabled={connectionsQuery.isLoading || connections.length === 0}>
              <option value="">{connectionsQuery.isLoading ? "Loading…" : "Select platform…"}</option>
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.endpoint}</option>)}
            </select>
            {connections.length === 0 && connectionsQuery.isSuccess && <p className="text-xs text-amber-700 dark:text-amber-300">Create a Proxmox connection from the Virtual machines page first.</p>}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!connectionId} onClick={continueToVm}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <VmFormDialog environmentId={environmentId} connectionId={connectionId} open={vmFormOpen} onOpenChange={setVmFormOpen} />
  </>;
}
