const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const ansibleRunner = require('../services/ansible-runner');
const db = require('../db');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

const adhocLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many ad-hoc requests. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const ALLOWED_MODULES = new Set([
  'ping', 'setup',
  'shell', 'command', 'raw', 'script',
  'apt', 'dnf', 'yum', 'pacman', 'zypper',
  'service', 'systemd',
  'copy', 'file', 'fetch', 'template',
  'user', 'group',
  'reboot',
]);

// POST /api/adhoc/run
router.post('/run', adhocLimiter, (req, res, next) => {
  if (!can(getPermissions(req.user), 'canRunPlaybooks')) return res.status(403).json({ error: 'Permission denied' });
  next();
}, async (req, res) => {
  const { targets, module: mod, args } = req.body;

  if (!mod || typeof mod !== 'string') return res.status(400).json({ error: 'module required' });
  if (!ALLOWED_MODULES.has(mod)) return res.status(400).json({ error: `Module '${mod}' not in allowlist` });
  if (args !== undefined && typeof args !== 'string') return res.status(400).json({ error: 'args must be a string' });
  if (args && args.length > 2000) return res.status(400).json({ error: 'args too long' });

  const targetStr = (typeof targets === 'string' && targets.trim()) ? targets.trim() : 'all';

  // Target authorization: restricted users may only run against their accessible servers
  const perms = getPermissions(req.user);
  if (!perms.full && perms.servers !== 'all') {
    const resolvedTargets = targetStr.split(',').map(t => t.trim()).filter(Boolean);
    if (resolvedTargets.length === 0 || resolvedTargets.includes('all')) {
      return res.status(403).json({ error: 'Restricted users must specify individual server targets' });
    }
    const accessibleNames = new Set(filterServers(db.servers.getAll(), perms).map(s => s.name));
    const forbidden = resolvedTargets.filter(t => !accessibleNames.has(t));
    if (forbidden.length > 0) {
      return res.status(403).json({ error: `Access denied to: ${forbidden.join(', ')}` });
    }
  }

  try {
    const outputLines = [];
    const result = await ansibleRunner.runAdHoc(
      targetStr, mod, args || '',
      (type, data) => outputLines.push({ type, data })
    );
    res.json({ success: result.success, output: outputLines, exitCode: result.code ?? 0 });
  } catch (e) {
    serverError(res, e, 'adhoc run');
  }
});

module.exports = router;
