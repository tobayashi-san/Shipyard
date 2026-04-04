const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const db = require('../db');
const scheduler = require('../services/scheduler');
const { sendWebhook, sendEmail } = require('../services/notifier');
const { adminOnly } = require('../middleware/auth');
const { setSecret } = require('../utils/crypto');
const { serverError } = require('../utils/http-error');
const { rotateJwtSecret } = require('../utils/jwt-secret');

const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many deploy attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/system/key - Get current SSH key info
router.get('/key', (req, res) => {
  try {
    let keyInfo = sshManager.getKeyInfo();
    if (!keyInfo) {
      // Auto-generate if none exists
      const result = sshManager.generateKey();
      keyInfo = sshManager.getKeyInfo();
    }
    res.json(keyInfo);
  } catch (error) {
    serverError(res, error, 'get SSH key');
  }
});

// POST /api/system/generate - Generate new SSH key
router.post('/generate', adminOnly, (req, res) => {
  try {
    const rawName = req.body.name || 'shipyard';
    if (!/^[a-zA-Z0-9_-]+$/.test(rawName)) {
      return res.status(400).json({ error: 'Key name may only contain letters, digits, _ and -' });
    }
    const result = sshManager.generateKey(rawName);
    res.json(result);
  } catch (error) {
    serverError(res, error, 'generate SSH key');
  }
});

// POST /api/system/key/export - Export private key (optional passphrase)
router.post('/key/export', adminOnly, deployLimiter, (req, res) => {
  try {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    const key = sshManager.getPrivateKeyExport(passphrase);
    db.auditLog.write('ssh.export', `SSH private key exported${passphrase ? ' (passphrase-protected)' : ''}`, req.ip, true, req.user?.username);
    res.json({ privateKey: key, success: true });
  } catch (error) {
    db.auditLog.write('ssh.export', 'SSH private key export failed', req.ip, false, req.user?.username);
    serverError(res, error, 'export SSH key');
  }
});

// POST /api/system/key/import - Import private key
router.post('/key/import', adminOnly, (req, res) => {
  try {
    const { privateKey, passphrase } = req.body;
    if (!privateKey || typeof privateKey !== 'string') {
      return res.status(400).json({ error: 'privateKey is required' });
    }
    const result = sshManager.importKey(privateKey, 'shipyard_imported', passphrase || '');
    db.auditLog.write('ssh.import', 'SSH private key imported', req.ip, true, req.user?.username);
    res.json(result);
  } catch (error) {
    db.auditLog.write('ssh.import', 'SSH private key import failed', req.ip, false, req.user?.username);
    if (error.message?.includes('passphrase') || error.message?.includes('Invalid SSH')) {
      return res.status(400).json({ error: error.message });
    }
    serverError(res, error, 'import SSH key');
  }
});

// POST /api/system/deploy - Deploy SSH key to a server
router.post('/deploy', adminOnly, deployLimiter, async (req, res) => {
  try {
    const { ip_address, ssh_user, password, ssh_port } = req.body;
    if (!ip_address || !password) {
      return res.status(400).json({ error: 'ip_address and password are required' });
    }
    const result = await sshManager.deployKey(ip_address, ssh_user || 'root', password, ssh_port || 22);
    db.auditLog.write('ssh.deploy', `SSH key deployed to ${ip_address}`, req.ip, result.success !== false, req.user?.username);
    res.json(result);
  } catch (error) {
    db.auditLog.write('ssh.deploy', `SSH key deploy failed for ${req.body?.ip_address}`, req.ip, false, req.user?.username);
    serverError(res, error, 'deploy SSH key');
  }
});

// POST /api/system/deploy-all - Deploy SSH key to multiple/all servers
router.post('/deploy-all', adminOnly, deployLimiter, async (req, res) => {
  try {
    const { password, serverIds } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'password is required' });
    }

    const allServers = db.servers.getAll();
    let targets = allServers;
    if (Array.isArray(serverIds) && serverIds.length > 0) {
      const idSet = new Set(serverIds.filter(id => typeof id === 'string'));
      targets = allServers.filter(s => idSet.has(s.id));
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: 'No target servers found' });
    }

    const results = [];
    for (const s of targets) {
      try {
        await sshManager.deployKey(s.ip_address, s.ssh_user || 'root', password, s.ssh_port || 22);
        results.push({ id: s.id, name: s.name, ip_address: s.ip_address, success: true });
      } catch (e) {
        results.push({ id: s.id, name: s.name, ip_address: s.ip_address, success: false, error: e.message });
      }
    }

    const failed = results.filter(r => !r.success).length;
    const succeeded = results.length - failed;
    db.auditLog.write('ssh.deploy_all', `SSH key deploy all: success=${succeeded} failed=${failed}`, req.ip, failed === 0, req.user?.username);
    res.json({ success: failed === 0, total: results.length, succeeded, failed, results });
  } catch (error) {
    db.auditLog.write('ssh.deploy_all', 'Bulk SSH key deploy failed', req.ip, false, req.user?.username);
    serverError(res, error, 'deploy SSH key to all servers');
  }
});

