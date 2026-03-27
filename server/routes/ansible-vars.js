const express = require('express');
const router = express.Router();
const db = require('../db');
const { getPermissions, can } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

const MAX_KEY_LEN = 100;
const MAX_VAL_LEN = 10000;
const MAX_VARS    = 500;

function validateKey(key) {
  if (!key || typeof key !== 'string') return 'Key required';
  if (key.length > MAX_KEY_LEN) return 'Key too long (max 100 chars)';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return 'Key must start with a letter or underscore and contain only letters, numbers, and underscores';
  return null;
}

// GET /api/ansible-vars
router.get('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canViewVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  res.json(db.ansibleVars.getAll());
});

// POST /api/ansible-vars
router.post('/', (req, res, next) => { if (!can(getPermissions(req.user), 'canAddVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const { key, value, description } = req.body;
  const err = validateKey(key);
  if (err) return res.status(400).json({ error: err });
  if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Value required' });
  if (value.length > MAX_VAL_LEN) return res.status(400).json({ error: 'Value too long' });
  if (db.ansibleVars.getAll().length >= MAX_VARS) return res.status(400).json({ error: 'Variable limit reached' });
  try {
    res.status(201).json(db.ansibleVars.create(key.trim(), value, description || ''));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Variable key already exists' });
    serverError(res, e, 'create ansible var');
  }
});

// PUT /api/ansible-vars/:id
router.put('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canEditVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  const { key, value, description } = req.body;
  const err = validateKey(key);
  if (err) return res.status(400).json({ error: err });
  if (!value || typeof value !== 'string') return res.status(400).json({ error: 'Value required' });
  if (value.length > MAX_VAL_LEN) return res.status(400).json({ error: 'Value too long' });
  try {
    const updated = db.ansibleVars.update(req.params.id, key.trim(), value, description || '');
    if (!updated) return res.status(404).json({ error: 'Variable not found' });
    res.json(updated);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Variable key already exists' });
    serverError(res, e, 'update ansible var');
  }
});

// DELETE /api/ansible-vars/:id
router.delete('/:id', (req, res, next) => { if (!can(getPermissions(req.user), 'canDeleteVars')) return res.status(403).json({ error: 'Permission denied' }); next(); }, (req, res) => {
  db.ansibleVars.delete(req.params.id);
  res.json({ success: true });
});

module.exports = router;
