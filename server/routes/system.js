const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const db = require('../db');
const scheduler = require('../services/scheduler');

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
    res.status(500).json({ error: error.message });
  }
});

// POST /api/system/generate - Generate new SSH key
router.post('/generate', (req, res) => {
  try {
    const rawName = req.body.name || 'shipyard';
    if (!/^[a-zA-Z0-9_-]+$/.test(rawName)) {
      return res.status(400).json({ error: 'Key name may only contain letters, digits, _ and -' });
    }
    const result = sshManager.generateKey(rawName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/system/deploy - Deploy SSH key to a server
router.post('/deploy', deployLimiter, async (req, res) => {
  try {
    const { ip_address, ssh_user, password, ssh_port } = req.body;
    if (!ip_address || !password) {
      return res.status(400).json({ error: 'ip_address and password are required' });
    }
    const result = await sshManager.deployKey(ip_address, ssh_user || 'root', password, ssh_port || 22);
    db.auditLog.write('ssh.deploy', `SSH key deployed to ${ip_address}`, req.ip, result.success !== false);
    res.json(result);
  } catch (error) {
    db.auditLog.write('ssh.deploy', `SSH key deploy failed for ${req.body?.ip_address}`, req.ip, false);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/system/settings - Get all app settings (white label etc.)
router.get('/settings', (req, res) => {
  try {
    const raw = db.settings.getAll();
    res.json({
      appName:     raw.wl_app_name     || '',
      appTagline:  raw.wl_app_tagline  || '',
      accentColor: raw.wl_accent_color || '',
      theme:       raw.ui_theme        || 'auto',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/system/settings - Save app settings
router.put('/settings', (req, res) => {
  try {
    const { appName, appTagline, accentColor, theme } = req.body;
    if (appName     !== undefined) db.settings.set('wl_app_name',     appName);
    if (appTagline  !== undefined) db.settings.set('wl_app_tagline',  appTagline);
    if (accentColor !== undefined) db.settings.set('wl_accent_color', accentColor);
    if (theme       !== undefined) db.settings.set('ui_theme',        theme);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
router.put('/polling-config', (req, res) => {
  const { info, updates, imageUpdates, customUpdates } = req.body;
  const save = (key, val) => { if (val !== undefined) db.settings.set(key, String(val)); };
  if (info)          { save('poll_info_enabled', info.enabled ? '1' : '0');                   save('poll_info_interval_min', Math.max(1, parseInt(info.intervalMin) || 5)); }
  if (updates)       { save('poll_updates_enabled', updates.enabled ? '1' : '0');             save('poll_updates_interval_min', Math.max(1, parseInt(updates.intervalMin) || 60)); }
  if (imageUpdates)  { save('poll_image_updates_enabled', imageUpdates.enabled ? '1' : '0'); save('poll_image_updates_interval_min', Math.max(1, parseInt(imageUpdates.intervalMin) || 360)); }
  if (customUpdates) { save('poll_custom_updates_enabled', customUpdates.enabled ? '1' : '0');save('poll_custom_updates_interval_min', Math.max(1, parseInt(customUpdates.intervalMin) || 360)); }
  scheduler.restartPolling();
  res.json({ success: true });
});

// POST /api/system/onboarding-complete – mark first-run wizard as done
router.post('/onboarding-complete', (req, res) => {
  db.settings.set('onboarding_done', '1');
  res.json({ success: true });
});

// GET /api/system/audit - Recent audit log entries
router.get('/audit', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(db.auditLog.getRecent(limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/system/status - Check Ansible installation
router.get('/status', (req, res) => {
  const installed = ansibleRunner.isInstalled();
  const version = installed ? ansibleRunner.getVersion() : null;
  res.json({ installed, version });
});

module.exports = router;
