const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const { parseTargetExpression } = require('../utils/validate');

// GET /api/schedule-history?limit=100&scheduleId=xxx
router.get('/', (req, res) => {
  if (!can(getPermissions(req.user), 'canViewSchedules')) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const scheduleId = req.query.scheduleId || null;

  const perms = getPermissions(req.user);
  // Admins / full-access users see everything
  if (!perms || perms.full || perms.servers === 'all') {
    return res.json(db.scheduleHistory.getAll(limit, scheduleId));
  }

  // Restricted users: only show history entries whose targets match an
  // accessible server name (or were run against a single accessible server).
  // Entries targeting 'all' are not shown to restricted users.
  const accessibleNames = new Set(
    filterServers(db.servers.getAll(), perms).map(s => s.name)
  );
  const all = db.scheduleHistory.getAll(limit * 5, scheduleId);
  const filtered = all
    .filter(h => {
      if (!h.targets) return false;
      const parsed = parseTargetExpression(h.targets);
      if (parsed.kind !== 'list' || parsed.included.length === 0) return false;
      return parsed.included.some(t => accessibleNames.has(t));
    })
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
  if (perms && !perms.full && perms.servers !== 'all' && perms.servers != null) {
    const accessibleNames = new Set(
      filterServers(db.servers.getAll(), perms).map(s => s.name)
    );
    const parsed = parseTargetExpression(row.targets);
    if (parsed.kind !== 'list') return res.status(403).json({ error: 'Permission denied' });
    if (!parsed.included.some(t => accessibleNames.has(t))) return res.status(403).json({ error: 'Permission denied' });
  }

  res.json(row);
});

module.exports = router;
