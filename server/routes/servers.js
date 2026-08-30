const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const log = require('../utils/logger').child('routes:servers');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');
const ansibleRunner = require('../services/ansible-runner');
const { refreshDockerCache } = require('../services/docker-inventory');
const resourceAlerts = require('../services/resource-alerts');
const { parseImageUpdateReport } = require('../utils/parse-image-updates');
const { serverError } = require('../utils/http-error');
const { targetIncludesServer, validateInventoryHostName } = require('../utils/validate');
const { isValidStorageMountPath, parseConfiguredStorageMounts } = require('../utils/storage-mounts');
const { buildServerAttention } = require('../utils/server-attention');

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

const { getPermissions, filterServers, can, guardServerAccess, canAccessServerGroup, canAccessEnvironment, guardServerGroupAccess } = require('../utils/permissions');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

function accessibleGroupsForEnvironment(permissions, environmentId) {
  return db.serverGroups.getAll(environmentId)
    .filter(group => canAccessServerGroup(permissions, group));
}

// GET /api/servers - List all servers
router.get('/', guard('canViewServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const environmentId = req.environmentId || String(req.query.environment_id || '').trim() || 'default';
    const servers = filterServers(db.servers.getAll(), perms)
      .filter(server => String(server.environment_id || 'default') === environmentId);
    res.json(servers.map(parseServer));
  } catch (error) {
    serverError(res, error, 'list servers');
  }
});

