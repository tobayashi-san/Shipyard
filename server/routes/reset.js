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

function deleteServerTables(environmentId = null) {
  if (!environmentId) {
    db.db.prepare('DELETE FROM server_info').run();
    db.db.prepare('DELETE FROM update_history').run();
    db.db.prepare('DELETE FROM docker_containers').run();
    db.db.prepare('DELETE FROM compose_projects').run();
    db.db.prepare('DELETE FROM server_updates_cache').run();
    db.db.prepare('DELETE FROM docker_image_updates_cache').run();
    db.db.prepare('DELETE FROM custom_update_tasks').run();
    db.db.prepare('DELETE FROM servers').run();
    db.db.prepare('DELETE FROM server_groups').run();
    return;
  }
  const serverIds = db.db.prepare('SELECT id FROM servers WHERE environment_id = ?').all(environmentId).map(row => row.id);
  if (serverIds.length) {
    const placeholders = serverIds.map(() => '?').join(',');
    for (const table of ['server_info', 'docker_containers', 'compose_projects', 'server_updates_cache', 'docker_image_updates_cache', 'custom_update_tasks']) {
      db.db.prepare(`DELETE FROM ${table} WHERE server_id IN (${placeholders})`).run(...serverIds);
    }
  }
  db.db.prepare('DELETE FROM update_history WHERE environment_id = ?').run(environmentId);
  db.db.prepare('DELETE FROM servers WHERE environment_id = ?').run(environmentId);
  db.db.prepare('DELETE FROM server_groups WHERE environment_id = ?').run(environmentId);
}

function deleteUserPlaybooks() {
  if (!fs.existsSync(PLAYBOOKS_DIR)) return;
  for (const f of fs.readdirSync(PLAYBOOKS_DIR)) {
    if (f.endsWith('.yml') || f.endsWith('.yaml')) {
      fs.unlinkSync(path.join(PLAYBOOKS_DIR, f));
    }
  }
}

// DELETE /api/reset/servers
router.delete('/servers', resetLimiter, adminOnly, (req, res) => {
  try {
    const environmentId = req.environmentId || 'default';
    db.db.transaction(deleteServerTables)(environmentId);
    db.auditLog.write('reset.servers', `All servers and related data deleted in environment=${environmentId}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/schedules
router.delete('/schedules', resetLimiter, adminOnly, (req, res) => {
  try {
    const environmentId = req.environmentId || 'default';
    db.db.prepare('DELETE FROM schedules WHERE environment_id = ?').run(environmentId);
    db.db.prepare('DELETE FROM schedule_history WHERE environment_id = ?').run(environmentId);
    db.auditLog.write('reset.schedules', `All schedules deleted in environment=${environmentId}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/playbooks
router.delete('/playbooks', resetLimiter, adminOnly, (req, res) => {
  try {
    deleteUserPlaybooks();
    db.auditLog.write('reset.playbooks', 'All user playbooks deleted', req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

// DELETE /api/reset/auth — clears password + JWT secret + onboarding flag + users
router.delete('/auth', resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.prepare('DELETE FROM users').run();
    db.db.prepare("DELETE FROM app_settings WHERE key IN ('auth_password_hash', 'auth_username', 'auth_email')").run();
    setSecret(db, 'auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('onboarding_done', '');
    db.settings.set('totp_enabled', '');
    db.settings.set('totp_secret', '');
    db.settings.set('totp_secret_pending', '');
    db.auditLog.write('reset.auth', 'Authentication reset: all users deleted, sessions invalidated', req.ip, true, req.user?.username);
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
      db.db.prepare('DELETE FROM operation_acknowledgements').run();
      db.db.prepare('DELETE FROM users').run();
    })();
    deleteUserPlaybooks();
    db.db.prepare("DELETE FROM app_settings WHERE key IN ('auth_password_hash', 'auth_username', 'auth_email')").run();
    setSecret(db, 'auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('totp_enabled', '');
    db.settings.set('totp_secret', '');
    db.settings.set('totp_secret_pending', '');
    db.settings.set('wl_app_name', '');
    db.settings.set('wl_app_tagline', '');
    db.settings.set('wl_accent_color', '');
    db.settings.set('wl_logo_icon', '');
    db.settings.set('wl_logo_image', '');
    db.settings.set('wl_show_icon', '1');
    db.settings.set('ui_theme', 'auto');
    db.settings.set('onboarding_done', '');
    db.auditLog.write('reset.all', 'Full factory reset performed', req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    serverError(res, e, 'reset');
  }
});

module.exports = router;
