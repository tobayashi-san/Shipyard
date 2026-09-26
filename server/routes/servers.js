const { collectionQueue } = require('../services/collection-queue');
const { hostAuditDetail } = require('../utils/host-audit');
const { validHistoryRange, matchesHistoryRange } = require('../utils/history-date-range');
const { compareHistory } = require('../utils/history-order');
const { updateCatalogAge } = require('../utils/update-catalog-age');
const { workflowHostIds } = require('../utils/workflow-history-scope');
const { parseSshPort } = require('../utils/ssh-port');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const log = require('../utils/logger').child('routes:servers');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');
const resourceAlerts = require('../services/resource-alerts');
const { serverError } = require('../utils/http-error');
const { validateInventoryHostName } = require('../utils/validate');
const { isValidStorageMountPath, parseConfiguredStorageMounts } = require('../utils/storage-mounts');
const { buildServerAttention } = require('../utils/server-attention');
const { hostGuest } = require('../features/opentofu/host-guest');

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

// VM identity belongs to an already authorized host; no live inventory lookup.
function hostVmId(serverId) {
  return hostGuest(serverId)?.vm_id ?? null;
}

// GET /api/servers - List all servers
// Cached operating state shared by inventory and host detail; never starts SSH work.
function serverOperatingState(server, perms) {
    const canViewUpdates = can(perms, 'canViewUpdates');
    const canViewDocker = can(perms, 'canViewDocker');
    const canViewCustomUpdates = can(perms, 'canViewCustomUpdates');
    const canViewHistory = can(perms, 'canViewServerHistory');
    let deployment = null;
    if (can(perms, 'canViewDeployments') && db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tofu_managed_servers'").get()) {
      deployment = db.db.prepare(`SELECT vm.id, run.status, run.deployment_phase
        FROM tofu_managed_servers mapping
        JOIN tofu_proxmox_vms vm ON vm.workspace_id = mapping.workspace_id
          AND mapping.resource_key = 'resource:proxmox_virtual_environment_vm.' || vm.name
        LEFT JOIN tofu_runs run ON run.id = (SELECT id FROM tofu_runs WHERE workspace_id = vm.workspace_id AND action = 'apply' ORDER BY started_at DESC, rowid DESC LIMIT 1)
        WHERE mapping.server_id = ? AND vm.is_isolated = 1 LIMIT 1`).get(server.id) || null;
    }
    const info = db.serverInfo.get(server.id);
    const imageUpdatesMeta = canViewDocker && canViewUpdates
      ? db.dockerImageUpdatesCache.getWithMeta(server.id)
      : null;
    const updatesMeta = canViewUpdates ? db.updatesCache.getWithMeta(server.id) : null;
    const updates = updatesMeta?.updates || null;
    const customUpdatesCount = canViewCustomUpdates ? db.customUpdateTasks.countHasUpdate(server.id) : 0;
    const attention = buildServerAttention({
      server,
      info,
      updates: updates || [],
      imageUpdates: imageUpdatesMeta?.results || null,
      customUpdatesCount,
      customCheckFailures: canViewCustomUpdates ? db.customUpdateTasks.countCheckFailures(server.id) : 0,
      history: canViewHistory ? db.updateHistory.getByServer(server.id) : [],
      alerts: db.resourceAlerts.list({ statuses: ['active'], serverIds: [server.id], limit: 200 }),
      includeUpdates: canViewUpdates,
      includeDockerUpdates: canViewDocker && canViewUpdates,
      includeCustomUpdates: canViewCustomUpdates,
      includeHistory: canViewHistory,
    });
    return {
      deployment,
      proxmox_vm_id: hostVmId(server.id),
      attention,
      ...(canViewUpdates ? {
        updates_count: updates === null ? null : updates.filter(update => !update.phased).length,
        updates_checked_at: updatesMeta?.updated_at || null,
        updates_stale: updateCatalogAge(updatesMeta?.updated_at, db.settings.get('poll_updates_interval_min')).stale,
        reboot_required: !!info?.reboot_required,
      } : {}),
      ...(canViewDocker && canViewUpdates ? {
        image_updates_count: imageUpdatesMeta ? imageUpdatesMeta.results.filter(update => update.status === 'update_available').length : null,
        image_updates_checked_at: imageUpdatesMeta?.updated_at || null,
        image_updates_stale: updateCatalogAge(imageUpdatesMeta?.updated_at, db.settings.get('poll_image_updates_interval_min') || 360).stale,
      } : {}),
      ...(canViewCustomUpdates ? { custom_updates_count: customUpdatesCount, custom_updates_stale: db.customUpdateTasks.getByServer(server.id).some(task => updateCatalogAge(task.last_checked_at, db.settings.get('poll_custom_updates_interval_min') || 360).stale) } : {}),
      info_cached_at: info?.updated_at || null,
      // Latest collected usage for the inventory list; the detail view keeps the full record.
      resources: info ? {
        ram_used_mb: info.ram_used_mb ?? null,
        ram_total_mb: info.ram_total_mb ?? null,
        disk_used_gb: info.disk_used_gb ?? null,
        disk_total_gb: info.disk_total_gb ?? null,
        os: info.os || null,
        uptime_seconds: info.uptime_seconds ?? null,
      } : null,
    };
}

