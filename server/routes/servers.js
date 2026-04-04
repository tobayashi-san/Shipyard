const express = require('express');
const router = express.Router();
const log = require('../utils/logger').child('routes:servers');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');
const ansibleRunner = require('../services/ansible-runner');
const { parseImageUpdateOutput } = require('../utils/parse-image-updates');
const { serverError } = require('../utils/http-error');
const { targetIncludesServer } = require('../utils/validate');
const { isValidStorageMountPath, parseConfiguredStorageMounts } = require('../utils/storage-mounts');

// Deserialize JSON fields for API responses
function parseServer(s) {
  return {
    ...s,
    tags: JSON.parse(s.tags || '[]'),
    services: JSON.parse(s.services || '[]'),
    links: parseServerLinks(s.links),
    storage_mounts: parseConfiguredStorageMounts(s.storage_mounts),
  };
}

function parseServerLinks(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeServerLinks(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    const err = new Error('Links must be an array');
    err.statusCode = 400;
    throw err;
  }

  const seenUrls = new Set();
  return value.map((link, index) => {
    if (!link || typeof link !== 'object') {
      const err = new Error(`Link #${index + 1} is invalid`);
      err.statusCode = 400;
      throw err;
    }

    const name = String(link.name || '').trim().slice(0, 100);
    const url = String(link.url || '').trim().slice(0, 1000);
    if (!name) {
      const err = new Error(`Link #${index + 1} needs a name`);
      err.statusCode = 400;
      throw err;
    }
    if (!url) {
      const err = new Error(`Link "${name}" needs a URL`);
      err.statusCode = 400;
      throw err;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      const err = new Error(`Link "${name}" has an invalid URL`);
      err.statusCode = 400;
      throw err;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      const err = new Error(`Link "${name}" must use http or https`);
      err.statusCode = 400;
      throw err;
    }

    const normalizedUrl = parsed.toString();
    if (seenUrls.has(normalizedUrl)) {
      const err = new Error(`Link URL "${normalizedUrl}" is duplicated`);
      err.statusCode = 400;
      throw err;
    }
    seenUrls.add(normalizedUrl);

    return { name, url: normalizedUrl };
  });
}

function normalizeStorageMounts(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    const err = new Error('Storage mounts must be an array');
    err.statusCode = 400;
    throw err;
  }

  const seenPaths = new Set();
  return value.map((mount, index) => {
    if (!mount || typeof mount !== 'object') {
      const err = new Error(`Storage mount #${index + 1} is invalid`);
      err.statusCode = 400;
      throw err;
    }

    const path = String(mount.path || '').trim();
    if (!isValidStorageMountPath(path)) {
      const err = new Error(`Storage mount path "${path || `#${index + 1}`}" is invalid`);
      err.statusCode = 400;
      throw err;
    }
    if (seenPaths.has(path)) {
      const err = new Error(`Storage mount path "${path}" is duplicated`);
      err.statusCode = 400;
      throw err;
    }
    seenPaths.add(path);

    const name = String(mount.name || path).trim().slice(0, 100) || path;
    return { name, path };
  });
}

function normalizeGroupMatchKey(value) {
  return String(value || '').trim().toLowerCase();
}

function extractGroupTagCandidates(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return [];
  const prefixed = raw.match(/^(?:group|folder):(.+)$/i);
  return prefixed ? [prefixed[1].trim(), raw] : [raw];
}

function resolveGroupIdByTags(tags, groups) {
  if (!Array.isArray(tags) || tags.length === 0 || !Array.isArray(groups) || groups.length === 0) return null;
  const groupMap = new Map(groups.map(group => [normalizeGroupMatchKey(group.name), group.id]));

  for (const tag of tags) {
    for (const candidate of extractGroupTagCandidates(tag)) {
      const groupId = groupMap.get(normalizeGroupMatchKey(candidate));
      if (groupId) return groupId;
    }
  }

  return null;
}

const { getPermissions, filterServers, can, guardServerAccess } = require('../utils/permissions');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

// GET /api/servers - List all servers
router.get('/', guard('canViewServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    res.json(filterServers(db.servers.getAll(), perms).map(parseServer));
  } catch (error) {
    serverError(res, error, 'list servers');
  }
});

