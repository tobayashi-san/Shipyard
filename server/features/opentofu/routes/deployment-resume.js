'use strict';
const { filterServers, getPermissions } = require('../../../utils/permissions');

function registerDeploymentResumeRoutes({router, db, getWorkspace, getProxmoxVms, validatePostDeployPlaybookAccess, findBinary, redactTofuOutput, finishHostDeployment}) {
  router.post('/workspaces/:id/resume', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Deployment not found' });
    const run = db.db.prepare("SELECT * FROM tofu_runs WHERE workspace_id = ? AND action IN ('apply', 'destroy') ORDER BY started_at DESC, rowid DESC LIMIT 1").get(workspace.id);
    if (!run || run.action !== 'apply' || !run.vm_provisioned || !['failed', 'interrupted'].includes(run.status)) return res.status(409).json({ error: 'No deployed VM is awaiting completion.' });
    if (db.db.prepare("SELECT 1 FROM tofu_workspaces WHERE migration_status = 'running' LIMIT 1").get()) return res.status(409).json({ error: 'A state migration is running. Retry after it finishes.' });
    try {
      validatePostDeployPlaybookAccess(getProxmoxVms(workspace.id).flatMap(vm => vm.post_deploy_playbooks || []), req);
      const accessible = new Set(filterServers(db.servers.getAll(), getPermissions(req.user)).map(host => host.id));
      const mappings = db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ?').all(workspace.id);
      if (mappings.some(mapping => !accessible.has(mapping.server_id))) return res.status(403).json({ error: 'A deployment host is outside your access scope.' });
    } catch (error) { return res.status(403).json({ error: error.message }); }
    const binary = findBinary();
    if (!binary) return res.status(503).json({ error: 'OpenTofu is unavailable. Restore the executable and retry completion.' });
    try {
      db.db.prepare("UPDATE tofu_runs SET status = 'running', completed_at = NULL WHERE id = ?").run(run.id);
    } catch { return res.status(409).json({ error: 'Another deployment operation is active.' }); }
    const emitMeta = message => db.db.prepare('UPDATE tofu_runs SET output = output || ? WHERE id = ?').run(`\n${redactTofuOutput(message, workspace.env_vars)}\n`, run.id);
    emitMeta('[Shipyard] Resuming host connection and post-deploy. The VM plan will not run again.');
    res.json({ dbRunId: run.id, status: 'started' });
    finishHostDeployment({ workspace, binary, env: { ...process.env, ...workspace.env_vars }, dbRunId: run.id, logMeta: { ip: req.ip, user: req.user?.username }, emitMeta })
      .then(() => {
        db.db.prepare("UPDATE tofu_runs SET status='success', completed_at=datetime('now') WHERE id=?").run(run.id);
        db.auditLog.write('tofu.resume', `workspace=${workspace.name} run=${run.id} status=success`, req.ip, true, req.user?.username || null);
      })
      .catch(error => {
        emitMeta(`[Shipyard] Completion failed: ${error.message}`);
        db.db.prepare("UPDATE tofu_runs SET status='failed', completed_at=datetime('now') WHERE id=?").run(run.id);
      });
  });

}
module.exports = { registerDeploymentResumeRoutes };
