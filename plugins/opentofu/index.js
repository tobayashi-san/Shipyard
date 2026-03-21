const { spawn, execSync } = require('child_process');
const { randomUUID }      = require('crypto');

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

    const runId = randomUUID();
    const args  = [action, '-no-color'];
    if (action === 'apply' || action === 'destroy') args.push('-auto-approve');
    if (action !== 'init') args.push('-input=false');

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

  // GET /api/plugin/opentofu/workspaces/:id/state
  router.get('/workspaces/:id/state', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'Binary not found' });
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
