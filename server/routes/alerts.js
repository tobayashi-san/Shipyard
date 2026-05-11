const express = require('express');
const db = require('../db');
const { getPermissions, filterServers, can, guardServerAccess } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');
const resourceAlerts = require('../services/resource-alerts');

const router = express.Router();

function visibleServerIds(req) {
  const perms = getPermissions(req.user);
  return filterServers(db.servers.getAll(), perms).map(server => server.id);
}

function normalizeStatuses(value) {
  const raw = String(value || 'open').toLowerCase();
  if (raw === 'all') return ['all'];
  if (raw === 'active') return ['active'];
  if (raw === 'acknowledged') return ['acknowledged'];
  if (raw === 'resolved') return ['resolved'];
  return ['active', 'acknowledged'];
}

function validateThresholds(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const err = new Error('thresholds must be an object');
    err.statusCode = 400;
    throw err;
  }
  const out = {};
  for (const key of ['cpu', 'ram', 'disk', 'storage']) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < 0 || number > 100) {
      const err = new Error(`${key} threshold must be between 0 and 100`);
      err.statusCode = 400;
      throw err;
    }
    out[key] = Math.round(number);
  }
  return out;
}

function guardAlertAccess(req, res, next) {
  const alert = db.resourceAlerts.getById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  const visible = new Set(visibleServerIds(req));
  if (!visible.has(alert.server_id)) return res.status(403).json({ error: 'Server access denied' });
  req.alert = alert;
  next();
}

router.get('/', (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    res.json(db.resourceAlerts.list({
      statuses: normalizeStatuses(req.query.status),
      serverIds: visibleServerIds(req),
      limit: req.query.limit,
    }));
  } catch (error) {
    serverError(res, error, 'list resource alerts');
  }
});

router.post('/:id/ack', guardAlertAccess, (req, res) => {
  try {
    const alert = db.resourceAlerts.acknowledge(req.params.id, req.user?.username);
    resourceAlerts.emitAlertUpdated(alert);
    res.json(alert);
  } catch (error) {
    serverError(res, error, 'acknowledge resource alert');
  }
});

router.post('/:id/unack', guardAlertAccess, (req, res) => {
  try {
    const alert = db.resourceAlerts.unacknowledge(req.params.id);
    resourceAlerts.emitAlertUpdated(alert);
    res.json(alert);
  } catch (error) {
    serverError(res, error, 'unacknowledge resource alert');
  }
});

router.get('/servers/:id/settings', guardServerAccess, (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    res.json(db.alertSettings.getByServer(req.params.id));
  } catch (error) {
    serverError(res, error, 'get alert settings');
  }
});

router.put('/servers/:id/settings', guardServerAccess, (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canEditServers')) return res.status(403).json({ error: 'Permission denied' });
    const body = req.body || {};
    const patch = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
      patch.enabled = body.enabled;
    }
    if (body.notify_enabled !== undefined) {
      if (typeof body.notify_enabled !== 'boolean') return res.status(400).json({ error: 'notify_enabled must be a boolean' });
      patch.notify_enabled = body.notify_enabled;
    }
    if (body.trigger_after_seconds !== undefined) {
      const seconds = Number(body.trigger_after_seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
        return res.status(400).json({ error: 'trigger_after_seconds must be between 0 and 86400' });
      }
      patch.trigger_after_seconds = Math.round(seconds);
    }
    const thresholds = validateThresholds(body.thresholds);
    if (thresholds !== undefined) patch.thresholds = thresholds;

    const settings = db.alertSettings.upsert(req.params.id, patch);
    resourceAlerts.evaluateServer(req.params.id);
    res.json(settings);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'save alert settings');
  }
});

module.exports = router;
