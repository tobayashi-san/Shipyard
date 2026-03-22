/**
 * Git synchronization service for the playbooks directory.
 * Handles auth (SSH via existing key, HTTPS via stored token),
 * auto-pull before runs, and auto-push after saves.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const db = require('../db');
const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');

// Path to temp SSH key file – written once, reused, cleaned on exit
let _tmpKeyPath = null;

function getConfig() {
  const g = (k) => db.settings.get(k) || '';
  return {
    repoUrl:   g('git_repo_url'),
    authToken: g('git_auth_token'),
    autoPull:  db.settings.get('git_auto_pull') !== '0',
    autoPush:  db.settings.get('git_auto_push') !== '0',
    userName:  g('git_user_name')  || 'Shipyard',
    userEmail: g('git_user_email') || 'shipyard@localhost',
  };
}

function isConfigured() {
  return !!db.settings.get('git_repo_url');
}

function buildAuthUrl(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      u.username = 'oauth2';
      u.password = token;
      return u.toString();
    }
  } catch {}
  return url;
}

async function getTmpKeyPath() {
  if (_tmpKeyPath && fs.existsSync(_tmpKeyPath)) return _tmpKeyPath;
  try {
    const sshManager = require('./ssh-manager');
    const keyContent = sshManager.getPrivateKey();
    const tmpPath = path.join(os.tmpdir(), '.shipyard_git_key');
    fs.writeFileSync(tmpPath, keyContent, { mode: 0o600 });
    _tmpKeyPath = tmpPath;
    return tmpPath;
  } catch {
    return null;
  }
}

async function buildEnv(repoUrl) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    HOME: process.env.HOME || os.homedir(),
  };
  if (/^(git@|ssh:\/\/)/.test(repoUrl)) {
    const keyPath = await getTmpKeyPath();
    if (keyPath) {
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes`;
    }
  }
  return env;
}

async function runGit(args) {
  const cfg = getConfig();
  const env = await buildEnv(cfg.repoUrl);
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: PLAYBOOKS_DIR,
      env,
      timeout: 30000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), success: true };
  } catch (err) {
    return { stdout: '', stderr: err.stderr?.trim() || err.message, success: false };
  }
}

async function isGitRepo() {
  // Must be a git root directly in PLAYBOOKS_DIR, not inherited from a parent repo
  return fs.existsSync(path.join(PLAYBOOKS_DIR, '.git'));
}

async function applyGitIdentity() {
  const cfg = getConfig();
  await runGit(['config', 'user.name',  cfg.userName]);
  await runGit(['config', 'user.email', cfg.userEmail]);
}

async function setRemote(url) {
  let r = await runGit(['remote', 'set-url', 'origin', url]);
  if (!r.success) r = await runGit(['remote', 'add', 'origin', url]);
  return r;
}

// ── Public API ────────────────────────────────────────────────

async function getStatus() {
  if (!await isGitRepo()) return { initialized: false };

  const [branchRes, remoteRes, statusRes] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['remote', 'get-url', 'origin']),
    runGit(['status', '--porcelain']),
  ]);

  const changed = (statusRes.stdout || '').split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3),
  }));

  const cfg = getConfig();
  return {
    initialized: true,
    configured: isConfigured(),
    branch: branchRes.stdout || 'main',
    remote: remoteRes.success ? remoteRes.stdout : '',
    changed,
    autoPull: cfg.autoPull,
    autoPush: cfg.autoPush,
  };
}

async function getLog() {
  if (!await isGitRepo()) return [];
  const r = await runGit(['log', '--oneline', '-20', '--format=%H|%s|%an|%ar']);
  if (!r.success) return [];
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [hash, message, author, date] = line.split('|');
    return { hash: (hash || '').slice(0, 8), message, author, date };
  });
}

async function pull() {
  const cfg = getConfig();
  if (!cfg.repoUrl) return { success: false, stderr: 'No repository configured' };
  if (!await isGitRepo()) return { success: false, stderr: 'Playbooks directory is not a git repository' };

  await applyGitIdentity();
  const authUrl = cfg.authToken ? buildAuthUrl(cfg.repoUrl, cfg.authToken) : cfg.repoUrl;
  await setRemote(authUrl);

  const r = await runGit(['pull', '--rebase', 'origin', 'HEAD']);
  return r;
}

async function commit(message) {
  if (!message || typeof message !== 'string') return { success: false, stderr: 'Commit message required' };
  await applyGitIdentity();
  await runGit(['add', '-A']);
  return runGit(['commit', '-m', message]);
}

async function push() {
  const cfg = getConfig();
  if (!cfg.repoUrl) return { success: false, stderr: 'No repository configured' };
  await applyGitIdentity();
  const authUrl = cfg.authToken ? buildAuthUrl(cfg.repoUrl, cfg.authToken) : cfg.repoUrl;
  await setRemote(authUrl);
  return runGit(['push', 'origin', 'HEAD']);
}

/**
 * Auto-pull before a job run (no-op if disabled or not configured).
 */
