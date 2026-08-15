'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const cryptoUtil = require('../../../utils/crypto');

/** Register local and remote OpenTofu state inspection/recovery endpoints. */
function registerStateRoutes({ db, router, backupLocalState, ensureStateSafety, ensureWorkspacePath, findBinary, getWorkspace, listStateBackups, stateBackupDirectory, workspaceBackendType }) {
  // ── Routes: State ─────────────────────────────────────────────────────────
  
  router.get('/workspaces/:id/state-safety', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const safety = ensureStateSafety(workspace);
      res.json({ backend: safety.backend, mode: safety.mode, locking: safety.locking, backups: safety.mode === 'encrypted-backup' ? listStateBackups(workspace).length : null });
    } catch (error) {
      res.status(error.status || 503).json({ error: error.message, backend: workspaceBackendType(workspace), mode: 'unsafe' });
    }
  });
  
  router.get('/workspaces/:id/state-backups', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ items: listStateBackups(workspace) });
  });
  
  router.post('/workspaces/:id/state-backups/restore', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (workspaceBackendType(workspace) !== 'local') return res.status(409).json({ error: 'Remote state must be restored through its configured backend.' });
    if (db.db.prepare("SELECT 1 FROM tofu_runs WHERE workspace_id = ? AND status IN ('running', 'cancelling')").get(workspace.id)) {
      return res.status(409).json({ error: 'State cannot be restored while an operation is running.' });
    }
    if (req.body?.confirmation !== `RESTORE STATE ${workspace.name}`) return res.status(400).json({ error: `Confirm with "RESTORE STATE ${workspace.name}".` });
    const name = String(req.body?.backup || '');
    if (!listStateBackups(workspace).some(item => item.name === name)) return res.status(404).json({ error: 'State backup not found.' });
    try {
      backupLocalState(workspace, 'before-restore');
      const plaintext = cryptoUtil.decrypt(fs.readFileSync(path.join(stateBackupDirectory(workspace), name), 'utf8'));
      if (!plaintext || plaintext.startsWith('enc:')) throw new Error('The backup cannot be decrypted with the current master key.');
      JSON.parse(plaintext);
      fs.mkdirSync(workspace.path, { recursive: true });
      const temporary = path.join(workspace.path, `.terraform.tfstate.restore-${randomUUID()}`);
      fs.writeFileSync(temporary, plaintext, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, path.join(workspace.path, 'terraform.tfstate'));
      db.auditLog.write('tofu.state_restore', `workspace=${workspace.name} backup=${name}`, req.ip, true, req.user?.username);
      res.json({ success: true });
    } catch (error) {
      db.auditLog.write('tofu.state_restore', `workspace=${workspace.name} backup=${name} error=${error.message}`, req.ip, false, req.user?.username);
      res.status(error.status || 500).json({ error: error.message });
    }
  });
  
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
      const raw = execFileSync(binary, ['state', 'list', '-no-color'], {
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
  
  
}

module.exports = { registerStateRoutes };
