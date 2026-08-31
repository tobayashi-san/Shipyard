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
  const { data: environmentsData } = useQuery({
    queryKey: ["environments"],
    queryFn: () => api.getEnvironments(),
  });
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
  const [services, setServices] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [links, setLinks] = React.useState<LinkEntry[]>([]);
  const [mounts, setMounts] = React.useState<MountEntry[]>([]);
  const [sshPassword, setSshPassword] = React.useState("");
  const [dockerEnabled, setDockerEnabled] = React.useState(false);
  const [environmentId, setEnvironmentId] = React.useState(activeEnvironmentId);
  const [error, setError] = React.useState<string | null>(null);
  const [connectionTest, setConnectionTest] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [advancedOpen, setAdvancedOpen] = React.useState(isEdit);

  const reset = React.useCallback(() => {
    if (editServer) {
      setName((editServer.name as string) || "");
      setIp((editServer.ip_address as string) || "");
      setHostname((editServer.hostname as string) || "");
      setSshUser((editServer.ssh_user as string) || "root");
      setSshPort(String(editServer.ssh_port ?? 22));
      setServices(asArray<string>(editServer.services).join(", "));
      setTags(asArray<string>(editServer.tags).join(", "));
      const ls = asArray<LinkEntry>(editServer.links);
      setLinks(ls.map((l) => ({ ...l })));
      const ms = asArray<MountEntry>(editServer.storage_mounts);
      setMounts(ms.map((m) => ({ ...m })));
      setDockerEnabled(!!editServer.docker_enabled);
      setEnvironmentId((editServer.environment_id as string) || "default");
    } else {
      setName((initialValues?.name as string) || "");
      setIp((initialValues?.ip_address as string) || "");
      setHostname((initialValues?.hostname as string) || "");
      setSshUser((initialValues?.ssh_user as string) || "root");
      setSshPort(String(initialValues?.ssh_port ?? 22));
      setServices("");
      setTags(asArray<string>(initialValues?.tags).join(", "));
      setLinks([]);
      setMounts([]);
      setDockerEnabled(false);
      setEnvironmentId((initialValues?.environment_id as string) || activeEnvironmentId);
    }
    setSshPassword("");
    setError(null);
    setConnectionTest('idle');
    setAdvancedOpen(isEdit);
  }, [editServer, initialValues, activeEnvironmentId, isEdit]);

  React.useEffect(() => {
    if (open) reset();
  }, [open, reset]);

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

  const mutation = useMutation({
    mutationFn: async (): Promise<AnyObj> => {
      const data: AnyObj = {
        name: name.trim(),
        ip_address: ip.trim(),
        hostname: hostname.trim() || ip.trim(),
        ssh_user: sshUser.trim() || "root",
        ssh_port: Math.min(65535, Math.max(1, parseInt(sshPort) || 22)),
        services: services
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        tags: tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
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
      setOpen(false);
      onSuccess?.(savedServer);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : String(err)),
  });
  const testConnection = async () => {
    setConnectionTest('testing');
    try {
      const result = await api.testNewServerConnection({
        ip_address: ip.trim(),
        ssh_user: sshUser.trim() || 'root',
        ssh_port: Math.min(65535, Math.max(1, parseInt(sshPort) || 22)),
        password: sshPassword,
      });
      setConnectionTest(result.connected ? 'success' : 'error');
      if (!result.connected) showToast(result.error || 'Connection test failed.', 'error');
    } catch (testError) {
      setConnectionTest('error');
      showToast((testError as Error).message, 'error');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
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

      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
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
            mutation.mutate();
          }}
          className="flex-1 overflow-y-auto px-4 pb-4 pt-5 sm:px-6"
        >
          {/* ── Basic Information ───────────────────────── */}
          <SectionHeading
            icon={<Server className="h-3.5 w-3.5" />}
            title={t("add.sectionBasic")}
          />

          <FieldRow label={t("add.name")} required htmlFor="server-name">
            <Input
              id="server-name"
              name="serverName"
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
              placeholder="192.168.1.100"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
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
                  <Input id="server-ssh-password" name="sshPassword" type="password" placeholder={t("add.sshPasswordPlaceholder")} value={sshPassword} onChange={(e) => { setSshPassword(e.target.value); setConnectionTest('idle'); }} autoComplete="current-password" className="w-full" />
                  <Button type="button" variant="outline" size="sm" onClick={() => void testConnection()} disabled={!ip.trim() || !sshPassword || connectionTest === 'testing'}>
                    <Wifi className={connectionTest === 'testing' ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />Test
                  </Button>
                </div>
                {connectionTest === 'success' && <p role="status" className="text-xs text-success">Connection successful.</p>}
                {connectionTest === 'error' && <p role="status" className="text-xs text-destructive">Connection failed. Review the connection details.</p>}
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
              onChange={(e) => setSshUser(e.target.value)}
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
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          {/* ── Metadata ────────────────────────────────── */}
          <SectionHeading
            icon={<Tag className="h-3.5 w-3.5" />}
            title={t("add.sectionMeta")}
          />

          <FieldRow
            label={t("add.services")}
            hint={t("add.servicesHint")}
            htmlFor="server-services"
          >
            <Input
              id="server-services"
              name="services"
              placeholder="Plex, Docker, Nginx"
              value={services}
              onChange={(e) => setServices(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          <FieldRow
            label={t("add.tags")}
            hint={t("add.tagsHint")}
            htmlFor="server-tags"
          >
            <Input
              id="server-tags"
              name="tags"
              placeholder="production, media"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full"
            />
          </FieldRow>
          <FieldRow
            label="Environment"
            hint="Controls which console environment this host appears in."
            htmlFor="server-environment"
          >
            <select
              id="server-environment"
              name="environmentId"
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {environments.map((environment) => (
                <option
                  key={String(environment.id)}
                  value={String(environment.id)}
                >
                  {String(environment.name)}
                </option>
              ))}
            </select>
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              form="server-form"
              disabled={mutation.isPending}
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
  );
}
