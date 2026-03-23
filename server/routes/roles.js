const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const { adminOnly } = require('../middleware/auth');
const { ALLOWED_PERMISSION_KEYS } = require('../utils/permissions');

function parse(role) {
  try { return { ...role, permissions: JSON.parse(role.permissions || '{}') }; }
  catch { return { ...role, permissions: {} }; }
}

// Strip unknown keys and enforce correct types to prevent privilege escalation
function sanitizePermissions(perms) {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return {};
  const clean = {};
  for (const [k, v] of Object.entries(perms)) {
    if (k === 'servers') {
      // Accept 'all' or { groups: [...], servers: [...] }
      if (v === 'all') { clean[k] = v; }
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        clean[k] = { groups: Array.isArray(v.groups) ? v.groups.filter(g => typeof g === 'string') : [],
                     servers: Array.isArray(v.servers) ? v.servers.filter(s => typeof s === 'string') : [] };
      }
    } else if (k === 'playbooks' || k === 'plugins') {
      // Accept 'all' or string array
      if (v === 'all') { clean[k] = v; }
      else if (Array.isArray(v)) { clean[k] = v.filter(s => typeof s === 'string'); }
    } else if (ALLOWED_PERMISSION_KEYS.has(k)) {
      clean[k] = !!v; // boolean only
    }
    // Unknown keys like 'full' are silently dropped
  }
  return clean;
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
    const role = db.roles.create(name.trim(), sanitizePermissions(permissions));
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
    const updated = db.roles.update(req.params.id, name.trim(), sanitizePermissions(permissions));
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
