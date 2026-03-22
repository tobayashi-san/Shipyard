const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

let _gitSync = null;
function getGitSync() {
  if (!_gitSync) {
    try { _gitSync = require('../../server/services/git-sync'); } catch {}
  }
  return _gitSync;
}

// Map of currently running processes: runId -> ChildProcess
const _running = new Map();

// ── Tofu <-> Git workspace sync ────────────────────────────────────────────
const GIT_WORKSPACE_DIR = path.resolve(path.join(__dirname, '..', '..', 'server', 'data', 'git-workspace'));
const TOFU_SUBDIR       = 'tofu';
const TOFU_EXTENSIONS   = ['.tf', '.tfvars', '.tfvars.json', '.auto.tfvars'];

function tofuGitDir(workspaceName) {
  return path.join(GIT_WORKSPACE_DIR, TOFU_SUBDIR, workspaceName);
}

function syncOneToGit(name, wsPath) {
  if (!fs.existsSync(wsPath)) return;
  const destDir = tofuGitDir(name);
  fs.mkdirSync(destDir, { recursive: true });
  const srcFiles = new Set(
    fs.readdirSync(wsPath).filter(f => TOFU_EXTENSIONS.some(e => f.endsWith(e)))
  );
  for (const f of srcFiles) fs.copyFileSync(path.join(wsPath, f), path.join(destDir, f));
  // Remove from git dir what no longer exists locally
  const destFiles = fs.readdirSync(destDir).filter(f => TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of destFiles) if (!srcFiles.has(f)) fs.unlinkSync(path.join(destDir, f));
}

function syncOneFromGit(name, wsPath) {
  const srcDir = tofuGitDir(name);
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(wsPath, { recursive: true });
  const files = fs.readdirSync(srcDir).filter(f => TOFU_EXTENSIONS.some(e => f.endsWith(e)));
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(wsPath, f));
}

function syncAllToGit(workspaces) {
  for (const ws of workspaces) syncOneToGit(ws.name, ws.path);
}

function syncAllFromGit(workspaces) {
  for (const ws of workspaces) syncOneFromGit(ws.name, ws.path);
}

const https = require('https');
const http  = require('http');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

