'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');
const log = require('../../../utils/logger').child('features:opentofu:vms');
const { can, filterServers, getPermissions } = require('../../../utils/permissions');
const {
  buildProxmoxResourceOverview,
  normalizeProxmoxVm,
  normalizeProxmoxVmTemplate,
} = require('../proxmox-blueprints');
const { readProxmoxConnection, requestProxmoxApi } = require('../proxmox-client');
const { loadWorkspaceState } = require('../managed-servers');

function snapshotNameOrError(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
    const error = new Error('Invalid snapshot name.'); error.status = 400; throw error;
  }
  return name;
}

/** Register deployment VM definitions and linked-host operations. */
function registerVmRoutes({ db, router, ensureWorkspacePath, findBinary, getPostDeployOverview, getProxmoxVmTemplates, getProxmoxVms, getWorkspace, getInfrastructureSummary, listProxmoxConnectionRows, loadProxmoxCatalog, loadProxmoxInfrastructure, permissionError, readSavedProxmoxConnection, runPostDeployPlaybooks, syncFleetWorkspace, validatePostDeployPlaybookAccess, writeFleetProxmoxFiles }) {
  function legacyWorkspaceOrError(workspace, res) {
    if (workspace?.workspace_kind !== 'isolated_vm') return true;
    res.status(410).json({ error: 'This VM is managed through the VM API; its internal workspace is not user-editable.' });
    return false;
  }
  function getProxmoxConnectionSource(id) {
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(id);
    if (!source) {
      const error = new Error('Proxmox platform not found.'); error.status = 404; throw error;
    }
    return { source, connection: readSavedProxmoxConnection(source) };
  }

  // ── Routes: Shipyard Proxmox VM form ────────────────────────────────────────
  
  router.get('/workspaces/:id/proxmox-catalog', async (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      res.json(await loadProxmoxCatalog(workspace, req.query.node));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Proxmox catalog could not be loaded' });
    }
  });
  
  router.get('/infrastructure', async (_req, res) => {
    try {
      const environmentId = String(_req.query.environment_id || '').trim();
      if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
      if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
      res.json(await loadProxmoxInfrastructure(environmentId));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Proxmox inventory could not be loaded.' });
    }
  });

  // Compact, persisted navigation snapshot. A stale snapshot is returned
  // immediately while a lightweight Proxmox tree refreshes in the background;
  // the first request waits so an unknown state is never reported as an empty
  // installation.
  router.get('/infrastructure-summary', async (req, res) => {
    try {
      const environmentId = String(req.query.environment_id || '').trim();
      if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
      if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
      res.set('Cache-Control', 'private, no-cache');
      res.json(await getInfrastructureSummary(environmentId));
    } catch (error) {
      res.status(502).json({ error: error.message || 'Proxmox inventory summary could not be loaded.' });
    }
  });
  
  router.get('/workspaces/:id/proxmox-vms', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({
      vms: getProxmoxVms(workspace.id),
      generated_files: ['fleet-proxmox-provider.tf', 'fleet-proxmox-variables.tf', 'fleet-proxmox-vms.tf'],
    });
  });
  
  function getManagedProxmoxVmForServer(serverId, req, { requireEdit = false } = {}) {
    const permissions = getPermissions(req.user);
    if (!can(permissions, requireEdit ? 'canEditServers' : 'canViewServers')) {
      const error = new Error('Permission denied'); error.status = 403; throw error;
    }
    const accessible = filterServers(db.servers.getAll(), permissions).some(server => server.id === serverId);
    if (!accessible) {
      const error = new Error('Server not found'); error.status = 404; throw error;
    }
    const mappings = db.db.prepare(`
      SELECT mapping.workspace_id, mapping.resource_key, workspace.name AS workspace_name
      FROM tofu_managed_servers mapping
      JOIN tofu_workspaces workspace ON workspace.id = mapping.workspace_id
      WHERE mapping.server_id = ? AND mapping.resource_key LIKE 'resource:proxmox_virtual_environment_vm.%'
      ORDER BY workspace.name COLLATE NOCASE
      LIMIT 1
    `).all(serverId);
    const mapping = mappings[0];
    if (!mapping) {
      const imported = db.db.prepare(`
        SELECT inventory.server_id, inventory.connection_id, inventory.node_name, inventory.vm_id, source.name AS source_name
        FROM proxmox_inventory_servers inventory
        JOIN tofu_proxmox_connections source ON source.id = inventory.connection_id
        WHERE inventory.server_id = ?
      `).get(serverId);
      if (!imported) {
        const error = new Error('This server has no Proxmox VM mapping.'); error.status = 404; throw error;
      }
      const { connection } = getProxmoxConnectionSource(imported.connection_id);
      return {
        mapping: { workspace_id: null, workspace_name: null, source_name: imported.source_name },
        vm: { name: db.servers.getById(serverId)?.name || `VM ${imported.vm_id}`, node_name: imported.node_name, vm_id: imported.vm_id },
        connection,
      };
    }
    const vmName = String(mapping.resource_key).replace(/^resource:proxmox_virtual_environment_vm\./, '');
    const vm = getProxmoxVms(mapping.workspace_id).find(item => item.name === vmName);
    if (!vm?.node_name || !vm.vm_id) {
      const error = new Error('The Proxmox VM definition is incomplete. Node and VM ID are required.'); error.status = 409; throw error;
    }
    const workspace = getWorkspace(mapping.workspace_id);
    if (!workspace) {
      const error = new Error('The associated deployment is unavailable.'); error.status = 404; throw error;
    }
    return { mapping, vm, connection: readProxmoxConnection(workspace.env_vars) };
  }
  
  router.get('/managed-servers/:serverId/snapshots', async (req, res) => {
    try {
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req);
      const snapshots = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/snapshot`);
      res.json({
        workspace_id: target.mapping.workspace_id,
        workspace_name: target.mapping.workspace_name,
        node_name: target.vm.node_name,
        vm_id: target.vm.vm_id,
        snapshots: Array.isArray(snapshots) ? snapshots.filter(snapshot => snapshot?.name !== 'current') : [],
      });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'Snapshots could not be loaded.' });
    }
  });
  
  router.post('/managed-servers/:serverId/snapshots', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim().slice(0, 512);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
      return res.status(400).json({ error: 'Der Snapshot-Name darf 1–40 Zeichen (Buchstaben, Zahlen, Punkt, Unterstrich, Bindestrich) enthalten.' });
    }
    try {
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req, { requireEdit: true });
      const upid = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/snapshot`, {
        method: 'POST',
        payload: { snapname: name, description, vmstate: 1 },
      });
      db.auditLog.write('tofu.snapshot_create', `workspace=${target.mapping.workspace_name} vm=${target.vm.name} vm_id=${target.vm.vm_id} snapshot=${name}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, task: upid, name });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'The snapshot could not be created.' });
    }
  });
  
  router.delete('/managed-servers/:serverId/snapshots/:snapshotName', async (req, res) => {
    try {
      const name = snapshotNameOrError(req.params.snapshotName);
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req, { requireEdit: true });
      const task = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/snapshot/${encodeURIComponent(name)}`, { method: 'DELETE' });
      db.auditLog.write('infrastructure.snapshot_delete', `source=${target.mapping.source_name || target.mapping.workspace_name || 'unknown'} vm=${target.vm.name || target.vm.vm_id} vm_id=${target.vm.vm_id} snapshot=${name}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, task, name });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'The snapshot could not be deleted.' });
    }
  });
  
  // Power operations stay deliberately small and explicit. They act on the
  // already linked Proxmox VM and never synthesize or mutate OpenTofu state.
  router.post('/managed-servers/:serverId/power', async (req, res) => {
    if (!can(getPermissions(req.user), 'canRebootServers')) return res.status(403).json({ error: 'Permission denied' });
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (!['start', 'shutdown', 'reboot', 'stop'].includes(action)) return res.status(400).json({ error: 'Invalid Proxmox action.' });
    try {
      const target = getManagedProxmoxVmForServer(String(req.params.serverId || ''), req, { requireEdit: true });
      const task = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.vm.node_name)}/qemu/${encodeURIComponent(target.vm.vm_id)}/status/${action}`, { method: 'POST' });
      db.auditLog.write('infrastructure.vm_power', `action=${action} source=${target.mapping.source_name || target.mapping.workspace_name || 'unknown'} vm=${target.vm.name || target.vm.vm_id} vm_id=${target.vm.vm_id}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, action, task });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'The Proxmox action could not be started.' });
    }
  });
  
  // The server detail remains the operational source of truth. This small
  // lookup only adds deployment context and deliberately never exposes a
  // workspace's credentials or state file to the browser.
  router.get('/managed-servers/:serverId', (req, res) => {
    if (!can(getPermissions(req.user), 'canViewServers')) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const serverId = String(req.params.serverId || '').trim();
    if (!serverId) return res.status(400).json({ error: 'Server ID is required' });
    if (!filterServers(db.servers.getAll(), getPermissions(req.user)).some(server => server.id === serverId)) {
      return res.status(404).json({ error: 'Server not found' });
    }
    const mappings = db.db.prepare(`
      SELECT mapping.workspace_id, mapping.resource_key, workspace.name AS workspace_name
      FROM tofu_managed_servers mapping
      JOIN tofu_workspaces workspace ON workspace.id = mapping.workspace_id
      WHERE mapping.server_id = ?
      ORDER BY workspace.name COLLATE NOCASE
    `).all(serverId);
    const resources = mappings.map(mapping => {
      const vmName = String(mapping.resource_key || '').replace(/^resource:proxmox_virtual_environment_vm\./, '');
      const vm = getProxmoxVms(mapping.workspace_id).find(item => item.name === vmName);
      const workspace = getWorkspace(mapping.workspace_id);
      let clusterId = null;
      let connectionId = null;
      try {
        const connection = workspace ? readProxmoxConnection(workspace.env_vars) : null;
        clusterId = connection ? `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}` : null;
        // A workspace can retain legacy credentials, but operational actions
        // must use a registered platform connection. Match it by normalized
        // endpoint so the UI only offers a deep VM link when it is actionable.
        const matchingConnection = connection && workspace
          ? listProxmoxConnectionRows(workspace.environment_id).find(row => {
            try {
              const saved = readSavedProxmoxConnection(row);
              return `${saved.base.origin}${saved.base.pathname.replace(/\/+$/, '')}` === clusterId;
            } catch { return false; }
          })
          : null;
        connectionId = matchingConnection?.id || null;
      } catch {
        // The deployment linkage stays useful even if its legacy connection is
        // no longer configured. Do not turn the whole host detail into a 500.
      }
      return {
        workspace_id: mapping.workspace_id,
        workspace_name: mapping.workspace_name,
        resource_key: mapping.resource_key,
        cluster_id: clusterId,
        connection_id: connectionId,
        vm: vm ? {
          id: vm.id,
          name: vm.name,
          node_name: vm.node_name,
          vm_id: vm.vm_id,
          post_deploy_playbooks: vm.post_deploy_playbooks || [],
        } : null,
      };
    });
    const adopted = db.db.prepare(`
      SELECT inventory.connection_id, inventory.node_name, inventory.vm_id, source.name AS source_name
      FROM proxmox_inventory_servers inventory
      JOIN tofu_proxmox_connections source ON source.id = inventory.connection_id
      WHERE inventory.server_id = ?
    `).get(serverId);
    if (adopted) {
      const server = db.servers.getById(serverId);
      let clusterId = null;
      let connectionId = null;
      try {
        const { connection } = getProxmoxConnectionSource(adopted.connection_id);
        clusterId = `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}`;
        connectionId = adopted.connection_id;
      } catch {
        // A removed connection is rendered as an unavailable link in the UI.
      }
      resources.push({
        workspace_id: null,
        workspace_name: adopted.source_name,
        resource_key: `inventory:proxmox:${adopted.connection_id}:${adopted.node_name}:${adopted.vm_id}`,
        kind: 'inventory',
        cluster_id: clusterId,
        connection_id: connectionId,
        vm: { name: server?.name || `VM ${adopted.vm_id}`, node_name: adopted.node_name, vm_id: adopted.vm_id, post_deploy_playbooks: [] },
      });
    }
    res.json({ resources });
  });
  
  router.get('/workspaces/:id/deployment-summary', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vms = getProxmoxVms(workspace.id);
    const postDeploy = getPostDeployOverview(workspace.id);
    res.json({
      vm_count: vms.length,
      started_vm_count: vms.filter(vm => vm.started).length,
      post_deploy: postDeploy,
      resources: vms.map(vm => ({
        id: vm.id, name: vm.name, node_name: vm.node_name, vm_id: vm.vm_id,
        cpu_cores: vm.cpu_cores, memory_mb: vm.memory_mb, disk_size_gb: vm.disk_size_gb,
      })),
    });
  });
  
  router.post('/workspaces/:id/post-deploy/retry', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vmId = String(req.body?.vm_id || '').trim();
    const playbook = String(req.body?.playbook || '').trim();
    const vm = getProxmoxVms(workspace.id).find(item => item.id === vmId);
    if (!vm || !vm.post_deploy_playbooks.includes(playbook)) return res.status(404).json({ error: 'Post-deploy step not found' });
    try {
      validatePostDeployPlaybookAccess([playbook], req);
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    db.db.prepare(`
      INSERT INTO tofu_proxmox_playbook_runs (workspace_id, vm_id, playbook, status, output, updated_at)
      VALUES (?, ?, ?, 'running', '', datetime('now'))
      ON CONFLICT(workspace_id, vm_id, playbook) DO UPDATE SET
        status = 'running', output = '', completed_at = NULL, updated_at = datetime('now')
    `).run(workspace.id, vm.id, playbook);
    res.status(202).json({ accepted: true });
  
    // This is intentionally decoupled from a full tofu apply: the VM has
    // already been reconciled and Shipyard can safely rerun just this bootstrap
    // step against its managed server mapping.
    setImmediate(() => runPostDeployPlaybooks({
      workspace,
      syncedServers: [{ resource_key: `resource:proxmox_virtual_environment_vm.${vm.name}` }],
      logMeta: { ip: req.ip, user: req.user?.username },
      emitMeta: () => {},
      onlyVmId: vm.id,
      onlyPlaybook: playbook,
      force: true,
    }).catch(error => log.error({ err: error, workspace: workspace.name, vm: vm.name, playbook }, 'Post-deploy retry failed')));
  });
  
  router.get('/workspaces/:id/proxmox-vm-templates', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ templates: getProxmoxVmTemplates(workspace.id) });
  });
  
  router.post('/workspaces/:id/proxmox-vm-templates', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess([...(template.config.pre_deploy_playbooks || []), ...(template.config.post_deploy_playbooks || [])], req);
      const id = randomUUID();
      db.db.prepare('INSERT INTO tofu_proxmox_vm_templates (id, workspace_id, name, config) VALUES (?, ?, ?, ?)')
        .run(id, workspace.id, template.name, JSON.stringify(template.config));
      res.status(201).json({ template: { ...template, id } });
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });
  
  router.put('/workspaces/:id/proxmox-vm-templates/:templateId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const existing = db.db.prepare('SELECT id FROM tofu_proxmox_vm_templates WHERE id = ? AND workspace_id = ?')
      .get(req.params.templateId, workspace.id);
    if (!existing) return res.status(404).json({ error: 'VM template not found' });
    try {
      const template = normalizeProxmoxVmTemplate(req.body || {});
      validatePostDeployPlaybookAccess([...(template.config.pre_deploy_playbooks || []), ...(template.config.post_deploy_playbooks || [])], req);
      db.db.prepare("UPDATE tofu_proxmox_vm_templates SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(template.name, JSON.stringify(template.config), existing.id, workspace.id);
      res.json({ template: { ...template, id: existing.id } });
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });
  
  router.delete('/workspaces/:id/proxmox-vm-templates/:templateId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const result = db.db.prepare('DELETE FROM tofu_proxmox_vm_templates WHERE id = ? AND workspace_id = ?')
      .run(req.params.templateId, workspace.id);
    if (!result.changes) return res.status(404).json({ error: 'VM template not found' });
    res.json({ success: true });
  });
  
  router.post('/workspaces/:id/proxmox-vms', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: permissionError(mkdirErr, workspace.path) });
    try {
      const vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess([...(vm.pre_deploy_playbooks || []), ...(vm.post_deploy_playbooks || [])], req);
      if (vm.vm_id !== null && getProxmoxVms(workspace.id).some(existing => existing.vm_id === vm.vm_id)) {
        return res.status(409).json({ error: `VM ID ${vm.vm_id} is already defined in this workspace.` });
      }
      const id = randomUUID();
      db.db.prepare('INSERT INTO tofu_proxmox_vms (id, workspace_id, name, config) VALUES (?, ?, ?, ?)')
        .run(id, workspace.id, vm.name, JSON.stringify(vm));
      const generated = writeFleetProxmoxFiles(workspace);
      res.status(201).json({ vm: { ...vm, id }, generated_files: generated.files });
      syncFleetWorkspace(workspace, `Add Shipyard Proxmox VM ${vm.name}`);
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });
  
  router.put('/workspaces/:id/proxmox-vms/:vmId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const existing = db.db.prepare('SELECT id FROM tofu_proxmox_vms WHERE id = ? AND workspace_id = ?').get(req.params.vmId, workspace.id);
    if (!existing) return res.status(404).json({ error: 'VM definition not found' });
    try {
      const vm = normalizeProxmoxVm(req.body || {});
      validatePostDeployPlaybookAccess([...(vm.pre_deploy_playbooks || []), ...(vm.post_deploy_playbooks || [])], req);
      if (vm.vm_id !== null && getProxmoxVms(workspace.id).some(item => item.id !== existing.id && item.vm_id === vm.vm_id)) {
        return res.status(409).json({ error: `VM ID ${vm.vm_id} is already defined in this workspace.` });
      }
      db.db.prepare("UPDATE tofu_proxmox_vms SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
        .run(vm.name, JSON.stringify(vm), existing.id, workspace.id);
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ vm: { ...vm, id: existing.id }, generated_files: generated.files });
      syncFleetWorkspace(workspace, `Update Shipyard Proxmox VM ${vm.name}`);
    } catch (error) {
      res.status(/UNIQUE constraint failed/.test(error.message) ? 409 : 400).json({ error: error.message });
    }
  });
  
  router.delete('/workspaces/:id/proxmox-vms/:vmId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const result = db.db.prepare('DELETE FROM tofu_proxmox_vms WHERE id = ? AND workspace_id = ?').run(req.params.vmId, workspace.id);
    if (!result.changes) return res.status(404).json({ error: 'VM definition not found' });
    try {
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ success: true, generated_files: generated.files });
      syncFleetWorkspace(workspace, 'Remove Shipyard Proxmox VM');
    } catch (error) {
      res.status(500).json({ error: permissionError(error, workspace.path) });
    }
  });
  
  router.post('/workspaces/:id/proxmox-vms/regenerate', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!legacyWorkspaceOrError(workspace, res)) return;
    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: permissionError(mkdirErr, workspace.path) });
    try {
      const generated = writeFleetProxmoxFiles(workspace);
      res.json({ success: true, generated_files: generated.files, count: generated.vms.length });
      syncFleetWorkspace(workspace, 'Regenerate Shipyard Proxmox files');
    } catch (error) {
      res.status(500).json({ error: permissionError(error, workspace.path) });
    }
  });
  
  router.get('/workspaces/:id/resources-overview', async (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const vms = getProxmoxVms(workspace.id);
    const binary = findBinary();
    if (!binary || !fs.existsSync(workspace.path)) {
      return res.json({ ...buildProxmoxResourceOverview(vms), actual: { available: false, vm_count: 0, resources: [], reason: binary ? 'Workspace path is unavailable' : 'OpenTofu binary is not installed' } });
    }
    const managedServersByVm = new Map();
    if (workspace.proxmox_connection_id) {
      const rows = db.db.prepare(`
        SELECT inventory.node_name, inventory.vm_id, inventory.server_id, servers.hostname
        FROM proxmox_inventory_servers inventory
        JOIN servers ON servers.id = inventory.server_id
        WHERE inventory.connection_id = ?
      `).all(workspace.proxmox_connection_id);
      for (const row of rows) managedServersByVm.set(`${row.node_name}:${row.vm_id}`, row);
    }
    try {
      const state = await loadWorkspaceState({ binary, workspace, env: { ...process.env, ...workspace.env_vars } });
      res.json(buildProxmoxResourceOverview(vms, state, managedServersByVm));
    } catch (error) {
      const overview = buildProxmoxResourceOverview(vms);
      overview.actual.reason = String(error.stderr || error.stdout || error.message || 'No state available').trim();
      res.json(overview);
    }
  });
  
  
}

module.exports = { registerVmRoutes };
