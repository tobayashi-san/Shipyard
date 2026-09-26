'use strict';

// Run history, execution and cancellation for OpenTofu deployments. An apply
// only runs a reviewed plan that is still current and non-destructive.
const { spawn, execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const log = require('../../../utils/logger').child('features:opentofu');
const { filterServers, getPermissions } = require('../../../utils/permissions');
const { verifyVmIdentity } = require('../vm-identity-safety');
const { loadWorkspaceState } = require('../managed-servers');
const { ensureProviderLockIsTracked, syncOneFromGit } = require('../workspace-files');
const {
  assertNonDestructivePlan,
  createStreamingRedactor,
  pruneWorkspaceRuns,
  redactTofuOutput,
  summarizePlanJson,
  terraformConfigurationHash,
  validateIsolatedVmPlan,
} = require('../run-safety');

const execFileAsync = promisify(execFile);

const TOFU_RUN_PAGE_SIZE_DEFAULT = Math.max(1, parseInt(process.env.TOFU_RUN_PAGE_SIZE_DEFAULT || '5', 10) || 5);
const TOFU_RUN_PAGE_SIZE_MAX = Math.max(TOFU_RUN_PAGE_SIZE_DEFAULT, parseInt(process.env.TOFU_RUN_PAGE_SIZE_MAX || '100', 10) || 100);
const TOFU_PLAN_DIR = '.fleet/plans';
const TOFU_PLAN_MAX_AGE_MS = Math.max(60_000, (parseInt(process.env.TOFU_PLAN_MAX_AGE_MINUTES || '30', 10) || 30) * 60_000);

function registerRunRoutes({
  router,
  db,
  broadcast,
  activeRuns: _running,
  getGitSync,
  getWorkspace,
  getProxmoxVms,
  validatePostDeployPlaybookAccess,
  findBinary,
  ensureWorkspacePath,
  writeFleetProxmoxFiles,
  permissionError,
  ensureStateSafety,
  backupLocalState,
  runPreDeployPlaybooks,
  registerIdentifiedHost,
  finishHostDeployment,
  syncFleetWorkspace,
}) {
  // ── Routes: Run history ───────────────────────────────────────────────────

  router.get('/workspaces/:id/runs', (req, res) => {
    const pageSize = Math.min(TOFU_RUN_PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.page_size) || parseInt(req.query.limit) || TOFU_RUN_PAGE_SIZE_DEFAULT));
    const requestedPage = Math.max(1, parseInt(req.query.page) || 1);
    const total = db.db.prepare('SELECT COUNT(*) AS c FROM tofu_runs WHERE workspace_id = ?').get(req.params.id).c || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const runs = db.db.prepare(
      'SELECT id, workspace_id, action, status, deployment_phase, vm_provisioned, plan_summary, plan_safe, plan_validation, approved_plan_id, started_by, started_at, completed_at FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).all(req.params.id, pageSize, offset);
    res.json({
      items: runs,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: totalPages,
        has_prev: page > 1,
        has_next: page < totalPages,
      },
    });
  });

  router.get('/workspaces/:id/runs/:runId', (req, res) => {
    const run = db.db.prepare('SELECT id, workspace_id, action, status, output, deployment_phase, vm_provisioned, plan_summary, plan_safe, plan_validation, approved_plan_id, started_by, started_at, completed_at FROM tofu_runs WHERE id = ? AND workspace_id = ?')
      .get(req.params.runId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });


  // ── Routes: Execute ───────────────────────────────────────────────────────

  router.post('/workspaces/:id/run', (req, res) => {
    const VALID_ACTIONS = ['init', 'validate', 'plan', 'drift', 'apply'];
    const { action, plan_id: planId } = req.body || {};
    if (['destroy', 'destroy_vm'].includes(action)) return res.status(403).json({ error: 'VM deletion is disabled. Delete VMs manually in Proxmox.' });
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (db.db.prepare("SELECT 1 FROM tofu_workspaces WHERE migration_status = 'running' LIMIT 1").get()) {
      return res.status(409).json({ error: 'OpenTofu runs are temporarily locked while legacy VM state is being isolated.' });
    }
    const activeRun = db.db.prepare("SELECT id, action, started_at FROM tofu_runs WHERE workspace_id = ? AND status IN ('running', 'cancelling')").get(workspace.id);
    if (activeRun) return res.status(409).json({ error: `${activeRun.action} is already running for this deployment.`, active_run: activeRun });

    let approvedPlan = null;
    if (action === 'apply') {
      approvedPlan = db.db.prepare("SELECT * FROM tofu_runs WHERE id = ? AND workspace_id = ? AND action = 'plan' AND status = 'success'")
        .get(String(planId || ''), workspace.id);
      if (!approvedPlan?.plan_path || !approvedPlan.config_hash) {
        return res.status(409).json({ error: 'Apply requires a successfully reviewed and saved plan.' });
      }
      if (workspace.workspace_kind === 'isolated_vm' && approvedPlan.plan_safe !== 1) {
        let detail = null;
        try { detail = JSON.parse(approvedPlan.plan_validation || 'null'); } catch {}
        return res.status(409).json({ error: detail?.error || 'The reviewed plan did not pass the isolated-VM safety check.' });
      }
      const latestPlan = db.db.prepare("SELECT id FROM tofu_runs WHERE workspace_id = ? AND action = 'plan' AND status = 'success' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(workspace.id);
      if (latestPlan?.id !== approvedPlan.id) return res.status(409).json({ error: 'Only the latest successful plan can be applied.' });
      const plannedAt = new Date(`${approvedPlan.completed_at || approvedPlan.started_at}Z`).getTime();
      if (!Number.isFinite(plannedAt) || Date.now() - plannedAt > TOFU_PLAN_MAX_AGE_MS) return res.status(409).json({ error: 'The plan has expired. Create and review a new plan.' });
      const consumed = db.db.prepare("SELECT id FROM tofu_runs WHERE approved_plan_id = ? AND action = 'apply' AND (status IN ('running', 'cancelling', 'success') OR vm_provisioned = 1)").get(approvedPlan.id);
      if (consumed) return res.status(409).json({ error: 'This plan has already been applied. Create a new plan.' });
      try {
        const deploymentVms = getProxmoxVms(workspace.id);
        validatePostDeployPlaybookAccess(deploymentVms.flatMap(vm => [...(vm.pre_deploy_playbooks || []), ...(vm.post_deploy_playbooks || [])]), req);
        const accessibleServerIds = new Set(filterServers(db.servers.getAll(), getPermissions(req.user)).map(server => String(server.id)));
        for (const vm of deploymentVms) {
          if (workspace.workspace_kind === 'isolated_vm') {
            if (!vm.started) return res.status(400).json({ error: 'Start the VM in its configuration before deploying so Fleet can connect.' });
            if (vm.ipv4_address === 'dhcp' && !vm.agent_enabled) return res.status(400).json({ error: 'Enable the guest agent to discover the DHCP address before deploying.' });
            if (vm.ssh_public_key_variable && !workspace.env_vars[`TF_VAR_${vm.ssh_public_key_variable}`]) return res.status(400).json({ error: 'No SSH public key is configured. Save the Fleet public key under Settings → Connections before deploying.' });
          }
          if ((vm.pre_deploy_playbooks || []).length && !accessibleServerIds.has(String(vm.pre_deploy_target_server_id || ''))) {
            return res.status(403).json({ error: `The pre-deploy target for ${vm.name} is not accessible.` });
          }
        }
      } catch (error) {
        return res.status(403).json({ error: error.message });
      }
    }

    const binary = findBinary();
    if (!binary) return res.status(500).json({ error: 'OpenTofu/Terraform binary not found in PATH' });

    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });

    const runId  = randomUUID();
    const dbRunId = randomUUID();
    const planPath = ['plan', 'drift'].includes(action) ? path.join(workspace.path, TOFU_PLAN_DIR, `${dbRunId}.tfplan`) : null;

    // Save run to DB
    try {
      db.db.prepare('INSERT INTO tofu_runs (id, workspace_id, action, plan_path, approved_plan_id, started_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(dbRunId, workspace.id, action, planPath, approvedPlan?.id || null, req.user?.username || null);
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error.message)) return res.status(409).json({ error: 'An OpenTofu operation is already running for this deployment.' });
      throw error;
    }
    pruneWorkspaceRuns(db, workspace.id);

    const tofuAction = action === 'drift' ? 'plan' : action;
    const args = [tofuAction, '-no-color'];
    if (tofuAction === 'plan') args.push('-input=false', '-detailed-exitcode', `-out=${planPath}`);
    if (action === 'drift') args.push('-refresh-only');
    if (tofuAction === 'apply') args.push('-auto-approve', '-input=false', approvedPlan.plan_path);

    const env = { ...process.env, ...workspace.env_vars };
    const logMeta = { ip: req.ip, user: req.user?.username };
    const eventVm = workspace.workspace_kind === 'isolated_vm' ? getProxmoxVms(workspace.id)[0] : null;
    const broadcastTofu = payload => broadcast({
      ...payload,
      ...(eventVm ? { vmId: eventVm.id, vmName: eventVm.name } : { workspaceId: workspace.id, workspaceName: workspace.name }),
    });

    res.json({ runId, dbRunId, status: 'started' });

    // Auto-pull from git before run
    const gs = getGitSync();
    const pullAndRun = async () => {
      if (gs && gs.isConfigured()) {
        try {
          await gs.pull();
          syncOneFromGit(workspace.name, workspace.path);
        } catch {}
      }

      // Generate Fleet-owned files only after Git has been pulled, otherwise
      // the pull could overwrite the just-generated desired state.
      try {
        ensureProviderLockIsTracked(workspace.path);
        if (getProxmoxVms(workspace.id).length > 0) writeFleetProxmoxFiles(workspace);
        if (planPath) fs.mkdirSync(path.dirname(planPath), { recursive: true });
      } catch (error) {
        const message = `Fleet Proxmox files could not be generated: ${permissionError(error, workspace.path)}`;
        db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?").run(message, dbRunId);
        broadcastTofu({ type: 'tofu_done', runId, success: false, error: message, dbRunId });
        return;
      }

      // Internal VM units have no user-visible Init action. Initialize their
      // provider automatically before every plan/drift check so the first
      // deployment is a single Plan -> Apply workflow.
      if (workspace.workspace_kind === 'isolated_vm' && ['plan', 'drift'].includes(action)) {
        try {
          await execFileAsync(binary, ['init', '-input=false', '-no-color'], {
            cwd: workspace.path,
            env: { ...process.env, ...workspace.env_vars },
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          ensureProviderLockIsTracked(workspace.path);
        } catch (error) {
          const detail = String(error.stderr || error.stdout || error.message || 'OpenTofu init failed').trim();
          const message = `The isolated VM provider could not be initialized: ${redactTofuOutput(detail, workspace.env_vars)}`;
          db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?").run(message, dbRunId);
          broadcastTofu({ type: 'tofu_done', runId, success: false, error: message, dbRunId });
          return;
        }
      }

      const configHash = terraformConfigurationHash(workspace.path, workspace.env_vars);
      if (action === 'apply') {
        try {
          ensureStateSafety(workspace);
          backupLocalState(workspace, `before-${action}`);
        } catch (error) {
          const message = `State safety check failed: ${error.message}`;
          db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?").run(message, dbRunId);
          broadcastTofu({ type: 'tofu_done', runId, success: false, error: message, dbRunId });
          return;
        }
      }
      if (action === 'apply') {
        if (!fs.existsSync(approvedPlan.plan_path) || approvedPlan.config_hash !== configHash) {
          const message = !fs.existsSync(approvedPlan.plan_path)
            ? 'The saved plan artifact is no longer available. Create a new plan.'
            : 'The deployment configuration has changed since the plan. Create and review a new plan.';
          db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?").run(message, dbRunId);
          broadcastTofu({ type: 'tofu_done', runId, success: false, error: message, dbRunId });
          return;
        }
      }
      db.db.prepare('UPDATE tofu_runs SET config_hash = ? WHERE id = ?').run(configHash, dbRunId);

      broadcastTofu({ type: 'tofu_start', runId, action: tofuAction });
      const header = `▶  ${binary} ${args.join(' ')}\n   cwd: ${workspace.path}\n\n`;
      broadcastTofu({ type: 'tofu_output', runId, stream: 'meta',
        data: header });
      db.db.prepare('UPDATE tofu_runs SET output = ? WHERE id = ?').run(header, dbRunId);

      let output = header;
      const emitMeta = (message) => {
        const raw = message.endsWith('\n') ? message : `${message}\n`;
        const text = redactTofuOutput(raw, workspace.env_vars);
        output += text;
        db.db.prepare('UPDATE tofu_runs SET output = output || ? WHERE id = ?').run(text, dbRunId);
        broadcastTofu({ type: 'tofu_output', runId, stream: 'meta', data: text });
      };
      if (action === 'apply') {
        try {
          const planBytes = fs.readFileSync(approvedPlan.plan_path);
          const actualPlan = JSON.parse(execFileSync(binary, ['show', '-json', approvedPlan.plan_path], { cwd: workspace.path, env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }).toString());
          assertNonDestructivePlan(actualPlan);
          if (workspace.workspace_kind === 'isolated_vm') {
            const validation = validateIsolatedVmPlan(actualPlan, getProxmoxVms(workspace.id)[0]);
            if (!validation.safe) throw new Error(validation.error);
          }
          await verifyVmIdentity({ workspace, vms: getProxmoxVms(workspace.id), state: await loadWorkspaceState({ binary, workspace, env }), plan: actualPlan });
          db.db.prepare("UPDATE tofu_runs SET deployment_phase = 'pre_deploy' WHERE id = ?").run(dbRunId);
          const preDeploy = await runPreDeployPlaybooks({ workspace, logMeta, emitMeta });
          if (preDeploy.started) emitMeta(`[Fleet] Pre-deploy complete: ${preDeploy.succeeded} succeeded.`);
          await verifyVmIdentity({ workspace, vms: getProxmoxVms(workspace.id), state: await loadWorkspaceState({ binary, workspace, env }), plan: actualPlan });
          if (!planBytes.equals(fs.readFileSync(approvedPlan.plan_path)) || terraformConfigurationHash(workspace.path, workspace.env_vars) !== configHash) throw new Error('The plan or configuration changed during pre-deploy. Create and review a new plan.');
        } catch (error) {
          const message = error.message || String(error);
          emitMeta(`[Fleet] ${message}`);
          db.db.prepare("UPDATE tofu_runs SET status='failed', completed_at=datetime('now') WHERE id=?").run(dbRunId);
          broadcastTofu({ type: 'tofu_done', runId, success: false, error: message, dbRunId });
          return;
        }
      }

      if (action === 'apply') db.db.prepare("UPDATE tofu_runs SET deployment_phase = 'deploy' WHERE id = ?").run(dbRunId);
      const proc = spawn(binary, args, { cwd: workspace.path, env, detached: process.platform !== 'win32' });
      _running.set(runId, { proc, dbRunId, workspaceId: workspace.id, cancelled: false });
      const emitProcessOutput = (stream, s) => {
        if (!s) return;
        output += s;
        db.db.prepare('UPDATE tofu_runs SET output = output || ? WHERE id = ?').run(s, dbRunId);
        broadcastTofu({ type: 'tofu_output', runId, stream, data: s });
      };
      const stdoutRedactor = createStreamingRedactor(workspace.env_vars, value => emitProcessOutput('stdout', value));
      const stderrRedactor = createStreamingRedactor(workspace.env_vars, value => emitProcessOutput('stderr', value));
      proc.stdout.on('data', d => stdoutRedactor.write(d.toString()));
      proc.stderr.on('data', d => stderrRedactor.write(d.toString()));
      proc.on('close', code => {
        stdoutRedactor.flush();
        stderrRedactor.flush();
        const runContext = _running.get(runId);
        _running.delete(runId);
        const cancelled = Boolean(runContext?.cancelled);
        const success = !cancelled && (code === 0 || (['plan', 'drift'].includes(action) && code === 2));
        const finish = async () => {
          let planSummary = null;
          let planValidation = null;
          if (success && ['plan', 'drift'].includes(action)) {
            try {
              fs.chmodSync(planPath, 0o600);
              const planJson = JSON.parse(execFileSync(binary, ['show', '-json', planPath], {
                cwd: workspace.path,
                env,
                encoding: 'utf8',
                timeout: 30_000,
                maxBuffer: 32 * 1024 * 1024,
              }));
              planSummary = summarizePlanJson(planJson);
              emitMeta(`[Fleet] Plan: ${planSummary.create} create, ${planSummary.update} update, ${planSummary.delete} delete, ${planSummary.replace} replace.`);
              if (workspace.workspace_kind === 'isolated_vm') {
                const isolatedVm = getProxmoxVms(workspace.id)[0];
                if (!isolatedVm) throw new Error('The internal VM workspace does not contain exactly one VM definition.');
                planValidation = validateIsolatedVmPlan(planJson, isolatedVm);
                emitMeta(planValidation.safe
                  ? `[Fleet] Isolation check passed for ${planValidation.expected_address}.`
                  : `[Fleet] Isolation check blocked Apply: ${planValidation.error}`);
              }
              if (action === 'drift') {
                try { fs.unlinkSync(planPath); } catch {}
                db.db.prepare('UPDATE tofu_runs SET plan_path = NULL WHERE id = ?').run(dbRunId);
              }
            } catch (error) {
              throw new Error(`The plan could not be evaluated safely: ${error.message}`);
            }
          }
          if (!success && action === 'apply' && workspace.workspace_kind === 'isolated_vm') {
            try {
              await registerIdentifiedHost({ workspace, binary, env, dbRunId, logMeta, emitMeta });
              db.db.prepare('UPDATE tofu_runs SET vm_provisioned = 1 WHERE id = ?').run(dbRunId);
              emitMeta('[Fleet] Apply failed after creating the VM. Its host is registered; retry will verify the actual configuration before continuing.');
            } catch (error) { emitMeta(`[Fleet] Host registration withheld: ${error.message}`); }
          }
          if (success && action === 'apply') {
            db.db.prepare('UPDATE tofu_runs SET vm_provisioned = 1 WHERE id = ?').run(dbRunId);
            // Consume the approved plan before host connection; retries must never apply it again.
            if (approvedPlan?.plan_path) {
              try { fs.unlinkSync(approvedPlan.plan_path); } catch {}
              db.db.prepare('UPDATE tofu_runs SET plan_path = NULL WHERE id = ?').run(approvedPlan.id);
            }
            const backup = backupLocalState(workspace, 'after-apply');
            if (backup) emitMeta(`[Fleet] Encrypted state backup saved: ${backup}`);
            await finishHostDeployment({ workspace, binary, env, dbRunId, logMeta, emitMeta });
          }

          if (success && action === 'init') syncFleetWorkspace(workspace, `Track provider lock for ${workspace.name}`);

          const status = cancelled ? 'cancelled' : success ? 'success' : 'failed';
          db.db.prepare("UPDATE tofu_runs SET status=?, output=?, plan_summary=?, plan_safe=?, plan_validation=?, completed_at=datetime('now') WHERE id=?")
            .run(status, output, planSummary ? JSON.stringify(planSummary) : null, planValidation ? (planValidation.safe ? 1 : 0) : null, planValidation ? JSON.stringify(planValidation) : null, dbRunId);
          db.auditLog.write('tofu.run', `workspace=${workspace.name} action=${action} status=${status} run=${dbRunId}`, logMeta.ip || null, success, logMeta.user || null);
          broadcastTofu({ type: 'tofu_done', runId, success, exitCode: code, dbRunId });
        };

        finish().catch(err => {
          log.error({ err, workspace: workspace.name }, 'OpenTofu run finalization failed');
          db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?")
            .run(`${output}\n[Fleet] Finalization failed: ${err.message}\n`, dbRunId);
          broadcastTofu({ type: 'tofu_done', runId, success: false, exitCode: code, error: err.message, dbRunId });
        });
      });
      proc.on('error', err => {
        _running.delete(runId);
        db.db.prepare("UPDATE tofu_runs SET status='failed', output=?, completed_at=datetime('now') WHERE id=?")
          .run(err.message, dbRunId);
        broadcastTofu({ type: 'tofu_done', runId, success: false, exitCode: -1, error: err.message, dbRunId });
      });
    };

    pullAndRun().catch(error => {
      log.error({ err: error, workspace: workspace.name }, 'OpenTofu preflight failed');
      db.db.prepare("UPDATE tofu_runs SET status='failed', output=output || ?, completed_at=datetime('now') WHERE id=? AND status='running'")
        .run(`\n[Fleet] Preparation failed: ${error.message}\n`, dbRunId);
      broadcastTofu({ type: 'tofu_done', runId, success: false, error: error.message, dbRunId });
    });
  });

  router.post('/workspaces/:id/cancel/:runId', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const runningPair = [..._running.entries()].find(([, item]) => item.dbRunId === req.params.runId && item.workspaceId === workspace.id);
    if (!runningPair) return res.status(404).json({ error: 'No running process found for this workspace' });
    const [internalRunId, entry] = runningPair;
    entry.cancelled = true;
    db.db.prepare("UPDATE tofu_runs SET status='cancelling', output=output || ? WHERE id=?")
      .run('\n[Fleet] Cancellation requested.\n', entry.dbRunId);
    try {
      if (process.platform !== 'win32' && entry.proc.pid) process.kill(-entry.proc.pid, 'SIGTERM');
      else entry.proc.kill('SIGTERM');
    } catch { entry.proc.kill('SIGTERM'); }
    setTimeout(() => {
      if (!_running.has(internalRunId)) return;
      try {
        if (process.platform !== 'win32' && entry.proc.pid) process.kill(-entry.proc.pid, 'SIGKILL');
        else entry.proc.kill('SIGKILL');
      } catch {}
    }, 10_000).unref?.();
    res.json({ success: true });
  });
}

module.exports = { registerRunRoutes };
