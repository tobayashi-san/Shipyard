'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const log = require('../../../utils/logger').child('features:opentofu:workspaces');
const cryptoUtil = require('../../../utils/crypto');
const { createProxmoxConnection } = require('../proxmox-client');
const { moveWorkspaceDirectory, moveWorkspaceGitDirectory } = require('../workspace-files');

/** Register deployment inventory, metadata and platform assignment endpoints. */
function registerWorkspaceRoutes({ db, router, activeRuns, findBinary, getInstallState, getLastRun, getVersion, getWorkspace, getWorkspaceRow, getWorkspaceRows, isAllowedPath, parseWorkspaceEnvVars, permissionError, publicProxmoxConnection, scaffoldWorkspace, serializeWorkspaceEnvVars, syncPathsFile, validateUniqueWorkspaceName, validateUniqueWorkspacePath, WORKSPACE_PATH_ERROR }) {
  function rejectInternalWorkspace(workspace, res) {
    if (workspace?.workspace_kind !== 'isolated_vm') return false;
    res.status(410).json({ error: 'Internal VM workspaces are managed exclusively through the VM API.' });
    return true;
  }
  router.get('/status', (req, res) => {
    const binary = findBinary();
    const version = binary ? getVersion(binary) : null;
    res.json({ installed: Boolean(binary && version), binary, version, installing: getInstallState() });
  });
  
  router.get('/workspaces', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    const rows = getWorkspaceRows(environmentId).filter(row => row.workspace_kind !== 'isolated_vm');
    const withStatus = rows.map(r => {
      const lastRun = getLastRun(r.id);
      return {
        ...r,
        env_var_keys: Object.keys(parseWorkspaceEnvVars(r.env_vars)).sort(),
        env_vars: undefined,
        last_run: lastRun,
        // The browser only needs a human-readable platform reference.  Do
        // not expose the connection secret or legacy workspace variables in
        // this inventory endpoint.
        proxmox_connection: (() => {
          if (!r.proxmox_connection_id) return null;
          const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?')
            .get(r.proxmox_connection_id, r.environment_id || 'default');
          return source ? publicProxmoxConnection(source) : null;
        })(),
      };
    });
    res.json(withStatus);
  });
  
  
  router.post('/workspaces', (req, res) => {
    const { name, path: wPath, description, env_vars, scaffold } = req.body;
    const environmentId = String(req.body?.environment_id || '').trim();
    const proxmoxConnectionId = String(req.body?.proxmox_connection_id || '').trim() || null;
    if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    let safeName;
    try { safeName = validateUniqueWorkspaceName(name); }
    catch (error) { return res.status(409).json({ error: error.message }); }
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: WORKSPACE_PATH_ERROR });
    let safePathValue;
    try { safePathValue = validateUniqueWorkspacePath(wPath); }
    catch (error) { return res.status(409).json({ error: error.message }); }
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    if (proxmoxConnectionId && !db.db.prepare('SELECT 1 FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?').get(proxmoxConnectionId, environmentId)) {
      return res.status(400).json({ error: 'The selected Proxmox connection does not belong to this environment.' });
    }
    if (scaffold?.provider === 'proxmox' && !proxmoxConnectionId) return res.status(400).json({ error: 'Select a Proxmox platform in Infrastructure first.' });
    const id = randomUUID();
    let serializedEnv;
    try { serializedEnv = serializeWorkspaceEnvVars(env_vars || {}); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, description, env_vars, environment_id, proxmox_connection_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, safeName, safePathValue, (description || '').trim(), serializedEnv, environmentId, proxmoxConnectionId);
    syncPathsFile();
    if (scaffold) {
      try { scaffoldWorkspace(safePathValue, scaffold.provider || null); } catch (e) { /* path not mounted yet — files can be created later */ }
    }
    res.json({ success: true, id });
  });
  
  router.put('/workspaces/:id', (req, res) => {
    const { name, path: wPath, description, env_vars } = req.body;
    if (!name || !wPath) return res.status(400).json({ error: 'name and path are required' });
    if (!isAllowedPath(wPath)) return res.status(400).json({ error: WORKSPACE_PATH_ERROR });
    const existing = getWorkspaceRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workspace not found' });
    if (rejectInternalWorkspace(existing, res)) return;
    let safeName;
    try { safeName = validateUniqueWorkspaceName(name, existing.id); }
    catch (error) { return res.status(409).json({ error: error.message }); }
    const nextPath = wPath.trim();
    try { validateUniqueWorkspacePath(nextPath, existing.id); }
    catch (error) { return res.status(409).json({ error: error.message }); }
    const shouldMoveFiles = req.body.move_files !== false;
    const pathChanged = path.resolve(existing.path) !== path.resolve(nextPath);
  
    if (pathChanged && shouldMoveFiles && isAllowedPath(existing.path)) {
      try {
        moveWorkspaceDirectory(existing.path, nextPath);
      } catch (e) {
        return res.status(400).json({ error: permissionError(e, existing.path), code: e.code });
      }
    }
  
    let serializedEnv;
    try { serializedEnv = serializeWorkspaceEnvVars(env_vars || {}); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    const result = db.db.prepare('UPDATE tofu_workspaces SET name=?, path=?, description=?, env_vars=? WHERE id=?')
      .run(safeName, nextPath, (description || '').trim(), serializedEnv, req.params.id);
    try { moveWorkspaceGitDirectory(existing.name, safeName); }
    catch (error) { log.warn({ err: error, workspace: existing.name }, 'Could not rename OpenTofu Git directory'); }
    syncPathsFile();
    res.json({ success: true });
  });
  
  // The console can safely update display metadata without receiving or
  // round-tripping workspace environment variables (which may contain secrets).
  router.patch('/workspaces/:id/metadata', (req, res) => {
    const existing = getWorkspaceRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Workspace not found' });
    if (rejectInternalWorkspace(existing, res)) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    let safeName;
    try { safeName = validateUniqueWorkspaceName(name, existing.id); }
    catch (error) { return res.status(409).json({ error: error.message }); }
    if (description.length > 1_000) return res.status(400).json({ error: 'description must be at most 1000 characters' });
    db.db.prepare('UPDATE tofu_workspaces SET name=?, description=? WHERE id=?').run(safeName, description, req.params.id);
    try { moveWorkspaceGitDirectory(existing.name, safeName); }
    catch (error) { log.warn({ err: error, workspace: existing.name }, 'Could not rename OpenTofu Git directory'); }
    res.json({ success: true });
  });
  
  router.delete('/workspaces/:id', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (rejectInternalWorkspace(workspace, res)) return;
    if ([...activeRuns.values()].some(run => run.workspaceId === workspace.id)) {
      return res.status(409).json({ error: 'The workspace cannot be removed while an OpenTofu run is active.' });
    }
  
    // Removing a deployment is deliberately a Fleet registration operation.
    // It neither destroys Proxmox resources nor deletes independent Fleet
    // hosts. The workspace directory is retained for recovery or a later
    // manual OpenTofu run as well.
    const removeWorkspace = db.db.transaction(() => {
      db.db.prepare('DELETE FROM tofu_managed_servers WHERE workspace_id = ?').run(workspace.id);
      db.db.prepare('DELETE FROM tofu_proxmox_playbook_runs WHERE workspace_id = ?').run(workspace.id);
      db.db.prepare('DELETE FROM tofu_proxmox_vm_templates WHERE workspace_id = ?').run(workspace.id);
      db.db.prepare('DELETE FROM tofu_proxmox_vms WHERE workspace_id = ?').run(workspace.id);
      db.db.prepare('DELETE FROM tofu_runs WHERE workspace_id = ?').run(workspace.id);
      db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(workspace.id);
    });
    removeWorkspace();
    db.auditLog.write('tofu.workspace_remove', `workspace=${workspace.name} inventory_kept=true`, req.ip, true, req.user?.username);
    syncPathsFile();
    res.json({ success: true, inventory_kept: true, workspace_files_kept: true });
  });
  
  // Keep connection management in the native Fleet console without ever
  // returning secrets to the browser. Empty secret fields on update preserve
  // their stored value, which makes the form safe to reopen and save.
  router.get('/workspaces/:id/proxmox-connection', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const env = workspace.env_vars || {};
    res.json({
      source: workspace.proxmox_connection || null,
      source_id: workspace.proxmox_connection_id || null,
      endpoint: String(env.TF_VAR_proxmox_endpoint || ''),
      insecure: String(env.TF_VAR_proxmox_insecure || '').toLowerCase() === 'true',
      api_token_configured: Boolean(String(env.TF_VAR_proxmox_api_token || '').trim()),
      ssh_public_key_configured: Boolean(String(env.TF_VAR_ssh_public_key || '').trim()),
    });
  });
  
  router.put('/workspaces/:id/proxmox-connection', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (rejectInternalWorkspace(workspace, res)) return;
    const body = req.body || {};
    const sourceId = String(body.proxmox_connection_id || '').trim() || null;
    if (sourceId) {
      const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?').get(sourceId, workspace.environment_id || 'default');
      if (!source) return res.status(400).json({ error: 'The selected Proxmox connection does not belong to this environment.' });
      db.db.prepare('UPDATE tofu_workspaces SET proxmox_connection_id = ? WHERE id = ?').run(sourceId, workspace.id);
      return res.json({ success: true, source: publicProxmoxConnection(source), source_id: source.id, endpoint: source.endpoint, insecure: Boolean(source.insecure), api_token_configured: true, ssh_public_key_configured: Boolean(source.ssh_public_key) });
    }
    // An explicit detachment returns the deployment to its legacy, local
    // connection fields without deleting its manually configured variables.
    if (body.detach_source === true) db.db.prepare('UPDATE tofu_workspaces SET proxmox_connection_id = NULL WHERE id = ?').run(workspace.id);
    const endpoint = String(body.endpoint || '').trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) return res.status(400).json({ error: 'The Proxmox endpoint must start with http:// or https://.' });
    const env = { ...(workspace.env_vars || {}) };
    if (endpoint) env.TF_VAR_proxmox_endpoint = endpoint;
    else if (body.clear_endpoint === true) delete env.TF_VAR_proxmox_endpoint;
    env.TF_VAR_proxmox_insecure = body.insecure === true ? 'true' : 'false';
    if (typeof body.api_token === 'string' && body.api_token.trim()) env.TF_VAR_proxmox_api_token = body.api_token.trim();
    else if (body.clear_api_token === true) delete env.TF_VAR_proxmox_api_token;
    if (typeof body.ssh_public_key === 'string' && body.ssh_public_key.trim()) env.TF_VAR_ssh_public_key = body.ssh_public_key.trim();
    else if (body.clear_ssh_public_key === true) delete env.TF_VAR_ssh_public_key;
    let serializedEnv;
    try { serializedEnv = serializeWorkspaceEnvVars(env); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
    db.db.prepare('UPDATE tofu_workspaces SET env_vars = ? WHERE id = ?').run(serializedEnv, workspace.id);
    res.json({
      success: true,
      endpoint: String(env.TF_VAR_proxmox_endpoint || ''),
      insecure: env.TF_VAR_proxmox_insecure === 'true',
      api_token_configured: Boolean(String(env.TF_VAR_proxmox_api_token || '').trim()),
      ssh_public_key_configured: Boolean(String(env.TF_VAR_ssh_public_key || '').trim()),
    });
  });
  
  // One-way migration for old deployments that still contain their own
  // Proxmox token. This removes the second normal configuration location
  // without breaking existing installations during the upgrade.
  router.post('/workspaces/:id/promote-proxmox-connection', (req, res) => {
    const row = getWorkspaceRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Workspace not found' });
    if (row.proxmox_connection_id) return res.status(409).json({ error: 'This deployment already uses a platform connection.' });
    let env = {};
    env = parseWorkspaceEnvVars(row.env_vars);
    const endpoint = String(env.TF_VAR_proxmox_endpoint || '').trim();
    const token = String(env.TF_VAR_proxmox_api_token || '').trim();
    if (!cryptoUtil.isEncryptionAvailable()) return res.status(503).json({ error: 'SHIPYARD_KEY_SECRET is required before platform secrets can be migrated.' });
    try { createProxmoxConnection(endpoint, token, String(env.TF_VAR_proxmox_insecure || '').toLowerCase() === 'true'); }
    catch (error) { return res.status(400).json({ error: `The existing workspace connection cannot be migrated: ${error.message}` }); }
    const environmentId = String(row.environment_id || 'default');
    const baseName = `${row.name} · Proxmox`;
    let name = baseName.slice(0, 80);
    let suffix = 2;
    while (db.db.prepare('SELECT 1 FROM tofu_proxmox_connections WHERE environment_id = ? AND name = ?').get(environmentId, name)) name = `${baseName.slice(0, 74)} (${suffix++})`;
    const id = randomUUID();
    const insecure = String(env.TF_VAR_proxmox_insecure || '').toLowerCase() === 'true';
    const sshKey = String(env.TF_VAR_ssh_public_key || '').trim();
    const remainingEnv = { ...env };
    delete remainingEnv.TF_VAR_proxmox_endpoint;
    delete remainingEnv.TF_VAR_proxmox_api_token;
    delete remainingEnv.TF_VAR_proxmox_insecure;
    delete remainingEnv.TF_VAR_ssh_public_key;
    const migrate = db.db.transaction(() => {
      db.db.prepare('INSERT INTO tofu_proxmox_connections (id, environment_id, name, endpoint, api_token, insecure, ssh_public_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, environmentId, name, endpoint, cryptoUtil.encrypt(token), insecure ? 1 : 0, sshKey ? cryptoUtil.encrypt(sshKey) : '');
      db.db.prepare('UPDATE tofu_workspaces SET proxmox_connection_id = ?, env_vars = ? WHERE id = ?').run(id, serializeWorkspaceEnvVars(remainingEnv), row.id);
    });
    migrate();
    res.status(201).json({ success: true, source: publicProxmoxConnection(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(id)) });
  });
  
  
}

module.exports = { registerWorkspaceRoutes };