router.get('/update-dashboard', require('../features/updates/dashboard'));
router.get('/update-history', require('../features/updates/history'));

router.get('/', guard('canViewServers'), (req, res) => {
  try {
    const perms = getPermissions(req.user);
    const environmentId = req.environmentId || String(req.query.environment_id || '').trim() || 'default';
    const servers = filterServers(db.servers.getAll(), perms)
      .filter(server => String(server.environment_id || 'default') === environmentId);
    res.json(servers.map(server => ({ ...parseServer(server), ...serverOperatingState(server, perms) })));
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
          ssh_port:  parseSshPort(s.ssh_port),
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
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found.' });
  const parent = parent_id ? db.db.prepare('SELECT * FROM server_groups WHERE id = ?').get(String(parent_id)) : null;
  if (parent_id && (!parent || parent.environment_id !== environmentId)) return res.status(400).json({ error: 'The parent folder belongs to a different environment.' });
  const perms = getPermissions(req.user);
  // A restricted operator may add a child folder only below an explicitly
  // assigned folder.  Root folders remain an environment administration task.
  if (!perms?.full && perms?.servers !== 'all' && (!parent || !canAccessServerGroup(perms, parent))) {
    return res.status(403).json({ error: 'Folders may only be created inside an assigned folder.' });
  }
  res.json(db.serverGroups.create(name.trim(), color, parent_id || null, environmentId));
});

// Validate moves before either metadata or hierarchy is written. Keeping an
// existing parent does not require administration rights on that ancestor.
function validateGroupParent(req, parentId) {
  const groupId = String(req.params.groupId || '');
  const groups = db.serverGroups.getAll();
  const current = groups.find(group => group.id === groupId);
  if (!current) return { status: 404, error: 'Folder not found.' };
  if (parentId === current.parent_id) return null;
  const parent = parentId ? groups.find(group => group.id === parentId) : null;
  if (parentId && !parent) return { status: 400, error: 'Parent folder not found.' };
  if (parent && !canAccessServerGroup(getPermissions(req.user), parent)) return { status: 403, error: 'Target folder access denied.' };
  if (parent && parent.environment_id !== current.environment_id) return { status: 400, error: 'Folders cannot be nested across environments.' };
  if (parentId === groupId) return { status: 400, error: 'A folder cannot be its own parent.' };
  const descendantIds = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.parent_id && descendantIds.has(group.parent_id) && !descendantIds.has(group.id)) {
        descendantIds.add(group.id);
        changed = true;
      }
    }
  }
  if (parentId && descendantIds.has(parentId)) return { status: 400, error: 'A folder cannot be moved into one of its descendants.' };
  return null;
}