// GET /api/servers/export?format=json|csv
router.get('/export', guard('canExportImportServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const servers = filterServers(db.servers.getAll(), perms).map(s => ({
      name:        s.name,
      hostname:    s.hostname,
      ip_address:  s.ip_address,
      ssh_port:    s.ssh_port,
      ssh_user:    s.ssh_user,
      tags:        JSON.parse(s.tags     || '[]'),
      services:    JSON.parse(s.services || '[]'),
      links:       parseServerLinks(s.links),
      storage_mounts: parseConfiguredStorageMounts(s.storage_mounts),
    }));

    const format = (req.query.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) return res.status(400).json({ error: 'Invalid format. Use json or csv.' });

    if (format === 'csv') {
      const escape = v => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = 'name,hostname,ip_address,ssh_port,ssh_user,tags,services,links,storage_mounts';
      const rows = servers.map(s =>
        [s.name, s.hostname, s.ip_address, s.ssh_port, s.ssh_user,
         JSON.stringify(s.tags), JSON.stringify(s.services), JSON.stringify(s.links), JSON.stringify(s.storage_mounts)].map(escape).join(',')
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="servers.csv"');
      return res.send([header, ...rows].join('\r\n'));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="servers.json"');
    res.json(servers);
  } catch (error) {
    serverError(res, error, 'export servers');
  }
});

// POST /api/servers/import
router.post('/import', guard('canExportImportServers'), (req, res) => {
  try {
    const { servers } = req.body;
    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: 'No server data found' });
    }

    const allGroups = db.serverGroups.getAll();
    const existingAll = db.servers.getAll();
    const existing    = new Set(existingAll.map(s => s.name));
    const existingIPs = new Set(existingAll.map(s => s.ip_address));
    const results  = { created: 0, skipped: 0, errors: [] };

    for (const s of servers) {
      if (!s.name || !s.ip_address) {
        results.errors.push(`Skipped: missing required fields (name/ip_address)`);
        results.skipped++;
        continue;
      }
      if (existing.has(s.name) || existingIPs.has(s.ip_address)) {
        results.skipped++;
        continue;
      }
      try {
        const normalizedTags = Array.isArray(s.tags) ? s.tags : [];
        const created = db.servers.create({
          name:      String(s.name).slice(0, 100),
          hostname:  String(s.hostname  || s.ip_address).slice(0, 255),
          ip_address: String(s.ip_address).slice(0, 45),
          ssh_port:  parseInt(s.ssh_port) || 22,
          ssh_user:  String(s.ssh_user || 'root').slice(0, 100),
          tags:      normalizedTags,
          services:  Array.isArray(s.services) ? s.services : [],
          links:     normalizeServerLinks(s.links || []),
          storage_mounts: normalizeStorageMounts(s.storage_mounts || []),
        });
        const autoGroupId = resolveGroupIdByTags(normalizedTags, allGroups);
        if (autoGroupId) db.serverGroups.setServerGroup(created.id, autoGroupId);
        existing.add(s.name);
        existingIPs.add(s.ip_address);
        results.created++;
      } catch (e) {
        results.errors.push(`"${s.name}": ${e.message}`);
        results.skipped++;
      }
    }

    res.json(results);
  } catch (error) {
    serverError(res, error, 'import servers');
  }
});

// ── Server Groups ─────────────────────────────────────────────
// GET /api/servers/groups — only return groups the user can see
router.get('/groups', guard('canViewServers'), (req, res) => {
  const perms = getPermissions(req.user);
  const allGroups = db.serverGroups.getAll();
  if (!perms || perms.full || perms.servers === 'all') return res.json(allGroups);

  // Collect the group IDs the user has explicit access to
  const { groups: allowedGroups = [], servers: allowedServers = [] } = perms.servers || {};

  // Also include groups that contain at least one allowed server
  const groupsWithAccessibleServer = new Set(
    db.servers.getAll()
      .filter(s => allowedServers.includes(s.id) || (s.group_id && allowedGroups.includes(s.group_id)))
      .map(s => s.group_id)
      .filter(Boolean)
  );

  const visibleGroupIds = new Set([...allowedGroups, ...groupsWithAccessibleServer]);

  // Include ancestor groups so the folder tree renders correctly
  function addAncestors(groupId) {
    const g = allGroups.find(x => x.id === groupId);
    if (g?.parent_id && !visibleGroupIds.has(g.parent_id)) {
      visibleGroupIds.add(g.parent_id);
      addAncestors(g.parent_id);
    }
  }
  [...visibleGroupIds].forEach(addAncestors);

  res.json(allGroups.filter(g => visibleGroupIds.has(g.id)));
});

