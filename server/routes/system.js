const { validHistoryRange } = require('../utils/history-date-range');
const {sshKeyAuditDetail} = require('../utils/ssh-key-audit');
const {auditCsv} = require('../utils/audit-export');
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
const { releaseStatus } = require('../services/release-check');
const log = require('../utils/logger').child('system');
const { rotateJwtSecret } = require('../utils/jwt-secret');
const { getPermissions } = require('../utils/permissions');
const { filterAuditFocus, queryVisibleAuditRows } = require('../utils/audit-scope');

const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many deploy attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const keyExportLimiter = rateLimit({windowMs:15 * 60 * 1000,max:10,message:{error:'Too many private-key export attempts. Please wait 15 minutes.'},standardHeaders:true,legacyHeaders:false});

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
function auditObjectLinks(detail, environmentId = 'default', action = '') {
  const text = String(detail || '');
  if (String(action).startsWith('git.')) return [];
  // A reused name identifies a different object after deletion. Historical
  // deletion records must never navigate to that replacement.
  if (['server.delete', 'server.deleted', 'ipam.subnet_delete'].includes(action)) return [];
  if (['server.create', 'server.created'].includes(action) && text.includes('server_id=')) {
    const id = text.match(/(?:^|\s)server_id="([^"\r\n]+)"(?:\s|$)/)?.[1];
    const host = id && db.db.prepare('SELECT id,name FROM servers WHERE id=? AND environment_id=?').get(id, environmentId);
    return host ? [{kind:'server',id:host.id,label:host.name,href:`/servers/${host.id}`}] : [];
  }
  if (action === 'server.update' && text.startsWith('{')) {
    try {
      const record = JSON.parse(text);
      if (record.kind !== 'host-change' || record.version !== 1) return [];
      const host = db.db.prepare('SELECT id,name FROM servers WHERE id=? AND environment_id=?').get(record.resource?.id, environmentId);
      return host ? [{kind:'server',id:host.id,label:host.name,href:`/servers/${host.id}`}] : [];
    } catch { return []; }
  }
  const links = [];
  const seen = new Set();
  const add = (kind, id, label, href) => {
    if (!id || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    links.push({ kind, id, label, href });
  };

  // These events record historical names and user-controlled task names.
  // Only the canonical host ID identifies their resource, including after
  // task deletion or a host rename. Never fall back to text inside a name.
  if (['server.notes_update', 'terminal.connect', 'terminal.connect_failed', 'terminal.disconnect',
    'custom_update.create', 'custom_update.update', 'custom_update.delete',
    'custom_update.check', 'custom_update.preview'].includes(action)) {
    const id = text.match(/(?:^|\s)server_id="([^"\r\n]+)"(?:\s|$)/)?.[1];
    if (id) {
      const row = db.db.prepare('SELECT id, name FROM servers WHERE id = ? AND environment_id = ?').get(id, environmentId);
      if (row) add('server', row.id, row.name, `/servers/${row.id}${action === 'server.notes_update' ? '#tab=notes' : ''}`);
    }
    return links;
  }

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
// GET /api/system/release — running version and whether a newer stable release exists.
router.get('/release', async (req, res) => {
  res.json(await releaseStatus());
});

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
    const rawName = req.body.name || 'fleet';
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
router.post('/key/export', adminOnly, keyExportLimiter, require('../middleware/administrator-credentials')('private-key export', 'exporting the private key'), (req, res) => {
  try {
    const passphrase = typeof req.body.passphrase === 'string' ? req.body.passphrase : '';
    const key = sshManager.getPrivateKeyExport(passphrase);
    db.auditLog.write('ssh.export', `SSH private key exported${passphrase ? ' (passphrase-protected)' : ''}`, req.ip, true, req.user?.username);
    res.setHeader('Cache-Control','no-store');
    res.json({ privateKey: key, success: true });
  } catch (error) {
    db.auditLog.write('ssh.export', 'SSH private key export failed', req.ip, false, req.user?.username);
    serverError(res, error, 'export SSH key');
  }
});