// PUT /api/servers/groups/:groupId
router.put('/groups/:groupId', guard('canEditServers'), guardServerGroupAccess, (req, res) => {
  const { name, color } = req.body;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const hasParent = Object.prototype.hasOwnProperty.call(req.body, 'parent_id');
  if (hasParent && req.body.parent_id !== null && (typeof req.body.parent_id !== 'string' || !req.body.parent_id.trim())) {
    return res.status(400).json({ error: 'Parent folder must be an ID or null.' });
  }
  const parentId = hasParent ? req.body.parent_id : undefined;
  if (hasParent) {
    const failure = validateGroupParent(req, parentId);
    if (failure) return res.status(failure.status).json({ error: failure.error });
  }
  db.db.transaction(() => {
    db.serverGroups.update(req.params.groupId, name.trim(), color);
    if (hasParent) db.serverGroups.setGroupParent(req.params.groupId, parentId);
  })();
  res.json({ success: true });
});

// DELETE /api/servers/groups/:groupId
router.delete('/groups/:groupId', guard('canDeleteServers'), guardServerGroupAccess, (req, res) => {
  db.serverGroups.delete(req.params.groupId);
  res.json({ success: true });
});

// PUT /api/servers/groups/:groupId/parent
router.put('/groups/:groupId/parent', guard('canEditServers'), guardServerGroupAccess, (req, res) => {
  const parentId = req.body.parent_id ? String(req.body.parent_id) : null;
  const failure = validateGroupParent(req, parentId);
  if (failure) return res.status(failure.status).json({ error: failure.error });
  db.serverGroups.setGroupParent(req.params.groupId, parentId);
  res.json({ success: true });
});

// PUT /api/servers/group/bulk — move a checked set without issuing a partial
// update.  Every host and the target folder must be accessible to the caller.
router.put('/group/bulk', guard('canEditServers'), (req, res) => {
  const serverIds = [...new Set((Array.isArray(req.body?.server_ids) ? req.body.server_ids : [])
    .map(value => String(value || '').trim()).filter(Boolean))];
  const groupId = req.body?.group_id ? String(req.body.group_id) : null;
  if (serverIds.length === 0 || serverIds.length > 500) return res.status(400).json({ error: 'Select between 1 and 500 hosts.' });

  const placeholders = serverIds.map(() => '?').join(',');
  const servers = db.db.prepare(`SELECT * FROM servers WHERE id IN (${placeholders})`).all(...serverIds);
  if (servers.length !== serverIds.length) return res.status(404).json({ error: 'At least one host was not found.' });
  if (req.environmentId && servers.some(server => String(server.environment_id || 'default') !== req.environmentId)) {
    return res.status(404).json({ error: 'At least one host was not found.' });
  }
  const permissions = getPermissions(req.user);
  if (filterServers(servers, permissions).length !== servers.length) return res.status(403).json({ error: 'At least one host is outside your permissions.' });

  const environments = new Set(servers.map(server => String(server.environment_id || 'default')));
  if (environments.size !== 1) return res.status(400).json({ error: 'Hosts from different environments cannot be moved together.' });
  const target = groupId ? db.db.prepare('SELECT * FROM server_groups WHERE id = ?').get(groupId) : null;
  if (groupId && !target) return res.status(400).json({ error: 'Target folder not found.' });
  if (target && !canAccessServerGroup(permissions, target)) return res.status(403).json({ error: 'Target folder access denied.' });
  if (target && String(target.environment_id || 'default') !== [...environments][0]) return res.status(400).json({ error: 'The target folder belongs to a different environment.' });

  db.db.transaction(() => {
    const update = db.db.prepare('UPDATE servers SET group_id = ? WHERE id = ?');
    servers.forEach(server => update.run(groupId, server.id));
  })();
  db.auditLog.write('servers.group_bulk_move', `servers=${serverIds.length} group=${groupId || 'root'} targets=${servers.map(server=>server.name).join(',')}`, req.ip, true, req.user?.username, [...environments][0]);
  res.json({ success: true, moved: serverIds.length, group_id: groupId });
});

