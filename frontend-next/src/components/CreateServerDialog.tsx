import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Trash2, KeyRound, Server, Wifi, Tag, Link2, HardDrive } from 'lucide-react';

type AnyObj = Record<string, unknown>;

interface LinkEntry { name: string; url: string }
interface MountEntry { name: string; path: string }

interface CreateServerDialogProps {
  editServer?: AnyObj | null;
  trigger?: React.ReactNode;
  onSuccess?: (server: AnyObj) => void;
  /** Controlled mode: pass open + onOpenChange to drive the dialog externally */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}

/* ── Flache Abschnitt-Überschrift ─────────────────────────────── */
function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b pb-2 pt-5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  );
}

/* ── Label-links / Input-rechts Zeile ─────────────────────────── */
function FieldRow({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-center gap-4 py-2.5">
      <div>
        <span className="text-sm font-medium text-foreground">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </span>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function CreateServerDialog({ editServer = null, trigger, onSuccess, open: openProp, onOpenChange: onOpenChangeProp }: CreateServerDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isEdit = !!editServer;

  const isControlled = openProp !== undefined;
  const [openInternal, setOpenInternal] = React.useState(false);
  const open = isControlled ? openProp! : openInternal;
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChangeProp?.(v);
    else setOpenInternal(v);
  };
  const [name, setName] = React.useState('');
  const [ip, setIp] = React.useState('');
  const [hostname, setHostname] = React.useState('');
  const [sshUser, setSshUser] = React.useState('root');
  const [sshPort, setSshPort] = React.useState('22');
  const [services, setServices] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [links, setLinks] = React.useState<LinkEntry[]>([]);
  const [mounts, setMounts] = React.useState<MountEntry[]>([]);
  const [sshPassword, setSshPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    if (editServer) {
      setName((editServer.name as string) || '');
      setIp((editServer.ip_address as string) || '');
      setHostname((editServer.hostname as string) || '');
      setSshUser((editServer.ssh_user as string) || 'root');
      setSshPort(String(editServer.ssh_port ?? 22));
      setServices(((editServer.services as string[]) || []).join(', '));
      setTags(((editServer.tags as string[]) || []).join(', '));
      const ls = (editServer.links as LinkEntry[]) || [];
      setLinks(ls.map((l) => ({ ...l })));
      const ms = (editServer.storage_mounts as MountEntry[]) || [];
      setMounts(ms.map((m) => ({ ...m })));
    } else {
      setName(''); setIp(''); setHostname(''); setSshUser('root'); setSshPort('22');
      setServices(''); setTags('');
      setLinks([]);
      setMounts([]);
    }
    setSshPassword('');
    setError(null);
  }, [editServer]);

  React.useEffect(() => { if (open) reset(); }, [open, reset]);

  const setLink = (i: number, field: keyof LinkEntry, val: string) =>
    setLinks((prev) => prev.map((l, j) => j === i ? { ...l, [field]: val } : l));
  const removeLink = (i: number) => setLinks((prev) => prev.filter((_, j) => j !== i));
  const addLink = () => setLinks((prev) => [...prev, { name: '', url: '' }]);

  const setMount = (i: number, field: keyof MountEntry, val: string) =>
    setMounts((prev) => prev.map((m, j) => j === i ? { ...m, [field]: val } : m));
  const removeMount = (i: number) => setMounts((prev) => prev.filter((_, j) => j !== i));
  const addMount = () => setMounts((prev) => [...prev, { name: '', path: '' }]);

  const mutation = useMutation({
    mutationFn: async (): Promise<AnyObj> => {
      const data: AnyObj = {
        name: name.trim(),
        ip_address: ip.trim(),
        hostname: hostname.trim() || ip.trim(),
        ssh_user: sshUser.trim() || 'root',
        ssh_port: Math.min(65535, Math.max(1, parseInt(sshPort) || 22)),
        services: services.split(',').map((s) => s.trim()).filter(Boolean),
        tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
        links: links.filter((l) => l.name || l.url),
        storage_mounts: mounts.filter((m) => m.path),
      };

      let savedServer: AnyObj;
      if (isEdit) {
        savedServer = (await api.updateServer(editServer!.id as string | number, data)) as AnyObj ?? data;
        showToast(t('add.saved', { name: data.name }), 'success');
      } else {
        savedServer = (await api.createServer(data)) as AnyObj ?? data;
        if (sshPassword) {
          try {
            await api.deploySSHKey({
              ip_address: data.ip_address,
              ssh_user: data.ssh_user,
              password: sshPassword,
              ssh_port: data.ssh_port,
            });
            showToast(t('add.transferred'), 'success');
          } catch (err) {
            showToast(t('add.transferError', { msg: (err as Error).message }), 'warning');
          }
        }
        showToast(t('add.added', { name: data.name }), 'success');
      }
      return savedServer;
    },
    onSuccess: (savedServer) => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      setOpen(false);
      onSuccess?.(savedServer);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); }}>
      {(!isControlled || trigger) && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button>
              <Plus className="h-4 w-4" />
              {t('add.titleAdd')}
            </Button>
          )}
        </DialogTrigger>
      )}

      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
        {/* ── Header ──────────────────────────────────── */}
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{isEdit ? t('add.titleEdit') : t('add.titleAdd')}</DialogTitle>
          {isEdit && !!(editServer?.name || editServer?.ip_address) && (
            <p className="text-sm text-muted-foreground">
              {String(editServer!.name ?? '')}
              {editServer!.ip_address
                ? <span className="ml-2 font-mono text-xs">{String(editServer!.ip_address)}</span>
                : null}
            </p>
          )}
        </DialogHeader>

        {/* ── Scrollable body ─────────────────────────── */}
        <form
          id="server-form"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!name.trim() || !ip.trim()) { setError(t('common.error')); return; }
            mutation.mutate();
          }}
          className="flex-1 overflow-y-auto px-6 pt-5 pb-4"
        >
          {/* ── Basic Information ───────────────────────── */}
          <SectionHeading icon={<Server className="h-3.5 w-3.5" />} title={t('add.sectionBasic')} />

          <FieldRow label={t('add.name')} required>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('add.namePlaceholder')}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t('add.ip')} required>
            <Input
              placeholder="192.168.1.100"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t('add.hostname')} hint={t('add.hostnameHint')}>
            <Input
              placeholder="plex-server"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          {/* ── Connection ──────────────────────────────── */}
          <SectionHeading icon={<Wifi className="h-3.5 w-3.5" />} title={t('add.sectionConnection')} />

          <FieldRow label={t('add.sshUser')}>
            <Input
              placeholder="root"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t('add.sshPort')}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          {/* ── Metadata ────────────────────────────────── */}
          <SectionHeading icon={<Tag className="h-3.5 w-3.5" />} title={t('add.sectionMeta')} />

          <FieldRow label={t('add.services')} hint={t('add.servicesHint')}>
            <Input
              placeholder="Plex, Docker, Nginx"
              value={services}
              onChange={(e) => setServices(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          <FieldRow label={t('add.tags')} hint={t('add.tagsHint')}>
            <Input
              placeholder="production, media"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full"
            />
          </FieldRow>

          {/* ── Links ───────────────────────────────────── */}
          <div className="flex items-center justify-between border-b pb-2 pt-5">
            <div className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('add.links')}
              </span>
            </div>
            <button
              type="button"
              onClick={addLink}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t('add.linkAdd')}
            </button>
          </div>

          {links.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">{t('add.linksEmpty')}</p>
          ) : (
            <div className="space-y-1.5 py-2">
              {links.map((link, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
                  <Input
                    placeholder={t('add.linkNamePlaceholder')}
                    value={link.name}
                    onChange={(e) => setLink(i, 'name', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Input
                    type="url"
                    placeholder="https://..."
                    value={link.url}
                    onChange={(e) => setLink(i, 'url', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeLink(i)}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
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
                {t('add.storageMounts')}
              </span>
            </div>
            <button
              type="button"
              onClick={addMount}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t('add.storageMountAdd')}
            </button>
          </div>

          {mounts.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">{t('add.mountsEmpty')}</p>
          ) : (
            <div className="space-y-1.5 py-2">
              {mounts.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
                  <Input
                    placeholder={t('add.storageMountNamePlaceholder')}
                    value={m.name}
                    onChange={(e) => setMount(i, 'name', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Input
                    placeholder="/mnt/media"
                    value={m.path}
                    onChange={(e) => setMount(i, 'path', e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeMount(i)}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* ── SSH Key (add-only) ──────────────────────── */}
          {!isEdit && (
            <>
              <SectionHeading icon={<KeyRound className="h-3.5 w-3.5" />} title={t('add.sshKeySection')} />
              <FieldRow label={t('add.sshPasswordPlaceholder')} hint={t('add.sshKeyHint')}>
                <Input
                  type="password"
                  placeholder={t('add.sshPasswordPlaceholder')}
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  autoComplete="off"
                  className="w-full"
                />
              </FieldRow>
            </>
          )}
        </form>

        {/* ── Sticky footer ───────────────────────────── */}
        <div className="flex flex-col gap-2 border-t bg-muted/30 px-6 py-3">
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="server-form" disabled={mutation.isPending}>
              {mutation.isPending ? t('add.saving') : (isEdit ? t('common.save') : t('common.add'))}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
