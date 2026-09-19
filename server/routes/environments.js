const express = require('express');
const db = require('../db');
const { getPermissions, filterServers, can, canAccessEnvironment } = require('../utils/permissions');
const scheduler = require('../services/scheduler');
const { serverError } = require('../utils/http-error');

const router = express.Router();
const isAdmin = (req) => req.user?.role === 'admin';
const hasTable = (name) => Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

function consolidationConflict(environmentId) {
  const checks = [
    {
      table: 'ipam_subnets',
      sql: `SELECT source.cidr AS value FROM ipam_subnets source
        JOIN ipam_subnets target ON target.environment_id = 'default' AND target.cidr = source.cidr
        WHERE source.environment_id = ? LIMIT 1`,
      label: 'IPAM prefix',
    },
    {
      table: 'ansible_vars',
      sql: `SELECT source.key AS value FROM ansible_vars source
        JOIN ansible_vars target ON target.environment_id = 'default' AND target.key = source.key
        WHERE source.environment_id = ? LIMIT 1`,
      label: 'Ansible variable',
    },
    {
      table: 'tofu_proxmox_connections',
      sql: `SELECT source.name AS value FROM tofu_proxmox_connections source
        JOIN tofu_proxmox_connections target ON target.environment_id = 'default' AND target.name = source.name
        WHERE source.environment_id = ? LIMIT 1`,
      label: 'platform connection',
    },
  ];
  for (const check of checks) {
    if (!hasTable(check.table)) continue;
    const conflict = db.db.prepare(check.sql).get(environmentId);
    if (conflict) return `${check.label} "${conflict.value}" already exists in the default environment.`;
  }
  return null;
}

function moveEnvironmentRows(table, environmentId, extraSet = '') {
  if (!hasTable(table)) return;
  db.db.prepare(`UPDATE ${table} SET environment_id = 'default'${extraSet} WHERE environment_id = ?`).run(environmentId);
}

router.get('/', (req, res) => {
  const deploymentCount = hasTable('tofu_workspaces')
    ? "COUNT(DISTINCT w.id) AS deployment_count"
    : '0 AS deployment_count';
  const workspaceJoin = hasTable('tofu_workspaces')
    ? 'LEFT JOIN tofu_workspaces w ON w.environment_id = e.id'
    : '';
  const rows = db.db.prepare(`SELECT e.id, e.name, COUNT(DISTINCT s.id) AS server_count, ${deploymentCount} FROM environments e LEFT JOIN servers s ON s.environment_id = e.id ${workspaceJoin} GROUP BY e.id ORDER BY e.name`).all();
  const permissions = getPermissions(req.user);
  const canSeeDefinitions = can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments');
  const definitionCounts = new Map(hasTable('tofu_proxmox_vms') && hasTable('tofu_workspaces')
    ? db.db.prepare(`SELECT w.environment_id, COUNT(*) AS count FROM tofu_proxmox_vms vm JOIN tofu_workspaces w ON w.id = vm.workspace_id WHERE vm.is_isolated = 1 GROUP BY w.environment_id`).all().map(row => [row.environment_id, row.count])
    : []);
  res.json(rows
    .filter(row => canAccessEnvironment(permissions, row.id))
    .map(row => ({
      ...row,
      vm_definition_count: canSeeDefinitions ? (definitionCounts.get(row.id) || 0) : undefined,
      server_count: filterServers(db.servers.getAll(row.id), permissions).length,
      deployment_count: can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments')
        ? row.deployment_count
        : undefined,
    })));
});

router.post('/', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Name must contain 1 to 80 characters.', field: 'name' });
  const id = db.uuidv4();
  try { db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(id, name); res.status(201).json({ id, name, server_count: 0 }); }
  catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An environment with this name already exists.', field: 'name' });
    serverError(res, error, 'create environment');
  }
});

router.put('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Name must contain 1 to 80 characters.', field: 'name' });
  try {
    const result = db.db.prepare('UPDATE environments SET name = ? WHERE id = ?').run(name, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An environment with this name already exists.', field: 'name' });
    serverError(res, error, 'rename environment');
  }
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  if (req.params.id === 'default') return res.status(400).json({ error: 'Default environment cannot be deleted' });
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Environment not found' });
  }
  const conflict = consolidationConflict(req.params.id);
  if (conflict) return res.status(409).json({ error: `Environment cannot be consolidated: ${conflict}` });

  const scheduleIds = hasTable('schedules')
    ? db.db.prepare('SELECT id FROM schedules WHERE environment_id = ?').all(req.params.id).map(row => row.id)
    : [];
  try {
    const remove = db.db.transaction((id) => {
      // Move every environment-scoped row before deleting the parent. This
      // preserves folder relationships and prevents FK cascades or invisible
      // rows that still point at an environment which no longer exists.
      moveEnvironmentRows('servers', id);
      moveEnvironmentRows('server_groups', id);
      moveEnvironmentRows('ssh_key_assignments', id);
      moveEnvironmentRows('schedules', id);
      moveEnvironmentRows('schedule_history', id);
      moveEnvironmentRows('update_history', id);
      moveEnvironmentRows('audit_log', id);
      moveEnvironmentRows('proxmox_guest_audit', id);
      moveEnvironmentRows('proxmox_object_audit', id);
      moveEnvironmentRows('proxmox_guest_tasks', id);
      moveEnvironmentRows('operation_acknowledgements', id);
      moveEnvironmentRows('ansible_vars', id);
      moveEnvironmentRows('variable_change_events', id);
      if (hasTable('variable_change_events')) db.db.prepare("DELETE FROM variable_change_events WHERE environment_id = 'default' AND id NOT IN (SELECT id FROM variable_change_events WHERE environment_id = 'default' ORDER BY id DESC LIMIT 1000)").run();
      moveEnvironmentRows('ipam_subnets', id);
      moveEnvironmentRows('ipam_source_observations', id);
      moveEnvironmentRows('ipam_sync_sources', id, ", updated_at = datetime('now')");
      moveEnvironmentRows('ipam_sync_conflicts', id);
      moveEnvironmentRows('ipam_proxmox_sync_conflicts', id);
      moveEnvironmentRows('maintenance_windows', id);
      moveEnvironmentRows('tofu_workspaces', id);
      moveEnvironmentRows('tofu_proxmox_connections', id);
      const result = db.db.prepare('DELETE FROM environments WHERE id = ?').run(id);
      db.auditLog.write('environment.delete', `environment=${id} consolidated_into=default`, req.ip, true, req.user?.username, 'default');
      return result;
    });
    const result = remove(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
    for (const scheduleId of scheduleIds) {
      try { scheduler.reload(scheduleId); } catch { /* the persisted schedule remains available for the next scheduler reload */ }
    }
    res.json({ success: true, consolidated_into: 'default' });
  } catch (error) {
    serverError(res, error, 'delete environment');
  }
});

module.exports = router;
