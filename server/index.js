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
const db = require('./db');
const ansibleRunner = require('./services/ansible-runner');
const sshManager = require('./services/ssh-manager');
const systemInfo = require('./services/system-info');
const { notify } = require('./services/notifier');

const app = express();

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
    console.error(`[HTTPS] Failed to read certificate files: ${e.message}`);
    console.error(`        SSL_KEY=${SSL_KEY}`);
    console.error(`        SSL_CERT=${SSL_CERT}`);
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
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:5173'],
}));
app.use(express.json());

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
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
      "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com",
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
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// Auth – mount BEFORE the auth middleware so login/setup routes are always reachable
const { router: authRouter } = require('./routes/auth');
const { getJwtSecret } = require('./utils/jwt-secret');
const authMiddleware = require('./middleware/auth');
app.use('/api/auth', authRouter);

// Users management (admin-only, enforced inside the router)
const usersRouter = require('./routes/users');
const rolesRouter = require('./routes/roles');
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/roles', authMiddleware, rolesRouter);

// Protect all other /api routes
app.use('/api', authMiddleware);

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
const gitSync            = require('./services/git-sync');
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

const { getPermissions, filterServers, filterPlugins, can } = require('./utils/permissions');

// GET /api/dashboard – aggregated stats from DB cache (no SSH, instant)
app.get('/api/dashboard', (req, res) => {
  try {
    const perms = getPermissions(req.user);
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

      if (info?.reboot_required) rebootRequired++;
      totalUpdates += updates.filter(u => !u.phased).length;

      const ramPct = info?.ram_total_mb ? Math.round((info.ram_used_mb / info.ram_total_mb) * 100) : null;
      const diskPct = info?.disk_total_gb ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : null;
      if (ramPct > 85) criticalRam++;
      if (diskPct > 85) criticalDisk++;

      return {
        id: s.id,
        name: s.name,
        ip_address: s.ip_address,
        status: s.status,
        last_seen: s.last_seen,
        os: info?.os || null,
        uptime_seconds: info?.uptime_seconds || null,
        ram_pct: ramPct,
        disk_pct: diskPct,
        cpu_pct: info?.cpu_usage_pct ?? null,
        load_avg: info?.load_avg || null,
        reboot_required: !!info?.reboot_required,
        updates_count: updates.filter(u => !u.phased).length,
        containers_running: containers.filter(c => c.state === 'running').length,
        containers_total: containers.length,
        image_updates_count: imageUpdates === null ? null : imageUpdates.filter(r => r.status === 'update_available').length,
        image_updates_checked_at: imageUpdatesMeta?.updated_at || null,
        custom_updates_count: db.customUpdateTasks.countHasUpdate(s.id),
        info_cached_at: info?.updated_at || null,
      };
    });

    // Fetch more rows than needed so we can filter by accessible servers
    const allRecentHistory = db.db.prepare(`
      SELECT h.*, s.name as server_name
      FROM update_history h
      LEFT JOIN servers s ON h.server_id = s.id
      ORDER BY h.started_at DESC LIMIT 200
    `).all();

    // Restrict to entries belonging to servers the user can access.
    // For non-server entries (bulk_update, ansible runs with targets like 'all'),
    // only show them to users with full access.
    const allowedServerIds = new Set(servers.map(s => s.id));
    const recentHistory = (perms && !perms.full)
      ? allRecentHistory.filter(h => allowedServerIds.has(h.server_id)).slice(0, 8)
      : allRecentHistory.slice(0, 8);

    res.json({
      summary: { total: servers.length, online, offline, unknown: servers.length - online - offline, rebootRequired, totalUpdates, criticalDisk, criticalRam },
      servers: serverStats,
      recentHistory,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// Ansible execution via REST + WebSocket

// POST /api/ansible/run - Run a playbook with WebSocket output
app.post('/api/ansible/run', async (req, res) => {
  const { playbook, targets, extraVars } = req.body;
  if (!playbook) return res.status(400).json({ error: 'playbook is required' });
  if (extraVars && (typeof extraVars !== 'object' || Array.isArray(extraVars) ||
      Object.values(extraVars).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
    return res.status(400).json({ error: 'extraVars must be a flat object with string/number/boolean values' });
  }
  if (extraVars && JSON.stringify(extraVars).length > 4096) {
    return res.status(400).json({ error: 'extraVars too large (max 4KB)' });
  }

  const historyId = db.updateHistory.create(
    targets || 'all',
    `ansible:${playbook}`
  );
  const schedHistId = db.scheduleHistory.create(null, 'Quick Run', playbook, targets || 'all');

  res.json({ historyId, status: 'started' });

  // Sync playbooks from git before running
  await gitSync.autoPull();

  // Run playbook and stream output via WebSocket
  try {
    const result = await ansibleRunner.runPlaybook(
      playbook,
      targets || 'all',
      extraVars || {},
      (type, data) => {
        broadcast({ type: 'ansible_output', historyId, stream: type, data });
      }
    );

    const status = result.success ? 'success' : 'failed';
    const output = result.stdout + result.stderr;
    db.updateHistory.updateStatus(historyId, status, output);
    db.scheduleHistory.complete(schedHistId, status, output);
    db.auditLog.write('ansible.run', `playbook=${playbook} targets=${targets || 'all'} status=${status}`, req.ip, result.success);
    broadcast({ type: 'ansible_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.scheduleHistory.complete(schedHistId, 'failed', error.message);
    db.auditLog.write('ansible.run', `playbook=${playbook} targets=${targets || 'all'} error=${error.message}`, req.ip, false);
    broadcast({ type: 'ansible_error', historyId, error: error.message });
    notify(`Playbook failed: ${playbook}`, error.message, false).catch(() => {});
  }
});

// POST /api/servers/:id/update - Run system update on a server
app.post('/api/servers/:id/update', (req, res, next) => {
  if (!can(getPermissions(req.user), 'canUpdateServers')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const serverId = req.params.id;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

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
    db.auditLog.write('server.update', `server=${server.name} status=${status}`, req.ip, result.success);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.auditLog.write('server.update', `server=${server.name} error=${error.message}`, req.ip, false);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
    notify(`Update failed: ${server.name}`, error.message, false).catch(() => {});
  }
});

// POST /api/servers/update-all - Run system update on all servers
app.post('/api/servers/update-all', (req, res, next) => {
  if (!can(getPermissions(req.user), 'canUpdateServers')) return res.status(403).json({ error: 'Permission denied' });
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
    db.auditLog.write('server.update_all', `status=${status}`, req.ip, result.success);
    broadcast({ type: 'bulk_update_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    db.auditLog.write('server.update_all', `error=${error.message}`, req.ip, false);
    broadcast({ type: 'bulk_update_error', historyId, error: error.message });
    notify('Bulk update failed', error.message, false).catch(() => {});
  }
});

// POST /api/servers/:id/reboot - Reboot a server using ansible ad-hoc
app.post('/api/servers/:id/reboot', rebootLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canUpdateServers')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const serverId = req.params.id;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

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
          .then(info => db.serverInfo.upsert(server.id, info)).catch(() => {});
      }, 5000); // give it a little time to boot before polling again
    }
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});

// POST /api/servers/:id/docker/:container/restart - Restart a docker container
app.post('/api/servers/:id/docker/:container/restart', containerRestartLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canManageDocker')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { id: serverId, container } = req.params;
  if (!/^[a-zA-Z0-9_.-]+$/.test(container)) return res.status(400).json({ error: 'Invalid container name' });
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

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
      }
    );

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
    
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});


