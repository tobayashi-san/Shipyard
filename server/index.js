const express = require('express');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const path = require('path');

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
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
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
const { router: authRouter, getJwtSecret } = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
app.use('/api/auth', authRouter);

// Protect all other /api routes
app.use('/api', authMiddleware);

// API Routes
const resetRouter = require('./routes/reset');
const serversRouter = require('./routes/servers');
const systemRouter = require('./routes/system');
const playbooksRouter = require('./routes/playbooks');
const schedulesRouter = require('./routes/schedules');
app.use('/api/reset', resetRouter);
app.use('/api/servers', serversRouter);
app.use('/api/system', systemRouter);
app.use('/api/playbooks', playbooksRouter);
app.use('/api/schedules', schedulesRouter);

// GET /api/dashboard – aggregated stats from DB cache (no SSH, instant)
app.get('/api/dashboard', (req, res) => {
  try {
    const servers = db.servers.getAll();
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
        info_cached_at: info?.updated_at || null,
      };
    });

    const recentHistory = db.db.prepare(`
      SELECT h.*, s.name as server_name
      FROM update_history h
      LEFT JOIN servers s ON h.server_id = s.id
      ORDER BY h.started_at DESC LIMIT 8
    `).all();

    res.json({
      summary: { total: servers.length, online, offline, unknown: servers.length - online - offline, rebootRequired, totalUpdates, criticalDisk, criticalRam },
      servers: serverStats,
      recentHistory,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ansible execution via REST + WebSocket
const ansibleRunner = require('./services/ansible-runner');
const db = require('./db');

// POST /api/ansible/run - Run a playbook with WebSocket output
app.post('/api/ansible/run', async (req, res) => {
  const { playbook, targets, extraVars } = req.body;
  if (!playbook) return res.status(400).json({ error: 'playbook is required' });
  if (extraVars && (typeof extraVars !== 'object' || Array.isArray(extraVars) ||
      Object.values(extraVars).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
    return res.status(400).json({ error: 'extraVars must be a flat object with string/number/boolean values' });
  }

  const historyId = db.updateHistory.create(
    targets || 'all',
    `ansible:${playbook}`
  );

  res.json({ historyId, status: 'started' });

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

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'ansible_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'ansible_error', historyId, error: error.message });
  }
});

// POST /api/servers/:id/update - Run system update on a server
app.post('/api/servers/:id/update', async (req, res) => {
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

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'update_complete', serverId, historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});

// POST /api/servers/update-all - Run system update on all servers
app.post('/api/servers/update-all', async (req, res) => {
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

    db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
    broadcast({ type: 'bulk_update_complete', historyId, success: result.success });
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'bulk_update_error', historyId, error: error.message });
  }
});

// POST /api/servers/:id/reboot - Reboot a server using ansible ad-hoc
app.post('/api/servers/:id/reboot', async (req, res) => {
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
        require('./services/system-info').getSystemInfo(server)
          .then(info => db.serverInfo.upsert(server.id, info)).catch(() => {});
      }, 5000); // give it a little time to boot before polling again
    }
  } catch (error) {
    db.updateHistory.updateStatus(historyId, 'failed', error.message);
    broadcast({ type: 'update_error', serverId, historyId, error: error.message });
  }
});

// POST /api/servers/:id/docker/:container/restart - Restart a docker container
app.post('/api/servers/:id/docker/:container/restart', async (req, res) => {
  const { id: serverId, container } = req.params;
  if (!/^[a-zA-Z0-9_.-]+$/.test(container)) return res.status(400).json({ error: 'Invalid container name' });
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const historyId = db.updateHistory.create(serverId, `restart_docker_${container}`);
  res.json({ historyId, status: 'started' });

  try {
    broadcast({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Restarting docker container ${container} on ${server.name}...\n` });
    
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'command',
      `docker restart ${container}`,
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


// POST /api/servers/:id/docker/compose/write
app.post('/api/servers/:id/docker/compose/write', async (req, res) => {
  const { id: serverId } = req.params;
  const { path, content } = req.body;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!path || !content) return res.status(400).json({ error: 'path and content required' });
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Invalid path format' });

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
      // Save it to our DB so we can track it even if it's down!
      const projectName = path.split('/').pop() || 'stack';
      db.composeProjects.upsert(server.id, projectName, path);
      res.json({ success: true, message: 'docker-compose.yml saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to write docker-compose.yml', details: result.stderr || result.stdout });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:id/docker/compose/action
app.post('/api/servers/:id/docker/compose/action', async (req, res) => {
  const { id: serverId } = req.params;
  const { path, action } = req.body;
  const server = db.servers.getById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!path || !['up', 'down', 'pull'].includes(action)) return res.status(400).json({ error: 'Invalid path or action' });
  if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Invalid path format' });

  const historyId = db.updateHistory.create(serverId, `compose_${action}_${path.split('/').pop()}`);
  res.json({ historyId, status: 'started' });

  try {
    let cmd = '';
    if (action === 'up') cmd = 'docker compose up -d';
    if (action === 'down') cmd = 'docker compose down';
    if (action === 'pull') cmd = 'docker compose pull';

    broadcast({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Running '${cmd}' in ${path} on ${server.name}...\n` });

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
const { Client: SshClient } = require('ssh2');
const sshManager = require('./services/ssh-manager');

wssSsh.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // Auth
  const passwordHash = db.settings.get('auth_password_hash');
  if (passwordHash) {
    const secret = process.env.JWT_SECRET || db.settings.get('auth_jwt_secret');
    const token  = url.searchParams.get('token');
    try { require('jsonwebtoken').verify(token, secret); }
    catch { ws.close(4001, 'Unauthorized'); return; }
  }

  const serverId = url.searchParams.get('serverId');
  const server   = db.servers.getById(serverId);
  if (!server) { ws.close(4004, 'Server not found'); return; }

  let privateKey;
  try { privateKey = fs.readFileSync(sshManager.getPrivateKeyPath()); }
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
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input')  stream.write(msg.data);
      if (msg.type === 'resize') stream.setWindow(msg.rows, msg.cols, 0, 0);
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
const jwt = require('jsonwebtoken');

wss.on('connection', (ws, req) => {
  // Validate token if a password is configured
  const passwordHash = db.settings.get('auth_password_hash');
  if (passwordHash) {
    const secret = process.env.JWT_SECRET || db.settings.get('auth_jwt_secret');
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    try {
      jwt.verify(token, secret);
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }
  }

  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

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

  // Start scheduler and background polling after server is listening
  const scheduler = require('./services/scheduler');
  scheduler.init(broadcast);
  scheduler.startPolling();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  const scheduler = require('./services/scheduler');
  scheduler.stopPolling();
  const sshManager = require('./services/ssh-manager');
  sshManager.closeAll();
  server.close();
  process.exit(0);
});
