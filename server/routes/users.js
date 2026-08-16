const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');
const { serverError } = require('../utils/http-error');
const { normalizeUsername, validateUsername } = require('../utils/usernames');
const { normalizeEmail } = require('../utils/email');

// GET /api/users – list all users (no password_hash)
router.get('/', adminOnly, (req, res) => {
  try {
    res.json(db.users.getAll());
  } catch (e) {
    serverError(res, e, 'list users');
  }
});

// POST /api/users – create user
router.post('/', adminOnly, async (req, res) => {
  const { username, displayName, email, password, role } = req.body;
  const usernameErr = validateUsername(username);
  if (usernameErr) return res.status(400).json({ error: usernameErr });
  const usernameNorm = normalizeUsername(username);
  if (!password || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  const emailNorm = normalizeEmail(email);
  if (emailNorm && emailNorm.error) return res.status(400).json({ error: emailNorm.error });
  const knownRoles = db.roles.getAll().map(r => r.id);
  if (role !== undefined && role !== 'admin' && !knownRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const userRole = role || 'user';
  try {
    if (db.users.getByUsername(usernameNorm)) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    const hash = await bcrypt.hash(password, 12);
    const displayNameNorm = (displayName && typeof displayName === 'string') ? displayName.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
    const user = db.users.create(usernameNorm, emailNorm || '', hash, userRole, displayNameNorm);
    db.auditLog.write('users.create', `Created user: ${usernameNorm}`, req.ip, true, req.user?.username);
    res.status(201).json(user);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    serverError(res, e, 'create user');
  }
});

// PUT /api/users/:id – admin can update username/displayName/email/role
router.put('/:id', adminOnly, (req, res) => {
  const { id } = req.params;
  const { username, displayName, email, role } = req.body;
  const fields = {};
  if (username !== undefined) {
    const usernameErr = validateUsername(username);
    if (usernameErr) return res.status(400).json({ error: usernameErr });
    fields.username = normalizeUsername(username);
  }
  if (displayName !== undefined) {
    if (typeof displayName !== 'string') return res.status(400).json({ error: 'displayName must be a string' });
    fields.display_name = displayName.trim().replace(/\s+/g, ' ').slice(0, 100);
  }
  if (email !== undefined) {
    const emailNorm = normalizeEmail(email);
    if (emailNorm && emailNorm.error) return res.status(400).json({ error: emailNorm.error });
    fields.email = emailNorm || '';
  }
  if (role !== undefined) {
    const knownRoles = db.roles.getAll().map(r => r.id);
    if (role !== 'admin' && !knownRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    fields.role = role;
  }
  try {
    const existing = db.users.getById(id);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (fields.username) {
      const existingByUsername = db.users.getByUsername(fields.username);
      if (existingByUsername && existingByUsername.id !== id) {
        return res.status(409).json({ error: 'Username already exists' });
      }
    }
    if (fields.role && existing.role !== fields.role) {
      if (req.user.id === id) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }
      if (existing.role === 'admin' && fields.role !== 'admin' && db.users.countActiveAdmins() <= 1) {
        return res.status(409).json({ error: 'Cannot remove the last active administrator' });
      }
    }
    // Invalidate tokens when role changes so user gets new permissions on next login
    if (fields.role) {
      if (existing && existing.role !== fields.role) {
        db.users.incrementTokenVersion(id);
      }
    }
    const user = db.users.update(id, fields);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.auditLog.write('users.update', `Updated user: ${id}`, req.ip, true, req.user?.username);
    res.json(user);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    serverError(res, e, 'update user');
  }
});

// PUT /api/users/:id/status – suspend or reactivate an account
router.put('/:id/status', adminOnly, (req, res) => {
  const { id } = req.params;
  const { disabled } = req.body || {};
  if (typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be a boolean' });
  }
  const user = db.users.getById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.user.id === id && disabled) {
    return res.status(400).json({ error: 'Cannot disable your own account' });
  }
  if (disabled && user.role === 'admin' && !user.disabled && db.users.countActiveAdmins() <= 1) {
    return res.status(409).json({ error: 'Cannot disable the last active administrator' });
  }
  try {
    const updated = db.users.update(id, { disabled: disabled ? 1 : 0 });
    // Both suspension and reactivation revoke every previously issued token.
    db.users.incrementTokenVersion(id);
    db.auditLog.write(
      disabled ? 'users.disable' : 'users.enable',
      `${disabled ? 'Disabled' : 'Enabled'} user: ${id}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json(db.users.getById(updated.id));
  } catch (e) {
    serverError(res, e, 'update user status');
  }
});

// POST /api/users/:id/revoke-sessions – revoke all API and WebSocket sessions
router.post('/:id/revoke-sessions', adminOnly, (req, res) => {
  const { id } = req.params;
  const user = db.users.getById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    db.users.incrementTokenVersion(id);
    db.auditLog.write('users.sessions.revoke', `Revoked sessions for user: ${id}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'revoke user sessions');
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
    db.auditLog.write('users.password', `Admin reset password for user: ${id}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset user password');
  }
});

// PUT /api/users/:id/totp-disable – admin disables another user's 2FA
router.put('/:id/totp-disable', adminOnly, (req, res) => {
  const { id } = req.params;
  const user = db.users.getById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    db.users.setTotp(id, '', false);
    db.users.setPendingTotp(id, '');
    db.users.incrementTokenVersion(id);
    db.auditLog.write('users.totp.disable', `Admin disabled 2FA for user: ${id}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'admin disable user totp');
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
  if (user.role === 'admin' && !user.disabled && db.users.countActiveAdmins() <= 1) {
    return res.status(409).json({ error: 'Cannot delete the last active administrator' });
  }
  try {
    db.users.delete(id);
    db.auditLog.write('users.delete', `Deleted user: ${id}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'delete user');
  }
});

module.exports = router;
