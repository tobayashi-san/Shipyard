const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');
const { serverError } = require('../utils/http-error');
const { setSecret } = require('../utils/crypto');
const scheduler = require('../services/scheduler');
const { withRemovedPlaybooks } = require('../services/reset-playbooks');
const resetCredentials = require('../middleware/reset-credentials');
const {resetBackupState} = require('../services/reset-backup-proof');
const {takeBackupApproval} = require('./reset-backup');

router.use(require('./reset-backup').router);

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many reset requests. Please wait one hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const PLAYBOOKS_DIR = path.resolve(process.env.FLEET_PLAYBOOKS_DIR || path.join(__dirname, '..', 'playbooks'));

function deleteServerTables(environmentId = null) {
  if (!environmentId) {
    db.db.prepare('DELETE FROM server_info').run();
    db.db.prepare('DELETE FROM update_history').run();
    db.db.prepare('DELETE FROM docker_containers').run();
    db.db.prepare('DELETE FROM compose_projects').run();
    db.db.prepare('DELETE FROM server_updates_cache').run();
    db.db.prepare('DELETE FROM docker_image_updates_cache').run();
    db.db.prepare('DELETE FROM docker_image_check_exclusions').run();
    db.db.prepare('DELETE FROM custom_update_tasks').run();
    db.db.prepare('DELETE FROM servers').run();
    db.db.prepare('DELETE FROM server_groups').run();
    return;
  }
  const serverIds = db.db.prepare('SELECT id FROM servers WHERE environment_id = ?').all(environmentId).map(row => row.id);
  if (serverIds.length) {
    const placeholders = serverIds.map(() => '?').join(',');
    for (const table of ['server_info', 'docker_containers', 'compose_projects', 'server_updates_cache', 'docker_image_updates_cache', 'docker_image_check_exclusions', 'custom_update_tasks']) {
      db.db.prepare(`DELETE FROM ${table} WHERE server_id IN (${placeholders})`).run(...serverIds);
    }
  }
  db.db.prepare('DELETE FROM update_history WHERE environment_id = ?').run(environmentId);
  db.db.prepare('DELETE FROM servers WHERE environment_id = ?').run(environmentId);
  db.db.prepare('DELETE FROM server_groups WHERE environment_id = ?').run(environmentId);
}

function resetAccounts() {
  db.db.prepare('DELETE FROM users').run();
  db.db.prepare("DELETE FROM app_settings WHERE key IN ('auth_password_hash', 'auth_username', 'auth_email')").run();
  setSecret(db, 'auth_jwt_secret', crypto.randomBytes(64).toString('hex'));
  for (const key of ['onboarding_done','totp_enabled','totp_secret','totp_secret_pending']) db.settings.set(key, '');
}

function resetResponse(res, cleanupPending, schedulerPending = false) {
  const warnings = [];
  if (cleanupPending) warnings.push('Reset completed, but private playbook staging cleanup remains. Preserve those files and ask an administrator to run the offline reset recovery procedure with the original current database. Do not repeat the reset.');
  if (schedulerPending) warnings.push('Reset completed, but some local scheduler registrations could not be removed. Deleted schedules cannot start new runs. Ask an administrator to restart Fleet to clear remaining scheduler registrations; do not repeat the reset.');
  res.json({success:true, ...(warnings.length ? {warning:warnings.join(' ')} : {})});
}

function unregisterDeletedSchedules(ids) {
  let pending = false;
  for (const id of ids) {
    try { scheduler.unregister(id); } catch { pending = true; }
  }
  return pending;
}

function resetError(res, error) {
  if (error.code === 'RESET_BACKUP_REQUIRED') return res.status(409).json({error: error.message, field: 'backup'});
  if (error.code === 'RESET_RECOVERY_REQUIRED') return res.status(409).json({
    field: 'recovery',
    error: 'Reset paused: an interrupted playbook reset needs offline recovery. Preserve the remaining files and ask an administrator to stop application and filesystem writers, then run the reset recovery procedure before trying again.',
  });
  return serverError(res, error, 'reset');
}

const RESET_PHRASES = {
  servers: 'DELETE HOSTS', schedules: 'DELETE SCHEDULES', playbooks: 'DELETE PLAYBOOKS',
  auth: 'RESET ALL ACCOUNTS', all: 'RESET HOSTS SCHEDULES AND ACCOUNTS',
};

// Require the explicitly displayed scope and phrase independently of the UI.
router.use('/:action', adminOnly, (req, res, next) => {
  if (req.method !== 'DELETE' || !RESET_PHRASES[req.params.action]) return next();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.confirmation !== RESET_PHRASES[req.params.action]) {
    return res.status(400).json({error:'Type the complete confirmation phrase before resetting.',field:'confirmation'});
  }
  const expectedScope = ['servers','schedules'].includes(req.params.action) ? (req.environmentId || 'default') : 'all-environments';
  if (body.scope !== expectedScope) return res.status(409).json({error:'Reset scope changed. Reopen the confirmation and review its target.'});
  next();
});

