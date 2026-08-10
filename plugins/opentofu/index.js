const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const net  = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const log = require('../../server/utils/logger').child('plugins:opentofu');
const ansibleRunner = require('../../server/services/ansible-runner');
const { getPermissions, can, canAccessPlaybook, filterServers } = require('../../server/utils/permissions');
const cryptoUtil = require('../../server/utils/crypto');

let _gitSync = null;
function getGitSync() {
  if (!_gitSync) {
    try { _gitSync = require('../../server/services/git-sync'); } catch {}
  }
  return _gitSync;
}

let _sshManager = null;
function getSshManager() {
  if (!_sshManager) {
    try { _sshManager = require('../../server/services/ssh-manager'); } catch {}
  }
  return _sshManager;
}

// Map of currently running processes: internal runId -> process context.
// The persisted dbRunId is what the console exposes, so retain both IDs.
const _running = new Map();

// ── Tofu <-> Git workspace sync ────────────────────────────────────────────
const GIT_WORKSPACE_DIR = path.resolve(path.join(__dirname, '..', '..', 'server', 'data', 'git-workspace'));
const TOFU_SUBDIR       = 'tofu';
// Only .tf files are synced to git — .tfvars may contain secrets
const TOFU_EXTENSIONS   = ['.tf'];

function tofuGitDir(workspaceName) {
  return path.join(GIT_WORKSPACE_DIR, TOFU_SUBDIR, workspaceName);
}

// Patterns that are never synced to git regardless of workspace .gitignore
const NEVER_SYNC = ['.tfvars', '.tfvars.json', '.auto.tfvars', '.tfstate', '.tfstate.backup'];
const SERVER_TYPE_HINTS = ['server', 'instance', 'vm', 'machine', 'droplet', 'compute', 'node', 'guest'];
const DIRECT_IP_KEYS = [
  'shipyard_ip',
  'ip_address',
  'ip',
  'default_ipv4_address',
  'primary_ipv4_address',
  'public_ip',
  'private_ip',
  'ipv4_address',
  'access_ip_v4',
  'main_ip',
];
const DIRECT_NAME_KEYS = ['shipyard_name', 'name', 'vm_name', 'hostname', 'host'];
const DIRECT_SSH_USER_KEYS = ['shipyard_ssh_user', 'ssh_user', 'default_user', 'admin_user', 'username'];
const DIRECT_SSH_PORT_KEYS = ['shipyard_ssh_port', 'ssh_port', 'port'];
const APPLY_SYNC_MAX_WAIT_MS = Math.max(0, parseInt(process.env.TOFU_SYNC_MAX_WAIT_MS || '90000', 10) || 90000);
const APPLY_SYNC_RETRY_MS = Math.max(1000, parseInt(process.env.TOFU_SYNC_RETRY_MS || '5000', 10) || 5000);
const TOFU_RUN_HISTORY_MAX = Math.max(25, parseInt(process.env.TOFU_RUN_HISTORY_MAX || '250', 10) || 250);
const TOFU_RUN_PAGE_SIZE_DEFAULT = Math.max(1, parseInt(process.env.TOFU_RUN_PAGE_SIZE_DEFAULT || '5', 10) || 5);
const TOFU_RUN_PAGE_SIZE_MAX = Math.max(TOFU_RUN_PAGE_SIZE_DEFAULT, parseInt(process.env.TOFU_RUN_PAGE_SIZE_MAX || '100', 10) || 100);
const SHIPYARD_OUTPUT_BLOCK_START = '# BEGIN SHIPYARD MANAGED OUTPUT';
const SHIPYARD_OUTPUT_BLOCK_END = '# END SHIPYARD MANAGED OUTPUT';
const PROVISION_PLAYBOOK_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ya?ml$/;
const SHIPYARD_OUTPUT_GENERATORS = {
  proxmox_virtual_environment_vm: {
    providerTag: 'proxmox',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    // The bpg/proxmox provider returns a nested list and its interface index is
    // not stable. Flatten it so the managed output keeps working for both a
    // single NIC and multi-NIC guests.
    ipExpr: (address) => `try([for ip in flatten(${address}.ipv4_addresses) : ip if !startswith(ip, "127.") && !startswith(ip, "169.254.")][0], null)`,
  },
  hcloud_server: {
    providerTag: 'hcloud',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.ipv4_address, null)`,
  },
  digitalocean_droplet: {
    providerTag: 'digitalocean',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.ipv4_address, null)`,
  },
  aws_instance: {
    providerTag: 'aws',
    sshUser: 'ec2-user',
    nameExpr: (address, name) => `try(${address}.tags["Name"], ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.public_ip, ${address}.private_ip, null)`,
  },
  google_compute_instance: {
    providerTag: 'gcp',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.network_interface[0].access_config[0].nat_ip, ${address}.network_interface[0].network_ip, null)`,
  },
};

function syncOneToGit(name, wsPath) {
  if (!fs.existsSync(wsPath)) return;
  const destDir = tofuGitDir(name);
  fs.mkdirSync(destDir, { recursive: true });
  const srcFiles = new Set(
    fs.readdirSync(wsPath).filter(f =>
      (f === '.gitignore' || TOFU_EXTENSIONS.some(e => f.endsWith(e))) &&
      !NEVER_SYNC.some(e => f.endsWith(e))
    )
  );
  for (const f of srcFiles) fs.copyFileSync(path.join(wsPath, f), path.join(destDir, f));
  // Remove from git dir what no longer exists locally
  const destFiles = fs.readdirSync(destDir).filter(f => TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of destFiles) if (!srcFiles.has(f)) fs.unlinkSync(path.join(destDir, f));
}

function syncOneFromGit(name, wsPath) {
  const srcDir = tofuGitDir(name);
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(wsPath, { recursive: true });
  const files = fs.readdirSync(srcDir).filter(f => TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(wsPath, f));
}

function syncAllToGit(workspaces) {
  for (const ws of workspaces) syncOneToGit(ws.name, ws.path);
}

function syncAllFromGit(workspaces) {
  for (const ws of workspaces) syncOneFromGit(ws.name, ws.path);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// `tofu destroy -auto-approve` is deliberately used for non-interactive runs.
// Never rely on the browser confirmation alone: the API may be called directly
// or from an outdated client.  A workspace-bound phrase makes the destructive
// operation explicit and prevents a generic accidental POST from deleting an
// entire workspace.
function destroyConfirmationPhrase(workspaceName) {
  return `DESTROY ${String(workspaceName || '').trim()}`;
}

function hasValidDestroyConfirmation(value, workspaceName) {
  return typeof value === 'string' && value === destroyConfirmationPhrase(workspaceName);
}

function normalizePostDeployPlaybooks(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw new Error('Post-Deploy-Playbooks müssen als Liste übergeben werden');
  if (value.length > 12) throw new Error('Es können höchstens 12 Post-Deploy-Playbooks ausgewählt werden');
  const unique = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('Ungültiges Post-Deploy-Playbook');
    const playbook = raw.trim();
    if (!PROVISION_PLAYBOOK_RE.test(playbook)) throw new Error(`Ungültiger Playbook-Name: ${playbook || 'leer'}`);
    if (!unique.includes(playbook)) unique.push(playbook);
  }
  return unique;
}

function uniqueStrings(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDirectoryEmpty(dirPath) {
  try {
    return fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function moveWorkspaceDirectory(fromPath, toPath) {
  const source = path.resolve(fromPath);
  const target = path.resolve(toPath);
  if (source === target) return false;
  if (!fs.existsSync(source)) return false;

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    const stats = fs.statSync(target);
    if (!stats.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${target}`);
    }
    if (!isDirectoryEmpty(target)) {
      throw new Error(`Target path already exists and is not empty: ${target}`);
    }
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }

  try {
    fs.renameSync(source, target);
    return true;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number.parseInt(value, 10);
    if (Number.isInteger(num) && num >= 1 && num <= 65535) return num;
  }
  return null;
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = trimmed.split('/')[0].trim();
  if (net.isIP(direct)) return direct;

  const match = trimmed.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (match && net.isIP(match[0])) return match[0];

  const ipv6Match = trimmed.match(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/i);
  if (ipv6Match && net.isIP(ipv6Match[0])) return ipv6Match[0];

  return null;
}

function isUsableGuestIp(ip) {
  if (!ip) return false;
  if (net.isIP(ip) === 4) return !ip.startsWith('127.') && !ip.startsWith('169.254.');
  if (net.isIP(ip) === 6) return ip !== '::1' && !ip.toLowerCase().startsWith('fe80:');
  return false;
}

function collectUsableIps(value, output = [], depth = 0) {
  if (depth > 6 || value == null) return output;
  if (typeof value === 'string') {
    const ip = normalizeIp(value);
    if (isUsableGuestIp(ip) && !output.includes(ip)) output.push(ip);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectUsableIps(item, output, depth + 1));
    return output;
  }
  if (isPlainObject(value)) Object.values(value).forEach(item => collectUsableIps(item, output, depth + 1));
  return output;
}

function findFirstIp(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    const ip = normalizeIp(value);
    return isUsableGuestIp(ip) ? ip : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ip = findFirstIp(item, depth + 1);
      if (ip) return ip;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;

  for (const key of DIRECT_IP_KEYS) {
    if (key in value) {
      const ip = findFirstIp(value[key], depth + 1);
      if (ip) return ip;
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!/ip|addr|address|network/i.test(key)) continue;
    const ip = findFirstIp(nested, depth + 1);
    if (ip) return ip;
  }

  for (const nested of Object.values(value)) {
    const ip = findFirstIp(nested, depth + 1);
    if (ip) return ip;
  }

  return null;
}

function normalizeServerCandidate(candidate, {
  resourceKey,
  workspaceName,
  fallbackName = null,
  defaultTags = [],
} = {}) {
  const base = typeof candidate === 'string'
    ? { ip_address: candidate, name: fallbackName || candidate }
    : candidate;

  if (!isPlainObject(base)) return null;

  const tags = uniqueStrings(
    Array.isArray(base.tags) ? base.tags : [],
    defaultTags,
    ['opentofu', `opentofu:${workspaceName}`]
  );

  const directIpAddress = firstNonEmptyString(
    ...DIRECT_IP_KEYS.map(key => typeof base[key] === 'string' ? base[key] : null)
  );
  // Proxmox uses "dhcp" in the desired Cloud-Init configuration. It is not
  // an address and must not prevent scanning the actual guest addresses.
  const normalizedIp = (isUsableGuestIp(normalizeIp(directIpAddress)) && normalizeIp(directIpAddress)) || findFirstIp(base);
  if (!normalizedIp) return null;

  const name = firstNonEmptyString(
    ...DIRECT_NAME_KEYS.map(key => typeof base[key] === 'string' ? base[key] : null),
    fallbackName,
    normalizedIp
  );
  if (!name) return null;

  const hostname = firstNonEmptyString(base.hostname, base.host, name, normalizedIp) || normalizedIp;
  const sshUser = firstNonEmptyString(...DIRECT_SSH_USER_KEYS.map(key => base[key])) || 'root';
  const sshPort = firstNumber(...DIRECT_SSH_PORT_KEYS.map(key => base[key])) || 22;

  return {
    resource_key: resourceKey,
    name,
    hostname,
    ip_address: normalizedIp,
    ssh_user: sshUser,
    ssh_port: sshPort,
    tags,
    services: Array.isArray(base.services) ? uniqueStrings(base.services) : [],
  };
}

function flattenStateResources(moduleNode, out = []) {
  if (!moduleNode || typeof moduleNode !== 'object') return out;
  if (Array.isArray(moduleNode.resources)) out.push(...moduleNode.resources);
  if (Array.isArray(moduleNode.child_modules)) {
    for (const child of moduleNode.child_modules) flattenStateResources(child, out);
  }
  return out;
}

function resourceLooksLikeServer(resource) {
  const type = String(resource?.type || '').toLowerCase();
  if (SERVER_TYPE_HINTS.some(hint => type.includes(hint))) return true;

  const values = resource?.values;
  if (!isPlainObject(values)) return false;
  if (values.shipyard_managed === true) return true;
  return !!findFirstIp(values) && !!firstNonEmptyString(values.name, values.hostname, values.vm_name);
}

function extractServersFromOutputs(outputs, workspaceName) {
  const extracted = [];
  const pushCandidate = (candidate, baseKey, fallbackName = null) => {
    const stableId = isPlainObject(candidate)
      ? firstNonEmptyString(candidate.id, candidate.name, candidate.hostname, fallbackName, baseKey)
      : fallbackName || baseKey;
    const normalized = normalizeServerCandidate(candidate, {
      resourceKey: `${baseKey}:${stableId}`,
      workspaceName,
      fallbackName,
      defaultTags: ['managed-by-output'],
    });
    if (normalized) extracted.push(normalized);
  };

  if (Object.prototype.hasOwnProperty.call(outputs || {}, 'shipyard_server')) {
    pushCandidate(outputs.shipyard_server?.value, 'output:shipyard_server');
  }

  if (Object.prototype.hasOwnProperty.call(outputs || {}, 'shipyard_servers')) {
    const value = outputs.shipyard_servers?.value;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => pushCandidate(entry, 'output:shipyard_servers', `server-${index + 1}`));
    } else if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        pushCandidate(entry, 'output:shipyard_servers', key);
      }
    } else if (value != null) {
      pushCandidate(value, 'output:shipyard_servers');
    }
  }

  return extracted;
}

