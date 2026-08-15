const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPermissions, filterServers, can, canAccessPlaybook, canAccessEnvironment } = require('../utils/permissions');
const { parseTargetExpression } = require('../utils/validate');

function canAccessHistoryRow(perms, row, allServers) {
  if (!perms) return false;
  if (perms.full) return true;
  if (!canAccessPlaybook(perms, row.playbook)) return false;
  if (perms.servers === 'all') return true;

  const accessibleNames = new Set(
    filterServers(allServers, perms).map(s => s.name)
  );
  const parsed = parseTargetExpression(row.targets);
  if (parsed.kind !== 'list' || parsed.included.length === 0) return false;
  return parsed.included.every(t => accessibleNames.has(t));
}

// GET /api/schedule-history?limit=100&scheduleId=xxx
router.get('/', (req, res) => {
  if (!can(getPermissions(req.user), 'canViewSchedules')) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const scheduleId = req.query.scheduleId || null;
  const environmentId = String(req.query.environment_id || 'default').trim() || 'default';

  const perms = getPermissions(req.user);
  if (!perms) return res.status(403).json({ error: 'Permission denied' });
  if (!canAccessEnvironment(perms, environmentId)) return res.status(403).json({ error: 'Environment access denied' });

  // Admins / full-access users see everything
  if (perms.full) {
    return res.json(db.scheduleHistory.getAll(limit, scheduleId, environmentId));
  }

  // Non-full users only see history for allowed playbooks and visible targets.
  const allServers = db.servers.getAll().filter(server =>
    String(server.environment_id || 'default') === environmentId);
  const all = db.scheduleHistory.getAll(limit * 5, scheduleId, environmentId);
  const filtered = all
    .filter(h => canAccessHistoryRow(perms, h, allServers))
    .slice(0, limit);

  res.json(filtered);
});

// GET /api/schedule-history/:id  (includes full output)
router.get('/:id', (req, res) => {
  if (!can(getPermissions(req.user), 'canViewSchedules')) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const row = db.scheduleHistory.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Restricted users can only view history for servers they have access to
  const perms = getPermissions(req.user);
  if (!canAccessEnvironment(perms, row.environment_id || 'default')) return res.status(403).json({ error: 'Environment access denied' });
  const environmentId = row.environment_id || 'default';
  const environmentServers = db.servers.getAll().filter(server =>
    String(server.environment_id || 'default') === environmentId);
  if (!canAccessHistoryRow(perms, row, environmentServers)) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  res.json(row);
});

module.exports = router;
