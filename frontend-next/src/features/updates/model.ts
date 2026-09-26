import type { StatusTone } from '@/components/ui/status-badge';

export interface UpdateItem {
  package?: string;
  current_version?: string;
  version?: string;
  phased?: boolean;
  container_name?: string;
  image?: string;
  status?: string;
}
export interface Catalog {
  updates: UpdateItem[];
  checked_at: string | null;
  stale: boolean;
  failure?: { reason: string; attempted_at: string } | null;
}
export interface UpdateHost {
  id: string;
  name: string;
  ip_address?: string;
  status: string;
  reboot_required: boolean;
  system: Catalog;
  docker?: Catalog | null;
  /** Apps tracked by custom update checks. */
  custom?: CustomApp[] | null;
}
export interface CustomApp {
  id: string;
  name: string;
  current_version: string | null;
  version: string | null;
  has_update: boolean;
  checked_at: string | null;
  stale: boolean;
  failed: boolean;
}
export function pendingApps(host: UpdateHost) {
  return (host.custom || []).filter(app => app.has_update);
}
export function appsStatus(apps: CustomApp[]): { label: string; tone: StatusTone; needsCheck: boolean } {
  if (apps.some(app => app.failed)) return { label: 'Check failed', tone: 'danger', needsCheck: true };
  if (apps.some(app => !app.checked_at)) return { label: 'Not checked', tone: 'muted', needsCheck: true };
  if (apps.some(app => app.stale)) return { label: 'Check again', tone: 'muted', needsCheck: true };
  const count = apps.filter(app => app.has_update).length;
  return { label: count ? `${count} available` : 'Up to date', tone: count ? 'warning' : 'success', needsCheck: false };
}
export function pendingUpdates(catalog: Catalog, kind: 'system' | 'docker') {
  return catalog.updates.filter(item => kind === 'system' ? !item.phased : item.status === 'update_available');
}
export function catalogStatus(catalog: Catalog, kind: 'system' | 'docker'): { label: string; tone: StatusTone; needsCheck: boolean } {
  if (catalog.failure) return { label: 'Check failed', tone: 'danger', needsCheck: true };
  if (!catalog.checked_at) return { label: 'Not checked', tone: 'muted', needsCheck: true };
  if (catalog.stale) return { label: 'Check again', tone: 'muted', needsCheck: true };
  if (kind === 'docker' && catalog.updates.some(item => !['update_available', 'up_to_date', 'updated', 'ignored'].includes(item.status || ''))) {
    return { label: 'Check required', tone: 'muted', needsCheck: true };
  }
  const count = pendingUpdates(catalog, kind).length;
  return { label: count ? `${count} available` : 'Up to date', tone: count ? 'warning' : 'success', needsCheck: false };
}

export interface PackageRow {
  key: string;
  kind: 'system' | 'docker' | 'app';
  name: string;
  versions: string[];
  hosts: { id: string; name: string; detail: string }[];
}

/** Groups pending updates by package or image so one question ("where is openssl outdated?") has one row. */
export function packageIndex(hosts: UpdateHost[], includeDocker: boolean): PackageRow[] {
  const rows = new Map<string, PackageRow>();
  const add = (kind: PackageRow['kind'], name: string, host: UpdateHost, detail: string, version?: string) => {
    const key = `${kind}:${name}`;
    const row = rows.get(key) || { key, kind, name, versions: [], hosts: [] };
    if (version && !row.versions.includes(version)) row.versions.push(version);
    if (!row.hosts.some(item => item.id === host.id && item.detail === detail)) row.hosts.push({ id: host.id, name: host.name, detail });
    rows.set(key, row);
  };
  for (const host of hosts) {
    for (const item of pendingUpdates(host.system, 'system')) {
      if (item.package) add('system', item.package, host, item.current_version ? `${item.current_version} → ${item.version || 'newer'}` : item.version || '', item.version);
    }
    if (includeDocker && host.docker) {
      for (const item of pendingUpdates(host.docker, 'docker')) {
        const image = item.image || item.container_name;
        if (image) add('docker', image, host, item.container_name || '');
      }
    }
    for (const app of pendingApps(host)) add('app', app.name, host, `${app.current_version || 'installed'} → ${app.version || 'newer'}`, app.version || undefined);
  }
  return [...rows.values()].sort((a, b) => b.hosts.length - a.hosts.length || a.name.localeCompare(b.name));
}

/** A host needs action when updates wait or its latest check cannot be trusted. */
export function needsAction(host: UpdateHost, includeDocker: boolean) {
  const catalogs = [host.system, ...(includeDocker && host.docker ? [host.docker] : [])];
  if (host.custom?.length && (appsStatus(host.custom).needsCheck || pendingApps(host).length > 0)) return true;
  return host.reboot_required || catalogs.some((catalog, index) => {
    const status = catalogStatus(catalog, index === 0 ? 'system' : 'docker');
    return status.needsCheck || pendingUpdates(catalog, index === 0 ? 'system' : 'docker').length > 0;
  });
}
