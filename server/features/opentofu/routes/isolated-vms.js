'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { requestProxmoxApi } = require('../proxmox-client');

function publicVm(row, normalizeProxmoxVm) {
  if (!row) return null;
  let config;
  try { config = normalizeProxmoxVm(JSON.parse(row.config)); }
  catch { return null; }
  return {
    ...config,
    id: row.id,
    environment_id: row.environment_id || 'default',
    connection_id: row.connection_id || row.proxmox_connection_id || null,
    template_id: row.template_id || null,
    platform: row.connection_name ? { id: row.connection_id, name: row.connection_name, endpoint: row.connection_endpoint } : null,
    last_run: row.last_run_id ? {
      id: row.last_run_id,
      action: row.last_run_action,
      status: row.last_run_status,
      plan_summary: row.last_run_plan_summary,
      started_at: row.last_run_started_at,
      completed_at: row.last_run_completed_at,
    } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** User-facing VM routes backed by hidden one-resource OpenTofu workspaces. */
function registerIsolatedVmRoutes({
  db,
  router,
  backupLocalState,
  ensureWorkspacePath,
  findBinary,
  getPostDeployOverview,
  getWorkspace,
  internalVmRoot,
  isAllowedPath,
  loadProxmoxCatalog,
  normalizeProxmoxVm,
  normalizeProxmoxVmTemplate,
  readSavedProxmoxConnection,
  syncPathsFile,
  validatePostDeployPlaybookAccess,
  writeFleetProxmoxFiles,
}) {
  const selectVm = `
    SELECT vm.*, workspace.environment_id, workspace.proxmox_connection_id,
           workspace.path AS workspace_path, workspace.workspace_kind,
           source.name AS connection_name, source.endpoint AS connection_endpoint,
           last_run.id AS last_run_id, last_run.action AS last_run_action,
           last_run.status AS last_run_status, last_run.plan_summary AS last_run_plan_summary,
           last_run.started_at AS last_run_started_at, last_run.completed_at AS last_run_completed_at
    FROM tofu_proxmox_vms vm
    JOIN tofu_workspaces workspace ON workspace.id = vm.workspace_id
    LEFT JOIN tofu_proxmox_connections source ON source.id = COALESCE(vm.connection_id, workspace.proxmox_connection_id)
    LEFT JOIN tofu_runs last_run ON last_run.id = (
      SELECT id FROM tofu_runs WHERE workspace_id = workspace.id ORDER BY started_at DESC, rowid DESC LIMIT 1
    )
  `;
  const getVmRow = id => db.db.prepare(`${selectVm} WHERE vm.id = ? AND vm.is_isolated = 1`).get(id) || null;

  router.get('/proxmox-connections/:connectionId/vm-catalog', async (req, res) => {
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(req.params.connectionId);
    if (!source) return res.status(404).json({ error: 'Proxmox platform not found' });
    try {
      const connection = readSavedProxmoxConnection(source);
      res.json(await loadProxmoxCatalog({ env_vars: {
        TF_VAR_proxmox_endpoint: connection.base.toString(),
        TF_VAR_proxmox_api_token: connection.apiToken,
        TF_VAR_proxmox_insecure: connection.insecure ? 'true' : 'false',
      } }, req.query.node));
    } catch (error) { res.status(502).json({ error: error.message || 'Proxmox catalog could not be loaded' }); }
  });

  router.get('/vms', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    const rows = db.db.prepare(`${selectVm} WHERE vm.is_isolated = 1 AND workspace.environment_id = ? ORDER BY vm.name COLLATE NOCASE`).all(environmentId);
    res.json(rows.map(row => publicVm(row, normalizeProxmoxVm)).filter(Boolean));
  });

  router.post('/vms', (req, res) => {
    const environmentId = String(req.body?.environment_id || '').trim();
    const connectionId = String(req.body?.connection_id || '').trim();
    const source = db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?').get(connectionId, environmentId);
    if (!source) return res.status(400).json({ error: 'Select a Proxmox platform from this environment.' });
    let vm;
    try {
      vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess(vm.post_deploy_playbooks, req);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    const nameCollision = db.db.prepare(`
      SELECT 1 FROM tofu_proxmox_vms vm JOIN tofu_workspaces workspace ON workspace.id = vm.workspace_id
      WHERE workspace.environment_id = ? AND vm.name = ? COLLATE NOCASE
    `).get(environmentId, vm.name);
    if (nameCollision) return res.status(409).json({ error: `A VM named ${vm.name} already exists in this environment.` });
    if (vm.vm_id !== null && db.db.prepare('SELECT 1 FROM tofu_proxmox_vms WHERE connection_id = ? AND vm_numeric_id = ?').get(connectionId, vm.vm_id)) {
      return res.status(409).json({ error: `VM ID ${vm.vm_id} is already managed on this platform.` });
    }
    const templateId = String(req.body?.template_id || '').trim() || null;
    if (templateId && !db.db.prepare('SELECT 1 FROM tofu_proxmox_vm_templates WHERE id = ? AND environment_id = ?').get(templateId, environmentId)) {
      return res.status(400).json({ error: 'The selected VM template does not belong to this environment.' });
    }

    const vmId = randomUUID();
    const workspaceId = randomUUID();
    const workspacePath = path.join(internalVmRoot, vmId);
    if (!isAllowedPath(workspacePath)) return res.status(500).json({ error: 'The internal VM workspace root is outside the configured allowlist.' });
    const create = db.db.transaction(() => {
      db.db.prepare(`
        INSERT INTO tofu_workspaces
          (id, name, path, description, env_vars, environment_id, proxmox_connection_id, workspace_kind)
        VALUES (?, ?, ?, ?, '{}', ?, ?, 'isolated_vm')
      `).run(workspaceId, `vm-${vmId}`, workspacePath, `Internal OpenTofu unit for ${vm.name}`, environmentId, connectionId);
      db.db.prepare(`
        INSERT INTO tofu_proxmox_vms
          (id, workspace_id, name, config, connection_id, template_id, vm_numeric_id, is_isolated)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(vmId, workspaceId, vm.name, JSON.stringify(vm), connectionId, templateId, vm.vm_id);
      writeFleetProxmoxFiles(getWorkspace(workspaceId));
    });
    try {
      create();
      syncPathsFile();
      db.auditLog.write('tofu.vm_create', `vm=${vm.name} isolated=true`, req.ip, true, req.user?.username);
      res.status(201).json(publicVm(getVmRow(vmId), normalizeProxmoxVm));
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 500).json({ error: error.message });
    }
  });

  router.get('/vms/:vmId', (req, res) => {
    const row = getVmRow(req.params.vmId);
    if (!row) return res.status(404).json({ error: 'VM not found' });
    const vm = publicVm(row, normalizeProxmoxVm);
    res.json({ ...vm, post_deploy: getPostDeployOverview(row.workspace_id) });
  });

  router.get('/vms/:vmId/live', async (req, res) => {
    const row = getVmRow(req.params.vmId);
    if (!row) return res.status(404).json({ error: 'VM not found' });
    const vm = publicVm(row, normalizeProxmoxVm);
    if (!vm.vm_id) return res.json({ available: false, reason: 'The Proxmox VM ID is assigned during the first deployment.' });
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(vm.connection_id);
    if (!source) return res.json({ available: false, reason: 'The Proxmox platform connection is unavailable.' });
    try {
      const connection = readSavedProxmoxConnection(source);
      const config = await requestProxmoxApi(connection, `/nodes/${encodeURIComponent(vm.node_name)}/qemu/${encodeURIComponent(vm.vm_id)}/config`);
      const value = config && typeof config === 'object' ? config : {};
      const optionMap = raw => String(raw || '').split(',').reduce((result, item) => {
        const split = item.indexOf('=');
        if (split > 0) result[item.slice(0, split)] = item.slice(split + 1);
        return result;
      }, {});
      const diskEntry = Object.entries(value).find(([key, raw]) => /^(?:scsi|virtio|sata|ide)\d+$/.test(key) && typeof raw === 'string');
      const networkEntry = Object.entries(value).find(([key, raw]) => /^net\d+$/.test(key) && typeof raw === 'string');
      const ipEntry = Object.entries(value).find(([key, raw]) => /^ipconfig\d+$/.test(key) && typeof raw === 'string');
      const disk = optionMap(diskEntry?.[1]);
      const network = optionMap(networkEntry?.[1]);
      const ip = optionMap(ipEntry?.[1]);
      res.json({
        available: true,
        observed_at: new Date().toISOString(),
        name: value.name || vm.name,
        node_name: vm.node_name,
        vm_id: vm.vm_id,
        cpu_cores: Number(value.cores || 0),
        memory_mb: Number(value.memory || 0),
        disk_size_gb: Number.parseFloat(String(disk.size || '').replace(/G$/i, '')) || null,
        bridge: network.bridge || null,
        vlan_id: network.tag ? Number(network.tag) : null,
        ipv4_address: ip.ip || null,
        started: value.onboot === undefined ? null : value.onboot === 1 || value.onboot === '1',
      });
    } catch (error) {
      const status = Number(error.status || 0) === 404 ? 200 : (error.status || 502);
      res.status(status).json({ available: false, reason: Number(error.status || 0) === 404 ? 'The VM does not exist in Proxmox yet.' : (error.message || 'Live Proxmox configuration could not be loaded.') });
    }
  });

  router.put('/vms/:vmId', (req, res) => {
    const row = getVmRow(req.params.vmId);
    if (!row) return res.status(404).json({ error: 'VM not found' });
    let vm;
    try {
      vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess(vm.post_deploy_playbooks, req);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    if (vm.name !== row.name && db.db.prepare("SELECT 1 FROM tofu_runs WHERE workspace_id = ? AND action = 'apply' AND status = 'success'").get(row.workspace_id)) {
      return res.status(409).json({ error: 'A deployed VM cannot be renamed because its OpenTofu resource address is already in state.' });
    }
    if (vm.vm_id !== null && db.db.prepare('SELECT 1 FROM tofu_proxmox_vms WHERE connection_id = ? AND vm_numeric_id = ? AND id <> ?').get(row.connection_id, vm.vm_id, row.id)) {
      return res.status(409).json({ error: `VM ID ${vm.vm_id} is already managed on this platform.` });
    }
    const templateId = String(req.body?.template_id || row.template_id || '').trim() || null;
    if (templateId && !db.db.prepare('SELECT 1 FROM tofu_proxmox_vm_templates WHERE id = ? AND environment_id = ?').get(templateId, row.environment_id)) {
      return res.status(400).json({ error: 'The selected VM template does not belong to this environment.' });
    }
    try {
      db.db.prepare("UPDATE tofu_proxmox_vms SET name = ?, config = ?, template_id = ?, vm_numeric_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(vm.name, JSON.stringify(vm), templateId, vm.vm_id, row.id);
      writeFleetProxmoxFiles(getWorkspace(row.workspace_id));
      res.json(publicVm(getVmRow(row.id), normalizeProxmoxVm));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post('/vms/:vmId/forget', (req, res) => {
    const row = getVmRow(req.params.vmId);
    if (!row) return res.status(404).json({ error: 'VM not found' });
    if (req.body?.confirmation !== `FORGET ${row.name}`) return res.status(400).json({ error: `Confirm with "FORGET ${row.name}".` });
    if (db.db.prepare("SELECT 1 FROM tofu_runs WHERE workspace_id = ? AND status IN ('running', 'cancelling')").get(row.workspace_id)) {
      return res.status(409).json({ error: 'The VM cannot be unmanaged while an OpenTofu operation is running.' });
    }
    const workspace = getWorkspace(row.workspace_id);
    const statePath = path.join(workspace.path, 'terraform.tfstate');
    const binary = findBinary();
    try {
      ensureWorkspacePath(workspace);
      if (fs.existsSync(statePath)) {
        if (!binary) throw new Error('OpenTofu is required to detach a VM that has state.');
        backupLocalState(workspace, 'before-forget');
        const address = `proxmox_virtual_environment_vm.${row.name}`;
        const listed = execFileSync(binary, ['state', 'list', '-no-color'], { cwd: workspace.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 15_000 });
        if (listed.split(/\r?\n/).includes(address)) {
          execFileSync(binary, ['state', 'rm', address], { cwd: workspace.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 30_000 });
        }
      }
      const remove = db.db.transaction(() => {
        db.db.prepare('DELETE FROM tofu_proxmox_playbook_runs WHERE workspace_id = ? AND vm_id = ?').run(row.workspace_id, row.id);
        db.db.prepare('DELETE FROM tofu_managed_servers WHERE workspace_id = ?').run(row.workspace_id);
        db.db.prepare('DELETE FROM tofu_runs WHERE workspace_id = ?').run(row.workspace_id);
        db.db.prepare('DELETE FROM tofu_proxmox_vms WHERE id = ?').run(row.id);
        db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run(row.workspace_id);
      });
      remove();
      syncPathsFile();
      db.auditLog.write('tofu.vm_forget', `vm=${row.name} infrastructure_kept=true`, req.ip, true, req.user?.username);
      res.json({ success: true, infrastructure_kept: true, workspace_files_kept: true });
    } catch (error) {
      db.auditLog.write('tofu.vm_forget', `vm=${row.name} error=${error.message}`, req.ip, false, req.user?.username);
      res.status(500).json({ error: error.message });
    }
  });

  // Reuse the mature run/state/catalog implementation while keeping workspace
  // identifiers and paths out of the public contract.
  const rewrite = (suffix, bodyAction = null) => (req, res, next) => {
    const row = getVmRow(req.params.vmId);
    if (!row) return res.status(404).json({ error: 'VM not found' });
    if (bodyAction) req.body = { ...(req.body || {}), action: bodyAction };
    req.url = `/workspaces/${encodeURIComponent(row.workspace_id)}${suffix}`;
    next();
  };
  router.post('/vms/:vmId/plan', rewrite('/run', 'plan'));
  router.post('/vms/:vmId/apply', rewrite('/run', 'apply'));
  router.post('/vms/:vmId/check-drift', rewrite('/run', 'drift'));
  router.post('/vms/:vmId/destroy', (req, _res, next) => {
    req.body = { ...(req.body || {}), confirm_destroy: req.body?.confirmation, vm_id: req.params.vmId, action: 'destroy_vm' };
    next();
  }, rewrite('/run'));
  router.get('/vms/:vmId/runs', rewrite('/runs'));
  router.get('/vms/:vmId/runs/:runId', (req, res, next) => rewrite(`/runs/${encodeURIComponent(req.params.runId)}`)(req, res, next));
  router.get('/vms/:vmId/state', rewrite('/state'));
  router.get('/vms/:vmId/actual', rewrite('/resources-overview'));
  router.get('/vms/:vmId/catalog', rewrite('/proxmox-catalog'));

  router.get('/vm-templates', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    const rows = db.db.prepare('SELECT * FROM tofu_proxmox_vm_templates WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId);
    res.json({ templates: rows.map(row => {
      try { return { id: row.id, name: row.name, connection_id: row.connection_id || null, config: normalizeProxmoxVm(JSON.parse(row.config)) }; }
      catch { return null; }
    }).filter(Boolean) });
  });

  router.post('/vm-templates', (req, res) => {
    const environmentId = String(req.body?.environment_id || '').trim();
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess(template.config.post_deploy_playbooks, req);
      if (db.db.prepare('SELECT 1 FROM tofu_proxmox_vm_templates WHERE environment_id = ? AND name = ? COLLATE NOCASE').get(environmentId, template.name)) {
        return res.status(409).json({ error: 'A template with this name already exists in the environment.' });
      }
      const id = randomUUID();
      db.db.prepare('INSERT INTO tofu_proxmox_vm_templates (id, workspace_id, environment_id, connection_id, name, config) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, `environment:${environmentId}`, environmentId, req.body?.connection_id || null, template.name, JSON.stringify(template.config));
      res.status(201).json({ template: { id, ...template, environment_id, connection_id: req.body?.connection_id || null } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.put('/vm-templates/:templateId', (req, res) => {
    const existing = db.db.prepare('SELECT * FROM tofu_proxmox_vm_templates WHERE id = ?').get(req.params.templateId);
    if (!existing) return res.status(404).json({ error: 'VM template not found' });
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess(template.config.post_deploy_playbooks, req);
      const environmentId = existing.environment_id || String(req.body?.environment_id || 'default');
      if (db.db.prepare('SELECT 1 FROM tofu_proxmox_vm_templates WHERE environment_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(environmentId, template.name, existing.id)) {
        return res.status(409).json({ error: 'A template with this name already exists in the environment.' });
      }
      db.db.prepare("UPDATE tofu_proxmox_vm_templates SET name = ?, config = ?, connection_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(template.name, JSON.stringify(template.config), req.body?.connection_id || existing.connection_id || null, existing.id);
      res.json({ template: { id: existing.id, ...template, environment_id: environmentId, connection_id: req.body?.connection_id || existing.connection_id || null } });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.delete('/vm-templates/:templateId', (req, res) => {
    const result = db.db.prepare('DELETE FROM tofu_proxmox_vm_templates WHERE id = ?').run(req.params.templateId);
    if (!result.changes) return res.status(404).json({ error: 'VM template not found' });
    db.db.prepare('UPDATE tofu_proxmox_vms SET template_id = NULL WHERE template_id = ?').run(req.params.templateId);
    res.json({ success: true });
  });
}

module.exports = { publicVm, registerIsolatedVmRoutes };
