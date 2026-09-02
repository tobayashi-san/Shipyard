const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');
const gitSync = require('../services/git-sync');
const { notify } = require('../services/notifier');
const { getPermissions, filterServers, can, canAccessEnvironment, canAccessPlaybook, canAccessTargets } = require('../utils/permissions');
const { isValidPlaybook, validateTargets, parseTargetExpression, resolveTargets, validateKnownInventoryTargets } = require('../utils/validate');

function createAnsibleRouter({ broadcast } = {}) {
  const router = express.Router();
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  // Limit ansible-playbook spawns to prevent fork-bomb / runaway scheduling.
  const runLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ? `u:${req.user.id}` : ipKeyGenerator(req.ip),
    message: { error: 'Too many playbook runs, please slow down (max 20/min).' },
  });

  function environmentServers(req, res, environmentId) {
    const perms = getPermissions(req.user);
    if (req.environmentId && environmentId !== req.environmentId) {
      res.status(404).json({ error: 'Environment resource not found' });
      return null;
    }
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) {
      res.status(400).json({ error: 'Environment not found' });
      return null;
    }
    if (!canAccessEnvironment(perms, environmentId)) {
      res.status(403).json({ error: 'Environment access denied' });
      return null;
    }
    return db.servers.getAll().filter(server =>
      String(server.environment_id || 'default') === environmentId);
  }

  router.post('/preview-targets', (req, res) => {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
    const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
    const servers = environmentServers(req, res, environmentId);
    if (!servers) return;
    const targets = String(req.body?.targets || '').trim();
    const error = validateTargets(targets) || validateKnownInventoryTargets(targets, servers);
    if (error) return res.status(400).json({ error });
    if (!canAccessTargets(perms, targets, servers)) return res.status(403).json({ error: 'Target servers not permitted for your role' });
    const names = resolveTargets(targets, servers).split(',').filter(Boolean);
    res.json({ environment_id: environmentId, count: names.length, targets: names });
  });

  router.post('/runs/:id/cancel', (req, res) => {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
    const row = db.scheduleHistory.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Run not found' });
    if (req.environmentId && String(row.environment_id || 'default') !== req.environmentId) return res.status(404).json({ error: 'Run not found' });
    const servers = environmentServers(req, res, row.environment_id || 'default');
    if (!servers) return;
    if (!canAccessPlaybook(perms, row.playbook) || !canAccessTargets(perms, row.targets, servers)) {
      return res.status(403).json({ error: 'Run access denied' });
    }
    if (row.status !== 'running') return res.status(409).json({ error: 'Run is not active' });
    if (!ansibleRunner.cancelRun(req.params.id)) return res.status(409).json({ error: 'Run is starting or no longer active' });
    db.auditLog.write('ansible.cancel', `run=${req.params.id} playbook=${row.playbook}`, req.ip, true, req.user?.username);
    res.status(202).json({ id: req.params.id, status: 'cancelling' });
  });

  router.post('/run', runLimiter, async (req, res) => {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
    const { playbook, targets, extraVars, checkMode, forks } = req.body;
    if (!playbook) return res.status(400).json({ error: 'playbook is required' });
    if (!isValidPlaybook(playbook)) return res.status(400).json({ error: 'Invalid playbook filename' });

    if (!perms.full && perms.playbooks !== 'all') {
      if (!Array.isArray(perms.playbooks) || !perms.playbooks.includes(playbook)) {
        return res.status(403).json({ error: 'Playbook not permitted for your role' });
      }
    }

    const targetsErr = validateTargets(targets);
    if (targetsErr) return res.status(400).json({ error: targetsErr });
    const normalizedTargets = typeof targets === 'string' ? targets.trim() : targets;
    if (!normalizedTargets) return res.status(400).json({ error: 'targets is required' });
    const environmentId = req.environmentId || String(req.body?.environment_id || 'default').trim() || 'default';
    const allServers = environmentServers(req, res, environmentId);
    if (!allServers) return;
    const knownTargetsErr = validateKnownInventoryTargets(normalizedTargets, allServers);
    if (knownTargetsErr) return res.status(400).json({ error: knownTargetsErr });

    if (!perms.full && perms.servers !== 'all') {
      const parsedTargets = parseTargetExpression(normalizedTargets);
      if (parsedTargets.kind !== 'list' || parsedTargets.included.length === 0) {
        return res.status(403).json({ error: 'Restricted users must specify individual server targets' });
      }
      const accessibleNames = new Set(filterServers(allServers, perms).map(s => s.name));
      const forbidden = parsedTargets.included.filter(t => !accessibleNames.has(t));
      if (forbidden.length > 0) {
        return res.status(403).json({ error: `Access denied to: ${forbidden.join(', ')}` });
      }
    }
    if (extraVars && (typeof extraVars !== 'object' || Array.isArray(extraVars) ||
        Object.values(extraVars).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) {
      return res.status(400).json({ error: 'extraVars must be a flat object with string/number/boolean values' });
    }
    if (extraVars && JSON.stringify(extraVars).length > 4096) {
      return res.status(400).json({ error: 'extraVars too large (max 4KB)' });
    }
    if (checkMode !== undefined && typeof checkMode !== 'boolean') return res.status(400).json({ error: 'checkMode must be boolean' });
    const normalizedForks = Math.min(50, Math.max(1, Number.parseInt(forks, 10) || 5));

    const resolvedTargets = resolveTargets(normalizedTargets, allServers);
    const schedHistId = db.scheduleHistory.create(null, checkMode ? 'Dry run' : 'Manual run', playbook, resolvedTargets, {
      environmentId,
      triggeredBy: req.user?.username || null,
      checkMode,
    });
    // Manual playbook runs are workflow history rows, not single-server
    // update rows. Use the persisted workflow ID consistently for the API and
    // live events so environment lookup never depends on a phantom FK row.
    const historyId = schedHistId;
    ansibleRunner.prepareRun(schedHistId);
    const outputLines = [];

    res.json({ historyId, runId: schedHistId, status: 'started', targets: resolvedTargets.split(',').filter(Boolean), check_mode: Boolean(checkMode) });

    try {
      await gitSync.autoPull();
      const result = await ansibleRunner.runPlaybook(
        playbook,
        normalizedTargets,
        extraVars || {},
        (type, data) => {
          outputLines.push(data);
          db.scheduleHistory.appendOutput(schedHistId, data);
          emit({ type: 'ansible_output', historyId, runId: schedHistId, environmentId, playbook, stream: type, data });
        },
        { environmentId, checkMode, forks: normalizedForks, runId: schedHistId }
      );

      const status = result.cancelled ? 'cancelled' : result.success ? 'success' : 'failed';
      const output = outputLines.join('') || result.stdout + result.stderr;
      db.scheduleHistory.complete(schedHistId, status, output);
      db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} status=${status}`, req.ip, result.success, req.user?.username);
      for (const s of allServers) {
        if (resolvedTargets.split(',').includes(s.name)) db.updatesCache.delete(s.id);
      }
      emit({ type: 'ansible_complete', historyId, success: result.success, status, runId: schedHistId, environmentId, playbook });
    } catch (error) {
      ansibleRunner.clearRun(schedHistId);
      db.scheduleHistory.complete(schedHistId, 'failed', outputLines.join('') + (outputLines.length ? '\n' : '') + error.message);
      db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} error=${error.message}`, req.ip, false, req.user?.username);
      emit({ type: 'ansible_error', historyId, runId: schedHistId, environmentId, playbook, error: error.message });
      if (db.settings.get('notify_playbook_failed') !== '0') notify(`Playbook failed: ${playbook}`, error.message, false).catch(() => {});
    }
  });

  return router;
}

module.exports = createAnsibleRouter;
