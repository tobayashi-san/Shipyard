const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const { adminOnly } = require('../middleware/auth');

function parse(role) {
  try { return { ...role, permissions: JSON.parse(role.permissions || '{}') }; }
  catch { return { ...role, permissions: {} }; }
}

// GET /api/roles
router.get('/', adminOnly, (req, res) => {
  try { res.json(db.roles.getAll().map(parse)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/roles
router.post('/', adminOnly, (req, res) => {
  const { name, permissions } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  try {
    const role = db.roles.create(name.trim(), permissions || {});
    db.auditLog.write('roles.create', `Created role: ${name}`, req.ip);
    res.status(201).json(parse(role));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Role name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/roles/:id
router.put('/:id', adminOnly, (req, res) => {
  const role = db.roles.getById(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'Cannot edit built-in roles' });
  const { name, permissions } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  try {
    const updated = db.roles.update(req.params.id, name.trim(), permissions || {});
    db.auditLog.write('roles.update', `Updated role: ${req.params.id}`, req.ip);
    res.json(parse(updated));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Role name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/roles/:id
router.delete('/:id', adminOnly, (req, res) => {
  const role = db.roles.getById(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'Cannot delete built-in roles' });
  const inUse = db.users.getAll().filter(u => u.role === req.params.id).length;
  if (inUse > 0) return res.status(400).json({ error: `Role assigned to ${inUse} user(s). Reassign them first.` });
  try {
    db.roles.delete(req.params.id);
    db.auditLog.write('roles.delete', `Deleted role: ${req.params.id}`, req.ip);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
