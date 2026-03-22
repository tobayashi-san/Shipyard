const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const otplib = require('otplib');
const QRCode = require('qrcode');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { getJwtSecret } = require('../utils/jwt-secret');

const isTest = process.env.NODE_ENV === 'test';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip: () => isTest,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const changeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip: () => isTest,
  message: { error: 'Too many password change attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function verifyTotp(code, secret) {
  const result = otplib.verifySync({ token: String(code).replace(/\s/g, ''), secret });
  return result.valid;
}

function makeToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    getJwtSecret(),
    { expiresIn: '8h' }
  );
}

function makeTempToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '5m' });
}

// GET /api/auth/status – is a password configured? Is onboarding done?
router.get('/status', (req, res) => {
  const configured = db.users.count() > 0 || !!db.settings.get('auth_password_hash');
  res.json({
    configured,
    onboardingDone: !!db.settings.get('onboarding_done'),
    username: 'admin',
  });
});

// GET /api/auth/profile
router.get('/profile', authMiddleware, (req, res) => {
  res.json({
    id:       req.user.id,
    username: req.user.username,
    email:    req.user.email || '',
    role:     req.user.role,
  });
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, (req, res) => {
  const { username, email } = req.body;
  const fields = {};
  if (username !== undefined) {
    const u = String(username).trim().slice(0, 64);
    if (!u) return res.status(400).json({ error: 'Username cannot be empty' });
    fields.username = u;
  }
  if (email !== undefined) fields.email = String(email).trim().slice(0, 256);

  if (Object.keys(fields).length) {
    db.users.update(req.user.id, fields);
    // Also keep legacy settings in sync for backwards compat
    if (fields.username) db.settings.set('auth_username', fields.username);
    if (fields.email !== undefined) db.settings.set('auth_email', fields.email);
  }

  db.auditLog.write('auth.profile', 'Profile updated', req.ip);
  res.json({ success: true });
});

// POST /api/auth/setup – first-time password setup (only when no users exist)
router.post('/setup', async (req, res) => {
  if (db.users.count() > 0) {
    return res.status(400).json({ error: 'Users already exist. Use /api/auth/change.' });
  }
  let { username, password } = req.body;
  username = (username && String(username).trim()) || 'admin';
  if (!password || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' });
  }
  const hash = await bcrypt.hash(password, 12);

  // Create first admin user
  const user = db.users.create(username, '', hash, 'admin');

  // Also persist legacy settings for backward compat
  db.settings.set('auth_password_hash', hash);
  db.settings.set('auth_username', username);

  db.auditLog.write('auth.setup', `Initial admin user created: ${username}`, req.ip);
  res.json({ token: makeToken(user) });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }

  let user = null;

  if (username) {
    user = db.users.getByUsername(String(username).trim());
  } else {
    // Legacy: no username provided — try to find admin
    const all = db.users.getAll();
    if (all.length === 1) {
      user = db.users.getByUsername(all[0].username);
    }
  }

  if (!user) {
    // Fallback to legacy settings-based auth
    const hash = db.settings.get('auth_password_hash');
    if (!hash) return res.status(400).json({ error: 'No password configured' });
    const valid = await bcrypt.compare(password, hash);
    if (!valid) {
      db.auditLog.write('auth.login', 'Failed login attempt', req.ip, false);
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: 'Incorrect credentials' });
    }
    // Legacy 2FA check
    if (db.settings.get('totp_enabled') === '1') {
      const tempToken = makeTempToken({ totp_pending: true });
      return res.json({ requires2FA: true, tempToken });
    }
    db.auditLog.write('auth.login', 'Successful login (legacy)', req.ip);
    // Issue a legacy-compatible token with ok:true since we have no real user
    const token = jwt.sign({ ok: true }, getJwtSecret(), { expiresIn: '8h' });
    return res.json({ token });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    db.auditLog.write('auth.login', `Failed login attempt for ${user.username}`, req.ip, false);
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Incorrect credentials' });
  }

  // If 2FA is enabled for this user, issue a short-lived temp token
  if (user.totp_enabled) {
    const tempToken = makeTempToken({ totp_pending: true, userId: user.id });
    return res.json({ requires2FA: true, tempToken });
  }

  db.auditLog.write('auth.login', `Successful login: ${user.username}`, req.ip);
  res.json({ token: makeToken(user) });
});