// PUT /api/servers/:id/group
router.put('/:id/group', guardServerAccess, guard('canEditServers'), (req, res) => {
  const groupId = req.body.group_id ? String(req.body.group_id) : null;
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const target = groupId ? db.serverGroups.getAll().find(group => group.id === groupId) : null;
  if (groupId && !target) return res.status(400).json({ error: 'Target folder not found.' });
  if (target && !canAccessServerGroup(getPermissions(req.user), target)) return res.status(403).json({ error: 'Target folder access denied.' });
  if (target && String(target.environment_id || 'default') !== String(server.environment_id || 'default')) return res.status(400).json({ error: 'The target folder belongs to a different environment.' });
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
    res.json({ ...parseServer(req.server), ...serverOperatingState(req.server, perms) });
  } catch (error) {
    serverError(res, error, 'get server');
  }
});

// POST /api/servers - Add a new server
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddServers')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  try {
    const { name, hostname, ip_address, ssh_port, ssh_user, owner, tags, services, links, storage_mounts, environment_id } = req.body;
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
    if (owner != null && (typeof owner !== 'string' || owner.length > 100)) return res.status(400).json({ error: 'Owner too long (max 100)' });
    const normalizedLinks = normalizeServerLinks(links || []);
    const normalizedStorageMounts = normalizeStorageMounts(storage_mounts || []);
    const normalizedTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : [];
    const environmentId = req.environmentId || environment_id || 'default';
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const permissions = getPermissions(req.user);
    if (!canAccessEnvironment(permissions, environmentId)) return res.status(403).json({ error: 'Environment access denied' });
    const server = db.db.transaction(() => {
    const created = db.servers.create({
      name: normalizedName,
      hostname: (hostname || ip_address).slice(0, 255),
      ip_address: ip_address.slice(0, 45),
      ssh_port: parseSshPort(ssh_port),
      ssh_user: (ssh_user || 'root').slice(0, 100),
      owner: String(owner || '').trim().slice(0, 100),
      tags: normalizedTags,
      services: Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : [],
      links: normalizedLinks,
      storage_mounts: normalizedStorageMounts,
      environment_id: environmentId,
    });
    const autoGroupId = resolveGroupIdByTags(normalizedTags, accessibleGroupsForEnvironment(permissions, environmentId));
    if (autoGroupId) {
      db.serverGroups.setServerGroup(created.id, autoGroupId);
      created.group_id = autoGroupId;
    }
    db.auditLog.write('server.create', `Server ${JSON.stringify(normalizedName)} (${ip_address}) created; server_id=${JSON.stringify(created.id)}`, req.ip, true, req.user?.username, environmentId);
    return created;
    })();
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

    const { name, hostname, ip_address, ssh_port, ssh_user, owner, tags, services, links, storage_mounts, dockerEnabled, environment_id } = req.body;
    const sName   = name !== undefined ? String(name).trim().slice(0, 100) : existing.name;
    if (name !== undefined) {
      const nameErr = validateInventoryHostName(sName);
      if (nameErr) return res.status(400).json({ error: nameErr });
    }
    const sHost   = hostname !== undefined ? String(hostname).slice(0, 255) : existing.hostname;
    const sIp     = ip_address !== undefined ? String(ip_address).slice(0, 45) : existing.ip_address;
    const sPort   = ssh_port !== undefined ? parseSshPort(ssh_port) : existing.ssh_port;
    const sUser   = ssh_user !== undefined ? String(ssh_user).slice(0, 100) : existing.ssh_user;
    const sOwner  = owner !== undefined ? String(owner).trim().slice(0, 100) : (existing.owner || '');
    const sTags   = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)) : JSON.parse(existing.tags || '[]');
    const sSvcs   = Array.isArray(services) ? services.filter(s => typeof s === 'string').map(s => s.slice(0, 100)) : JSON.parse(existing.services || '[]');
    const sLinks  = links !== undefined ? normalizeServerLinks(links) : parseServerLinks(existing.links);
    const sMounts = storage_mounts !== undefined ? normalizeStorageMounts(storage_mounts) : parseConfiguredStorageMounts(existing.storage_mounts);
    const sDockerEnabled = dockerEnabled !== undefined ? (dockerEnabled ? 1 : 0) : (existing.docker_enabled || 0);
    const environmentId = environment_id !== undefined ? environment_id : (existing.environment_id || 'default');
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const permissions = getPermissions(req.user);
    if (!canAccessEnvironment(permissions, environmentId)) return res.status(403).json({ error: 'Environment access denied' });
    const server = db.db.transaction(() => {
    const updated = db.servers.update(req.params.id, {
      name: sName, hostname: sHost, ip_address: sIp,
      ssh_port: sPort, ssh_user: sUser, owner: sOwner, tags: sTags, services: sSvcs,
      links: sLinks,
      storage_mounts: sMounts,
      docker_enabled: sDockerEnabled,
      environment_id: environmentId,
    });
    const environmentChanged = String(environmentId) !== String(existing.environment_id || 'default');
    if (environmentChanged && existing.group_id) {
      db.serverGroups.setServerGroup(req.params.id, null);
      updated.group_id = null;
    }
    if (tags !== undefined) {
      const autoGroupId = resolveGroupIdByTags(sTags, accessibleGroupsForEnvironment(permissions, environmentId));
      if (autoGroupId && autoGroupId !== existing.group_id) {
        db.serverGroups.setServerGroup(req.params.id, autoGroupId);
        updated.group_id = autoGroupId;
      }
    }
    const current = db.servers.getById(req.params.id);
    const detail = hostAuditDetail(existing, current);
    if (JSON.parse(detail).changes.length) db.auditLog.write('server.update', detail, req.ip, true, req.user?.username, environmentId);
    return current;
    })();
    res.json(parseServer(server));
    // Mount usage is measured by the info collection; measure new or changed
    // mounts now instead of waiting for the next polling interval.
    const mountsChanged = JSON.stringify(sMounts) !== JSON.stringify(parseConfiguredStorageMounts(existing.storage_mounts));
    if (mountsChanged && server.status === 'online') {
      collectionQueue.run('info', server, () => systemInfo.getSystemInfo(server), {priority:1,baseMs:require('../services/scheduler').getPollingConfig().info.intervalMs})
        .then(info => { db.serverInfo.upsert(server.id, info); resourceAlerts.evaluateServer(server.id); })
        .catch(err => log.debug({ err, server: server.name }, 'Storage mount refresh after host update failed'));
    }
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'update server');
  }
});