// GET /api/system/settings - Get all app settings (white label etc.)
router.get('/settings', adminOnly, (req, res) => {
  try {
    const raw = db.settings.getAll();
    res.json({
      appName:              raw.wl_app_name     || '',
      appTagline:           raw.wl_app_tagline  || '',
      accentColor:          raw.wl_accent_color || '',
      showIcon:             raw.wl_show_icon    !== '0',
      logoIcon:             raw.wl_logo_icon    || 'fa-ship',
      logoImage:            raw.wl_logo_image   || '',
      theme:                raw.ui_theme        || 'auto',
      timeFormat:           raw.ui_time_format  || '24h',
      agentEnabled:         raw.agent_enabled   === '1',
      webhookUrl:           raw.webhook_url     || '',
      webhookSecret:        raw.webhook_secret  ? '••••••••' : '',
      smtpHost:             raw.smtp_host       || '',
      smtpPort:             raw.smtp_port       || '587',
      smtpUser:             raw.smtp_user       || '',
      smtpFrom:             raw.smtp_from       || '',
      smtpTo:               raw.smtp_to         || '',
      notifPlaybookFailed:  raw.notify_playbook_failed  !== '0',
      notifUpdateFailed:    raw.notify_update_failed    !== '0',
    });
  } catch (error) {
    serverError(res, error, 'get settings');
  }
});

// PUT /api/system/settings - Save app settings
router.put('/settings', adminOnly, (req, res) => {
  try {
    const { appName, appTagline, accentColor, showIcon, logoIcon, logoImage, theme, timeFormat,
            agentEnabled, webhookUrl, webhookSecret,
            smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpTo,
            notifPlaybookFailed, notifUpdateFailed } = req.body;
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    if (appName       !== undefined) db.settings.set('wl_app_name',     str(appName, 100));
    if (appTagline    !== undefined) db.settings.set('wl_app_tagline',  str(appTagline, 500));
    if (accentColor   !== undefined) db.settings.set('wl_accent_color', str(accentColor, 20));
    if (showIcon      !== undefined) db.settings.set('wl_show_icon',    showIcon ? '1' : '0');
    if (logoIcon      !== undefined) db.settings.set('wl_logo_icon',    str(logoIcon, 64));
    if (logoImage     !== undefined) db.settings.set('wl_logo_image',   str(logoImage, 200000));
    if (theme         !== undefined) db.settings.set('ui_theme',        str(theme, 20));
    if (timeFormat    !== undefined) db.settings.set('ui_time_format',  str(timeFormat, 10));
    if (agentEnabled !== undefined) {
      if (typeof agentEnabled !== 'boolean') return res.status(400).json({ error: 'agentEnabled must be a boolean' });
      db.settings.set('agent_enabled', agentEnabled ? '1' : '0');
    }
    if (webhookUrl    !== undefined) db.settings.set('webhook_url',     str(webhookUrl, 1000));
    if (webhookSecret !== undefined) setSecret(db, 'webhook_secret',  str(webhookSecret, 500));
    if (smtpHost      !== undefined) db.settings.set('smtp_host',       str(smtpHost, 255));
    if (smtpPort      !== undefined) db.settings.set('smtp_port',       String(parseInt(smtpPort) || 587));
    if (smtpUser      !== undefined) db.settings.set('smtp_user',       str(smtpUser, 256));
    if (smtpPass      !== undefined) setSecret(db, 'smtp_pass',       str(smtpPass, 500));
    if (smtpFrom      !== undefined) db.settings.set('smtp_from',       str(smtpFrom, 256));
    if (smtpTo               !== undefined) db.settings.set('smtp_to',                  str(smtpTo, 256));
    if (notifPlaybookFailed !== undefined) {
      if (typeof notifPlaybookFailed !== 'boolean') return res.status(400).json({ error: 'notifPlaybookFailed must be a boolean' });
      db.settings.set('notify_playbook_failed', notifPlaybookFailed ? '1' : '0');
    }
    if (notifUpdateFailed !== undefined) {
      if (typeof notifUpdateFailed !== 'boolean') return res.status(400).json({ error: 'notifUpdateFailed must be a boolean' });
      db.settings.set('notify_update_failed', notifUpdateFailed ? '1' : '0');
    }
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'save settings');
  }
});

