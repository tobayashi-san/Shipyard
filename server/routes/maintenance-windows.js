const express = require('express');
const db = require('../db');
const { getPermissions, can, canAccessEnvironment } = require('../utils/permissions');

const router = express.Router();
const guard = capability => (req, res, next) => can(getPermissions(req.user), capability) ? next() : res.status(403).json({ error: 'Permission denied' });

function normalizeWindow(body = {}) {
  const name = String(body.name || '').trim().slice(0, 120);
  const startsAt = new Date(String(body.starts_at || ''));
  const endsAt = new Date(String(body.ends_at || ''));
  if (!name) throw new Error('A maintenance window name is required.');
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error('Start and end must be valid dates.');
  if (endsAt <= startsAt) throw new Error('The end must be after the start.');
  if (endsAt.getTime() - startsAt.getTime() > 366 * 24 * 60 * 60 * 1000) throw new Error('A maintenance window cannot exceed one year.');
  return { name, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), description: String(body.description || '').trim().slice(0, 1000) };
}

function stateFor(row, now = Date.now()) {
  const start = new Date(row.starts_at).getTime();
  const end = new Date(row.ends_at).getTime();
  return now < start ? 'scheduled' : now <= end ? 'active' : 'completed';
}

router.get('/', guard('canViewMaintenance'), (req, res) => {
  const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
  if (!canAccessEnvironment(getPermissions(req.user), environmentId)) return res.status(403).json({ error: 'Umgebungszugriff verweigert.' });
  const rows = db.db.prepare('SELECT * FROM maintenance_windows WHERE environment_id = ? ORDER BY starts_at DESC').all(environmentId);
  res.json(rows.map(row => ({ ...row, state: stateFor(row) })));
});

router.post('/', guard('canEditMaintenance'), (req, res) => {
  try {
    const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found.' });
    if (!canAccessEnvironment(getPermissions(req.user), environmentId)) return res.status(403).json({ error: 'Umgebungszugriff verweigert.' });
    const value = normalizeWindow(req.body);
    const id = db.uuidv4();
    db.db.prepare('INSERT INTO maintenance_windows (id, environment_id, name, starts_at, ends_at, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, environmentId, value.name, value.starts_at, value.ends_at, value.description, req.user?.username || '');
    db.auditLog.write('maintenance_window.create', `environment=${environmentId} window=${value.name}`, req.ip, true, req.user?.username);
    res.status(201).json({ id, environment_id: environmentId, ...value, state: stateFor(value), created_by: req.user?.username || '' });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not create maintenance window.' }); }
});

router.put('/:id', guard('canEditMaintenance'), (req, res) => {
  const existing = db.db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Maintenance window not found.' });
  if (req.environmentId && existing.environment_id !== req.environmentId) return res.status(404).json({ error: 'Maintenance window not found.' });
  if (!canAccessEnvironment(getPermissions(req.user), existing.environment_id)) return res.status(403).json({ error: 'Umgebungszugriff verweigert.' });
  try {
    const value = normalizeWindow(req.body);
    db.db.prepare('UPDATE maintenance_windows SET name = ?, starts_at = ?, ends_at = ?, description = ? WHERE id = ?')
      .run(value.name, value.starts_at, value.ends_at, value.description, existing.id);
    db.auditLog.write('maintenance_window.update', `window=${value.name}`, req.ip, true, req.user?.username);
    res.json({ ...existing, ...value, state: stateFor(value) });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not update maintenance window.' }); }
});

router.delete('/:id', guard('canEditMaintenance'), (req, res) => {
  const existing = db.db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Maintenance window not found.' });
  if (req.environmentId && existing.environment_id !== req.environmentId) return res.status(404).json({ error: 'Maintenance window not found.' });
  if (!canAccessEnvironment(getPermissions(req.user), existing.environment_id)) return res.status(403).json({ error: 'Umgebungszugriff verweigert.' });
  db.db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(existing.id);
  db.auditLog.write('maintenance_window.delete', `window=${existing.name}`, req.ip, true, req.user?.username);
  res.status(204).end();
});

module.exports = router;
