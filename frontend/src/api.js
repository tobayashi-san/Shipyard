import { t } from './i18n.js';
import { showToast } from './components/toast.js';

const API_BASE = '/api';

class ApiClient {
  constructor() {
    this._token = localStorage.getItem('shipyard_token');
    this._onUnauthorized = null;
  }

  setToken(token) {
    this._token = token;
    if (token) localStorage.setItem('shipyard_token', token);
    else localStorage.removeItem('shipyard_token');
  }

  getToken() { return this._token; }

  onUnauthorized(callback) { this._onUnauthorized = callback; }

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    const config = { ...options, headers: { ...options.headers, ...headers } };
    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    const response = await fetch(url, config);

    if (response.status === 401) {
      this.setToken(null);
      showToast(t('api.sessionExpired'), 'warning');
      if (this._onUnauthorized) this._onUnauthorized();
      throw new Error(t('api.notSignedIn'));
    }

    if (!response.ok) {
      let errMsg = `Request failed: ${response.status}`;
      try {
        const err = await response.json();
        errMsg = err.error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  // Auth (no token needed – plain fetch)
  getAuthStatus() {
    return fetch('/api/auth/status').then(async (r) => {
      if (!r.ok) throw new Error(`Auth status failed: ${r.status}`);
      return r.json();
    });
  }
  authSetup(username, password) {
    return fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  }
  authLogin(username, password) {
    return fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  }
  authChangePassword(currentPassword, newPassword) {
    return this.request('/auth/change', { method: 'POST', body: { currentPassword, newPassword } });
  }
  totpStatus()              { return this.request('/auth/totp/status'); }
  totpSetup()               { return this.request('/auth/totp/setup',   { method: 'POST' }); }
  totpConfirm(code)         { return this.request('/auth/totp/confirm', { method: 'POST', body: { code } }); }
  totpDisable(password)     { return this.request('/auth/totp',         { method: 'DELETE', body: { password } }); }
  getProfile()              { return this.request('/auth/profile'); }
  updateProfile(data)       { return this.request('/auth/profile', { method: 'PUT', body: data }); }
  totpLogin(tempToken, code) {
    return fetch('/api/auth/totp/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken, code }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  }

  // Servers
  getDashboard() { return this.request('/dashboard'); }
  getServers() { return this.request('/servers'); }
  getServer(id) { return this.request(`/servers/${id}`); }
  createServer(data) { return this.request('/servers', { method: 'POST', body: data }); }
  updateServer(id, data) { return this.request(`/servers/${id}`, { method: 'PUT', body: data }); }
  deleteServer(id) { return this.request(`/servers/${id}`, { method: 'DELETE' }); }
  testConnection(id) { return this.request(`/servers/${id}/test`, { method: 'POST' }); }
  setServerGroup(serverId, groupId) { return this.request(`/servers/${serverId}/group`, { method: 'PUT', body: { group_id: groupId } }); }
  getServerGroups() { return this.request('/servers/groups'); }
  createServerGroup(name, color, parentId) { return this.request('/servers/groups', { method: 'POST', body: { name, color, parent_id: parentId || null } }); }
  updateServerGroup(id, name, color) { return this.request(`/servers/groups/${id}`, { method: 'PUT', body: { name, color } }); }
  deleteServerGroup(id) { return this.request(`/servers/groups/${id}`, { method: 'DELETE' }); }
  setGroupParent(groupId, parentId) { return this.request(`/servers/groups/${groupId}/parent`, { method: 'PUT', body: { parent_id: parentId || null } }); }

  async exportServers(format) {
    const res = await fetch(`${API_BASE}/servers/export?format=${format}`, {
      headers: this._token ? { Authorization: `Bearer ${this._token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `servers.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  importServers(servers) { return this.request('/servers/import', { method: 'POST', body: { servers } }); }

  // Ping – accurately measures browser-to-server round trip via a minimal endpoint
  ping() { return this.request('/ping'); }

  // System Info
  getServerInfo(id, force = false) { return this.request(`/servers/${id}/info${force ? '?force=1' : ''}`); }
  getServerServices(id) { return this.request(`/servers/${id}/services`); }
  getServerUpdates(id, force = false) { return this.request(`/servers/${id}/updates${force ? '?force=1' : ''}`); }
  getServerHistory(id) { return this.request(`/servers/${id}/history`); }
  getServerNotes(id) { return this.request(`/servers/${id}/notes`); }
  saveServerNotes(id, notes) { return this.request(`/servers/${id}/notes`, { method: 'PUT', body: { notes } }); }
  getServerDocker(id, force = false) { return this.request(`/servers/${id}/docker${force ? '?force=1' : ''}`); }
  restartServerDocker(id, container) { return this.request(`/servers/${id}/docker/${container}/restart`, { method: 'POST' }); }
  getContainerLogs(id, container, tail = 200) { return this.request(`/servers/${id}/docker/${encodeURIComponent(container)}/logs?tail=${tail}`); }
  checkImageUpdates(id) { return this.request(`/servers/${id}/docker/image-updates`); }

  // Custom Update Tasks
  getCustomUpdateTasks(serverId) { return this.request(`/servers/${serverId}/custom-updates`); }
  createCustomUpdateTask(serverId, data) { return this.request(`/servers/${serverId}/custom-updates`, { method: 'POST', body: data }); }
  updateCustomUpdateTask(serverId, taskId, data) { return this.request(`/servers/${serverId}/custom-updates/${taskId}`, { method: 'PUT', body: data }); }
  deleteCustomUpdateTask(serverId, taskId) { return this.request(`/servers/${serverId}/custom-updates/${taskId}`, { method: 'DELETE' }); }
  runCustomUpdateTask(serverId, taskId) { return this.request(`/servers/${serverId}/custom-updates/${taskId}/run`, { method: 'POST' }); }
  checkCustomUpdateTask(serverId, taskId) { return this.request(`/servers/${serverId}/custom-updates/${taskId}/check`, { method: 'POST' }); }

  // Compose
  getDockerCompose(id, path) { return this.request(`/servers/${id}/docker/compose?path=${encodeURIComponent(path)}`); }
  writeDockerCompose(id, path, content) { return this.request(`/servers/${id}/docker/compose/write`, { method: 'POST', body: { path, content } }); }
  runDockerComposeAction(id, path, action) { return this.request(`/servers/${id}/docker/compose/action`, { method: 'POST', body: { path, action } }); }

  // SSH
  getSSHKey() { return this.request('/system/key'); }
  exportSSHKey(passphrase = '') { return this.request('/system/key/export', { method: 'POST', body: { passphrase } }); }
  importSSHKey(privateKey, passphrase = '') { return this.request('/system/key/import', { method: 'POST', body: { privateKey, passphrase } }); }
  generateSSHKey(name) { return this.request('/system/generate', { method: 'POST', body: { name } }); }
  deploySSHKey(data) { return this.request('/system/deploy', { method: 'POST', body: data }); }
  deploySSHKeyAll(data) { return this.request('/system/deploy-all', { method: 'POST', body: data }); }

  // App Settings
  getSettings() { return this.request('/system/settings'); }
  saveSettings(data) { return this.request('/system/settings', { method: 'PUT', body: data }); }

  // Ansible / Playbooks
  getAnsibleStatus() { return this.request('/system/status'); }
  getAuditLog(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '') q.set(k, v); }
    return this.request(`/system/audit?${q}`);
  }
  getAuditMeta() { return this.request('/system/audit/meta'); }
  getPollingConfig() { return this.request('/system/polling-config'); }
  savePollingConfig(data) { return this.request('/system/polling-config', { method: 'PUT', body: data }); }
  getPlaybooks() { return this.request('/playbooks'); }
  getPlaybook(filename) { return this.request(`/playbooks/${encodeURIComponent(filename)}`); }
  savePlaybook(filename, content) { return this.request('/playbooks', { method: 'POST', body: { filename, content } }); }
  deletePlaybook(filename) { return this.request(`/playbooks/${encodeURIComponent(filename)}`, { method: 'DELETE' }); }
  getPlaybookHistory(filename) { return this.request(`/playbooks/${encodeURIComponent(filename)}/history`); }
  getPlaybookVersion(filename, version) { return this.request(`/playbooks/${encodeURIComponent(filename)}/history/${version}`); }
  restorePlaybook(filename, version) { return this.request(`/playbooks/${encodeURIComponent(filename)}/restore/${version}`, { method: 'POST' }); }
  testWebhook() { return this.request('/system/webhook-test', { method: 'POST' }); }
  testSmtp()    { return this.request('/system/smtp-test',    { method: 'POST' }); }
  runUpdate(serverId) { return this.request(`/servers/${serverId}/update`, { method: 'POST' }); }
  runUpdateAll() { return this.request(`/servers/update-all`, { method: 'POST' }); }
  runReboot(serverId) { return this.request(`/servers/${serverId}/reboot`, { method: 'POST' }); }
  runPlaybook(playbook, targets, extraVars) {
    return this.request('/ansible/run', { method: 'POST', body: { playbook, targets, extraVars } });
  }

  // Agent (v1)
  getAgentStatus(serverId) { return this.request(`/v1/servers/${serverId}/agent/status`); }
  installAgent(serverId, data) { return this.request(`/v1/servers/${serverId}/agent/install`, { method: 'POST', body: data }); }
  updateAgent(serverId) { return this.request(`/v1/servers/${serverId}/agent/update`, { method: 'POST' }); }
  configureAgent(serverId, data) { return this.request(`/v1/servers/${serverId}/agent/config`, { method: 'PUT', body: data }); }
  rotateAgentToken(serverId, data = {}) { return this.request(`/v1/servers/${serverId}/agent/token-rotate`, { method: 'POST', body: data }); }
  removeAgent(serverId) { return this.request(`/v1/servers/${serverId}/agent`, { method: 'DELETE' }); }
  getAgentManifest() { return this.request('/v1/agent-manifest'); }
  getAgentManifestHistory(limit = 50) { return this.request(`/v1/agent-manifest/history?limit=${encodeURIComponent(limit)}`); }
  saveAgentManifest(content, changelog = '') { return this.request('/v1/agent-manifest', { method: 'PUT', body: { content, changelog } }); }

  // Plugins
  getPlugins()          { return this.request('/plugins'); }
  enablePlugin(id)      { return this.request(`/plugins/${id}/enable`,  { method: 'POST' }); }
  disablePlugin(id)     { return this.request(`/plugins/${id}/disable`, { method: 'POST' }); }
  reloadPlugins()       { return this.request('/plugins/reload',        { method: 'POST' }); }

  // Onboarding
  markOnboardingDone() { return this.request('/system/onboarding-complete', { method: 'POST' }); }

  // Reset / Danger Zone
  resetServers()   { return this.request('/reset/servers',   { method: 'DELETE' }); }
  resetSchedules() { return this.request('/reset/schedules', { method: 'DELETE' }); }
  resetPlaybooks() { return this.request('/reset/playbooks', { method: 'DELETE' }); }
  resetAuth()      { return this.request('/reset/auth',      { method: 'DELETE' }); }
  resetAll()       { return this.request('/reset/all',       { method: 'DELETE' }); }

  // Schedules
  getSchedules() { return this.request('/schedules'); }
  createSchedule(data) { return this.request('/schedules', { method: 'POST', body: data }); }
  updateSchedule(id, data) { return this.request(`/schedules/${id}`, { method: 'PUT', body: data }); }
  deleteSchedule(id) { return this.request(`/schedules/${id}`, { method: 'DELETE' }); }
  toggleSchedule(id) { return this.request(`/schedules/${id}/toggle`, { method: 'POST' }); }

  // Schedule History
  getScheduleHistory(limit = 100, scheduleId = null) {
    const q = new URLSearchParams({ limit });
    if (scheduleId) q.set('scheduleId', scheduleId);
    return this.request(`/schedule-history?${q}`);
  }
  getScheduleHistoryEntry(id) { return this.request(`/schedule-history/${id}`); }

  // Ansible Variables
  getAnsibleVars() { return this.request('/ansible-vars'); }
  createAnsibleVar(data) { return this.request('/ansible-vars', { method: 'POST', body: data }); }
  updateAnsibleVar(id, data) { return this.request(`/ansible-vars/${id}`, { method: 'PUT', body: data }); }
  deleteAnsibleVar(id) { return this.request(`/ansible-vars/${id}`, { method: 'DELETE' }); }

  // Ad-hoc Commands
  runAdhoc(targets, module, args) { return this.request('/adhoc/run', { method: 'POST', body: { targets, module, args } }); }

  // Playbooks Git
  getGitConfig()        { return this.request('/playbooks-git/config'); }
  saveGitConfig(data)   { return this.request('/playbooks-git/config', { method: 'PUT', body: data }); }
  gitSetup(data)        { return this.request('/playbooks-git/setup', { method: 'POST', body: data }); }
  getGitStatus()        { return this.request('/playbooks-git/status'); }
  getGitLog()           { return this.request('/playbooks-git/log'); }
  getGitBranches()      { return this.request('/playbooks-git/branches'); }
  gitCheckout(branch)   { return this.request('/playbooks-git/checkout', { method: 'POST', body: { branch } }); }
  gitCommit(message)    { return this.request('/playbooks-git/commit', { method: 'POST', body: { message } }); }
  gitPull()             { return this.request('/playbooks-git/pull',  { method: 'POST' }); }
  gitPush()             { return this.request('/playbooks-git/push',  { method: 'POST' }); }

  // User management
  getUsers()                       { return this.request('/users'); }
  createUser(data)                 { return this.request('/users', { method: 'POST', body: data }); }
  updateUser(id, data)             { return this.request(`/users/${id}`, { method: 'PUT', body: data }); }
  resetUserPassword(id, password)  { return this.request(`/users/${id}/password`, { method: 'PUT', body: { password } }); }
  disableUserTotp(id)              { return this.request(`/users/${id}/totp-disable`, { method: 'PUT' }); }
  deleteUser(id)                   { return this.request(`/users/${id}`, { method: 'DELETE' }); }

  // Role management
  getRoles()                       { return this.request('/roles'); }
  createRole(data)                 { return this.request('/roles', { method: 'POST', body: data }); }
  updateRole(id, data)             { return this.request(`/roles/${id}`, { method: 'PUT', body: data }); }
  deleteRole(id)                   { return this.request(`/roles/${id}`, { method: 'DELETE' }); }
}

export const api = new ApiClient();