// GET /api/servers/export?format=json|csv
router.get('/export', guard('canExportImportServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const environmentId = req.environmentId || 'default';
    const servers = filterServers(db.servers.getAll(environmentId), perms).map(s => ({
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
      // Defuse CSV formula injection (CWE-1236): values starting with =, +, -, @,
      // tab or CR are interpreted as formulas by Excel/LibreOffice/Sheets.
      // Prefix such values with a single quote and always wrap them in quotes.
      const FORMULA_PREFIX = /^[=+\-@\t\r]/;
      const escape = v => {
        let s = String(v ?? '');
        const needsFormulaGuard = FORMULA_PREFIX.test(s);
        if (needsFormulaGuard) s = `'${s}`;
        return needsFormulaGuard || s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
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

    const environmentId = req.environmentId || 'default';
    const allGroups = db.serverGroups.getAll(environmentId);
    const existingAll = db.servers.getAll(environmentId);
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
          ssh_port:  parseInt(s.ssh_port, 10) || 22,
          ssh_user:  String(s.ssh_user || 'root').slice(0, 100),
          tags:      normalizedTags,
          services:  Array.isArray(s.services) ? s.services : [],
          links:     normalizeServerLinks(s.links || []),
          storage_mounts: normalizeStorageMounts(s.storage_mounts || []),
          environment_id: environmentId,
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
  const environmentId = req.environmentId || String(req.query.environment_id || '').trim() || 'default';
  const allGroups = db.serverGroups.getAll(environmentId);
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
  const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Umgebung nicht gefunden.' });
  const parent = parent_id ? db.db.prepare('SELECT * FROM server_groups WHERE id = ?').get(String(parent_id)) : null;
  if (parent_id && (!parent || parent.environment_id !== environmentId)) return res.status(400).json({ error: 'Übergeordneter Ordner gehört nicht zu dieser Umgebung.' });
  const perms = getPermissions(req.user);
  // A restricted operator may add a child folder only below an explicitly
  // assigned folder.  Root folders remain an environment administration task.
  if (!perms?.full && perms?.servers !== 'all' && (!parent || !canAccessServerGroup(perms, parent))) {
    return res.status(403).json({ error: 'Ordner dürfen nur innerhalb eines zugewiesenen Ordners angelegt werden.' });
  }
  res.json(db.serverGroups.create(name.trim(), color, parent_id || null, environmentId));
});

// PUT /api/servers/groups/:groupId
router.put('/groups/:groupId', guard('canEditServers'), guardServerGroupAccess, (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  db.serverGroups.update(req.params.groupId, name.trim(), color);
  res.json({ success: true });
});

// DELETE /api/servers/groups/:groupId
router.delete('/groups/:groupId', guard('canDeleteServers'), guardServerGroupAccess, (req, res) => {
  db.serverGroups.delete(req.params.groupId);
  res.json({ success: true });
});

// PUT /api/servers/groups/:groupId/parent
router.put('/groups/:groupId/parent', guard('canEditServers'), guardServerGroupAccess, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const parentId = req.body.parent_id ? String(req.body.parent_id) : null;
  const groups = db.serverGroups.getAll();
  const current = groups.find(group => group.id === groupId);
  if (!current) return res.status(404).json({ error: 'Ordner nicht gefunden.' });
  const parent = parentId ? groups.find(group => group.id === parentId) : null;
  if (parentId && !parent) return res.status(400).json({ error: 'Übergeordneter Ordner nicht gefunden.' });
  const perms = getPermissions(req.user);
  if (parent && !canAccessServerGroup(perms, parent)) return res.status(403).json({ error: 'Zielordnerzugriff verweigert.' });
  if (parent && parent.environment_id !== current.environment_id) return res.status(400).json({ error: 'Ordner können nicht umgebungsübergreifend verschachtelt werden.' });
  if (parentId === groupId) return res.status(400).json({ error: 'Ein Ordner kann nicht sein eigener Überordner sein.' });
  const descendantIds = new Set([groupId]);
  let changed = true;
  while (changed) { changed = false; for (const group of groups) if (group.parent_id && descendantIds.has(group.parent_id) && !descendantIds.has(group.id)) { descendantIds.add(group.id); changed = true; } }
  if (parentId && descendantIds.has(parentId)) return res.status(400).json({ error: 'Ein Ordner kann nicht in einen eigenen Unterordner verschoben werden.' });
  db.serverGroups.setGroupParent(groupId, parentId);
  res.json({ success: true });
});

// PUT /api/servers/group/bulk — move a checked set without issuing a partial
// update.  Every host and the target folder must be accessible to the caller.
router.put('/group/bulk', guard('canEditServers'), (req, res) => {
  const serverIds = [...new Set((Array.isArray(req.body?.server_ids) ? req.body.server_ids : [])
    .map(value => String(value || '').trim()).filter(Boolean))];
  const groupId = req.body?.group_id ? String(req.body.group_id) : null;
  if (serverIds.length === 0 || serverIds.length > 500) return res.status(400).json({ error: 'Wähle zwischen 1 und 500 Hosts aus.' });

  const placeholders = serverIds.map(() => '?').join(',');
  const servers = db.db.prepare(`SELECT * FROM servers WHERE id IN (${placeholders})`).all(...serverIds);
  if (servers.length !== serverIds.length) return res.status(404).json({ error: 'Mindestens ein Host wurde nicht gefunden.' });
  if (req.environmentId && servers.some(server => String(server.environment_id || 'default') !== req.environmentId)) {
    return res.status(404).json({ error: 'Mindestens ein Host wurde nicht gefunden.' });
  }
  const permissions = getPermissions(req.user);
  if (filterServers(servers, permissions).length !== servers.length) return res.status(403).json({ error: 'Mindestens ein Host liegt außerhalb deiner Berechtigung.' });

  const environments = new Set(servers.map(server => String(server.environment_id || 'default')));
  if (environments.size !== 1) return res.status(400).json({ error: 'Hosts aus verschiedenen Umgebungen können nicht gemeinsam verschoben werden.' });
  const target = groupId ? db.db.prepare('SELECT * FROM server_groups WHERE id = ?').get(groupId) : null;
  if (groupId && !target) return res.status(400).json({ error: 'Zielordner nicht gefunden.' });
  if (target && !canAccessServerGroup(permissions, target)) return res.status(403).json({ error: 'Zielordnerzugriff verweigert.' });
  if (target && String(target.environment_id || 'default') !== [...environments][0]) return res.status(400).json({ error: 'Zielordner gehört zu einer anderen Umgebung.' });

  db.db.transaction(() => {
    const update = db.db.prepare('UPDATE servers SET group_id = ? WHERE id = ?');
    servers.forEach(server => update.run(groupId, server.id));
  })();
  db.auditLog.write('servers.group_bulk_move', `servers=${serverIds.length} group=${groupId || 'root'}`, req.ip, true, req.user?.username);
  res.json({ success: true, moved: serverIds.length, group_id: groupId });
});

// PUT /api/servers/:id/group
router.put('/:id/group', guardServerAccess, guard('canEditServers'), (req, res) => {
  const groupId = req.body.group_id ? String(req.body.group_id) : null;
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const target = groupId ? db.serverGroups.getAll().find(group => group.id === groupId) : null;
  if (groupId && !target) return res.status(400).json({ error: 'Zielordner nicht gefunden.' });
  if (target && !canAccessServerGroup(getPermissions(req.user), target)) return res.status(403).json({ error: 'Zielordnerzugriff verweigert.' });
  if (target && String(target.environment_id || 'default') !== String(server.environment_id || 'default')) return res.status(400).json({ error: 'Zielordner gehört zu einer anderen Umgebung.' });
  db.serverGroups.setServerGroup(req.params.id, groupId);
  res.json({ success: true });
});

// POST /api/servers/auto-group-by-tags
router.post('/auto-group-by-tags', guard('canEditServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const environmentId = req.environmentId || 'default';
    const allGroups = db.serverGroups.getAll(environmentId).filter(group => canAccessServerGroup(perms, group));
    const servers = filterServers(db.servers.getAll(environmentId), perms);
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
    const perms = getPermissions(req.user);
    const canViewUpdates = can(perms, 'canViewUpdates');
    const canViewDocker = can(perms, 'canViewDocker');
    const canViewCustomUpdates = can(perms, 'canViewCustomUpdates');
    const canViewHistory = can(perms, 'canViewServerHistory');
    const info = db.serverInfo.get(req.server.id);
    const imageUpdatesMeta = canViewDocker && canViewUpdates
      ? db.dockerImageUpdatesCache.getWithMeta(req.server.id)
      : null;
    const attention = buildServerAttention({
      server: req.server,
      info,
      updates: canViewUpdates ? (db.updatesCache.get(req.server.id) || []) : [],
      imageUpdates: imageUpdatesMeta?.results || null,
      customUpdatesCount: canViewCustomUpdates ? db.customUpdateTasks.countHasUpdate(req.server.id) : 0,
      history: canViewHistory ? db.updateHistory.getByServer(req.server.id) : [],
      alerts: db.resourceAlerts.list({ statuses: ['active'], serverIds: [req.server.id], limit: 200 }),
      includeUpdates: canViewUpdates,
      includeDockerUpdates: canViewDocker && canViewUpdates,
      includeCustomUpdates: canViewCustomUpdates,
      includeHistory: canViewHistory,
    });
    res.json({ ...parseServer(req.server), attention });
  } catch (error) {
    serverError(res, error, 'get server');
  }
});

// POST /api/servers - Add a new server
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddServers')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  try {
    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services, links, storage_mounts, environment_id } = req.body;
    if (!name || typeof name !== 'string' || !ip_address || typeof ip_address !== 'string') {
      return res.status(400).json({ error: 'Name and IP address are required' });
    }
    const normalizedName = name.trim();
    if (normalizedName.length > 100) return res.status(400).json({ error: 'Name too long (max 100)' });
    const nameErr = validateInventoryHostName(normalizedName);
    if (nameErr) return res.status(400).json({ error: nameErr });
    if (ip_address.length > 45) return res.status(400).json({ error: 'IP address too long (max 45)' });
    if (hostname && (typeof hostname !== 'string' || hostname.length > 255)) return res.status(400).json({ error: 'Hostname too long (max 255)' });
    if (ssh_user && (typeof ssh_user !== 'string' || ssh_user.length > 100)) return res.status(400).json({ error: 'SSH user too long (max 100)' });
    const normalizedLinks = normalizeServerLinks(links || []);
    const normalizedStorageMounts = normalizeStorageMounts(storage_mounts || []);
    const normalizedTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : [];
    const environmentId = req.environmentId || environment_id || 'default';
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const permissions = getPermissions(req.user);
    if (!canAccessEnvironment(permissions, environmentId)) return res.status(403).json({ error: 'Environment access denied' });
    const server = db.servers.create({
      name: normalizedName,
      hostname: (hostname || ip_address).slice(0, 255),
      ip_address: ip_address.slice(0, 45),
      ssh_port: Math.min(65535, Math.max(1, parseInt(ssh_port, 10) || 22)),
      ssh_user: (ssh_user || 'root').slice(0, 100),
      tags: normalizedTags,
      services: Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : [],
      links: normalizedLinks,
      storage_mounts: normalizedStorageMounts,
      environment_id: environmentId,
    });
    const autoGroupId = resolveGroupIdByTags(normalizedTags, accessibleGroupsForEnvironment(permissions, environmentId));
    if (autoGroupId) {
      db.serverGroups.setServerGroup(server.id, autoGroupId);
      server.group_id = autoGroupId;
    }
    db.auditLog.write('server.create', `Server "${normalizedName}" (${ip_address}) created`, req.ip, true, req.user?.username);
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

    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services, links, storage_mounts, dockerEnabled, environment_id } = req.body;
    const sName   = name !== undefined ? String(name).trim().slice(0, 100) : existing.name;
    if (name !== undefined) {
      const nameErr = validateInventoryHostName(sName);
      if (nameErr) return res.status(400).json({ error: nameErr });
    }
    const sHost   = hostname !== undefined ? String(hostname).slice(0, 255) : existing.hostname;
    const sIp     = ip_address !== undefined ? String(ip_address).slice(0, 45) : existing.ip_address;
    const sPort   = ssh_port !== undefined ? Math.min(65535, Math.max(1, parseInt(ssh_port, 10) || 22)) : existing.ssh_port;
    const sUser   = ssh_user !== undefined ? String(ssh_user).slice(0, 100) : existing.ssh_user;
    const sTags   = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : JSON.parse(existing.tags || '[]');
    const sSvcs   = Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : JSON.parse(existing.services || '[]');
    const sLinks  = links !== undefined ? normalizeServerLinks(links) : parseServerLinks(existing.links);
    const sMounts = storage_mounts !== undefined ? normalizeStorageMounts(storage_mounts) : parseConfiguredStorageMounts(existing.storage_mounts);
    const sDockerEnabled = dockerEnabled !== undefined ? (dockerEnabled ? 1 : 0) : (existing.docker_enabled || 0);
    const environmentId = environment_id !== undefined ? environment_id : (existing.environment_id || 'default');
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const permissions = getPermissions(req.user);
    if (!canAccessEnvironment(permissions, environmentId)) return res.status(403).json({ error: 'Environment access denied' });
    const server = db.servers.update(req.params.id, {
      name: sName, hostname: sHost, ip_address: sIp,
      ssh_port: sPort, ssh_user: sUser, tags: sTags, services: sSvcs,
      links: sLinks,
      storage_mounts: sMounts,
      docker_enabled: sDockerEnabled,
      environment_id: environmentId,
    });
    const environmentChanged = String(environmentId) !== String(existing.environment_id || 'default');
    if (environmentChanged && existing.group_id) {
      db.serverGroups.setServerGroup(req.params.id, null);
      server.group_id = null;
    }
    if (tags !== undefined) {
      const autoGroupId = resolveGroupIdByTags(sTags, accessibleGroupsForEnvironment(permissions, environmentId));
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
    // OpenTofu and imported Proxmox inventory mappings deliberately have no
    // database foreign key for backwards compatibility.
    // Remove them with the host so an old resource never remains as a broken
    // link in the infrastructure tree.
    try { db.db.prepare('DELETE FROM tofu_managed_servers WHERE server_id = ?').run(req.params.id); } catch { /* schema unavailable during partial migration */ }
    try { db.db.prepare('DELETE FROM proxmox_inventory_servers WHERE server_id = ?').run(req.params.id); } catch { /* schema unavailable during partial migration */ }
    db.auditLog.write('server.delete', `Server "${server.name}" (${server.ip_address}) deleted`, req.ip, true, req.user?.username);
    res.json({ message: 'Server deleted' });
  } catch (error) {
    serverError(res, error, 'delete server');
  }
});