// POST /api/servers/:id/custom-updates/:taskId/run
app.post('/api/servers/:id/custom-updates/:taskId/run', customUpdateRunLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canManageCustomUpdates')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== server.id) return res.status(404).json({ error: 'Task not found' });

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
    db.auditLog.write('custom_update.run', `server=${server.name} task=${task.name}`, req.ip, success);
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
  return BLOCKED_REMOTE_PREFIXES.some(prefix => (normalized + '/').startsWith(prefix));
}

// POST /api/servers/:id/docker/compose/write
app.post('/api/servers/:id/docker/compose/write', (req, res, next) => {
  if (!can(getPermissions(req.user), 'canManageDocker')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { id: serverId } = req.params;
  const { path, content } = req.body;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!path || !content) return res.status(400).json({ error: 'path and content required' });
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Invalid path format' });
  if (isBlockedRemotePath(path)) return res.status(400).json({ error: 'Path not allowed: system directories are protected' });

  try {
    // We use a base64 encoded string to safely transfer the multiline compose file via CLI
    const b64 = Buffer.from(content).toString('base64');
    
    // Create directory if it doesn't exist, then write the decoded file
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'shell',
      `mkdir -p "${path}" && echo "${b64}" | base64 -d > "${path}/docker-compose.yml"`,
      () => {}
    );

    if (result.success) {
      // Only create a new compose project entry if this path isn't already tracked
      // (avoids phantom "root"/"dirname" entries shadowing the real project name)
      if (!db.composeProjects.getByServerAndPath(server.id, path)) {
        const projectName = path.split('/').pop() || 'stack';
        db.composeProjects.upsert(server.id, projectName, path);
      }
      res.json({ success: true, message: 'docker-compose.yml saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to write docker-compose.yml', details: result.stderr || result.stdout });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/docker/compose/action
app.post('/api/servers/:id/docker/compose/action', (req, res, next) => {
  if (!can(getPermissions(req.user), 'canManageDocker')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { id: serverId } = req.params;
  const { path, action } = req.body;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!path || !['up', 'down', 'pull'].includes(action)) return res.status(400).json({ error: 'Invalid path or action' });
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

    const result = await ansibleRunner.runAdHoc(
      server.name,
      'shell',
      `cd "${path}" && ${cmd}`,
      (type, data) => {
        broadcast({ type: 'update_output', serverId, historyId, stream: type, data });
      }
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
    } catch {}
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
const clients = new Set();

function verifyWsAuth(ws, url) {
  const passwordHash = db.settings.get('auth_password_hash');
  if (!passwordHash) return true;
  const secret = getJwtSecret();
  try { jwt.verify(url.searchParams.get('token'), secret); return true; }
  catch { ws.close(4001, 'Unauthorized'); return false; }
}

function getWsUser(url) {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(url.searchParams.get('token'), secret);
    if (payload.userId) return db.users.getById(payload.userId) || null;
    if (payload.ok === true) {
      const admins = db.users.getAll().filter(u => u.role === 'admin');
      return admins[0] || { role: 'admin' };
    }
    return null;
  } catch { return null; }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (!verifyWsAuth(ws, url)) return;

  clients.add(ws);
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
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
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
  console.log(`\n  ⚓  Shipyard running on ${proto}://localhost:${PORT}`);
  console.log(`  📡 WebSocket on ${wsProto}://localhost:${PORT}/ws`);
  if (!isHttps && process.env.NODE_ENV === 'production') {
    console.warn('\n  ⚠️  SECURITY: Running without HTTPS. Set SSL_KEY and SSL_CERT env vars');
    console.warn('     or use a reverse proxy (nginx, Caddy) to terminate TLS.\n');
  } else {
    console.log('');
  }

  // Prune audit log entries older than 90 days
  try { db.auditLog.pruneOlderThan(90); } catch {}

  // Start scheduler and background polling after server is listening
  const scheduler = require('./services/scheduler');
  scheduler.init(broadcast);
  scheduler.startPolling();

  // Load plugins after all helpers are available
  pluginLoader.loadAll({ db, broadcast, sshManager, ansibleRunner, scheduler });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  require('./services/scheduler').stopPolling();
  sshManager.closeAll();
  server.close();
  process.exit(0);
});
