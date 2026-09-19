import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, KeyRound, Network, RefreshCw, ShieldCheck } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
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
  ca_certificate_configured: boolean;
  auto_sync_ipam: boolean;
  sync_interval_min: number;
  last_ipam_synced_at?: string | null;
  last_ipam_status?: string;
  last_ipam_error?: string;
}

interface ConnectionDialogProps {
  environmentId: string;
  connection?: ProxmoxConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProxmoxConnectionDialog(props: ConnectionDialogProps) {
  return props.open ? <ConnectionForm {...props} /> : null;
}

function ConnectionForm({environmentId, connection: requestedConnection, onOpenChange}: ConnectionDialogProps) {
  const queryClient = useQueryClient();
  const [opening] = useState(() => ({environmentId, connection: requestedConnection ? {...requestedConnection} : null}));
  const connection = opening.connection;
  const openedEnvironment = opening.environmentId;
  const contextChanged = environmentId !== openedEnvironment || (requestedConnection?.id ?? null) !== (connection?.id ?? null) || Boolean(connection && connection.environment_id !== openedEnvironment);
  const [name, setName] = useState(connection?.name || "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint || "");
  const [apiToken, setApiToken] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [caCertificate, setCaCertificate] = useState("");
  const [insecure, setInsecure] = useState(Boolean(connection?.insecure));
  const [autoSyncIpam, setAutoSyncIpam] = useState(connection?.auto_sync_ipam ?? true);
  const [syncIntervalMin, setSyncIntervalMin] = useState(String(connection?.sync_interval_min ?? 15));
  const [discardRequested, setDiscardRequested] = useState(false);
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = name !== (connection?.name || "") || endpoint !== (connection?.endpoint || "") || Boolean(apiToken || sshKey || caCertificate) || insecure !== Boolean(connection?.insecure) || autoSyncIpam !== (connection?.auto_sync_ipam ?? true) || syncIntervalMin !== String(connection?.sync_interval_min ?? 15);
  const testFingerprint = JSON.stringify([endpoint.trim(), apiToken, insecure, caCertificate]);
  const connectionVerified = testedFingerprint === testFingerprint;
  type ConnectionTest = { reachable: boolean; authenticated: boolean; checked_at: string; identity: string; version?: string | null; node_count: number; permissions: string[]; inventory_access: boolean; recommended_missing: string[] };
  const connectionTest = useMutation({
    mutationFn: () => apiFetch<ConnectionTest>('/opentofu/proxmox-connections/test', {
      method: 'POST', environmentId: openedEnvironment,
      body: { environment_id: openedEnvironment, connection_id: connection?.id, endpoint, api_token: apiToken, insecure, ca_certificate: caCertificate },
    }),
    onSuccess: () => setTestedFingerprint(testFingerprint),
  });
  const save = useMutation({
    mutationFn: () => {
      if (contextChanged) throw new Error('The environment or selected connection changed. Return to the original context before saving.');
      return apiFetch<ProxmoxConnection>(
        connection
          ? `/opentofu/proxmox-connections/${encodeURIComponent(connection.id)}`
          : "/opentofu/proxmox-connections",
        {
          method: connection ? "PUT" : "POST",
          environmentId: openedEnvironment,
          body: {
            environment_id: openedEnvironment,
            name,
            endpoint,
            api_token: apiToken,
            ssh_public_key: sshKey,
            ca_certificate: caCertificate,
            insecure,
            auto_sync_ipam: false,

          },
        },
      );
    },
    onSettled: () => { submitting.current = false; },
    onSuccess: () => {
      showToast(
        connection
          ? "Platform connection saved."
          : "Proxmox platform connected.",
        "success",
      );
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "proxmox-connections", openedEnvironment],
      });
      void queryClient.invalidateQueries({
        queryKey: ["opentofu", "infrastructure", openedEnvironment],
      });
      if (mounted.current) onOpenChange(false);
    },

  });
  const errorField = save.error instanceof ApiError ? save.error.field : undefined;
  const fieldProps = (field: string) => ({
    name: field,
    'aria-invalid': errorField === field || undefined,
    'aria-describedby': errorField === field ? `platform-error-${field}` : undefined,
  });
  const fieldError = (field: string) => errorField === field && <p id={`platform-error-${field}`} className="text-sm text-destructive">{save.error?.message}</p>;
  useEffect(() => {
    if (!save.isError || contextChanged || discardRequested || !errorField) return;
    const control = formRef.current?.elements.namedItem(errorField);
    if (control instanceof HTMLElement) control.focus();
  }, [save.isError, save.error, errorField, contextChanged, discardRequested]);
  useBlocker({
    disabled: !dirty && !save.isPending,
    enableBeforeUnload: dirty || save.isPending,
    shouldBlockFn: () => submitting.current || (dirty && !globalThis.confirm('Discard unsaved platform connection changes and leave this page?')),
  });
  const requestClose = () => {
    if (submitting.current) return;
    if (dirty) setDiscardRequested(true);
    else onOpenChange(false);
  };
  const isEdit = Boolean(connection);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) requestClose(); }}>
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
        <p className="text-xs text-muted-foreground">Environment: <strong>{openedEnvironment}</strong>{connection ? ` · ${connection.name}` : ''}</p>
        {contextChanged && <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">The environment or connection changed. This draft still belongs to {openedEnvironment}. Return to its original context before saving, or discard the draft.</div>}
        {save.isError && <div role="alert" className="rounded-md border border-destructive p-3 text-sm">{save.error instanceof Error ? save.error.message : 'The connection could not be saved.'} Your draft is preserved.</div>}
        {discardRequested && <div role="alert" className="space-y-3 rounded-md border p-3 text-sm">
          <p>Discard unsaved connection changes?</p>
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setDiscardRequested(false)}>Keep editing</Button><Button type="button" variant="destructive" onClick={() => onOpenChange(false)}>Discard changes</Button></div>
        </div>}
        <form
          ref={formRef}
          onChange={() => { if (save.isError) save.reset(); }}
          aria-busy={save.isPending}
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting.current || contextChanged || discardRequested) return;
            submitting.current = true;
            save.mutate();
          }}
        >
          <fieldset disabled={save.isPending || contextChanged || discardRequested} className="min-w-0 space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="platform-name">Display name</Label>
            <Input
              id="platform-name"
              {...fieldProps('name')}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production cluster"
            />
            {fieldError('name')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-endpoint">Proxmox API endpoint</Label>
            <Input
              id="platform-endpoint"
              {...fieldProps('endpoint')}
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://pve.example.com:8006/"
              type="url"
              inputMode="url"
            />
            {fieldError('endpoint')}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-token">Proxmox API token</Label>
            <Input
              id="platform-token"
              {...fieldProps('api_token')}
              required={!isEdit}
              value={apiToken}
              onChange={(event) => setApiToken(event.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder={
                connection?.api_token_configured
                  ? "Saved — enter only to change"
                  : "shipyard@pve!automation=…"
              }
            />
            {fieldError('api_token')}
            <p className="text-xs text-muted-foreground">
              The token is stored encrypted and is never sent to the browser
              again.
            </p>
            <div className="rounded-md border bg-muted/15 p-3 text-xs text-muted-foreground">
              <strong className="text-foreground">Use a dedicated service account.</strong>{' '}
              Example token ID: <code>shipyard@pve!automation</code>. Start with <code>Sys.Audit</code>, <code>VM.Audit</code> and <code>Datastore.Audit</code>; add <code>VM.PowerMgmt</code>, <code>VM.Snapshot</code> or <code>Sys.Modify</code> only for the actions Shipyard should perform. Avoid root tokens.
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="platform-ca-certificate">Private CA certificate <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <textarea id="platform-ca-certificate" {...fieldProps('ca_certificate')} value={caCertificate} onChange={(event) => setCaCertificate(event.target.value)} rows={4} className="flex min-h-24 w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-mono text-xs leading-5" placeholder={connection?.ca_certificate_configured ? 'Saved — enter only to replace' : '-----BEGIN CERTIFICATE-----'} />
            {fieldError('ca_certificate')}
            <p className="text-xs text-muted-foreground">Trust a private Proxmox CA while keeping certificate verification enabled.</p>
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
              {...fieldProps('ssh_public_key')}
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
            {fieldError('ssh_public_key')}
            <p className="text-xs text-muted-foreground">
              Passed on as the default for new VM definitions on this platform.
            </p>
          </div>
          <label className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
            <input
              type="checkbox"
              {...fieldProps('insecure')}
                checked={insecure}
              onChange={(event) => setInsecure(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Do not verify TLS certificate</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Last resort for temporary labs. Prefer the private CA field above.
              </span>
            </span>
          </label>
            {fieldError('insecure')}
          </fieldset>
          <div className="mt-4 space-y-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><strong>Connection and permission check</strong><p className="text-xs text-muted-foreground">Read-only requests verify authentication, node inventory and reported privileges before saving.</p></div><Button type="button" variant="outline" disabled={connectionTest.isPending || !endpoint.trim() || (!isEdit && !apiToken.trim()) || contextChanged || discardRequested} onClick={() => connectionTest.mutate()}>{connectionTest.isPending ? <RefreshCw className="animate-spin" /> : <ShieldCheck />}Test connection</Button></div>
            {connectionTest.isError && <div role="alert" className="flex gap-2 text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/><span>{connectionTest.error instanceof Error ? connectionTest.error.message : 'Connection test failed.'}</span></div>}
            {connectionTest.data && connectionVerified && <div role="status" className="space-y-1 rounded bg-emerald-500/10 p-2 text-xs"><div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4"/>Authenticated as {connectionTest.data.identity}; {connectionTest.data.node_count} node(s) visible{connectionTest.data.version ? ` · Proxmox ${connectionTest.data.version}` : ''}.</div><p>{connectionTest.data.permissions.length ? `Reported privileges: ${connectionTest.data.permissions.join(', ')}.` : 'Authentication and inventory access succeeded; Proxmox returned no explicit privilege names.'}</p>{connectionTest.data.recommended_missing.length > 0 && <p className="text-amber-700 dark:text-amber-300">Recommended inventory privileges not reported: {connectionTest.data.recommended_missing.join(', ')}. Scoped permissions may still allow the tested node inventory.</p>}</div>}
            {!connectionVerified && !connectionTest.isPending && <p className="text-xs text-muted-foreground">Test the current endpoint, token and TLS settings to enable saving.</p>}
          </div>
          {save.isPending && <p role="status" className="mt-4 text-sm text-muted-foreground">Saving connection in {openedEnvironment}. Please wait before closing.</p>}
          <DialogFooter className="mt-5">
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || connectionTest.isPending || contextChanged || discardRequested || !connectionVerified || (isEdit && !dirty)}>
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
