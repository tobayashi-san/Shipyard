/**
 * Git synchronization service for the playbooks directory.
 *
 * Layout in the remote repo:
 *   playbooks/   ← synced from/to server/playbooks/
 *   tofu/        ← can be added later manually
 *
 * The local git workspace lives at server/data/git-workspace/ (inside the persistent volume).
 * The runtime playbook files stay in server/playbooks/ as before.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const log = require('../utils/logger').child('git');

const db = require('../db');
const { getSecret, setSecret } = require('../utils/crypto');

// Runtime playbooks (read/written by the server at runtime)
const PLAYBOOKS_DIR = path.resolve(process.env.SHIPYARD_PLAYBOOKS_DIR || path.join(__dirname, '..', 'playbooks'));

// Dedicated git workspace – inside the persistent data volume so the shipyard user can write to it
const GIT_WORKSPACE_DIR = path.resolve(process.env.SHIPYARD_GIT_WORKSPACE_DIR || path.join(__dirname, '..', 'data', 'git-workspace'));

// Subdirectory inside the workspace that contains the playbooks
const PLAYBOOKS_SUBDIR = 'playbooks';

// Path to temp SSH key file – written once, reused, cleaned on exit
let _tmpKeyPath = null;

function clearTmpKey() {
  if (!_tmpKeyPath) return;
  try { fs.unlinkSync(_tmpKeyPath); } catch {}
  _tmpKeyPath = null;
}

// Plugins can register sync hooks that run before every push/status check
const _syncHooks = [];
function registerSyncHook(fn) { _syncHooks.push(fn); }
function runSyncHooks() { for (const fn of _syncHooks) { try { fn(); } catch {} } }

// ── Config ────────────────────────────────────────────────────

function getConfig() {
  const g = (k) => db.settings.get(k) || '';
  return {
    repoUrl:   g('git_repo_url'),
    authToken: getSecret(db, 'git_auth_token') || '',
    sshKey:    getSecret(db, 'git_ssh_key') || '',
    autoPull:  db.settings.get('git_auto_pull') !== '0',
    autoPush:  db.settings.get('git_auto_push') === '1' && db.settings.get('git_read_only') !== '1',
    readOnly:  db.settings.get('git_read_only') === '1',
    userName:  g('git_user_name')  || 'Shipyard',
    userEmail: g('git_user_email') || 'shipyard@localhost',
    branch:    g('git_branch')     || 'main',
  };
}

function isConfigured() {
  return !!db.settings.get('git_repo_url');
}

function isSshRemote(url) {
  return /^(?:ssh:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:)/.test(String(url || '').trim());
}

function validateCredentials(repoUrl, authToken = '', sshKey = '') {
  if (typeof authToken !== 'string' || typeof sshKey !== 'string' || authToken.length > 8192 || sshKey.length > 32768) {
    return { ok: false, error: 'Provide text credentials within the allowed size (token: 8192, SSH key: 32768 characters).' };
  }
  if (authToken.trim() && sshKey.trim()) return { ok: false, error: 'Provide only one credential method.' };
  const remote = String(repoUrl || '').trim();
  if (remote && authToken.trim() && !/^https?:\/\//.test(remote)) return { ok: false, error: 'HTTPS tokens require an HTTP(S) repository URL.' };
  if (remote && sshKey.trim() && !isSshRemote(remote)) return { ok: false, error: 'SSH keys require an SSH repository URL.' };
  return { ok: true };
}

function updateCredentials({ mode, authToken, sshKey }) {
  if (mode !== 'https' && mode !== 'ssh') throw new Error('Credential mode must be https or ssh.');
  for (const [field, value] of [['authToken', authToken], ['sshKey', sshKey]]) {
    if (value !== undefined && typeof value !== 'string') throw new Error(`${field} must be text.`);
  }
  if ((mode === 'https' && sshKey?.trim()) || (mode === 'ssh' && authToken?.trim())) {
    throw new Error('Submit only credentials for the selected authentication method.');
  }
  const current = getConfig();
  if (current.repoUrl && (mode === 'ssh' ? !isSshRemote(current.repoUrl) : !/^https?:\/\//.test(current.repoUrl))) {
    throw new Error('Credential method does not match the repository URL. Configure a matching remote URL before changing authentication transport.');
  }
  const validation = validateCredentials(current.repoUrl, authToken, sshKey);
  if (!validation.ok) throw new Error(validation.error);
  if (mode === 'https') {
    const nextToken = String(authToken || '').trim() || current.authToken;
    if (!nextToken) throw new Error('An HTTPS token is required.');
    setSecret(db, 'git_auth_token', nextToken);
    setSecret(db, 'git_ssh_key', '');
  } else {
    const nextKey = String(sshKey || '').trim() || current.sshKey;
    if (!nextKey) throw new Error('An SSH private key is required.');
    setSecret(db, 'git_ssh_key', nextKey);
    setSecret(db, 'git_auth_token', '');
  }
  clearTmpKey();
}

// ── Validation ────────────────────────────────────────────────

/**
 * Validate a git remote URL. Accepts:
 *   - https://host/path  http://host/path
 *   - ssh://[user@]host[:port]/path
 *   - user@host:path  (SCP-like)
 *
 * Rejects file://, leading "-" anywhere in URL or hostname (CVE-2017-1000117 class),
 * embedded credentials in https URLs (use authToken setting instead), control chars,
 * whitespace, and unknown schemes.
 *
 * Returns { ok: true } on success or { ok: false, error: '...' }.
 */
