const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const db = require('../db');

const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Zu viele Deploy-Versuche. Bitte warte 15 Minuten.' },
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
