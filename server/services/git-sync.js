/**
 * Git synchronization service for the playbooks directory.
 *
 * Layout in the remote repo:
 *   playbooks/   ← synced from/to server/playbooks/
 *   tofu/        ← can be added later manually
 *
 * The local git workspace lives at server/git-workspace/.
 * The runtime playbook files stay in server/playbooks/ as before.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const db = require('../db');

// Runtime playbooks (read/written by the server at runtime)
const PLAYBOOKS_DIR = path.resolve(path.join(__dirname, '..', 'playbooks'));

// Dedicated git workspace – NOT inside the lab_manager repo
const GIT_WORKSPACE_DIR = path.resolve(path.join(__dirname, '..', 'git-workspace'));

// Subdirectory inside the workspace that contains the playbooks
const PLAYBOOKS_SUBDIR = 'playbooks';

// Path to temp SSH key file – written once, reused, cleaned on exit
let _tmpKeyPath = null;

// ── Config ────────────────────────────────────────────────────

function getConfig() {
  const g = (k) => db.settings.get(k) || '';
  return {
    repoUrl:   g('git_repo_url'),
    authToken: g('git_auth_token'),
    autoPull:  db.settings.get('git_auto_pull') !== '0',
    autoPush:  db.settings.get('git_auto_push') !== '0',
    userName:  g('git_user_name')  || 'Shipyard',
    userEmail: g('git_user_email') || 'shipyard@localhost',
    branch:    g('git_branch')     || 'main',
  };
}

function isConfigured() {
  return !!db.settings.get('git_repo_url');
}

// ── Helpers ───────────────────────────────────────────────────

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
      cwd: GIT_WORKSPACE_DIR,
      env,
      timeout: 30000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), success: true };
  } catch (err) {
    return { stdout: '', stderr: err.stderr?.trim() || err.message, success: false };
  }
}

// The workspace is a git repo if it has its own .git directory
async function isGitRepo() {
  return fs.existsSync(path.join(GIT_WORKSPACE_DIR, '.git'));
}

function ensureWorkspaceDirs() {
  if (!fs.existsSync(GIT_WORKSPACE_DIR)) {
    fs.mkdirSync(GIT_WORKSPACE_DIR, { recursive: true });
  }
  const pbDir = path.join(GIT_WORKSPACE_DIR, PLAYBOOKS_SUBDIR);
  if (!fs.existsSync(pbDir)) {
    fs.mkdirSync(pbDir, { recursive: true });
  }
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

// ── Sync between server/playbooks/ and git-workspace/playbooks/ ──

/**
 * Copy *.yml / *.yaml from server/playbooks/ into git-workspace/playbooks/.
 * Called before commit/push.
 */
function syncToWorkspace() {
  ensureWorkspaceDirs();
  const destDir = path.join(GIT_WORKSPACE_DIR, PLAYBOOKS_SUBDIR);
  const sourceFiles = new Set(
    fs.readdirSync(PLAYBOOKS_DIR)
      .filter(f => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.includes('.bak.'))
  );
  // Copy new/updated files
  for (const f of sourceFiles) {
    fs.copyFileSync(path.join(PLAYBOOKS_DIR, f), path.join(destDir, f));
  }
  // Remove files from workspace that no longer exist in server/playbooks/
  const destFiles = fs.readdirSync(destDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  for (const f of destFiles) {
    if (!sourceFiles.has(f)) fs.unlinkSync(path.join(destDir, f));
  }
}

/**
 * Copy *.yml / *.yaml from git-workspace/playbooks/ into server/playbooks/.
 * Called after pull.
 */
function syncFromWorkspace() {
  const srcDir = path.join(GIT_WORKSPACE_DIR, PLAYBOOKS_SUBDIR);
  if (!fs.existsSync(srcDir)) return;
  const files = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(PLAYBOOKS_DIR, f));
  }
}

// ── Public API ────────────────────────────────────────────────

