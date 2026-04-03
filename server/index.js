const http = require('http');
const https = require('https');
const fs = require('fs');
const log = require('./utils/logger');
const db = require('./db');
const sshManager = require('./services/ssh-manager');
const pluginLoader = require('./services/plugin-loader');
const scheduler = require('./services/scheduler');
const ansibleRunner = require('./services/ansible-runner');
const manifestService = require('./services/agent-manifest');
const { createApp } = require('./app');
const { createWebSocketHub } = require('./ws');

const SSL_KEY = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;

let server;
let isHttps = false;

if (SSL_KEY && SSL_CERT) {
  let key;
  let cert;
  try {
    key = fs.readFileSync(SSL_KEY);
    cert = fs.readFileSync(SSL_CERT);
  } catch (e) {
    log.fatal({ err: e, SSL_KEY, SSL_CERT }, 'Failed to read certificate files');
    process.exit(1);
  }
  isHttps = true;
  const { app, allowedOrigins, setBroadcast } = createApp({ isHttps });
  server = https.createServer({ key, cert }, app);
  start({ server, allowedOrigins, isHttps, setBroadcast });
} else {
  const { app, allowedOrigins, setBroadcast } = createApp({ isHttps });
  server = http.createServer(app);
  start({ server, allowedOrigins, isHttps, setBroadcast });
}

function start({ server, allowedOrigins, isHttps, setBroadcast }) {
  const PORT = process.env.PORT || (isHttps ? 443 : 3001);
  const { wss, wssSsh, broadcast } = createWebSocketHub({ server, allowedOrigins });
  setBroadcast(broadcast);

  const proto = isHttps ? 'https' : 'http';
  const wsProto = isHttps ? 'wss' : 'ws';

  server.listen(PORT, () => {
    log.info({ url: `${proto}://localhost:${PORT}`, ws: `${wsProto}://localhost:${PORT}/ws` }, 'Shipyard running');
    if (!isHttps && process.env.NODE_ENV === 'production') {
      log.warn('Running without HTTPS. Set SSL_KEY and SSL_CERT env vars or use a reverse proxy (nginx, Caddy) to terminate TLS.');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      log.warn('JWT_SECRET env var is not set. A random secret is used on each restart, which will log out all users.');
    }

    try { db.auditLog.pruneOlderThan(90); } catch {}

    if (!db.settings.get('agent_enabled') && db.agentConfig.getAll().length > 0) {
      db.settings.set('agent_enabled', '1');
    }

    scheduler.init(broadcast);
    scheduler.startPolling();
    pluginLoader.loadAll({ db, broadcast, sshManager, ansibleRunner, scheduler });

    try { manifestService.ensureSeeded(); } catch (e) { log.warn({ err: e }, 'Failed to seed agent manifest'); }
  });

  function shutdown(signal) {
    log.info({ signal }, 'Shutting down...');

    const forceExit = setTimeout(() => {
      log.warn('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    if (forceExit.unref) forceExit.unref();

    try { scheduler.shutdown(); } catch {}
    sshManager.closeAll();

    for (const ws of wss.clients) { try { ws.close(1001, 'Server shutting down'); } catch {} }
    for (const ws of wssSsh.clients) { try { ws.close(1001, 'Server shutting down'); } catch {} }

    server.close(() => {
      try { db.db.close(); } catch {}
      clearTimeout(forceExit);
      log.info('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
