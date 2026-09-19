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
    if [ -f custom-plan.json ]; then cat custom-plan.json; exit 0; fi
    if [ -f destructive-plan ]; then
      echo '{"resource_changes":[{"address":"indirect.foreign","change":{"actions":["delete"]}}]}'
    elif [ -f isolation-unsafe ]; then
      echo '{"resource_changes":[{"address":"proxmox_virtual_environment_vm.isolated-app","change":{"actions":["create"]}},{"address":"proxmox_virtual_environment_vm.foreign-app","change":{"actions":["update"]}}]}'
    elif [ -f isolation-safe ]; then
      echo '{"resource_changes":[{"address":"proxmox_virtual_environment_vm.isolated-app","change":{"actions":["create"],"after":{"vm_id":46001,"node_name":"pve001","description":"Shipyard VM isolated-vm"}}}]}'
    else
      echo '{"resource_changes":[{"change":{"actions":["create"]}},{"change":{"actions":["update"]}}]}'
    fi
  else
    if [ -f custom-state.json ] && [ -f apply-count ]; then cat custom-state.json; exit 0; fi
    if [ -f discovered-state.json ]; then cat discovered-state.json
    elif [ -f isolation-safe ] && [ -f apply-count ]; then echo '{"values":{"root_module":{"resources":[{"address":"proxmox_virtual_environment_vm.isolated-app","type":"proxmox_virtual_environment_vm","values":{"name":"isolated-app","vm_id":46001,"node_name":"pve001","description":"Shipyard VM isolated-vm"}}]}}}'
    else echo '{"values":{}}'; fi
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
  echo 'apply' >> apply-count
  echo 'apply-begin'
  sleep 0.4
  echo '{"version":4,"resources":[]}' > terraform.tfstate
  echo 'apply-done'
  if [ -f fail-apply ]; then exit 1; fi
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
  throw new Error(`Run ${id} did not reach ${[...wanted].join(', ')}: ${db.db.prepare("SELECT output FROM tofu_runs WHERE id = ?").get(id)?.output}`);
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
  assert.deepEqual(JSON.parse(plan.plan_summary), { create: 1, update: 1, delete: 0, replace: 0, no_op: 0, read: 0 });

  const applyStart = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'apply', plan_id: plan.id });
  assert.equal(applyStart.status, 200);
  const concurrent = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({ action: 'plan' });
  assert.equal(concurrent.status, 409);
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = db.db.prepare('SELECT output FROM tofu_runs WHERE id = ?').get(applyStart.body.dbRunId);
    if (row?.output.includes('apply-begin')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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

test('isolated VM Apply accepts only its reviewed plan and resumes automatic workflows without recreating the VM', async t => {
  const { app } = createApp();
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'testpass12345' });
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const preHost = db.servers.create({name:'pre-deploy-host',hostname:'pre-deploy-host',ip_address:'192.0.2.40'});
  const playbookCalls = [];
  const runner = require('../services/ansible-runner');
  t.mock.method(runner, 'getAvailablePlaybooks', () => ['prepare.yml', 'configure.yml'].map(filename => ({filename})));
  t.mock.method(runner, 'runPlaybook', async (playbook, target) => { playbookCalls.push({playbook,target}); return {success:true,stdout:'completed',stderr:''}; });
  const workspacePath = path.join(workspaceRoot, 'isolated-app');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'isolation-safe'), 'safe');
  fs.writeFileSync(path.join(workspacePath, 'terraform.tfstate'), '{"version":3,"resources":[]}');
  db.db.prepare(`INSERT INTO tofu_workspaces (id, name, path, description, env_vars, environment_id, workspace_kind)
    VALUES ('isolated-workspace', 'vm-isolated-app', ?, '', '{}', 'default', 'isolated_vm')`).run(workspacePath);
  db.db.prepare(`INSERT INTO tofu_proxmox_vms (id, workspace_id, name, config, is_isolated)
    VALUES ('isolated-vm', 'isolated-workspace', 'isolated-app', ?, 1)`).run(JSON.stringify({ name: 'isolated-app', node_name: 'pve001', vm_id: 46001, disk_datastore: 'local-lvm', bridge: 'vmbr0', pre_deploy_playbooks:['prepare.yml'], pre_deploy_target_server_id:preHost.id, post_deploy_playbooks:['configure.yml'] }));

  const env = { TF_VAR_proxmox_endpoint: 'https://pve.test:8006', TF_VAR_proxmox_api_token: 'user@pve!token=secret' };
  db.db.prepare('UPDATE tofu_workspaces SET env_vars = ? WHERE id = ?').run(JSON.stringify(env), 'isolated-workspace');
  const { EventEmitter } = require('events');
  t.mock.method(require('https'), 'request', (url, options, callback) => {
    const stream = new EventEmitter();
    stream.setTimeout = () => stream;
    stream.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
      callback(response);
      const deployed = fs.existsSync(path.join(workspacePath, 'apply-count'));
      const data = String(url).includes('/cluster/resources') ? (deployed ? [{vmid:46001,node:'pve001',name:'isolated-app',type:'qemu',status:'running'}] : [])
        : String(url).includes('/agent/') ? (fs.existsSync(path.join(workspacePath, 'discovered-state.json')) ? [{name:'eth0','ip-addresses':[{'ip-address':'192.0.2.41','ip-address-type':'ipv4'}]}] : [])
        : String(url).endsWith('/config') ? {description:'Shipyard VM isolated-vm',cores:2,memory:4096,net0:'bridge=vmbr0',ciuser:'ubuntu',scsi0:'local-lvm:vm-46001-disk-0,size=40G'} : [];
      response.emit('data', JSON.stringify({data})); response.emit('end');
    });
    return stream;
  });

  const safeStart = await request(app).post('/api/opentofu/vms/isolated-vm/plan').set(auth).send({});
  assert.equal(safeStart.status, 200);
  const safePlan = await waitForRun(safeStart.body.dbRunId, 'success');
  assert.equal(safePlan.plan_safe, 1);
  assert.equal(JSON.parse(safePlan.plan_validation).expected_address, 'proxmox_virtual_environment_vm.isolated-app');

  const applyStart = await request(app).post('/api/opentofu/vms/isolated-vm/apply').set(auth).send({ plan_id: safePlan.id });
  assert.equal(applyStart.status, 200);
  const incomplete = await waitForRun(applyStart.body.dbRunId, 'failed');
  assert.equal(incomplete.vm_provisioned, 1);
  assert.equal(incomplete.deployment_phase, 'register_host');
  const pendingHost = db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ?').get('isolated-workspace');
  assert.ok(pendingHost);
  assert.equal(db.servers.getById(pendingHost.server_id).ip_address, '');
  assert.deepEqual(playbookCalls, [{playbook:'prepare.yml',target:'pre-deploy-host'}]);
  const reusePlan = await request(app).post('/api/opentofu/vms/isolated-vm/apply').set(auth).send({ plan_id: safePlan.id });
  assert.equal(reusePlan.status, 409);
  fs.writeFileSync(path.join(workspacePath, 'discovered-state.json'), JSON.stringify({ values: { root_module: { resources: [{ address: 'proxmox_virtual_environment_vm.isolated-app', type: 'proxmox_virtual_environment_vm', values: { name: 'isolated-app', vm_id: 46001, node_name: 'pve001', description: 'Shipyard VM isolated-vm', ipv4_addresses: [['192.0.2.41']] } }] } } }));
  const ssh = require('../services/ssh-manager');
  const originalTest = ssh.testConnection;
  ssh.testConnection = async () => true;
  let applied;
  try {
    const resumed = await request(app).post('/api/opentofu/vms/isolated-vm/resume').set(auth).send({});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    applied = await waitForRun(applyStart.body.dbRunId, 'success');
  } finally { ssh.testConnection = originalTest; }
  assert.equal(applied.deployment_phase, 'ready');
  assert.equal(db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ?').get('isolated-workspace').server_id, pendingHost.server_id);
  assert.equal(db.servers.getById(pendingHost.server_id).status, 'online');
  assert.deepEqual(playbookCalls, [{playbook:'prepare.yml',target:'pre-deploy-host'}, {playbook:'configure.yml',target:'isolated-app'}]);
  assert.equal(fs.readFileSync(path.join(workspacePath, 'apply-count'), 'utf8').trim(), 'apply');
  assert.ok(db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ?').get('isolated-workspace'));

  assert.equal(applied.approved_plan_id, safePlan.id);
  const driftStart = await request(app).post('/api/opentofu/vms/isolated-vm/check-drift').set(auth).send({});
  assert.equal(driftStart.status, 200);
  const drift = await waitForRun(driftStart.body.dbRunId, 'success');
  assert.equal(drift.action, 'drift');
  assert.equal(drift.plan_safe, 1);

  const safety = await request(app).get('/api/opentofu/vms/isolated-vm/state-safety').set(auth);
  assert.equal(safety.status, 200);
  assert.equal(safety.body.mode, 'encrypted-backup');
  const backups = await request(app).get('/api/opentofu/vms/isolated-vm/state-backups').set(auth);
  assert.equal(backups.status, 200);
  assert.ok(backups.body.items.length > 0);
  const beforeApply = backups.body.items.find(item => item.name.includes('before-apply'));
  assert.ok(beforeApply);
  fs.writeFileSync(path.join(workspacePath, 'terraform.tfstate'), '{"broken":true}');
  const restored = await request(app).post('/api/opentofu/vms/isolated-vm/state-backups/restore').set(auth).send({ backup: beforeApply.name, confirmation: 'RESTORE STATE isolated-app' });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspacePath, 'terraform.tfstate'), 'utf8')).version, 3);

  fs.unlinkSync(path.join(workspacePath, 'isolation-safe'));
  fs.writeFileSync(path.join(workspacePath, 'isolation-unsafe'), 'unsafe');
  const unsafeStart = await request(app).post('/api/opentofu/vms/isolated-vm/plan').set(auth).send({});
  assert.equal(unsafeStart.status, 200);
  const unsafePlan = await waitForRun(unsafeStart.body.dbRunId, 'success');
  assert.equal(unsafePlan.plan_safe, 0);
  assert.match(JSON.parse(unsafePlan.plan_validation).error, /foreign-app/);
  const blockedApply = await request(app).post('/api/opentofu/vms/isolated-vm/apply').set(auth).send({ plan_id: unsafePlan.id });
  assert.equal(blockedApply.status, 409);
  assert.match(blockedApply.body.error, /foreign-app/);
});

