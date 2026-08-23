import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Download, File, Folder, FolderUp, RefreshCw, Upload } from 'lucide-react';
import { api, apiDownload, apiFetch, apiUploadFile } from '@/lib/api';
import { hasCap, type Profile } from '@/lib/queries';
import { showToast } from '@/lib/toast';
import { useUi } from '@/lib/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { OverflowItem, OverflowMenu } from '@/components/ui/overflow-menu';

interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified_at: number;
  permissions: number;
}

interface FileListing { path: string; entries: FileEntry[] }
interface ServerOption { id: string; name: string; ip_address?: string }
function joinRemotePath(directory: string, name: string) {
  return directory === '/' ? `/${name}` : `${directory.replace(/\/$/, '')}/${name}`;
}

function parentRemotePath(value: string) {
  if (value === '/') return '/';
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}` || '/';
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function permissionLabel(mode: number) {
  return (mode || 0).toString(8).padStart(3, '0');
}

export function ServerFilesTab({ serverId, profile }: { serverId: string; profile: Profile | null | undefined }) {
  const qc = useQueryClient();
  const environmentId = useUi(state => state.environmentId);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const [path, setPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [upload, setUpload] = useState<{ file: globalThis.File; target: string; overwrite: boolean } | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [transfer, setTransfer] = useState<{ entry: FileEntry; targetServerId: string; targetPath: string; overwrite: boolean } | null>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const canManage = hasCap(profile, 'canManageFiles');

  useEffect(() => () => uploadController.current?.abort(), []);

  const listing = useQuery<FileListing>({
    queryKey: ['server-files', serverId, path],
    queryFn: () => apiFetch(`/servers/${encodeURIComponent(serverId)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  });

  const resolvedPath = listing.data?.path || path || '';
  const entries = useMemo(() => [...(listing.data?.entries || [])].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }), [listing.data?.entries]);

  const servers = useQuery<ServerOption[]>({
    queryKey: ['servers', environmentId],
    queryFn: () => api.getServers(environmentId) as unknown as Promise<ServerOption[]>,
    enabled: canManage,
  });

  const uploadMutation = useMutation({
    mutationFn: async (value: NonNullable<typeof upload>) => {
      setUploadProgress(0);
      const controller = new AbortController();
      uploadController.current = controller;
      const query = new URLSearchParams({ path: value.target, overwrite: String(value.overwrite) });
      return apiUploadFile(`/servers/${encodeURIComponent(serverId)}/files/upload?${query}`, value.file, setUploadProgress, controller.signal);
    },
    onSuccess: () => {
      showToast('File uploaded successfully.', 'success');
      setUpload(null);
      setUploadProgress(0);
      void qc.invalidateQueries({ queryKey: ['server-files', serverId] });
    },
    onError: (error: Error) => {
      if (error.message !== 'Upload canceled') showToast(error.message, 'error');
    },
    onSettled: () => { uploadController.current = null; },
  });

  const transferMutation = useMutation({
    mutationFn: (value: NonNullable<typeof transfer>) => apiFetch(`/servers/${encodeURIComponent(serverId)}/files/transfer`, {
      method: 'POST',
      body: {
        source_path: joinRemotePath(resolvedPath, value.entry.name),
        target_server_id: value.targetServerId,
        target_path: value.targetPath,
        overwrite: value.overwrite,
      },
    }),
    onSuccess: () => {
      showToast('File transferred successfully.', 'success');
      setTransfer(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  function openPath(nextPath: string) {
    setPath(nextPath);
    setPathInput(nextPath);
  }

  function cancelUpload() {
    uploadController.current?.abort();
    setUpload(null);
    setUploadProgress(0);
  }

  async function downloadEntry(entry: FileEntry) {
    const remotePath = joinRemotePath(resolvedPath, entry.name);
    setDownloadingPath(remotePath);
    try {
      const isDirectory = entry.type === 'directory';
      const endpoint = isDirectory ? 'archive' : 'download';
      const filename = isDirectory ? `${entry.name}.tar.gz` : entry.name;
      await apiDownload(`/servers/${encodeURIComponent(serverId)}/files/${endpoint}?path=${encodeURIComponent(remotePath)}`, filename);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Download failed.', 'error');
    } finally {
      setDownloadingPath(null);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">Files</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">Browse and transfer files through this host&apos;s trusted SSH connection.</p>
              </div>
              {canManage && <>
                <input ref={fileInput} className="hidden" type="file" onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) setUpload({ file, target: joinRemotePath(resolvedPath || '/', file.name), overwrite: false });
                }} />
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!resolvedPath}>
                  <Upload className="h-4 w-4" /> Upload
                </Button>
              </>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <form className="flex gap-2" onSubmit={event => { event.preventDefault(); openPath(pathInput || resolvedPath); }}>
              <Button type="button" size="icon" variant="outline" aria-label="Parent directory" disabled={!resolvedPath || resolvedPath === '/'} onClick={() => openPath(parentRemotePath(resolvedPath))}>
                <FolderUp className="h-4 w-4" />
              </Button>
              <Input aria-label="Remote directory" value={pathInput || resolvedPath} onChange={event => setPathInput(event.target.value)} placeholder="/home/user" />
              <Button type="submit" size="sm" variant="outline">Open</Button>
              <Button type="button" size="icon" variant="outline" aria-label="Refresh directory" onClick={() => void listing.refetch()} disabled={listing.isFetching}>
                <RefreshCw className={listing.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          {listing.isError ? (
            <EmptyState icon={<Folder className="h-6 w-6" />} title="Directory unavailable" description={(listing.error as Error).message} compact action={<Button size="sm" variant="outline" onClick={() => void listing.refetch()}>Try again</Button>} />
          ) : listing.isLoading ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading files…</div>
          ) : entries.length === 0 ? (
            <EmptyState icon={<Folder className="h-6 w-6" />} title="This directory is empty" compact />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><th className="px-4 py-2.5 font-medium">Name</th><th className="px-4 py-2.5 font-medium">Size</th><th className="px-4 py-2.5 font-medium">Modified</th><th className="px-4 py-2.5 font-medium">Mode</th><th className="px-4 py-2.5 text-right font-medium">Actions</th></tr></thead>
                <tbody>{entries.map(entry => {
                  const fullPath = joinRemotePath(resolvedPath, entry.name);
                  return <tr key={`${entry.type}:${entry.name}`} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="max-w-[28rem] px-4 py-2.5"><button type="button" disabled={entry.type !== 'directory'} onClick={() => openPath(fullPath)} className="flex max-w-full items-center gap-2 text-left disabled:cursor-default"><span className="text-muted-foreground">{entry.type === 'directory' ? <Folder className="h-4 w-4" /> : <File className="h-4 w-4" />}</span><span className={entry.type === 'directory' ? 'truncate font-medium hover:underline' : 'truncate'}>{entry.name}</span>{entry.type === 'symlink' && <Badge variant="outline">link</Badge>}</button></td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">{entry.type === 'directory' ? '—' : formatSize(entry.size)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{entry.modified_at ? new Date(entry.modified_at * 1000).toLocaleString() : '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{permissionLabel(entry.permissions)}</td>
                    <td className="px-4 py-2"><div className="flex justify-end">{entry.type !== 'symlink' ? <OverflowMenu title={`Actions for ${entry.name}`}><OverflowItem icon={Download} disabled={downloadingPath !== null} onClick={() => void downloadEntry(entry)}>{entry.type === 'directory' ? 'Download as .tar.gz' : 'Download file'}</OverflowItem>{canManage && entry.type === 'file' && <OverflowItem icon={ArrowRightLeft} onClick={() => setTransfer({ entry, targetServerId: '', targetPath: entry.name, overwrite: false })}>Transfer file</OverflowItem>}</OverflowMenu> : <span className="text-muted-foreground">—</span>}</div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Dialog open={!!upload} onOpenChange={open => { if (!open) cancelUpload(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Upload file</DialogTitle></DialogHeader>
          {upload && <div className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3 text-sm"><div className="font-medium">{upload.file.name}</div><div className="mt-1 text-xs text-muted-foreground">{formatSize(upload.file.size)}</div></div>
            <div className="space-y-1.5"><Label htmlFor="upload-target">Destination path</Label><Input id="upload-target" value={upload.target} onChange={event => setUpload({ ...upload, target: event.target.value })} /></div>
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"><span><span className="block font-medium">Replace existing file</span><span className="text-xs text-muted-foreground">Disabled by default to prevent accidental overwrites.</span></span><Switch checked={upload.overwrite} onCheckedChange={checked => setUpload({ ...upload, overwrite: checked })} /></label>
            {uploadMutation.isPending && <div className="space-y-1"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${uploadProgress}%` }} /></div><div className="text-right font-mono text-xs text-muted-foreground">{uploadProgress}%</div></div>}
          </div>}
          <DialogFooter><Button variant="outline" onClick={cancelUpload}>{uploadMutation.isPending ? 'Cancel upload' : 'Cancel'}</Button><Button onClick={() => upload && uploadMutation.mutate(upload)} disabled={!upload?.target || uploadMutation.isPending}>{uploadMutation.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!transfer} onOpenChange={open => { if (!open && !transferMutation.isPending) setTransfer(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transfer to another host</DialogTitle></DialogHeader>
          {transfer && <div className="space-y-4">
            <div className="rounded-md border bg-muted/20 p-3 text-sm"><span className="font-medium">{transfer.entry.name}</span><span className="ml-2 text-xs text-muted-foreground">{formatSize(transfer.entry.size)}</span></div>
            <div className="space-y-1.5"><Label htmlFor="transfer-host">Destination host</Label><select id="transfer-host" value={transfer.targetServerId} onChange={event => {
              const targetServerId = event.target.value;
              const selected = (servers.data || []).find(server => server.id === targetServerId);
              const defaultHome = selected ? (selected.name ? `/tmp/${transfer.entry.name}` : transfer.targetPath) : transfer.targetPath;
              setTransfer({ ...transfer, targetServerId, targetPath: transfer.targetPath.startsWith('/') ? transfer.targetPath : defaultHome });
            }} className="h-8 w-full rounded-sm border bg-background px-2.5 text-[13px]"><option value="">Select a host…</option>{(servers.data || []).filter(server => server.id !== serverId).map(server => <option key={server.id} value={server.id}>{server.name}{server.ip_address ? ` — ${server.ip_address}` : ''}</option>)}</select></div>
            <div className="space-y-1.5"><Label htmlFor="transfer-target">Absolute destination path</Label><Input id="transfer-target" value={transfer.targetPath} onChange={event => setTransfer({ ...transfer, targetPath: event.target.value })} placeholder="/tmp/file.tar.gz" /></div>
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"><span><span className="block font-medium">Replace existing file</span><span className="text-xs text-muted-foreground">Disabled by default to prevent accidental overwrites.</span></span><Switch checked={transfer.overwrite} onCheckedChange={checked => setTransfer({ ...transfer, overwrite: checked })} /></label>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setTransfer(null)} disabled={transferMutation.isPending}>Cancel</Button><Button onClick={() => transfer && transferMutation.mutate(transfer)} disabled={!transfer?.targetServerId || !transfer?.targetPath.startsWith('/') || transferMutation.isPending}>{transferMutation.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Transfer</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
