const express = require('express');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Client: SshClient } = require('ssh2');
const log = require('./utils/logger');
const { serverError } = require('./utils/http-error');
const { createComposeTempFile, buildComposeWriteOperations } = require('./utils/compose-write');
const db = require('./db');
const ansibleRunner = require('./services/ansible-runner');
const sshManager = require('./services/ssh-manager');
const systemInfo = require('./services/system-info');
const { notify } = require('./services/notifier');

const app = express();

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// ── HTTPS / HTTP ──────────────────────────────────────────────
const SSL_KEY  = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;
let server;
let isHttps = false;

if (SSL_KEY && SSL_CERT) {
  let key, cert;
  try {
    key  = fs.readFileSync(SSL_KEY);
    cert = fs.readFileSync(SSL_CERT);
  } catch (e) {
    log.fatal({ err: e, SSL_KEY, SSL_CERT }, 'Failed to read certificate files');
    process.exit(1);
  }
  server  = https.createServer({ key, cert }, app);
  isHttps = true;
} else {
  server = http.createServer(app);
}

const wss    = new WebSocketServer({ noServer: true });
const wssSsh = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Reject browser connections from unconfigured origins
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin && !isAllowedRequestOrigin(allowedOrigins, origin, host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (pathname === '/ws/ssh') {
    wssSsh.handleUpgrade(req, socket, head, ws => wssSsh.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || (isHttps ? 443 : 3001);

// Middleware
const { parseAllowedOrigins, isAllowedRequestOrigin } = require('./utils/allowed-origins');
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '2mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (req.path.startsWith('/api/')) {
      log.child({ module: 'http' })[level]({
        method: req.method, url: req.path, status: res.statusCode, duration,
      }, 'request');
    }
  });
  next();
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  const isProduction = process.env.NODE_ENV === 'production';
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // In production the Vite build emits only external module scripts — no inline scripts needed.
      // In development the Express server does not serve the frontend, so this only applies in production.
      isProduction ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));
}

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  try {
    db.db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
  } catch (e) {
    log.error({ err: e }, 'Health check failed');
    res.status(500).json({ status: 'error', error: 'Database unavailable' });
  }
});

// Auth – mount BEFORE the auth middleware so login/setup routes are always reachable
const { router: authRouter } = require('./routes/auth');
const { getJwtSecret } = require('./utils/jwt-secret');
const authMiddleware = require('./middleware/auth');
const agentRouter = require('./routes/agent');
app.use('/api/auth', authRouter);
app.use('/api/v1/agent', agentRouter);

// Users management (admin-only, enforced inside the router)
const usersRouter = require('./routes/users');
const rolesRouter = require('./routes/roles');
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/roles', authMiddleware, rolesRouter);

// Protect all other /api routes
app.use('/api', authMiddleware);

