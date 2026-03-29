const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const net  = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const log = require('../../server/utils/logger').child('plugins:opentofu');

let _gitSync = null;
function getGitSync() {
  if (!_gitSync) {
    try { _gitSync = require('../../server/services/git-sync'); } catch {}
  }
  return _gitSync;
}

// Map of currently running processes: runId -> ChildProcess
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
const SHIPYARD_OUTPUT_GENERATORS = {
  proxmox_virtual_environment_vm: {
    providerTag: 'proxmox',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.ipv4_addresses[1][0], ${address}.ipv4_addresses[0][0], null)`,
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

function findFirstIp(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return normalizeIp(value);
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

  const ipAddress = firstNonEmptyString(
    ...DIRECT_IP_KEYS.map(key => typeof base[key] === 'string' ? base[key] : null)
  ) || findFirstIp(base);
  const normalizedIp = normalizeIp(ipAddress);
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
}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastSync = { authoritative: false, source: 'state', servers: [] };

  while (true) {
    attempts++;
    const state = await loadState();
    lastSync = extractManagedServersFromState(state, workspaceName);

    if (lastSync.servers.length > 0) {
      return { ...lastSync, attempts, waitedMs: Date.now() - startedAt, timedOut: false };
    }

    if (lastSync.source === 'outputs' && !lastSync.authoritative) {
      return { ...lastSync, attempts, waitedMs: Date.now() - startedAt, timedOut: false };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      return { ...lastSync, attempts, waitedMs: elapsed, timedOut: true };
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

function register({ router, db, broadcast }) {

  // ── DB setup ──────────────────────────────────────────────────────────────
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      env_vars    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

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
      fs.writeFileSync(PATHS_FILE, rows.map(r => r.path).join('\n'), 'utf8');
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

  const ALLOWED_PATH_PREFIXES = ['/opt/','/srv/','/home/','/var/lib/','/app/','/workspaces/'];

  function isAllowedPath(p) {
    const resolved = path.resolve(p);
    if (resolved.includes('..')) return false;
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

  function getWorkspace(id) {
    const row = db.db.prepare('SELECT * FROM tofu_workspaces WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, env_vars: sanitizeEnvVars(JSON.parse(row.env_vars || '{}')) };
  }

  function getAllWorkspaces() {
    return db.db.prepare('SELECT id, name, path FROM tofu_workspaces').all();
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
    const rows = db.db.prepare('SELECT * FROM tofu_workspaces ORDER BY name ASC').all();
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

  router.post('/workspaces', (req, res) => {
    const { name, path: wPath, description, env_vars, scaffold } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: 'Path must be under /workspaces/, /opt/, /srv/, /home/, /var/lib/, or /app/' });
    const id = randomUUID();
    db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, description, env_vars) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(env_vars || {}));
    syncPathsFile();
    if (scaffold) {
      try { scaffoldWorkspace(wPath.trim(), scaffold.provider || null); } catch (e) { /* path not mounted yet — files can be created later */ }
    }
    res.json({ success: true, id });
  });

  router.put('/workspaces/:id', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: 'Path must be under /opt/, /srv/, /home/, /var/lib/, or /app/' });
    const existing = getWorkspace(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workspace not found' });
    const nextPath = wPath.trim();
    const shouldMoveFiles = req.body.move_files !== false;
    const pathChanged = path.resolve(existing.path) !== path.resolve(nextPath);

    if (pathChanged && shouldMoveFiles) {
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

  router.delete('/workspaces/:id', (req, res) => {
    db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(req.params.id);
    db.db.prepare('DELETE FROM tofu_runs WHERE workspace_id = ?').run(req.params.id);
    syncPathsFile();
    res.json({ success: true });
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
    const { action } = req.body;
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'OpenTofu/Terraform binary not found in PATH' });

    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });

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
      _running.set(runId, proc);

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
    const proc = _running.get(req.params.runId);
    if (!proc) return res.status(404).json({ error: 'No running process found' });
    proc.kill('SIGTERM');
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
    pruneWorkspaceRuns,
    moveWorkspaceDirectory,
  },
};
