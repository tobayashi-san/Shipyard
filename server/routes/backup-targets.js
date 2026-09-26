'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { adminOnly } = require('../middleware/auth');
const targets = require('../services/backup-targets');
const { confirmCurrentUser } = require('../utils/reauth');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skip: () => process.env.NODE_ENV === 'test', standardHeaders: true, legacyHeaders: false, message: { error: 'Too many backup requests. Try again in 15 minutes.' } });
router.use(adminOnly, limiter);

// A changed destination, credential or passphrase decides where the database goes.
function changesDestination(input, existing) {
  if (!existing) return true;
  const settings = targets.publicTarget(existing).settings;
  return Boolean(input.passphrase)
    || Object.values(input.secrets || {}).some(value => typeof value === 'string' && value.trim())
    || String(input.remote_path || '').replace(/^\/+|\/+$/g, '') !== existing.remote_path
    || Object.entries(input.settings || {}).some(([key, value]) => key in settings && String(value || '').trim() !== String(settings[key] || ''));
}

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ targets: db.backupTargets.getAll().map(targets.publicTarget), types: Object.fromEntries(Object.entries(targets.TYPES).map(([key, spec]) => [key, spec.label])), s3_providers: targets.S3_PROVIDERS });
});

router.post('/', async (req, res) => {
  const { error: authError } = await confirmCurrentUser(req.user.username, req.body || {});
  if (authError) return res.status(authError.status).json(authError.body);
  const { row, error } = targets.prepareTarget(req.body || {});
  if (error) return res.status(400).json({ error });
  const created = db.backupTargets.create(row);
  targets.register(created);
  db.auditLog.write('backup.target_create', `Backup destination "${created.name}" (${created.type}) created`, req.ip, true, req.user.username);
  res.status(201).json(targets.publicTarget(created));
});

router.put('/:id', async (req, res) => {
  const existing = db.backupTargets.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Backup destination not found.' });
  if (changesDestination(req.body || {}, existing)) {
    const { error: authError } = await confirmCurrentUser(req.user.username, req.body || {});
    if (authError) return res.status(authError.status).json(authError.body);
  }
  const { row, error } = targets.prepareTarget(req.body || {}, existing);
  if (error) return res.status(400).json({ error });
  const updated = db.backupTargets.update(existing.id, row);
  targets.register(updated);
  db.auditLog.write('backup.target_update', `Backup destination "${updated.name}" updated`, req.ip, true, req.user.username);
  res.json(targets.publicTarget(updated));
});

router.delete('/:id', (req, res) => {
  const existing = db.backupTargets.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Backup destination not found.' });
  targets.unregister(existing.id);
  db.backupTargets.delete(existing.id);
  db.auditLog.write('backup.target_delete', `Backup destination "${existing.name}" deleted; archives at the destination were kept`, req.ip, true, req.user.username);
  res.json({ success: true });
});

router.post('/:id/test', async (req, res) => {
  const existing = db.backupTargets.getById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Backup destination not found.' });
  try { res.json(await targets.testTarget(existing)); }
  catch (error) { res.status(422).json({ error: `Destination not reachable: ${error.message}` }); }
});

router.post('/:id/run', async (req, res) => {
  try { res.json(await targets.runBackup(req.params.id, { actor: req.user.username, ip: req.ip })); }
  catch (error) { res.status(error.status || 422).json({ error: error.message }); }
});

module.exports = router;
