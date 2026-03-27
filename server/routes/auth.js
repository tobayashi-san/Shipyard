const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const otplib = require('otplib');
const QRCode = require('qrcode');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { getJwtSecret } = require('../utils/jwt-secret');
const { serverError } = require('../utils/http-error');

const isTest = process.env.NODE_ENV === 'test';

// Dummy hash for constant-time comparison when user not found (prevents timing attacks)
const DUMMY_HASH = '$2a$12$LJ3m4ys3Rl4Eqb4oNaeyxOV2OVXjoAiGxvuoQDcxXnQmYVG.gu0Vu';

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
    { userId: user.id, username: user.username, role: user.role, tv: user.token_version || 0 },
    getJwtSecret(),
    { expiresIn: '8h' }
  );
}

function makeTempToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '5m' });
}

// GET /api/auth/status – is a password configured? Is onboarding done?
router.get('/status', (req, res) => {
  const configured = db.users.count() > 0;
  res.json({
    configured,
    onboardingDone: !!db.settings.get('onboarding_done'),
    username: 'admin',
  });
});

// GET /api/auth/profile
router.get('/profile', authMiddleware, (req, res) => {
  const { getPermissions } = require('../utils/permissions');
  const permissions = getPermissions(req.user);
  const fullUser = db.users.getById(req.user.id);
  res.json({
    id:          req.user.id,
    username:    req.user.username,
    displayName: fullUser?.display_name || '',
    email:       fullUser?.email || req.user.email || '',
    role:        req.user.role,
    permissions,
  });
});

// PUT /api/auth/profile – users can update their display name and email only
router.put('/profile', authMiddleware, (req, res) => {
  const { displayName, email } = req.body;
  const fields = {};
  if (displayName !== undefined) fields.display_name = String(displayName).trim().slice(0, 100);
  if (email !== undefined) fields.email = String(email).trim().slice(0, 256);

  if (Object.keys(fields).length) {
    try {
      db.users.update(req.user.id, fields);
    } catch (e) {
      return serverError(res, e, 'update profile');
    }
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
  const user = db.users.create(username, '', hash, 'admin');

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
    // No username provided — try single-user shortcut
    const all = db.users.getAll();
    if (all.length === 1) {
      user = db.users.getByUsername(all[0].username);
    }
  }

  if (!user) {
    // Constant-time comparison to prevent timing leaks
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(401).json({ error: 'Incorrect credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash || DUMMY_HASH);
  if (!valid) {
    db.auditLog.write('auth.login', `Failed login attempt for ${user.username}`, req.ip, false);
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

  const fullUser = db.users.getByUsername(req.user.username);
  if (!fullUser) return res.status(404).json({ error: 'User not found' });
  const valid = await bcrypt.compare(currentPassword, fullUser.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const newHash = await bcrypt.hash(newPassword, 12);
  db.users.setPasswordHash(req.user.id, newHash);
  // Increment per-user token version to invalidate only this user's tokens
  db.users.incrementTokenVersion(req.user.id);
  db.auditLog.write('auth.change', `Password changed for ${req.user.username}, user tokens invalidated`, req.ip);
  // Issue a fresh token so the user isn't logged out
  const updatedUser = db.users.getById(req.user.id);
  res.json({ success: true, token: makeToken(updatedUser) });
});

// ── TOTP / 2FA ───────────────────────────────────────────────

// POST /api/auth/totp/login – verify TOTP code after password step
router.post('/totp/login', loginLimiter, (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'tempToken and code required' });

  let payload;
  try { payload = jwt.verify(tempToken, getJwtSecret()); }
  catch { return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' }); }

  if (!payload.totp_pending || !payload.userId) {
    return res.status(401).json({ error: 'Invalid token type' });
  }

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
  res.json({ token: makeToken(user) });
});

// GET /api/auth/totp/status – is 2FA enabled?
router.get('/totp/status', authMiddleware, (req, res) => {
  res.json({ enabled: !!req.user.totp_enabled });
});

// POST /api/auth/totp/setup – generate a new TOTP secret and return QR code
router.post('/totp/setup', authMiddleware, async (req, res) => {
  try {
    const secret = otplib.generateSecret();
    const appName = db.settings.get('wl_app_name') || 'Shipyard';
    const username = req.user?.username || 'admin';

    db.users.setPendingTotp(req.user.id, secret);

    const otpauthUrl = otplib.generateURI({ label: username, issuer: appName, secret });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    res.json({ secret, otpauthUrl, qrDataUrl });
  } catch (e) {
    serverError(res, e, 'totp setup');
  }
});

// POST /api/auth/totp/confirm – verify code, then enable 2FA
router.post('/totp/confirm', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const fullUser = db.users.getByUsername(req.user.username);
  const secret = fullUser?.totp_secret_pending;
  if (!secret) return res.status(400).json({ error: 'No pending TOTP setup. Call /totp/setup first.' });
  if (!verifyTotp(code, secret)) return res.status(400).json({ error: 'Invalid code – try again' });
  db.users.setTotp(req.user.id, secret, true);
  db.users.setPendingTotp(req.user.id, '');

  db.auditLog.write('auth.totp', '2FA enabled', req.ip);
  res.json({ success: true });
});

// DELETE /api/auth/totp – disable 2FA (requires password re-authentication)
router.delete('/totp', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required to disable 2FA' });
  }

  const fullUser = db.users.getByUsername(req.user.username);
  if (!fullUser) return res.status(404).json({ error: 'User not found' });
  const valid = await bcrypt.compare(password, fullUser.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });
  db.users.setTotp(req.user.id, '', false);

  db.auditLog.write('auth.totp', '2FA disabled', req.ip);
  res.json({ success: true });
});

module.exports = { router };
