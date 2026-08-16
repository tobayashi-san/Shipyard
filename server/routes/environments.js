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
  res.json(rows
    .filter(row => canAccessEnvironment(permissions, row.id))
    .map(row => ({
      ...row,
      server_count: filterServers(db.servers.getAll(row.id), permissions).length,
      deployment_count: can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments')
        ? row.deployment_count
        : undefined,
    })));
});

router.post('/', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = db.uuidv4();
  try { db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(id, name); res.status(201).json({ id, name, server_count: 0 }); }
  catch { res.status(409).json({ error: 'Environment already exists' }); }
});

router.put('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = db.db.prepare('UPDATE environments SET name = ? WHERE id = ?').run(name, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
  res.json({ success: true });
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
      moveEnvironmentRows('ansible_vars', id);
      moveEnvironmentRows('ipam_subnets', id);
      moveEnvironmentRows('ipam_source_observations', id);
      moveEnvironmentRows('ipam_sync_sources', id, ", updated_at = datetime('now')");
      moveEnvironmentRows('ipam_sync_conflicts', id);
      moveEnvironmentRows('ipam_proxmox_sync_conflicts', id);
      moveEnvironmentRows('maintenance_windows', id);
      moveEnvironmentRows('tofu_workspaces', id);
      moveEnvironmentRows('tofu_proxmox_connections', id);
      return db.db.prepare('DELETE FROM environments WHERE id = ?').run(id);
    });
    const result = remove(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
    for (const scheduleId of scheduleIds) {
      try { scheduler.reload(scheduleId); } catch { /* the persisted schedule remains available for the next scheduler reload */ }
    }
    db.auditLog.write('environment.delete', `environment=${req.params.id} consolidated_into=default`, req.ip, true, req.user?.username);
    res.json({ success: true, consolidated_into: 'default' });
  } catch (error) {
    serverError(res, error, 'delete environment');
  }
});

module.exports = router;
