import { getToken, notifyUnauthorized } from './auth';

const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip Authorization header (used for /auth/login, /auth/setup, /auth/status). */
  skipAuth?: boolean;
}

export async function apiFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.headers) Object.assign(headers, options.headers as Record<string, string>);

  if (!options.skipAuth) {
    const tok = getToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
  }

  const init: RequestInit = { ...options, headers } as RequestInit;
  delete (init as { skipAuth?: boolean }).skipAuth;

  if (options.body !== undefined && options.body !== null && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    init.body = JSON.stringify(options.body);
  } else if (options.body !== undefined) {
    init.body = options.body as BodyInit;
  }

  const res = await fetch(url, init);

  if (res.status === 401 && !options.skipAuth) {
    notifyUnauthorized();
    throw new ApiError('Not signed in', 401);
  }

  if (!res.ok) {
    let msg = `Request failed: ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new ApiError(msg, res.status);
  }

  if (res.status === 204) return null as T;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/** Download helper for binary endpoints (e.g. server export). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const tok = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
  });
  if (!res.ok) throw new ApiError(`Download failed: ${res.status}`, res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─────────────────────────── Typed API surface ──────────────────────────────
// Matches the legacy ApiClient in frontend/src/api.js. Field names preserve
// snake_case at the API boundary (per AGENTS.md). Return types are deliberately
// loose (`unknown`/`any`) for now to avoid blocking parity work; tighten per view.

type AnyObj = Record<string, unknown>;

export const api = {
  // Auth
  authStatus:        () => apiFetch<{ configured: boolean; appName?: string; appTagline?: string; accentColor?: string; showIcon?: boolean; logoIcon?: string; logoImage?: string }>('/auth/status', { skipAuth: true }),
  authSetup:         (username: string, password: string) =>
    apiFetch<{ token: string }>('/auth/setup', { method: 'POST', body: { username, password }, skipAuth: true }),
  authLogin:         (username: string, password: string) =>
    apiFetch<{ token?: string; tempToken?: string; requires2FA?: boolean; user?: AnyObj }>('/auth/login', { method: 'POST', body: { username, password }, skipAuth: true }),
  authChangePassword:(currentPassword: string, newPassword: string) =>
    apiFetch('/auth/change', { method: 'POST', body: { currentPassword, newPassword } }),
  totpStatus:        () => apiFetch<{ enabled: boolean }>('/auth/totp/status'),
  totpSetup:         () => apiFetch<{ otpauthUrl: string; secret: string }>('/auth/totp/setup', { method: 'POST' }),
  totpConfirm:       (code: string) => apiFetch('/auth/totp/confirm', { method: 'POST', body: { code } }),
  totpDisable:       (password: string) => apiFetch('/auth/totp', { method: 'DELETE', body: { password } }),
  totpLogin:         (tempToken: string, code: string) =>
    apiFetch<{ token: string }>('/auth/totp/login', { method: 'POST', body: { tempToken, code }, skipAuth: true }),
  getProfile:        () => apiFetch<AnyObj>('/auth/profile'),
  updateProfile:     (data: AnyObj) => apiFetch('/auth/profile', { method: 'PUT', body: data }),

  // Dashboard
  getDashboard:      () => apiFetch<AnyObj>('/dashboard'),
  ping:              () => apiFetch<{ ok: boolean; ts: number }>('/ping'),

  // Servers
  getServers:        () => apiFetch<AnyObj[]>('/servers'),
  getServer:         (id: string | number) => apiFetch<AnyObj>(`/servers/${id}`),
  createServer:      (data: AnyObj) => apiFetch<AnyObj>('/servers', { method: 'POST', body: data }),
  updateServer:      (id: string | number, data: AnyObj) => apiFetch(`/servers/${id}`, { method: 'PUT', body: data }),
  deleteServer:      (id: string | number) => apiFetch(`/servers/${id}`, { method: 'DELETE' }),
  testConnection:    (id: string | number) => apiFetch(`/servers/${id}/test`, { method: 'POST' }),
  resetServerHostKey:(id: string | number) => apiFetch(`/servers/${id}/reset-host-key`, { method: 'POST' }),
  autoGroupByTags:   () => apiFetch('/servers/auto-group-by-tags', { method: 'POST' }),
  setServerGroup:    (serverId: string | number, groupId: string | number | null) =>
    apiFetch(`/servers/${serverId}/group`, { method: 'PUT', body: { group_id: groupId } }),

  // Server groups
  getServerGroups:   () => apiFetch<AnyObj[]>('/servers/groups'),
  createServerGroup: (name: string, color?: string, parentId?: string | number | null) =>
    apiFetch('/servers/groups', { method: 'POST', body: { name, color, parent_id: parentId ?? null } }),
  updateServerGroup: (id: string | number, name: string, color?: string) =>
    apiFetch(`/servers/groups/${id}`, { method: 'PUT', body: { name, color } }),
  deleteServerGroup: (id: string | number) => apiFetch(`/servers/groups/${id}`, { method: 'DELETE' }),
  setGroupParent:    (groupId: string | number, parentId: string | number | null) =>
    apiFetch(`/servers/groups/${groupId}/parent`, { method: 'PUT', body: { parent_id: parentId ?? null } }),

  exportServers:     (format: 'json' | 'csv') => apiDownload(`/servers/export?format=${format}`, `servers.${format}`),
  importServers:     (servers: AnyObj[]) => apiFetch('/servers/import', { method: 'POST', body: { servers } }),

  // Server data
  getServerInfo:     (id: string | number, force = false) => apiFetch<AnyObj>(`/servers/${id}/info${force ? '?force=1' : ''}`),
  getServerServices: (id: string | number) => apiFetch<AnyObj>(`/servers/${id}/services`),
  getServerUpdates:  (id: string | number, force = false) => apiFetch<AnyObj>(`/servers/${id}/updates${force ? '?force=1' : ''}`),
  getServerHistory:  (id: string | number) => apiFetch<AnyObj[]>(`/servers/${id}/history`),
  getServerNotes:    (id: string | number) => apiFetch<{ notes: string }>(`/servers/${id}/notes`),
  saveServerNotes:   (id: string | number, notes: string) => apiFetch(`/servers/${id}/notes`, { method: 'PUT', body: { notes } }),
  getServerDocker:   (id: string | number, force = false) => apiFetch<AnyObj>(`/servers/${id}/docker${force ? '?force=1' : ''}`),
  restartContainer:  (id: string | number, container: string) => apiFetch(`/servers/${id}/docker/${container}/restart`, { method: 'POST' }),
  getContainerLogs:  (id: string | number, container: string, tail = 200) =>
    apiFetch<{ logs: string }>(`/servers/${id}/docker/${encodeURIComponent(container)}/logs?tail=${tail}`),
  checkImageUpdates: (id: string | number) => apiFetch(`/servers/${id}/docker/image-updates`),
  getCachedImageUpdates: (id: string | number) => apiFetch(`/servers/${id}/docker/image-updates/cached`),

  // Custom updates
  getCustomUpdateTasks:   (serverId: string | number) => apiFetch<AnyObj[]>(`/servers/${serverId}/custom-updates`),
  createCustomUpdateTask: (serverId: string | number, data: AnyObj) => apiFetch(`/servers/${serverId}/custom-updates`, { method: 'POST', body: data }),
  updateCustomUpdateTask: (serverId: string | number, taskId: string | number, data: AnyObj) =>
    apiFetch(`/servers/${serverId}/custom-updates/${taskId}`, { method: 'PUT', body: data }),
  deleteCustomUpdateTask: (serverId: string | number, taskId: string | number) =>
    apiFetch(`/servers/${serverId}/custom-updates/${taskId}`, { method: 'DELETE' }),
  runCustomUpdateTask:    (serverId: string | number, taskId: string | number) =>
    apiFetch(`/servers/${serverId}/custom-updates/${taskId}/run`, { method: 'POST' }),
  checkCustomUpdateTask:  (serverId: string | number, taskId: string | number) =>
    apiFetch(`/servers/${serverId}/custom-updates/${taskId}/check`, { method: 'POST' }),

  // Compose
  getDockerCompose:  (id: string | number, p: string) => apiFetch<{ content: string }>(`/servers/${id}/docker/compose?path=${encodeURIComponent(p)}`),
  writeDockerCompose:(id: string | number, p: string, content: string) =>
    apiFetch(`/servers/${id}/docker/compose/write`, { method: 'POST', body: { path: p, content } }),
  composeAction:     (id: string | number, p: string, action: string) =>
    apiFetch(`/servers/${id}/docker/compose/action`, { method: 'POST', body: { path: p, action } }),
  deleteComposeStack:(id: string | number, p: string) =>
    apiFetch(`/servers/${id}/docker/compose/stack?path=${encodeURIComponent(p)}`, { method: 'DELETE' }),

  // SSH / System
  getSSHKey:         () => apiFetch<{ publicKey: string }>('/system/key'),
  exportSSHKey:      (passphrase = '') => apiFetch<{ privateKey: string }>('/system/key/export', { method: 'POST', body: { passphrase } }),
  importSSHKey:      (privateKey: string, passphrase = '') => apiFetch('/system/key/import', { method: 'POST', body: { privateKey, passphrase } }),
  generateSSHKey:    (name?: string) => apiFetch('/system/generate', { method: 'POST', body: { name } }),
  deploySSHKey:      (data: AnyObj) => apiFetch('/system/deploy', { method: 'POST', body: data }),
  deploySSHKeyAll:   (data: AnyObj) => apiFetch('/system/deploy-all', { method: 'POST', body: data }),

  // App Settings
  getSettings:       () => apiFetch<AnyObj>('/system/settings'),
  saveSettings:      (data: AnyObj) => apiFetch('/system/settings', { method: 'PUT', body: data }),
  getAnsibleStatus:  () => apiFetch<AnyObj>('/system/status'),
  getAuditLog:       (params: Record<string, string | number | undefined> = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return apiFetch<AnyObj>(`/system/audit?${q}`);
  },
  getAuditMeta:      () => apiFetch<AnyObj>('/system/audit/meta'),
  getPollingConfig:  () => apiFetch<AnyObj>('/system/polling-config'),
  savePollingConfig: (data: AnyObj) => apiFetch('/system/polling-config', { method: 'PUT', body: data }),
  testWebhook:       () => apiFetch('/system/webhook-test', { method: 'POST' }),
  testSmtp:          () => apiFetch('/system/smtp-test',    { method: 'POST' }),
  markOnboardingDone:() => apiFetch('/system/onboarding-complete', { method: 'POST' }),

  // Playbooks
  getPlaybooks:      () => apiFetch<AnyObj[]>('/playbooks'),
  getPlaybook:       (filename: string) => apiFetch<{ content: string }>(`/playbooks/${encodeURIComponent(filename)}`),
  savePlaybook:      (filename: string, content: string) => apiFetch('/playbooks', { method: 'POST', body: { filename, content } }),
  deletePlaybook:    (filename: string) => apiFetch(`/playbooks/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
  getPlaybookHistory:(filename: string) => apiFetch<AnyObj[]>(`/playbooks/${encodeURIComponent(filename)}/history`),
  getPlaybookVersion:(filename: string, version: string | number) => apiFetch(`/playbooks/${encodeURIComponent(filename)}/history/${version}`),
  restorePlaybook:   (filename: string, version: string | number) => apiFetch(`/playbooks/${encodeURIComponent(filename)}/restore/${version}`, { method: 'POST' }),

  // Ansible / actions
  runUpdate:         (serverId: string | number) => apiFetch(`/servers/${serverId}/update`, { method: 'POST' }),
  runUpdateAll:      () => apiFetch('/servers/update-all', { method: 'POST' }),
  runReboot:         (serverId: string | number) => apiFetch(`/servers/${serverId}/reboot`, { method: 'POST' }),
  runPlaybook:       (playbook: string, targets: unknown, extraVars?: AnyObj) =>
    apiFetch('/ansible/run', { method: 'POST', body: { playbook, targets, extraVars } }),
  runAdhoc:          (targets: unknown, module: string, args: string) =>
    apiFetch('/adhoc/run', { method: 'POST', body: { targets, module, args } }),

  // Schedules
  getSchedules:      () => apiFetch<AnyObj[]>('/schedules'),
  createSchedule:    (data: AnyObj) => apiFetch('/schedules', { method: 'POST', body: data }),
  updateSchedule:    (id: string | number, data: AnyObj) => apiFetch(`/schedules/${id}`, { method: 'PUT', body: data }),
  deleteSchedule:    (id: string | number) => apiFetch(`/schedules/${id}`, { method: 'DELETE' }),
  toggleSchedule:    (id: string | number) => apiFetch(`/schedules/${id}/toggle`, { method: 'POST' }),
  getScheduleHistory:(limit = 100, scheduleId: string | number | null = null) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (scheduleId) q.set('scheduleId', String(scheduleId));
    return apiFetch<AnyObj[]>(`/schedule-history?${q}`);
  },
  getScheduleHistoryEntry: (id: string | number) => apiFetch<AnyObj>(`/schedule-history/${id}`),

  // Ansible vars
  getAnsibleVars:    () => apiFetch<AnyObj[]>('/ansible-vars'),
  createAnsibleVar:  (data: AnyObj) => apiFetch('/ansible-vars', { method: 'POST', body: data }),
  updateAnsibleVar:  (id: string | number, data: AnyObj) => apiFetch(`/ansible-vars/${id}`, { method: 'PUT', body: data }),
  deleteAnsibleVar:  (id: string | number) => apiFetch(`/ansible-vars/${id}`, { method: 'DELETE' }),

  // Git
  getGitConfig:      () => apiFetch<AnyObj>('/playbooks-git/config'),
  saveGitConfig:     (data: AnyObj) => apiFetch('/playbooks-git/config', { method: 'PUT', body: data }),
  saveGitSettings:   (data: AnyObj) => apiFetch('/playbooks-git/settings', { method: 'POST', body: data }),
  gitDisconnect:     () => apiFetch('/playbooks-git/disconnect', { method: 'POST' }),
  gitSetup:          (data: AnyObj) => apiFetch('/playbooks-git/setup', { method: 'POST', body: data }),
  getGitStatus:      () => apiFetch<AnyObj>('/playbooks-git/status'),
  getGitLog:         (page?: number, limit?: number) =>
    apiFetch<AnyObj>(`/playbooks-git/log${page || limit ? `?page=${page || 1}&limit=${limit || 10}` : ''}`),
  getGitBranches:    () => apiFetch<AnyObj>('/playbooks-git/branches'),
  gitCheckout:       (branch: string) => apiFetch('/playbooks-git/checkout', { method: 'POST', body: { branch } }),
  gitCommit:         (message: string) => apiFetch('/playbooks-git/commit', { method: 'POST', body: { message } }),
  gitPull:           () => apiFetch('/playbooks-git/pull', { method: 'POST' }),
  gitPush:           () => apiFetch('/playbooks-git/push', { method: 'POST' }),

  // Plugins
  getPlugins:        () => apiFetch<AnyObj[]>('/plugins'),
  enablePlugin:      (id: string) => apiFetch(`/plugins/${id}/enable`, { method: 'POST' }),
  disablePlugin:     (id: string) => apiFetch(`/plugins/${id}/disable`, { method: 'POST' }),
  reloadPlugins:     () => apiFetch('/plugins/reload', { method: 'POST' }),

  // Agent (v1)
  getAgentStatus:    (serverId: string | number) => apiFetch<AnyObj>(`/v1/servers/${serverId}/agent/status`),
  installAgent:      (serverId: string | number, data: AnyObj) => apiFetch(`/v1/servers/${serverId}/agent/install`, { method: 'POST', body: data }),
  updateAgent:       (serverId: string | number) => apiFetch(`/v1/servers/${serverId}/agent/update`, { method: 'POST' }),
  configureAgent:    (serverId: string | number, data: AnyObj) => apiFetch(`/v1/servers/${serverId}/agent/config`, { method: 'PUT', body: data }),
  rotateAgentToken:  (serverId: string | number, data: AnyObj = {}) =>
    apiFetch(`/v1/servers/${serverId}/agent/token-rotate`, { method: 'POST', body: data }),
  removeAgent:       (serverId: string | number) => apiFetch(`/v1/servers/${serverId}/agent`, { method: 'DELETE' }),
  getAgentManifest:  () => apiFetch<{ content: string }>('/v1/agent-manifest'),
  getAgentManifestHistory: (limit = 50) => apiFetch<AnyObj[]>(`/v1/agent-manifest/history?limit=${limit}`),
  saveAgentManifest: (content: string, changelog = '') =>
    apiFetch('/v1/agent-manifest', { method: 'PUT', body: { content, changelog } }),

  // Reset / danger
  resetServers:      () => apiFetch('/reset/servers',   { method: 'DELETE' }),
  resetSchedules:    () => apiFetch('/reset/schedules', { method: 'DELETE' }),
  resetPlaybooks:    () => apiFetch('/reset/playbooks', { method: 'DELETE' }),
  resetAuth:         () => apiFetch('/reset/auth',      { method: 'DELETE' }),
  resetAll:          () => apiFetch('/reset/all',       { method: 'DELETE' }),

  // Users / Roles
  getUsers:          () => apiFetch<AnyObj[]>('/users'),
  createUser:        (data: AnyObj) => apiFetch('/users', { method: 'POST', body: data }),
  updateUser:        (id: string | number, data: AnyObj) => apiFetch(`/users/${id}`, { method: 'PUT', body: data }),
  resetUserPassword: (id: string | number, password: string) => apiFetch(`/users/${id}/password`, { method: 'PUT', body: { password } }),
  disableUserTotp:   (id: string | number) => apiFetch(`/users/${id}/totp-disable`, { method: 'PUT', body: {} }),
  deleteUser:        (id: string | number) => apiFetch(`/users/${id}`, { method: 'DELETE' }),

  getRoles:          () => apiFetch<AnyObj[]>('/roles'),
  createRole:        (data: AnyObj) => apiFetch('/roles', { method: 'POST', body: data }),
  updateRole:        (id: string | number, data: AnyObj) => apiFetch(`/roles/${id}`, { method: 'PUT', body: data }),
  deleteRole:        (id: string | number) => apiFetch(`/roles/${id}`, { method: 'DELETE' }),
};

export type Api = typeof api;