// Preview validates candidate key material without activating it.
router.post('/key/import-preview', adminOnly, keyExportLimiter, (req,res) => {
  try {
    const {privateKey,passphrase} = req.body || {};
    if (typeof privateKey !== 'string' || !privateKey || privateKey.length > 65536 || (passphrase !== undefined && typeof passphrase !== 'string')) return res.status(400).json({error:'Provide a private key of at most 64 KiB and a text passphrase.'});
    const candidate=sshManager.inspectImport(privateKey,passphrase || '');
    const current=sshManager.getKeyInfo();
    res.setHeader('Cache-Control','no-store');
    res.json({candidate,current:current ? {id:current.id,fingerprint:current.fingerprint,algorithm:current.algorithm} : null});
  } catch {res.status(400).json({error:'Invalid SSH private key or wrong passphrase.'});}
});

// POST /api/system/key/import - Import private key
router.post('/key/import', adminOnly, keyExportLimiter, (req, res) => {
  try {
    const { privateKey, passphrase, expectedKeyId, expectedFingerprint } = req.body;
    if (!Object.hasOwn(req.body,'expectedKeyId') || (expectedKeyId !== null && typeof expectedKeyId !== 'string') || typeof expectedFingerprint !== 'string' || !expectedFingerprint) return res.status(428).json({error:'Preview the key replacement before importing.'});
    if (typeof passphrase !== 'undefined' && typeof passphrase !== 'string') return res.status(400).json({error:'Passphrase must be text.'});
    if (!privateKey || typeof privateKey !== 'string' || privateKey.length > 65536) {
      return res.status(400).json({ error: 'privateKey is required' });
    }
    const result = sshManager.importKey(privateKey, 'fleet_imported', passphrase || '', (before,after) => {
      db.auditLog.write('ssh.import', sshKeyAuditDetail(before,after), req.ip, true, req.user?.username);
    }, candidate => {
      if ((db.sshKeys.getFirst()?.id || null) !== expectedKeyId || candidate.fingerprint !== expectedFingerprint) {const error=new Error('The current or selected key changed. Preview the replacement again.');error.status=409;throw error;}
    });
    res.json(result);
  } catch (error) {
    db.auditLog.write('ssh.import', 'SSH private key import failed', req.ip, false, req.user?.username);
    if (error.status === 409) return res.status(409).json({error:error.message});
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
    // not an internal Fleet crash. Keep implementation details in the log.
    log.warn({ err: error, serverId: req.body?.server_id, ipAddress: req.body?.ip_address }, 'SSH key deployment failed');
    if (!res.headersSent) res.status(502).json({ error: 'The SSH key could not be installed. Check the IP address, SSH user, password, and host reachability.' });
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
// The private Fleet key stays central. These records only declare the
// resources for which its public part is intended, making access intent
// visible in the console and auditable without duplicating key material.
router.get('/key-assignments', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
  const rows = db.db.prepare('SELECT * FROM ssh_key_assignments WHERE environment_id = ? ORDER BY target_type, target_label COLLATE NOCASE').all(environmentId);
  res.json(rows);
});

router.get('/key-assignment-targets', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(404).json({ error: 'Environment not found.' });
  res.json(sshAssignmentTargets(environmentId));
});

router.put('/key-assignments', adminOnly, (req, res) => {
  const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
  const targetType = String(req.body?.target_type || '').trim();
  const targetId = String(req.body?.target_id || '').trim();
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found.' });
  const target = resolveSshAssignmentTarget(targetType, targetId, environmentId);
  if (!target) return res.status(400).json({ error: 'The target is invalid or belongs to a different environment.' });
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
  if (!row || (req.environmentId && row.environment_id !== req.environmentId)) return res.status(404).json({ error: 'Key assignment not found.' });
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
      agentEnabled:         false,
      webhookUrl:           raw.webhook_url     || '',
      webhookSecret:        raw.webhook_secret  ? '••••••••' : '',
      smtpHost:             raw.smtp_host       || '',
      smtpPort:             raw.smtp_port       || '587',
      smtpSecurity: raw.smtp_security || (raw.smtp_host ? (raw.smtp_port === '465' ? 'tls' : 'legacy') : 'starttls'),
      smtpUser:             raw.smtp_user       || '',
      hasSmtpPassword:      Boolean(raw.smtp_pass),
      smtpFrom:             raw.smtp_from       || '',
      smtpTo:               raw.smtp_to         || '',
      notifDedupeMinutes: Number(raw.notify_dedupe_minutes || 0),
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
            smtpHost, smtpPort, smtpSecurity, smtpUser, smtpPass, smtpFrom, smtpTo,
            notifPlaybookFailed, notifUpdateFailed, notifResourceAlerts } = req.body;
    const dedupeMinutes = req.body.notifDedupeMinutes;
    if (dedupeMinutes !== undefined && (!Number.isInteger(dedupeMinutes) || dedupeMinutes < 0 || dedupeMinutes > 60)) return res.status(400).json({error:'notifDedupeMinutes must be an integer from 0 to 60.'});
    if (appName !== undefined && (typeof appName !== 'string' || appName.length > 100)) return res.status(400).json({error:'appName must be text up to 100 characters',field:'appName'});
    if (accentColor !== undefined && (typeof accentColor !== 'string' || (accentColor !== '' && !/^#[0-9a-f]{6}$/i.test(accentColor)))) return res.status(400).json({error:'accentColor must be empty or a six-digit hex color',field:'accentColor'});
    if (logoImage !== undefined) {
      if (typeof logoImage !== 'string') return res.status(400).json({ error: 'logoImage must be a string' });
      if (logoImage.length > 32768) return res.status(400).json({ error: 'logoImage too large (max 32 KB)' });
    }
    if (schedulerTimezone !== undefined) {
      if (!isValidTimeZone(schedulerTimezone)) return res.status(400).json({ error: 'Invalid schedulerTimezone' });
    }
    if (agentEnabled !== undefined) {
      if (agentEnabled !== false) return res.status(400).json({ error: 'Agent support has been removed. Use SSH collection.' });
    }
    if (notifPlaybookFailed !== undefined) {
      if (typeof notifPlaybookFailed !== 'boolean') return res.status(400).json({ error: 'notifPlaybookFailed must be a boolean' });
    }
    if (notifUpdateFailed !== undefined) {
      if (typeof notifUpdateFailed !== 'boolean') return res.status(400).json({ error: 'notifUpdateFailed must be a boolean' });
    }
    if (notifResourceAlerts !== undefined) {
      if (typeof notifResourceAlerts !== 'boolean') return res.status(400).json({ error: 'notifResourceAlerts must be a boolean' });
    }
    if (smtpSecurity !== undefined && !['tls','starttls','plain','legacy'].includes(smtpSecurity)) return res.status(400).json({error:'Invalid SMTP transport mode',field:'smtpSecurity'});
    if (smtpSecurity === 'legacy' && db.settings.get('smtp_security') !== 'legacy' && (!db.settings.get('smtp_host') || db.settings.get('smtp_security'))) return res.status(400).json({error:'Legacy mode is only available for an existing legacy configuration'});
    if (smtpPort !== undefined && !((typeof smtpPort === 'number' && Number.isInteger(smtpPort) || typeof smtpPort === 'string' && /^\d+$/.test(smtpPort)) && Number(smtpPort) >= 1 && Number(smtpPort) <= 65535))
      return res.status(400).json({error:'SMTP port must be a whole number from 1 to 65535.',field:'smtpPort'});
    if (webhookUrl !== undefined) {
      if (typeof webhookUrl !== 'string' || webhookUrl.length > 1000) return res.status(400).json({error:'Webhook URL must be text up to 1000 characters.',field:'webhookUrl'});
      if (webhookUrl.trim()) {
        try {
          const url = new URL(webhookUrl.trim());
          if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
        } catch { return res.status(400).json({error:'Use an HTTP or HTTPS webhook URL without embedded credentials.',field:'webhookUrl'}); }
      }
    }
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    db.db.transaction(() => {
      if (appName       !== undefined) db.settings.set('wl_app_name',     str(appName, 100));
      if (appTagline    !== undefined) db.settings.set('wl_app_tagline',  str(appTagline, 500));
      if (accentColor   !== undefined) db.settings.set('wl_accent_color', str(accentColor, 20));
      if (showIcon      !== undefined) db.settings.set('wl_show_icon',    showIcon ? '1' : '0');
      if (logoIcon      !== undefined) db.settings.set('wl_logo_icon',    str(logoIcon, 64));
      if (logoImage     !== undefined) {
        db.settings.set('wl_logo_image', logoImage);
      }
      if (theme         !== undefined) db.settings.set('ui_theme',        str(theme, 20));
      if (timeFormat    !== undefined) db.settings.set('ui_time_format',  str(timeFormat, 10));
      if (schedulerTimezone !== undefined) {
        db.settings.set('scheduler_timezone', schedulerTimezone.trim());
      }
      if (agentEnabled !== undefined) {
        db.settings.set('agent_enabled', '0');
      }
      if (webhookUrl    !== undefined) db.settings.set('webhook_url',     webhookUrl.trim());
      if (webhookSecret !== undefined && webhookSecret !== '••••••••') setSecret(db, 'webhook_secret',  str(webhookSecret, 500));
      if (smtpHost      !== undefined) db.settings.set('smtp_host',       str(smtpHost, 255));
      if (smtpSecurity !== undefined) db.settings.set('smtp_security', smtpSecurity);
      if (smtpPort      !== undefined) db.settings.set('smtp_port',       String(Number(smtpPort)));
      if (smtpUser      !== undefined) db.settings.set('smtp_user',       str(smtpUser, 256));
      if (smtpPass      !== undefined) setSecret(db, 'smtp_pass',       str(smtpPass, 500));
      if (smtpFrom      !== undefined) db.settings.set('smtp_from',       str(smtpFrom, 256));
      if (smtpTo               !== undefined) db.settings.set('smtp_to',                  str(smtpTo, 256));
      if (notifPlaybookFailed !== undefined) {
        db.settings.set('notify_playbook_failed', notifPlaybookFailed ? '1' : '0');
      }
      if (notifUpdateFailed !== undefined) {
        db.settings.set('notify_update_failed', notifUpdateFailed ? '1' : '0');
      }
      if (notifResourceAlerts !== undefined) {
        db.settings.set('notify_resource_alerts', notifResourceAlerts ? '1' : '0');
      }
      if (dedupeMinutes !== undefined) db.settings.set('notify_dedupe_minutes', String(dedupeMinutes));
      const fields = ['appName','appTagline','accentColor','showIcon','logoIcon','logoImage','theme','timeFormat','schedulerTimezone','agentEnabled','webhookUrl','webhookSecret','smtpHost','smtpPort','smtpSecurity','smtpUser','smtpPass','smtpFrom','smtpTo','notifPlaybookFailed','notifUpdateFailed','notifResourceAlerts','notifDedupeMinutes'].filter(key=>req.body[key]!==undefined);
      db.auditLog.write('system.settings', `Updated settings: ${fields.join(', ')}`, req.ip, true, req.user?.username);
    })();
    if (schedulerTimezone !== undefined) scheduler.reloadAllSchedules();
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'save settings');
  }
});

// Global channel history, restricted to administrators like the channel settings.
router.get('/notification-deliveries', adminOnly, (req, res) => {
  const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));
  const pageSize = 25;
  const total = db.db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE created_at >= datetime('now', '-30 days')").get().count;
  const items = db.db.prepare("SELECT * FROM notification_deliveries WHERE created_at >= datetime('now', '-30 days') ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all(pageSize, (page - 1) * pageSize);
  res.json({ items, total, page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(total / pageSize)) });
});

