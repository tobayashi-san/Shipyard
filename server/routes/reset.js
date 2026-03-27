const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');
const { serverError } = require('../utils/http-error');
const { setSecret } = require('../utils/crypto');

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many reset requests. Please wait one hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');
const INTERNAL_PLAYBOOKS = ['update.yml', 'gather-docker.yml', 'check-image-updates.yml', 'reboot.yml', 'setup-ssh.yml'];

function deleteServerTables() {
  db.db.prepare('DELETE FROM server_info').run();
  db.db.prepare('DELETE FROM update_history').run();
  db.db.prepare('DELETE FROM docker_containers').run();
  db.db.prepare('DELETE FROM compose_projects').run();
  db.db.prepare('DELETE FROM server_updates_cache').run();
  db.db.prepare('DELETE FROM docker_image_updates_cache').run();
  db.db.prepare('DELETE FROM custom_update_tasks').run();
  db.db.prepare('DELETE FROM servers').run();
  db.db.prepare('DELETE FROM server_groups').run();
}

function deleteUserPlaybooks() {
  if (!fs.existsSync(PLAYBOOKS_DIR)) return;
  for (const f of fs.readdirSync(PLAYBOOKS_DIR)) {
    if (!INTERNAL_PLAYBOOKS.includes(f) && f.endsWith('.yml')) {
      fs.unlinkSync(path.join(PLAYBOOKS_DIR, f));
    }
  }
}

// DELETE /api/reset/servers
router.delete('/servers', resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.transaction(deleteServerTables)();
    db.auditLog.write('reset.servers', 'All servers and related data deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/schedules
router.delete('/schedules', resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.prepare('DELETE FROM schedules').run();
    db.auditLog.write('reset.schedules', 'All schedules deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/playbooks
router.delete('/playbooks', resetLimiter, adminOnly, (req, res) => {
  try {
    deleteUserPlaybooks();
    db.auditLog.write('reset.playbooks', 'All user playbooks deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/auth — clears password + JWT secret + onboarding flag + users
router.delete('/auth', resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.prepare('DELETE FROM users').run();
    db.settings.set('auth_password_hash', '');
    setSecret(db, 'auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('onboarding_done', '');
    db.settings.set('totp_enabled', '');
    db.settings.set('totp_secret', '');
    db.settings.set('totp_secret_pending', '');
    db.auditLog.write('reset.auth', 'Authentication reset: all users deleted, sessions invalidated', req.ip);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/all — wipe everything
router.delete('/all', resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.transaction(() => {
      deleteServerTables();
      db.db.prepare('DELETE FROM schedules').run();
      db.db.prepare('DELETE FROM users').run();
    })();
    deleteUserPlaybooks();
    db.settings.set('auth_password_hash', '');
    setSecret(db, 'auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('totp_enabled', '');
    db.settings.set('totp_secret', '');
    db.settings.set('totp_secret_pending', '');
    db.settings.set('wl_app_name', '');
    db.settings.set('wl_app_tagline', '');
    db.settings.set('wl_accent_color', '');
    db.settings.set('ui_theme', 'auto');
    db.settings.set('onboarding_done', '');
    db.auditLog.write('reset.all', 'Full factory reset performed', req.ip);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

module.exports = router;