// Lightweight ping endpoint for latency measurement (responds immediately, no DB/SSH)
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// API Routes
const resetRouter        = require('./routes/reset');
const serversRouter      = require('./routes/servers');
const systemRouter       = require('./routes/system');
const playbooksRouter    = require('./routes/playbooks');
const schedulesRouter    = require('./routes/schedules');
const customUpdatesRouter = require('./routes/custom-updates');
const pluginsAdminRouter = require('./routes/plugins-admin');
const pluginLoader       = require('./services/plugin-loader');
const scheduleHistoryRouter = require('./routes/schedule-history');
const ansibleVarsRouter  = require('./routes/ansible-vars');
const adhocRouter        = require('./routes/adhoc');
const gitPlaybooksRouter = require('./routes/git-playbooks');
const agentAdminRouter   = require('./routes/agent-admin');
const gitSync            = require('./services/git-sync');
const manifestService    = require('./services/agent-manifest');
app.use('/api/reset', resetRouter);
app.use('/api/servers', serversRouter);
app.use('/api/servers/:id/custom-updates', customUpdatesRouter);
app.use('/api/system', systemRouter);
app.use('/api/playbooks', playbooksRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/schedule-history', scheduleHistoryRouter);
app.use('/api/ansible-vars', ansibleVarsRouter);
app.use('/api/adhoc', adhocRouter);
app.use('/api/playbooks-git', gitPlaybooksRouter);
app.use('/api/plugins', pluginsAdminRouter);
app.use('/api/v1', agentAdminRouter);

// Dynamic plugin data routes — auth is handled inside each plugin's own router
app.use('/api/plugin/:pluginId', (req, res, next) => {
  const { pluginId } = req.params;
  const pluginRouter = pluginLoader.getRouter(pluginId);
  if (!pluginRouter) return res.status(404).json({ error: `Plugin '${pluginId}' not found or not enabled` });
  pluginRouter(req, res, next);
});

// Serve plugin UI files (only for enabled plugins)
app.get('/plugins/:pluginId/ui.js', (req, res) => {
  const { pluginId } = req.params;
  if (!pluginLoader.isEnabled(pluginId)) {
    return res.status(404).type('application/javascript').send('// Plugin not found or not enabled\n');
  }
  const uiPath = pluginLoader.getUiPath(pluginId);
  if (!uiPath) {
    return res.status(404).type('application/javascript').send('// ui.js not found\n');
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(uiPath);
});

const { getPermissions, filterServers, filterPlugins, can, guardServerAccess } = require('./utils/permissions');
const { isValidPlaybook, validateTargets, parseTargetExpression, resolveTargets } = require('./utils/validate');

// GET /api/dashboard – aggregated stats from DB cache (no SSH, instant)
app.get('/api/dashboard', (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    const servers = filterServers(db.servers.getAll(), perms);
    const online = servers.filter(s => s.status === 'online').length;
    const offline = servers.filter(s => s.status === 'offline').length;

    let rebootRequired = 0;
    let totalUpdates = 0;
    let criticalDisk = 0;
    let criticalRam = 0;

    const serverStats = servers.map(s => {
      const info = db.serverInfo.get(s.id);
      const updates = db.updatesCache.get(s.id) || [];
      const containers = db.dockerContainers.getByServer(s.id);
      const imageUpdatesMeta = db.dockerImageUpdatesCache.getWithMeta(s.id);
      const imageUpdates = imageUpdatesMeta ? imageUpdatesMeta.results : null;
      const agentCfg = db.agentConfig.getByServerId(s.id);

      if (info?.reboot_required) rebootRequired++;
      totalUpdates += updates.filter(u => !u.phased).length;

      const isOnline = s.status === 'online';
      const ramPct = (isOnline && info?.ram_total_mb) ? Math.round((info.ram_used_mb / info.ram_total_mb) * 100) : null;
      const diskPct = (isOnline && info?.disk_total_gb) ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : null;
      if (ramPct > 85) criticalRam++;
      if (diskPct > 85) criticalDisk++;

      let agentMode = 'legacy';
      let agentState = 'legacy';
      let agentLastSeen = null;
      if (agentCfg && agentCfg.mode && agentCfg.mode !== 'legacy') {
        agentMode = agentCfg.mode;
        agentLastSeen = agentCfg.last_seen || null;
        const intervalSec = Math.max(5, parseInt(agentCfg.interval, 10) || 30);
        const seenMs = agentCfg.last_seen ? new Date(agentCfg.last_seen).getTime() : 0;
        if (!seenMs) {
          agentState = 'failed';
        } else {
          const ageMs = Date.now() - seenMs;
          if (ageMs <= intervalSec * 3 * 1000) agentState = 'ok';
          else if (ageMs <= intervalSec * 10 * 1000) agentState = 'warning';
          else agentState = 'failed';
        }
      }

      return {
        id: s.id,
        name: s.name,
        ip_address: s.ip_address,
        tags: JSON.parse(s.tags || '[]'),
        status: s.status,
        last_seen: s.last_seen,
        os: info?.os || null,
        uptime_seconds: isOnline ? (info?.uptime_seconds || null) : null,
        ram_pct: ramPct,
        disk_pct: diskPct,
        cpu_pct: isOnline ? (info?.cpu_usage_pct ?? null) : null,
        load_avg: isOnline ? (info?.load_avg || null) : null,
        reboot_required: !!info?.reboot_required,
        updates_count: updates.filter(u => !u.phased).length,
        containers_running: containers.filter(c => c.state === 'running').length,
        containers_total: containers.length,
        image_updates_count: imageUpdates === null ? null : imageUpdates.filter(r => r.status === 'update_available').length,
        image_updates_checked_at: imageUpdatesMeta?.updated_at || null,
        custom_updates_count: db.customUpdateTasks.countHasUpdate(s.id),
        info_cached_at: info?.updated_at || null,
        agent_mode: agentMode,
        agent_state: agentState,
        agent_last_seen: agentLastSeen,
      };
    });

    // Fetch more rows than needed so we can filter by accessible servers
    const allRecentHistory = db.db.prepare(`
      SELECT h.*, s.name as server_name
      FROM update_history h
      LEFT JOIN servers s ON h.server_id = s.id
      ORDER BY h.started_at DESC LIMIT 500
    `).all();

    // Always filter history against the permission-filtered server list.
    // A user should see:
    //   1. Entries where server_id matches a server UUID they can access
    //   2. Entries where server_id matches a server name they can access (ansible stores names)
    //   3. Entries for bulk/ansible runs (server_id = 'all' | 'bulk_update' | etc.)
    //      — only if the user is not server-restricted (full access or servers = 'all')
    const isServerRestricted = perms && !perms.full && perms.servers !== 'all' && perms.servers != null;
    const allowedServerIds   = new Set(servers.map(s => s.id));
    const allowedServerNames = new Set(servers.map(s => s.name));

    const recentHistory = allRecentHistory.filter(h => {
      // Entry belongs to a server UUID the user can access
      if (allowedServerIds.has(h.server_id)) return true;
      // Entry uses ansible server name instead of UUID
      if (allowedServerNames.has(h.server_id)) return true;
      // Bulk / global runs (no specific server) — only show to unrestricted users
      if (!isServerRestricted) return true;
      return false;
    }).slice(0, 8);

    res.json({
      summary: { total: servers.length, online, offline, unknown: servers.length - online - offline, rebootRequired, totalUpdates, criticalDisk, criticalRam },
      servers: serverStats,
      recentHistory,
    });
  } catch (e) {
    serverError(res, e, 'dashboard stats');
  }
});

// ── Rate limiters for destructive actions ─────────────────────────────────────
const rebootLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many reboot requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const containerRestartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many restart requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const customUpdateRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many update executions. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const composeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many compose requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Ansible execution via REST + WebSocket

// POST /api/ansible/run - Run a playbook with WebSocket output
app.post('/api/ansible/run', async (req, res) => {
  const perms = getPermissions(req.user);
  if (!can(perms, 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
  const { playbook, targets, extraVars } = req.body;
  if (!playbook) return res.status(400).json({ error: 'playbook is required' });
  if (!isValidPlaybook(playbook)) return res.status(400).json({ error: 'Invalid playbook filename' });

  // Playbook whitelist: restricted roles may only run their permitted playbooks
  if (!perms.full && perms.playbooks !== 'all') {
    if (!Array.isArray(perms.playbooks) || !perms.playbooks.includes(playbook)) {
      return res.status(403).json({ error: 'Playbook not permitted for your role' });
    }
  }

  const targetsErr = validateTargets(targets);
  if (targetsErr) return res.status(400).json({ error: targetsErr });
  const normalizedTargets = typeof targets === 'string' ? targets.trim() : targets;
  if (!normalizedTargets) return res.status(400).json({ error: 'targets is required' });

  // Target authorization: restricted users may only run against their accessible servers
  if (!perms.full && perms.servers !== 'all') {
    const parsedTargets = parseTargetExpression(normalizedTargets);
    if (parsedTargets.kind !== 'list' || parsedTargets.included.length === 0) {
      return res.status(403).json({ error: 'Restricted users must specify individual server targets' });
    }
    const accessibleNames = new Set(filterServers(db.servers.getAll(), perms).map(s => s.name));
    const forbidden = parsedTargets.included.filter(t => !accessibleNames.has(t));
    if (forbidden.length > 0) {
      return res.status(403).json({ error: `Access denied to: ${forbidden.join(', ')}` });
    }
  }
  if (extraVars && (typeof extraVars !== 'object' || Array.isArray(extraVars) ||
      Object.values(extraVars).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
    return res.status(400).json({ error: 'extraVars must be a flat object with string/number/boolean values' });
  }
  if (extraVars && JSON.stringify(extraVars).length > 4096) {
    return res.status(400).json({ error: 'extraVars too large (max 4KB)' });
  }

  const historyId = db.updateHistory.create(
    normalizedTargets,
    `ansible:${playbook}`
  );
  const resolvedTargets = resolveTargets(normalizedTargets, db.servers.getAll());
  const schedHistId = db.scheduleHistory.create(null, 'Quick Run', playbook, resolvedTargets);

  res.json({ historyId, status: 'started' });

  // Sync playbooks from git before running
  await gitSync.autoPull();

  // Run playbook and stream output via WebSocket
  try {
    const result = await ansibleRunner.runPlaybook(
      playbook,
      normalizedTargets,
      extraVars || {},
      (type, data) => {
        broadcast({ type: 'ansible_output', historyId, stream: type, data });
      }
    );

    const status = result.success ? 'success' : 'failed';
    const output = result.stdout + result.stderr;
    db.updateHistory.updateStatus(historyId, status, output);
    db.scheduleHistory.complete(schedHistId, status, output);
    db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} status=${status}`, req.ip, result.success, req.user?.username);
    // Invalidate update cache for targeted servers
    for (const s of db.servers.getAll()) {
      if (resolvedTargets.split(',').includes(s.name)) db.updatesCache.delete(s.id);
    }
    broadcast({ type: 'ansible_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.scheduleHistory.complete(schedHistId, 'failed', error.message);
    db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} error=${error.message}`, req.ip, false, req.user?.username);
    broadcast({ type: 'ansible_error', historyId, error: error.message });
    if (db.settings.get('notify_playbook_failed') !== '0') notify(`Playbook failed: ${playbook}`, error.message, false).catch(() => {});
  }
});

// POST /api/servers/:id/update - Run system update on a server
app.post('/api/servers/:id/update', guardServerAccess, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRunUpdates')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const serverId = req.params.id;
  const server = req.server;

  const historyId = db.updateHistory.create(serverId, 'system_update');

  res.json({ historyId, status: 'started' });

  try {
    const result = await ansibleRunner.runPlaybook(
      'update.yml',
      server.name,
      {},
      (type, data) => {
        broadcast({ type: 'update_output', serverId, historyId, stream: type, data });
      }
    );

    const status = result.success ? 'success' : 'failed';
    db.updateHistory.updateStatus(historyId, status, result.stdout + result.stderr);
    db.auditLog.write('server.update', `server=${server.name} status=${status}`, req.ip, result.success, req.user?.username);
    db.updatesCache.delete(serverId);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.auditLog.write('server.update', `server=${server.name} error=${error.message}`, req.ip, false, req.user?.username);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
    if (db.settings.get('notify_update_failed') !== '0') notify(`Update failed: ${server.name}`, error.message, false).catch(() => {});
  }
});

// POST /api/servers/update-all - Run system update on all servers
app.post('/api/servers/update-all', (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRunUpdates')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const historyId = db.updateHistory.create('bulk_update', 'system_update_all');
  res.json({ historyId, status: 'started' });

  try {
    const result = await ansibleRunner.runPlaybook(
      'update.yml',
      'all',
      {},
      (type, data) => {
        broadcast({ type: 'bulk_update_output', historyId, stream: type, data });
      }
    );

    const status = result.success ? 'success' : 'failed';
    db.updateHistory.updateStatus(historyId, status, result.stdout + result.stderr);
    db.auditLog.write('server.update_all', `status=${status}`, req.ip, result.success, req.user?.username);
    broadcast({ type: 'bulk_update_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.auditLog.write('server.update_all', `error=${error.message}`, req.ip, false, req.user?.username);
    broadcast({ type: 'bulk_update_error', historyId, error: error.message });
    if (db.settings.get('notify_update_failed') !== '0') notify('Bulk update failed', error.message, false).catch(() => {});
  }
});

// POST /api/servers/:id/reboot - Reboot a server using ansible ad-hoc
app.post('/api/servers/:id/reboot', guardServerAccess, rebootLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRebootServers')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const serverId = req.params.id;
  const server = req.server;

  const historyId = db.updateHistory.create(serverId, 'reboot');
  res.json({ historyId, status: 'started' });

  try {
    // We use the reboot module wrapper (or just an ad-hoc command)
    // The reboot module waits for the server to come back up.
    broadcast({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Initiating reboot for ${server.name}...\n` });
    
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'reboot',
      '',
      (type, data) => {
        broadcast({ type: 'update_output', serverId, historyId, stream: type, data });
      }
    );

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
    
    // Refresh info right away
    if (result.success) {
      setTimeout(() => {
        systemInfo.getSystemInfo(server)
          .then(info => { try { db.serverInfo.upsert(server.id, info); } catch {} })
          .catch(() => {});
      }, 5000); // give it a little time to boot before polling again
    }
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});

// POST /api/servers/:id/docker/:container/restart - Restart a docker container
app.post('/api/servers/:id/docker/:container/restart', guardServerAccess, containerRestartLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRestartDocker')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { id: serverId, container } = req.params;
  if (!/^[a-zA-Z0-9_.-]+$/.test(container) || container.startsWith('-')) return res.status(400).json({ error: 'Invalid container name' });
  const server = req.server;

  const historyId = db.updateHistory.create(serverId, `restart_docker_${container}`);
  res.json({ historyId, status: 'started' });

  try {
    broadcast({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Restarting container ${container} on ${server.name}...\n` });

    const result = await ansibleRunner.runAdHoc(
      server.name,
      'shell',
      `$(command -v docker 2>/dev/null || command -v podman 2>/dev/null) restart ${container}`,
      (type, data) => {
        broadcast({ type: 'update_output', serverId, historyId, stream: type, data });
      },
      { become: true }
    );

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
    
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});


// POST /api/servers/:id/custom-updates/:taskId/run
app.post('/api/servers/:id/custom-updates/:taskId/run', guardServerAccess, customUpdateRunLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRunCustomUpdates')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const server = req.server;
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== server.id) return res.status(404).json({ error: 'Task not found' });
  if (!String(task.update_command || '').trim()) {
    return res.status(400).json({ error: 'No update command configured for this task' });
  }

  const historyId = db.updateHistory.create(server.id, `custom_update:${task.name}`);
  res.json({ historyId, status: 'started' });

  broadcast({ type: 'update_output', serverId: server.id, historyId, stream: 'stdout', data: `Running: ${task.name}\n` });
  try {
    let cmd = task.update_command;
    if (/^https?:\/\//.test(cmd)) {
      // Reject URLs with shell metacharacters before embedding in shell command
      if (/["'`$\\;&|<>()\r\n\t ]/.test(cmd)) {
        db.updateHistory.updateStatus(historyId, 'failed', 'Invalid characters in update URL');
        broadcast({ type: 'update_error', serverId: server.id, historyId, error: 'Invalid characters in update URL' });
        return;
      }
      cmd = `curl -fsSL -- "${cmd}" | bash`;
    }
    let fullOutput = '';
    const code = await sshManager.execStream(server, cmd, chunk => {
      fullOutput += chunk;
      broadcast({ type: 'update_output', serverId: server.id, historyId, stream: 'stdout', data: chunk });
    });
    const success = code === 0;
    db.updateHistory.updateStatus(historyId, success ? 'success' : 'failed', fullOutput);
    db.auditLog.write('custom_update.run', `server=${server.name} task=${task.name}`, req.ip, success, req.user?.username);
    broadcast({ type: 'update_complete', serverId: server.id, historyId, success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId: server.id, historyId, error: error.message });
  }
});

// Directories that must not be targeted by compose write/action
const BLOCKED_REMOTE_PREFIXES = ['/etc/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/boot/', '/proc/', '/sys/', '/dev/'];

function isBlockedRemotePath(p) {
  const normalized = p.replace(/\/+/g, '/').replace(/\/$/, '');
  // Block all system directories and root-level paths that aren't under /home, /opt, /srv, /var
  if (BLOCKED_REMOTE_PREFIXES.some(prefix => (normalized + '/').startsWith(prefix))) return true;
  return false;
}

// POST /api/servers/:id/docker/compose/write
app.post('/api/servers/:id/docker/compose/write', composeLimiter, guardServerAccess, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canManageDockerCompose')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { path, content } = req.body;
  const server = req.server;
  if (!path || !content) return res.status(400).json({ error: 'path and content required' });
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Invalid path format' });
  if (isBlockedRemotePath(path)) return res.status(400).json({ error: 'Path not allowed: system directories are protected' });

  let tempCompose;
  try {
    tempCompose = createComposeTempFile(content);
    const ops = buildComposeWriteOperations(path, tempCompose.tmpFile);

    const ensureDir = await ansibleRunner.runAdHoc(
      server.name,
      ops.ensureDir.module,
      ops.ensureDir.args,
      () => {},
      { become: true }
    );
    if (!ensureDir.success) {
      return res.status(500).json({ error: 'Failed to create compose directory', details: ensureDir.stderr || ensureDir.stdout });
    }

    const copyResult = await ansibleRunner.runAdHoc(
      server.name,
      ops.copyFile.module,
      ops.copyFile.args,
      () => {},
      { become: true }
    );

    if (copyResult.success) {
      // Only create a new compose project entry if this path isn't already tracked
      // (avoids phantom "root"/"dirname" entries shadowing the real project name)
      if (!db.composeProjects.getByServerAndPath(server.id, path)) {
        const projectName = path.split('/').pop() || 'stack';
        db.composeProjects.upsert(server.id, projectName, path);
      }
      res.json({ success: true, message: 'docker-compose.yml saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to write docker-compose.yml', details: copyResult.stderr || copyResult.stdout });
    }
  } catch (err) {
    serverError(res, err, 'write docker-compose');
  } finally {
    tempCompose?.cleanup();
  }
});

// POST /api/servers/:id/docker/compose/action
app.post('/api/servers/:id/docker/compose/action', composeLimiter, guardServerAccess, async (req, res) => {
  const { id: serverId } = req.params;
  const { path, action } = req.body;
  const perms = getPermissions(req.user);
  if (!path || !['up', 'down', 'pull'].includes(action)) return res.status(400).json({ error: 'Invalid path or action' });
  const requiredCap = action === 'pull' ? 'canPullDocker' : 'canManageDockerCompose';
  if (!can(perms, requiredCap)) return res.status(403).json({ error: 'Permission denied' });
  const server = req.server;
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Invalid path format' });
  if (isBlockedRemotePath(path)) return res.status(400).json({ error: 'Path not allowed: system directories are protected' });

  const historyId = db.updateHistory.create(serverId, `compose_${action}_${path.split('/').pop()}`);
  res.json({ historyId, status: 'started' });

  try {
    const rt = '$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)';
    let cmd = '';
    if (action === 'up') cmd = `${rt} compose up -d`;
    if (action === 'down') cmd = `${rt} compose down`;
    if (action === 'pull') cmd = `${rt} compose pull`;

    broadcast({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Running compose ${action.toUpperCase()} in ${path} on ${server.name}...\n` });

    const safePath = path.replace(/'/g, "'\\''");
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'shell',
      `cd '${safePath}' && ${cmd}`,
      (type, data) => {
        broadcast({ type: 'update_output', serverId, historyId, stream: type, data });
      },
      { become: true }
    );

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});

// ============================================================
// SSH Terminal WebSocket  (/ws/ssh)
// ============================================================

wssSsh.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (!verifyWsAuth(ws, url)) return;

  // Check terminal capability
  const wsUser = getWsUser(url);
  if (!can(getPermissions(wsUser), 'canUseTerminal')) {
    ws.close(4003, 'Permission denied');
    return;
  }

  const serverId = url.searchParams.get('serverId');
  const server   = db.servers.getById(serverId);
  if (!server) { ws.close(4004, 'Server not found'); return; }

  // Check server access
  const perms = getPermissions(wsUser);
  if (perms && !perms.full) {
    const allowed = filterServers([server], perms);
    if (allowed.length === 0) { ws.close(4003, 'Server access denied'); return; }
  }

  let privateKey;
  try { privateKey = sshManager.getPrivateKey(); }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: 'SSH key not found' }));
    ws.close();
    return;
  }

  const conn   = new SshClient();
  let stream   = null;

  conn.on('ready', () => {
    const cols = Math.min(Math.max(parseInt(url.searchParams.get('cols')) || 80, 10), 500);
    const rows = Math.min(Math.max(parseInt(url.searchParams.get('rows')) || 24,  2), 200);

    conn.shell({ term: 'xterm-256color', cols, rows }, (err, sh) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
        return;
      }
      stream = sh;
      ws.send(JSON.stringify({ type: 'ready' }));

      sh.on('data',         d => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
      sh.stderr.on('data',  d => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
      sh.on('close', () => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'closed' }));
        ws.close();
        conn.end();
      });
    });
  });

  conn.on('error', err => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
    conn.end();
  });

  ws.on('message', raw => {
    if (!stream) return;
    if (raw.length > 65536) return; // 64 KB limit per message
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input' && typeof msg.data === 'string')  stream.write(msg.data);
      if (msg.type === 'resize') {
        const rows = Math.min(Math.max(parseInt(msg.rows) || 24, 2), 200);
        const cols = Math.min(Math.max(parseInt(msg.cols) || 80, 10), 500);
        stream.setWindow(rows, cols, 0, 0);
      }
    } catch (e) {
      log.debug({ err: e }, 'SSH terminal message error');
    }
  });

  ws.on('close', () => {
    try { stream?.close(); } catch {}
    conn.end();
  });

  conn.connect({
    host:         server.ip_address,
    port:         server.ssh_port || 22,
    username:     server.ssh_user || 'root',
    privateKey,
    readyTimeout: 10000,
  });
});

// WebSocket handling
const clients = new Map(); // ws -> { user, perms }

function verifyWsAuth(ws, url) {
  if (db.users.count() === 0) { ws.close(4001, 'Setup required'); return false; }
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(url.searchParams.get('token'), secret);
    // Validate token_version if present
    if (payload.userId) {
      const user = db.users.getById(payload.userId);
      if (!user) { ws.close(4001, 'Unauthorized'); return false; }
      if (payload.tv !== undefined && payload.tv !== (user.token_version || 0)) {
        ws.close(4001, 'Token revoked'); return false;
      }
    }
    return true;
  }
  catch { ws.close(4001, 'Unauthorized'); return false; }
}

function getWsUser(url) {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(url.searchParams.get('token'), secret);
    if (payload.userId) return db.users.getById(payload.userId) || null;
    return null;
  } catch { return null; }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (!verifyWsAuth(ws, url)) return;

  const wsUser = getWsUser(url);
  const perms = getPermissions(wsUser);
  clients.set(ws, { user: wsUser, perms });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  // Trigger immediate info refresh if data is stale
  const scheduler = require('./services/scheduler');
  scheduler.onClientConnect();

  // Send initial status
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [client, meta] of clients) {
    if (client.readyState !== 1) continue; // WebSocket.OPEN

    // Filter server-specific messages for restricted users
    if (data.serverId && meta.perms && !meta.perms.full) {
      const server = db.servers.getById(data.serverId);
      if (!server) continue; // server was deleted — skip broadcast
      const allowed = filterServers([server], meta.perms);
      if (allowed.length === 0) continue;
    }

    client.send(msg);
  }
}

// SPA fallback for production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  });
}

// Start server
const proto   = isHttps ? 'https' : 'http';
const wsProto = isHttps ? 'wss'   : 'ws';
server.listen(PORT, () => {
  log.info({ url: `${proto}://localhost:${PORT}`, ws: `${wsProto}://localhost:${PORT}/ws` }, 'Shipyard running');
  if (!isHttps && process.env.NODE_ENV === 'production') {
    log.warn('Running without HTTPS. Set SSL_KEY and SSL_CERT env vars or use a reverse proxy (nginx, Caddy) to terminate TLS.');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    log.warn('JWT_SECRET env var is not set. A random secret is used on each restart, which will log out all users.');
  }

  // Prune audit log entries older than 90 days
  try { db.auditLog.pruneOlderThan(90); } catch {}

  // Auto-enable agent feature if agents are already configured (migration for existing installs)
  if (!db.settings.get('agent_enabled') && db.agentConfig.getAll().length > 0) {
    db.settings.set('agent_enabled', '1');
  }

  // Start scheduler and background polling after server is listening
  const scheduler = require('./services/scheduler');
  scheduler.init(broadcast);
  scheduler.startPolling();

  // Load plugins after all helpers are available
  pluginLoader.loadAll({ db, broadcast, sshManager, ansibleRunner, scheduler });

  // Ensure agent manifest exists (seed on first run)
  try { manifestService.ensureSeeded(); } catch (e) { log.warn({ err: e }, 'Failed to seed agent manifest'); }
});

// Graceful shutdown
function shutdown(signal) {
  log.info({ signal }, 'Shutting down...');

  // 10-second hard deadline in case something hangs
  const forceExit = setTimeout(() => {
    log.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  if (forceExit.unref) forceExit.unref();

  // Stop scheduler (pollers + cron jobs)
  try { require('./services/scheduler').shutdown(); } catch {}

  // Close all SSH connections (also stops the idle-cleanup timer)
  sshManager.closeAll();

  // Close WebSocket clients so the HTTP server can drain completely
  for (const ws of wss.clients)    { try { ws.close(1001, 'Server shutting down'); } catch {} }
  for (const ws of wssSsh.clients) { try { ws.close(1001, 'Server shutting down'); } catch {} }

  // Stop accepting new HTTP connections; exit when existing ones finish
  server.close(() => {
    try { db.db.close(); } catch {}
    clearTimeout(forceExit);
    log.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
