'use strict';

const { execFile: execFileCallback } = require('child_process');
const { randomUUID } = require('crypto');
const { promisify } = require('util');
const log = require('../../utils/logger').child('features:opentofu:inventory');
const {
  DIRECT_IP_KEYS,
  findFirstIp,
  firstNonEmptyString,
  firstNumber,
  flattenStateResources,
  isPlainObject,
  isUsableGuestIp,
  normalizeIp,
  parseJsonArray,
  sleep,
  uniqueStrings,
} = require('./core-utils');

const execFileAsync = promisify(execFileCallback);
let sshManager;
function getSshManager() {
  if (!sshManager) sshManager = require('../../services/ssh-manager');
  return sshManager;
}

const SERVER_TYPE_HINTS = ['server', 'instance', 'vm', 'machine', 'droplet', 'compute', 'node', 'guest'];
const DIRECT_NAME_KEYS = ['shipyard_name', 'name', 'vm_name', 'hostname', 'host'];
const DIRECT_SSH_USER_KEYS = ['shipyard_ssh_user', 'ssh_user', 'default_user', 'admin_user', 'username'];
const DIRECT_SSH_PORT_KEYS = ['shipyard_ssh_port', 'ssh_port', 'port'];
const APPLY_SYNC_MAX_WAIT_MS = Math.max(0, parseInt(process.env.TOFU_SYNC_MAX_WAIT_MS || '90000', 10) || 90000);
const APPLY_SYNC_RETRY_MS = Math.max(1000, parseInt(process.env.TOFU_SYNC_RETRY_MS || '5000', 10) || 5000);
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
  removeOrphanedServerMappings(db);
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
  let detached = 0;

  for (const desiredServer of desiredServers) {
    const mapping = mappingsByKey.get(desiredServer.resource_key);
    let targetServer = mapping ? db.servers.getById(mapping.server_id) : null;
    let createdByFeature = mapping ? !!mapping.created_by_plugin : false;

    if (!targetServer) {
      targetServer = findReusableServer(existingServers, trackedServerIds, desiredServer);
      createdByFeature = false;
    }

    const payload = buildServerPayload(targetServer, desiredServer, workspace);

    if (targetServer) {
      db.servers.update(targetServer.id, payload);
      updated++;
    } else {
      targetServer = db.servers.create(payload);
      existingServers.push(targetServer);
      trackedServerIds.add(targetServer.id);
      createdByFeature = true;
      created++;
    }

    upsertMapping.run(randomUUID(), workspace.id, desiredServer.resource_key, targetServer.id, createdByFeature ? 1 : 0);
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
    // A Terraform/OpenTofu state is a desired deployment definition, not an
    // ownership claim over Shipyard's central inventory.  Removing a resource
    // from state must only detach the deployment mapping; deleting the Shipyard
    // host here made ordinary inventory vanish on the next Apply.
    if (db.servers.getById(mapping.server_id)) detached++;
    deleteMapping.run(workspace.id, mapping.resource_key);
  }

  if (created || updated || detached) {
    db.auditLog.write(
      'tofu.server_sync',
      `workspace=${workspace.name} created=${created} updated=${updated} detached=${detached}`,
      logMeta.ip || null,
      true,
      logMeta.user || null
    );
  }

  return { created, updated, detached };
}

function cleanupManagedServersForWorkspace({ db, workspace, logMeta = {} }) {
  ensureManagedServersTable(db);
  const mappings = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').all(workspace.id);
  let detached = 0;

  for (const mapping of mappings) {
    if (db.servers.getById(mapping.server_id)) detached++;
  }

  db.db.prepare('DELETE FROM tofu_managed_servers WHERE workspace_id = ?').run(workspace.id);

  if (detached) {
    db.auditLog.write(
      'tofu.server_cleanup',
      `workspace=${workspace.name} detached=${detached}`,
      logMeta.ip || null,
      true,
      logMeta.user || null
    );
  }

  return { detached };
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

// A host can be removed independently from an OpenTofu deployment or
// from the imported Proxmox inventory. These tables deliberately have no
// foreign keys so the feature remains compatible with existing Shipyard DBs. The
// cleanup only removes mappings whose target host is already absent.
function removeOrphanedServerMappings(db) {
  let staleManaged = 0;
  let staleInventory = 0;
  try {
    staleManaged = db.db.prepare(`
      DELETE FROM tofu_managed_servers
      WHERE NOT EXISTS (SELECT 1 FROM servers WHERE servers.id = tofu_managed_servers.server_id)
    `).run().changes;
  } catch { /* table is not available before feature setup */ }
  try {
    staleInventory = db.db.prepare(`
      DELETE FROM proxmox_inventory_servers
      WHERE NOT EXISTS (SELECT 1 FROM servers WHERE servers.id = proxmox_inventory_servers.server_id)
    `).run().changes;
  } catch { /* table is not available before plugin setup */ }
  return { staleManaged, staleInventory };
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




module.exports = {
  cleanupManagedServersForWorkspace,
  ensureManagedServersTable,
  extractManagedServersFromState,
  loadWorkspaceState,
  normalizeServerCandidate,
  reconcileManagedServers,
  removeOrphanedServerMappings,
  waitForManagedServers,
};
