'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-tofu-run-'));
const workspaceRoot = path.join(root, 'workspaces');
const binRoot = path.join(root, 'bin');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(binRoot, { recursive: true });
const fakeTofu = path.join(binRoot, 'tofu');
fs.writeFileSync(fakeTofu, `#!/bin/sh
action="$1"
if [ "$action" = "version" ]; then
  echo '{"terraform_version":"1.9.0"}'
  exit 0
fi
if [ "$action" = "show" ]; then
  if [ "$#" -ge 3 ]; then
    echo '{"resource_changes":[{"change":{"actions":["create"]}},{"change":{"actions":["update"]}},{"change":{"actions":["delete"]}}]}'
  else
    echo '{"values":{}}'
  fi
  exit 0
fi
if [ "$action" = "plan" ]; then
  for arg in "$@"; do
    case "$arg" in -out=*) plan_file=$(printf '%s' "$arg" | cut -c 6-);; esac
  done
  echo 'saved-plan' > "$plan_file"
  echo 'plan-output'
  exit 2
fi
if [ "$action" = "apply" ]; then
  echo 'apply-begin'
  sleep 0.4
  echo '{"version":4,"resources":[]}' > terraform.tfstate
  echo 'apply-done'
  exit 0
fi
echo "completed-$action"
exit 0
`, { mode: 0o755 });

process.env.PATH = `${binRoot}:${process.env.PATH}`;
process.env.DB_PATH = path.join(root, 'test.db');
process.env.JWT_SECRET = 'test-jwt-secret-opentofu-runs';
process.env.SHIPYARD_KEY_SECRET = 'test-key-secret-opentofu-runs';
process.env.OPENTOFU_WORKSPACE_ROOTS = workspaceRoot;
process.env.TOFU_STATE_BACKUP_DIR = path.join(root, 'state-backups');
process.env.TOFU_SYNC_MAX_WAIT_MS = '1';
process.env.TOFU_SYNC_RETRY_MS = '1';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../db');
const { createApp } = require('../app');

async function waitForRun(id, statuses) {
  const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = db.db.prepare('SELECT * FROM tofu_runs WHERE id = ?').get(id);
    if (row && wanted.has(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not reach ${[...wanted].join(', ')}`);
}

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('Apply is bound to one saved plan, persists output, and locks its workspace', async () => {
  const { app } = createApp();
  const setup = await request(app).post('/api/auth/setup').send({ username: 'admin', password: 'testpass12345' });
  assert.equal(setup.status, 200);
  const auth = { Authorization: `Bearer ${setup.body.token}` };
  const workspacePath = path.join(workspaceRoot, 'secure-run');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'main.tf'), 'resource "test_resource" "one" {}\n');
  db.db.prepare(`INSERT INTO tofu_workspaces (id, name, path, description, env_vars, environment_id) VALUES ('secure-run', 'secure-run', ?, '', '{}', 'default')`).run(workspacePath);

  const withoutPlan = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'apply' });
  assert.equal(withoutPlan.status, 409);

  const planStart = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'plan' });
  assert.equal(planStart.status, 200);
  const plan = await waitForRun(planStart.body.dbRunId, 'success');
  assert.ok(fs.existsSync(plan.plan_path));
  assert.deepEqual(JSON.parse(plan.plan_summary), { create: 1, update: 1, delete: 1, replace: 0, no_op: 0, read: 0 });

  const applyStart = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'apply', plan_id: plan.id });
  assert.equal(applyStart.status, 200);
  const concurrent = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'plan' });
  assert.equal(concurrent.status, 409);
  await new Promise(resolve => setTimeout(resolve, 100));
  const live = await request(app).get(`/api/opentofu/workspaces/secure-run/runs/${applyStart.body.dbRunId}`).set(auth);
  assert.equal(live.status, 200);
  assert.match(live.body.output, /apply-begin/);
  const applied = await waitForRun(applyStart.body.dbRunId, 'success');
  assert.equal(applied.approved_plan_id, plan.id);
  assert.match(applied.output, /apply-done/);
  assert.ok(fs.readdirSync(path.join(root, 'state-backups', 'secure-run')).some(name => name.endsWith('.tfstate.enc')));
  const stateThroughEditor = await request(app).get('/api/opentofu/workspaces/secure-run/file?path=terraform.tfstate').set(auth);
  assert.equal(stateThroughEditor.status, 400);

  const backups = await request(app).get('/api/opentofu/workspaces/secure-run/state-backups').set(auth);
  assert.equal(backups.status, 200);
  fs.writeFileSync(path.join(workspacePath, 'terraform.tfstate'), '{"broken":true}');
  const restored = await request(app).post('/api/opentofu/workspaces/secure-run/state-backups/restore').set(auth).send({
    backup: backups.body.items[0].name,
    confirmation: 'RESTORE STATE secure-run',
  });
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspacePath, 'terraform.tfstate'), 'utf8')).version, 4);

  const reuse = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'apply', plan_id: plan.id });
  assert.equal(reuse.status, 409);

  const nextPlanStart = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'plan' });
  const nextPlan = await waitForRun(nextPlanStart.body.dbRunId, 'success');
  fs.appendFileSync(path.join(workspacePath, 'main.tf'), '# changed after review\n');
  const staleApply = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'apply', plan_id: nextPlan.id });
  assert.equal(staleApply.status, 200);
  const rejected = await waitForRun(staleApply.body.dbRunId, 'failed');
  assert.match(rejected.output, /configuration has changed since the plan/i);
});

test('startup recovery marks orphaned running rows as interrupted', () => {
  db.db.prepare(`INSERT INTO tofu_runs (id, workspace_id, action, status) VALUES ('orphaned-run', 'secure-run', 'plan', 'running')`).run();
  createApp();
  const recovered = db.db.prepare('SELECT status, output, completed_at FROM tofu_runs WHERE id = ?').get('orphaned-run');
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.output, /interrupted by a restart/);
  assert.ok(recovered.completed_at);
});