// POST /api/servers/:id/test - Test SSH connection
const testConnectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many SSH test requests. Please slow down.' },
});
router.post('/:id/test', testConnectionLimiter, guardServerAccess, guard('canUseTerminal'), async (req, res) => {
  try {
    const server = req.server;
    const connected = await sshManager.testConnection(server);
    db.servers.updateStatus(server.id, connected ? 'online' : 'offline');
    resourceAlerts.evaluateServer(server.id);

    res.json({ connected, status: connected ? 'online' : 'offline' });
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'error');
    resourceAlerts.evaluateServer(req.params.id);
    log.warn({ err: error, serverId: req.params.id }, 'SSH test failed');
    res.json({ connected: false, status: 'error', error: 'Connection test failed' });
  }
});

// POST /api/servers/:id/reset-host-key - Remove stale known_hosts entries and clear stored host fingerprint
router.post('/:id/reset-host-key', guardServerAccess, guard('canUseTerminal'), (req, res) => {
  try {
    const server = req.server;
    const result = sshManager.removeKnownHostEntries([server.ip_address, server.hostname]);
    // Clear the trust-on-first-use fingerprint so the next connect re-learns it.
    try { db.servers.setHostFingerprint(server.id, ''); } catch {}
    db.auditLog.write(
      'server.reset_host_key',
      `server="${server.name}" removed=${result.removed.join(',') || '-'} missing=${result.missing.join(',') || '-'} fingerprint=cleared`,
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

// GET /api/servers/:id/alert-settings
router.get('/:id/alert-settings', guardServerAccess, guard('canViewServers'), (req, res) => {
  try {
    res.json(db.alertSettings.getByServer(req.params.id));
  } catch (error) {
    serverError(res, error, 'get alert settings');
  }
});

// PUT /api/servers/:id/alert-settings
router.put('/:id/alert-settings', guardServerAccess, guard('canEditServers'), (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      patch.enabled = body.enabled;
    }
    if (body.notify_enabled !== undefined) {
      if (typeof body.notify_enabled !== 'boolean') return res.status(400).json({ error: 'notify_enabled must be a boolean' });
      patch.notify_enabled = body.notify_enabled;
    }
    if (body.trigger_after_seconds !== undefined) {
      const seconds = Number(body.trigger_after_seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
        return res.status(400).json({ error: 'trigger_after_seconds must be between 0 and 86400' });
      }
      patch.trigger_after_seconds = Math.round(seconds);
    }
    if (body.thresholds !== undefined) {
      if (!body.thresholds || typeof body.thresholds !== 'object' || Array.isArray(body.thresholds)) {
        return res.status(400).json({ error: 'thresholds must be an object' });
      }
      const thresholds = {};
      for (const key of ['cpu', 'ram', 'disk', 'storage']) {
        if (body.thresholds[key] === undefined) continue;
        const value = Number(body.thresholds[key]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          return res.status(400).json({ error: `${key} threshold must be between 0 and 100` });
        }
        thresholds[key] = Math.round(value);
      }
      patch.thresholds = thresholds;
    }
    const settings = db.alertSettings.upsert(req.params.id, patch);
    resourceAlerts.evaluateServer(req.params.id);
    res.json(settings);
  } catch (error) {
    serverError(res, error, 'save alert settings');
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
    resourceAlerts.evaluateServer(req.params.id);
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
        resourceAlerts.evaluateServer(server.id);
        if (info.docker_detected && !server.docker_enabled) {
          db.servers.setDockerEnabled(server.id, 1);
        }
      })
      .catch(err => {
        log.debug({ err, server: server.name }, 'Background info refresh failed');
        try { db.servers.updateStatus(server.id, 'offline'); } catch (updateErr) {
          log.warn({ err: updateErr, server: server.name }, 'Failed to update server status to offline');
        }
        resourceAlerts.evaluateServer(server.id);
      });
    return;
  }

  // No cache yet (first visit) or forced refresh – wait for real data
  try {
    const info = await systemInfo.getSystemInfo(server);
    db.serverInfo.upsert(server.id, info);
    db.servers.updateStatus(server.id, 'online');
    resourceAlerts.evaluateServer(server.id);
    if (info.docker_detected && !server.docker_enabled) {
      db.servers.setDockerEnabled(server.id, 1);
    }
    res.json(info);
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'offline');
    resourceAlerts.evaluateServer(req.params.id);
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
      .then(updates => {
        db.updatesCache.set(server.id, updates);
        resourceAlerts.evaluateServer(server.id);
      })
      .catch(err => { log.debug({ err, server: server.name }, 'Background updates cache refresh failed'); });
    return;
  }

  try {
    const updates = await systemInfo.getAvailableUpdates(server);
    db.updatesCache.set(server.id, updates);
    resourceAlerts.evaluateServer(server.id);
    res.json(updates);
  } catch (error) {
    // A background refresh may use the last known result. A manually forced
    // check must instead report its failure so the UI never presents stale
    // data as a freshly completed package check.
    if (cached && !force) return res.json(cached);
    if (error.message && error.message.includes('SSH connection failed')) {
      return res.status(503).json({ error: error.message });
    }
    serverError(res, error, 'get server updates');
  }
});