// POST /api/auth/change – change password (requires valid JWT)
router.post('/change', changeLimiter, authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 12) {
    return res.status(400).json({ error: 'New password must be at least 12 characters' });
  }

  const userId = req.user.id;

  // If legacy user (no real id), fall back to settings-based check
  if (userId === 'legacy') {
    const hash = db.settings.get('auth_password_hash');
    if (!hash) return res.status(400).json({ error: 'No password configured.' });
    const valid = await bcrypt.compare(currentPassword, hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 12);
    db.settings.set('auth_password_hash', newHash);
    const newSecret = crypto.randomBytes(64).toString('hex');
    db.settings.set('auth_jwt_secret', newSecret);
    db.auditLog.write('auth.change', 'Password changed (legacy), all tokens invalidated', req.ip);
    return res.json({ success: true });
  }

  const fullUser = db.users.getByUsername(req.user.username);
  if (!fullUser) return res.status(404).json({ error: 'User not found' });
  const valid = await bcrypt.compare(currentPassword, fullUser.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const newHash = await bcrypt.hash(newPassword, 12);
  db.users.setPasswordHash(userId, newHash);
  // Also update legacy settings hash for admin users
  if (req.user.role === 'admin') {
    db.settings.set('auth_password_hash', newHash);
  }
  // Rotate JWT secret so all existing tokens are invalidated immediately
  const newSecret = crypto.randomBytes(64).toString('hex');
  db.settings.set('auth_jwt_secret', newSecret);
  db.auditLog.write('auth.change', `Password changed for ${req.user.username}, all tokens invalidated`, req.ip);
  res.json({ success: true });
});

// ── TOTP / 2FA ───────────────────────────────────────────────

// POST /api/auth/totp/login – verify TOTP code after password step
router.post('/totp/login', loginLimiter, (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'tempToken and code required' });

  let payload;
  try { payload = jwt.verify(tempToken, getJwtSecret()); }
  catch { return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' }); }

  if (!payload.totp_pending) return res.status(401).json({ error: 'Invalid token type' });

  // New-style: userId in payload
  if (payload.userId) {
    const user = db.users.getByUsername(
      db.users.getById(payload.userId)?.username || ''
    );
    if (!user) return res.status(401).json({ error: 'User not found' });
    const secret = user.totp_secret;
    if (!secret) return res.status(400).json({ error: '2FA not configured' });
    if (!verifyTotp(code, secret)) {
      db.auditLog.write('auth.totp', 'Invalid TOTP code', req.ip, false);
      return res.status(401).json({ error: 'Invalid authenticator code' });
    }
    db.auditLog.write('auth.login', `Successful login (2FA): ${user.username}`, req.ip);
    return res.json({ token: makeToken(user) });
  }

  // Legacy path
  const secret = db.settings.get('totp_secret');
  if (!secret) return res.status(400).json({ error: '2FA not configured' });
  if (!verifyTotp(code, secret)) {
    db.auditLog.write('auth.totp', 'Invalid TOTP code', req.ip, false);
    return res.status(401).json({ error: 'Invalid authenticator code' });
  }
  db.auditLog.write('auth.login', 'Successful login (2FA)', req.ip);
  const token = jwt.sign({ ok: true }, getJwtSecret(), { expiresIn: '8h' });
  res.json({ token });
});

// GET /api/auth/totp/status – is 2FA enabled?
router.get('/totp/status', authMiddleware, (req, res) => {
  if (req.user && req.user.id !== 'legacy') {
    return res.json({ enabled: !!req.user.totp_enabled });
  }
  res.json({ enabled: db.settings.get('totp_enabled') === '1' });
});

// POST /api/auth/totp/setup – generate a new TOTP secret and return QR code
router.post('/totp/setup', authMiddleware, async (req, res) => {
  try {
    const secret = otplib.generateSecret();
    const appName = db.settings.get('wl_app_name') || 'Shipyard';
    const username = req.user?.username || 'admin';

    if (req.user && req.user.id !== 'legacy') {
      db.users.setPendingTotp(req.user.id, secret);
    } else {
      db.settings.set('totp_secret_pending', secret);
    }

    const otpauthUrl = otplib.generateURI({ label: username, issuer: appName, secret });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/totp/confirm – verify code, then enable 2FA
router.post('/totp/confirm', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  if (req.user && req.user.id !== 'legacy') {
    const fullUser = db.users.getByUsername(req.user.username);
    const secret = fullUser?.totp_secret_pending;
    if (!secret) return res.status(400).json({ error: 'No pending TOTP setup. Call /totp/setup first.' });
    if (!verifyTotp(code, secret)) return res.status(400).json({ error: 'Invalid code – try again' });
    db.users.setTotp(req.user.id, secret, true);
    db.users.setPendingTotp(req.user.id, '');
  } else {
    const secret = db.settings.get('totp_secret_pending');
    if (!secret) return res.status(400).json({ error: 'No pending TOTP setup. Call /totp/setup first.' });
    if (!verifyTotp(code, secret)) return res.status(400).json({ error: 'Invalid code – try again' });
    db.settings.set('totp_secret', secret);
    db.settings.set('totp_enabled', '1');
    db.settings.set('totp_secret_pending', '');
  }

  db.auditLog.write('auth.totp', '2FA enabled', req.ip);
  res.json({ success: true });
});

// DELETE /api/auth/totp – disable 2FA
router.delete('/totp', authMiddleware, (req, res) => {
  if (req.user && req.user.id !== 'legacy') {
    db.users.setTotp(req.user.id, '', false);
  } else {
    db.settings.set('totp_enabled', '0');
    db.settings.set('totp_secret', '');
  }
  db.auditLog.write('auth.totp', '2FA disabled', req.ip);
  res.json({ success: true });
});

module.exports = { router };