// DELETE /api/servers/:id - Delete server
router.delete('/:id', guardServerAccess, guard('canDeleteServers'), (req, res) => {
  try {
    const server = req.server;
    db.db.transaction(() => {
      db.servers.delete(req.params.id);
      // Old installations may not have inventory integration tables yet.
      for (const table of ['tofu_managed_servers', 'proxmox_inventory_servers']) {
        if (db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          db.db.prepare(`DELETE FROM ${table} WHERE server_id = ?`).run(req.params.id);
        }
      }
      db.auditLog.write('server.delete', `Server ${JSON.stringify(server.name)} (${server.ip_address}) deleted; server_id=${JSON.stringify(server.id)}`, req.ip, true, req.user?.username, server.environment_id || 'default');
    })();
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
router.post('/connection-test', testConnectionLimiter, guard('canEditServers'), async (req, res) => {
  const ipAddress = String(req.body?.ip_address || '').trim();
  const sshUser = String(req.body?.ssh_user || 'root').trim() || 'root';
  const password = String(req.body?.password || '');
  let sshPort;
  try { sshPort = parseSshPort(req.body?.ssh_port); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!ipAddress || !password) return res.status(400).json({ error: 'Host address and password are required.' });
  try {
    const connected = await sshManager.testPasswordConnection(ipAddress, sshUser, password, sshPort);
    res.json({ connected });
  } catch (error) {
    log.warn({ err: error, host: ipAddress }, 'Pre-save SSH test failed');
    res.json({ connected: false, error: 'Connection test failed. Check the address, port, username, and password.' });
  }
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
    const last = db.db.prepare('SELECT revision, author, created_at FROM server_note_revisions WHERE server_id = ? ORDER BY revision DESC LIMIT 1').get(req.params.id);
    res.json({ notes: req.server.notes || '', revision: last?.revision || 0, author: last?.author || null, updated_at: last?.created_at || null });
  } catch (error) {
    serverError(res, error, 'get server notes');
  }
});

router.get('/:id/notes/history', guardServerAccess, guard('canViewNotes'), (req, res) => {
  const revisions = db.db.prepare('SELECT revision, notes, author, created_at FROM server_note_revisions WHERE server_id = ? ORDER BY revision DESC LIMIT 100').all(req.params.id);
  res.json({ revisions });
});

// PUT /api/servers/:id/notes
router.put('/:id/notes', guardServerAccess, guard('canEditNotes'), (req, res) => {
  try {
    if (typeof req.body.notes !== 'string' || req.body.notes.length > 5000) return res.status(400).json({ error: 'Notes must be text with at most 5000 characters.' });
    if (!Number.isInteger(req.body.revision) || req.body.revision < 0) return res.status(428).json({ error: 'Load the current notes revision before saving.' });
    const result = db.db.transaction(() => {
      const last = db.db.prepare('SELECT revision FROM server_note_revisions WHERE server_id = ? ORDER BY revision DESC LIMIT 1').get(req.params.id);
      if ((last?.revision || 0) !== req.body.revision) return null;
      const current = db.db.prepare('SELECT notes FROM servers WHERE id = ?').get(req.params.id);
      if (!last) db.db.prepare('INSERT INTO server_note_revisions (server_id, revision, notes) VALUES (?, 0, ?)').run(req.params.id, current.notes || '');
      const revision = req.body.revision + 1;
      const updated_at = new Date().toISOString();
      const author = req.user?.username || 'Unknown user';
      db.servers.setNotes(req.params.id, req.body.notes);
      db.db.prepare('INSERT INTO server_note_revisions (server_id, revision, notes, author, created_at) VALUES (?, ?, ?, ?, ?)').run(req.params.id, revision, req.body.notes, author, updated_at);
      db.db.prepare('DELETE FROM server_note_revisions WHERE server_id = ? AND revision <= ?').run(req.params.id, revision - 100);
      db.auditLog.write('server.notes_update', `server_id=${JSON.stringify(req.params.id)} server=${JSON.stringify(req.server.name)} from_revision=${req.body.revision} to_revision=${revision}`, req.ip, true, author, req.server.environment_id);
      return { notes: req.body.notes, revision, author, updated_at };
    })();
    if (!result) return res.status(409).json({ error: 'Notes changed since you opened them. Copy your draft, reload the saved notes, and merge your changes.' });
    res.json(result);
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
  // Serve cache immediately, refresh in background
  if (cached && !force) {
    const isOnline = server.status === 'online';
    // `_refreshing` is true only when this request actually starts a background collection.
    const refreshing = collectionQueue.due('info', server, {active:true});
    const payload = { ...cached, _cached: true, _refreshing: refreshing, _source: 'ssh' };
    if (!isOnline) {
      payload.ram_used_mb = null;
      payload.disk_used_gb = null;
      payload.cpu_usage_pct = null;
      payload.load_avg = null;
      payload.uptime_seconds = null;
    }
    res.json(payload);
    if (!refreshing) return;
    collectionQueue.run('info', server, () => systemInfo.getSystemInfo(server), {priority:1,baseMs:require('../services/scheduler').getPollingConfig().info.intervalMs})
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
        try { if (!['COLLECTION_QUEUE_FULL', 'SSH_QUEUE_FULL', 'SSH_QUEUE_TIMEOUT'].includes(err.code)) db.servers.updateStatus(server.id, 'offline'); } catch (updateErr) {
          log.warn({ err: updateErr, server: server.name }, 'Failed to update server status to offline');
        }
        resourceAlerts.evaluateServer(server.id);
      });
    return;
  }

  // No cache yet (first visit) or forced refresh – wait for real data
  try {
    const info = await collectionQueue.run('info', server, () => systemInfo.getSystemInfo(server), {priority:2,baseMs:require('../services/scheduler').getPollingConfig().info.intervalMs});
    db.serverInfo.upsert(server.id, info);
    db.servers.updateStatus(server.id, 'online');
    resourceAlerts.evaluateServer(server.id);
    if (info.docker_detected && !server.docker_enabled) {
      db.servers.setDockerEnabled(server.id, 1);
    }
    res.json({ ...db.serverInfo.get(server.id), _source: 'ssh' });
  } catch (error) {
    if (['COLLECTION_QUEUE_FULL', 'SSH_QUEUE_FULL', 'SSH_QUEUE_TIMEOUT'].includes(error.code)) return res.status(503).json({error:error.message});
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

// A fresh, uncached simulation. It refreshes package metadata but never
// installs/removes packages, records update history or changes the catalog.
router.get('/:id/updates/preview', guardServerAccess, guard('canViewUpdates'), rateLimit({
  windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false,
}), async (req, res) => {
  try {
    res.json(await systemInfo.getAvailableUpdates(req.server, { includePlan: true }));
  } catch (error) {
    serverError(res, error, 'preview server updates');
  }
});

// GET /api/servers/:id/updates - Get available updates (stale-while-revalidate)
router.get('/:id/updates', guardServerAccess, guard('canViewUpdates'), async (req, res) => {
  const server = req.server;

  const cached = db.updatesCache.get(req.params.id);
  const force = req.query.force === '1';
  const respond = (updates, cachedResult) => {
    if (req.query.include_meta !== '1') return res.json(cachedResult ? updates.map(update => ({ ...update, _cached: true })) : updates);
    const meta = db.db.prepare('SELECT updated_at FROM server_updates_cache WHERE server_id = ?').get(server.id);
    return res.json({ updates, source: 'Host package manager over SSH', updated_at: meta?.updated_at || null, cached: cachedResult, ...updateCatalogAge(meta?.updated_at, db.settings.get('poll_updates_interval_min')) });
  };


  if (cached && !force) {
    respond(cached, true);
    if (!collectionQueue.due('updates', server)) return;
    collectionQueue.run('updates', server, () => systemInfo.getAvailableUpdates(server), {priority:1,baseMs:require('../services/scheduler').getPollingConfig().updates.intervalMs})
      .then(updates => {
        db.updatesCache.set(server.id, updates);
        resourceAlerts.evaluateServer(server.id);
      })
      .catch(err => { db.checkAttempts.failed(server.id, 'os', 'Package check failed. Check host connectivity and package manager access.'); log.debug({ err, server: server.name }, 'Background updates cache refresh failed'); });
    return;
  }

  try {
    const updates = await collectionQueue.run('updates', server, () => systemInfo.getAvailableUpdates(server), {priority:2,baseMs:require('../services/scheduler').getPollingConfig().updates.intervalMs});
    db.updatesCache.set(server.id, updates);
    resourceAlerts.evaluateServer(server.id);
    respond(updates, false);
  } catch (error) {
    db.checkAttempts.failed(server.id, 'os', 'Package check failed. Check host connectivity and package manager access.');
    // A background refresh may use the last known result. A manually forced
    // check must instead report its failure so the UI never presents stale
    // data as a freshly completed package check.
    if (cached && !force) return respond(cached, true);
    if (error.message && error.message.includes('SSH connection failed')) {
      return res.status(503).json({ error: error.message });
    }
    serverError(res, error, 'get server updates');
  }
});

// GET /api/servers/:id/history - Get update history + scheduled playbook runs
// A log dialog follows its run independently of list filters and pagination.
router.get('/:id/history/:source/:runId', guardServerAccess, guard('canViewServerHistory'), (req, res) => {
  try {
    const { source, runId } = req.params;
    if (source === 'manual') {
      const row = db.db.prepare('SELECT * FROM update_history WHERE id = ? AND server_id = ?').get(runId, req.server.id);
      return row ? res.json(row) : res.status(404).json({ error: 'History run not found' });
    }
    if (source === 'schedule') {
      const row = db.scheduleHistory.getById(runId);
      if (!row || row.environment_id !== (req.server.environment_id || 'default') || !workflowHostIds(row)?.includes(req.server.id)) {
        return res.status(404).json({ error: 'History run not found' });
      }
      return res.json({ id: row.id, server_id: req.server.id, action: row.playbook, playbook: row.playbook, schedule_name: row.schedule_name, triggered_by: row.schedule_name || 'schedule', status: row.status, started_at: row.started_at, completed_at: row.completed_at, output: row.output, _type: 'schedule' });
    }
    return res.status(400).json({ error: 'Invalid history source' });
  } catch (error) {
    serverError(res, error, 'get server history run');
  }
});

router.get('/:id/history', guardServerAccess, guard('canViewServerHistory'), (req, res) => {
  try {
    const server = req.server;
    const paginated = req.query.page !== undefined;
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
    const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const manualHistory = paginated
      ? db.db.prepare('SELECT id, server_id, server_name_snapshot, environment_id, action, status, started_at, completed_at, triggered_by FROM update_history WHERE server_id = ? ORDER BY started_at DESC, id DESC').all(req.params.id)
      : db.updateHistory.getByServer(req.params.id);

    // Also fetch scheduled playbook runs that targeted this server
    let scheduleRuns = [];
    if (server) {
      const allRuns = db.scheduleHistory.getAll(-1, null, server.environment_id || 'default');
      scheduleRuns = allRuns
        .filter(r => workflowHostIds(r)?.includes(server.id))
        .slice(0, paginated ? undefined : 200)
        .map(r => ({
          id: r.id,
          server_id: req.params.id,
          action: r.playbook,
          triggered_by: r.schedule_name || 'schedule',
          status: r.status,
          started_at: r.started_at,
          completed_at: r.completed_at,
          output: r.output,
          _type: 'schedule',
          schedule_name: r.schedule_name,
          playbook: r.playbook,
        }));
    }

    // Read outputs only after host scoping. Unfiltered pagination needs logs for
    // the visible page only; text searches inspect one log at a time.
    const manualOutput = db.db.prepare('SELECT output FROM update_history WHERE id = ? AND server_id = ?');
    const scheduleOutput = db.db.prepare('SELECT output FROM schedule_history WHERE id = ? AND environment_id = ?');
    const readOutput = row => row._type === 'schedule'
      ? scheduleOutput.get(row.id, server.environment_id || 'default')?.output
      : manualOutput.get(row.id, req.params.id)?.output;
    const withOutput = row => ({ ...row, output: readOutput(row) });

    // Merge and sort by started_at descending
    let combined = [...manualHistory, ...scheduleRuns]
      .sort(compareHistory);

    if (paginated) {
      const action = String(req.query.action || '');
      const status = String(req.query.status || '');
      const search = String(req.query.search || '').trim().toLowerCase();
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!validHistoryRange(from, to)) return res.status(400).json({ error: 'Invalid history date range' });
      const actions = [...new Set(combined.map(row => row.action).filter(Boolean))].sort();
      const totalUnfiltered = combined.length;
      combined = combined.filter(row => {
        if (action && row.action !== action) return false;
        if (status && row.status !== status) return false;
        if (search && ![row.action, row.triggered_by, readOutput(row), row.playbook].filter(Boolean).join(' ').toLowerCase().includes(search)) return false;
        if (!matchesHistoryRange(row.started_at, from, to)) return false;
        return true;
      });
      const totalPages = Math.max(1, Math.ceil(combined.length / pageSize));
      const page = Math.min(requestedPage, totalPages);
      return res.json({ actions, total_unfiltered: totalUnfiltered, items: combined.slice((page - 1) * pageSize, page * pageSize).map(withOutput), pagination: {
        page, page_size: pageSize, total: combined.length, total_pages: totalPages,
        has_prev: page > 1, has_next: page < totalPages,
      } });
    }
    res.json(combined.map(withOutput));
  } catch (error) {
    serverError(res, error, 'get server history');
  }
});

router.use(require('./server-docker'));

module.exports = router;
