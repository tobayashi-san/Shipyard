const express = require('express');
const router = express.Router();
const db = require('../db');
const cron = require('node-cron');
const scheduler = require('../services/scheduler');
const { getPermissions, can } = require('../utils/permissions');

// GET /api/schedules — list all
router.get('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canViewSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const schedules = db.schedules.getAll();
  res.json(schedules);
});

// GET /api/schedules/:id — single
router.get('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canViewSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const schedule = db.schedules.getById(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  res.json(schedule);
});

// POST /api/schedules — create
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const { name, playbook, targets, cronExpression } = req.body;
  if (!name || !playbook || !cronExpression) {
    return res.status(400).json({ error: 'name, playbook, and cronExpression are required' });
  }
  if (typeof name !== 'string' || name.length > 100) return res.status(400).json({ error: 'Invalid name' });
  if (typeof playbook !== 'string' || playbook.length > 200) return res.status(400).json({ error: 'Invalid playbook' });
  if (typeof cronExpression !== 'string' || cronExpression.length > 100) return res.status(400).json({ error: 'Invalid cronExpression' });
  if (!cron.validate(cronExpression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  if (db.schedules.getAll().length >= 100) {
    return res.status(400).json({ error: 'Maximum number of schedules (100) reached' });
  }
  const id = db.schedules.create(name, playbook, targets, cronExpression);
  scheduler.reload(id);
  res.json({ id, status: 'created' });
});

// PUT /api/schedules/:id — update
router.put('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canEditSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const { name, playbook, targets, cronExpression, enabled } = req.body;
  const fields = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > 100) return res.status(400).json({ error: 'Invalid name' });
    fields.name = name;
  }
  if (playbook !== undefined) {
    if (typeof playbook !== 'string' || playbook.length > 200) return res.status(400).json({ error: 'Invalid playbook' });
    fields.playbook = playbook;
  }
  if (targets !== undefined) {
    if (typeof targets !== 'string' || targets.length > 500) return res.status(400).json({ error: 'Invalid targets' });
    fields.targets = targets;
  }
  if (cronExpression !== undefined) {
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
    fields.cronExpression = cronExpression;
  }
  if (enabled !== undefined) fields.enabled = enabled ? 1 : 0;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  db.schedules.update(req.params.id, fields);
  scheduler.reload(req.params.id);
  res.json({ status: 'updated' });
});

// POST /api/schedules/:id/toggle — toggle enabled
router.post('/:id/toggle', (req, res, next) => { if (!can(getPermissions(req.user), 'canToggleSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const newEnabled = existing.enabled ? 0 : 1;
  db.schedules.update(req.params.id, { enabled: newEnabled });
  scheduler.reload(req.params.id);
  res.json({ enabled: !!newEnabled });
});

// DELETE /api/schedules/:id
router.delete('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canDeleteSchedules')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  scheduler.unregister(req.params.id);
  db.schedules.delete(req.params.id);
  res.json({ status: 'deleted' });
});

module.exports = router;
