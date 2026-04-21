const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');
const gitSync = require('../services/git-sync');
const { notify } = require('../services/notifier');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const { isValidPlaybook, validateTargets, parseTargetExpression, resolveTargets } = require('../utils/validate');

function createAnsibleRouter({ broadcast } = {}) {
  const router = express.Router();
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  // Limit ansible-playbook spawns to prevent fork-bomb / runaway scheduling.
  const runLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id || req.ip,
    message: { error: 'Too many playbook runs, please slow down (max 20/min).' },
  });

  router.post('/run', runLimiter, async (req, res) => {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
    const { playbook, targets, extraVars } = req.body;
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

    if (!perms.full && perms.servers !== 'all') {
      const parsedTargets = parseTargetExpression(normalizedTargets);
      if (parsedTargets.kind !== 'list' || parsedTargets.included.length === 0) {
        return res.status(403).json({ error: 'Restricted users must specify individual server targets' });
      }
      const accessibleNames = new Set(filterServers(db.servers.getAll(), perms).map(s => s.name));
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

    const historyId = db.updateHistory.create(normalizedTargets, `ansible:${playbook}`, req.user?.username || null);
    const resolvedTargets = resolveTargets(normalizedTargets, db.servers.getAll());
    const schedHistId = db.scheduleHistory.create(null, 'Quick Run', playbook, resolvedTargets);

    res.json({ historyId, status: 'started' });

    await gitSync.autoPull();

    try {
      const result = await ansibleRunner.runPlaybook(
        playbook,
        normalizedTargets,
        extraVars || {},
        (type, data) => {
          emit({ type: 'ansible_output', historyId, stream: type, data });
        }
      );

      const status = result.success ? 'success' : 'failed';
      const output = result.stdout + result.stderr;
      db.updateHistory.updateStatus(historyId, status, output);
      db.scheduleHistory.complete(schedHistId, status, output);
      db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} status=${status}`, req.ip, result.success, req.user?.username);
      for (const s of db.servers.getAll()) {
        if (resolvedTargets.split(',').includes(s.name)) db.updatesCache.delete(s.id);
      }
      emit({ type: 'ansible_complete', historyId, success: result.success });
    } catch (error) {
      db.updateHistory.updateStatus(historyId, 'failed', error.message);
      db.scheduleHistory.complete(schedHistId, 'failed', error.message);
      db.auditLog.write('ansible.run', `playbook=${playbook} targets=${normalizedTargets} error=${error.message}`, req.ip, false, req.user?.username);
      emit({ type: 'ansible_error', historyId, error: error.message });
      if (db.settings.get('notify_playbook_failed') !== '0') notify(`Playbook failed: ${playbook}`, error.message, false).catch(() => {});
    }
  });

  return router;
}

module.exports = createAnsibleRouter;