// POST /api/servers/groups
router.post('/groups', guard('canEditServers'), (req, res) => {
  const { name, color, parent_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  res.json(db.serverGroups.create(name.trim(), color, parent_id || null));
});

// PUT /api/servers/groups/:groupId
router.put('/groups/:groupId', guard('canEditServers'), (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  db.serverGroups.update(req.params.groupId, name.trim(), color);
  res.json({ success: true });
});

// DELETE /api/servers/groups/:groupId
router.delete('/groups/:groupId', guard('canDeleteServers'), (req, res) => {
  db.serverGroups.delete(req.params.groupId);
  res.json({ success: true });
});

// PUT /api/servers/groups/:groupId/parent
router.put('/groups/:groupId/parent', guard('canEditServers'), (req, res) => {
  db.serverGroups.setGroupParent(req.params.groupId, req.body.parent_id || null);
  res.json({ success: true });
});

// PUT /api/servers/:id/group
router.put('/:id/group', guardServerAccess, guard('canEditServers'), (req, res) => {
  db.serverGroups.setServerGroup(req.params.id, req.body.group_id || null);
  res.json({ success: true });
});

// POST /api/servers/auto-group-by-tags
router.post('/auto-group-by-tags', guard('canEditServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const allGroups = db.serverGroups.getAll();
    const servers = filterServers(db.servers.getAll(), perms);
    let matched = 0;
    let moved = 0;

    for (const server of servers) {
      const tags = JSON.parse(server.tags || '[]');
      const groupId = resolveGroupIdByTags(tags, allGroups);
      if (!groupId) continue;
      matched++;
      if (groupId !== server.group_id) {
        db.serverGroups.setServerGroup(server.id, groupId);
        moved++;
      }
    }

    res.json({ matched, moved, unchanged: matched - moved });
  } catch (error) {
    serverError(res, error, 'auto group servers by tags');
  }
});

// GET /api/servers/:id - Get single server
router.get('/:id', guardServerAccess, guard('canViewServers'), (req, res) => {
  try {
    res.json(parseServer(req.server));
  } catch (error) {
    serverError(res, error, 'get server');
  }
});

// POST /api/servers - Add a new server
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddServers')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  try {
    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services, links, storage_mounts } = req.body;
    if (!name || typeof name !== 'string' || !ip_address || typeof ip_address !== 'string') {
      return res.status(400).json({ error: 'Name and IP address are required' });
    }
    if (name.length > 100) return res.status(400).json({ error: 'Name too long (max 100)' });
    if (ip_address.length > 45) return res.status(400).json({ error: 'IP address too long (max 45)' });
    if (hostname && (typeof hostname !== 'string' || hostname.length > 255)) return res.status(400).json({ error: 'Hostname too long (max 255)' });
    if (ssh_user && (typeof ssh_user !== 'string' || ssh_user.length > 100)) return res.status(400).json({ error: 'SSH user too long (max 100)' });
    const allGroups = db.serverGroups.getAll();
    const normalizedLinks = normalizeServerLinks(links || []);
    const normalizedStorageMounts = normalizeStorageMounts(storage_mounts || []);
    const normalizedTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : [];
    const server = db.servers.create({
      name: name.slice(0, 100),
      hostname: (hostname || ip_address).slice(0, 255),
      ip_address: ip_address.slice(0, 45),
      ssh_port: Math.min(65535, Math.max(1, parseInt(ssh_port) || 22)),
      ssh_user: (ssh_user || 'root').slice(0, 100),
      tags: normalizedTags,
      services: Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : [],
      links: normalizedLinks,
      storage_mounts: normalizedStorageMounts,
    });
    const autoGroupId = resolveGroupIdByTags(normalizedTags, allGroups);
    if (autoGroupId) {
      db.serverGroups.setServerGroup(server.id, autoGroupId);
      server.group_id = autoGroupId;
    }
    db.auditLog.write('server.create', `Server "${name}" (${ip_address}) created`, req.ip, true, req.user?.username);
    res.status(201).json(parseServer(server));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'create server');
  }
});

