const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');

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
  for (const table of ['update_history', 'server_info', 'server_updates_cache', 'docker_containers', 'compose_projects', 'servers']) {
    db.db.prepare(`DELETE FROM ${table}`).run();
  }
}

function deleteUserPlaybooks() {
  if (!fs.existsSync(PLAYBOOKS_DIR)) return;
  for (const file of fs.readdirSync(PLAYBOOKS_DIR)) {
    if (!INTERNAL_PLAYBOOKS.includes(file) && (file.endsWith('.yml') || file.endsWith('.yaml'))) {
      fs.unlinkSync(path.join(PLAYBOOKS_DIR, file));
    }
  }
}

// DELETE /api/reset/servers
router.delete(\1, resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.transaction(deleteServerTables)();
    db.auditLog.write('reset.servers', 'All servers and related data deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reset/schedules
router.delete(\1, resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.prepare('DELETE FROM schedules').run();
    db.auditLog.write('reset.schedules', 'All schedules deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reset/playbooks
router.delete(\1, resetLimiter, adminOnly, (req, res) => {
  try {
    deleteUserPlaybooks();
    db.auditLog.write('reset.playbooks', 'All user playbooks deleted', req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reset/auth — clears password + JWT secret + onboarding flag
router.delete(\1, resetLimiter, adminOnly, (req, res) => {
  try {
    db.settings.set('auth_password_hash', '');
    db.settings.set('auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('onboarding_done', '');
    db.auditLog.write('reset.auth', 'Authentication reset, all sessions invalidated', req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/reset/all — wipe everything
router.delete(\1, resetLimiter, adminOnly, (req, res) => {
  try {
    db.db.transaction(() => {
      deleteServerTables();
      db.db.prepare('DELETE FROM schedules').run();
    })();
    deleteUserPlaybooks();
    db.settings.set('auth_password_hash', '');
    db.settings.set('auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
    db.settings.set('wl_app_name', '');
    db.settings.set('wl_app_tagline', '');
    db.settings.set('wl_accent_color', '');
    db.settings.set('ui_theme', 'auto');
    db.settings.set('onboarding_done', '');
    db.auditLog.write('reset.all', 'Full factory reset performed', req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