function validateGitUrl(url) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'repoUrl required' };
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'repoUrl required' };
  if (trimmed.length > 2048) return { ok: false, error: 'repoUrl too long' };
  // No control chars or whitespace
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, error: 'repoUrl contains invalid characters' };
  // Defuse argument-injection: never accept anything that starts with "-"
  if (trimmed.startsWith('-')) return { ok: false, error: 'repoUrl must not start with "-"' };

  // SCP-like: user@host:path  (host must not start with "-")
  const scp = /^([A-Za-z0-9_.\-]+)@([A-Za-z0-9.\-]+):([A-Za-z0-9_./\-~]*)$/;
  const scpMatch = trimmed.match(scp);
  if (scpMatch) {
    const host = scpMatch[2];
    if (host.startsWith('-')) return { ok: false, error: 'host must not start with "-"' };
    return { ok: true };
  }

  // URL form
  let u;
  try { u = new URL(trimmed); }
  catch { return { ok: false, error: 'Invalid git URL' }; }

  const allowedSchemes = new Set(['https:', 'http:', 'ssh:', 'git:']);
  if (!allowedSchemes.has(u.protocol)) {
    return { ok: false, error: `Unsupported URL scheme: ${u.protocol}` };
  }
  if (!u.hostname) return { ok: false, error: 'URL missing hostname' };
  if (u.protocol === 'ssh:' && (u.password || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test((u.username || 'git')) || u.hostname.includes('%'))) return { ok: false, error: 'Invalid SSH user or hostname' };
  if (u.hostname.startsWith('-')) return { ok: false, error: 'host must not start with "-"' };
  // Reject userinfo in https URLs to prevent token leaking via getStatus()/logs
  if ((u.protocol === 'https:' || u.protocol === 'http:') && (u.username || u.password)) {
    return { ok: false, error: 'embed credentials via authToken, not in URL' };
  }
  return { ok: true };
}

/**
 * Validate a git branch / ref name. Conservative subset of git's rules:
 * alphanumerics, dot, underscore, slash, hyphen. Cannot start with "-" or ".",
 * cannot contain "..", cannot end with ".lock" or "/".
 */
function validateBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 200) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) return false;
  if (name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.startsWith('refs/') || name.includes('@{') || name.includes('//')) return false;
  if (name.includes('..')) return false;
  return true;
}

function remoteBranchRef(branch) {
  return `refs/remotes/origin/${branch}`;
}

