const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const scheduler = require('../services/scheduler');
const { getPermissions, can, guardServerAccess } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// Returns an error string or null if valid
function validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output }) {
  if (!name || !['script', 'github', 'trigger'].includes(type))
    return 'name and type (script|github|trigger) are required';
  if (typeof name !== 'string' || name.length > 200) return 'name too long (max 200)';
  if (update_command !== undefined && update_command !== null && (typeof update_command !== 'string' || update_command.length > 5000))
    return 'update_command too long (max 5000)';
  if (check_command !== undefined && check_command !== null && (typeof check_command !== 'string' || check_command.length > 5000))
    return 'check_command too long (max 5000)';
  if (trigger_output !== undefined && trigger_output !== null && (typeof trigger_output !== 'string' || trigger_output.length > 5000))
    return 'trigger_output too long (max 5000)';
  if ((type === 'script' || type === 'github') && !update_command)
    return 'update_command is required for type=script and type=github';
  if (type === 'github' && (!github_repo || !GITHUB_REPO_RE.test(github_repo)))
    return 'github_repo must be "owner/repo" for type=github';
  if (type === 'trigger' && !check_command)
    return 'check_command is required for type=trigger';
  if (type === 'trigger' && !trigger_output)
    return 'trigger_output is required for type=trigger';
  return null;
}

// GET /api/servers/:id/custom-updates
router.get('/', guardServerAccess, guard('canViewCustomUpdates'), (req, res) => {
  res.json(db.customUpdateTasks.getByServer(req.params.id));
});

// POST /api/servers/:id/custom-updates
router.post('/', guardServerAccess, guard('canEditCustomUpdates'), (req, res) => {
  const { name, type, check_command, github_repo, update_command, trigger_output } = req.body;
  const validationError = validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output });
  if (validationError) return res.status(400).json({ error: validationError });
  const task = db.customUpdateTasks.create(req.params.id, { name, type, check_command, github_repo, update_command, trigger_output });
  res.status(201).json(task);
});

// PUT /api/servers/:id/custom-updates/:taskId
router.put('/:taskId', guardServerAccess, guard('canEditCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  const { name, type, check_command, github_repo, update_command, trigger_output } = req.body;
  const validationError = validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output });
  if (validationError) return res.status(400).json({ error: validationError });
  res.json(db.customUpdateTasks.update(req.params.taskId, { name, type, check_command, github_repo, update_command, trigger_output }));
});

// DELETE /api/servers/:id/custom-updates/:taskId
router.delete('/:taskId', guardServerAccess, guard('canDeleteCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  db.customUpdateTasks.delete(req.params.taskId);
  res.json({ success: true });
});

// POST /api/servers/:id/custom-updates/:taskId/check  (manual version check)
router.post('/:taskId/check', guardServerAccess, guard('canRunCustomUpdates'), async (req, res) => {
  const server = req.server;
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  try {
    await scheduler.checkCustomTask(server, task);
    res.json(db.customUpdateTasks.getById(task.id));
  } catch (err) {
    serverError(res, err, 'custom update check');
  }
});

module.exports = router;