async function getStatus() {
  if (!await isGitRepo()) return { initialized: false };

  const cfg = getConfig();
  const [branchRes, statusRes] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['status', '--porcelain']),
  ]);

  const changed = (statusRes.stdout || '').split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3),
  }));

  return {
    initialized: true,
    configured: isConfigured(),
    branch: branchRes.stdout || 'main',
    remote: cfg.repoUrl, // never expose token
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

async function getBranches() {
  if (!await isGitRepo()) return { local: [], remote: [] };
  const [localR, remoteR] = await Promise.all([
    runGit(['branch', '--format=%(refname:short)']),
    runGit(['branch', '-r', '--format=%(refname:short)']),
  ]);
  const local = localR.stdout.split('\n').filter(Boolean);
  const remote = remoteR.stdout.split('\n').filter(Boolean)
    .map(b => b.replace(/^origin\//, ''))
    .filter(b => b !== 'HEAD');
  return { local, remote };
}

async function checkout(branch) {
  if (!branch || typeof branch !== 'string') return { success: false, stderr: 'Branch name required' };
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) return { success: false, stderr: 'Invalid branch name' };

  // Try existing local branch first
  let r = await runGit(['checkout', branch]);
  if (!r.success) {
    // Try to create tracking branch from remote
    r = await runGit(['checkout', '-b', branch, `origin/${branch}`]);
    if (!r.success) {
      // Create new local branch
      r = await runGit(['checkout', '-b', branch]);
    }
  }
  if (r.success) {
    db.settings.set('git_branch', branch);
    syncFromWorkspace();
  }
  return r;
}

async function pull() {
  const cfg = getConfig();
  if (!cfg.repoUrl) return { success: false, stderr: 'No repository configured' };
  if (!await isGitRepo()) return { success: false, stderr: 'Git workspace not initialized – run setup first' };

  await applyGitIdentity();
  const authUrl = cfg.authToken ? buildAuthUrl(cfg.repoUrl, cfg.authToken) : cfg.repoUrl;
  await setRemote(authUrl);

  const r = await runGit(['pull', '--rebase', 'origin', cfg.branch]);
  if (r.success) syncFromWorkspace();
  return r;
}

async function commit(message) {
  if (!message || typeof message !== 'string') return { success: false, stderr: 'Commit message required' };
  syncToWorkspace();
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
  return runGit(['push', 'origin', `HEAD:${cfg.branch}`]);
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
    syncToWorkspace();

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
    const pr = await runGit(['push', 'origin', `HEAD:${cfg.branch}`]);
    if (!pr.success) console.warn('[Git] Auto-push failed:', pr.stderr);
    else console.log('[Git] Auto-push complete');
  } catch (e) {
    console.warn('[Git] Auto-push error:', e.message);
  }
}

/**
 * First-time setup: save config, init workspace, set remote, initial pull.
 */
async function setup({ repoUrl, authToken, autoPull: ap, autoPush: ap2, userName, userEmail, branch }) {
  if (!repoUrl) return { success: false, error: 'repoUrl required' };
  const targetBranch = (branch || 'main').trim();

  db.settings.set('git_repo_url',   repoUrl);
  db.settings.set('git_auth_token', authToken || '');
  db.settings.set('git_auto_pull',  ap  !== false ? '1' : '0');
  db.settings.set('git_auto_push',  ap2 !== false ? '1' : '0');
  db.settings.set('git_user_name',  userName  || 'Shipyard');
  db.settings.set('git_user_email', userEmail || 'shipyard@localhost');
  db.settings.set('git_branch',     targetBranch);

  ensureWorkspaceDirs();

  if (!await isGitRepo()) {
    // Try modern -b flag first, fall back for git < 2.28
    let r = await runGit(['init', '-b', targetBranch]);
    if (!r.success) {
      r = await runGit(['init']);
      if (!r.success) return { success: false, error: r.stderr };
      await runGit(['symbolic-ref', 'HEAD', `refs/heads/${targetBranch}`]);
    }

    const gitignore = path.join(GIT_WORKSPACE_DIR, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, '*.bak.*\n');
    }
  }

  await applyGitIdentity();

  const authUrl = authToken ? buildAuthUrl(repoUrl, authToken) : repoUrl;
  const remoteR = await setRemote(authUrl);
  if (!remoteR.success) return { success: false, error: remoteR.stderr };

  // Copy existing playbooks into the workspace before pulling
  syncToWorkspace();

  // Fetch remote branches so we can switch to the right one
  await runGit(['fetch', 'origin']);

  // Checkout the target branch (creates tracking branch if remote exists)
  await checkout(targetBranch);

  // Initial pull – OK to fail (empty repo, etc.)
  const pullR = await runGit(['pull', '--rebase', 'origin', targetBranch]);
  if (pullR.success) syncFromWorkspace();

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

module.exports = { getConfig, isConfigured, getStatus, getLog, getBranches, checkout, pull, commit, push, autoPull, autoPush, setup };
