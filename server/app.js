const express = require('express');
const cors = require('cors');
const path = require('path');
const log = require('./utils/logger');
const db = require('./db');
const pluginLoader = require('./services/plugin-loader');
const authMiddleware = require('./middleware/auth');
const { parseAllowedOrigins } = require('./utils/allowed-origins');

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

function createApp({ isHttps = false } = {}) {
  const app = express();
  let broadcast = () => {};
  const emit = (payload) => broadcast(payload);

  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }

  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  app.use(cors({ origin: allowedOrigins }));
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
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    next();
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));
  }

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

  app.use('/api/users', authMiddleware, usersRouter);
  app.use('/api/roles', authMiddleware, rolesRouter);

  app.use('/api', authMiddleware);

  app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/api/reset', resetRouter);
  app.use('/api/dashboard', dashboardRouter);
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
    pluginRouter(req, res, next);
  });

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

  if (process.env.NODE_ENV === 'production') {
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
    });
  }

  return {
    app,
    allowedOrigins,
    setBroadcast: (nextBroadcast) => {
      broadcast = typeof nextBroadcast === 'function' ? nextBroadcast : broadcast;
    },
  };
}

module.exports = { createApp };