test('destroy is denied and a saved plan changed to deletion never reaches apply', async () => {
  const { app } = createApp();
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'testpass12345' });
  const auth = { Authorization: `Bearer ${login.body.token}` };
  for (const action of ['destroy', 'destroy_vm']) {
    const denied = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({action,confirm_destroy:'DESTROY secure-run'});
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /manually in Proxmox/);
  }
  const workspacePath = db.db.prepare("SELECT path FROM tofu_workspaces WHERE id='secure-run'").get().path;
  const started = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({action:'plan'});
  const plan = await waitForRun(started.body.dbRunId, 'success');
  const before = fs.readFileSync(path.join(workspacePath, 'apply-count'), 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'destructive-plan'), 'delete');
  try {
    const apply = await request(app).post('/api/opentofu/workspaces/secure-run/run').set(auth).send({action:'apply',plan_id:plan.id});
    assert.equal(apply.status, 200);
    const failed = await waitForRun(apply.body.dbRunId, 'failed');
    assert.match(failed.output, /Deleting or replacing/);
    assert.equal(fs.readFileSync(path.join(workspacePath, 'apply-count'), 'utf8'), before);
  } finally { fs.unlinkSync(path.join(workspacePath, 'destructive-plan')); }
});

test('a partial apply registers its identified VM and consumes the plan without running post-deploy', async t => {
  const { app } = createApp();
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'testpass12345' });
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const workspacePath = path.join(workspaceRoot, 'partial-app');
  fs.mkdirSync(workspacePath);
  const values = {vm_id:47001,node_name:'pve001',name:'partial-app',description:'Shipyard VM partial-vm'};
  fs.writeFileSync(path.join(workspacePath,'custom-plan.json'),JSON.stringify({resource_changes:[{address:'proxmox_virtual_environment_vm.partial-app',change:{actions:['create'],after:values}}]}));
  fs.writeFileSync(path.join(workspacePath,'custom-state.json'),JSON.stringify({values:{root_module:{resources:[{address:'proxmox_virtual_environment_vm.partial-app',type:'proxmox_virtual_environment_vm',values}]}}}));
  fs.writeFileSync(path.join(workspacePath,'fail-apply'),'fail after creation');
  const env = {TF_VAR_proxmox_endpoint:'https://partial.test',TF_VAR_proxmox_api_token:'user@pve!token=secret'};
  db.db.prepare("INSERT INTO tofu_workspaces (id,name,path,env_vars,environment_id,workspace_kind) VALUES ('partial-workspace','partial-workspace',?,?,'default','isolated_vm')").run(workspacePath,JSON.stringify(env));
  db.db.prepare("INSERT INTO tofu_proxmox_vms (id,workspace_id,name,config,is_isolated) VALUES ('partial-vm','partial-workspace','partial-app',?,1)").run(JSON.stringify({...values,bridge:'vmbr0',disk_datastore:'local-lvm'}));
  const {EventEmitter} = require('events');
  t.mock.method(require('https'),'request',(url,_options,callback)=>{
    const stream = new EventEmitter(); stream.setTimeout=()=>stream;
    stream.end=()=>queueMicrotask(()=>{
      const response=new EventEmitter(); response.statusCode=200; response.setEncoding=()=>{}; callback(response);
      const data=String(url).includes('/cluster/resources') ? (fs.existsSync(path.join(workspacePath,'apply-count')) ? [{vmid:47001,node:'pve001',name:'partial-app',type:'qemu'}] : []) : {description:values.description};
      response.emit('data',JSON.stringify({data})); response.emit('end');
    }); return stream;
  });
  const planned=await request(app).post('/api/opentofu/vms/partial-vm/plan').set(auth).send({});
  const plan=await waitForRun(planned.body.dbRunId,'success');
  const applied=await request(app).post('/api/opentofu/vms/partial-vm/apply').set(auth).send({plan_id:plan.id});
  const failed=await waitForRun(applied.body.dbRunId,'failed');
  assert.equal(failed.vm_provisioned,1,failed.output);
  const mapping=db.db.prepare("SELECT server_id FROM tofu_managed_servers WHERE workspace_id='partial-workspace'").get();
  assert.ok(mapping);
  assert.equal(db.servers.getById(mapping.server_id).ip_address,'');
  assert.match(failed.output,/Apply failed after creating the VM/);
  const reuse=await request(app).post('/api/opentofu/vms/partial-vm/apply').set(auth).send({plan_id:plan.id});
  assert.equal(reuse.status,409);
});