async function autoPull() {
  const cfg = getConfig();
  if (!cfg.autoPull || !cfg.repoUrl) return;
  try {
    const r = await pull();
    if (!r.success) console.warn('[Git] Auto-pull failed:', r.stderr);
    else console.log('[Git] Auto-pull complete:', r.stdout || 'up to date');
  } catch (e) {
    console.warn('[Git] Auto-pull error:', e.message);
  }
}

/**
 * Auto-commit + push after saving a playbook (no-op if disabled).
 */
async function autoPush(message = 'Update playbooks') {
  const cfg = getConfig();
  if (!cfg.autoPush || !cfg.repoUrl) return;
  if (!await isGitRepo()) return;

  try {
    const status = await runGit(['status', '--porcelain']);
    if (!status.stdout) return; // nothing changed

    await applyGitIdentity();
    await runGit(['add', '-A']);
    const cr = await runGit(['commit', '-m', message]);
    if (!cr.success && !cr.stderr.includes('nothing to commit')) {
      console.warn('[Git] Auto-commit failed:', cr.stderr);
      return;
    }

    const authUrl = cfg.authToken ? buildAuthUrl(cfg.repoUrl, cfg.authToken) : cfg.repoUrl;
    await setRemote(authUrl);
    const pr = await runGit(['push', 'origin', 'HEAD']);
    if (!pr.success) console.warn('[Git] Auto-push failed:', pr.stderr);
    else console.log('[Git] Auto-push complete');
  } catch (e) {
    console.warn('[Git] Auto-push error:', e.message);
  }
}

/**
 * First-time setup: save config, init repo, set remote, initial pull.
 */
async function setup({ repoUrl, authToken, autoPull: ap, autoPush: ap2, userName, userEmail }) {
  if (!repoUrl) return { success: false, error: 'repoUrl required' };

  db.settings.set('git_repo_url',   repoUrl);
  db.settings.set('git_auth_token', authToken || '');
  db.settings.set('git_auto_pull',  ap !== false ? '1' : '0');
  db.settings.set('git_auto_push',  ap2 !== false ? '1' : '0');
  db.settings.set('git_user_name',  userName  || 'Shipyard');
  db.settings.set('git_user_email', userEmail || 'shipyard@localhost');

  if (!await isGitRepo()) {
    const r = await runGit(['init']);
    if (!r.success) return { success: false, error: r.stderr };

    const gitignore = path.join(PLAYBOOKS_DIR, '.gitignore');
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*.bak.*\n');
  }

  await applyGitIdentity();

  const authUrl = authToken ? buildAuthUrl(repoUrl, authToken) : repoUrl;
  const remoteR = await setRemote(authUrl);
  if (!remoteR.success) return { success: false, error: remoteR.stderr };

  // Initial pull — OK to fail (empty repo, new branch, etc.)
  const pullR = await runGit(['pull', '--rebase', 'origin', 'HEAD']);
  return {
    success: true,
    pullOutput: pullR.stdout || (pullR.success ? 'up to date' : pullR.stderr),
  };
}

// Cleanup temp key on process exit
process.on('exit', () => {
  if (_tmpKeyPath) {
    try { fs.unlinkSync(_tmpKeyPath); } catch {}
  }
});

module.exports = { getConfig, isConfigured, getStatus, getLog, pull, commit, push, autoPull, autoPush, setup };
