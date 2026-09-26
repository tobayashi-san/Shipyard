import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CloudUpload, Pencil, Play, Plus, PlugZap, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Timestamp } from '@/components/ui/timestamp';
import { showToast } from '@/lib/toast';

type TargetType = 'smb' | 'sftp' | 's3' | 'drive' | 'webdav' | 'local';
interface BackupTarget {
  id: string; name: string; type: TargetType; remote_path: string; cron_expression: string; keep_count: number; enabled: boolean;
  settings: Record<string, string>; secrets: Record<string, boolean>; passphrase_set: boolean;
  last_run_at: string | null; last_status: string | null; last_error: string | null; last_file: string | null;
}
interface TargetList { targets: BackupTarget[]; types: Record<TargetType, string>; s3_providers: string[] }

// Field labels per destination; secrets are write-only and blank keeps the stored value.
const FIELDS: Record<TargetType, { key: string; label: string; placeholder?: string; secret?: boolean; multiline?: boolean }[]> = {
  smb: [{ key: 'host', label: 'Server', placeholder: 'nas.local or 10.40.2.10' }, { key: 'share', label: 'Share', placeholder: 'backups' }, { key: 'user', label: 'User' }, { key: 'pass', label: 'Password', secret: true }, { key: 'domain', label: 'Domain (optional)', placeholder: 'WORKGROUP' }],
  sftp: [{ key: 'host', label: 'Server' }, { key: 'port', label: 'Port', placeholder: '22' }, { key: 'user', label: 'User' }, { key: 'pass', label: 'Password', secret: true }, { key: 'key_pem', label: 'Private key (instead of a password)', secret: true, multiline: true }],
  s3: [{ key: 'provider', label: 'Provider' }, { key: 'endpoint', label: 'Endpoint (empty for AWS)', placeholder: 'https://s3.eu-central-003.backblazeb2.com' }, { key: 'region', label: 'Region', placeholder: 'eu-central-1' }, { key: 'bucket', label: 'Bucket' }, { key: 'access_key_id', label: 'Access key ID', secret: true }, { key: 'secret_access_key', label: 'Secret access key', secret: true }],
  drive: [{ key: 'token', label: 'Token JSON', secret: true, multiline: true }, { key: 'root_folder_id', label: 'Folder ID (optional)' }, { key: 'client_id', label: 'Client ID (optional)', secret: true }, { key: 'client_secret', label: 'Client secret (optional)', secret: true }],
  webdav: [{ key: 'url', label: 'URL', placeholder: 'https://cloud.example.com/remote.php/dav/files/user' }, { key: 'vendor', label: 'Vendor', placeholder: 'nextcloud' }, { key: 'user', label: 'User' }, { key: 'pass', label: 'Password or app password', secret: true }],
  local: [],
};
const SCHEDULES = [['30 2 * * *', 'Daily at 02:30'], ['30 2 * * 0', 'Weekly, Sunday 02:30'], ['30 2 1 * *', 'Monthly, 1st at 02:30']] as const;

interface Draft { id?: string; type: TargetType; name: string; remote_path: string; cron_expression: string; keep_count: string; enabled: boolean; settings: Record<string, string>; secrets: Record<string, string>; passphrase: string; repeat: string; password: string; code: string }
const emptyDraft = (): Draft => ({ type: 'smb', name: '', remote_path: 'fleet', cron_expression: '30 2 * * *', keep_count: '14', enabled: true, settings: {}, secrets: {}, passphrase: '', repeat: '', password: '', code: '' });

function statusTone(status: string | null) {
  return status === 'success' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'info' : 'muted';
}