// PUT /api/servers/:id - Update server
router.put('/:id', guardServerAccess, guard('canEditServers'), (req, res) => {
  try {
    const existing = req.server;
    const allGroups = db.serverGroups.getAll();

    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services, links, storage_mounts } = req.body;
    const sName   = name !== undefined ? String(name).slice(0, 100) : existing.name;
    const sHost   = hostname !== undefined ? String(hostname).slice(0, 255) : existing.hostname;
    const sIp     = ip_address !== undefined ? String(ip_address).slice(0, 45) : existing.ip_address;
    const sPort   = ssh_port !== undefined ? Math.min(65535, Math.max(1, parseInt(ssh_port) || 22)) : existing.ssh_port;
    const sUser   = ssh_user !== undefined ? String(ssh_user).slice(0, 100) : existing.ssh_user;
    const sTags   = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : JSON.parse(existing.tags || '[]');
    const sSvcs   = Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : JSON.parse(existing.services || '[]');
    const sLinks  = links !== undefined ? normalizeServerLinks(links) : parseServerLinks(existing.links);
    const sMounts = storage_mounts !== undefined ? normalizeStorageMounts(storage_mounts) : parseConfiguredStorageMounts(existing.storage_mounts);
    const server = db.servers.update(req.params.id, {
      name: sName, hostname: sHost, ip_address: sIp,
      ssh_port: sPort, ssh_user: sUser, tags: sTags, services: sSvcs,
      links: sLinks,
      storage_mounts: sMounts,
    });
    if (tags !== undefined) {
      const autoGroupId = resolveGroupIdByTags(sTags, allGroups);
      if (autoGroupId && autoGroupId !== existing.group_id) {
        db.serverGroups.setServerGroup(req.params.id, autoGroupId);
        server.group_id = autoGroupId;
      }
    }
    res.json(parseServer(server));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'update server');
  }
});

// DELETE /api/servers/:id - Delete server
router.delete('/:id', guardServerAccess, guard('canDeleteServers'), (req, res) => {
  try {
    const server = req.server;
    db.servers.delete(req.params.id);
    db.auditLog.write('server.delete', `Server "${server.name}" (${server.ip_address}) deleted`, req.ip, true, req.user?.username);
    res.json({ message: 'Server deleted' });
  } catch (error) {
    serverError(res, error, 'delete server');
  }
});

// POST /api/servers/:id/test - Test SSH connection
router.post('/:id/test', guardServerAccess, guard('canUseTerminal'), async (req, res) => {
  try {
    const server = req.server;
    const connected = await sshManager.testConnection(server);
    db.servers.updateStatus(server.id, connected ? 'online' : 'offline');

    res.json({ connected, status: connected ? 'online' : 'offline' });
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'error');
    res.json({ connected: false, status: 'error', error: error.message });
  }
});

// POST /api/servers/:id/reset-host-key - Remove stale known_hosts entries
router.post('/:id/reset-host-key', guardServerAccess, guard('canUseTerminal'), (req, res) => {
  try {
    const server = req.server;
    const result = sshManager.removeKnownHostEntries([server.ip_address, server.hostname]);
    db.auditLog.write(
      'server.reset_host_key',
      `server="${server.name}" removed=${result.removed.join(',') || '-'} missing=${result.missing.join(',') || '-'}`,
      req.ip,
      true,
      req.user?.username
    );
    res.json(result);
  } catch (error) {
    serverError(res, error, 'reset host key');
  }
});

// GET /api/servers/:id/notes
router.get('/:id/notes', guardServerAccess, guard('canViewNotes'), (req, res) => {
  try {
    res.json({ notes: req.server.notes || '' });
  } catch (error) {
    serverError(res, error, 'get server notes');
  }
});

// PUT /api/servers/:id/notes
router.put('/:id/notes', guardServerAccess, guard('canEditNotes'), (req, res) => {
  try {
    if (typeof req.body.notes === 'string' && req.body.notes.length > 5000) {
      return res.status(400).json({ error: 'Notes too long (max 5000 characters)' });
    }
    const notes = typeof req.body.notes === 'string' ? req.body.notes : '';
    db.servers.setNotes(req.params.id, notes);
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'update server notes');
  }
});

