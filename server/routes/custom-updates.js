const { updateCatalogAge } = require('../utils/update-catalog-age');
const rateLimit = require('express-rate-limit');
const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db');
const scheduler = require('../services/scheduler');
const resourceAlerts = require('../services/resource-alerts');
const { getPermissions, can, guardServerAccess } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');
const { linkedGuest } = require('../features/opentofu/host-guest');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

function auditCustom(req, action, task, success = true, changed = []) {
  const detail = `server_id=${JSON.stringify(String(req.server.id))} task_id=${JSON.stringify(String(task.id || 'draft'))} name=${JSON.stringify(String(task.name || ''))}${changed.length ? ` changed_fields=${JSON.stringify(changed.join(', '))}` : ''}`;
  db.auditLog.write(`custom_update.${action}`, detail, req.ip, success, req.user?.username, req.server.environment_id || 'default');
}

const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

// Returns an error string or null if valid
function validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output, latest_command }) {
  if (!name || !['script', 'github', 'trigger'].includes(type))
    return 'name and type (script|github|trigger) are required';
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return 'name too long (max 200)';
  if (update_command !== undefined && update_command !== null && (typeof update_command !== 'string' || update_command.length > 5000))
    return 'update_command too long (max 5000)';
  if (check_command !== undefined && check_command !== null && (typeof check_command !== 'string' || check_command.length > 5000))
    return 'check_command too long (max 5000)';
  if (trigger_output !== undefined && trigger_output !== null && (typeof trigger_output !== 'string' || trigger_output.length > 5000))
    return 'trigger_output too long (max 5000)';
  if (latest_command !== undefined && latest_command !== null && (typeof latest_command !== 'string' || latest_command.length > 5000))
    return 'latest_command too long (max 5000)';
  if (type === 'github' && (!github_repo || !GITHUB_REPO_RE.test(github_repo)))
    return 'github_repo must be "owner/repo" for type=github';
  if (typeof check_command !== 'string' || !check_command.trim())
    return 'A command that returns the installed version or trigger output is required.';
  if (type === 'script' && (typeof latest_command !== 'string' || !latest_command.trim()))
    return 'A command that returns the desired version is required for script checks.';
  if (type === 'trigger' && (typeof trigger_output !== 'string' || !trigger_output.trim()))
    return 'trigger_output is required for type=trigger';
  return null;
}

// Snapshots act on the Proxmox guest, so enabling them needs guest edit rights and a link.
function snapshotOptionError(req, snapshotBeforeRun, previous = false) {
  if (snapshotBeforeRun === undefined || snapshotBeforeRun === null) return null;
  if (typeof snapshotBeforeRun !== 'boolean') return 'snapshot_before_run must be true or false';
  if (!snapshotBeforeRun || previous) return null;
  if (!can(getPermissions(req.user), 'canEditServers')) return 'Creating snapshots requires permission to edit hosts.';
  if (!linkedGuest(req.server)) return 'This host is not linked to a Proxmox VM or container, so no snapshot can be taken.';
  return null;
}

// GET /api/servers/:id/custom-updates/snapshot-target
router.get('/snapshot-target', guardServerAccess, guard('canViewCustomUpdates'), (req, res) => {
  const guest = linkedGuest(req.server);
  res.json(guest ? { available: true, node_name: guest.node_name, vm_id: guest.vm_id, guest_type: guest.guest_type } : { available: false });
});

// GET /api/servers/:id/custom-updates
router.get('/', guardServerAccess, guard('canViewCustomUpdates'), (req, res) => {
  res.json(db.customUpdateTasks.getByServer(req.params.id).map(task => ({ ...task, ...updateCatalogAge(task.last_checked_at, db.settings.get('poll_custom_updates_interval_min') || 360), source: task.type === 'github' ? 'Installed version command and GitHub release' : task.type === 'trigger' ? 'Configured trigger command and expected output' : 'Configured installed and desired version commands' })));
});

// Executes only the configured check commands, without creating/updating a task.
router.post('/preview', guardServerAccess, guard('canEditCustomUpdates'), guard('canRunCustomUpdates'), rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const validationError = validateTaskInput(req.body || {});
  if (validationError) return res.status(400).json({ error: validationError });
  const { name, type, check_command, github_repo, trigger_output, latest_command } = req.body;
  try {
    const result = await scheduler.previewCustomTask(req.server, { name, type, check_command, github_repo, trigger_output, latest_command });
    auditCustom(req, 'preview', { name });
    res.json(result);
  } catch (error) {
    auditCustom(req, 'preview', { name }, false);
    // Do not return SSH exception text or command output in an error response.
    res.status(422).json({ error: 'Check failed. Review host connectivity, commands and release source.' });
  }
});

// POST /api/servers/:id/custom-updates
router.post('/', guardServerAccess, guard('canEditCustomUpdates'), (req, res) => {
  const { name, type, check_command, github_repo, update_command, trigger_output, latest_command, snapshot_before_run } = req.body;
  const validationError = validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output, latest_command }) || snapshotOptionError(req, snapshot_before_run);
  if (validationError) return res.status(400).json({ error: validationError });
  const task = db.customUpdateTasks.create(req.params.id, { name, type, check_command, github_repo, update_command, trigger_output, latest_command, snapshot_before_run });
  resourceAlerts.evaluateServer(req.params.id);
  auditCustom(req, 'create', task);
  res.status(201).json(task);
});

// PUT /api/servers/:id/custom-updates/:taskId
router.put('/:taskId', guardServerAccess, guard('canEditCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  const { name, type, check_command, github_repo, update_command, trigger_output, latest_command } = req.body;
  // Omitting the option keeps the stored choice, so older clients cannot switch it off.
  const snapshot_before_run = req.body.snapshot_before_run ?? !!task.snapshot_before_run;
  const validationError = validateTaskInput({ name, type, update_command, check_command, github_repo, trigger_output, latest_command }) || snapshotOptionError(req, snapshot_before_run, !!task.snapshot_before_run);
  if (validationError) return res.status(400).json({ error: validationError });
  const updated = db.customUpdateTasks.update(req.params.taskId, { name, type, check_command, github_repo, update_command, trigger_output, latest_command, snapshot_before_run });
  resourceAlerts.evaluateServer(req.params.id);
  const changed = ['name', 'type', 'check_command', 'github_repo', 'update_command', 'trigger_output', 'latest_command', 'snapshot_before_run'].filter(field => (task[field] || null) !== (updated[field] || null));
  auditCustom(req, 'update', updated, true, changed);
  res.json(updated);
});

// DELETE /api/servers/:id/custom-updates/:taskId
router.delete('/:taskId', guardServerAccess, guard('canDeleteCustomUpdates'), (req, res) => {
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  db.customUpdateTasks.delete(req.params.taskId);
  auditCustom(req, 'delete', task);
  resourceAlerts.evaluateServer(req.params.id);
  res.json({ success: true });
});

// POST /api/servers/:id/custom-updates/:taskId/check  (manual version check)
router.post('/:taskId/check', guardServerAccess, guard('canRunCustomUpdates'), async (req, res) => {
  const server = req.server;
  const task = db.customUpdateTasks.getById(req.params.taskId);
  if (!task || task.server_id !== req.params.id) return res.status(404).json({ error: 'Task not found' });
  try {
    await scheduler.checkCustomTask(server, task);
    resourceAlerts.evaluateServer(req.params.id);
    auditCustom(req, 'check', task);
    res.json(db.customUpdateTasks.getById(task.id));
  } catch (err) {
    auditCustom(req, 'check', task, false);
    serverError(res, err, 'custom update check');
  }
});

module.exports = router;
