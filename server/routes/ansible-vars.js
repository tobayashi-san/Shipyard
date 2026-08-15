const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPermissions, can, canAccessEnvironment } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');
const cryptoUtil = require('../utils/crypto');

const MAX_KEY_LEN = 100;
const MAX_VAL_LEN = 10000;
const MAX_VARS    = 500;

function requestedEnvironment(req) {
  return String(req.body?.environment_id || req.query?.environment_id || 'default').trim() || 'default';
}

function ensureEnvironmentAccess(req, res, environmentId) {
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) {
    res.status(400).json({ error: 'Environment not found' });
    return false;
  }
  if (!canAccessEnvironment(getPermissions(req.user), environmentId)) {
    res.status(403).json({ error: 'Environment access denied' });
    return false;
  }
  return true;
}

function validateKey(key) {
  if (!key || typeof key !== 'string') return 'Key required';
  if (key.length > MAX_KEY_LEN) return 'Key too long (max 100 chars)';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return 'Key must start with a letter or underscore and contain only letters, numbers, and underscores';
  return null;
}

// GET /api/ansible-vars
router.get('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canViewVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const environmentId = requestedEnvironment(req);
  if (!ensureEnvironmentAccess(req, res, environmentId)) return;
  res.json(db.ansibleVars.getAll(environmentId));
});

// POST /api/ansible-vars
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const { key, value, description, is_secret } = req.body;
  const environmentId = requestedEnvironment(req);
  if (!ensureEnvironmentAccess(req, res, environmentId)) return;
  if (is_secret === true && !cryptoUtil.isEncryptionAvailable()) return res.status(503).json({ error: 'SHIPYARD_KEY_SECRET is required before storing secret variables' });
  const err = validateKey(key);
  if (err) return res.status(400).json({ error: err });
  if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Value required' });
  if (value.length > MAX_VAL_LEN) return res.status(400).json({ error: 'Value too long' });
  if (db.ansibleVars.getAll(environmentId).length >= MAX_VARS) return res.status(400).json({ error: 'Variable limit reached' });
  try {
    res.status(201).json(db.ansibleVars.create(key.trim(), value, description || '', { environmentId, isSecret: is_secret === true }));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Variable key already exists' });
    serverError(res, e, 'create ansible var');
  }
});

// PUT /api/ansible-vars/:id
router.put('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canEditVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const { key, value, description, is_secret } = req.body;
  const existing = db.ansibleVars.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Variable not found' });
  if (!ensureEnvironmentAccess(req, res, existing.environment_id || 'default')) return;
  if (is_secret === true && !cryptoUtil.isEncryptionAvailable()) return res.status(503).json({ error: 'SHIPYARD_KEY_SECRET is required before storing secret variables' });
  const err = validateKey(key);
  if (err) return res.status(400).json({ error: err });
  const keepValue = is_secret === true && (value === undefined || value === '');
  if (!keepValue && (!value || typeof value !== 'string')) return res.status(400).json({ error: 'Value required' });
  if (!keepValue && value.length > MAX_VAL_LEN) return res.status(400).json({ error: 'Value too long' });
  try {
    const updated = db.ansibleVars.update(req.params.id, key.trim(), value || '', description || '', { keepValue, isSecret: is_secret === true });
    res.json(updated);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Variable key already exists' });
    serverError(res, e, 'update ansible var');
  }
});

// DELETE /api/ansible-vars/:id
router.delete('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canDeleteVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const existing = db.ansibleVars.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Variable not found' });
  if (!ensureEnvironmentAccess(req, res, existing.environment_id || 'default')) return;
  db.ansibleVars.delete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
