const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/schedule-history?limit=100&scheduleId=xxx
router.get('/', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const scheduleId = req.query.scheduleId || null;
  res.json(db.scheduleHistory.getAll(limit, scheduleId));
});

// GET /api/schedule-history/:id  (includes full output)
router.get('/:id', (req, res) => {
  const row = db.scheduleHistory.getById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
