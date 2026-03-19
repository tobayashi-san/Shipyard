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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const changeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many password change attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function getJwtSecret() {
  // Prefer environment variable – avoids storing the secret in the DB at rest
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let secret = db.settings.get('auth_jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    db.settings.set('auth_jwt_secret', secret);
  }
  return secret;
}

function makeToken() {
  return jwt.sign({ ok: true }, getJwtSecret(), { expiresIn: '24h' });
}

function makeTempToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '5m' });
}

// GET /api/auth/status – is a password configured? Is onboarding done?
router.get('/status', (req, res) => {
  res.json({
    configured: !!db.settings.get('auth_password_hash'),
    onboardingDone: !!db.settings.get('onboarding_done'),
  });
});

// POST /api/auth/setup – first-time password setup (only when no password exists)
router.post('/setup', async (req, res) => {
  if (db.settings.get('auth_password_hash')) {
    return res.status(400).json({ error: 'Password already configured. Use /api/auth/change.' });
  }
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const hash = await bcrypt.hash(password, 12);
  db.settings.set('auth_password_hash', hash);
  db.auditLog.write('auth.setup', 'Initial password configured', req.ip);
  res.json({ token: makeToken() });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required' });
  }
  const hash = db.settings.get('auth_password_hash');
  if (!hash) {
    return res.status(400).json({ error: 'No password configured' });
  }
  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    db.auditLog.write('auth.login', 'Failed login attempt', req.ip, false);
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Incorrect password' });
  }

  // If 2FA is enabled, issue a short-lived temp token and ask for TOTP code
  if (db.settings.get('totp_enabled') === '1') {
    const tempToken = makeTempToken({ totp_pending: true });
    return res.json({ requires2FA: true, tempToken });
  }

  db.auditLog.write('auth.login', 'Successful login', req.ip);
  res.json({ token: makeToken() });
});

// POST /api/auth/change – change password (requires valid JWT)
router.post('/change', changeLimiter, authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const hash = db.settings.get('auth_password_hash');
  if (!hash) {
    return res.status(400).json({ error: 'No password configured. Use /api/auth/setup.' });
  }
  const valid = await bcrypt.compare(currentPassword, hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const newHash = await bcrypt.hash(newPassword, 12);
  db.settings.set('auth_password_hash', newHash);
  // Rotate JWT secret so all existing tokens are invalidated immediately
  const newSecret = crypto.randomBytes(64).toString('hex');
  db.settings.set('auth_jwt_secret', newSecret);
  db.auditLog.write('auth.change', 'Password changed, all tokens invalidated', req.ip);
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

  const secret = db.settings.get('totp_secret');
  if (!secret) return res.status(400).json({ error: '2FA not configured' });

  if (!otplib.verifySync({ token: String(code).replace(/\s/g, ''), secret, type: 'totp' }).valid) {
    db.auditLog.write('auth.totp', 'Invalid TOTP code', req.ip, false);
    return res.status(401).json({ error: 'Invalid authenticator code' });
  }

  db.auditLog.write('auth.login', 'Successful login (2FA)', req.ip);
  res.json({ token: makeToken() });
});

// GET /api/auth/totp/status – is 2FA enabled?
router.get('/totp/status', authMiddleware, (req, res) => {
  res.json({ enabled: db.settings.get('totp_enabled') === '1' });
});

// POST /api/auth/totp/setup – generate a new TOTP secret and return QR code
router.post('/totp/setup', authMiddleware, async (req, res) => {
  try {
    const secret = otplib.generateSecret();
    // Store temporarily – only persisted after /totp/confirm
    db.settings.set('totp_secret_pending', secret);

    const appName = db.settings.get('wl_app_name') || 'Shipyard';
    const otpauthUrl = otplib.generateURI({ label: 'admin', issuer: appName, secret, type: 'totp' });
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

  const secret = db.settings.get('totp_secret_pending');
  if (!secret) return res.status(400).json({ error: 'No pending TOTP setup. Call /totp/setup first.' });

  if (!otplib.verifySync({ token: String(code).replace(/\s/g, ''), secret, type: 'totp' }).valid) {
    return res.status(401).json({ error: 'Invalid code – try again' });
  }

  db.settings.set('totp_secret', secret);
  db.settings.set('totp_enabled', '1');
  db.settings.set('totp_secret_pending', '');
  db.auditLog.write('auth.totp', '2FA enabled', req.ip);
  res.json({ success: true });
});

// DELETE /api/auth/totp – disable 2FA
router.delete('/totp', authMiddleware, (req, res) => {
  db.settings.set('totp_enabled', '0');
  db.settings.set('totp_secret', '');
  db.auditLog.write('auth.totp', '2FA disabled', req.ip);
  res.json({ success: true });
});

module.exports = { router, getJwtSecret };