// ── Helpers ───────────────────────────────────────────────────

async function getTmpKeyPath() {
  if (_tmpKeyPath && fs.existsSync(_tmpKeyPath)) return _tmpKeyPath;
  try {
    const crypto = require('crypto');
    const configuredKey = getConfig().sshKey;
    const keyContent = configuredKey || require('./ssh-manager').getPrivateKey();
    const tmpPath = path.join(os.tmpdir(), `.shipyard_git_key_${crypto.randomUUID()}`);
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
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    HOME: process.env.HOME || os.homedir(),
  };
  const token = getConfig().authToken;
  if (/^https?:\/\//.test(repoUrl || '') && token) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_1 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from('oauth2:' + token).toString('base64')}`;
  }
  if (isSshRemote(repoUrl)) {
    const keyPath = await getTmpKeyPath();
    if (keyPath) {
      env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
    }
  }
  return env;
}

async function runGit(args, raw = false) {
  const cfg = getConfig();
  const env = await buildEnv(cfg.repoUrl);
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: GIT_WORKSPACE_DIR,
      env,
      timeout: 30000,
    });
    return { stdout: raw ? stdout : stdout.trim(), stderr: stderr.trim(), success: true };
  } catch (err) {
    return { stdout: '', stderr: err.stderr?.trim() || err.message, success: false, exitCode: err.code };
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
async function trackedPlaybooks() {
  const result = await runGit(['ls-files', '-z', '--', `${PLAYBOOKS_SUBDIR}/`], true);
  if (!result.success) throw new Error('Tracked playbooks could not be read.');
  return result.stdout.split('\0').filter(Boolean).map(file => file.slice(PLAYBOOKS_SUBDIR.length + 1))
    .filter(file => !file.includes('/') && /\.ya?ml$/.test(file) && !file.includes('.bak.'));
}

function syncFromWorkspace(previousFiles = []) {
  const srcDir = path.join(GIT_WORKSPACE_DIR, PLAYBOOKS_SUBDIR);
  const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml')) : [];
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(PLAYBOOKS_DIR, f));
  }
  const retained = new Set(files);
  for (const file of previousFiles) {
    if (!retained.has(file)) fs.rmSync(path.join(PLAYBOOKS_DIR, file), { force: true });
  }
}

// ── Public API ────────────────────────────────────────────────

async function inspectConflicts() {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], true);
  if (!result.success) throw new Error('Git conflict status could not be read');
  return result.stdout.split('\0').filter(Boolean);
}

async function requireNoConflicts() {
  const conflicts = await inspectConflicts();
  return conflicts.length
    ? { success: false, code: 'MERGE_CONFLICT', stderr: 'Unresolved merge conflicts. Resolve or abort the merge in the Git workspace before synchronizing; no conflict files were overwritten.', conflicts }
    : { success: true };
}

