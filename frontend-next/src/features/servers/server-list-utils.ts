export interface ServerRow {
  id: string;
  name: string;
  ip_address?: string;
  hostname?: string;
  ssh_user?: string;
  ssh_port?: number;
  status?: 'online' | 'offline' | string;
  group_id?: string | null;
  group_name?: string;
  tags?: string[];
  services?: string[];
  links?: { name: string; url: string }[];
  storage_mounts?: { name: string; path: string }[];
  last_seen?: string;
  [k: string]: unknown;
}

export interface ServerGroup {
  id: string;
  name: string;
  color?: string;
  parent_id?: string | null;
}

export interface GroupNode extends ServerGroup {
  children: GroupNode[];
}

export interface ServerInfo {
  os?: string;
  cpu_usage_pct?: number;
  ram_used_mb?: number;
  ram_total_mb?: number;
  disk_used_gb?: number;
  disk_total_gb?: number;
}

const STORAGE_KEY_COLLAPSED = 'shipyard.ui.servers.collapsedGroups';

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}

export function normalizeServer(s: Record<string, unknown>): ServerRow {
  return {
    ...s,
    id: String(s.id),
    name: String(s.name ?? ''),
    tags: parseArray<string>(s.tags),
    services: parseArray<string>(s.services),
    links: parseArray<{ name: string; url: string }>(s.links),
    storage_mounts: parseArray<{ name: string; path: string }>(s.storage_mounts),
  } as ServerRow;
}

export function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED);
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values.filter((v: unknown) => typeof v === 'string') : []);
  } catch { return new Set(); }
}

export function saveCollapsedGroups(groups: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify([...groups])); } catch { /* unavailable storage */ }
}

export function buildGroupTree(groups: ServerGroup[], parentId: string | null = null, visited = new Set<string>()): GroupNode[] {
  if (parentId !== null && visited.has(parentId)) return [];
  if (parentId !== null) visited.add(parentId);
  return groups.filter(group => (group.parent_id || null) === parentId)
    .map(group => ({ ...group, children: buildGroupTree(groups, group.id, new Set(visited)) }));
}

export function countDescendantServers(node: GroupNode, byGroup: Record<string, ServerRow[]>, visited = new Set<string>()): number {
  if (visited.has(node.id)) return 0;
  visited.add(node.id);
  return node.children.reduce((count, child) => count + (byGroup[child.id] || []).length + countDescendantServers(child, byGroup, visited), 0);
}

export function getDescendantIds(groups: ServerGroup[], id: string): Set<string> {
  const ids = new Set([id]);
  const add = (parentId: string) => groups.filter(group => group.parent_id === parentId).forEach(group => {
    if (!ids.has(group.id)) { ids.add(group.id); add(group.id); }
  });
  add(id);
  return ids;
}

export function formatRelativeTime(dateStr: string, translate: (key: string) => string): string {
  const utc = dateStr && !dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
  const diff = Math.floor((Date.now() - new Date(utc).getTime()) / 1000);
  if (diff < 60) return translate('dash.justNow');
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function parseCsvServers(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(header => header.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const fields: string[] = []; let value = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quoted && char === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { fields.push(value); value = ''; }
      else value += char;
    }
    fields.push(value);
    const server: Record<string, unknown> = {};
    headers.forEach((header, index) => { server[header] = fields[index] ?? ''; });
    server.tags = parseArray<string>(server.tags);
    server.services = parseArray<string>(server.services);
    server.links = parseArray<{ name: string; url: string }>(server.links);
    server.storage_mounts = parseArray<{ name: string; path: string }>(server.storage_mounts);
    server.ssh_port = parseInt(String(server.ssh_port)) || 22;
    return server;
  }).filter(server => server.name && server.ip_address);
}
