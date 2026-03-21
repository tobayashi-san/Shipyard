const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Map of currently running processes: runId -> ChildProcess
const _running = new Map();

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

  // ── Binary detection ──────────────────────────────────────────────────────
  function findBinary() {
    for (const bin of ['tofu', 'opentofu', 'terraform']) {
      try { execSync(`which ${bin}`, { stdio: 'ignore' }); return bin; } catch {}
    }
    return null;
  }

  function getVersion(bin) {
    try {
      const raw = execSync(`${bin} version -json`, { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(raw);
      return parsed.terraform_version || parsed.tofu_version || null;
    } catch {
      try {
        return execSync(`${bin} version`, { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim();
      } catch { return null; }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getWorkspace(id) {
    const row = db.db.prepare('SELECT * FROM tofu_workspaces WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, env_vars: JSON.parse(row.env_vars || '{}') };
  }

  // Resolve a relative path safely within a workspace (prevent traversal)
  function safePath(wsPath, relPath) {
    const resolved = path.resolve(wsPath, relPath);
    if (!resolved.startsWith(path.resolve(wsPath) + path.sep) &&
        resolved !== path.resolve(wsPath)) return null;
    return resolved;
  }

  // Recursively list files/dirs, skipping .terraform provider cache
  function walkDir(dir, rel, depth) {
    if (depth > 5) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
    const result = [];
    for (const e of entries) {
      if (e.name === '.terraform') continue; // auto-generated provider cache, skip entirely
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

  // ── Routes ────────────────────────────────────────────────────────────────

  // GET /api/plugin/opentofu/status
  router.get('/status', (req, res) => {
    const binary = findBinary();
    res.json({
      installed: !!binary,
      binary,
      version: binary ? getVersion(binary) : null,
    });
  });

  // GET /api/plugin/opentofu/workspaces
  router.get('/workspaces', (req, res) => {
    const rows = db.db.prepare('SELECT * FROM tofu_workspaces ORDER BY created_at ASC').all();
    res.json(rows.map(r => ({ ...r, env_vars: JSON.parse(r.env_vars || '{}') })));
  });

  // POST /api/plugin/opentofu/workspaces
  router.post('/workspaces', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    const id = randomUUID();
    db.db.prepare(
      'INSERT INTO tofu_workspaces (id, name, path, description, env_vars) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(env_vars || {}));
    res.json({ success: true, id });
  });

  // PUT /api/plugin/opentofu/workspaces/:id
  router.put('/workspaces/:id', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    const result = db.db.prepare(
      'UPDATE tofu_workspaces SET name=?, path=?, description=?, env_vars=? WHERE id=?'
    ).run(name.trim(), wPath.trim(), (description || '').trim(), JSON.stringify(env_vars || {}), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ success: true });
  });

  // DELETE /api/plugin/opentofu/workspaces/:id
  router.delete('/workspaces/:id', (req, res) => {
    db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // POST /api/plugin/opentofu/workspaces/:id/run
  router.post('/workspaces/:id/run', (req, res) => {
    const VALID_ACTIONS = ['init', 'validate', 'plan', 'apply', 'destroy'];
    const { action } = req.body;
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'OpenTofu/Terraform binary not found in PATH' });

    if (!fs.existsSync(workspace.path)) {
      if (action === 'init') {
        // Auto-create the directory so tofu init can bootstrap a new workspace
        try { fs.mkdirSync(workspace.path, { recursive: true }); }
        catch (e) {
          return res.status(400).json({
            error: `Cannot create "${workspace.path}": ${e.message}.\n` +
                   `Mount the parent directory in docker-compose.override.yml first.`
          });
        }
      } else {
        return res.status(400).json({
          error: `Path "${workspace.path}" does not exist inside the container.\n` +
                 `Add a volume mount in docker-compose.override.yml:\n` +
                 `  - /your/host/path:${workspace.path}:rw\n` +
                 `Then restart: docker compose up -d`
        });
      }
    }

    const runId = randomUUID();
    const args  = [action, '-no-color'];
    if (action === 'apply' || action === 'destroy') args.push('-auto-approve');
    if (action === 'plan' || action === 'apply' || action === 'destroy') args.push('-input=false');

    const env = { ...process.env, ...workspace.env_vars };

    res.json({ runId, status: 'started' });

    broadcast({ type: 'tofu_start', runId, workspaceId: workspace.id, action });
    broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'meta',
      data: `▶  ${binary} ${args.join(' ')}\n   cwd: ${workspace.path}\n\n` });

    const proc = spawn(binary, args, { cwd: workspace.path, env });
    _running.set(runId, proc);

    proc.stdout.on('data', d => {
      broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stdout', data: d.toString() });
    });
    proc.stderr.on('data', d => {
      broadcast({ type: 'tofu_output', runId, workspaceId: workspace.id, stream: 'stderr', data: d.toString() });
    });
    proc.on('close', code => {
      _running.delete(runId);
      broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success: code === 0, exitCode: code });
    });
    proc.on('error', err => {
      _running.delete(runId);
      broadcast({ type: 'tofu_done', runId, workspaceId: workspace.id, success: false, exitCode: -1, error: err.message });
    });
  });

  // POST /api/plugin/opentofu/workspaces/:id/cancel/:runId
  router.post('/workspaces/:id/cancel/:runId', (req, res) => {
    const proc = _running.get(req.params.runId);
    if (!proc) return res.status(404).json({ error: 'No running process found' });
    proc.kill('SIGTERM');
    res.json({ success: true });
  });

  // GET /api/plugin/opentofu/workspaces/:id/check
  router.get('/workspaces/:id/check', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ pathExists: fs.existsSync(workspace.path) });
  });

  // GET /api/plugin/opentofu/workspaces/:id/files  — directory tree
  router.get('/workspaces/:id/files', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });
    res.json({ tree: walkDir(workspace.path, '', 0) });
  });

  // GET /api/plugin/opentofu/workspaces/:id/file?path=rel/path  — read file
  router.get('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      const content = fs.readFileSync(fp, 'utf8');
      res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/plugin/opentofu/workspaces/:id/file?path=rel/path  — save file
  router.put('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.writeFileSync(fp, req.body.content ?? '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      const msg = e.code === 'EACCES'
        ? `Permission denied: "${fp}". Fix with: chown -R 1001:1001 ${workspace.path}`
        : e.message;
      res.status(500).json({ error: msg, code: e.code });
    }
  });

  // POST /api/plugin/opentofu/workspaces/:id/file?path=rel/path  — create new file
  router.post('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.body.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    if (fs.existsSync(fp)) return res.status(409).json({ error: 'File already exists' });
    try {
      const dir = path.dirname(fp);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fp, '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      const msg = e.code === 'EACCES'
        ? `Permission denied. Fix with: chown -R 1001:1001 ${workspace.path}`
        : e.message;
      res.status(500).json({ error: msg, code: e.code });
    }
  });

  // DELETE /api/plugin/opentofu/workspaces/:id/file?path=rel/path  — delete file
  router.delete('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.unlinkSync(fp);
      res.json({ success: true });
    } catch (e) {
      const msg = e.code === 'EACCES'
        ? `Permission denied. Fix with: chown -R 1001:1001 ${workspace.path}`
        : e.message;
      res.status(500).json({ error: msg, code: e.code });
    }
  });

  // GET /api/plugin/opentofu/workspaces/:id/state
  router.get('/workspaces/:id/state', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'Binary not found' });
    if (!fs.existsSync(workspace.path)) {
      return res.json({ output: `Error: path "${workspace.path}" does not exist inside the container.\nMount it via docker-compose.override.yml first.` });
    }
    try {
      const output = execSync(`${binary} state list -no-color`, {
        cwd: workspace.path,
        env: { ...process.env, ...workspace.env_vars },
        encoding: 'utf8',
        timeout: 15000,
      });
      res.json({ output: output.trim() });
    } catch (e) {
      res.json({ output: (e.stdout || e.stderr || e.message || '').trim() });
    }
  });
}

module.exports = { register };
