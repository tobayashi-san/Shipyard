const express = require('express');
const router = express.Router();
const db = require('../db');
const cron = require('node-cron');
const scheduler = require('../services/scheduler');
const { getPermissions, can, canAccessPlaybook, canAccessTargets } = require('../utils/permissions');
const { isValidPlaybook, validateTargets } = require('../utils/validate');

function requireScheduleCapability(capability) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), capability)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

function normalizeScheduleTargets(targets) {
  return typeof targets === 'string' && targets.trim() ? targets.trim() : 'all';
}

function validateScheduleScope(req, playbook, targets) {
  const perms = getPermissions(req.user);
  if (!canAccessPlaybook(perms, playbook)) {
    return 'Playbook not permitted for your role';
  }
  if (!canAccessTargets(perms, normalizeScheduleTargets(targets), db.servers.getAll())) {
    return 'Target servers not permitted for your role';
  }
  return null;
}

function canAccessSchedule(req, schedule) {
  return !validateScheduleScope(req, schedule.playbook, schedule.targets);
}

// GET /api/schedules — list all
router.get('/', requireScheduleCapability('canViewSchedules'), (req, res) => {
  const schedules = db.schedules.getAll().filter(schedule => canAccessSchedule(req, schedule));
  res.json(schedules);
});

// GET /api/schedules/:id — single
router.get('/:id', requireScheduleCapability('canViewSchedules'), (req, res) => {
  const schedule = db.schedules.getById(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!canAccessSchedule(req, schedule)) return res.status(403).json({ error: 'Schedule access denied' });
  res.json(schedule);
});

// POST /api/schedules — create
router.post('/', requireScheduleCapability('canAddSchedules'), (req, res) => {
  const { name, playbook, targets, cronExpression } = req.body;
  if (!name || !playbook || !cronExpression) {
    return res.status(400).json({ error: 'name, playbook, and cronExpression are required' });
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Invalid name' });
  if (!isValidPlaybook(playbook)) return res.status(400).json({ error: 'Invalid playbook filename (must be letters/digits/_ - ending in .yml or .yaml)' });
  if (typeof cronExpression !== 'string' || cronExpression.length > 100) return res.status(400).json({ error: 'Invalid cronExpression' });
  if (!cron.validate(cronExpression)) {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }
  const targetsErr = validateTargets(targets);
  if (targetsErr) return res.status(400).json({ error: targetsErr });
  const normalizedTargets = normalizeScheduleTargets(targets);
  const scopeErr = validateScheduleScope(req, playbook, normalizedTargets);
  if (scopeErr) return res.status(403).json({ error: scopeErr });
  if (db.schedules.getAll().length >= 100) {
    return res.status(400).json({ error: 'Maximum number of schedules (100) reached' });
  }
  const id = db.schedules.create(name.trim(), playbook, normalizedTargets, cronExpression);
  scheduler.reload(id);
  db.auditLog.write('schedule.create', `Schedule "${name.trim()}" created (${playbook})`, req.ip, true, req.user?.username);
  res.json({ id, status: 'created' });
});

// PUT /api/schedules/:id — update
router.put('/:id', requireScheduleCapability('canEditSchedules'), (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  if (!canAccessSchedule(req, existing)) return res.status(403).json({ error: 'Schedule access denied' });

  const { name, playbook, targets, cronExpression, enabled } = req.body;
  const fields = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Invalid name' });
    fields.name = name.trim();
  }
  if (playbook !== undefined) {
    if (!isValidPlaybook(playbook)) return res.status(400).json({ error: 'Invalid playbook filename (must be letters/digits/_ - ending in .yml or .yaml)' });
    fields.playbook = playbook;
  }
  if (targets !== undefined) {
    const targetsErr = validateTargets(targets);
    if (targetsErr) return res.status(400).json({ error: targetsErr });
    fields.targets = normalizeScheduleTargets(targets);
  }
  if (cronExpression !== undefined) {
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({ error: 'Invalid cron expression' });
    }
    fields.cronExpression = cronExpression;
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    fields.enabled = enabled ? 1 : 0;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const nextPlaybook = fields.playbook || existing.playbook;
  const nextTargets = fields.targets || existing.targets;
  const scopeErr = validateScheduleScope(req, nextPlaybook, nextTargets);
  if (scopeErr) return res.status(403).json({ error: scopeErr });

  db.schedules.update(req.params.id, fields);
  scheduler.reload(req.params.id);
  db.auditLog.write('schedule.update', `Schedule "${existing.name}" updated`, req.ip, true, req.user?.username);
  res.json({ status: 'updated' });
});

// POST /api/schedules/:id/toggle — toggle enabled
router.post('/:id/toggle', requireScheduleCapability('canToggleSchedules'), (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  if (!canAccessSchedule(req, existing)) return res.status(403).json({ error: 'Schedule access denied' });

  const newEnabled = existing.enabled ? 0 : 1;
  db.schedules.update(req.params.id, { enabled: newEnabled });
  scheduler.reload(req.params.id);
  db.auditLog.write('schedule.toggle', `Schedule "${existing.name}" ${newEnabled ? 'enabled' : 'disabled'}`, req.ip, true, req.user?.username);
  res.json({ enabled: !!newEnabled });
});

// DELETE /api/schedules/:id
router.delete('/:id', requireScheduleCapability('canDeleteSchedules'), (req, res) => {
  const existing = db.schedules.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });
  if (!canAccessSchedule(req, existing)) return res.status(403).json({ error: 'Schedule access denied' });

  scheduler.unregister(req.params.id);
  db.schedules.delete(req.params.id);
  db.auditLog.write('schedule.delete', `Schedule "${existing.name}" deleted`, req.ip, true, req.user?.username);
  res.json({ status: 'deleted' });
});

module.exports = router;