router.use('/:action', (req,res,next) => {
  if (req.method !== 'DELETE' || !RESET_PHRASES[req.params.action]) return next();
  resetLimiter(req,res,() => resetCredentials(req,res,() => {
    try {
      const action = req.params.action;
      const expected = takeBackupApproval(req);
      req.checkResetBackup = (playbooksDirectory = PLAYBOOKS_DIR) => {
        if (resetBackupState({database: db.db, action, environmentId: req.environmentId || 'default', playbooksDirectory}) !== expected) {
          const error = Error('Reset data changed after backup verification. Create and verify a current backup before trying again.');
          error.code = 'RESET_BACKUP_REQUIRED';
          throw error;
        }
      };
      next();
    } catch (error) { res.status(409).json({error: error.message, field: 'backup'}); }
  }));
});

// DELETE /api/reset/servers
router.delete('/servers', adminOnly, (req, res) => {
  try {
    const environmentId = req.environmentId || 'default';
    db.db.transaction(() => {
      req.checkResetBackup();
      deleteServerTables(environmentId);
      db.auditLog.write('reset.servers', `All servers and related data deleted in environment=${environmentId}`, req.ip, true, req.user?.username, environmentId);
    }).immediate();
    res.json({ success: true });
  } catch (e) {
    resetError(res, e);
  }
});

// DELETE /api/reset/schedules
router.delete('/schedules', adminOnly, (req, res) => {
  try {
    const environmentId = req.environmentId || 'default';
    const deletedIds = db.db.transaction(() => {
      req.checkResetBackup();
      const ids = db.db.prepare('SELECT id FROM schedules WHERE environment_id = ?').all(environmentId).map(row => row.id);
      db.db.prepare('DELETE FROM schedules WHERE environment_id = ?').run(environmentId);
      db.db.prepare('DELETE FROM schedule_history WHERE environment_id = ?').run(environmentId);
      db.auditLog.write('reset.schedules', `All schedules deleted in environment=${environmentId}`, req.ip, true, req.user?.username, environmentId);
      return ids;
    }).immediate();
    resetResponse(res, false, unregisterDeletedSchedules(deletedIds));
  } catch (e) {
    resetError(res, e);
  }
});

// DELETE /api/reset/playbooks
router.delete('/playbooks', adminOnly, (req, res) => {
  try {
    const {cleanupPending} = withRemovedPlaybooks(PLAYBOOKS_DIR, db.db.transaction(() => {
      db.auditLog.write('reset.playbooks', 'All user playbooks deleted', req.ip, true, req.user?.username);
    }), db.db, req.checkResetBackup);
    resetResponse(res, cleanupPending);
  } catch (e) {
    resetError(res, e);
  }
});

// DELETE /api/reset/auth — clears password + JWT secret + onboarding flag + users
router.delete('/auth', adminOnly, (req, res) => {
  try {
    db.db.transaction(() => {
      req.checkResetBackup();
      resetAccounts();
      db.auditLog.write('reset.auth', 'Authentication reset: all users deleted, sessions invalidated', req.ip, true, req.user?.username);
    }).immediate();
    res.json({ success: true });
  } catch (e) {
    resetError(res, e);
  }
});

// DELETE /api/reset/all — combined reset; other inventories/integrations remain.
router.delete('/all', adminOnly, (req, res) => {
  try {
    const {result:deletedIds, cleanupPending} = withRemovedPlaybooks(PLAYBOOKS_DIR, db.db.transaction(() => {
      const ids = db.db.prepare('SELECT id FROM schedules').all().map(row => row.id);
      deleteServerTables();
      db.db.prepare('DELETE FROM schedules').run();
      db.db.prepare('DELETE FROM schedule_history').run();
      db.db.prepare('DELETE FROM operation_acknowledgements').run();
      resetAccounts();
      for (const key of ['wl_app_name','wl_app_tagline','wl_accent_color','wl_logo_icon','wl_logo_image']) db.settings.set(key, '');
      db.settings.set('wl_show_icon', '1');
      db.settings.set('ui_theme', 'auto');
      db.auditLog.write('reset.all', 'Combined reset: hosts, schedules, accounts, user playbooks and appearance reset; other inventories and integrations retained', req.ip, true, req.user?.username);
      return ids;
    }), db.db, req.checkResetBackup);
    resetResponse(res, cleanupPending, unregisterDeletedSchedules(deletedIds));
  } catch (e) {
    resetError(res, e);
  }
});

module.exports = router;
