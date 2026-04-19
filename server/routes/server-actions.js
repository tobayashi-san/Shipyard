const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');
const { notify } = require('../services/notifier');
const { createComposeTempFile, buildComposeWriteOperations } = require('../utils/compose-write');
const { getPermissions, can, guardServerAccess } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

function createServerActionsRouter({ broadcast } = {}) {
  const router = express.Router();
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  const rebootLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Too many reboot requests. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const containerRestartLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many restart requests. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const customUpdateRunLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many update executions. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const composeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    message: { error: 'Too many compose requests. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const BLOCKED_REMOTE_PREFIXES = ['/etc/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/boot/', '/proc/', '/sys/', '/dev/'];

  function isBlockedRemotePath(p) {
    const normalized = p.replace(/\/+/g, '/').replace(/\/$/, '');
    if (BLOCKED_REMOTE_PREFIXES.some(prefix => (normalized + '/').startsWith(prefix))) return true;
    return false;
  }

  router.post('/:id/update', guardServerAccess, (req, res, next) => {
    if (!can(getPermissions(req.user), 'canRunUpdates')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const serverId = req.params.id;
    const server = req.server;

    const historyId = db.updateHistory.create(serverId, 'system_update');

    res.json({ historyId, status: 'started' });

    try {
      const result = await ansibleRunner.runPlaybook(
        'update.yml',
        server.name,
        {},
        (type, data) => {
          emit({ type: 'update_output', serverId, historyId, stream: type, data });
        }
      );

      const status = result.success ? 'success' : 'failed';
      db.updateHistory.updateStatus(historyId, status, result.stdout + result.stderr);
      db.auditLog.write('server.update', `server=${server.name} status=${status}`, req.ip, result.success, req.user?.username);
      db.updatesCache.delete(serverId);
      emit({ type: 'update_complete', serverId, historyId, success: result.success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      db.auditLog.write('server.update', `server=${server.name} error=${error.message}`, req.ip, false, req.user?.username);
      emit({ type: 'update_error', serverId, historyId, error: error.message });
      if (db.settings.get('notify_update_failed') !== '0') notify(`Update failed: ${server.name}`, error.message, false).catch(() => {});
    }
  });

  router.post('/update-all', (req, res, next) => {
    if (!can(getPermissions(req.user), 'canRunUpdates')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const historyId = db.updateHistory.create('bulk_update', 'system_update_all');
    res.json({ historyId, status: 'started' });

    try {
      const result = await ansibleRunner.runPlaybook(
        'update.yml',
        'all',
        {},
        (type, data) => {
          emit({ type: 'bulk_update_output', historyId, stream: type, data });
        }
      );

      const status = result.success ? 'success' : 'failed';
      db.updateHistory.updateStatus(historyId, status, result.stdout + result.stderr);
      db.auditLog.write('server.update_all', `status=${status}`, req.ip, result.success, req.user?.username);
      emit({ type: 'bulk_update_complete', historyId, success: result.success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      db.auditLog.write('server.update_all', `error=${error.message}`, req.ip, false, req.user?.username);
      emit({ type: 'bulk_update_error', historyId, error: error.message });
      if (db.settings.get('notify_update_failed') !== '0') notify('Bulk update failed', error.message, false).catch(() => {});
    }
  });

  router.post('/:id/reboot', guardServerAccess, rebootLimiter, (req, res, next) => {
    if (!can(getPermissions(req.user), 'canRebootServers')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const serverId = req.params.id;
    const server = req.server;

    const historyId = db.updateHistory.create(serverId, 'reboot');
    res.json({ historyId, status: 'started' });

    try {
      emit({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Initiating reboot for ${server.name}...\n` });

      const result = await ansibleRunner.runAdHoc(
        server.name,
        'reboot',
        '',
        (type, data) => {
          emit({ type: 'update_output', serverId, historyId, stream: type, data });
        }
      );

      db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
      emit({ type: 'update_complete', serverId, historyId, success: result.success });

      if (result.success) {
        setTimeout(() => {
          systemInfo.getSystemInfo(server)
            .then(info => { try { db.serverInfo.upsert(server.id, info); } catch {} })
            .catch(() => {});
        }, 5000);
      }
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      emit({ type: 'update_error', serverId, historyId, error: error.message });
    }
  });

  router.post('/:id/docker/:container/restart', guardServerAccess, containerRestartLimiter, (req, res, next) => {
    if (!can(getPermissions(req.user), 'canRestartDocker')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const { id: serverId, container } = req.params;
    if (!/^[a-zA-Z0-9_.-]+$/.test(container) || container.startsWith('-')) return res.status(400).json({ error: 'Invalid container name' });
    const server = req.server;

    const historyId = db.updateHistory.create(serverId, `restart_docker_${container}`);
    res.json({ historyId, status: 'started' });

    try {
      emit({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Restarting container ${container} on ${server.name}...\n` });

      const result = await ansibleRunner.runAdHoc(
        server.name,
        'shell',
        `$(command -v docker 2>/dev/null || command -v podman 2>/dev/null) restart ${container}`,
        (type, data) => {
          emit({ type: 'update_output', serverId, historyId, stream: type, data });
        },
        { become: true }
      );

      db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
      emit({ type: 'update_complete', serverId, historyId, success: result.success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      emit({ type: 'update_error', serverId, historyId, error: error.message });
    }
  });

  router.post('/:id/custom-updates/:taskId/run', guardServerAccess, customUpdateRunLimiter, (req, res, next) => {
    if (!can(getPermissions(req.user), 'canRunCustomUpdates')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const server = req.server;
    const task = db.customUpdateTasks.getById(req.params.taskId);
    if (!task || task.server_id !== server.id) return res.status(404).json({ error: 'Task not found' });
    if (!String(task.update_command || '').trim()) {
      return res.status(400).json({ error: 'No update command configured for this task' });
    }

    const historyId = db.updateHistory.create(server.id, `custom_update:${task.name}`);
    res.json({ historyId, status: 'started' });

    emit({ type: 'update_output', serverId: server.id, historyId, stream: 'stdout', data: `Running: ${task.name}\n` });
    try {
      let cmd = task.update_command;
      if (/^https?:\/\//.test(cmd)) {
        if (/["'`$\\;&|<>()\r\n\t ]/.test(cmd)) {
          db.updateHistory.updateStatus(historyId, 'failed', 'Invalid characters in update URL');
          emit({ type: 'update_error', serverId: server.id, historyId, error: 'Invalid characters in update URL' });
          return;
        }
        cmd = `curl -fsSL -- "${cmd}" | bash`;
      }
      let fullOutput = '';
      const code = await sshManager.execStream(server, cmd, chunk => {
        fullOutput += chunk;
        emit({ type: 'update_output', serverId: server.id, historyId, stream: 'stdout', data: chunk });
      });
      const success = code === 0;
      db.updateHistory.updateStatus(historyId, success ? 'success' : 'failed', fullOutput);
      db.auditLog.write('custom_update.run', `server=${server.name} task=${task.name}`, req.ip, success, req.user?.username);
      emit({ type: 'update_complete', serverId: server.id, historyId, success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      emit({ type: 'update_error', serverId: server.id, historyId, error: error.message });
    }
  });

  router.post('/:id/docker/compose/write', composeLimiter, guardServerAccess, (req, res, next) => {
    if (!can(getPermissions(req.user), 'canManageDockerCompose')) return res.status(403).json({ error: 'Permission denied' });
    next();
  }, async (req, res) => {
    const { path: remotePath, content } = req.body;
    const server = req.server;
    if (!remotePath || !content) return res.status(400).json({ error: 'path and content required' });
    if (!/^[a-zA-Z0-9/_.-]+$/.test(remotePath) || remotePath.includes('..')) return res.status(400).json({ error: 'Invalid path format' });
    if (isBlockedRemotePath(remotePath)) return res.status(400).json({ error: 'Path not allowed: system directories are protected' });

    let tempCompose;
    try {
      tempCompose = createComposeTempFile(content);
      const ops = buildComposeWriteOperations(remotePath, tempCompose.tmpFile);

      const ensureDir = await ansibleRunner.runAdHoc(
        server.name,
        ops.ensureDir.module,
        ops.ensureDir.args,
        () => {},
        { become: true }
      );
      if (!ensureDir.success) {
        return res.status(500).json({ error: 'Failed to create compose directory', details: ensureDir.stderr || ensureDir.stdout });
      }

      const copyResult = await ansibleRunner.runAdHoc(
        server.name,
        ops.copyFile.module,
        ops.copyFile.args,
        () => {},
        { become: true }
      );

      if (copyResult.success) {
        if (!db.composeProjects.getByServerAndPath(server.id, remotePath)) {
          const projectName = remotePath.split('/').pop() || 'stack';
          db.composeProjects.upsert(server.id, projectName, remotePath);
        }
        res.json({ success: true, message: 'docker-compose.yml saved successfully' });
      } else {
        res.status(500).json({ error: 'Failed to write docker-compose.yml', details: copyResult.stderr || copyResult.stdout });
      }
    } catch (err) {
      serverError(res, err, 'write docker-compose');
    } finally {
      tempCompose?.cleanup();
    }
  });

  router.post('/:id/docker/compose/action', composeLimiter, guardServerAccess, async (req, res) => {
    const { id: serverId } = req.params;
    const { path: remotePath, action } = req.body;
    const perms = getPermissions(req.user);
    if (!remotePath || !['up', 'down', 'pull'].includes(action)) return res.status(400).json({ error: 'Invalid path or action' });
    const requiredCap = action === 'pull' ? 'canPullDocker' : 'canManageDockerCompose';
    if (!can(perms, requiredCap)) return res.status(403).json({ error: 'Permission denied' });
    const server = req.server;
    if (!/^[a-zA-Z0-9/_.-]+$/.test(remotePath) || remotePath.includes('..')) return res.status(400).json({ error: 'Invalid path format' });
    if (isBlockedRemotePath(remotePath)) return res.status(400).json({ error: 'Path not allowed: system directories are protected' });

    const historyId = db.updateHistory.create(serverId, `compose_${action}_${remotePath.split('/').pop()}`);
    res.json({ historyId, status: 'started' });

    try {
      const rt = '$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)';
      let cmd = '';
      if (action === 'up') cmd = `${rt} compose up -d`;
      if (action === 'down') cmd = `${rt} compose down`;
      if (action === 'pull') cmd = `${rt} compose pull`;

      emit({ type: 'update_output', serverId, historyId, stream: 'stdout', data: `Running compose ${action.toUpperCase()} in ${remotePath} on ${server.name}...\n` });

      const safePath = remotePath.replace(/'/g, "'\\''");
      const result = await ansibleRunner.runAdHoc(
        server.name,
        'shell',
        `cd '${safePath}' && ${cmd}`,
        (type, data) => {
          emit({ type: 'update_output', serverId, historyId, stream: type, data });
        },
        { become: true }
      );

      db.updateHistory.updateStatus(historyId, result.success ? 'success' : 'failed', result.stdout + result.stderr);
      emit({ type: 'update_complete', serverId, historyId, success: result.success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      emit({ type: 'update_error', serverId, historyId, error: error.message });
    }
  });

  router.delete('/:id/docker/compose/stack', guardServerAccess, (req, res) => {
    if (!can(getPermissions(req.user), 'canManageDockerCompose')) return res.status(403).json({ error: 'Permission denied' });
    const { id: serverId } = req.params;
    const { path: remotePath } = req.query;
    if (!remotePath || typeof remotePath !== 'string') return res.status(400).json({ error: 'path query param required' });
    try {
      const projectName = remotePath.split('/').filter(Boolean).pop() || remotePath;
      db.composeProjects.delete(serverId, projectName);
      db.auditLog.write('compose.delete', `server=${req.server.name} path=${remotePath}`, req.ip, true, req.user?.username);
      res.json({ status: 'deleted' });
    } catch (err) {
      serverError(res, err, 'delete compose stack');
    }
  });

  return router;
}

module.exports = createServerActionsRouter;
