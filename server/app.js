const express = require('express');
const cors = require('cors');
const path = require('path');
const log = require('./utils/logger');
const db = require('./db');
const pluginLoader = require('./services/plugin-loader');
const authMiddleware = require('./middleware/auth');
const { createCorsOriginValidator, parseAllowedOrigins } = require('./utils/allowed-origins');
const { apiLimiter, authenticatedApiLimiter, fileReadLimiter } = require('./utils/rate-limiters');
const { serverError } = require('./utils/http-error');
const { getPermissions, canAccessPlugin } = require('./utils/permissions');

const { router: authRouter } = require('./routes/auth');
const agentRouter = require('./routes/agent');
const usersRouter = require('./routes/users');
const rolesRouter = require('./routes/roles');
const resetRouter = require('./routes/reset');
const dashboardRouter = require('./routes/dashboard');
const createAnsibleRouter = require('./routes/ansible');
const serversRouter = require('./routes/servers');
const createServerActionsRouter = require('./routes/server-actions');
const customUpdatesRouter = require('./routes/custom-updates');
const systemRouter = require('./routes/system');
const playbooksRouter = require('./routes/playbooks');
const schedulesRouter = require('./routes/schedules');
const scheduleHistoryRouter = require('./routes/schedule-history');
const ansibleVarsRouter = require('./routes/ansible-vars');
const adhocRouter = require('./routes/adhoc');
const gitPlaybooksRouter = require('./routes/git-playbooks');
const pluginsAdminRouter = require('./routes/plugins-admin');
const agentAdminRouter = require('./routes/agent-admin');
const alertsRouter = require('./routes/alerts');
const resourceAlerts = require('./services/resource-alerts');

const PLUGIN_UI_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function pluginUiContentType(ext) {
  return PLUGIN_UI_CONTENT_TYPES[ext] || 'application/octet-stream';
}

function createApp({ isHttps = false } = {}) {
  const app = express();
  let broadcast = () => {};
  const emit = (payload) => broadcast(payload);

  // TRUST_PROXY: accepts '1' (single hop), numeric hop count ('2', '3', …),
  // 'true'/'false', or an Express-compatible value like a CIDR/IP list
  // (e.g. '10.0.0.0/8,192.168.0.0/16'). Backward-compatible with prior '1'-only behaviour.
  const tp = process.env.TRUST_PROXY;
  if (tp !== undefined && tp !== '' && tp !== '0' && tp.toLowerCase() !== 'false') {
    const asNum = Number.parseInt(tp, 10);
    if (Number.isFinite(asNum) && String(asNum) === tp.trim()) {
      app.set('trust proxy', asNum);
    } else if (tp.toLowerCase() === 'true') {
      app.set('trust proxy', true);
    } else {
      // IP/CIDR list – Express accepts comma-separated string or array.
      app.set('trust proxy', tp.split(',').map(s => s.trim()).filter(Boolean));
    }
  }

  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  app.use(cors({ origin: createCorsOriginValidator(allowedOrigins) }));
  app.use(express.json({ limit: '2mb' }));

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
        isProduction ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "font-src 'self' data: https://cdnjs.cloudflare.com",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    next();
  });

  const nextDist = path.join(__dirname, '..', 'frontend-next', 'dist');
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(nextDist));
  }

  app.use('/api', apiLimiter);

  app.get('/api/health', (req, res) => {
    try {
      db.db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
    } catch (e) {
      log.error({ err: e }, 'Health check failed');
      res.status(500).json({ status: 'error', error: 'Database unavailable' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/v1/agent', agentRouter);

  app.use('/api/users', authMiddleware, authenticatedApiLimiter, usersRouter);
  app.use('/api/roles', authMiddleware, authenticatedApiLimiter, rolesRouter);

  app.use('/api', authMiddleware);
  app.use('/api', authenticatedApiLimiter);

  app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/api/reset', resetRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/ansible', createAnsibleRouter({ broadcast: emit }));
  app.use('/api/servers/:id/custom-updates', customUpdatesRouter);
  app.use('/api/servers', createServerActionsRouter({ broadcast: emit }));
  app.use('/api/servers', serversRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/playbooks', playbooksRouter);
  app.use('/api/schedules', schedulesRouter);
  app.use('/api/schedule-history', scheduleHistoryRouter);
  app.use('/api/ansible-vars', ansibleVarsRouter);
  app.use('/api/adhoc', adhocRouter);
  app.use('/api/playbooks-git', gitPlaybooksRouter);
  app.use('/api/plugins', pluginsAdminRouter);
  app.use('/api/v1', agentAdminRouter);

  app.use('/api/plugin/:pluginId', (req, res, next) => {
    const { pluginId } = req.params;
    const pluginRouter = pluginLoader.getRouter(pluginId);
    if (!pluginRouter) return res.status(404).json({ error: `Plugin '${pluginId}' not found or not enabled` });
    if (!canAccessPlugin(getPermissions(req.user), pluginId)) {
      return res.status(403).json({ error: 'Plugin access denied' });
    }
    pluginRouter(req, res, next);
  });

  app.get('/plugins/:pluginId/ui.js', fileReadLimiter, (req, res) => {
    const { pluginId } = req.params;
    if (!pluginLoader.isEnabled(pluginId)) {
      return res.status(404).type('application/javascript').send('// Plugin not found or not enabled\n');
    }
    const uiRoot = pluginLoader.getUiRoot(pluginId);
    if (!uiRoot) {
      return res.status(404).type('application/javascript').send('// ui.js not found\n');
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('ui.js', { root: uiRoot });
  });

  app.get(/^\/plugins\/([a-z0-9][a-z0-9_-]*)\/(.+)$/, fileReadLimiter, (req, res) => {
    const pluginId = req.params[0];
    const assetPath = req.params[1];
    if (!pluginLoader.isEnabled(pluginId)) {
      return res.status(404).type('application/javascript').send('// Plugin not found or not enabled\n');
    }

    const asset = pluginLoader.getUiAsset(pluginId, assetPath);
    if (!asset) {
      return res.status(404).type('application/javascript').send('// Plugin asset not found\n');
    }

    res.setHeader('Content-Type', pluginUiContentType(asset.ext));
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(asset.file, { root: asset.root });
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(fileReadLimiter, (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(path.join(nextDist, 'index.html'));
    });
  }

  app.use((err, req, res, next) => {
    if (!err) return next();
    return serverError(res, err, `${req.method} ${req.path}`);
  });

  return {
    app,
    allowedOrigins,
    setBroadcast: (nextBroadcast) => {
      broadcast = typeof nextBroadcast === 'function' ? nextBroadcast : broadcast;
      resourceAlerts.setBroadcast(broadcast);
    },
  };
}

module.exports = { createApp };
