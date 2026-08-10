const express = require('express');
const db = require('../db');

const router = express.Router();
const isAdmin = (req) => req.user?.role === 'admin';
const hasTable = (name) => Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

router.get('/', (req, res) => {
  const deploymentCount = hasTable('tofu_workspaces')
    ? "COUNT(DISTINCT w.id) AS deployment_count"
    : '0 AS deployment_count';
  const workspaceJoin = hasTable('tofu_workspaces')
    ? 'LEFT JOIN tofu_workspaces w ON w.environment_id = e.id'
    : '';
  const rows = db.db.prepare(`SELECT e.id, e.name, COUNT(DISTINCT s.id) AS server_count, ${deploymentCount} FROM environments e LEFT JOIN servers s ON s.environment_id = e.id ${workspaceJoin} GROUP BY e.id ORDER BY e.name`).all();
  res.json(rows);
});

router.post('/', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = db.uuidv4();
  try { db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(id, name); res.status(201).json({ id, name, server_count: 0 }); }
  catch { res.status(409).json({ error: 'Environment already exists' }); }
});

router.put('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = db.db.prepare('UPDATE environments SET name = ? WHERE id = ?').run(name, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Permission denied' });
  if (req.params.id === 'default') return res.status(400).json({ error: 'Default environment cannot be deleted' });
  const remove = db.db.transaction((id) => {
    db.db.prepare("UPDATE servers SET environment_id = 'default' WHERE environment_id = ?").run(id);
    // Deployments are first-class environment resources as well. Keep them
    // visible after an environment is removed instead of orphaning them.
    if (hasTable('tofu_workspaces')) db.db.prepare("UPDATE tofu_workspaces SET environment_id = 'default' WHERE environment_id = ?").run(id);
    return db.db.prepare('DELETE FROM environments WHERE id = ?').run(id);
  });
  const result = remove(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Environment not found' });
  res.json({ success: true });
});

module.exports = router;
