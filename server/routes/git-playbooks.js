const express = require('express');
const router = express.Router();
const db = require('../db');
const gitSync = require('../services/git-sync');

// GET /api/playbooks-git/config
router.get('/config', (req, res) => {
  const cfg = gitSync.getConfig();
  res.json({
    repoUrl:   cfg.repoUrl,
    hasToken:  !!cfg.authToken,
    autoPull:  cfg.autoPull,
    autoPush:  cfg.autoPush,
    userName:  cfg.userName,
    userEmail: cfg.userEmail,
    configured: gitSync.isConfigured(),
  });
});

// POST /api/playbooks-git/setup  (initial config + clone/init)
router.post('/setup', async (req, res) => {
  const { repoUrl, authToken, autoPull, autoPush, userName, userEmail } = req.body;
  if (!repoUrl || typeof repoUrl !== 'string') return res.status(400).json({ error: 'repoUrl required' });
  if (!/^(git@|https?:\/\/|ssh:\/\/)/.test(repoUrl)) return res.status(400).json({ error: 'Invalid git URL' });

  try {
    const result = await gitSync.setup({ repoUrl, authToken, autoPull, autoPush, userName, userEmail });
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ success: true, pullOutput: result.pullOutput });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/playbooks-git/config  (update settings without re-cloning)
router.put('/config', (req, res) => {
  const { autoPull, autoPush, userName, userEmail, authToken } = req.body;
  if (autoPull  !== undefined) db.settings.set('git_auto_pull',  autoPull  ? '1' : '0');
  if (autoPush  !== undefined) db.settings.set('git_auto_push',  autoPush  ? '1' : '0');
  if (userName  !== undefined) db.settings.set('git_user_name',  userName);
  if (userEmail !== undefined) db.settings.set('git_user_email', userEmail);
  if (authToken !== undefined) db.settings.set('git_auth_token', authToken);
  res.json({ success: true });
});

// GET /api/playbooks-git/status
router.get('/status', async (req, res) => {
  res.json(await gitSync.getStatus());
});

// GET /api/playbooks-git/log
router.get('/log', async (req, res) => {
  res.json(await gitSync.getLog());
});

// POST /api/playbooks-git/pull
router.post('/pull', async (req, res) => {
  const r = await gitSync.pull();
  if (!r.success) return res.status(500).json({ error: r.stderr });
  res.json({ success: true, output: r.stdout });
});

// POST /api/playbooks-git/commit
router.post('/commit', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  if (message.length > 500) return res.status(400).json({ error: 'message too long' });
  const r = await gitSync.commit(message);
  if (!r.success) return res.status(400).json({ error: r.stderr || 'Nothing to commit' });
  res.json({ success: true, output: r.stdout });
});

// POST /api/playbooks-git/push
router.post('/push', async (req, res) => {
  const r = await gitSync.push();
  if (!r.success) return res.status(500).json({ error: r.stderr });
  res.json({ success: true, output: r.stdout });
});

module.exports = router;
