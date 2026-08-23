'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { buildProxmoxProviderFiles } = require('../proxmox-blueprints');
const { validateIsolatedVmPlan } = require('../run-safety');

function writeProspectiveVmFiles(directory, vm) {
  const files = buildProxmoxProviderFiles([vm]);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fleet-proxmox-provider.tf'), files.provider, 'utf8');
  fs.writeFileSync(path.join(directory, 'fleet-proxmox-variables.tf'), files.variables, 'utf8');
  fs.writeFileSync(path.join(directory, 'fleet-proxmox-vms.tf'), files.vms, 'utf8');
  fs.writeFileSync(path.join(directory, '.gitignore'), '.local/\n.terraform/\n*.tfstate*\n.shipyard/plans/\n', 'utf8');
}

/** Explicit, local-state-only splitter for legacy multi-VM workspaces. */
function registerLegacyVmMigrationRoutes({ db, router, backupLocalState, findBinary, getProxmoxVms, getWorkspace, internalVmRoot, isAllowedPath, syncPathsFile, workspaceBackendType }) {
  router.get('/legacy-workspaces', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    const rows = db.db.prepare(`
      SELECT workspace.id, workspace.name, workspace.migration_status, workspace.read_only,
             COUNT(vm.id) AS vm_count
      FROM tofu_workspaces workspace
      JOIN tofu_proxmox_vms vm ON vm.workspace_id = workspace.id
      WHERE workspace.environment_id = ? AND workspace.workspace_kind = 'legacy'
      GROUP BY workspace.id
      ORDER BY workspace.name COLLATE NOCASE
    `).all(environmentId);
    res.json(rows.map(row => ({ ...row, vm_count: Number(row.vm_count), migration_required: true })));
  });

  router.post('/legacy-workspaces/:id/migrate-vms', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace || workspace.workspace_kind !== 'legacy') return res.status(404).json({ error: 'Legacy workspace not found' });
    if (req.body?.confirmation !== `MIGRATE ${workspace.name}`) return res.status(400).json({ error: `Confirm with "MIGRATE ${workspace.name}".` });
    if (db.db.prepare("SELECT 1 FROM tofu_runs WHERE status IN ('running', 'cancelling') LIMIT 1").get()) {
      return res.status(409).json({ error: 'Stop all OpenTofu runs before migrating legacy state.' });
    }
    if (workspaceBackendType(workspace) !== 'local') {
      return res.status(409).json({ error: 'Remote-backend migration requires a backend-specific state move and cannot use the local-state migration assistant.' });
    }
    if (!workspace.proxmox_connection_id) {
      return res.status(409).json({ error: 'Promote the legacy Proxmox credentials to an environment platform connection before splitting VM states.' });
    }
    const vms = getProxmoxVms(workspace.id);
    if (!vms.length) return res.status(409).json({ error: 'The workspace has no Shipyard VM definitions to migrate.' });
    const binary = findBinary();
    const originalStatePath = path.join(workspace.path, 'terraform.tfstate');
    const hasState = fs.existsSync(originalStatePath);
    if (hasState && !binary) return res.status(503).json({ error: 'OpenTofu is required to split the existing state.' });

    const migrationId = randomUUID();
    const scratchRoot = path.join(workspace.path, '.shipyard', 'migration', migrationId);
    const workingState = path.join(scratchRoot, 'remaining.tfstate');
    const originalState = hasState ? fs.readFileSync(originalStatePath) : null;
    const units = vms.map(vm => ({ vm, workspaceId: randomUUID(), path: path.join(internalVmRoot, vm.id) }));
    if (units.some(unit => !isAllowedPath(unit.path))) return res.status(500).json({ error: 'An internal VM path is outside the configured workspace roots.' });
    if (units.some(unit => fs.existsSync(unit.path))) {
      return res.status(409).json({ error: 'A target VM directory already exists from an earlier migration attempt. Review it before retrying.' });
    }

    try {
      db.db.prepare("UPDATE tofu_workspaces SET migration_status = 'running', read_only = 1 WHERE id = ?").run(workspace.id);
      fs.mkdirSync(scratchRoot, { recursive: true });
      if (hasState) {
        backupLocalState(workspace, 'before-vm-isolation-migration');
        fs.copyFileSync(originalStatePath, workingState);
        const listed = execFileSync(binary, ['state', 'list', `-state=${workingState}`, '-no-color'], { cwd: workspace.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 30_000 })
          .trim().split(/\r?\n/).filter(Boolean);
        const expected = new Set(vms.map(vm => `proxmox_virtual_environment_vm.${vm.name}`));
        const unsupported = listed.filter(address => !expected.has(address));
        const missing = [...expected].filter(address => !listed.includes(address));
        if (unsupported.length || missing.length) throw new Error(`State migration requires exactly the Shipyard VM resources. Unsupported: ${unsupported.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}.`);
      }

      for (const unit of units) {
        writeProspectiveVmFiles(unit.path, unit.vm);
        if (!hasState) continue;
        const targetState = path.join(unit.path, 'terraform.tfstate');
        const address = `proxmox_virtual_environment_vm.${unit.vm.name}`;
        execFileSync(binary, ['state', 'mv', `-state=${workingState}`, `-state-out=${targetState}`, address, address], { cwd: workspace.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 60_000 });
        execFileSync(binary, ['init', '-input=false', '-no-color'], { cwd: unit.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
        const planPath = path.join(scratchRoot, `${unit.vm.id}.tfplan`);
        execFileSync(binary, ['plan', '-input=false', '-no-color', `-out=${planPath}`], { cwd: unit.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
        const planJson = JSON.parse(execFileSync(binary, ['show', '-json', planPath], { cwd: unit.path, env: { ...process.env, ...workspace.env_vars }, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }));
        const validation = validateIsolatedVmPlan(planJson, unit.vm);
        if (!validation.safe) throw new Error(`VM ${unit.vm.name} failed isolation validation: ${validation.error}`);
        const lifecycleChange = (planJson.resource_changes || []).some(change => (change.change?.actions || []).some(action => action === 'create' || action === 'delete'));
        if (lifecycleChange) throw new Error(`VM ${unit.vm.name} would be created, deleted, or replaced after state migration.`);
      }

      if (hasState) fs.renameSync(workingState, originalStatePath);
      const migrateDatabase = db.db.transaction(() => {
        for (const unit of units) {
          db.db.prepare(`INSERT INTO tofu_workspaces (id, name, path, description, env_vars, environment_id, proxmox_connection_id, workspace_kind)
            VALUES (?, ?, ?, ?, '{}', ?, ?, 'isolated_vm')`)
            .run(unit.workspaceId, `vm-${unit.vm.id}`, unit.path, `Migrated internal OpenTofu unit for ${unit.vm.name}`, workspace.environment_id, workspace.proxmox_connection_id);
          db.db.prepare(`UPDATE tofu_proxmox_vms SET workspace_id = ?, connection_id = ?, vm_numeric_id = ?, is_isolated = 1, updated_at = datetime('now') WHERE id = ?`)
            .run(unit.workspaceId, workspace.proxmox_connection_id, unit.vm.vm_id, unit.vm.id);
          db.db.prepare('UPDATE tofu_proxmox_playbook_runs SET workspace_id = ? WHERE workspace_id = ? AND vm_id = ?').run(unit.workspaceId, workspace.id, unit.vm.id);
          db.db.prepare('UPDATE tofu_managed_servers SET workspace_id = ? WHERE workspace_id = ? AND resource_key = ?')
            .run(unit.workspaceId, workspace.id, `resource:proxmox_virtual_environment_vm.${unit.vm.name}`);
        }
        db.db.prepare("UPDATE tofu_workspaces SET workspace_kind = 'legacy_migrated', migration_status = 'complete', read_only = 1 WHERE id = ?").run(workspace.id);
      });
      migrateDatabase();
      syncPathsFile();
      try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
      db.auditLog.write('tofu.legacy_vm_migrate', `workspace=${workspace.name} vms=${units.length} state_split=${hasState}`, req.ip, true, req.user?.username);
      res.json({ success: true, migrated_vms: units.map(unit => ({ id: unit.vm.id, name: unit.vm.name })), legacy_workspace_archived: true });
    } catch (error) {
      if (originalState) fs.writeFileSync(originalStatePath, originalState, { mode: 0o600 });
      for (const unit of units) {
        try { fs.rmSync(unit.path, { recursive: true, force: true }); } catch {}
      }
      try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
      db.db.prepare("UPDATE tofu_workspaces SET migration_status = 'failed', read_only = 0 WHERE id = ?").run(workspace.id);
      db.auditLog.write('tofu.legacy_vm_migrate', `workspace=${workspace.name} error=${error.message}`, req.ip, false, req.user?.username);
      res.status(409).json({ error: error.message, state_backup_kept: hasState });
    }
  });
}

module.exports = { registerLegacyVmMigrationRoutes, writeProspectiveVmFiles };
