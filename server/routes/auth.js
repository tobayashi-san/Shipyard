const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const changeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Zu viele Passwort-Änderungsversuche. Bitte warte 15 Minuten.' },
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
    // Small artificial delay to slow brute-force
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Falsches Passwort' });
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
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen lang sein' });
  }
  const hash = db.settings.get('auth_password_hash');
  if (!hash) {
    return res.status(400).json({ error: 'Kein Passwort konfiguriert. Nutze /api/auth/setup.' });
  }
  const valid = await bcrypt.compare(currentPassword, hash);
  if (!valid) {
    return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
  }
  const newHash = await bcrypt.hash(newPassword, 12);
  db.settings.set('auth_password_hash', newHash);
  // Rotate JWT secret so all existing tokens are invalidated immediately
  const newSecret = crypto.randomBytes(64).toString('hex');
  db.settings.set('auth_jwt_secret', newSecret);
  db.auditLog.write('auth.change', 'Password changed, all tokens invalidated', req.ip);
  res.json({ success: true });
});

module.exports = { router, getJwtSecret };