// POST /api/system/webhook-test - Send a test webhook notification
router.post('/webhook-test', adminOnly, async (req, res) => {
  if (!db.settings.get('webhook_url')) return res.status(400).json({ error: 'Save a webhook URL before testing.' });
  try {
    const result = await sendWebhook('Fleet Test', 'This is a test notification from Fleet.', true);
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
  if (!db.settings.get('smtp_host') || !db.settings.get('smtp_to')) return res.status(400).json({ error: 'Save an SMTP host and recipient before testing.' });
  try {
    const result = await sendEmail('Fleet Test', 'This is a test email from Fleet.', true);
    if (!result?.ok) return res.status(502).json({ error: result?.partial ? 'The mail server rejected some recipients. Check the configured recipient list.' : 'The mail server did not accept the test message.' });
    res.json({ success: true });
  } catch (error) {
    serverError(res, error, 'smtp test');
  }
});

// Runtime observation only: does not start checks or change configuration.
router.get('/polling-status', adminOnly, (req,res) => {
  res.set('Cache-Control','no-store');
  res.json(scheduler.getRuntimeStatus());
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
  const prefixes = {info:'poll_info',updates:'poll_updates',imageUpdates:'poll_image_updates',customUpdates:'poll_custom_updates'};
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !Object.hasOwn(prefixes,key)))
    return res.status(400).json({error:'Provide one or more recognized polling sections.'});
  for (const [name, section] of Object.entries(body)) {
    if (!section || typeof section !== 'object' || Array.isArray(section) || typeof section.enabled !== 'boolean')
      return res.status(400).json({error:`${name}.enabled must be a boolean`,field:`${name}.enabled`});
    if (!Number.isInteger(section.intervalMin) || section.intervalMin < 1 || section.intervalMin > 9999)
      return res.status(400).json({error:`${name}.intervalMin must be a whole number from 1 to 9999`,field:`${name}.intervalMin`});
    if (Object.keys(section).some(key => key !== 'enabled' && key !== 'intervalMin'))
      return res.status(400).json({error:`Unknown field in ${name}`,field:name});
  }
  try {
    db.db.transaction(() => {
      for (const [name, section] of Object.entries(body)) {
        db.settings.set(`${prefixes[name]}_enabled`,section.enabled ? '1':'0');
        db.settings.set(`${prefixes[name]}_interval_min`,String(section.intervalMin));
      }
      db.auditLog.write('system.polling', 'Polling configuration updated', req.ip, true, req.user?.username);
    })();
  } catch (error) { return serverError(res,error,'save polling configuration'); }
  scheduler.restartPolling();
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
    const { action, user, ip, success, from, to, focus, q } = req.query;
    if ((from !== undefined && typeof from !== 'string') || (to !== undefined && typeof to !== 'string') || !validHistoryRange(from, to)) return res.status(400).json({error:'Invalid audit date range.'});
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) return res.status(400).json({error:'Search must be text of at most 200 characters.'});
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = filterAuditFocus(queryVisibleAuditRows(
      { environmentId, action, user, ip, success, from, to, q },
      getPermissions(req.user),
    ), focus).slice(offset, offset + limit);
    res.json(rows.map(row => ({ ...row, object_links: auditObjectLinks(row.detail, environmentId, row.action) })));
  } catch (error) {
    serverError(res, error, 'audit log');
  }
});

