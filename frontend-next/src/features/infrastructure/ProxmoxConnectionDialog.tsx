import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Network, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { showToast } from "@/lib/toast";
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

export interface ProxmoxConnection {
  id: string;
  environment_id: string;
  name: string;
  endpoint: string;
  insecure: boolean;
  api_token_configured: boolean;
  ssh_public_key_configured: boolean;
  auto_sync_ipam: boolean;
  sync_interval_min: number;
  last_ipam_synced_at?: string | null;
  last_ipam_status?: string;
  last_ipam_error?: string;
}

export function ProxmoxConnectionDialog({
  environmentId,
  connection,
  open,
  onOpenChange,
}: {
  environmentId: string;
  connection?: ProxmoxConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [autoSyncIpam, setAutoSyncIpam] = useState(true);
  const [syncIntervalMin, setSyncIntervalMin] = useState("15");
  useEffect(() => {
    if (!open) return;
    setName(connection?.name || "");
    setEndpoint(connection?.endpoint || "");
    setApiToken("");
    setSshKey("");
    setInsecure(Boolean(connection?.insecure));
    setAutoSyncIpam(connection?.auto_sync_ipam ?? true);
    setSyncIntervalMin(String(connection?.sync_interval_min || 15));
  }, [connection, open]);
  const save = useMutation({
    mutationFn: () =>
      apiFetch<ProxmoxConnection>(
        connection
          ? `/opentofu/proxmox-connections/${encodeURIComponent(connection.id)}`
          : "/opentofu/proxmox-connections",
        {
          method: connection ? "PUT" : "POST",
          body: {
            environment_id: environmentId,
            name,
            endpoint,
            api_token: apiToken,
            ssh_public_key: sshKey,
            insecure,
            auto_sync_ipam: autoSyncIpam,
            sync_interval_min: Number(syncIntervalMin),
          },
        },
      ),
    onSuccess: () => {
      showToast(
        connection
          ? "Platform connection saved."
          : "Proxmox platform connected.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "proxmox-connections", environmentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "infrastructure", environmentId],
      });
      onOpenChange(false);
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
  const isEdit = Boolean(connection);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            {isEdit ? "Edit platform connection" : "Connect Proxmox platform"}
          </DialogTitle>
          <DialogDescription>
            The connection belongs to the environment, not to one deployment.
            Deployments can reuse it afterwards.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="platform-name">Anzeigename</Label>
            <Input
              id="platform-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production cluster"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-endpoint">Proxmox API-Endpunkt</Label>
            <Input
              id="platform-endpoint"
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://pve.example.com:8006/"
              inputMode="url"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-token">Proxmox API token</Label>
            <Input
              id="platform-token"
              required={!isEdit}
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder={
                connection?.api_token_configured
                  ? "Saved — enter only to change"
                  : "root@pam!fleet=…"
              }
            />
            <p className="text-xs text-muted-foreground">
              The token is stored encrypted and is never sent to the browser
              again.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-ssh-key">
              Default SSH public key{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <textarea
              id="platform-ssh-key"
              value={sshKey}
              onChange={(event) => setSshKey(event.target.value)}
              rows={3}
              className="flex min-h-20 w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-mono text-xs leading-5 shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.025)] outline-none"
              placeholder={
                connection?.ssh_public_key_configured
                  ? "Saved — enter only to change"
                  : "ssh-ed25519 AAAA…"
              }
            />
            <p className="text-xs text-muted-foreground">
              Passed on as the default for new VM definitions on this platform.
            </p>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoSyncIpam}
                onChange={(event) => setAutoSyncIpam(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Automatically synchronize IPAM</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Discover Proxmox VM and container addresses in every matching
                  network. Manual synchronization remains available.
                </span>
              </span>
            </label>
            <div className="space-y-1.5 pl-5">
              <Label htmlFor="platform-sync-interval">Interval in minutes</Label>
              <Input
                id="platform-sync-interval"
                type="number"
                min={5}
                max={1440}
                required={autoSyncIpam}
                disabled={!autoSyncIpam}
                value={syncIntervalMin}
                onChange={(event) => setSyncIntervalMin(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Between 5 minutes and 24 hours.
              </p>
            </div>
          </div>
          <label className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
            <input
              type="checkbox"
              checked={insecure}
              onChange={(event) => setInsecure(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Do not verify TLS certificate</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Only for self-signed certificates.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <RefreshCw className="animate-spin" />
              ) : (
                <KeyRound />
              )}
              {isEdit ? "Save" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
