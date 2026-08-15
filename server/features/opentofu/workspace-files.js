// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

// ── Tofu <-> Git workspace sync ────────────────────────────────────────────
const GIT_WORKSPACE_DIR = path.resolve(path.join(__dirname, '..', '..', 'data', 'git-workspace'));
const TOFU_SUBDIR       = 'tofu';
// Sync configuration and the provider lock file; .tfvars may contain secrets.
const TOFU_EXTENSIONS   = ['.tf'];
const TOFU_GIT_FILES    = new Set(['.gitignore', '.terraform.lock.hcl']);
const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$/;

function normalizedWorkspaceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!WORKSPACE_NAME_RE.test(name) || name === '.' || name === '..' || name.includes('..' + path.sep)) {
    throw new Error('The deployment name must start with a letter or number and contain at most 63 safe characters.');
  }
  return name;
}

function tofuGitDir(workspaceName) {
  const root = path.resolve(GIT_WORKSPACE_DIR, TOFU_SUBDIR);
  const target = path.resolve(root, normalizedWorkspaceName(workspaceName));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Unsicherer Deployment-Name.');
  return target;
}

// Patterns that are never synced to git regardless of workspace .gitignore
const NEVER_SYNC = ['.tfvars', '.tfvars.json', '.auto.tfvars', '.tfstate', '.tfstate.backup'];
function syncOneToGit(name, wsPath) {
  if (!fs.existsSync(wsPath)) return;
  const destDir = tofuGitDir(name);
  fs.mkdirSync(destDir, { recursive: true });
  const srcFiles = new Set(
    fs.readdirSync(wsPath).filter(f =>
      (TOFU_GIT_FILES.has(f) || TOFU_EXTENSIONS.some(e => f.endsWith(e))) &&
      !NEVER_SYNC.some(e => f.endsWith(e))
    )
  );
  for (const f of srcFiles) fs.copyFileSync(path.join(wsPath, f), path.join(destDir, f));
  // Remove from git dir what no longer exists locally
  const destFiles = fs.readdirSync(destDir).filter(f => TOFU_GIT_FILES.has(f) || TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of destFiles) if (!srcFiles.has(f)) fs.unlinkSync(path.join(destDir, f));
}

function syncOneFromGit(name, wsPath) {
  const srcDir = tofuGitDir(name);
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(wsPath, { recursive: true });
  const files = fs.readdirSync(srcDir).filter(f => TOFU_GIT_FILES.has(f) || TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(wsPath, f));
}

function syncAllToGit(workspaces) {
  for (const ws of workspaces) syncOneToGit(ws.name, ws.path);
}

function syncAllFromGit(workspaces) {
  for (const ws of workspaces) syncOneFromGit(ws.name, ws.path);
}

function moveWorkspaceGitDirectory(previousName, nextName) {
  if (previousName === nextName) return;
  const previous = tofuGitDir(previousName);
  const next = tofuGitDir(nextName);
  if (fs.existsSync(previous) && !fs.existsSync(next)) fs.renameSync(previous, next);
}

function ensureProviderLockIsTracked(workspacePath) {
  const ignorePath = path.join(workspacePath, '.gitignore');
  if (!fs.existsSync(ignorePath)) return false;
  const current = fs.readFileSync(ignorePath, 'utf8');
  const next = current.replace(/^\s*\.terraform\.lock\.hcl\s*(?:\r?\n|$)/gm, '');
  if (next === current) return false;
  fs.writeFileSync(ignorePath, next, 'utf8');
  return true;
}


function isDirectoryEmpty(dirPath) {
  try {
    return fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function moveWorkspaceDirectory(fromPath, toPath) {
  const source = path.resolve(fromPath);
  const target = path.resolve(toPath);
  if (source === target) return false;
  if (!fs.existsSync(source)) return false;

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    const stats = fs.statSync(target);
    if (!stats.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${target}`);
    }
    if (!isDirectoryEmpty(target)) {
      throw new Error(`Target path already exists and is not empty: ${target}`);
    }
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }

  try {
    fs.renameSync(source, target);
    return true;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }
}






module.exports = {
  ensureProviderLockIsTracked,
  moveWorkspaceDirectory,
  moveWorkspaceGitDirectory,
  normalizedWorkspaceName,
  syncAllFromGit,
  syncAllToGit,
  syncOneFromGit,
  syncOneToGit,
  tofuGitDir,
};