function extractServersFromResources(state, workspaceName) {
  const resources = flattenStateResources(state?.values?.root_module);
  const extracted = [];

  for (const resource of resources) {
    if (!resourceLooksLikeServer(resource)) continue;
    const normalized = normalizeServerCandidate(resource.values || {}, {
      resourceKey: `resource:${resource.address || resource.type || randomUUID()}`,
      workspaceName,
      fallbackName: firstNonEmptyString(resource.values?.name, resource.values?.hostname, resource.name, resource.address),
      defaultTags: [resource.type || 'resource-managed'],
    });
    if (normalized) extracted.push(normalized);
  }

  return extracted;
}

function extractManagedServersFromState(state, workspaceName) {
  const outputs = state?.values?.outputs || {};
  const hasExplicitOutputs =
    Object.prototype.hasOwnProperty.call(outputs, 'shipyard_server') ||
    Object.prototype.hasOwnProperty.call(outputs, 'shipyard_servers');

  if (hasExplicitOutputs) {
    const rawValues = [];
    if (Object.prototype.hasOwnProperty.call(outputs, 'shipyard_server')) rawValues.push(outputs.shipyard_server?.value);
    if (Object.prototype.hasOwnProperty.call(outputs, 'shipyard_servers')) rawValues.push(outputs.shipyard_servers?.value);
    const hasNonEmptyRaw = rawValues.some(value => {
      if (value == null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (isPlainObject(value)) return Object.keys(value).length > 0;
      if (typeof value === 'string') return value.trim() !== '';
      return true;
    });
    const servers = extractServersFromOutputs(outputs, workspaceName);
    return {
      authoritative: servers.length > 0 || !hasNonEmptyRaw,
      source: 'outputs',
      servers,
    };
  }

  return {
    authoritative: false,
    source: 'state',
    servers: extractServersFromResources(state, workspaceName),
  };
}

function buildServerPayload(existingServer, desiredServer, workspace) {
  return {
    name: desiredServer.name,
    hostname: desiredServer.hostname || desiredServer.name,
    ip_address: desiredServer.ip_address,
    ssh_port: desiredServer.ssh_port || existingServer?.ssh_port || 22,
    ssh_user: desiredServer.ssh_user || existingServer?.ssh_user || 'root',
    tags: uniqueStrings(
      parseJsonArray(existingServer?.tags),
      desiredServer.tags || [],
      ['opentofu', `opentofu:${workspace.name}`]
    ),
    services: uniqueStrings(parseJsonArray(existingServer?.services), desiredServer.services || []),
  };
}

function findReusableServer(allServers, trackedServerIds, desiredServer) {
  const exactIp = allServers.find(server =>
    server.ip_address === desiredServer.ip_address && !trackedServerIds.has(server.id)
  );
  if (exactIp) return exactIp;

  return allServers.find(server =>
    server.name === desiredServer.name && !trackedServerIds.has(server.id)
  ) || null;
}

async function reconcileManagedServers({ db, workspace, desiredServers, logMeta = {} }) {
  ensureManagedServersTable(db);
  const mappings = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').all(workspace.id);
  const mappingsByKey = new Map(mappings.map(mapping => [mapping.resource_key, mapping]));
  const trackedMappings = db.db.prepare('SELECT * FROM tofu_managed_servers').all();
  const trackedServerIds = new Set(trackedMappings.map(mapping => mapping.server_id));

  const existingServers = db.servers.getAll();
  const desiredKeys = new Set(desiredServers.map(server => server.resource_key));
  const upsertMapping = db.db.prepare(`
    INSERT INTO tofu_managed_servers (id, workspace_id, resource_key, server_id, created_by_plugin)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, resource_key) DO UPDATE SET
      server_id = excluded.server_id,
      created_by_plugin = excluded.created_by_plugin,
      updated_at = datetime('now')
  `);
  const deleteMapping = db.db.prepare('DELETE FROM tofu_managed_servers WHERE workspace_id = ? AND resource_key = ?');

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let untracked = 0;

  for (const desiredServer of desiredServers) {
    const mapping = mappingsByKey.get(desiredServer.resource_key);
    let targetServer = mapping ? db.servers.getById(mapping.server_id) : null;
    let createdByPlugin = mapping ? !!mapping.created_by_plugin : false;

    if (!targetServer) {
      targetServer = findReusableServer(existingServers, trackedServerIds, desiredServer);
      createdByPlugin = false;
    }

    const payload = buildServerPayload(targetServer, desiredServer, workspace);

    if (targetServer) {
      db.servers.update(targetServer.id, payload);
      updated++;
    } else {
      targetServer = db.servers.create(payload);
      existingServers.push(targetServer);
      trackedServerIds.add(targetServer.id);
      createdByPlugin = true;
      created++;
    }

    upsertMapping.run(randomUUID(), workspace.id, desiredServer.resource_key, targetServer.id, createdByPlugin ? 1 : 0);
    trackedServerIds.add(targetServer.id);
  }

  // Auto-reset stale SSH host keys for all synced IPs so re-deployed VMs
  // on the same IP don't cause host key verification failures.
  const syncedIps = desiredServers.map(s => s.ip_address).filter(Boolean);
  if (syncedIps.length > 0) {
    try {
      const ssh = getSshManager();
      if (ssh) {
        const result = ssh.removeKnownHostEntries(syncedIps);
        if (result.removed.length > 0) {
          log.info({ removed: result.removed }, 'Auto-cleared stale SSH host keys after apply');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to auto-clear SSH host keys');
    }
  }

  for (const mapping of mappings) {
    if (desiredKeys.has(mapping.resource_key)) continue;
    if (mapping.created_by_plugin) {
      const existing = db.servers.getById(mapping.server_id);
      if (existing) {
        db.servers.delete(mapping.server_id);
        deleted++;
      }
    } else {
      untracked++;
    }
    deleteMapping.run(workspace.id, mapping.resource_key);
  }

  if (created || updated || deleted || untracked) {
    db.auditLog.write(
      'tofu.server_sync',
      `workspace=${workspace.name} created=${created} updated=${updated} deleted=${deleted} untracked=${untracked}`,
      logMeta.ip || null,
      true,
      logMeta.user || null
    );
  }

  return { created, updated, deleted, untracked };
}

function cleanupManagedServersForWorkspace({ db, workspace, logMeta = {} }) {
  ensureManagedServersTable(db);
  const mappings = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').all(workspace.id);
  let deleted = 0;
  let untracked = 0;

  for (const mapping of mappings) {
    if (mapping.created_by_plugin) {
      const existing = db.servers.getById(mapping.server_id);
      if (existing) {
        db.servers.delete(mapping.server_id);
        deleted++;
      }
    } else {
      untracked++;
    }
  }

  db.db.prepare('DELETE FROM tofu_managed_servers WHERE workspace_id = ?').run(workspace.id);

  if (deleted || untracked) {
    db.auditLog.write(
      'tofu.server_cleanup',
      `workspace=${workspace.name} deleted=${deleted} untracked=${untracked}`,
      logMeta.ip || null,
      true,
      logMeta.user || null
    );
  }

  return { deleted, untracked };
}

async function loadWorkspaceState({ binary, workspace, env }) {
  const { stdout } = await execFileAsync(binary, ['show', '-json'], {
    cwd: workspace.path,
    env,
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function ensureManagedServersTable(db) {
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_managed_servers (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      resource_key      TEXT NOT NULL,
      server_id         TEXT NOT NULL,
      created_by_plugin INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, resource_key)
    )
  `).run();
}

async function waitForManagedServers({
  loadState,
  workspaceName,
  maxWaitMs = APPLY_SYNC_MAX_WAIT_MS,
  retryMs = APPLY_SYNC_RETRY_MS,
  sleepFn = sleep,
  hydrateServers = null,
}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastSync = { authoritative: false, source: 'state', servers: [] };

  while (true) {
    attempts++;
    const state = await loadState();
    lastSync = extractManagedServersFromState(state, workspaceName);

    let pending = false;
    if (lastSync.servers.length > 0 && typeof hydrateServers === 'function') {
      const hydrated = await hydrateServers({ state, servers: lastSync.servers });
      if (hydrated?.servers) lastSync = { ...lastSync, servers: hydrated.servers };
      pending = hydrated?.pending === true;
    }

    if (lastSync.servers.length > 0 && !pending) {
      return { ...lastSync, state, attempts, waitedMs: Date.now() - startedAt, timedOut: false };
    }

    if (lastSync.source === 'outputs' && !lastSync.authoritative) {
      return { ...lastSync, state, attempts, waitedMs: Date.now() - startedAt, timedOut: false };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      return { ...lastSync, state, attempts, waitedMs: elapsed, timedOut: true };
    }

    await sleepFn(Math.min(retryMs, Math.max(0, maxWaitMs - elapsed)));
  }
}

function readTerraformFiles(wsPath) {
  if (!fs.existsSync(wsPath)) return [];
  return fs.readdirSync(wsPath)
    .filter(name => name.endsWith('.tf'))
    .sort()
    .map(name => ({
      name,
      path: path.join(wsPath, name),
      content: fs.readFileSync(path.join(wsPath, name), 'utf8'),
    }));
}

function detectTerraformResources(files) {
  const resources = [];
  const seen = new Set();
  const pattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;

  for (const file of files) {
    let match;
    while ((match = pattern.exec(file.content)) !== null) {
      const type = match[1];
      const name = match[2];
      const key = `${type}.${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push({ type, name, address: `${type}.${name}`, file: file.name });
    }
  }

  return resources;
}

function supportedTerraformResources(resources) {
  return resources.filter(resource => !!SHIPYARD_OUTPUT_GENERATORS[resource.type]);
}

function generateShipyardOutputsBlock(resources) {
  const supported = supportedTerraformResources(resources);
  if (supported.length === 0) {
    throw new Error(`No supported VM resources found. Supported types: ${Object.keys(SHIPYARD_OUTPUT_GENERATORS).join(', ')}`);
  }

  const lines = [
    SHIPYARD_OUTPUT_BLOCK_START,
    '# Managed by Shipyard / OpenTofu',
    '# Adjust ssh_user or ssh_port below if your image uses different defaults.',
    'output "shipyard_servers" {',
    '  value = {',
  ];

  for (const resource of supported) {
    const config = SHIPYARD_OUTPUT_GENERATORS[resource.type];
    lines.push(`    ${JSON.stringify(resource.name)} = {`);
    lines.push(`      name       = ${config.nameExpr(resource.address, resource.name)}`);
    lines.push(`      hostname   = ${config.nameExpr(resource.address, resource.name)}`);
    lines.push(`      ip_address = ${config.ipExpr(resource.address)}`);
    lines.push(`      ssh_user   = ${JSON.stringify(config.sshUser)}`);
    lines.push('      ssh_port   = 22');
    lines.push(`      tags       = [${JSON.stringify(config.providerTag)}]`);
    lines.push('    }');
  }

  lines.push('  }');
  lines.push('}');
  lines.push(SHIPYARD_OUTPUT_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

function upsertManagedShipyardOutputs(existingContent, generatedBlock) {
  const markerRe = new RegExp(
    `${escapeRegExp(SHIPYARD_OUTPUT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SHIPYARD_OUTPUT_BLOCK_END)}\\n?`,
    'm'
  );

  if (markerRe.test(existingContent)) {
    return existingContent.replace(markerRe, generatedBlock);
  }

  const trimmed = existingContent.trimEnd();
  if (!trimmed) return generatedBlock;
  return `${trimmed}\n\n${generatedBlock}`;
}

// ── Fleet-managed Proxmox VM blueprints ───────────────────────────────────
// These helpers deliberately generate a separate .tf file.  A workspace may
// still contain hand-written Terraform, but VM definitions created in Fleet do
// not require its users to edit HCL.
const PROXMOX_VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PROXMOX_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROXMOX_TF_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PROXMOX_INTERFACE_RE = /^(?:scsi|virtio|sata|ide)\d+$/;

function proxmoxInt(value, fallback, { min, max, field }) {
  const raw = String(value ?? '').trim();
  const number = raw === '' ? fallback : (/^\d+$/.test(raw) ? Number(raw) : NaN);
  const result = Number.isFinite(number) ? number : fallback;
  if (raw && !Number.isFinite(number)) throw new Error(`Invalid ${field}`);
  if (result < min || result > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return result;
}

function proxmoxString(value, fallback, { field, pattern = PROXMOX_IDENTIFIER_RE, max = 100 } = {}) {
  const result = String(value ?? fallback ?? '').trim();
  if (!result || result.length > max || !pattern.test(result)) throw new Error(`Invalid ${field}`);
  return result;
}

function normalizeProxmoxVm(input = {}) {
  const diskDiscard = String(input.disk_discard ?? 'on');
  if (!['on', 'ignore'].includes(diskDiscard)) throw new Error('Invalid disk discard setting');
  const ipv4Input = String(input.ipv4_address ?? 'dhcp').trim().toLowerCase();
  const ipv4Prefix = proxmoxInt(input.ipv4_prefix, 24, { min: 0, max: 32, field: 'IPv4 prefix' });
  const ipv4Address = normalizeStaticIpv4Address(ipv4Input, ipv4Prefix);
  const gateway = String(input.ipv4_gateway ?? '').trim();
  if (gateway && !isValidIpv4(gateway)) throw new Error('Invalid IPv4 gateway');
  const vlanRaw = String(input.vlan_id ?? '').trim();
  const vlanId = vlanRaw === '' ? null : proxmoxInt(vlanRaw, null, { min: 1, max: 4094, field: 'VLAN ID' });
  const vmIdRaw = String(input.vm_id ?? '').trim();
  const vmId = vmIdRaw === '' ? null : proxmoxInt(vmIdRaw, null, { min: 100, max: 999999999, field: 'VM ID' });
  const sshPublicKeyVariable = String(input.ssh_public_key_variable ?? '').trim();
  if (sshPublicKeyVariable && !PROXMOX_TF_IDENTIFIER_RE.test(sshPublicKeyVariable)) {
    throw new Error('Invalid SSH public key variable');
  }

  return {
    name: proxmoxString(input.name, '', { field: 'VM name', pattern: PROXMOX_VM_NAME_RE, max: 63 }),
    node_name: proxmoxString(input.node_name, '', { field: 'Proxmox node' }),
    vm_id: vmId,
    started: input.started !== false && input.started !== 'false',
    clone_vm_id: proxmoxInt(input.clone_vm_id, 9000, { min: 1, max: 999999999, field: 'Template VM ID' }),
    clone_retries: proxmoxInt(input.clone_retries, 3, { min: 0, max: 10, field: 'Clone retries' }),
    disk_datastore: proxmoxString(input.disk_datastore, '', { field: 'Disk datastore' }),
    disk_interface: proxmoxString(input.disk_interface, 'scsi0', { field: 'Disk interface', pattern: PROXMOX_INTERFACE_RE, max: 10 }),
    disk_size_gb: proxmoxInt(input.disk_size_gb, 40, { min: 1, max: 65536, field: 'Disk size' }),
    disk_discard: diskDiscard,
    cpu_cores: proxmoxInt(input.cpu_cores, 2, { min: 1, max: 128, field: 'CPU cores' }),
    cpu_type: proxmoxString(input.cpu_type, 'host', { field: 'CPU type', pattern: /^[A-Za-z0-9._-]{1,60}$/, max: 60 }),
    memory_mb: proxmoxInt(input.memory_mb, 4096, { min: 256, max: 1048576, field: 'Memory' }),
    agent_enabled: input.agent_enabled !== false && input.agent_enabled !== 'false',
    bridge: proxmoxString(input.bridge, 'vmbr0', { field: 'Network bridge' }),
    vlan_id: vlanId,
    ipv4_address: ipv4Address,
    ipv4_prefix: ipv4Address === 'dhcp' ? null : Number(ipv4Address.split('/')[1]),
    ipv4_gateway: ipv4Address === 'dhcp' ? '' : gateway,
    username: proxmoxString(input.username, 'ubuntu', { field: 'Guest username', pattern: /^[a-z_][a-z0-9_-]{0,31}$/, max: 32 }),
    ssh_public_key_variable: sshPublicKeyVariable,
    post_deploy_playbooks: normalizePostDeployPlaybooks(input.post_deploy_playbooks),
  };
}

function normalizeProxmoxVmTemplate(input = {}) {
  if (!isPlainObject(input.config)) throw new Error('Die VM-Vorlage enthält keine gültige Konfiguration');
  return {
    name: proxmoxString(input.name, '', {
      field: 'VM template name', pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/, max: 63,
    }),
    config: normalizeProxmoxVm(input.config),
  };
}

function normalizeStaticIpv4Address(value, fallbackPrefix) {
  if (value === 'dhcp') return 'dhcp';
  const [address, inlinePrefix] = String(value || '').split('/', 2);
  const prefix = inlinePrefix === undefined || inlinePrefix === ''
    ? fallbackPrefix
    : proxmoxInt(inlinePrefix, fallbackPrefix, { min: 0, max: 32, field: 'IPv4 prefix' });
  if (!isValidIpv4(address)) throw new Error('IPv4 address must be DHCP or a valid IPv4 address');
  return `${address}/${prefix}`;
}

function isValidIpv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
}

function renderProxmoxVmHcl(vm) {
  const lines = [
    `resource "proxmox_virtual_environment_vm" ${JSON.stringify(vm.name)} {`,
    `  name      = ${JSON.stringify(vm.name)}`,
    `  node_name = ${JSON.stringify(vm.node_name)}`,
  ];
  if (vm.vm_id !== null && vm.vm_id !== undefined) lines.push(`  vm_id     = ${vm.vm_id}`);
  lines.push(
    `  started   = ${vm.started}`,
    '', '  clone {', `    vm_id   = ${vm.clone_vm_id}`, `    retries = ${vm.clone_retries}`, '  }',
    '', '  disk {', `    datastore_id = ${JSON.stringify(vm.disk_datastore)}`,
    `    interface    = ${JSON.stringify(vm.disk_interface)}`, `    size         = ${vm.disk_size_gb}`,
    `    discard      = ${JSON.stringify(vm.disk_discard)}`, '  }',
    '', '  cpu {', `    cores = ${vm.cpu_cores}`, `    type  = ${JSON.stringify(vm.cpu_type)}`, '  }',
    '', '  memory {', `    dedicated = ${vm.memory_mb}`, '  }',
    '', '  agent {', `    enabled = ${vm.agent_enabled}`, '  }',
    '', '  network_device {', `    bridge = ${JSON.stringify(vm.bridge)}`,
  );
  if (vm.vlan_id !== null) lines.push(`    vlan_id = ${vm.vlan_id}`);
  lines.push('  }', '', '  initialization {', '    ip_config {', '      ipv4 {', `        address = ${JSON.stringify(vm.ipv4_address)}`);
  if (vm.ipv4_gateway) lines.push(`        gateway = ${JSON.stringify(vm.ipv4_gateway)}`);
  lines.push('      }', '    }', '', '    user_account {', `      username = ${JSON.stringify(vm.username)}`);
  if (vm.ssh_public_key_variable) lines.push(`      keys     = [var.${vm.ssh_public_key_variable}]`);
  lines.push('    }', '  }', '}');
  return lines.join('\n');
}

function buildProxmoxProviderFiles(vms) {
  const sshVariables = [...new Set(vms.map(vm => vm.ssh_public_key_variable).filter(Boolean))];
  return {
    provider: `# Generated by Fleet. Connection values are set under Variables in this workspace.\nterraform {\n  required_providers {\n    proxmox = {\n      source  = "bpg/proxmox"\n      version = "~> 0.66"\n    }\n  }\n}\n\nprovider "proxmox" {\n  endpoint  = var.proxmox_endpoint\n  api_token = var.proxmox_api_token\n  insecure  = var.proxmox_insecure\n}\n`,
    variables: `# Generated by Fleet. Secret values are never written to this file.\nvariable "proxmox_endpoint" {\n  type = string\n}\n\nvariable "proxmox_api_token" {\n  type      = string\n  sensitive = true\n}\n\nvariable "proxmox_insecure" {\n  type    = bool\n  default = false\n}\n${sshVariables.map(name => `\nvariable "${name}" {\n  type      = string\n  sensitive = true\n}\n`).join('')}`,
    vms: `# Generated by Fleet OpenTofu VM form. Edit VMs in the Fleet console.\n\n${vms.map(renderProxmoxVmHcl).join('\n\n')}\n`,
  };
}

function getProxmoxStateResources(state) {
  const resources = flattenStateResources(state?.values?.root_module);
  return resources.filter(resource => resource.type === 'proxmox_virtual_environment_vm');
}

function normalizeResourceKey(resource) {
  if (!resource) return null;
  const address = String(resource.address || '').trim();
  return address ? `resource:${address}` : null;
}

function extractProxmoxGuestIpv4(payload) {
  const interfaces = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.result) ? payload.result : []);

  for (const iface of interfaces) {
    if (!iface || String(iface.name || '').toLowerCase() === 'lo') continue;
    const addresses = Array.isArray(iface['ip-addresses'])
      ? iface['ip-addresses']
      : (Array.isArray(iface.ip_addresses) ? iface.ip_addresses : []);
    for (const address of addresses) {
      const type = String(address?.['ip-address-type'] || address?.ip_address_type || '').toLowerCase();
      const ip = normalizeIp(address?.['ip-address'] || address?.ip_address || address?.address);
      if (!ip || net.isIP(ip) !== 4 || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!type || type === 'ipv4') return ip;
    }
  }
  return null;
}

function applyFleetProxmoxBlueprintMetadata({ servers, state, vms, guestIps = new Map() }) {
  const resourcesByKey = new Map(
    getProxmoxStateResources(state)
      .map(resource => [normalizeResourceKey(resource), resource])
      .filter(([key]) => key)
  );
  const vmByResourceKey = new Map((Array.isArray(vms) ? vms : []).map(vm => [
    `resource:proxmox_virtual_environment_vm.${vm.name}`,
    vm,
  ]));
  const pendingDhcpResourceKeys = [];

  const enriched = (Array.isArray(servers) ? servers : []).map(server => {
    const vm = vmByResourceKey.get(server.resource_key);
    if (!vm) return server;

    const resource = resourcesByKey.get(server.resource_key);
    const guestIp = guestIps.get(server.resource_key);
    const next = {
      ...server,
      // The Cloud-Init account is the account Fleet must use afterwards. Never
      // fall back to the generic provider default for form-created VMs.
      ssh_user: vm.username || server.ssh_user,
      hostname: vm.name || server.hostname,
    };
    if (guestIp) next.ip_address = guestIp;

    // A successful agent query without a routable address means DHCP is still
    // in progress. Let the existing state retry loop wait for the real lease.
    if (vm.ipv4_address === 'dhcp' && resource && !guestIp) {
      pendingDhcpResourceKeys.push(server.resource_key);
    }
    return next;
  });

  return { servers: enriched, pendingDhcpResourceKeys };
}

function buildProxmoxResourceOverview(vms, state = null) {
  const nodeMap = new Map();
  const addToNode = vm => {
    const entry = nodeMap.get(vm.node_name) || { name: vm.node_name, vm_count: 0, cpu_cores: 0, memory_mb: 0, disk_gb: 0 };
    entry.vm_count++; entry.cpu_cores += vm.cpu_cores; entry.memory_mb += vm.memory_mb; entry.disk_gb += vm.disk_size_gb;
    nodeMap.set(vm.node_name, entry);
  };
  vms.forEach(addToNode);
  const actual = getProxmoxStateResources(state).map(resource => ({
    address: resource.address,
    name: resource.values?.name || resource.name,
    node_name: resource.values?.node_name || null,
    vm_id: resource.values?.vm_id || null,
    status: resource.values?.started === false ? 'stopped' : 'managed',
    // Proxmox exposes loopback before the configured NIC in many states.
    // Present only routable guest addresses in the resource overview.
    ip_addresses: collectUsableIps(resource.values?.ipv4_addresses || []),
  }));
  return {
    desired: {
      vm_count: vms.length,
      cpu_cores: vms.reduce((sum, vm) => sum + vm.cpu_cores, 0),
      memory_mb: vms.reduce((sum, vm) => sum + vm.memory_mb, 0),
      disk_gb: vms.reduce((sum, vm) => sum + vm.disk_size_gb, 0),
      nodes: [...nodeMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    actual: { available: !!state, vm_count: actual.length, resources: actual },
  };
}

function pruneWorkspaceRuns(db, workspaceId, keep = TOFU_RUN_HISTORY_MAX) {
  const limit = Math.max(1, parseInt(keep, 10) || TOFU_RUN_HISTORY_MAX);
  return db.db.prepare(`
    DELETE FROM tofu_runs
    WHERE workspace_id = ?
      AND id NOT IN (
        SELECT id
        FROM tofu_runs
        WHERE workspace_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      )
  `).run(workspaceId, workspaceId, limit);
}

const https = require('https');
const http  = require('http');
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);

function _downloadFile(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'shipyard-lab-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        _downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = require('fs').createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function _fetchGitHubReleases() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/opentofu/opentofu/releases?per_page=15',
      headers: { 'User-Agent': 'shipyard-lab-manager' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          if (!Array.isArray(list)) { reject(new Error(list.message || 'GitHub API error')); return; }
          const versions = list
            .filter(r => !r.prerelease && !r.draft)
            .map(r => r.tag_name.replace(/^v/, ''))
            .filter(v => /^\d+\.\d+\.\d+$/.test(v));
          resolve(versions);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function createProxmoxConnection(endpointInput, apiTokenInput, insecureInput = false) {
  const endpoint = String(endpointInput || '').trim();
  const apiToken = String(apiTokenInput || '').trim();
  const insecureRaw = String(insecureInput || '').trim().toLowerCase();
  if (!endpoint || !apiToken) {
    throw new Error('Proxmox API-Endpunkt oder API-Token sind nicht konfiguriert.');
  }
  let base;
  try { base = new URL(endpoint); }
  catch { throw new Error('Die Proxmox-API-URL ist ungültig.'); }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Die Proxmox-API muss eine HTTPS-URL ohne Zugangsdaten in der URL verwenden.');
  }
  return {
    base,
    apiToken,
    insecure: insecureInput === true || ['1', 'true', 'yes', 'on'].includes(insecureRaw),
  };
}

function readProxmoxConnection(envVars = {}) {
  return createProxmoxConnection(
    envVars.TF_VAR_proxmox_endpoint || envVars.PROXMOX_ENDPOINT,
    envVars.TF_VAR_proxmox_api_token || envVars.PROXMOX_API_TOKEN,
    envVars.TF_VAR_proxmox_insecure || envVars.PROXMOX_INSECURE,
  );
}

function proxmoxApiUrl(connection, apiPath) {
  const url = new URL(connection.base.toString());
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/api2\/json$/, '');
  const [resourcePath, query = ''] = String(apiPath).split('?', 2);
  url.pathname = `${basePath}/api2/json/${resourcePath.replace(/^\/+/, '')}`;
  url.search = query ? `?${query}` : '';
  return url;
}

function requestProxmoxApi(connection, apiPath, { method = 'GET', payload = null } = {}) {
  const url = proxmoxApiUrl(connection, apiPath);
  const body = payload && typeof payload === 'object'
    ? new URLSearchParams(Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])).toString()
    : '';
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `PVEAPIToken=${connection.apiToken}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      rejectUnauthorized: !connection.insecure,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Die Proxmox-API antwortete mit HTTP ${response.statusCode}.`));
          return;
        }
        try {
          const payload = JSON.parse(body || '{}');
          if (payload?.errors) throw new Error('Die Proxmox-API hat die Anfrage abgelehnt.');
          resolve(payload?.data);
        } catch (error) {
          reject(error.message ? error : new Error('Ungültige Antwort der Proxmox-API.'));
        }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('Zeitüberschreitung bei der Proxmox-API.')));
    request.on('error', error => reject(new Error(error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
      ? 'Das Proxmox-Zertifikat wird nicht vertraut. Setze TF_VAR_proxmox_insecure=true oder verwende ein gültiges Zertifikat.'
      : 'Die Proxmox-API ist nicht erreichbar.')));
    if (body) request.write(body);
    request.end();
  });
}