// GET /api/servers/:id/info - Get system info (stale-while-revalidate)
router.get('/:id/info', guardServerAccess, guard('canViewServers'), async (req, res) => {
  const server = req.server;

  const cached = db.serverInfo.get(req.params.id);
  const force = req.query.force === '1';
  const agentCfg = db.agentConfig.getByServerId(req.params.id);
  const hasActiveAgent = !!(agentCfg && agentCfg.mode && agentCfg.mode !== 'legacy');

  // Agent-managed servers use cached metrics from the runner as the source of truth.
  // Do not overwrite them with classic SSH polling on read.
  if (hasActiveAgent && cached) {
    return res.json({ ...cached, _source: 'agent' });
  }

  // Serve cache immediately, refresh in background
  if (cached && !force) {
    const isOnline = server.status === 'online';
    const payload = { ...cached, _cached: true };
    if (!isOnline) {
      payload.ram_used_mb = null;
      payload.disk_used_gb = null;
      payload.cpu_usage_pct = null;
      payload.load_avg = null;
      payload.uptime_seconds = null;
    }
    res.json(payload);
    systemInfo.getSystemInfo(server)
      .then(info => {
        db.serverInfo.upsert(server.id, info);
        db.servers.updateStatus(server.id, 'online');
      })
      .catch(err => {
        log.debug({ err, server: server.name }, 'Background info refresh failed');
        try { db.servers.updateStatus(server.id, 'offline'); } catch {}
      });
    return;
  }

  // No cache yet (first visit) or forced refresh – wait for real data
  try {
    const info = await systemInfo.getSystemInfo(server);
    db.serverInfo.upsert(server.id, info);
    db.servers.updateStatus(server.id, 'online');
    res.json(info);
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'offline');
    if (error.message && error.message.includes('SSH connection failed')) {
      return res.status(503).json({ error: error.message });
    }
    serverError(res, error, 'get server info');
  }
});

// GET /api/servers/:id/services - Get running services
router.get('/:id/services', guardServerAccess, guard('canViewServers'), async (req, res) => {
  try {
    const server = req.server;
    const services = await systemInfo.getServices(server);
    res.json(services);
  } catch (error) {
    serverError(res, error, 'get server services');
  }
});

// GET /api/servers/:id/updates - Get available updates (stale-while-revalidate)
router.get('/:id/updates', guardServerAccess, guard('canViewUpdates'), async (req, res) => {
  const server = req.server;

  const cached = db.updatesCache.get(req.params.id);
  const force = req.query.force === '1';

  if (cached && !force) {
    res.json(cached.map(u => ({ ...u, _cached: true })));
    systemInfo.getAvailableUpdates(server)
      .then(updates => db.updatesCache.set(server.id, updates))
      .catch(() => {});
    return;
  }

  try {
    const updates = await systemInfo.getAvailableUpdates(server);
    db.updatesCache.set(server.id, updates);
    res.json(updates);
  } catch (error) {
    if (cached) return res.json(cached);
    serverError(res, error, 'get server updates');
  }
});

// GET /api/servers/:id/history - Get update history + scheduled playbook runs
router.get('/:id/history', guardServerAccess, guard('canViewServers'), (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    const manualHistory = db.updateHistory.getByServer(req.params.id);

    // Also fetch scheduled playbook runs that targeted this server
    let scheduleRuns = [];
    if (server) {
      const allRuns = db.scheduleHistory.getAll(200);
      const serverName = server.name;
      const createdAt = server.created_at ? new Date(server.created_at) : null;
      scheduleRuns = allRuns
        .filter(r => targetIncludesServer(r.targets, serverName) &&
          (!createdAt || new Date(r.started_at) >= createdAt))
        .map(r => ({
          id: r.id,
          server_id: req.params.id,
          action: r.playbook,
          triggered_by: r.schedule_name || 'schedule',
          status: r.status,
          started_at: r.started_at,
          completed_at: r.completed_at,
          _type: 'schedule',
          schedule_name: r.schedule_name,
          playbook: r.playbook,
        }));
    }

    // Merge and sort by started_at descending
    const combined = [...manualHistory, ...scheduleRuns]
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    res.json(combined);
  } catch (error) {
    serverError(res, error, 'get server history');
  }
});

function buildDockerResponse(serverId) {
  const containers = db.dockerContainers.getByServer(serverId);
  const composeProjects = db.composeProjects.getByServer(serverId);
  const activeProjects = new Set(containers.map(c => c.compose_project).filter(Boolean));
  for (const cp of composeProjects) {
    if (!activeProjects.has(cp.project_name)) {
      containers.push({
        id: `compose-${cp.id}`,
        server_id: serverId,
        container_name: '[Stack Offline]',
        image: '-',
        state: 'exited',
        status: 'Down',
        created_at_container: cp.created_at,
        compose_project: cp.project_name,
        compose_working_dir: cp.working_dir,
      });
    }
  }
  return containers;
}