// POST /api/system/webhook-test - Send a test webhook notification
router.post('/webhook-test', adminOnly, async (req, res) => {
  try {
    const result = await sendWebhook('Shipyard Test', 'This is a test notification from Shipyard.', true);
    if (result && result.ok === false) {
      return res.status(502).json({ error: 'Webhook request failed', status: result.status });
    }
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'webhook test');
  }
});

// POST /api/system/smtp-test - Send a test email
router.post('/smtp-test', adminOnly, async (req, res) => {
  try {
    await sendEmail('Shipyard Test', 'This is a test email from Shipyard.', true);
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'smtp test');
  }
});

// GET /api/system/polling-config
router.get('/polling-config', (req, res) => {
  const g = (key) => db.settings.get(key) ?? scheduler.DEFAULTS[key];
  res.json({
    info:          { enabled: g('poll_info_enabled') !== '0',          intervalMin: parseInt(g('poll_info_interval_min')) },
    updates:       { enabled: g('poll_updates_enabled') !== '0',       intervalMin: parseInt(g('poll_updates_interval_min')) },
    imageUpdates:  { enabled: g('poll_image_updates_enabled') !== '0', intervalMin: parseInt(g('poll_image_updates_interval_min')) },
    customUpdates: { enabled: g('poll_custom_updates_enabled') !== '0',intervalMin: parseInt(g('poll_custom_updates_interval_min')) },
  });
});

// PUT /api/system/polling-config
router.put('/polling-config', adminOnly, (req, res) => {
  const { info, updates, imageUpdates, customUpdates } = req.body;
  const save = (key, val) => { if (val !== undefined) db.settings.set(key, String(val)); };
  const checkEnabled = (section, name) => {
    if (section && section.enabled !== undefined && typeof section.enabled !== 'boolean')
      return res.status(400).json({ error: `${name}.enabled must be a boolean` });
  };
  if (checkEnabled(info, 'info') || checkEnabled(updates, 'updates') ||
      checkEnabled(imageUpdates, 'imageUpdates') || checkEnabled(customUpdates, 'customUpdates')) return;
  if (info)          { save('poll_info_enabled', info.enabled ? '1' : '0');                   save('poll_info_interval_min', Math.max(1, parseInt(info.intervalMin) || 5)); }
  if (updates)       { save('poll_updates_enabled', updates.enabled ? '1' : '0');             save('poll_updates_interval_min', Math.max(1, parseInt(updates.intervalMin) || 60)); }
  if (imageUpdates)  { save('poll_image_updates_enabled', imageUpdates.enabled ? '1' : '0'); save('poll_image_updates_interval_min', Math.max(1, parseInt(imageUpdates.intervalMin) || 360)); }
  if (customUpdates) { save('poll_custom_updates_enabled', customUpdates.enabled ? '1' : '0');save('poll_custom_updates_interval_min', Math.max(1, parseInt(customUpdates.intervalMin) || 360)); }
  scheduler.restartPolling();
  db.auditLog.write('system.polling', 'Polling configuration updated', req.ip, true, req.user?.username);
  res.json({ success: true });
});

// POST /api/system/rotate-jwt-secret – invalidate all sessions by rotating the JWT signing key
router.post('/rotate-jwt-secret', adminOnly, (req, res) => {
  const rotated = rotateJwtSecret();
  if (!rotated) {
    return res.status(400).json({
      error: 'JWT_SECRET is set via environment variable. Update it there to rotate the signing key.',
    });
  }
  db.auditLog.write('system.rotate-jwt', 'JWT secret rotated — all sessions invalidated', req.ip, true, req.user?.username);
  res.json({ success: true, message: 'JWT secret rotated. All users must log in again.' });
});

// POST /api/system/onboarding-complete – mark first-run wizard as done
router.post('/onboarding-complete', adminOnly, (req, res) => {
  db.settings.set('onboarding_done', '1');
  res.json({ success: true });
});

// GET /api/system/audit - Recent audit log entries (with optional filters)
router.get('/audit', adminOnly, (req, res) => {
  try {
    const { action, user, ip, success, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const rows = db.auditLog.query({ action, user, ip, success, from, to, limit, offset });
    res.json(rows);
  } catch (error) {
    serverError(res, error, 'audit log');
  }
});

// GET /api/system/audit/meta - Filter options for audit log UI
router.get('/audit/meta', adminOnly, (req, res) => {
  try {
    res.json({
      actions: db.auditLog.distinctActions(),
      users: db.auditLog.distinctUsers(),
      count: db.auditLog.countAll(),
    });
  } catch (error) {
    serverError(res, error, 'audit meta');
  }
});

// GET /api/system/status - Check Ansible installation
router.get('/status', (req, res) => {
  const installed = ansibleRunner.isInstalled();
  const version = installed ? ansibleRunner.getVersion() : null;
  res.json({ installed, version });
});

module.exports = router;
