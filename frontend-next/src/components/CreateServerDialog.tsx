import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StringListInput, normalizeStringList } from "@/components/ui/string-list-input";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { asArray } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { useUi } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { QueryErrorState } from "@/components/ui/query-error-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Plus,
  Trash2,
  Server,
  Wifi,
  Tag,
  Link2,
  HardDrive,
  Container,
  ChevronDown,
} from "lucide-react";

type AnyObj = Record<string, unknown>;

interface LinkEntry {
  name: string;
  url: string;
}
interface MountEntry {
  name: string;
  path: string;
}
interface DetectedMount extends MountEntry {
  source?: string;
  fstype?: string;
}

interface CreateServerDialogProps {
  editServer?: AnyObj | null;
  initialValues?: AnyObj | null;
  trigger?: React.ReactNode;
  onSuccess?: (server: AnyObj) => void;
  /** Controlled mode: pass open + onOpenChange to drive the dialog externally */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}

/* Flat section heading */
function SectionHeading({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b pb-2 pt-5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
    </div>
  );
}

/* ── Label-links / Input-rechts Zeile ─────────────────────────── */
function FieldRow({
  label,
  hint,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div>
        <label
          htmlFor={htmlFor}
          className="text-sm font-medium text-foreground"
        >
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function CreateServerDialog({
  editServer = null,
  initialValues = null,
  trigger,
  onSuccess,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: CreateServerDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const activeEnvironmentId = useUi((s) => s.environmentId);
  const environmentsQuery = useQuery({
    queryKey: ["environments"],
    queryFn: () => api.getEnvironments(),
  });
  const environmentsData = environmentsQuery.data;
  const environments = Array.isArray(environmentsData) ? environmentsData : [];
  const isEdit = !!editServer;

  const isControlled = openProp !== undefined;
  const [openInternal, setOpenInternal] = React.useState(false);
  const open = isControlled ? openProp! : openInternal;
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChangeProp?.(v);
    else setOpenInternal(v);
  };
  const [name, setName] = React.useState("");
  const [ip, setIp] = React.useState("");
  const [hostname, setHostname] = React.useState("");
  const [sshUser, setSshUser] = React.useState("root");
  const [sshPort, setSshPort] = React.useState("22");
  const [owner, setOwner] = React.useState("");
  const [services, setServices] = React.useState<string[]>([]);
  const [tags, setTags] = React.useState<string[]>([]);
  const [links, setLinks] = React.useState<LinkEntry[]>([]);
  const [mounts, setMounts] = React.useState<MountEntry[]>([]);
  const [sshPassword, setSshPassword] = React.useState("");
  const [dockerEnabled, setDockerEnabled] = React.useState(false);
  const [environmentId, setEnvironmentId] = React.useState(activeEnvironmentId);
  const [error, setError] = React.useState<string | null>(null);
  const [connectionTest, setConnectionTest] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [connectionTestError, setConnectionTestError] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(isEdit);
  const connectionRequest = React.useRef(0);
  const invalidateConnectionTest = React.useCallback(() => {
    connectionRequest.current += 1;
    setConnectionTest('idle');
    setConnectionTestError(null);
  }, []);
  const validSshPort = /^\d+$/.test(sshPort) && Number(sshPort) >= 1 && Number(sshPort) <= 65535;
  React.useEffect(() => {
    if (!open) invalidateConnectionTest();
    return () => { connectionRequest.current += 1; };
  }, [open, invalidateConnectionTest]);

  const [baseline, setBaseline] = React.useState('');
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [draftEnvironment, setDraftEnvironment] = React.useState(activeEnvironmentId);
  const [draftServerId, setDraftServerId] = React.useState(editServer?.id ?? null);
  const currentDraft = JSON.stringify({ name, ip, hostname, sshUser, sshPort, owner, services, tags, links, mounts, sshPassword, dockerEnabled, environmentId });
  const dirty = baseline !== '' && currentDraft !== baseline;
  const contextChanged = draftEnvironment !== activeEnvironmentId || draftServerId !== (editServer?.id ?? null);
  React.useEffect(() => { if (contextChanged) invalidateConnectionTest(); }, [contextChanged, invalidateConnectionTest]);

  const reset = React.useCallback(() => {
    const source = editServer || initialValues;
    const draft = {
      name: (source?.name as string) || '',
      ip: (source?.ip_address as string) || '',
      hostname: (source?.hostname as string) || '',
      sshUser: (source?.ssh_user as string) || 'root',
      sshPort: String(source?.ssh_port ?? 22),
      owner: (source?.owner as string) || '',
      services: editServer ? asArray<string>(editServer.services) : [],
      tags: asArray<string>(source?.tags),
      links: editServer ? asArray<LinkEntry>(editServer.links).map(item => ({ ...item })) : [],
      mounts: editServer ? asArray<MountEntry>(editServer.storage_mounts).map(item => ({ ...item })) : [],
      sshPassword: '',
      dockerEnabled: !!editServer?.docker_enabled,
      environmentId: (source?.environment_id as string) || (editServer ? 'default' : activeEnvironmentId),
    };
    setName(draft.name); setIp(draft.ip); setHostname(draft.hostname); setSshUser(draft.sshUser); setSshPort(draft.sshPort); setOwner(draft.owner);
    setServices(draft.services); setTags(draft.tags); setLinks(draft.links); setMounts(draft.mounts);
    setSshPassword(draft.sshPassword); setDockerEnabled(draft.dockerEnabled); setEnvironmentId(draft.environmentId);
    setBaseline(JSON.stringify(draft));
    setDraftEnvironment(activeEnvironmentId); setDraftServerId(editServer?.id ?? null);
    setDiscardOpen(false); setError(null); invalidateConnectionTest(); setAdvancedOpen(isEdit);
  }, [editServer, initialValues, activeEnvironmentId, isEdit, invalidateConnectionTest]);

  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) reset();
    wasOpen.current = open;
  }, [open, reset]);

  React.useEffect(() => {
    if (!open || !dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [open, dirty]);

  const setLink = (i: number, field: keyof LinkEntry, val: string) =>
    setLinks((prev) =>
      prev.map((l, j) => (j === i ? { ...l, [field]: val } : l)),
    );
  const removeLink = (i: number) =>
    setLinks((prev) => prev.filter((_, j) => j !== i));
  const addLink = () => setLinks((prev) => [...prev, { name: "", url: "" }]);

  const setMount = (i: number, field: keyof MountEntry, val: string) =>
    setMounts((prev) =>
      prev.map((m, j) => (j === i ? { ...m, [field]: val } : m)),
    );
  const removeMount = (i: number) =>
    setMounts((prev) => prev.filter((_, j) => j !== i));
  const addMount = () => setMounts((prev) => [...prev, { name: "", path: "" }]);
  // Network shares found on the host that are not monitored yet.
  const editId = editServer?.id as string | undefined;
  const hostInfo = useQuery({ queryKey: ["server", editId, "info"], queryFn: () => api.getServerInfo(editId as string), enabled: open && Boolean(editId) });
  const detectedMounts = asArray<DetectedMount>(hostInfo.data?.detected_mounts).filter(item => item?.path && !mounts.some(mount => mount.path === item.path));
  const addDetectedMounts = (items: DetectedMount[]) => setMounts(prev => [...prev.filter(mount => mount.path), ...items.map(item => ({ name: item.name, path: item.path }))]);

  const mutation = useMutation({
    mutationFn: async (): Promise<AnyObj> => {
      if (contextChanged) throw new Error('The active environment or host changed. Reopen this form before saving.');
      const data: AnyObj = {
        name: name.trim(),
        ip_address: ip.trim(),
        hostname: hostname.trim() || ip.trim(),
        ssh_user: sshUser.trim() || "root",
        ssh_port: Number(sshPort),
        owner: owner.trim(),
        services: normalizeStringList(services),
        tags: normalizeStringList(tags),
        links: links.filter((l) => l.name || l.url),
        storage_mounts: mounts.filter((m) => m.path),
        environment_id: environmentId,
        ...(isEdit && { dockerEnabled }),
      };

      let savedServer: AnyObj;
      if (isEdit) {
        savedServer =
          ((await api.updateServer(
            editServer!.id as string | number,
            data,
          )) as AnyObj) ?? data;
        showToast(t("add.saved", { name: data.name }), "success");
      } else {
        savedServer = ((await api.createServer(data)) as AnyObj) ?? data;
        if (sshPassword) {
          try {
            await api.deploySSHKey({
              ip_address: data.ip_address,
              ssh_user: data.ssh_user,
              password: sshPassword,
              ssh_port: data.ssh_port,
              environment_id: data.environment_id,
              server_id: savedServer.id,
            });
            showToast(t("add.transferred"), "success");
          } catch (err) {
            showToast(
              t("add.transferError", { msg: (err as Error).message }),
              "warning",
            );
          }
        }
        showToast(t("add.added", { name: data.name }), "success");
      }
      return savedServer;
    },
    onSuccess: (savedServer) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      if (editServer) {
        void qc.invalidateQueries({ queryKey: ["server", editServer.id] });
        // Changed mounts are measured in the background right after saving.
        window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["server", editServer.id, "info"] }), 8000);
      }
      setOpen(false);
      onSuccess?.(savedServer);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });
  const requestClose = () => {
    if (mutation.isPending) return;
    if (dirty) setDiscardOpen(true);
    else setOpen(false);
  };
  const testConnection = async () => {
    if (!validSshPort || contextChanged) return;
    const request = ++connectionRequest.current;
    setConnectionTest('testing');
    setConnectionTestError(null);
    try {
      const result = await api.testNewServerConnection({
        ip_address: ip.trim(),
        ssh_user: sshUser.trim() || 'root',
        ssh_port: Number(sshPort),
        password: sshPassword,
        environment_id: environmentId,
      });
      if (request !== connectionRequest.current) return;
      setConnectionTest(result.connected ? 'success' : 'error');
      if (!result.connected) {
        const cause = result.error || 'The host did not accept the supplied SSH connection details.';
        setConnectionTestError(cause);
        showToast(cause, 'error');
      }
    } catch (testError) {
      if (request !== connectionRequest.current) return;
      setConnectionTest('error');
      const cause = (testError as Error).message || 'Connection test failed.';
      setConnectionTestError(cause);
      showToast(cause, 'error');
    }
  };

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) setOpen(true); else requestClose();
      }}
    >
      {(!isControlled || trigger) && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button>
              <Plus className="h-4 w-4" />
              {t("add.titleAdd")}
            </Button>
          )}
        </DialogTrigger>
      )}

      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {/* ── Header ──────────────────────────────────── */}
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle>
            {isEdit ? t("add.titleEdit") : t("add.titleAdd")}
          </DialogTitle>
          {isEdit && !!(editServer?.name || editServer?.ip_address) && (
            <p className="text-sm text-muted-foreground">
              {String(editServer!.name ?? "")}
              {editServer!.ip_address ? (
                <span className="ml-2 font-mono text-xs">
                  {String(editServer!.ip_address)}
                </span>
              ) : null}
            </p>
          )}
        </DialogHeader>

        {/* ── Scrollable body ─────────────────────────── */}
        <form
          id="server-form"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!name.trim() || !ip.trim()) {
              setError(t("common.error"));
              return;
            }
            if (!validSshPort) {
              setError('SSH port must be a whole number between 1 and 65535.');
              setAdvancedOpen(true);
              return;
            }
            mutation.mutate();
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-5 sm:px-6"
        >
          {/* ── Basic Information ───────────────────────── */}
          <SectionHeading
            icon={<Server className="h-3.5 w-3.5" />}
            title={t("add.sectionBasic")}
          />

          <FieldRow
            label="Environment"
            hint={isEdit ? "The host belongs to this environment. Moving existing resources is not supported in this form." : "The host will be created in this environment."}
            htmlFor="server-environment"
          >
            <div className="w-full space-y-2">
              {environmentsQuery.isError && (
                <QueryErrorState
                  compact
                  className="py-3"
                  error={environmentsQuery.error}
                  title="Environments could not be loaded"
                  onRetry={() => void environmentsQuery.refetch()}
                />
              )}
              <select
                id="server-environment"
                name="environmentId"
                value={environmentId}
                onChange={(e) => { setEnvironmentId(e.target.value); invalidateConnectionTest(); }}
                disabled={isEdit || mutation.isPending || environmentsQuery.isLoading || environmentsQuery.isError}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {!environments.some((environment) => String(environment.id) === environmentId) && <option value={environmentId}>{environmentId}</option>}
                {environments.map((environment) => (
                  <option
                    key={String(environment.id)}
                    value={String(environment.id)}
                  >
                    {String(environment.name)}
                  </option>
                ))}
              </select>
            </div>
          </FieldRow>


          <FieldRow label={t("add.name")} required htmlFor="server-name">
            <Input
              id="server-name"
              name="serverName"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("add.namePlaceholder")}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t("add.ip")} required htmlFor="server-ip-address">
            <Input
              id="server-ip-address"
              name="serverIpAddress"
              required
              placeholder="192.168.1.100"
              value={ip}
              onChange={(e) => { setIp(e.target.value); invalidateConnectionTest(); }}
              className="w-full"
            />
          </FieldRow>

          {!isEdit && (
            <FieldRow
              label={t("add.sshPasswordPlaceholder")}
              hint="Used only for the connection test and initial key installation. The password is never stored."
              htmlFor="server-ssh-password"
            >
              <div className="w-full space-y-1.5">
                <div className="flex gap-2">
                  <Input id="server-ssh-password" name="sshPassword" type="password" placeholder={t("add.sshPasswordPlaceholder")} value={sshPassword} onChange={(e) => { setSshPassword(e.target.value); invalidateConnectionTest(); }} autoComplete="current-password" className="w-full" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void testConnection()} disabled={contextChanged || !ip.trim() || !sshPassword || !validSshPort || connectionTest === 'testing'}>
                    <Wifi className={connectionTest === 'testing' ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />Test
                  </Button>
                </div>
                {connectionTest === 'success' && <p role="status" className="text-xs text-success">Connection successful.</p>}
                {connectionTest === 'error' && <p role="alert" className="text-xs text-destructive">Connection failed: {connectionTestError}</p>}
              </div>
            </FieldRow>
          )}

          <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="group mt-4 border-t">
            <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-left">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
                <Tag className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Advanced options</span>
                <span className="block text-[13px] text-muted-foreground">Hostname, SSH settings, metadata, links, and storage.</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t pb-2">

          <FieldRow
            label={t("add.hostname")}
            hint={t("add.hostnameHint")}
            htmlFor="server-hostname"
          >
            <Input
              id="server-hostname"
              name="serverHostname"
              placeholder="plex-server"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          {/* ── Connection ──────────────────────────────── */}
          <SectionHeading
            icon={<Wifi className="h-3.5 w-3.5" />}
            title={t("add.sectionConnection")}
          />

          <FieldRow label={t("add.sshUser")} htmlFor="server-ssh-user">
            <Input
              id="server-ssh-user"
              name="sshUsername"
              autoComplete="username"
              placeholder="root"
              value={sshUser}
              onChange={(e) => { setSshUser(e.target.value); invalidateConnectionTest(); }}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t("add.sshPort")} htmlFor="server-ssh-port">
            <Input
              id="server-ssh-port"
              name="sshPort"
              type="number"
              min={1}
              max={65535}
              required
              step={1}
              value={sshPort}
              onChange={(e) => { setSshPort(e.target.value); invalidateConnectionTest(); }}
              aria-invalid={!validSshPort}
              aria-describedby={!validSshPort ? "server-port-error" : undefined}
              className="w-full"
            />
          </FieldRow>

          {!validSshPort && <p id="server-port-error" role="alert" className="text-xs text-destructive">SSH port must be a whole number between 1 and 65535.</p>}

          {/* ── Metadata ────────────────────────────────── */}
          <SectionHeading
            icon={<Tag className="h-3.5 w-3.5" />}
            title={t("add.sectionMeta")}
          />

          <FieldRow
            label="Owner / team"
            hint="Optional operational owner shown in the host inventory."
            htmlFor="server-owner"
          >
            <Input id="server-owner" name="serverOwner" value={owner} maxLength={100} onChange={(event) => setOwner(event.target.value)} placeholder="e.g. Platform Operations" className="w-full" />
          </FieldRow>

          <FieldRow
            label={t("add.services")}
            hint="Manage services as individual entries."
            htmlFor="server-services"
          >
            <StringListInput id="server-services" label="Service" values={services} onChange={setServices} disabled={mutation.isPending} />
          </FieldRow>

          <FieldRow
            label={t("add.tags")}
            hint="Manage tags as individual entries."
            htmlFor="server-tags"
          >
            <StringListInput id="server-tags" label="Tag" values={tags} onChange={setTags} disabled={mutation.isPending} />
          </FieldRow>
          {/* ── Links ───────────────────────────────────── */}
          <div className="flex items-center justify-between border-b pb-2 pt-5">
            <div className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("add.links")}
              </span>
            </div>
            <button
              type="button"
              onClick={addLink}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t("add.linkAdd")}
            </button>
          </div>

          {links.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("add.linksEmpty")}
            </p>
          ) : (
            <div className="space-y-1.5 py-2">
              {links.map((link, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center"
                >
                  <Input
                    aria-label={`${t("add.linkNamePlaceholder")} ${i + 1}`}
                    name={`links.${i}.name`}
                    placeholder={t("add.linkNamePlaceholder")}
                    value={link.name}
                    onChange={(e) => setLink(i, "name", e.target.value)}
                    className="h-8 w-full text-sm"
                  />
                  <Input
                    aria-label={`Link URL ${i + 1}`}
                    name={`links.${i}.url`}
                    type="url"
                    placeholder="https://..."
                    value={link.url}
                    onChange={(e) => setLink(i, "url", e.target.value)}
                    className="h-8 w-full text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeLink(i)}
                    className="h-8 w-8 justify-self-end text-muted-foreground hover:text-destructive"
                    aria-label={`Remove link ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* ── Storage Mounts ──────────────────────────── */}
          <div className="flex items-center justify-between border-b pb-2 pt-5">
            <div className="flex items-center gap-2">
              <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("add.storageMounts")}
              </span>
            </div>
            <button
              type="button"
              onClick={addMount}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t("add.storageMountAdd")}
            </button>
          </div>

          {mounts.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("add.mountsEmpty")}
            </p>
          ) : (
            <div className="space-y-1.5 py-2">
              {mounts.map((m, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-center"
                >
                  <Input
                    aria-label={`${t("add.storageMountNamePlaceholder")} ${i + 1}`}
                    name={`storageMounts.${i}.name`}
                    placeholder={t("add.storageMountNamePlaceholder")}
                    value={m.name}
                    onChange={(e) => setMount(i, "name", e.target.value)}
                    className="h-8 w-full text-sm"
                  />
                  <Input
                    aria-label={`Storage mount path ${i + 1}`}
                    name={`storageMounts.${i}.path`}
                    placeholder="/mnt/media"
                    value={m.path}
                    onChange={(e) => setMount(i, "path", e.target.value)}
                    className="h-8 w-full text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeMount(i)}
                    className="h-8 w-8 justify-self-end text-muted-foreground hover:text-destructive"
                    aria-label={`Remove storage mount ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {detectedMounts.length > 0 && (
            <div className="mb-2 rounded-md border border-dashed p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Detected on this host</p>
                {detectedMounts.length > 1 && <button type="button" onClick={() => addDetectedMounts(detectedMounts)} className="text-xs text-primary hover:underline">Add all</button>}
              </div>
              <ul className="mt-2 space-y-1.5">
                {detectedMounts.map(item => (
                  <li key={item.path} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0"><span className="font-mono text-xs">{item.path}</span><span className="block truncate text-xs text-muted-foreground">{item.source}{item.fstype ? ` · ${item.fstype}` : ''}</span></span>
                    <Button type="button" variant="outline" size="sm" onClick={() => addDetectedMounts([item])}><Plus className="h-3 w-3" />Add</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Docker (edit-only) ─────────────────────── */}
          {isEdit && (
            <>
              <SectionHeading
                icon={<Container className="h-3.5 w-3.5" />}
                title={t("add.dockerSection")}
              />
              <FieldRow
                label={t("add.dockerEnabled")}
                hint={t("add.dockerEnabledHint")}
              >
                <Switch
                  aria-label={t("add.dockerEnabled")}
                  checked={dockerEnabled}
                  onCheckedChange={setDockerEnabled}
                />
              </FieldRow>
            </>
          )}
            </div>
          </details>
        </form>

        {/* ── Sticky footer ───────────────────────────── */}
        <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 sm:px-6">
          {contextChanged && <p role="alert" className="text-sm text-destructive">The active environment or host changed. Your draft is preserved; return to the original context or reopen this form before saving.</p>}
          {dirty && <p className="text-xs text-muted-foreground">Unsaved changes</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={requestClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              form="server-form"
              disabled={mutation.isPending || contextChanged}
            >
              {mutation.isPending
                ? t("add.saving")
                : isEdit
                  ? t("common.save")
                  : t("common.add")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen} title="Discard host changes?" description="Your unsaved host settings will be lost." confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={() => { setDiscardOpen(false); setOpen(false); }} />
    </>
  );
}