function register({ router, db, broadcast }) {

  // ── DB setup ──────────────────────────────────────────────────────────────
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      env_vars    TEXT NOT NULL DEFAULT '{}',
      environment_id TEXT NOT NULL DEFAULT 'default',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_connections (
      id             TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      name           TEXT NOT NULL,
      endpoint       TEXT NOT NULL,
      api_token      TEXT NOT NULL,
      insecure       INTEGER NOT NULL DEFAULT 0,
      ssh_public_key TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(environment_id, name)
    )
  `).run();
  // Existing Fleet installations get the same default environment as legacy
  // servers. The guards keep this migration safe for fresh and old databases.
  try { db.db.prepare("CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now'))) ").run(); } catch {}
  try { db.db.prepare("INSERT OR IGNORE INTO environments (id, name) VALUES ('default', 'Standardumgebung')").run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_workspaces ADD COLUMN environment_id TEXT DEFAULT 'default'").run(); } catch {}
  // A deployment may consume an environment-level Proxmox source. Keeping the
  // relation on the workspace (instead of copying a token into it) makes one
  // cluster usable by many deployments and keeps credentials in one place.
  try { db.db.prepare('ALTER TABLE tofu_workspaces ADD COLUMN proxmox_connection_id TEXT').run(); } catch {}
  try { db.db.prepare("UPDATE tofu_workspaces SET environment_id = 'default' WHERE environment_id IS NULL OR environment_id = ''").run(); } catch {}

  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_runs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      output       TEXT NOT NULL DEFAULT '',
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `).run();

  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_vms (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      config       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, name)
    )
  `).run();

  // Templates are workspace-local presets. They intentionally live beside the
  // form definitions, rather than in generated HCL, so credentials and a
  // reusable default can be managed without creating a real VM first.
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_vm_templates (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      config       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, name)
    )
  `).run();

  // Successful post-deploy steps are recorded per VM and playbook. This makes
  // a bootstrap idempotent across later `tofu apply` runs, while a failed step
  // remains eligible for a retry on the next apply.
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_playbook_runs (
      workspace_id TEXT NOT NULL,
      vm_id        TEXT NOT NULL,
      playbook     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      output       TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, vm_id, playbook)
    )
  `).run();

  ensureManagedServersTable(db);

  syncPathsFile();

  // ── Register git sync hook so tofu files are included in push/status ─────
  const gs = getGitSync();
  if (gs?.registerSyncHook) {
    gs.registerSyncHook(() => syncAllToGit(getAllWorkspaces()));
  }

  // ── Binary detection (cached) ────────────────────────────────────────────
  let _cachedBinary  = undefined;
  let _cachedVersion = undefined;

  const TOFU_INSTALL_PATH = '/app/server/data/bin/tofu';

  function findBinary() {
    if (_cachedBinary !== undefined) return _cachedBinary;
    if (fs.existsSync(TOFU_INSTALL_PATH)) {
      _cachedBinary = TOFU_INSTALL_PATH;
      return TOFU_INSTALL_PATH;
    }
    for (const bin of ['tofu', 'opentofu', 'terraform']) {
      try { execFileSync('which', [bin], { stdio: 'ignore' }); _cachedBinary = bin; return bin; } catch {}
    }
    _cachedBinary = null; return null;
  }

  function getVersion(bin) {
    if (_cachedVersion !== undefined) return _cachedVersion;
    try {
      const raw = execFileSync(bin, ['version', '-json'], { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(raw);
      _cachedVersion = parsed.terraform_version || parsed.tofu_version || null;
    } catch {
      try { _cachedVersion = execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim(); }
      catch { _cachedVersion = null; }
    }
    return _cachedVersion;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const PATHS_FILE = '/app/server/data/tofu-workspace-paths.txt';
  function syncPathsFile() {
    try {
      const rows = db.db.prepare('SELECT path FROM tofu_workspaces').all();
      fs.writeFileSync(PATHS_FILE, rows.filter(r => isAllowedPath(r.path)).map(r => r.path).join('\n'), 'utf8');
    } catch {}
  }

  // Allowlist prefixes for environment variables passed to OpenTofu/Terraform
  const ALLOWED_ENV_PREFIXES = [
    'TF_VAR_', 'TF_CLI_', 'TF_LOG', 'TF_INPUT', 'TF_IN_AUTOMATION',
    'AWS_', 'ARM_', 'AZURE_', 'GOOGLE_', 'GCLOUD_', 'GCP_', 'CLOUDSDK_',
    'HCLOUD_', 'DO_', 'DIGITALOCEAN_', 'PROXMOX_',
    'VAULT_', 'CONSUL_', 'NOMAD_',
    'ALICLOUD_', 'OCI_', 'IBM_',
    'SCW_', 'LINODE_', 'VULTR_',
    'CLOUDFLARE_', 'GITHUB_TOKEN',
  ];

  const ALLOWED_PATH_ROOTS = String(process.env.OPENTOFU_WORKSPACE_ROOTS || '/workspaces')
    .split(',')
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => path.resolve(root));
  const ALLOWED_PATH_PREFIXES = ALLOWED_PATH_ROOTS.map(root => `${root}${path.sep}`);
  const WORKSPACE_PATH_ERROR = `Path must be under configured OpenTofu workspace roots: ${ALLOWED_PATH_ROOTS.join(', ') || '/workspaces'}`;

  function isAllowedPath(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const resolved = path.resolve(p);
    return ALLOWED_PATH_PREFIXES.some(prefix => resolved.startsWith(prefix));
  }

  const PROVIDER_CONFIGS = {
    aws: {
      providers_tf: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
`,
      extra_variables: `
variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "eu-central-1"
}
`,
    },
    azurerm: {
      providers_tf: `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`,
      extra_variables: '',
    },
    google: {
      providers_tf: `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}
`,
      extra_variables: `
variable "gcp_project" {
  type        = string
  description = "GCP project ID"
}

variable "gcp_region" {
  type        = string
  description = "GCP region"
  default     = "europe-west3"
}
`,
    },
    hcloud: {
      providers_tf: `terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
`,
      extra_variables: `
variable "hcloud_token" {
  type        = string
  description = "Hetzner Cloud API token"
  sensitive   = true
}
`,
    },
    digitalocean: {
      providers_tf: `terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}
`,
      extra_variables: `
variable "do_token" {
  type        = string
  description = "DigitalOcean API token"
  sensitive   = true
}
`,
    },
    kubernetes: {
      providers_tf: `terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}
`,
      extra_variables: '',
    },
    proxmox: {
      providers_tf: `terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  insecure  = var.proxmox_insecure
}
`,
      extra_variables: `
variable "proxmox_endpoint" {
  type        = string
  description = "Proxmox API endpoint, e.g. https://pve.example.com:8006/"
}

variable "proxmox_api_token" {
  type        = string
  description = "Proxmox API token, e.g. root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  sensitive   = true
}

variable "proxmox_insecure" {
  type        = bool
  description = "Skip TLS verification (self-signed certificates)"
  default     = false
}
`,
    },
  };

  function scaffoldWorkspace(wsPath, provider) {
    fs.mkdirSync(wsPath, { recursive: true });

    const providerCfg = PROVIDER_CONFIGS[provider];

    const mainTf = `# ${provider ? `${provider.toUpperCase()} ` : ''}Infrastructure
# Managed by Shipyard / OpenTofu

# Add your resources here
`;

    const variablesTf = `# Input variables
${providerCfg?.extra_variables || ''}`;

    const outputsTf = `# Outputs
# output "example" {
#   value       = resource.type.name.attribute
#   description = "An example output"
# }
`;

    const gitignore = `# Secret variable files — never commit these
*.tfvars
*.tfvars.json
*.auto.tfvars

# OpenTofu / Terraform state and cache
.terraform/
.terraform.lock.hcl
*.tfstate
*.tfstate.backup
*.tfstate.*.backup
crash.log
override.tf
override.tf.json
`;

    fs.writeFileSync(path.join(wsPath, '.gitignore'), gitignore);
    fs.writeFileSync(path.join(wsPath, 'main.tf'), mainTf);
    fs.writeFileSync(path.join(wsPath, 'variables.tf'), variablesTf);
    fs.writeFileSync(path.join(wsPath, 'outputs.tf'), outputsTf);

    if (providerCfg) {
      fs.writeFileSync(path.join(wsPath, 'providers.tf'), providerCfg.providers_tf);
    }
  }

  function sanitizeEnvVars(vars) {
    if (!vars || typeof vars !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'string') continue;
      const upper = k.toUpperCase();
      if (ALLOWED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix) || upper === prefix.replace(/_$/, ''))) {
        clean[k] = v;
      }
    }
    return clean;
  }

  function getWorkspaceRow(id) {
    const row = db.db.prepare('SELECT * FROM tofu_workspaces WHERE id = ?').get(id);
    return row || null;
  }

  function getWorkspace(id) {
    const row = getWorkspaceRow(id);
    if (!row) return null;
    if (!isAllowedPath(row.path)) return null;
    let envVars = {};
    try { envVars = JSON.parse(row.env_vars || '{}'); } catch {}
    const workspace = { ...row, env_vars: sanitizeEnvVars(envVars) };
    if (!workspace.proxmox_connection_id) return workspace;
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?')
      .get(workspace.proxmox_connection_id, workspace.environment_id || 'default');
    if (!source) return workspace;
    try {
      const connection = readSavedProxmoxConnection(source);
      const sshPublicKey = cryptoUtil.decrypt(String(source.ssh_public_key || ''));
      return {
        ...workspace,
        proxmox_connection: publicProxmoxConnection(source),
        env_vars: {
          ...workspace.env_vars,
          TF_VAR_proxmox_endpoint: connection.base.toString(),
          TF_VAR_proxmox_api_token: connection.apiToken,
          TF_VAR_proxmox_insecure: connection.insecure ? 'true' : 'false',
          ...(sshPublicKey && !String(sshPublicKey).startsWith('enc:') ? { TF_VAR_ssh_public_key: sshPublicKey } : {}),
        },
      };
    } catch (error) {
      log.warn({ err: error, workspace: workspace.name }, 'Could not resolve Proxmox connection source');
      return workspace;
    }
  }

  function getProxmoxVms(workspaceId) {
    return db.db.prepare('SELECT * FROM tofu_proxmox_vms WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(workspaceId)
      .map(row => {
        try {
          // Older form entries accepted a bare static address. Normalizing on
          // read repairs those definitions when the generated files are next
          // written, without requiring users to recreate their VM.
          return { ...normalizeProxmoxVm(JSON.parse(row.config)), id: row.id, created_at: row.created_at, updated_at: row.updated_at };
        }
        catch { return null; }
      })
      .filter(Boolean);
  }

  function getProxmoxVmTemplates(workspaceId) {
    return db.db.prepare('SELECT * FROM tofu_proxmox_vm_templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(workspaceId)
      .map(row => {
        try {
          return {
            id: row.id,
            name: row.name,
            config: normalizeProxmoxVm(JSON.parse(row.config)),
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  function validatePostDeployPlaybookAccess(playbooks, req) {
    if (!playbooks.length) return;
    const permissions = getPermissions(req.user);
    if (!can(permissions, 'canRunPlaybooks')) {
      throw new Error('Deine Rolle darf keine Playbooks ausführen.');
    }
    const available = new Set(ansibleRunner.getAvailablePlaybooks().map(playbook => playbook.filename));
    for (const playbook of playbooks) {
      if (!available.has(playbook)) throw new Error(`Playbook nicht gefunden: ${playbook}`);
      if (!canAccessPlaybook(permissions, playbook)) throw new Error(`Playbook nicht erlaubt: ${playbook}`);
    }
  }

  function pendingPostDeployJobs(workspace, syncedServers, { onlyVmId = null, onlyPlaybook = null, force = false } = {}) {
    const syncedByResource = new Map((Array.isArray(syncedServers) ? syncedServers : [])
      .map(server => [server.resource_key, server])
      .filter(([resourceKey]) => Boolean(resourceKey)));
    const completed = new Set(db.db.prepare(`
      SELECT vm_id, playbook FROM tofu_proxmox_playbook_runs
      WHERE workspace_id = ? AND status = 'success'
    `).all(workspace.id).map(row => `${row.vm_id}\u0000${row.playbook}`));

    return getProxmoxVms(workspace.id).flatMap(vm => {
      if (onlyVmId && vm.id !== onlyVmId) return [];
      const server = syncedByResource.get(`resource:proxmox_virtual_environment_vm.${vm.name}`);
      if (!server || !Array.isArray(vm.post_deploy_playbooks)) return [];
      return vm.post_deploy_playbooks
        .filter(playbook => (!onlyPlaybook || playbook === onlyPlaybook) && (force || !completed.has(`${vm.id}\u0000${playbook}`)))
        .map(playbook => ({ vm, server, playbook }));
    });
  }

  async function runPostDeployPlaybooks({ workspace, syncedServers, logMeta, emitMeta, onlyVmId = null, onlyPlaybook = null, force = false }) {
    const jobs = pendingPostDeployJobs(workspace, syncedServers, { onlyVmId, onlyPlaybook, force });
    if (!jobs.length) return { started: 0, succeeded: 0, failed: 0 };

    // Ensure that the selected Fleet playbooks reflect the configured Git
    // source immediately before provisioning starts.
    await getGitSync()?.autoPull?.();
    const available = new Set(ansibleRunner.getAvailablePlaybooks().map(playbook => playbook.filename));
    const mappingByResource = new Map(db.db.prepare(
      'SELECT resource_key, server_id FROM tofu_managed_servers WHERE workspace_id = ?'
    ).all(workspace.id).map(row => [row.resource_key, row.server_id]));
    const serverById = new Map(db.servers.getAll().map(server => [server.id, server]));
    const saveResult = db.db.prepare(`
      INSERT INTO tofu_proxmox_playbook_runs (workspace_id, vm_id, playbook, status, output, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'success' THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT(workspace_id, vm_id, playbook) DO UPDATE SET
        status = excluded.status, output = excluded.output,
        completed_at = excluded.completed_at, updated_at = datetime('now')
    `);
    const result = { started: 0, succeeded: 0, failed: 0 };

    for (const job of jobs) {
      const target = serverById.get(mappingByResource.get(job.server.resource_key));
      if (!target) {
        const output = `[Fleet] Zielserver für Post-Deploy-Playbook "${job.playbook}" ist noch nicht verfügbar.`;
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        emitMeta(`${output}\n`);
        result.failed++;
        continue;
      }
      result.started++;
      const historyId = db.updateHistory.create(target.id, `ansible:${job.playbook}`, logMeta.user || null);
      const scheduleHistoryId = db.scheduleHistory.create(null, `OpenTofu ${workspace.name}`, job.playbook, target.name);
      if (!available.has(job.playbook)) {
        const output = `[Fleet] Playbook nicht gefunden: ${job.playbook}`;
        db.updateHistory.updateStatus(historyId, 'failed', output);
        db.scheduleHistory.complete(scheduleHistoryId, 'failed', output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        emitMeta(`${output}\n`);
        result.failed++;
        continue;
      }

      emitMeta(`[Fleet] Starte Post-Deploy-Playbook "${job.playbook}" auf ${target.name}.\n`);
      try {
        const run = await ansibleRunner.runPlaybook(job.playbook, target.name, {
          fleet_workspace: workspace.name,
          fleet_vm: job.vm.name,
        }, (stream, data) => emitMeta(`[${job.playbook}/${stream}] ${data}`));
        const output = `${run.stdout || ''}${run.stderr || ''}`;
        const status = run.success ? 'success' : 'failed';
        db.updateHistory.updateStatus(historyId, status, output);
        db.scheduleHistory.complete(scheduleHistoryId, status, output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, status, output, status);
        db.auditLog.write('tofu.post_deploy_playbook', `workspace=${workspace.name} vm=${job.vm.name} playbook=${job.playbook} status=${status}`, logMeta.ip || null, run.success, logMeta.user || null);
        if (run.success) {
          result.succeeded++;
          emitMeta(`[Fleet] Post-Deploy-Playbook "${job.playbook}" erfolgreich abgeschlossen.\n`);
        } else {
          result.failed++;
          emitMeta(`[Fleet] Post-Deploy-Playbook "${job.playbook}" ist fehlgeschlagen und wird bei einem späteren Apply erneut versucht.\n`);
        }
      } catch (error) {
        const output = error.message || String(error);
        db.updateHistory.updateStatus(historyId, 'failed', output);
        db.scheduleHistory.complete(scheduleHistoryId, 'failed', output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        db.auditLog.write('tofu.post_deploy_playbook', `workspace=${workspace.name} vm=${job.vm.name} playbook=${job.playbook} error=${output}`, logMeta.ip || null, false, logMeta.user || null);
        result.failed++;
        emitMeta(`[Fleet] Post-Deploy-Playbook "${job.playbook}" konnte nicht gestartet werden: ${output}\n`);
      }
    }
    return result;
  }

  function getPostDeployOverview(workspaceId) {
    const statusByKey = new Map(db.db.prepare(`
      SELECT vm_id, playbook, status, output, completed_at, updated_at
      FROM tofu_proxmox_playbook_runs WHERE workspace_id = ?
    `).all(workspaceId).map(row => [`${row.vm_id}\u0000${row.playbook}`, row]));
    const entries = getProxmoxVms(workspaceId).flatMap(vm => (vm.post_deploy_playbooks || []).map((playbook, position) => {
      const current = statusByKey.get(`${vm.id}\u0000${playbook}`);
      return {
        vm_id: vm.id,
        vm_name: vm.name,
        playbook,
        position: position + 1,
        status: current?.status || 'pending',
        output: current?.output || '',
        completed_at: current?.completed_at || null,
        updated_at: current?.updated_at || null,
      };
    }));
    const counts = entries.reduce((result, entry) => {
      result[entry.status] = (result[entry.status] || 0) + 1;
      return result;
    }, { pending: 0, running: 0, success: 0, failed: 0 });
    return { entries, counts };
  }

  function writeFleetProxmoxFiles(workspace) {
    const vms = getProxmoxVms(workspace.id);
    const files = buildProxmoxProviderFiles(vms);
    fs.mkdirSync(workspace.path, { recursive: true });
    const handWrittenTerraform = readTerraformFiles(workspace.path)
      .filter(file => !file.name.startsWith('fleet-proxmox-'))
      .map(file => file.content)
      .join('\n');
    const hasProvider = /provider\s+"proxmox"\s*\{/.test(handWrittenTerraform);
    const hasVariable = name => new RegExp(`variable\\s+"${escapeRegExp(name)}"\\s*\\{`).test(handWrittenTerraform);
    const missingVariables = [
      ['proxmox_endpoint', 'type = string'],
      ['proxmox_api_token', 'type = string\n  sensitive = true'],
      ['proxmox_insecure', 'type = bool\n  default = false'],
      ...[...new Set(vms.map(vm => vm.ssh_public_key_variable).filter(Boolean))].map(name => [name, 'type = string\n  sensitive = true']),
    ].filter(([name]) => !hasVariable(name));
    const providerPath = path.join(workspace.path, 'fleet-proxmox-provider.tf');
    const variablesPath = path.join(workspace.path, 'fleet-proxmox-variables.tf');
    const vmPath = path.join(workspace.path, 'fleet-proxmox-vms.tf');
    fs.writeFileSync(providerPath, hasProvider
      ? '# Fleet uses the existing Proxmox provider configuration in this workspace.\n'
      : files.provider, 'utf8');
    fs.writeFileSync(variablesPath, missingVariables.length
      ? `# Generated by Fleet. Secret values are never written to this file.\n${missingVariables.map(([name, body]) => `\nvariable "${name}" {\n  ${body.replace(/\n/g, '\n  ')}\n}\n`).join('')}`
      : '# This workspace already declares the variables required by Fleet Proxmox VMs.\n', 'utf8');
    fs.writeFileSync(vmPath, files.vms, 'utf8');
    return { files: ['fleet-proxmox-provider.tf', 'fleet-proxmox-variables.tf', 'fleet-proxmox-vms.tf'], vms };
  }

  function syncFleetWorkspace(workspace, message) {
    const gs = getGitSync();
    if (gs?.isConfigured()) {
      syncOneToGit(workspace.name, workspace.path);
      gs.autoPush(message).catch(error => log.warn({ err: error, workspace: workspace.name }, 'Could not auto-push Proxmox workspace'));
    }
  }

  async function loadProxmoxCatalog(workspace, requestedNode = '') {
    const connection = readProxmoxConnection(workspace.env_vars);
    const nodesResponse = await requestProxmoxApi(connection, '/nodes');
    const nodes = (Array.isArray(nodesResponse) ? nodesResponse : [])
      .map(node => ({
        name: String(node?.node || '').trim(),
        status: String(node?.status || '').trim(),
        online: String(node?.status || '').toLowerCase() === 'online',
      }))
      .filter(node => node.name && PROXMOX_IDENTIFIER_RE.test(node.name));
    if (!nodes.length) throw new Error('In Proxmox wurden keine Nodes gefunden.');

    const wantedNode = String(requestedNode || '').trim();
    const nodeName = nodes.some(node => node.name === wantedNode)
      ? wantedNode
      : (nodes.find(node => node.online) || nodes[0]).name;
    const safeNode = encodeURIComponent(nodeName);
    const [nextIdResponse, templatesResponse, storageResponse, networkResponse] = await Promise.all([
      requestProxmoxApi(connection, '/cluster/nextid'),
      requestProxmoxApi(connection, `/nodes/${safeNode}/qemu?full=1`),
      requestProxmoxApi(connection, `/nodes/${safeNode}/storage`),
      requestProxmoxApi(connection, `/nodes/${safeNode}/network`),
    ]);
    const nextVmId = Number.parseInt(String(nextIdResponse?.vmid ?? nextIdResponse ?? ''), 10);
    const templates = (Array.isArray(templatesResponse) ? templatesResponse : [])
      .filter(item => item && (item.template === 1 || item.template === '1' || item.template === true))
      .map(item => ({ vm_id: Number(item.vmid), name: String(item.name || `VM ${item.vmid}`), node_name: nodeName }))
      .filter(item => Number.isInteger(item.vm_id) && item.vm_id > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const datastores = (Array.isArray(storageResponse) ? storageResponse : [])
      .filter(item => item && item.storage && item.active !== 0 && item.active !== '0')
      .map(item => ({
        id: String(item.storage),
        content: Array.isArray(item.content) ? item.content : String(item.content || '').split(',').filter(Boolean),
      }))
      .filter(item => item.content.length === 0 || item.content.includes('images'))
      .sort((a, b) => a.id.localeCompare(b.id, 'de'));
    const bridges = (Array.isArray(networkResponse) ? networkResponse : [])
      .filter(item => item && item.iface && (item.type === 'bridge' || String(item.iface).startsWith('vmbr')))
      .map(item => ({ name: String(item.iface), active: item.active === 1 || item.active === '1' || item.active === true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));

    return {
      nodes,
      node: nodeName,
      next_vm_id: Number.isInteger(nextVmId) && nextVmId > 0 ? nextVmId : null,
      templates,
      datastores,
      bridges,
    };
  }

  async function resolveFleetProxmoxServers({ workspace, state, servers }) {
    const vms = getProxmoxVms(workspace.id);
    const matchingVms = vms.filter(vm =>
      Array.isArray(servers) && servers.some(server =>
        server.resource_key === `resource:proxmox_virtual_environment_vm.${vm.name}`
      )
    );
    if (!matchingVms.length) return { servers, pending: false };

    let connection;
    try {
      connection = readProxmoxConnection(workspace.env_vars);
    } catch (error) {
      // OpenTofu state remains a useful fallback for old workspaces that do
      // not have API credentials configured in the Fleet form yet.
      log.warn({ err: error, workspace: workspace.name }, 'Could not enrich Fleet Proxmox server details');
      return { ...applyFleetProxmoxBlueprintMetadata({ servers, state, vms }), pending: false };
    }

    const resourceByKey = new Map(
      getProxmoxStateResources(state)
        .map(resource => [normalizeResourceKey(resource), resource])
        .filter(([key]) => key)
    );
    const guestIps = new Map();
    const settled = await Promise.allSettled(matchingVms.map(async vm => {
      const resourceKey = `resource:proxmox_virtual_environment_vm.${vm.name}`;
      const resource = resourceByKey.get(resourceKey);
      const vmId = Number.parseInt(String(resource?.values?.vm_id ?? vm.vm_id ?? ''), 10);
      const nodeName = String(resource?.values?.node_name || vm.node_name || '').trim();
      if (!Number.isInteger(vmId) || vmId <= 0 || !nodeName) return { resourceKey, queried: false };
      const data = await requestProxmoxApi(
        connection,
        `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmId}/agent/network-get-interfaces`
      );
      const ip = extractProxmoxGuestIpv4(data);
      if (ip) guestIps.set(resourceKey, ip);
      return { resourceKey, queried: true };
    }));
    const queriedKeys = new Set(settled
      .filter(result => result.status === 'fulfilled' && result.value.queried)
      .map(result => result.value.resourceKey));
    const failed = settled.filter(result => result.status === 'rejected');
    if (failed.length) {
      log.warn({ workspace: workspace.name, count: failed.length }, 'Could not read one or more Proxmox guest IP addresses');
    }

    const enriched = applyFleetProxmoxBlueprintMetadata({ servers, state, vms, guestIps });
    return {
      servers: enriched.servers,
      // Only wait if the guest agent has responded successfully. If the agent
      // is missing/unreachable, keep the state value and never delay apply.
      pending: enriched.pendingDhcpResourceKeys.some(key => queriedKeys.has(key)),
    };
  }

  function getWorkspaceRows(environmentId = null) {
    const rows = environmentId
      ? db.db.prepare('SELECT * FROM tofu_workspaces WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
      : db.db.prepare('SELECT * FROM tofu_workspaces ORDER BY name COLLATE NOCASE').all();
    return rows.filter(workspace => isAllowedPath(workspace.path));
  }

  function getAllWorkspaces(environmentId = null) {
    return getWorkspaceRows(environmentId).map(workspace => ({ id: workspace.id, name: workspace.name, path: workspace.path }));
  }

  function listProxmoxConnectionRows(environmentId = null) {
    return environmentId
      ? db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
      : db.db.prepare('SELECT * FROM tofu_proxmox_connections ORDER BY name COLLATE NOCASE').all();
  }

  function publicProxmoxConnection(row) {
    return {
      id: row.id,
      environment_id: row.environment_id,
      name: row.name,
      endpoint: row.endpoint,
      insecure: Boolean(row.insecure),
      api_token_configured: Boolean(row.api_token),
      ssh_public_key_configured: Boolean(row.ssh_public_key),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function readSavedProxmoxConnection(row) {
    const token = cryptoUtil.decrypt(String(row?.api_token || ''));
    if (!token || String(token).startsWith('enc:')) throw new Error(`Die Zugangsdaten für Proxmox-Verbindung „${row?.name || 'unbekannt'}“ können nicht gelesen werden.`);
    return createProxmoxConnection(row.endpoint, token, Boolean(row.insecure));
  }

  // Build a read-only inventory from environment connections first, then use
  // legacy deployment credentials as a compatibility fallback. This keeps
  // infrastructure independent from individual OpenTofu workspaces.
  async function loadProxmoxInfrastructure(environmentId = null) {
    const grouped = new Map();
    const warnings = [];
    for (const row of listProxmoxConnectionRows(environmentId)) {
      try {
        const connection = readSavedProxmoxConnection(row);
        const key = `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}`;
        const group = grouped.get(key) || { key, connection, workspaces: [], connections: [] };
        group.connections.push({ id: row.id, name: row.name });
        grouped.set(key, group);
      } catch (error) {
        warnings.push(error.message || 'Eine Proxmox-Verbindung ist unvollständig.');
      }
    }
    for (const row of getAllWorkspaces(environmentId)) {
      const workspace = getWorkspace(row.id);
      if (!workspace) continue;
      try {
        const connection = readProxmoxConnection(workspace.env_vars);
        const key = `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}`;
        const group = grouped.get(key) || { key, connection, workspaces: [], connections: [] };
        group.workspaces.push({ id: workspace.id, name: workspace.name });
        grouped.set(key, group);
      } catch {
        // A regular OpenTofu workspace does not need to be a Proxmox source.
      }
    }

    const settled = await Promise.allSettled([...grouped.values()].map(async group => {
      const [nodesResponse, resourcesResponse] = await Promise.all([
        requestProxmoxApi(group.connection, '/nodes'),
        requestProxmoxApi(group.connection, '/cluster/resources?type=vm'),
      ]);
      const nodes = (Array.isArray(nodesResponse) ? nodesResponse : [])
        .map(node => ({
          name: String(node?.node || '').trim(),
          status: String(node?.status || '').toLowerCase() || 'unknown',
          cpu: Number(node?.cpu) || 0,
          maxcpu: Number(node?.maxcpu) || 0,
          mem: Number(node?.mem) || 0,
          maxmem: Number(node?.maxmem) || 0,
          disk: Number(node?.disk) || 0,
          maxdisk: Number(node?.maxdisk) || 0,
          uptime: Number(node?.uptime) || 0,
        }))
        .filter(node => node.name && PROXMOX_IDENTIFIER_RE.test(node.name));
      const vms = (Array.isArray(resourcesResponse) ? resourcesResponse : [])
        .filter(resource => String(resource?.type || '').toLowerCase() === 'qemu')
        .map(resource => ({
          name: String(resource?.name || `VM ${resource?.vmid || '?'}`),
          node_name: String(resource?.node || '').trim(),
          vm_id: Number(resource?.vmid) || null,
          status: String(resource?.status || '').toLowerCase() || 'unknown',
          cpu: Number(resource?.cpu) || 0,
          maxcpu: Number(resource?.maxcpu) || 0,
          mem: Number(resource?.mem) || 0,
          maxmem: Number(resource?.maxmem) || 0,
        }))
        .filter(vm => vm.node_name && Number.isInteger(vm.vm_id));
      return {
        id: group.key,
        endpoint: group.connection.base.host,
        status: nodes.some(node => node.status === 'online') ? 'online' : 'offline',
        connections: group.connections,
        deployments: group.workspaces,
        nodes,
        vms,
      };
    }));

    const clusters = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') clusters.push(result.value);
      else warnings.push(result.reason?.message || 'Eine Proxmox-Verbindung konnte nicht abgefragt werden.');
    }
    return { clusters, warnings };
  }

  function ensureWorkspacePath(workspace) {
    if (fs.existsSync(workspace.path)) return null;
    try { fs.mkdirSync(workspace.path, { recursive: true }); return null; }
    catch (e) { return e; }
  }

  function isDirectoryEmpty(dirPath) {
    try {
      return fs.readdirSync(dirPath).length === 0;
    } catch {
      return false;
    }
  }

  function moveWorkspaceDirectory(fromPath, toPath) {
    const source = path.resolve(fromPath);
    const target = path.resolve(toPath);
    if (source === target) return false;
    if (!fs.existsSync(source)) return false;

    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (fs.existsSync(target)) {
      const stats = fs.statSync(target);
      if (!stats.isDirectory()) {
        throw new Error(`Target path exists and is not a directory: ${target}`);
      }
      if (!isDirectoryEmpty(target)) {
        throw new Error(`Target path already exists and is not empty: ${target}`);
      }
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(source, { recursive: true, force: true });
      return true;
    }

    try {
      fs.renameSync(source, target);
      return true;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(source, { recursive: true, force: true });
      return true;
    }
  }

  function permissionError(e, wsPath) {
    return e.code === 'EACCES'
      ? `Permission denied. Fix with: chown -R 1001:1001 ${wsPath}`
      : e.message;
  }

  function safePath(wsPath, relPath) {
    const resolved = path.resolve(wsPath, relPath);
    if (!resolved.startsWith(path.resolve(wsPath) + path.sep) &&
        resolved !== path.resolve(wsPath)) return null;
    return resolved;
  }

  function walkDir(dir, rel, depth) {
    if (depth > 5) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const result = [];
    for (const e of entries) {
      if (e.name === '.terraform' || e.name === '.git') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        result.push({ type: 'dir', name: e.name, path: childRel,
          children: walkDir(path.join(dir, e.name), childRel, depth + 1) });
      } else {
        result.push({ type: 'file', name: e.name, path: childRel });
      }
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function getLastRun(workspaceId) {
    return db.db.prepare(
      'SELECT * FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(workspaceId) || null;
  }

  // ── Routes: Status & Workspaces ───────────────────────────────────────────

  router.get('/status', (req, res) => {
    const binary = findBinary();
    res.json({ installed: !!binary, binary, version: binary ? getVersion(binary) : null });
  });

  router.get('/workspaces', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    if (environmentId && !db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const rows = getWorkspaceRows(environmentId || null);
    const withStatus = rows.map(r => {
      const lastRun = getLastRun(r.id);
      return {
        ...r,
        env_vars: sanitizeEnvVars(JSON.parse(r.env_vars || '{}')),
        last_run: lastRun,
      };
    });
    res.json(withStatus);
  });

  // Environment-level Proxmox sources. They are deliberately independent of
  // a workspace so a cluster can be shown even when no OpenTofu deployment is
  // attached to it yet.
  router.get('/proxmox-connections', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    if (environmentId && !db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    res.json(listProxmoxConnectionRows(environmentId || null).map(publicProxmoxConnection));
  });

  router.post('/proxmox-connections', (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Permission denied' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const environmentId = String(body.environment_id || 'default').trim() || 'default';
    const name = String(body.name || '').trim().slice(0, 80);
    const endpoint = String(body.endpoint || '').trim();
    const token = String(body.api_token || '').trim();
    const sshPublicKey = String(body.ssh_public_key || '').trim();
    if (!name) return res.status(400).json({ error: 'Connection name is required' });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    try { createProxmoxConnection(endpoint, token, body.insecure === true); } catch (error) { return res.status(400).json({ error: error.message }); }
    const id = randomUUID();
    try {
      db.db.prepare('INSERT INTO tofu_proxmox_connections (id, environment_id, name, endpoint, api_token, insecure, ssh_public_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, environmentId, name, endpoint, cryptoUtil.encrypt(token), body.insecure === true ? 1 : 0, sshPublicKey ? cryptoUtil.encrypt(sshPublicKey) : '');
      res.status(201).json(publicProxmoxConnection(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(id)));
    } catch (error) { res.status(409).json({ error: error.message || 'Connection already exists' }); }
  });

  router.put('/proxmox-connections/:id', (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Permission denied' });
    const existing = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Connection not found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name === undefined ? existing.name : String(body.name || '').trim().slice(0, 80);
    const endpoint = body.endpoint === undefined ? existing.endpoint : String(body.endpoint || '').trim();
    const token = typeof body.api_token === 'string' && body.api_token.trim() ? body.api_token.trim() : null;
    const insecure = body.insecure === undefined ? Boolean(existing.insecure) : body.insecure === true;
    if (!name) return res.status(400).json({ error: 'Connection name is required' });
    try { createProxmoxConnection(endpoint, token || readSavedProxmoxConnection(existing).apiToken, insecure); } catch (error) { return res.status(400).json({ error: error.message }); }
    const sshKey = typeof body.ssh_public_key === 'string' && body.ssh_public_key.trim() ? cryptoUtil.encrypt(body.ssh_public_key.trim()) : existing.ssh_public_key;
    db.db.prepare("UPDATE tofu_proxmox_connections SET name = ?, endpoint = ?, api_token = ?, insecure = ?, ssh_public_key = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, endpoint, token ? cryptoUtil.encrypt(token) : existing.api_token, insecure ? 1 : 0, sshKey, existing.id);
    res.json(publicProxmoxConnection(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(existing.id)));
  });

  router.delete('/proxmox-connections/:id', (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Permission denied' });
    const inUse = db.db.prepare('SELECT COUNT(*) AS count FROM tofu_workspaces WHERE proxmox_connection_id = ?').get(req.params.id);
    if (Number(inUse?.count || 0) > 0) return res.status(409).json({ error: `Diese Plattform-Verbindung wird noch von ${inUse.count} Deployment(s) verwendet. Ordne sie zuerst um oder löse die Verknüpfung.` });
    const result = db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Connection not found' });
    res.json({ success: true });
  });

  router.post('/workspaces', (req, res) => {
    const { name, path: wPath, description, env_vars, scaffold } = req.body;
    const environmentId = String(req.body?.environment_id || 'default').trim() || 'default';
    const proxmoxConnectionId = String(req.body?.proxmox_connection_id || '').trim() || null;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: WORKSPACE_PATH_ERROR });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    if (proxmoxConnectionId && !db.db.prepare('SELECT 1 FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?').get(proxmoxConnectionId, environmentId)) {
      return res.status(400).json({ error: 'Die gewählte Proxmox-Verbindung gehört nicht zu dieser Umgebung.' });
    }
    const id = randomUUID();
    db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, description, env_vars, environment_id, proxmox_connection_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(sanitizeEnvVars(env_vars || {})), environmentId, proxmoxConnectionId);
    syncPathsFile();
    if (scaffold) {
      try { scaffoldWorkspace(wPath.trim(), scaffold.provider || null); } catch (e) { /* path not mounted yet — files can be created later */ }
    }
    res.json({ success: true, id });
  });

  router.put('/workspaces/:id', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: WORKSPACE_PATH_ERROR });
    const existing = getWorkspaceRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workspace not found' });
    const nextPath = wPath.trim();
    const shouldMoveFiles = req.body.move_files !== false;
    const pathChanged = path.resolve(existing.path) !== path.resolve(nextPath);

    if (pathChanged && shouldMoveFiles && isAllowedPath(existing.path)) {
      try {
        moveWorkspaceDirectory(existing.path, nextPath);
      } catch (e) {
        return res.status(400).json({ error: permissionError(e, existing.path), code: e.code });
      }
    }

    const result = db.db.prepare('UPDATE tofu_workspaces SET name=?, path=?, description=?, env_vars=? WHERE id=?')
      .run(name.trim(), nextPath, (description || '').trim(), JSON.stringify(env_vars || {}), req.params.id);
    syncPathsFile();
    res.json({ success: true });
  });

  // The console can safely update display metadata without receiving or
  // round-tripping workspace environment variables (which may contain secrets).
  router.patch('/workspaces/:id/metadata', (req, res) => {
    const existing = getWorkspaceRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workspace not found' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 120) return res.status(400).json({ error: 'name must be at most 120 characters' });
    if (description.length > 1_000) return res.status(400).json({ error: 'description must be at most 1000 characters' });
    db.db.prepare('UPDATE tofu_workspaces SET name=?, description=? WHERE id=?').run(name, description, req.params.id);
    res.json({ success: true });
  });

  router.delete('/workspaces/:id', (req, res) => {
    db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(req.params.id);
    db.db.prepare('DELETE FROM tofu_runs WHERE workspace_id = ?').run(req.params.id);
    syncPathsFile();
    res.json({ success: true });
  });

  // Keep connection management in the native Fleet console without ever
  // returning secrets to the browser. Empty secret fields on update preserve
  // their stored value, which makes the form safe to reopen and save.
  router.get('/workspaces/:id/proxmox-connection', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const env = workspace.env_vars || {};
    res.json({
      source: workspace.proxmox_connection || null,
      source_id: workspace.proxmox_connection_id || null,
      endpoint: String(env.TF_VAR_proxmox_endpoint || ''),
      insecure: String(env.TF_VAR_proxmox_insecure || '').toLowerCase() === 'true',
      api_token_configured: Boolean(String(env.TF_VAR_proxmox_api_token || '').trim()),
      ssh_public_key_configured: Boolean(String(env.TF_VAR_ssh_public_key || '').trim()),
    });
  });

  router.put('/workspaces/:id/proxmox-connection', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const body = req.body || {};
    const sourceId = String(body.proxmox_connection_id || '').trim() || null;
    if (sourceId) {
      const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?').get(sourceId, workspace.environment_id || 'default');
      if (!source) return res.status(400).json({ error: 'Die gewählte Proxmox-Verbindung gehört nicht zu dieser Umgebung.' });
      db.db.prepare('UPDATE tofu_workspaces SET proxmox_connection_id = ? WHERE id = ?').run(sourceId, workspace.id);
      return res.json({ success: true, source: publicProxmoxConnection(source), source_id: source.id, endpoint: source.endpoint, insecure: Boolean(source.insecure), api_token_configured: true, ssh_public_key_configured: Boolean(source.ssh_public_key) });
    }
    // An explicit detachment returns the deployment to its legacy, local
    // connection fields without deleting its manually configured variables.
    if (body.detach_source === true) db.db.prepare('UPDATE tofu_workspaces SET proxmox_connection_id = NULL WHERE id = ?').run(workspace.id);
    const endpoint = String(body.endpoint || '').trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) return res.status(400).json({ error: 'Der Proxmox-Endpunkt muss mit http:// oder https:// beginnen.' });
    const env = { ...(workspace.env_vars || {}) };
    if (endpoint) env.TF_VAR_proxmox_endpoint = endpoint;
    else if (body.clear_endpoint === true) delete env.TF_VAR_proxmox_endpoint;
    env.TF_VAR_proxmox_insecure = body.insecure === true ? 'true' : 'false';
    if (typeof body.api_token === 'string' && body.api_token.trim()) env.TF_VAR_proxmox_api_token = body.api_token.trim();
    else if (body.clear_api_token === true) delete env.TF_VAR_proxmox_api_token;
    if (typeof body.ssh_public_key === 'string' && body.ssh_public_key.trim()) env.TF_VAR_ssh_public_key = body.ssh_public_key.trim();
    else if (body.clear_ssh_public_key === true) delete env.TF_VAR_ssh_public_key;
    db.db.prepare('UPDATE tofu_workspaces SET env_vars = ? WHERE id = ?').run(JSON.stringify(sanitizeEnvVars(env)), workspace.id);
    res.json({
      success: true,
      endpoint: String(env.TF_VAR_proxmox_endpoint || ''),
      insecure: env.TF_VAR_proxmox_insecure === 'true',
      api_token_configured: Boolean(String(env.TF_VAR_proxmox_api_token || '').trim()),
      ssh_public_key_configured: Boolean(String(env.TF_VAR_ssh_public_key || '').trim()),
    });
  });

  // ── Routes: Run history ───────────────────────────────────────────────────

  router.get('/workspaces/:id/runs', (req, res) => {
    const pageSize = Math.min(TOFU_RUN_PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.page_size) || parseInt(req.query.limit) || TOFU_RUN_PAGE_SIZE_DEFAULT));
    const requestedPage = Math.max(1, parseInt(req.query.page) || 1);
    const total = db.db.prepare('SELECT COUNT(*) AS c FROM tofu_runs WHERE workspace_id = ?').get(req.params.id).c || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const runs = db.db.prepare(
      'SELECT id, workspace_id, action, status, started_at, completed_at FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).all(req.params.id, pageSize, offset);
    res.json({
      items: runs,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: totalPages,
        has_prev: page > 1,
        has_next: page < totalPages,
      },
    });
  });

  router.get('/workspaces/:id/runs/:runId', (req, res) => {
    const run = db.db.prepare('SELECT * FROM tofu_runs WHERE id = ? AND workspace_id = ?')
      .get(req.params.runId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  // ── Routes: Execute ───────────────────────────────────────────────────────

  router.post('/workspaces/:id/run', (req, res) => {
    const VALID_ACTIONS = ['init', 'validate', 'plan', 'apply', 'destroy'];
    const { action, confirm_destroy: destroyConfirmation } = req.body || {};
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    if (action === 'destroy' && !hasValidDestroyConfirmation(destroyConfirmation, workspace.name)) {
      return res.status(400).json({
        error: `Destroy muss mit "${destroyConfirmationPhrase(workspace.name)}" bestätigt werden.`,
      });
    }

    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'OpenTofu/Terraform binary not found in PATH' });

    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });

    // Always rebuild Fleet-managed VM files immediately before a run. Besides
    // keeping the HCL in sync with the form, this migrates older static IP
    // entries such as 10.10.1.111 to Proxmox-valid 10.10.1.111/24.
    try {
      if (getProxmoxVms(workspace.id).length > 0) writeFleetProxmoxFiles(workspace);
    } catch (error) {
      return res.status(400).json({ error: `Fleet-Proxmox-Dateien konnten nicht erzeugt werden: ${permissionError(error, workspace.path)}` });
    }

    const runId  = randomUUID();
    const dbRunId = randomUUID();

    // Save run to DB
    db.db.prepare('INSERT INTO tofu_runs (id, workspace_id, action) VALUES (?, ?, ?)')
      .run(dbRunId, workspace.id, action);
    pruneWorkspaceRuns(db, workspace.id);

    const args = [action, '-no-color'];
    if (action === 'apply' || action === 'destroy') args.push('-auto-approve');
    if (['plan','apply','destroy'].includes(action)) args.push('-input=false');

    const env = { ...process.env, ...workspace.env_vars };
    const logMeta = { ip: req.ip, user: req.user?.username };

    res.json({ runId, dbRunId, status: 'started' });

    // Auto-pull from git before run
    const gs = getGitSync();
    const pullAndRun = async () => {
      if (gs && gs.isConfigured()) {
        try {
          await gs.pull();
          syncAllFromGit(getAllWorkspaces());
        } catch {}
      }

      broadcast({ type: 'tofu_start', runId, workspaceId: workspace.id, action });
      broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'meta',
        data: `▶  ${binary} ${args.join(' ')}\n   cwd: ${workspace.path}\n\n` });

      const proc = spawn(binary, args, { cwd: workspace.path, env });
      _running.set(runId, { proc, dbRunId, workspaceId: workspace.id });

      let output = '';
      const emitMeta = (message) => {
        const text = message.endsWith('\n') ? message : `${message}\n`;
        output += text;
        broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'meta', data: text });
      };
      proc.stdout.on('data', d => {
        const s = d.toString();
        output += s;
        broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stdout', data: s });
      });
      proc.stderr.on('data', d => {
        const s = d.toString();
        output += s;
        broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stderr', data: s });
      });
      proc.on('close', code => {
        _running.delete(runId);
        const success = code === 0;
        const finish = async () => {
          if (success && action === 'apply') {
            try {
              const sync = await waitForManagedServers({
                loadState: () => loadWorkspaceState({ binary, workspace, env }),
                workspaceName: workspace.name,
                hydrateServers: ({ state, servers }) => resolveFleetProxmoxServers({ workspace, state, servers }),
              });
              if (sync.source === 'outputs' && !sync.authoritative && sync.servers.length === 0) {
                emitMeta('[Shipyard] Output "shipyard_server(s)" is present but invalid. Skipping server sync to avoid deleting existing entries.');
              } else if (!sync.authoritative && sync.servers.length === 0) {
                const waited = Math.round(sync.waitedMs / 1000);
                emitMeta(`[Shipyard] No manageable servers found in state after waiting ${waited}s. Define output "shipyard_servers" for explicit sync.`);
              } else {
                const result = await reconcileManagedServers({
                  db,
                  workspace,
                  desiredServers: sync.servers,
                  logMeta,
                });
                const waitedSuffix = sync.attempts > 1 ? ` after waiting ${Math.round(sync.waitedMs / 1000)}s for DHCP/state updates` : '';
                emitMeta(`[Shipyard] Server sync complete: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted.${waitedSuffix}`);
                const postDeploy = await runPostDeployPlaybooks({
                  workspace,
                  syncedServers: sync.servers,
                  logMeta,
                  emitMeta,
                });
                if (postDeploy.started) {
                  emitMeta(`[Fleet] Post-Deploy abgeschlossen: ${postDeploy.succeeded} erfolgreich, ${postDeploy.failed} fehlgeschlagen.`);
                }
              }
            } catch (err) {
              log.error({ err, workspace: workspace.name }, 'OpenTofu apply server sync failed');
              emitMeta(`[Shipyard] Server sync failed: ${err.message}`);
            }
          }

          if (success && action === 'destroy') {
            try {
              const result = cleanupManagedServersForWorkspace({ db, workspace, logMeta });
              emitMeta(`[Shipyard] Removed ${result.deleted} managed server entries${result.untracked ? ` and untracked ${result.untracked} reused entries` : ''}.`);
            } catch (err) {
              log.error({ err, workspace: workspace.name }, 'OpenTofu destroy cleanup failed');
              emitMeta(`[Shipyard] Managed server cleanup failed: ${err.message}`);
            }
          }

          const status  = success ? 'success' : 'failed';
          db.db.prepare("UPDATE tofu_runs SET status=?, output=?, completed_at=datetime('now') WHERE id=?")
            .run(status, output, dbRunId);
          broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success, exitCode: code, dbRunId });
        };

        finish().catch(err => {
          log.error({ err, workspace: workspace.name }, 'OpenTofu run finalization failed');
          db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?")
            .run(`${output}\n[Shipyard] Finalization failed: ${err.message}\n`, dbRunId);
          broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success: false, exitCode: code, error: err.message, dbRunId });
        });
      });
      proc.on('error', err => {
        _running.delete(runId);
        db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?")
          .run(err.message, dbRunId);
        broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success: false, exitCode: -1, error: err.message, dbRunId });
      });
    };

    pullAndRun().catch(() => {});
  });

  router.post('/workspaces/:id/cancel/:runId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const entry = [..._running.values()].find(item => item.dbRunId === req.params.runId && item.workspaceId === workspace.id);
    if (!entry) return res.status(404).json({ error: 'No running process found for this workspace' });
    entry.proc.kill('SIGTERM');
    res.json({ success: true });
  });

  // ── Routes: Files ─────────────────────────────────────────────────────────

  router.get('/workspaces/:id/check', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    res.json({ pathExists: fs.existsSync(workspace.path) });
  });

  router.get('/workspaces/:id/files', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });
    res.json({ tree: walkDir(workspace.path, '', 0) });
  });

  router.get('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try { res.json({ content: fs.readFileSync(fp, 'utf8') }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.writeFileSync(fp, req.body.content ?? '', 'utf8');
      res.json({ success: true });
      // Auto-push to git after file save
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Update tofu/${workspace.name}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  router.post('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.body.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    if (fs.existsSync(fp)) return res.status(409).json({ error: 'File already exists' });
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  router.delete('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.unlinkSync(fp);
      res.json({ success: true });
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Delete tofu/${workspace.name}/${req.query.path}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  router.post('/workspaces/:id/generate-shipyard-output', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });

    try {
      const files = readTerraformFiles(workspace.path);
      const resources = detectTerraformResources(files);
      const supported = supportedTerraformResources(resources);
      const outputPath = path.join(workspace.path, 'outputs.tf');
      const generatedBlock = generateShipyardOutputsBlock(resources);
      const existingContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
      const nextContent = upsertManagedShipyardOutputs(existingContent, generatedBlock);
      fs.writeFileSync(outputPath, nextContent, 'utf8');

      res.json({
        success: true,
        path: 'outputs.tf',
        resources: supported,
        content: generatedBlock,
      });

      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Generate tofu/${workspace.name}/outputs.tf shipyard output`).catch(() => {});
      }
    } catch (e) {
      res.status(400).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  // ── Routes: Fleet Proxmox VM form ────────────────────────────────────────

  router.get('/workspaces/:id/proxmox-catalog', async (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      res.json(await loadProxmoxCatalog(workspace, req.query.node));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Proxmox catalog could not be loaded' });
    }
  });

  router.get('/infrastructure', async (_req, res) => {
    try {
      const environmentId = String(_req.query.environment_id || '').trim();
      if (environmentId && !db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
      res.json(await loadProxmoxInfrastructure(environmentId || null));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Proxmox-Inventar konnte nicht geladen werden.' });
    }
  });

  router.get('/workspaces/:id/proxmox-vms', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({
      vms: getProxmoxVms(workspace.id),
      generated_files: ['fleet-proxmox-provider.tf', 'fleet-proxmox-variables.tf', 'fleet-proxmox-vms.tf'],
    });
  });

  function getManagedProxmoxVmForServer(serverId, req, { requireEdit = false } = {}) {
    const permissions = getPermissions(req.user);
    if (!can(permissions, requireEdit ? 'canEditServers' : 'canViewServers')) {
      const error = new Error('Permission denied'); error.status = 403; throw error;
    }
    const accessible = filterServers(db.servers.getAll(), permissions).some(server => server.id === serverId);
    if (!accessible) {
      const error = new Error('Server not found'); error.status = 404; throw error;
    }
    const mappings = db.db.prepare(`
      SELECT mapping.workspace_id, mapping.resource_key, workspace.name AS workspace_name
      FROM tofu_managed_servers mapping
      JOIN tofu_workspaces workspace ON workspace.id = mapping.workspace_id
      WHERE mapping.server_id = ? AND mapping.resource_key LIKE 'resource:proxmox_virtual_environment_vm.%'
      ORDER BY workspace.name COLLATE NOCASE
      LIMIT 1
    `).all(serverId);
    const mapping = mappings[0];
    if (!mapping) {
      const error = new Error('Für diesen Server ist keine Proxmox-VM-Bereitstellung vorhanden.'); error.status = 404; throw error;
    }
    const vmName = String(mapping.resource_key).replace(/^resource:proxmox_virtual_environment_vm\./, '');
    const vm = getProxmoxVms(mapping.workspace_id).find(item => item.name === vmName);
    if (!vm?.node_name || !vm.vm_id) {
      const error = new Error('Die Proxmox-VM-Definition ist unvollständig. Node und VM-ID müssen gesetzt sein.'); error.status = 409; throw error;
    }
    const workspace = getWorkspace(mapping.workspace_id);
    if (!workspace) {
      const error = new Error('Das zugehörige Deployment ist nicht verfügbar.'); error.status = 404; throw error;
    }
    return { mapping, vm, connection: readProxmoxConnection(workspace.env_vars) };
  }

  router.get('/managed-servers/:serverId/snapshots', async (req, res) => {
    try {
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req);
      const snapshots = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/snapshot`);
      res.json({
        workspace_id: target.mapping.workspace_id,
        workspace_name: target.mapping.workspace_name,
        node_name: target.vm.node_name,
        vm_id: target.vm.vm_id,
        snapshots: Array.isArray(snapshots) ? snapshots.filter(snapshot => snapshot?.name !== 'current') : [],
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'Snapshots konnten nicht geladen werden.' });
    }
  });

  router.post('/managed-servers/:serverId/snapshots', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim().slice(0, 512);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
      return res.status(400).json({ error: 'Der Snapshot-Name darf 1–40 Zeichen (Buchstaben, Zahlen, Punkt, Unterstrich, Bindestrich) enthalten.' });
    }
    try {
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req, { requireEdit: true });
      const upid = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/snapshot`, {
        method: 'POST',
        payload: { snapname: name, description, vmstate: 1 },
      });
      db.auditLog.write('tofu.snapshot_create', `workspace=${target.mapping.workspace_name} vm=${target.vm.name} vm_id=${target.vm.vm_id} snapshot=${name}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, task: upid, name });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'Snapshot konnte nicht erstellt werden.' });
    }
  });

  // The server detail remains the operational source of truth. This small
  // lookup only adds deployment context and deliberately never exposes a
  // workspace's credentials or state file to the browser.
  router.get('/managed-servers/:serverId', (req, res) => {
    if (!can(getPermissions(req.user), 'canViewServers')) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const serverId = String(req.params.serverId || '').trim();
    if (!serverId) return res.status(400).json({ error: 'Server ID is required' });
    const mappings = db.db.prepare(`
      SELECT mapping.workspace_id, mapping.resource_key, workspace.name AS workspace_name
      FROM tofu_managed_servers mapping
      JOIN tofu_workspaces workspace ON workspace.id = mapping.workspace_id
      WHERE mapping.server_id = ?
      ORDER BY workspace.name COLLATE NOCASE
    `).all(serverId);
    const resources = mappings.map(mapping => {
      const vmName = String(mapping.resource_key || '').replace(/^resource:proxmox_virtual_environment_vm\./, '');
      const vm = getProxmoxVms(mapping.workspace_id).find(item => item.name === vmName);
      return {
        workspace_id: mapping.workspace_id,
        workspace_name: mapping.workspace_name,
        resource_key: mapping.resource_key,
        vm: vm ? {
          id: vm.id,
          name: vm.name,
          node_name: vm.node_name,
          vm_id: vm.vm_id,
          post_deploy_playbooks: vm.post_deploy_playbooks || [],
        } : null,
      };
    });
    res.json({ resources });
  });

  router.get('/workspaces/:id/deployment-summary', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vms = getProxmoxVms(workspace.id);
    const postDeploy = getPostDeployOverview(workspace.id);
    res.json({
      vm_count: vms.length,
      started_vm_count: vms.filter(vm => vm.started).length,
      post_deploy: postDeploy,
      resources: vms.map(vm => ({
        id: vm.id, name: vm.name, node_name: vm.node_name, vm_id: vm.vm_id,
        cpu_cores: vm.cpu_cores, memory_mb: vm.memory_mb, disk_size_gb: vm.disk_size_gb,
      })),
    });
  });

  router.post('/workspaces/:id/post-deploy/retry', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vmId = String(req.body?.vm_id || '').trim();
    const playbook = String(req.body?.playbook || '').trim();
    const vm = getProxmoxVms(workspace.id).find(item => item.id === vmId);
    if (!vm || !vm.post_deploy_playbooks.includes(playbook)) return res.status(404).json({ error: 'Post-Deploy-Schritt nicht gefunden' });
    try {
      validatePostDeployPlaybookAccess([playbook], req);
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    db.db.prepare(`
      INSERT INTO tofu_proxmox_playbook_runs (workspace_id, vm_id, playbook, status, output, updated_at)
      VALUES (?, ?, ?, 'running', '', datetime('now'))
      ON CONFLICT(workspace_id, vm_id, playbook) DO UPDATE SET
        status = 'running', output = '', completed_at = NULL, updated_at = datetime('now')
    `).run(workspace.id, vm.id, playbook);
    res.status(202).json({ accepted: true });

    // This is intentionally decoupled from a full tofu apply: the VM has
    // already been reconciled and Fleet can safely rerun just this bootstrap
    // step against its managed server mapping.
    setImmediate(() => runPostDeployPlaybooks({
      workspace,
      syncedServers: [{ resource_key: `resource:proxmox_virtual_environment_vm.${vm.name}` }],
      logMeta: { ip: req.ip, user: req.user?.username },
      emitMeta: () => {},
      onlyVmId: vm.id,
      onlyPlaybook: playbook,
      force: true,
    }).catch(error => log.error({ err: error, workspace: workspace.name, vm: vm.name, playbook }, 'Post-deploy retry failed')));
  });

  router.get('/workspaces/:id/proxmox-vm-templates', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ templates: getProxmoxVmTemplates(workspace.id) });
  });

  router.post('/workspaces/:id/proxmox-vm-templates', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess(template.config.post_deploy_playbooks, req);
      const id = randomUUID();
      db.db.prepare('INSERT INTO tofu_proxmox_vm_templates (id, workspace_id, name, config) VALUES (?, ?, ?, ?)')
        .run(id, workspace.id, template.name, JSON.stringify(template.config));
      res.status(201).json({ template: { ...template, id } });
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  router.put('/workspaces/:id/proxmox-vm-templates/:templateId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const existing = db.db.prepare('SELECT id FROM tofu_proxmox_vm_templates WHERE id = ? AND workspace_id = ?')
      .get(req.params.templateId, workspace.id);
    if (!existing) return res.status(404).json({ error: 'VM template not found' });
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess(template.config.post_deploy_playbooks, req);
      db.db.prepare("UPDATE tofu_proxmox_vm_templates SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(template.name, JSON.stringify(template.config), existing.id, workspace.id);
      res.json({ template: { ...template, id: existing.id } });
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  router.delete('/workspaces/:id/proxmox-vm-templates/:templateId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const result = db.db.prepare('DELETE FROM tofu_proxmox_vm_templates WHERE id = ? AND workspace_id = ?')
      .run(req.params.templateId, workspace.id);
    if (!result.changes) return res.status(404).json({ error: 'VM template not found' });
    res.json({ success: true });
  });

  router.post('/workspaces/:id/proxmox-vms', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: permissionError(mkdirErr, workspace.path) });
    try {
      const vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess(vm.post_deploy_playbooks, req);
      if (vm.vm_id !== null && getProxmoxVms(workspace.id).some(existing => existing.vm_id === vm.vm_id)) {
        return res.status(409).json({ error: `VM-ID ${vm.vm_id} ist in diesem Workspace bereits definiert.` });
      }
      const id = randomUUID();
      db.db.prepare('INSERT INTO tofu_proxmox_vms (id, workspace_id, name, config) VALUES (?, ?, ?, ?)')
        .run(id, workspace.id, vm.name, JSON.stringify(vm));
      const generated = writeFleetProxmoxFiles(workspace);
      res.status(201).json({ vm: { ...vm, id }, generated_files: generated.files });
      syncFleetWorkspace(workspace, `Add Fleet Proxmox VM ${vm.name}`);
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  router.put('/workspaces/:id/proxmox-vms/:vmId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const existing = db.db.prepare('SELECT id FROM tofu_proxmox_vms WHERE id = ? AND workspace_id = ?').get(req.params.vmId, workspace.id);
    if (!existing) return res.status(404).json({ error: 'VM definition not found' });
    try {
      const vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess(vm.post_deploy_playbooks, req);
      if (vm.vm_id !== null && getProxmoxVms(workspace.id).some(item => item.id !== existing.id && item.vm_id === vm.vm_id)) {
        return res.status(409).json({ error: `VM-ID ${vm.vm_id} ist in diesem Workspace bereits definiert.` });
      }
      db.db.prepare("UPDATE tofu_proxmox_vms SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(vm.name, JSON.stringify(vm), existing.id, workspace.id);
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ vm: { ...vm, id: existing.id }, generated_files: generated.files });
      syncFleetWorkspace(workspace, `Update Fleet Proxmox VM ${vm.name}`);
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });

  router.delete('/workspaces/:id/proxmox-vms/:vmId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const result = db.db.prepare('DELETE FROM tofu_proxmox_vms WHERE id = ? AND workspace_id = ?').run(req.params.vmId, workspace.id);
    if (!result.changes) return res.status(404).json({ error: 'VM definition not found' });
    try {
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ success: true, generated_files: generated.files });
      syncFleetWorkspace(workspace, 'Remove Fleet Proxmox VM');
    } catch (error) {
      res.status(500).json({ error: permissionError(error, workspace.path) });
    }
  });

  router.post('/workspaces/:id/proxmox-vms/regenerate', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: permissionError(mkdirErr, workspace.path) });
    try {
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ success: true, generated_files: generated.files, count: generated.vms.length });
      syncFleetWorkspace(workspace, 'Regenerate Fleet Proxmox files');
    } catch (error) {
      res.status(500).json({ error: permissionError(error, workspace.path) });
    }
  });

  router.get('/workspaces/:id/resources-overview', async (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vms = getProxmoxVms(workspace.id);
    const binary = findBinary();
    if (!binary || !fs.existsSync(workspace.path)) {
      return res.json({ ...buildProxmoxResourceOverview(vms), actual: { available: false, vm_count: 0, resources: [], reason: binary ? 'Workspace path is unavailable' : 'OpenTofu binary is not installed' } });
    }
    try {
      const state = await loadWorkspaceState({ binary, workspace, env: { ...process.env, ...workspace.env_vars } });
      res.json(buildProxmoxResourceOverview(vms, state));
    } catch (error) {
      const overview = buildProxmoxResourceOverview(vms);
      overview.actual.reason = String(error.stderr || error.stdout || error.message || 'No state available').trim();
      res.json(overview);
    }
  });

  // ── Routes: State ─────────────────────────────────────────────────────────

  router.get('/workspaces/:id/state', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'Binary not found' });
    ensureWorkspacePath(workspace);
    if (!fs.existsSync(workspace.path)) {
      return res.json({ resources: [], error: `Path "${workspace.path}" does not exist inside the container.` });
    }
    try {
      const raw = execFileSync(binary, ['state', 'list', '-no-color'], {
        cwd: workspace.path,
        env: { ...process.env, ...workspace.env_vars },
        encoding: 'utf8',
        timeout: 15000,
      });
      const resources = raw.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('.');
        return { address: line.trim(), type: parts[0] || '', name: parts.slice(1).join('.') || '' };
      });
      res.json({ resources });
    } catch (e) {
      const stderr = (e.stdout || e.stderr || e.message || '').trim();
      res.json({ resources: [], error: stderr });
    }
  });

  // ── Routes: Install ───────────────────────────────────────────────────────

  router.get('/releases', async (req, res) => {
    try {
      const releases = await _fetchGitHubReleases();
      res.json({ releases });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/install', async (req, res) => {
    const { version } = req.body;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version' });
    }
    const arch     = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const filename = `tofu_${version}_linux_${arch}.zip`;
    const url      = `https://github.com/opentofu/opentofu/releases/download/v${version}/${filename}`;
    const tmpZip   = `/tmp/tofu_install_${version}_${randomUUID().slice(0, 8)}.zip`;
    const installDir  = '/app/server/data/bin';
    const installPath = `${installDir}/tofu`;

    try {
      fs.mkdirSync(installDir, { recursive: true });
      await _downloadFile(url, tmpZip);
      await execFileAsync('unzip', ['-o', tmpZip, 'tofu', '-d', installDir]);
      fs.chmodSync(installPath, 0o755);
      try { fs.unlinkSync(tmpZip); } catch {}
      // Invalidate binary cache so next call picks up new binary
      _cachedBinary  = undefined;
      _cachedVersion = undefined;
      const bin = findBinary();
      const ver = bin ? getVersion(bin) : null;
      res.json({ success: true, binary: bin, version: ver });
    } catch (e) {
      try { fs.unlinkSync(tmpZip); } catch {}
      res.status(500).json({ error: e.message });
    }
  });

}

module.exports = {
  register,
  _test: {
    extractManagedServersFromState,
    reconcileManagedServers,
    cleanupManagedServersForWorkspace,
    normalizeServerCandidate,
    waitForManagedServers,
    detectTerraformResources,
    generateShipyardOutputsBlock,
    upsertManagedShipyardOutputs,
    normalizeProxmoxVm,
    normalizeProxmoxVmTemplate,
    normalizePostDeployPlaybooks,
    renderProxmoxVmHcl,
    readProxmoxConnection,
    proxmoxApiUrl,
    buildProxmoxProviderFiles,
    buildProxmoxResourceOverview,
    applyFleetProxmoxBlueprintMetadata,
    extractProxmoxGuestIpv4,
    pruneWorkspaceRuns,
    moveWorkspaceDirectory,
    destroyConfirmationPhrase,
    hasValidDestroyConfirmation,
  },
};
