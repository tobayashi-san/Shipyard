const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const db = require('../db');
const scheduler = require('../services/scheduler');
const { sendWebhook, sendEmail } = require('../services/notifier');
const { adminOnly, requireCap } = require('../middleware/auth');
const { setSecret } = require('../utils/crypto');
const { serverError } = require('../utils/http-error');
const log = require('../utils/logger').child('system');
const { rotateJwtSecret } = require('../utils/jwt-secret');
const { getPermissions } = require('../utils/permissions');
const { queryVisibleAuditRows } = require('../utils/audit-scope');

const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many deploy attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

const SSH_ASSIGNMENT_TYPES = new Set(['server', 'deployment', 'vm_template']);

function hasTable(name) {
  return Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Audit entries deliberately stay human-readable, but a name or assignment ID
// should not force an administrator to manually search for the affected
// object. Resolve only exact, current inventory matches; stale/deleted objects
// intentionally remain plain text instead of producing a misleading link.
function auditObjectLinks(detail, environmentId = 'default') {
  const text = String(detail || '');
  const links = [];
  const seen = new Set();
  const add = (kind, id, label, href) => {
    if (!id || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    links.push({ kind, id, label, href });
  };

  const target = text.match(/(?:^|\s)type=(server|deployment|vm_template)\s+target=([^\s]+)/);
  if (target) {
    const [, type, id] = target;
    if (type === 'server') {
      const row = db.db.prepare('SELECT id, name FROM servers WHERE id = ? AND environment_id = ?').get(id, environmentId);
      if (row) add('server', row.id, row.name, `/servers/${row.id}`);
    } else if (type === 'deployment' && hasTable('tofu_workspaces')) {
      const row = db.db.prepare('SELECT id, name FROM tofu_workspaces WHERE id = ? AND environment_id = ?').get(id, environmentId);
      if (row) add('deployment', row.id, row.name, `/deployments/${row.id}`);
    }
  }

  const namedServer = text.match(/\bserver=([^\s]+)/) || text.match(/\bServer "([^"]+)"/);
  if (namedServer) {
    const row = db.db.prepare('SELECT id, name FROM servers WHERE name = ? AND environment_id = ?').get(namedServer[1], environmentId);
    if (row) add('server', row.id, row.name, `/servers/${row.id}`);
  }
  // Workspace names are allowed to contain spaces. Stop at the next known
  // key/value field rather than at the first whitespace.
  const workspace = text.match(/\bworkspace=(.+?)(?=\s+(?:vm|playbook|status|action|error)=|$)/);
  if (workspace && hasTable('tofu_workspaces')) {
    const row = db.db.prepare('SELECT id, name FROM tofu_workspaces WHERE name = ? AND environment_id = ?').get(workspace[1], environmentId);
    if (row) add('deployment', row.id, row.name, `/deployments/${row.id}`);
  }

  // IPAM records deliberately log the canonical prefix.  Resolve it here so
  // operators can move from an audit event back to the affected address space
  // without searching through the prefix inventory.
  const subnet = text.match(/\bsubnet=([^\s]+)/);
  if (subnet && hasTable('ipam_subnets')) {
    const row = db.db.prepare('SELECT id, cidr, name FROM ipam_subnets WHERE cidr = ? AND environment_id = ?').get(subnet[1], environmentId);
    if (row) add('network', row.id, row.name ? `${row.cidr} · ${row.name}` : row.cidr, `/networks/${row.id}`);
  }
  return links;
}

function sshAssignmentTargets(environmentId) {
  const targets = {
    servers: db.db.prepare('SELECT id, name, ip_address FROM servers WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
      .map(row => ({ id: row.id, label: row.ip_address ? `${row.name} · ${row.ip_address}` : row.name })),
    deployments: [],
    vm_templates: [],
  };
  if (!hasTable('tofu_workspaces')) return targets;
  targets.deployments = db.db.prepare('SELECT id, name FROM tofu_workspaces WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
    .map(row => ({ id: row.id, label: row.name }));
  if (hasTable('tofu_proxmox_vm_templates')) {
    targets.vm_templates = db.db.prepare(`
      SELECT template.id, template.name, workspace.name AS workspace_name
      FROM tofu_proxmox_vm_templates template
      JOIN tofu_workspaces workspace ON workspace.id = template.workspace_id
      WHERE workspace.environment_id = ?
      ORDER BY workspace.name COLLATE NOCASE, template.name COLLATE NOCASE
    `).all(environmentId).map(row => ({ id: row.id, label: `${row.workspace_name} · ${row.name}` }));
  }
  return targets;
}

function resolveSshAssignmentTarget(type, id, environmentId) {
  if (!SSH_ASSIGNMENT_TYPES.has(type) || !id || id.length > 128) return null;
  if (type === 'server') {
    const row = db.db.prepare('SELECT id, name, ip_address FROM servers WHERE id = ? AND environment_id = ?').get(id, environmentId);
    return row ? { label: row.ip_address ? `${row.name} · ${row.ip_address}` : row.name } : null;
  }
  if (!hasTable('tofu_workspaces')) return null;
  if (type === 'deployment') {
    const row = db.db.prepare('SELECT name FROM tofu_workspaces WHERE id = ? AND environment_id = ?').get(id, environmentId);
    return row ? { label: row.name } : null;
  }
  if (!hasTable('tofu_proxmox_vm_templates')) return null;
  const row = db.db.prepare(`
    SELECT template.name, workspace.name AS workspace_name
    FROM tofu_proxmox_vm_templates template
    JOIN tofu_workspaces workspace ON workspace.id = template.workspace_id
    WHERE template.id = ? AND workspace.environment_id = ?
  `).get(id, environmentId);
  return row ? { label: `${row.workspace_name} · ${row.name}` } : null;
}

// GET /api/system/key - Get current SSH key info
router.get('/key', adminOnly, (req, res) => {
  try {
    const keyInfo = sshManager.getKeyInfo();
    if (!keyInfo) {
      return res.status(404).json({ error: 'SSH key not configured' });
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
    const { ip_address, ssh_user, password, ssh_port, server_id: serverId } = req.body;
    if (!ip_address || !password) {
      return res.status(400).json({ error: 'ip_address and password are required' });
    }
    const port = Number(ssh_port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid SSH port' });
    const environmentId = req.environmentId || 'default';
    const target = serverId ? db.servers.getById(String(serverId)) : db.servers.getAll(environmentId).find(server => server.ip_address === ip_address);
    if (target && String(target.environment_id || 'default') !== environmentId) return res.status(404).json({ error: 'Server not found' });
    if (serverId && !target) return res.status(404).json({ error: 'Server not found' });
    const result = await sshManager.deployKey(ip_address, ssh_user || 'root', password, port, { serverId: target?.id || null });
    // If a server with this IP exists and has no fingerprint yet, persist what we just learned (TOFU).
    try {
      if (result?.fingerprint) {
        const match = db.servers.getAll(environmentId).find(s => s.ip_address === ip_address);
        if (match && !db.servers.getHostFingerprint(match.id)) {
          db.servers.setHostFingerprint(match.id, result.fingerprint);
        }
      }
    } catch {}
    db.auditLog.write('ssh.deploy', `SSH key deployed to ${ip_address}`, req.ip, result.success !== false, req.user?.username);
    res.json(result);
  } catch (error) {
    db.auditLog.write('ssh.deploy', `SSH key deploy failed for ${req.body?.ip_address}`, req.ip, false, req.user?.username);
    // A remote SSH connection failure is an expected operational outcome,
    // not an internal Shipyard crash. Keep implementation details in the log.
    log.warn({ err: error, serverId: req.body?.server_id, ipAddress: req.body?.ip_address }, 'SSH key deployment failed');
    if (!res.headersSent) res.status(502).json({ error: 'SSH-Schlüssel konnte nicht installiert werden. Prüfe IP-Adresse, SSH-Benutzer, Passwort und Erreichbarkeit.' });
    else serverError(res, error, 'deploy SSH key');
  }
});

// POST /api/system/deploy-all - Deploy SSH key to multiple/all servers
router.post('/deploy-all', adminOnly, deployLimiter, async (req, res) => {
  try {
    const { password, serverIds } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'password is required' });
    }

    const allServers = db.servers.getAll(req.environmentId || 'default');
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
        await sshManager.deployKey(s.ip_address, s.ssh_user || 'root', password, s.ssh_port || 22, { serverId: s.id });
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

// ── SSH key scope ────────────────────────────────────────────────────────
// The private Shipyard key stays central. These records only declare the
// resources for which its public part is intended, making access intent
// visible in the console and auditable without duplicating key material.
router.get('/key-assignments', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
  const rows = db.db.prepare('SELECT * FROM ssh_key_assignments WHERE environment_id = ? ORDER BY target_type, target_label COLLATE NOCASE').all(environmentId);
  res.json(rows);
});

router.get('/key-assignment-targets', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(404).json({ error: 'Umgebung nicht gefunden.' });
  res.json(sshAssignmentTargets(environmentId));
});

router.put('/key-assignments', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
  const targetType = String(req.body?.target_type || '').trim();
  const targetId = String(req.body?.target_id || '').trim();
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Umgebung nicht gefunden.' });
  const target = resolveSshAssignmentTarget(targetType, targetId, environmentId);
  if (!target) return res.status(400).json({ error: 'Ziel ist ungültig oder gehört nicht zu dieser Umgebung.' });
  const existing = db.db.prepare('SELECT id FROM ssh_key_assignments WHERE key_name = ? AND target_type = ? AND target_id = ?').get('fleet', targetType, targetId);
  const id = existing?.id || db.uuidv4();
  db.db.prepare(`INSERT INTO ssh_key_assignments (id, key_name, target_type, target_id, target_label, environment_id, updated_at)
    VALUES (?, 'fleet', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key_name, target_type, target_id) DO UPDATE SET target_label=excluded.target_label, environment_id=excluded.environment_id, updated_at=datetime('now')`)
    .run(id, targetType, targetId, target.label, environmentId);
  const row = db.db.prepare('SELECT * FROM ssh_key_assignments WHERE id = ?').get(id);
  db.auditLog.write('ssh.assignment.upsert', `key=fleet type=${targetType} target=${targetId}`, req.ip, true, req.user?.username);
  res.status(existing ? 200 : 201).json(row);
});

router.delete('/key-assignments/:id', adminOnly, (req, res) => {
  const row = db.db.prepare('SELECT * FROM ssh_key_assignments WHERE id = ?').get(req.params.id);
  if (!row || (req.environmentId && row.environment_id !== req.environmentId)) return res.status(404).json({ error: 'Schlüsselzuordnung nicht gefunden.' });
  db.db.prepare('DELETE FROM ssh_key_assignments WHERE id = ?').run(row.id);
  db.auditLog.write('ssh.assignment.delete', `key=${row.key_name} type=${row.target_type} target=${row.target_id}`, req.ip, true, req.user?.username);
  res.status(204).end();
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
      schedulerTimezone:    raw.scheduler_timezone || scheduler.getSchedulerTimezone(),
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
      notifResourceAlerts:  raw.notify_resource_alerts  !== '0',
    });
  } catch (error) {
    serverError(res, error, 'get settings');
  }
});