function _downloadFile(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'shipyard-lab-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        _downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = require('fs').createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function _fetchGitHubReleases() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/opentofu/opentofu/releases?per_page=15',
      headers: { 'User-Agent': 'shipyard-lab-manager' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          if (!Array.isArray(list)) { reject(new Error(list.message || 'GitHub API error')); return; }
          const versions = list
            .filter(r => !r.prerelease && !r.draft)
            .map(r => r.tag_name.replace(/^v/, ''))
            .filter(v => /^\d+\.\d+\.\d+$/.test(v));
          resolve(versions);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function register({ router, db, broadcast }) {

  // ── DB setup ──────────────────────────────────────────────────────────────
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      env_vars    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_runs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      output       TEXT NOT NULL DEFAULT '',
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `).run();

  syncPathsFile();

  // ── Register git sync hook so tofu files are included in push/status ─────
  const gs = getGitSync();
  if (gs?.registerSyncHook) {
    gs.registerSyncHook(() => syncAllToGit(getAllWorkspaces()));
  }

  // ── Binary detection (cached) ────────────────────────────────────────────
  let _cachedBinary  = undefined;
  let _cachedVersion = undefined;

  const TOFU_INSTALL_PATH = '/app/server/data/bin/tofu';

  function findBinary() {
    if (_cachedBinary !== undefined) return _cachedBinary;
    if (fs.existsSync(TOFU_INSTALL_PATH)) {
      _cachedBinary = TOFU_INSTALL_PATH;
      return TOFU_INSTALL_PATH;
    }
    for (const bin of ['tofu', 'opentofu', 'terraform']) {
      try { execSync(`which ${bin}`, { stdio: 'ignore' }); _cachedBinary = bin; return bin; } catch {}
    }
    _cachedBinary = null; return null;
  }

  function getVersion(bin) {
    if (_cachedVersion !== undefined) return _cachedVersion;
    try {
      const raw = execSync(`${bin} version -json`, { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(raw);
      _cachedVersion = parsed.terraform_version || parsed.tofu_version || null;
    } catch {
      try { _cachedVersion = execSync(`${bin} version`, { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim(); }
      catch { _cachedVersion = null; }
    }
    return _cachedVersion;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const PATHS_FILE = '/app/server/data/tofu-workspace-paths.txt';
  function syncPathsFile() {
    try {
      const rows = db.db.prepare('SELECT path FROM tofu_workspaces').all();
      fs.writeFileSync(PATHS_FILE, rows.map(r => r.path).join('\n'), 'utf8');
    } catch {}
  }

  const BLOCKED_ENV_VARS = new Set([
    'LD_PRELOAD','LD_LIBRARY_PATH','PATH','NODE_OPTIONS',
    'HOME','USER','SHELL','HOSTNAME','PWD',
    'JWT_SECRET','SHIPYARD_KEY_SECRET','GIT_SSH_COMMAND',
    'BASH_ENV','ENV','CDPATH',
    'HTTP_PROXY','HTTPS_PROXY','NO_PROXY',
    'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',
  ]);

  const ALLOWED_PATH_PREFIXES = ['/opt/','/srv/','/home/','/var/lib/','/app/','/workspaces/'];

  function isAllowedPath(p) {
    const resolved = path.resolve(p);
    if (resolved.includes('..')) return false;
    return ALLOWED_PATH_PREFIXES.some(prefix => resolved.startsWith(prefix));
  }

  const PROVIDER_CONFIGS = {
    aws: {
      providers_tf: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
`,
      extra_variables: `
variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "eu-central-1"
}
`,
    },
    azurerm: {
      providers_tf: `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`,
      extra_variables: '',
    },
    google: {
      providers_tf: `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}
`,
      extra_variables: `
variable "gcp_project" {
  type        = string
  description = "GCP project ID"
}

variable "gcp_region" {
  type        = string
  description = "GCP region"
  default     = "europe-west3"
}
`,
    },
    hcloud: {
      providers_tf: `terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
`,
      extra_variables: `
variable "hcloud_token" {
  type        = string
  description = "Hetzner Cloud API token"
  sensitive   = true
}
`,
    },
    digitalocean: {
      providers_tf: `terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}
`,
      extra_variables: `
variable "do_token" {
  type        = string
  description = "DigitalOcean API token"
  sensitive   = true
}
`,
    },
    kubernetes: {
      providers_tf: `terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}
`,
      extra_variables: '',
    },
    proxmox: {
      providers_tf: `terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  insecure  = var.proxmox_insecure
}
`,
      extra_variables: `
variable "proxmox_endpoint" {
  type        = string
  description = "Proxmox API endpoint, e.g. https://pve.example.com:8006/"
}

variable "proxmox_api_token" {
  type        = string
  description = "Proxmox API token, e.g. root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  sensitive   = true
}

variable "proxmox_insecure" {
  type        = bool
  description = "Skip TLS verification (self-signed certificates)"
  default     = false
}
`,
    },
  };

  function scaffoldWorkspace(wsPath, provider) {
    fs.mkdirSync(wsPath, { recursive: true });

    const providerCfg = PROVIDER_CONFIGS[provider];

    const mainTf = `# ${provider ? `${provider.toUpperCase()} ` : ''}Infrastructure
# Managed by Shipyard / OpenTofu

# Add your resources here
`;

    const variablesTf = `# Input variables
${providerCfg?.extra_variables || ''}`;

    const outputsTf = `# Outputs
# output "example" {
#   value       = resource.type.name.attribute
#   description = "An example output"
# }
`;

    fs.writeFileSync(path.join(wsPath, 'main.tf'), mainTf);
    fs.writeFileSync(path.join(wsPath, 'variables.tf'), variablesTf);
    fs.writeFileSync(path.join(wsPath, 'outputs.tf'), outputsTf);

    if (providerCfg) {
      fs.writeFileSync(path.join(wsPath, 'providers.tf'), providerCfg.providers_tf);
    }
  }

  function sanitizeEnvVars(vars) {
    if (!vars || typeof vars !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!BLOCKED_ENV_VARS.has(k.toUpperCase()) && typeof v === 'string') clean[k] = v;
    }
    return clean;
  }

  function getWorkspace(id) {
    const row = db.db.prepare('SELECT * FROM tofu_workspaces WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, env_vars: sanitizeEnvVars(JSON.parse(row.env_vars || '{}')) };
  }

  function getAllWorkspaces() {
    return db.db.prepare('SELECT id, name, path FROM tofu_workspaces').all();
  }

  function ensureWorkspacePath(workspace) {
    if (fs.existsSync(workspace.path)) return null;
    try { fs.mkdirSync(workspace.path, { recursive: true }); return null; }
    catch (e) { return e; }
  }

  function permissionError(e, wsPath) {
    return e.code === 'EACCES'
      ? `Permission denied. Fix with: chown -R 1001:1001 ${wsPath}`
      : e.message;
  }

  function safePath(wsPath, relPath) {
    const resolved = path.resolve(wsPath, relPath);
    if (!resolved.startsWith(path.resolve(wsPath) + path.sep) &&
        resolved !== path.resolve(wsPath)) return null;
    return resolved;
  }

  function walkDir(dir, rel, depth) {
    if (depth > 5) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const result = [];
    for (const e of entries) {
      if (e.name === '.terraform' || e.name === '.git') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        result.push({ type: 'dir', name: e.name, path: childRel,
          children: walkDir(path.join(dir, e.name), childRel, depth + 1) });
      } else {
        result.push({ type: 'file', name: e.name, path: childRel });
      }
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function getLastRun(workspaceId) {
    return db.db.prepare(
      'SELECT * FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(workspaceId) || null;
  }

  // ── Routes: Status & Workspaces ───────────────────────────────────────────

  router.get('/status', (req, res) => {
    const binary = findBinary();
    res.json({ installed: !!binary, binary, version: binary ? getVersion(binary) : null });
  });

  router.get('/workspaces', (req, res) => {
    const rows = db.db.prepare('SELECT * FROM tofu_workspaces ORDER BY name ASC').all();
    const withStatus = rows.map(r => {
      const lastRun = getLastRun(r.id);
      return {
        ...r,
        env_vars: sanitizeEnvVars(JSON.parse(r.env_vars || '{}')),
        last_run: lastRun,
      };
    });
    res.json(withStatus);
  });

  router.post('/workspaces', (req, res) => {
    const { name, path: wPath, description, env_vars, scaffold } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: 'Path must be under /workspaces/, /opt/, /srv/, /home/, /var/lib/, or /app/' });
    const id = randomUUID();
    db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, description, env_vars) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(env_vars || {}));
    syncPathsFile();
    if (scaffold) {
      try { scaffoldWorkspace(wPath.trim(), scaffold.provider || null); } catch (e) { /* path not mounted yet — files can be created later */ }
    }
    res.json({ success: true, id });
  });

  router.put('/workspaces/:id', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: 'Path must be under /opt/, /srv/, /home/, /var/lib/, or /app/' });
    const result = db.db.prepare('UPDATE tofu_workspaces SET name=?, path=?, description=?, env_vars=? WHERE id=?')
      .run(name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(env_vars || {}), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Workspace not found' });
    syncPathsFile();
    res.json({ success: true });
  });

  router.delete('/workspaces/:id', (req, res) => {
    db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(req.params.id);
    db.db.prepare('DELETE FROM tofu_runs WHERE workspace_id = ?').run(req.params.id);
    syncPathsFile();
    res.json({ success: true });
  });

  // ── Routes: Run history ───────────────────────────────────────────────────

  router.get('/workspaces/:id/runs', (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const runs = db.db.prepare(
      'SELECT id, workspace_id, action, status, started_at, completed_at FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(req.params.id, limit);
    res.json(runs);
  });

  router.get('/workspaces/:id/runs/:runId', (req, res) => {
    const run = db.db.prepare('SELECT * FROM tofu_runs WHERE id = ? AND workspace_id = ?')
      .get(req.params.runId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  // ── Routes: Execute ───────────────────────────────────────────────────────

  router.post('/workspaces/:id/run', (req, res) => {
    const VALID_ACTIONS = ['init', 'validate', 'plan', 'apply', 'destroy'];
    const { action } = req.body;
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'OpenTofu/Terraform binary not found in PATH' });

    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });

    const runId  = randomUUID();
    const dbRunId = randomUUID();

    // Save run to DB
    db.db.prepare('INSERT INTO tofu_runs (id, workspace_id, action) VALUES (?, ?, ?)')
      .run(dbRunId, workspace.id, action);

    const args = [action, '-no-color'];
    if (action === 'apply' || action === 'destroy') args.push('-auto-approve');
    if (['plan','apply','destroy'].includes(action)) args.push('-input=false');

    const env = { ...process.env, ...workspace.env_vars };

    res.json({ runId, dbRunId, status: 'started' });

    // Auto-pull from git before run
    const gs = getGitSync();
    const pullAndRun = async () => {
      if (gs && gs.isConfigured()) {
        try {
          await gs.pull();
          syncAllFromGit(getAllWorkspaces());
        } catch {}
      }

      broadcast({ type: 'tofu_start', runId, workspaceId: workspace.id, action });
      broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'meta',
        data: `▶  ${binary} ${args.join(' ')}\n   cwd: ${workspace.path}\n\n` });

      const proc = spawn(binary, args, { cwd: workspace.path, env });
      _running.set(runId, proc);

      let output = '';
      proc.stdout.on('data', d => {
        const s = d.toString();
        output += s;
        broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stdout', data: s });
      });
      proc.stderr.on('data', d => {
        const s = d.toString();
        output += s;
        broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stderr', data: s });
      });
      proc.on('close', code => {
        _running.delete(runId);
        const success = code === 0;
        const status  = success ? 'success' : 'failed';
        db.db.prepare("UPDATE tofu_runs SET status=?, output=?, completed_at=datetime('now') WHERE id=?")
          .run(status, output, dbRunId);
        broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success, exitCode: code, dbRunId });
      });
      proc.on('error', err => {
        _running.delete(runId);
        db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?")
          .run(err.message, dbRunId);
        broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success: false, exitCode: -1, error: err.message, dbRunId });
      });
    };

    pullAndRun().catch(() => {});
  });

  router.post('/workspaces/:id/cancel/:runId', (req, res) => {
    const proc = _running.get(req.params.runId);
    if (!proc) return res.status(404).json({ error: 'No running process found' });
    proc.kill('SIGTERM');
    res.json({ success: true });
  });

  // ── Routes: Files ─────────────────────────────────────────────────────────

  router.get('/workspaces/:id/check', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    res.json({ pathExists: fs.existsSync(workspace.path) });
  });

  router.get('/workspaces/:id/files', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });
    res.json({ tree: walkDir(workspace.path, '', 0) });
  });

  router.get('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try { res.json({ content: fs.readFileSync(fp, 'utf8') }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.writeFileSync(fp, req.body.content ?? '', 'utf8');
      res.json({ success: true });
      // Auto-push to git after file save
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Update tofu/${workspace.name}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  router.post('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.body.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    if (fs.existsSync(fp)) return res.status(409).json({ error: 'File already exists' });
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  router.delete('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.unlinkSync(fp);
      res.json({ success: true });
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Delete tofu/${workspace.name}/${req.query.path}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });

  // ── Routes: State ─────────────────────────────────────────────────────────

  router.get('/workspaces/:id/state', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'Binary not found' });
    ensureWorkspacePath(workspace);
    if (!fs.existsSync(workspace.path)) {
      return res.json({ resources: [], error: `Path "${workspace.path}" does not exist inside the container.` });
    }
    try {
      const raw = execSync(`${binary} state list -no-color`, {
        cwd: workspace.path,
        env: { ...process.env, ...workspace.env_vars },
        encoding: 'utf8',
        timeout: 15000,
      });
      const resources = raw.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('.');
        return { address: line.trim(), type: parts[0] || '', name: parts.slice(1).join('.') || '' };
      });
      res.json({ resources });
    } catch (e) {
      const stderr = (e.stdout || e.stderr || e.message || '').trim();
      res.json({ resources: [], error: stderr });
    }
  });

  // ── Routes: Install ───────────────────────────────────────────────────────

  router.get('/releases', async (req, res) => {
    try {
      const releases = await _fetchGitHubReleases();
      res.json({ releases });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/install', async (req, res) => {
    const { version } = req.body;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({ error: 'Invalid version' });
    }
    const arch     = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const filename = `tofu_${version}_linux_${arch}.zip`;
    const url      = `https://github.com/opentofu/opentofu/releases/download/v${version}/${filename}`;
    const tmpZip   = `/tmp/tofu_install_${version}.zip`;
    const installDir  = '/app/server/data/bin';
    const installPath = `${installDir}/tofu`;

    try {
      fs.mkdirSync(installDir, { recursive: true });
      await _downloadFile(url, tmpZip);
      await execAsync(`unzip -o "${tmpZip}" tofu -d "${installDir}" && chmod +x "${installPath}"`);
      try { fs.unlinkSync(tmpZip); } catch {}
      // Invalidate binary cache so next call picks up new binary
      _cachedBinary  = undefined;
      _cachedVersion = undefined;
      const bin = findBinary();
      const ver = bin ? getVersion(bin) : null;
      res.json({ success: true, binary: bin, version: ver });
    } catch (e) {
      try { fs.unlinkSync(tmpZip); } catch {}
      res.status(500).json({ error: e.message });
    }
  });

}

module.exports = { register };