// GET /api/servers/:id/history - Get update history + scheduled playbook runs
router.get('/:id/history', guardServerAccess, guard('canViewServerHistory'), (req, res) => {
  try {
    const server = req.server;
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

// refreshDockerCache moved to ../services/docker-inventory.js

// GET /api/servers/:id/docker - Get docker containers (stale-while-revalidate)
router.get('/:id/docker', guardServerAccess, guard('canViewDocker'), async (req, res) => {
  const server = req.server;

  const cached = buildDockerResponse(req.params.id);
  const force = req.query.force === '1';

  if (cached.length > 0 && !force) {
    res.json(cached.map(c => ({ ...c, _cached: true })));
    refreshDockerCache(server).catch(err => { log.debug({ err, server: server.name }, 'Background docker cache refresh failed'); });
    return;
  }

  try {
    const refreshed = await refreshDockerCache(server);
    if (!refreshed) {
      if (cached.length > 0) return res.json(cached.map(c => ({ ...c, _cached: true })));
      return res.status(502).json({ error: 'Docker-Inventar konnte auf diesem Host nicht geladen werden. Prüfe die SSH-Verbindung und Docker-Berechtigungen.' });
    }
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
  if (container.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(container) || container.startsWith('-')) {
    return res.status(400).json({ error: 'Invalid container name' });
  }

  const tailRaw = parseInt(req.query.tail, 10);
  const tail = Math.max(1, Math.min(Number.isFinite(tailRaw) ? tailRaw : 200, 2000));

  try {
    // A single-host read should not depend on a locally installed Ansible
    // binary. Use the same trusted SSH connection as Files and Terminal, then
    // elevate non-interactively only when the SSH user cannot access Docker.
    const command = [
      'runtime="$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)"',
      'if [ -z "$runtime" ]; then echo "Docker or Podman is not installed" >&2; exit 127; fi',
      `if [ "$(id -u)" -eq 0 ] || "$runtime" info >/dev/null 2>&1; then "$runtime" logs --tail ${tail} --timestamps -- '${container}' 2>&1`,
      `elif command -v sudo >/dev/null 2>&1; then sudo -n "$runtime" logs --tail ${tail} --timestamps -- '${container}' 2>&1`,
      'else echo "Docker access denied and sudo is unavailable" >&2; exit 126; fi',
    ].join('; ');
    const result = await sshManager.execCommand(server, command);
    if (result.code !== 0) {
      const detail = String(result.stdout || result.stderr || 'Failed to get container logs').trim().slice(-2000);
      return res.status(502).json({ error: detail || 'Failed to get container logs' });
    }
    res.json({ logs: result.stdout || '' });
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
    const result = await ansibleRunner.runPlaybook(
      'check-image-updates.yml',
      server.name,
      {},
      null,
      { environmentId: server.environment_id || 'default' },
    );
    const report = parseImageUpdateReport(result.stdout);
    if (!result.success || !report.complete) {
      log.warn({ server: server.name, exitCode: result.code }, 'Image update check returned no complete result');
      return res.status(502).json({ error: 'Image update check did not complete. Existing results were kept.' });
    }
    db.dockerImageUpdatesCache.set(server.id, report.results);
    resourceAlerts.evaluateServer(server.id);
    res.json(report.results);
  } catch (error) {
    serverError(res, error, 'get docker image updates');
  }
});


// GET /api/servers/:id/docker/compose - Read docker-compose.yml
router.get('/:id/docker/compose', guardServerAccess, guard('canManageDockerCompose'), async (req, res) => {
  try {
    const { path } = req.query;

    if (typeof path !== 'string' || path.length === 0) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
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
      { become: true, environmentId: server.environment_id || 'default' }
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
