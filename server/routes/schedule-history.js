const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPermissions, filterServers } = require('../utils/permissions');

// GET /api/schedule-history?limit=100&scheduleId=xxx
router.get('/', (req, res) => {
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
    .filter(h => h.targets && h.targets !== 'all' && accessibleNames.has(h.targets))
    .slice(0, limit);

  res.json(filtered);
});

// GET /api/schedule-history/:id  (includes full output)
router.get('/:id', (req, res) => {
  const row = db.scheduleHistory.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
