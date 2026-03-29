const express = require('express');
const router = express.Router();
const db = require('../db');
const gitSync = require('../services/git-sync');
const { adminOnly } = require('../middleware/auth');
const { setSecret } = require('../utils/crypto');
const { serverError } = require('../utils/http-error');

// All git-playbooks routes are admin-only
router.use(adminOnly);

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
    branch:    cfg.branch,
    configured: gitSync.isConfigured(),
  });
});

// POST /api/playbooks-git/disconnect
router.post('/disconnect', (req, res) => {
  const db = require('../db');
  ['git_repo_url','git_auth_token','git_ssh_key','git_auto_pull','git_auto_push',
   'git_user_name','git_user_email','git_branch'].forEach(k => db.settings.set(k, ''));
  res.json({ success: true });
});

// POST /api/playbooks-git/settings
router.post('/settings', (req, res) => {
  const db = require('../db');
  const { autoPull, autoPush } = req.body;
  if (autoPull !== undefined) db.settings.set('git_auto_pull', autoPull ? '1' : '0');
  if (autoPush !== undefined) db.settings.set('git_auto_push', autoPush ? '1' : '0');
  res.json({ success: true });
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
    serverError(res, e, 'git setup');
  }
});

// PUT /api/playbooks-git/config  (update settings without re-cloning)
router.put('/config', (req, res) => {
  const { autoPull, autoPush, userName, userEmail, authToken } = req.body;
  if (autoPull  !== undefined) db.settings.set('git_auto_pull',  autoPull  ? '1' : '0');
  if (autoPush  !== undefined) db.settings.set('git_auto_push',  autoPush  ? '1' : '0');
  if (userName  !== undefined) db.settings.set('git_user_name',  userName);
  if (userEmail !== undefined) db.settings.set('git_user_email', userEmail);
  if (authToken !== undefined) setSecret(db, 'git_auth_token', authToken);
  res.json({ success: true });
});

// GET /api/playbooks-git/branches
router.get('/branches', async (req, res) => {
  try { res.json(await gitSync.getBranches()); }
  catch (e) { serverError(res, e, 'git branches'); }
});

// POST /api/playbooks-git/checkout
router.post('/checkout', async (req, res) => {
  const { branch } = req.body;
  if (!branch || typeof branch !== 'string') return res.status(400).json({ error: 'branch required' });
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) return res.status(400).json({ error: 'Invalid branch name' });
  try {
    const r = await gitSync.checkout(branch);
    if (!r.success) return res.status(500).json({ error: r.stderr });
    res.json({ success: true, output: r.stdout });
  } catch (e) { serverError(res, e, 'git checkout'); }
});

// GET /api/playbooks-git/status
router.get('/status', async (req, res) => {
  try { res.json(await gitSync.getStatus()); }
  catch (e) { serverError(res, e, 'git status'); }
});

// GET /api/playbooks-git/log
router.get('/log', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  try { res.json(await gitSync.getLog({ page, limit })); }
  catch (e) { serverError(res, e, 'git log'); }
});

// POST /api/playbooks-git/pull
router.post('/pull', async (req, res) => {
  try {
    const r = await gitSync.pull();
    if (!r.success) return res.status(500).json({ error: r.stderr });
    res.json({ success: true, output: r.stdout });
  } catch (e) { serverError(res, e, 'git pull'); }
});

// POST /api/playbooks-git/commit
router.post('/commit', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  if (message.length > 500) return res.status(400).json({ error: 'message too long' });
  try {
    const r = await gitSync.commit(message);
    if (!r.success) return res.status(400).json({ error: r.stderr || 'Nothing to commit' });
    res.json({ success: true, output: r.stdout });
  } catch (e) { serverError(res, e, 'git commit'); }
});

// POST /api/playbooks-git/push
router.post('/push', async (req, res) => {
  const { message } = req.body || {};
  try {
    const r = await gitSync.push(message);
    if (!r.success) return res.status(500).json({ error: r.stderr });
    res.json({ success: true, output: r.stdout });
  } catch (e) { serverError(res, e, 'git push'); }
});

module.exports = router;