async function refreshDockerCache(server) {
  const result = await ansibleRunner.runPlaybook('gather-docker.yml', server.name);
  if (!result.success) return;
  const marker = result.stdout.indexOf('"msg": [');
  if (marker === -1) return;
  const arrayStart = result.stdout.indexOf('[', marker);
  let depth = 0, jsonEnd = -1;
  for (let i = arrayStart; i < result.stdout.length; i++) {
    if (result.stdout[i] === '[') depth++;
    else if (result.stdout[i] === ']') { depth--; if (depth === 0) { jsonEnd = i; break; } }
  }
  if (jsonEnd === -1) return;
  const jsonStr = result.stdout.substring(arrayStart, jsonEnd + 1);
  try {
    const containers = JSON.parse(jsonStr).filter(line => line.trim()).map(line => {
      const parts = line.split('|');
      return {
        name: parts[0] || 'Unknown',
        image: parts[1] || 'Unknown',
        state: parts[2] || 'unknown',
        status: parts[3] || '',
        createdAt: parts[4] || '',
        composeProject: parts[5] || null,
        composeWorkingDir: parts[6] || null,
      };
    });
    db.dockerContainers.syncForServer(server.id, containers);
  } catch (e) {
    log.error({ err: e }, 'Failed to parse docker output');
  }
}

// GET /api/servers/:id/docker - Get docker containers (stale-while-revalidate)
router.get('/:id/docker', guardServerAccess, guard('canViewDocker'), async (req, res) => {
  const server = req.server;

  const cached = buildDockerResponse(req.params.id);
  const force = req.query.force === '1';

  if (cached.length > 0 && !force) {
    res.json(cached.map(c => ({ ...c, _cached: true })));
    refreshDockerCache(server).catch(() => {});
    return;
  }

  try {
    await refreshDockerCache(server);
    res.json(buildDockerResponse(req.params.id));
  } catch (error) {
    if (cached.length > 0) return res.json(cached);
    serverError(res, error, 'get docker containers');
  }
});

// GET /api/servers/:id/docker/:container/logs
router.get('/:id/docker/:container/logs', guardServerAccess, guard('canViewDocker'), async (req, res) => {
  const server = req.server;

  const container = req.params.container;
  if (container.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(container)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }

  const tailRaw = parseInt(req.query.tail);
  const tail = Math.max(1, Math.min(Number.isFinite(tailRaw) ? tailRaw : 200, 2000));

  try {
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'shell',
      `$(command -v docker 2>/dev/null || command -v podman 2>/dev/null) logs --tail ${tail} --timestamps ${container} 2>&1`,
      () => {},
      { become: true }
    );
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to get container logs' });
    }
    let logs = result.stdout || '';
    const match = logs.match(/rc=\d+\s*>>\n([\s\S]*)/);
    if (match) {
      logs = match[1];
    }
    res.json({ logs });
  } catch (error) {
    serverError(res, error, 'get container logs');
  }
});

// GET /api/servers/:id/docker/image-updates/cached - Return cached image update results (no SSH)
router.get('/:id/docker/image-updates/cached', guardServerAccess, guard('canPullDocker'), (req, res) => {
  const cached = db.dockerImageUpdatesCache.getWithMeta(req.params.id);
  res.json(cached ? { results: cached.results, updated_at: cached.updated_at } : { results: [], updated_at: null });
});

// GET /api/servers/:id/docker/image-updates - Check for image updates
router.get('/:id/docker/image-updates', guardServerAccess, guard('canPullDocker'), async (req, res) => {
  const server = req.server;
  try {
    const result = await ansibleRunner.runPlaybook('check-image-updates.yml', server.name);
    const updates = parseImageUpdateOutput(result.stdout);
    db.dockerImageUpdatesCache.set(server.id, updates);
    res.json(updates);
  } catch (error) {
    serverError(res, error, 'get docker image updates');
  }
});


// GET /api/servers/:id/docker/compose - Read docker-compose.yml
router.get('/:id/docker/compose', guardServerAccess, guard('canManageDockerCompose'), async (req, res) => {
  try {
    const { path } = req.query;

    if (!path) return res.status(400).json({ error: 'path query parameter is required' });
    if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) {
      return res.status(400).json({ error: 'Invalid path format' });
    }

    const server = req.server;

    const safePath = path.replace(/'/g, "'\\''");
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'command',
      `cat '${safePath}/docker-compose.yml'`,
      () => {}, // silence output
      { become: true }
    );

    if (result.success) {
      // Strip ansible "host | CHANGED | rc=0 >>" preamble
      let content = result.stdout;
      const match = content.match(/rc=\d+\s*>>\n([\s\S]*)/);
      if (match) {
        content = match[1];
      }
      res.json({ content });
    } else {
      res.status(500).json({ error: 'Failed to read docker-compose.yml. It might not exist in this directory.' });
    }
  } catch (error) {
    serverError(res, error, 'get docker compose');
  }
});

module.exports = router;