async function getStatus() {
  if (!await isGitRepo()) return { initialized: false };

  const conflicts = await inspectConflicts();
  // Preserve conflict markers and index stages until an operator resolves them.
  if (!conflicts.length) {
    runSyncHooks();
    syncToWorkspace();
  }

  const cfg = getConfig();
  const [branchRes, statusRes, revisionRes] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['status', '--porcelain=v1', '-z', '--no-renames'], true),
    runGit(['rev-parse', '--verify', 'HEAD']),
  ]);

  if (!branchRes.success || !statusRes.success) throw new Error('Git working-copy status could not be read.');

  const changed = (statusRes.stdout || '').split('\0').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3),
  }));

  let comparison = { state: 'unavailable', ahead: null, behind: null };
  if (revisionRes.success && validateBranchName(cfg.branch) && db.settings.get('git_last_fetch_repo') === cfg.repoUrl) {
    const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remoteBranchRef(cfg.branch)}`, '--']);
    if (counts.success && /^\d+\s+\d+$/.test(counts.stdout.trim())) {
      const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
      comparison = { state: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'aligned', ahead, behind };
    }
  }

  return {
    initialized: true,
    configured: isConfigured(),
    branch: branchRes.stdout || 'Detached HEAD',
    remote: cfg.repoUrl, // never expose token
    changed,
    conflicts,
    comparison,
    lastFetchAt: db.settings.get('git_last_fetch_at') || null,
    revision: revisionRes.success ? revisionRes.stdout : null,
    lastPullAt: db.settings.get('git_last_pull_at') || null,
    autoPull: cfg.autoPull,
    autoPush: cfg.autoPush,
    readOnly: cfg.readOnly,
  };
}

async function getLog({ page = 1, limit = 10 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const empty = {
    items: [],
    pagination: {
      page: 1,
      limit: safeLimit,
      total: 0,
      total_pages: 1,
      has_prev: false,
      has_next: false,
    },
  };

  if (!await isGitRepo()) return empty;

  const totalResult = await runGit(['rev-list', '--count', 'HEAD']);
  if (!totalResult.success) {
    const head = await runGit(['symbolic-ref', '-q', 'HEAD']);
    if (head.success && head.stdout.startsWith('refs/heads/')) {
      const ref = await runGit(['show-ref', '--verify', '--quiet', head.stdout]);
      if (ref.exitCode === 1) return empty; // Valid unborn branch, with no commits yet.
    }
    throw new Error('Git commit history could not be counted. Check the local repository.');
  }
  const total = Math.max(0, parseInt(totalResult.stdout, 10) || 0);
  if (!total) return empty;

  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, totalPages);
  const skip = (currentPage - 1) * safeLimit;
  const r = await runGit(['log', `-${safeLimit}`, `--skip=${skip}`, '--format=%H%x00%s%x00%an%x00%aI']);
  if (!r.success) throw new Error('Git commit history could not be read. Check the local repository.');

  const items = r.stdout.split('\n').filter(Boolean).map(line => {
    const [hash, message, author, date] = line.split('\0');
    return { hash: (hash || '').slice(0, 8), message, author, date };
  });

  return {
    items,
    pagination: {
      page: currentPage,
      limit: safeLimit,
      total,
      total_pages: totalPages,
      has_prev: currentPage > 1,
      has_next: currentPage < totalPages,
    },
  };
}

async function getBranches() {
  if (!await isGitRepo()) return { local: [], remote: [] };
  const [localR, remoteR] = await Promise.all([
    runGit(['branch', '--format=%(refname:short)']),
    runGit(['branch', '-r', '--format=%(refname:short)']),
  ]);
  if (!localR.success || !remoteR.success) throw new Error('Git branches could not be read.');
  const local = localR.stdout.split('\n').filter(Boolean);
  const remote = remoteR.stdout.split('\n').filter(Boolean)
    .map(b => b.replace(/^origin\//, ''))
    .filter(b => b !== 'HEAD');
  return { local, remote };
}

async function requireCleanWorkspace() {
  const safe = await requireNoConflicts();
  if (!safe.success) return safe;
  runSyncHooks();
  syncToWorkspace();
  const status = await runGit(['status', '--porcelain']);
  if (!status.success) return status;
  return status.stdout
    ? { success: false, stderr: 'Local changes are present. Commit and push or resolve them before pulling or switching branches; no files were discarded.' }
    : { success: true };
}

async function checkout(branch) {
  if (!validateBranchName(branch)) return { success: false, stderr: 'Invalid branch name' };

  const clean = await requireCleanWorkspace();
  if (!clean.success) return clean;

  const previousFiles = await trackedPlaybooks();

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
    syncFromWorkspace(previousFiles);
  }
  return r;
}

async function clearConnectionArtifacts() {
  if (await isGitRepo()) {
    const existing = await runGit(['config', '--local', '--get-regexp', '^remote\\.origin\\.']);
    if (existing.success) {
      const removed = await runGit(['config', '--local', '--remove-section', 'remote.origin']);
      if (!removed.success) throw new Error('Local Git connection could not be removed.');
    } else if (existing.exitCode !== 1) {
      throw new Error('Local Git connection could not be inspected.');
    }
  }
  clearTmpKey();
}

async function fetchRemote(cfg = getConfig()) {
  if (!cfg.repoUrl) return { success: false, stderr: 'No repository configured' };
  if (!validateBranchName(cfg.branch)) return { success: false, stderr: 'Invalid configured branch name' };
  if (!await isGitRepo()) return { success: false, stderr: 'Git workspace not initialized – run setup first' };

  const authUrl = cfg.repoUrl;
  const remoteResult = await setRemote(authUrl);
  if (!remoteResult.success) return { success: false, stderr: 'Git remote configuration could not be updated.' };

  // Fetch from remote
  const fetchR = await runGit(['fetch', '--prune', 'origin']);
  if (!fetchR.success) return fetchR;
  db.settings.set('git_last_fetch_at', new Date().toISOString());
  db.settings.set('git_last_fetch_repo', cfg.repoUrl);

  return { success: true, stdout: fetchR.stdout };
}

async function pull() {
  const cfg = getConfig();
  const fetched = await fetchRemote(cfg);
  if (!fetched.success) return fetched;
  await applyGitIdentity();

  // Keep local files and commits intact. Only a clean fast-forward is allowed.
  const clean = await requireCleanWorkspace();
  if (!clean.success) return clean;
  const previousFiles = await trackedPlaybooks();
  const mergeR = await runGit(['merge', '--ff-only', remoteBranchRef(cfg.branch)]);
  if (!mergeR.success) return { ...mergeR, stderr: 'Cannot fast-forward. Resolve branch divergence before pulling. ' + mergeR.stderr };
  syncFromWorkspace(previousFiles);
  db.settings.set('git_last_pull_at', new Date().toISOString());
  return { success: true, stdout: mergeR.stdout };
}

async function commit(message) {
  if (!message || typeof message !== 'string') return { success: false, stderr: 'Commit message required' };
  const safe = await requireNoConflicts();
  if (!safe.success) return safe;
  syncToWorkspace();
  await applyGitIdentity();
  await runGit(['add', '-A']);
  return runGit(['commit', '-m', message]);
}

async function push(message) {
  const cfg = getConfig();
  if (cfg.readOnly) return { success: false, code: 'READ_ONLY', stderr: 'Remote read-only mode is enabled. Publishing commits is disabled.' };
  if (!cfg.repoUrl) return { success: false, stderr: 'No repository configured' };
  if (!validateBranchName(cfg.branch)) return { success: false, stderr: 'Invalid configured branch name' };

  await applyGitIdentity();

  const safe = await requireNoConflicts();
  if (!safe.success) return safe;

  // Auto-commit any pending changes before pushing
  runSyncHooks();
  syncToWorkspace();
  await runGit(['add', '-A']);
  const statusR = await runGit(['status', '--porcelain']);
  if (statusR.stdout) {
    const msg = (message && typeof message === 'string') ? message : 'Update playbooks';
    await runGit(['commit', '-m', msg]);
  }

  // Check that at least one commit exists
  const headCheck = await runGit(['rev-parse', 'HEAD']);
  if (!headCheck.success) return { success: false, stderr: 'Nothing to push — no commits in workspace.' };

  const authUrl = cfg.repoUrl;
  const remoteResult = await setRemote(authUrl);
  if (!remoteResult.success) return { success: false, stderr: 'Git remote configuration could not be updated.' };
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
    if (!r.success) log.warn({ stderr: r.stderr }, 'Auto-pull failed');
    else log.info({ stdout: r.stdout || 'up to date' }, 'Auto-pull complete');
  } catch (e) {
    log.warn({ err: e }, 'Auto-pull error');
  }
}

/**
 * Auto-commit + push after saving a playbook (no-op if disabled).
 */
async function autoPush(message = 'Update playbooks') {
  const cfg = getConfig();
  if (!cfg.autoPush || !cfg.repoUrl) return;
  if (!validateBranchName(cfg.branch)) return;
  if (!await isGitRepo()) return;

  try {
    const safe = await requireNoConflicts();
    if (!safe.success) { log.warn({ stderr: safe.stderr }, 'Auto-push blocked'); return; }
    syncToWorkspace();

    const status = await runGit(['status', '--porcelain']);
    if (!status.stdout) return; // nothing changed

    await applyGitIdentity();
    await runGit(['add', '-A']);
    const cr = await runGit(['commit', '-m', message]);
    if (!cr.success && !cr.stderr.includes('nothing to commit')) {
      log.warn({ stderr: cr.stderr }, 'Auto-commit failed');
      return;
    }

    const authUrl = cfg.repoUrl;
    const remoteResult = await setRemote(authUrl);
    if (!remoteResult.success) throw new Error('Git remote configuration could not be updated.');
    const pr = await runGit(['push', 'origin', `HEAD:${cfg.branch}`]);
    if (!pr.success) log.warn({ stderr: pr.stderr }, 'Auto-push failed');
    else log.info('Auto-push complete');
  } catch (e) {
    log.warn({ err: e }, 'Auto-push error');
  }
}

/**
 * First-time setup: save config, init workspace, set remote, initial pull.
 */
async function setup({ repoUrl, authToken, sshKey, autoPull: ap, autoPush: ap2, readOnly = true, userName, userEmail, branch }) {
  const urlCheck = validateGitUrl(repoUrl);
  if (!urlCheck.ok) return { success: false, error: urlCheck.error };
  const credentials = validateCredentials(repoUrl, authToken, sshKey);
  if (!credentials.ok) return { success: false, error: credentials.error };
  const targetBranch = (branch || 'main').trim();
  if (!validateBranchName(targetBranch)) return { success: false, error: 'Invalid branch name' };

  db.settings.set('git_last_fetch_at', '');
  db.settings.set('git_last_fetch_repo', '');
  db.settings.set('git_repo_url',   repoUrl);
  setSecret(db, 'git_auth_token', authToken || '');
  setSecret(db, 'git_ssh_key', sshKey || '');
  clearTmpKey();
  db.settings.set('git_auto_pull',  ap  !== false ? '1' : '0');
  db.settings.set('git_auto_push',  ap2 === true && !readOnly ? '1' : '0');
  db.settings.set('git_read_only', readOnly ? '1' : '0');
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

  const authUrl = repoUrl;
  const remoteR = await setRemote(authUrl);
  if (!remoteR.success) return { success: false, error: remoteR.stderr };

  // Copy existing playbooks into the workspace before pulling
  syncToWorkspace();

  // Fetch remote branches so we can switch to the right one. Keep this command
  // free of user-controlled refspecs; checkout/rebase use local refs below.
  const fetchR = await runGit(['fetch', '--prune', 'origin']);

  if (fetchR.success) {
    db.settings.set('git_last_fetch_at', new Date().toISOString());
    db.settings.set('git_last_fetch_repo', repoUrl);
  }

  // Initial synchronization can be blocked by local files or an empty remote.
  // Report that separately from saving the connection; never imply an import succeeded.
  const checkoutR = fetchR.success ? await checkout(targetBranch) : fetchR;
  const initialPull = checkoutR.success ? await pull() : checkoutR;
  return {
    success: true,
    synchronized: initialPull.success,
    pullOutput: initialPull.stdout || (initialPull.success ? 'up to date' : initialPull.stderr),
  };
}

// Cleanup temp key on process exit
process.on('exit', () => {
  if (_tmpKeyPath) {
    try { fs.unlinkSync(_tmpKeyPath); } catch {}
  }
});

module.exports = { getConfig, isConfigured, getStatus, getLog, getBranches, checkout, fetchRemote, pull, commit, push, autoPull, autoPush, setup, updateCredentials, registerSyncHook, validateGitUrl, validateBranchName, validateCredentials, clearConnectionArtifacts };
