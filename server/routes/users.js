const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');

// GET /api/users – list all users (no password_hash)
router.get('/', adminOnly, (req, res) => {
  try {
    res.json(db.users.getAll());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users – create user
router.post('/', adminOnly, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'username required' });
  }
  if (!password || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  // Accept 'admin', any role in the roles table, or fallback to 'user'
  const knownRoles = db.roles.getAll().map(r => r.id);
  const userRole = (role === 'admin' || knownRoles.includes(role)) ? role : 'user';
  try {
    const hash = await bcrypt.hash(password, 12);
    const user = db.users.create(username.trim(), email || '', hash, userRole);
    db.auditLog.write('users.create', `Created user: ${username}`, req.ip);
    res.status(201).json(user);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id – update username/email/role
router.put('/:id', adminOnly, (req, res) => {
  const { id } = req.params;
  const { username, email, role } = req.body;
  const fields = {};
  if (username !== undefined) {
    const u = String(username).trim().slice(0, 64);
    if (!u) return res.status(400).json({ error: 'Username cannot be empty' });
    fields.username = u;
  }
  if (email !== undefined) fields.email = String(email).trim().slice(0, 256);
  if (role !== undefined) {
    const knownRoles = db.roles.getAll().map(r => r.id);
    if (role !== 'admin' && !knownRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    fields.role = role;
  }
  try {
    const user = db.users.update(id, fields);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.auditLog.write('users.update', `Updated user: ${id}`, req.ip);
    res.json(user);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id/password – admin resets another user's password
router.put('/:id/password', adminOnly, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  const user = db.users.getById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const hash = await bcrypt.hash(password, 12);
    db.users.setPasswordHash(id, hash);
    db.users.incrementTokenVersion(id);
    // Keep legacy settings in sync if resetting admin
    if (user.role === 'admin') {
      db.settings.set('auth_password_hash', hash);
    }
    db.auditLog.write('users.password', `Admin reset password for user: ${id}`, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:id – delete user (cannot delete own account)
router.delete('/:id', adminOnly, (req, res) => {
  const { id } = req.params;
  if (req.user.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const user = db.users.getById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    db.users.delete(id);
    db.auditLog.write('users.delete', `Deleted user: ${id}`, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