// GET /api/system/audit/export - filtered, spreadsheet-compatible audit export
router.get('/audit/export', requireCap('canViewAudit'), (req, res) => {
  try {
    const { action, user, ip, success, from, to, focus, q } = req.query;
    if ((from !== undefined && typeof from !== 'string') || (to !== undefined && typeof to !== 'string') || !validHistoryRange(from, to)) return res.status(400).json({error:'Invalid audit date range.'});
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) return res.status(400).json({error:'Search must be text of at most 200 characters.'});
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const rows = filterAuditFocus(queryVisibleAuditRows(
      { environmentId, action, user, ip, success, from, to, q },
      getPermissions(req.user),
    ), focus);
    if (rows.length > 10_000) return res.status(400).json({error:`${rows.length} audit entries match. Narrow the filters to at most 10000 entries before exporting.`, matching:rows.length, limit:10_000});
    const body = auditCsv(rows);
    db.auditLog.write('system.audit_export', `rows=${rows.length}`, req.ip, true, req.user?.username, environmentId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fleet-audit-log.csv"');
    res.send(body);
  } catch (error) {
    serverError(res, error, 'audit export');
  }
});

// GET /api/system/audit/meta - Filter options for audit log UI
router.get('/audit/meta', requireCap('canViewAudit'), (req, res) => {
  try {
    const { action, user, ip, success, from, to, focus, q } = req.query;
    if ((from !== undefined && typeof from !== 'string') || (to !== undefined && typeof to !== 'string') || !validHistoryRange(from, to)) return res.status(400).json({error:'Invalid audit date range.'});
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) return res.status(400).json({error:'Search must be text of at most 200 characters.'});
    const environmentId = req.environmentId || String(req.query.environment_id || 'default').trim() || 'default';
    const permissions = getPermissions(req.user);
    const rows = filterAuditFocus(queryVisibleAuditRows({ environmentId, action, user, ip, success, from, to, q }, permissions), focus);
    const allVisibleRows = filterAuditFocus(queryVisibleAuditRows({ environmentId }, permissions), focus);
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

router.use('/database-backup', require('./database-backup'));
router.use('/backup-targets', require('./backup-targets'));

module.exports = router;