export function BackupTargetsCard() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['backup-targets'], queryFn: () => apiFetch<TargetList>('/system/backup-targets'), refetchInterval: query => query.state.data?.targets.some(target => target.last_status === 'running') ? 5000 : false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [existing, setExisting] = useState<BackupTarget | null>(null);
  const [remove, setRemove] = useState<BackupTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['backup-targets'] });

  const save = useMutation({
    mutationFn: (value: Draft) => {
      const body = { name: value.name, type: value.type, remote_path: value.remote_path, cron_expression: value.cron_expression, keep_count: Number(value.keep_count), enabled: value.enabled, settings: value.settings, secrets: value.secrets, passphrase: value.passphrase, password: value.password, code: value.code };
      return value.id ? apiFetch(`/system/backup-targets/${value.id}`, { method: 'PUT', body }) : apiFetch('/system/backup-targets', { method: 'POST', body });
    },
    onSuccess: () => { setDraft(null); void refresh(); showToast('Backup destination saved.', 'success'); },
  });
  const act = async (target: BackupTarget, action: 'test' | 'run') => {
    setBusy(`${action}:${target.id}`);
    try {
      const result = await apiFetch<{ backups?: number; file?: string; removed?: string[] }>(`/system/backup-targets/${target.id}/${action}`, { method: 'POST', timeoutMs: 30 * 60 * 1000 });
      showToast(action === 'test' ? `Reachable. ${result.backups ?? 0} Fleet backups stored there.` : `Uploaded ${result.file}${result.removed?.length ? `, removed ${result.removed.length} older` : ''}.`, 'success');
    } catch (error) { showToast((error as Error).message, 'error'); }
    setBusy(null);
    void refresh();
  };
  const open = (target?: BackupTarget) => {
    setExisting(target || null);
    save.reset();
    setDraft(target ? { ...emptyDraft(), id: target.id, type: target.type, name: target.name, remote_path: target.remote_path, cron_expression: target.cron_expression, keep_count: String(target.keep_count), enabled: target.enabled, settings: { ...target.settings } } : emptyDraft());
  };

  const targets = list.data?.targets || [];
  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2"><CloudUpload className="h-4 w-4" />Scheduled backups</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">Fleet creates the encrypted database backup on a schedule, verifies it and copies it to a share, server or cloud storage. Older Fleet backups there are removed beyond the number you keep.</p>
      </div>
      <Button size="sm" onClick={() => open()}><Plus />Add destination</Button>
    </CardHeader>
    <CardContent className="space-y-2">
      {list.isError ? <p role="alert" className="text-sm text-destructive">{list.error.message}</p>
        : list.isPending ? <p className="text-sm text-muted-foreground">Loading destinations…</p>
        : !targets.length ? <p className="text-sm text-muted-foreground">No destination yet. Add an SMB share, SFTP server, S3 bucket, Google Drive or WebDAV folder.</p>
        : <ul className="divide-y rounded-md border">{targets.map(target => <li key={target.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{target.name}</span>
              <span className="text-xs text-muted-foreground">{list.data?.types[target.type]}</span>
              {!target.enabled && <StatusBadge tone="muted">Paused</StatusBadge>}
              {target.last_status && <StatusBadge tone={statusTone(target.last_status)}>{target.last_status === 'success' ? 'Last backup OK' : target.last_status === 'failed' ? 'Last backup failed' : 'Running…'}</StatusBadge>}
            </div>
            <p className="break-words text-xs text-muted-foreground">
              <code>{target.cron_expression}</code> · keeps {target.keep_count} · {target.last_run_at ? <>last run <Timestamp value={target.last_run_at} /></> : 'never run'}{target.last_file ? ` · ${target.last_file}` : ''}
            </p>
            {target.last_status === 'failed' && target.last_error && <p className="break-words text-xs text-destructive">{target.last_error}</p>}
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act(target, 'test')}><PlugZap />{busy === `test:${target.id}` ? 'Testing…' : 'Test'}</Button>
            <Button size="sm" variant="outline" disabled={Boolean(busy) || target.last_status === 'running'} onClick={() => void act(target, 'run')}><Play />{busy === `run:${target.id}` ? 'Backing up…' : 'Back up now'}</Button>
            <Button size="icon" variant="ghost" aria-label={`Edit ${target.name}`} onClick={() => open(target)}><Pencil /></Button>
            <Button size="icon" variant="ghost" aria-label={`Delete ${target.name}`} onClick={() => setRemove(target)}><Trash2 /></Button>
          </div>
        </li>)}</ul>}
    </CardContent>

    <Dialog open={Boolean(draft)} onOpenChange={value => { if (!value && !save.isPending) setDraft(null); }}>
      {draft && <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>{draft.id ? 'Edit backup destination' : 'Add backup destination'}</DialogTitle></DialogHeader>
        <form id="backup-target-form" className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" onSubmit={event => { event.preventDefault(); save.mutate(draft); }}>
          <fieldset disabled={save.isPending} className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">Name<Input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="NAS backups" /></label>
            <label className="space-y-1 text-sm">Type<select className="flex h-9 w-full rounded-md border bg-background px-3 text-sm" value={draft.type} disabled={Boolean(draft.id)} onChange={e => setDraft({ ...draft, type: e.target.value as TargetType, settings: {}, secrets: {} })}>
              {Object.entries(list.data?.types || {}).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            {FIELDS[draft.type].map(field => {
              const stored = Boolean(existing?.secrets[field.key]);
              const value = field.secret ? draft.secrets[field.key] || '' : draft.settings[field.key] || '';
              const set = (next: string) => setDraft(field.secret ? { ...draft, secrets: { ...draft.secrets, [field.key]: next } } : { ...draft, settings: { ...draft.settings, [field.key]: next } });
              const placeholder = field.secret && stored ? 'Stored · leave empty to keep' : field.placeholder;
              if (field.key === 'provider') return <label key={field.key} className="space-y-1 text-sm">{field.label}<select className="flex h-9 w-full rounded-md border bg-background px-3 text-sm" value={value || 'Other'} onChange={e => set(e.target.value)}>{(list.data?.s3_providers || []).map(provider => <option key={provider}>{provider}</option>)}</select></label>;
              return <label key={field.key} className={`space-y-1 text-sm ${field.multiline ? 'sm:col-span-2' : ''}`}>{field.label}
                {field.multiline ? <Textarea rows={3} className="font-mono text-xs" value={value} placeholder={placeholder} onChange={e => set(e.target.value)} /> : <Input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} value={value} placeholder={placeholder} onChange={e => set(e.target.value)} />}
              </label>;
            })}
            <label className="space-y-1 text-sm sm:col-span-2">{draft.type === 'local' ? 'Folder inside the container' : 'Folder'}<Input value={draft.remote_path} onChange={e => setDraft({ ...draft, remote_path: e.target.value })} placeholder={draft.type === 'local' ? '/backups' : 'fleet'} className="font-mono" /></label>
            {draft.type === 'drive' && <p className="text-xs text-muted-foreground sm:col-span-2">On a computer with a browser run <code>rclone authorize "drive"</code>, sign in, and paste the JSON it prints. Fleet only sees files it created itself.</p>}
            {draft.type === 'local' && <p className="text-xs text-muted-foreground sm:col-span-2">Mount the target on the Docker host (for example NFS) and bind it into the container in docker-compose.yml.</p>}
            <label className="space-y-1 text-sm">Schedule<select className="flex h-9 w-full rounded-md border bg-background px-3 text-sm" value={SCHEDULES.some(([cron]) => cron === draft.cron_expression) ? draft.cron_expression : 'custom'} onChange={e => setDraft({ ...draft, cron_expression: e.target.value === 'custom' ? '' : e.target.value })}>
              {SCHEDULES.map(([cron, label]) => <option key={cron} value={cron}>{label}</option>)}<option value="custom">Custom cron expression</option>
            </select></label>
            <label className="space-y-1 text-sm">Cron expression<Input required value={draft.cron_expression} onChange={e => setDraft({ ...draft, cron_expression: e.target.value })} className="font-mono" /></label>
            <label className="space-y-1 text-sm">Backups to keep<Input type="number" min={1} max={365} required value={draft.keep_count} onChange={e => setDraft({ ...draft, keep_count: e.target.value })} /></label>
            <label className="flex items-center justify-between gap-2 self-end rounded-md border px-3 py-2 text-sm">Enabled<Switch checked={draft.enabled} onCheckedChange={enabled => setDraft({ ...draft, enabled })} /></label>
            <label className="space-y-1 text-sm">Backup passphrase<Input type="password" autoComplete="new-password" minLength={draft.id ? undefined : 12} required={!draft.id} value={draft.passphrase} placeholder={draft.id ? 'Stored · leave empty to keep' : 'At least 12 characters'} onChange={e => setDraft({ ...draft, passphrase: e.target.value })} /></label>
            <label className="space-y-1 text-sm">Repeat passphrase<Input type="password" autoComplete="new-password" required={Boolean(draft.passphrase)} value={draft.repeat} onChange={e => setDraft({ ...draft, repeat: e.target.value })} /></label>
            <div className="rounded-md border border-dashed p-3 sm:col-span-2">
              <p className="mb-2 text-xs text-muted-foreground">The destination receives the whole database including stored credentials. Confirm with your account{draft.id ? ' when changing the destination, credentials or passphrase' : ''}.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">Current account password<Input type="password" autoComplete="current-password" value={draft.password} onChange={e => setDraft({ ...draft, password: e.target.value })} /></label>
                <label className="space-y-1 text-sm">Authenticator code (if enabled)<Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={draft.code} onChange={e => setDraft({ ...draft, code: e.target.value })} /></label>
              </div>
            </div>
          </fieldset>
          {draft.passphrase && draft.repeat && draft.passphrase !== draft.repeat && <p className="text-sm text-destructive">Passphrases do not match.</p>}
          {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
        </form>
        <DialogFooter className="shrink-0 border-t pt-3">
          <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</Button>
          <Button type="submit" form="backup-target-form" disabled={save.isPending || draft.passphrase !== draft.repeat}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
    <ConfirmDialog open={Boolean(remove)} onOpenChange={value => !value && setRemove(null)} title={`Delete "${remove?.name}"?`} description="Scheduled backups to this destination stop. Archives already stored there are kept." confirmLabel="Delete destination" variant="destructive"
      onConfirm={async () => { if (!remove) return; try { await apiFetch(`/system/backup-targets/${remove.id}`, { method: 'DELETE' }); showToast('Destination deleted.', 'success'); } catch (error) { showToast((error as Error).message, 'error'); } setRemove(null); void refresh(); }} />
  </Card>;
}
