const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const scheduler = require('../services/scheduler');
const { getPermissions, can } = require('../utils/permissions');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// Returns an error string or null if valid
function validateTaskInput({ name, type, update_command, github_repo }) {
  if (!name || !update_command || !['script', 'github'].includes(type))
    return 'name, type (script|github), and update_command are required';
  if (type === 'github' && (!github_repo || !GITHUB_REPO_RE.test(github_repo)))
    return 'github_repo must be "owner/repo" for type=github';
  return null;
}

// GET /api/servers/:id/custom-updates
router.get('/', guard('canViewCustomUpdates'), (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json(db.customUpdateTasks.getByServer(req.params.id));
});

// POST /api/servers/:id/custom-updates
router.post('/', guard('canEditCustomUpdates'), (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const { name, type, check_command, github_repo, update_command } = req.body;
  const validationError = validateTaskInput({ name, type, update_command, github_repo });
  if (validationError) return res.status(400).json({ error: validationError });
  const task = db.customUpdateTasks.create(req.params.id, { name, type, check_command, github_repo, update_command });
  res.status(201).json(task);
});

// PUT /api/servers/:id/custom-updates/:taskId
router.put('/:taskId', guard('canEditCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  const { name, type, check_command, github_repo, update_command } = req.body;
  const validationError = validateTaskInput({ name, type, update_command, github_repo });
  if (validationError) return res.status(400).json({ error: validationError });
  res.json(db.customUpdateTasks.update(req.params.taskId, { name, type, check_command, github_repo, update_command }));
});

// DELETE /api/servers/:id/custom-updates/:taskId
router.delete('/:taskId', guard('canDeleteCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  db.customUpdateTasks.delete(req.params.taskId);
  res.json({ success: true });
});

// POST /api/servers/:id/custom-updates/:taskId/check  (manual version check)
router.post('/:taskId/check', guard('canRunCustomUpdates'), async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  try {
    await scheduler.checkCustomTask(server, task);
    res.json(db.customUpdateTasks.getById(task.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
