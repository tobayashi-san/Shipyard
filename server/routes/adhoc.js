const express = require('express');
const router = express.Router();
const ansibleRunner = require('../services/ansible-runner');

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
router.post('/run', async (req, res) => {
  const { targets, module: mod, args } = req.body;

  if (!mod || typeof mod !== 'string') return res.status(400).json({ error: 'module required' });
  if (!ALLOWED_MODULES.has(mod)) return res.status(400).json({ error: `Module '${mod}' not in allowlist` });
  if (args !== undefined && typeof args !== 'string') return res.status(400).json({ error: 'args must be a string' });
  if (args && args.length > 2000) return res.status(400).json({ error: 'args too long' });

  const targetStr = (typeof targets === 'string' && targets.trim()) ? targets.trim() : 'all';

  try {
    const outputLines = [];
    const result = await ansibleRunner.runAdHoc(
      targetStr, mod, args || '',
      (type, data) => outputLines.push({ type, data })
    );
    res.json({ success: result.success, output: outputLines, exitCode: result.code ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