// PUT /api/system/settings - Save app settings
router.put('/settings', adminOnly, (req, res) => {
  try {
    const { appName, appTagline, accentColor, showIcon, logoIcon, logoImage, theme, timeFormat,
            schedulerTimezone, agentEnabled, webhookUrl, webhookSecret,
            smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpTo,
            notifPlaybookFailed, notifUpdateFailed, notifResourceAlerts } = req.body;
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    if (appName       !== undefined) db.settings.set('wl_app_name',     str(appName, 100));
    if (appTagline    !== undefined) db.settings.set('wl_app_tagline',  str(appTagline, 500));
    if (accentColor   !== undefined) db.settings.set('wl_accent_color', str(accentColor, 20));
    if (showIcon      !== undefined) db.settings.set('wl_show_icon',    showIcon ? '1' : '0');
    if (logoIcon      !== undefined) db.settings.set('wl_logo_icon',    str(logoIcon, 64));
    if (logoImage     !== undefined) {
      if (typeof logoImage !== 'string') return res.status(400).json({ error: 'logoImage must be a string' });
      // Cap strictly: this value is exposed on the unauthenticated /api/auth/status
      // endpoint, so we want to limit payload size. Reject rather than truncate,
      // because slicing a base64 data URL corrupts the image.
      if (logoImage.length > 32768) return res.status(400).json({ error: 'logoImage too large (max 32 KB)' });
      db.settings.set('wl_logo_image', logoImage);
    }
    if (theme         !== undefined) db.settings.set('ui_theme',        str(theme, 20));
    if (timeFormat    !== undefined) db.settings.set('ui_time_format',  str(timeFormat, 10));
    if (schedulerTimezone !== undefined) {
      if (!isValidTimeZone(schedulerTimezone)) return res.status(400).json({ error: 'Invalid schedulerTimezone' });
      db.settings.set('scheduler_timezone', schedulerTimezone.trim());
      scheduler.reloadAllSchedules();
    }
    if (agentEnabled !== undefined) {
      if (typeof agentEnabled !== 'boolean') return res.status(400).json({ error: 'agentEnabled must be a boolean' });
      db.settings.set('agent_enabled', agentEnabled ? '1' : '0');
    }
    if (webhookUrl    !== undefined) db.settings.set('webhook_url',     str(webhookUrl, 1000));
    if (webhookSecret !== undefined) setSecret(db, 'webhook_secret',  str(webhookSecret, 500));
    if (smtpHost      !== undefined) db.settings.set('smtp_host',       str(smtpHost, 255));
    if (smtpPort      !== undefined) db.settings.set('smtp_port',       String(parseInt(smtpPort, 10) || 587));
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
    if (notifResourceAlerts !== undefined) {
      if (typeof notifResourceAlerts !== 'boolean') return res.status(400).json({ error: 'notifResourceAlerts must be a boolean' });
      db.settings.set('notify_resource_alerts', notifResourceAlerts ? '1' : '0');
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
router.get('/polling-config', adminOnly, (req, res) => {
  const g = (key) => db.settings.get(key) ?? scheduler.DEFAULTS[key];
  res.json({
    info:          { enabled: g('poll_info_enabled') !== '0',          intervalMin: parseInt(g('poll_info_interval_min', 10)) },
    updates:       { enabled: g('poll_updates_enabled') !== '0',       intervalMin: parseInt(g('poll_updates_interval_min', 10)) },
    imageUpdates:  { enabled: g('poll_image_updates_enabled') !== '0', intervalMin: parseInt(g('poll_image_updates_interval_min', 10)) },
    customUpdates: { enabled: g('poll_custom_updates_enabled') !== '0',intervalMin: parseInt(g('poll_custom_updates_interval_min', 10)) },
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
  if (info)          { save('poll_info_enabled', info.enabled ? '1' : '0');                   save('poll_info_interval_min', Math.max(1, parseInt(info.intervalMin, 10) || 5)); }
  if (updates)       { save('poll_updates_enabled', updates.enabled ? '1' : '0');             save('poll_updates_interval_min', Math.max(1, parseInt(updates.intervalMin, 10) || 60)); }
  if (imageUpdates)  { save('poll_image_updates_enabled', imageUpdates.enabled ? '1' : '0'); save('poll_image_updates_interval_min', Math.max(1, parseInt(imageUpdates.intervalMin, 10) || 360)); }
  if (customUpdates) { save('poll_custom_updates_enabled', customUpdates.enabled ? '1' : '0');save('poll_custom_updates_interval_min', Math.max(1, parseInt(customUpdates.intervalMin, 10) || 360)); }
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
// Audit visibility is a deliberately assignable read capability.  The UI
// exposes recent object tasks on platform, node and VM pages, so using the
// broader admin guard here made those pages silently fail for an otherwise
// authorised operator.  Mutating system endpoints below remain admin-only.
router.get('/audit', requireCap('canViewAudit'), (req, res) => {
  try {
    const { action, user, ip, success, from, to } = req.query;
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = queryVisibleAuditRows(
      { environmentId, action, user, ip, success, from, to },
      getPermissions(req.user),
    ).slice(offset, offset + limit);
    res.json(rows.map(row => ({ ...row, object_links: auditObjectLinks(row.detail, environmentId) })));
  } catch (error) {
    serverError(res, error, 'audit log');
  }
});

// GET /api/system/audit/export - filtered, spreadsheet-compatible audit export
router.get('/audit/export', requireCap('canViewAudit'), (req, res) => {
  try {
    const { action, user, ip, success, from, to } = req.query;
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const rows = queryVisibleAuditRows(
      { environmentId, action, user, ip, success, from, to },
      getPermissions(req.user),
    ).slice(0, 10_000);
    const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const body = [
      ['Zeitpunkt', 'Aktion', 'Benutzer', 'IP-Adresse', 'Erfolg', 'Details'],
      ...rows.map(row => [row.created_at, row.action, row.user, row.ip, row.success ? 'ja' : 'nein', row.detail]),
    ].map(row => row.map(csv).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fleet-audit-log.csv"');
    res.send(`\ufeff${body}`);
    db.auditLog.write('system.audit_export', `rows=${rows.length}`, req.ip, true, req.user?.username);
  } catch (error) {
    serverError(res, error, 'audit export');
  }
});

// GET /api/system/audit/meta - Filter options for audit log UI
router.get('/audit/meta', requireCap('canViewAudit'), (req, res) => {
  try {
    const { action, user, ip, success, from, to } = req.query;
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const permissions = getPermissions(req.user);
    const rows = queryVisibleAuditRows({ environmentId, action, user, ip, success, from, to }, permissions);
    const allVisibleRows = queryVisibleAuditRows({ environmentId }, permissions);
    res.json({
      actions: [...new Set(allVisibleRows.map(row => row.action).filter(Boolean))].sort(),
      users: [...new Set(allVisibleRows.map(row => row.user).filter(Boolean))].sort(),
      count: rows.length,
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
