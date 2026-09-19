'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_operations_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-operations';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const environmentContext = require('../middleware/environment-context');
const operationsRouter = require('../routes/operations');
const { setupOpenTofuDatabase } = require('../features/opentofu/schema');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware, environmentContext);
app.use('/api/operations', operationsRouter);
app.use('/api/schedule-history', require('../routes/schedule-history'));
app.use('/api/servers', require('../routes/servers'));
app.use('/api/ansible', require('../routes/ansible')());

let token;
let restrictedHistoryToken;
let visibleHost;
let hiddenHost;

before(async () => {
  setupOpenTofuDatabase(db.db);
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  visibleHost = db.servers.create({ name: 'operations-visible', hostname: 'operations-visible', ip_address: '10.95.0.10' });
  hiddenHost = db.servers.create({ name: 'operations-hidden', hostname: 'operations-hidden', ip_address: '10.95.0.11' });
  const restrictedRole = db.roles.create('Restricted activity viewer', {
    servers: { groups: [], servers: [visibleHost.id] },
    canViewServerHistory: true,
    plugins: 'all',
    canViewDeployments: false,
  });
  const restrictedUser = db.users.create('restricted-activity', '', 'unused', restrictedRole.id, '');
  restrictedHistoryToken = jwt.sign({ userId: restrictedUser.id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const visibleRun = db.updateHistory.create(visibleHost.id, 'server.visible', 'operator');
  db.updateHistory.updateStatus(visibleRun, 'success', 'ok');
  const hiddenRun = db.updateHistory.create(hiddenHost.id, 'server.hidden', 'operator');
  db.updateHistory.updateStatus(hiddenRun, 'success', 'ok');
  db.auditLog.write('system.global', 'Global console event', '127.0.0.1', true, 'operator');
  for (let index = 0; index < 30; index += 1) {
    const id = db.updateHistory.create(visibleHost.id, `dataset-item-${String(index).padStart(2, '0')}`, 'operator');
    db.updateHistory.updateStatus(id, 'success', 'ok');
    db.db.prepare('UPDATE update_history SET started_at = ?, completed_at = ? WHERE id = ?')
      .run(`2026-07-${String(index + 1).padStart(2, '0')} 12:00:00`, `2026-07-${String(index + 1).padStart(2, '0')} 12:01:00`, id);
  }
});

test('restricted activity contains only explicitly assigned host executions and no audit rows', async () => {
  const response = await request(app)
    .get('/api/operations?source=Host&q=server.&page_size=100')
    .set({
      Authorization: `Bearer ${restrictedHistoryToken}`,
      'X-Shipyard-Environment': 'default',
    });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.name), ['Server visible']);
  assert.equal(response.body.items[0].action, 'server.visible');
  assert.equal(response.body.items[0].target, visibleHost.name);
  assert.equal(response.body.items.some(item => item.target === hiddenHost.name), false);
  assert.equal(response.body.items.some(item => item.action === 'system.global'), false);
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('operations filters and paginates the complete permitted history', async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Shipyard-Environment': 'default',
  };
  const page = await request(app)
    .get('/api/operations?source=Host&q=dataset-item&page=3&page_size=10')
    .set(headers);
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 30);
  assert.equal(page.body.total_pages, 3);
  assert.equal(page.body.items.length, 10);

  const oldest = await request(app)
    .get('/api/operations?source=Host&q=dataset-item-00')
    .set(headers);
  assert.equal(oldest.status, 200);
  assert.equal(oldest.body.total, 1);
  assert.equal(oldest.body.items[0].name, 'Dataset item 00');
});

test('workflow targets are condensed while preserving searchable raw details', async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Shipyard-Environment': 'default',
  };
  const targets = Array.from({ length: 14 }, (_, index) => `host-${index + 1}`).join(',');
  const condensedId = db.scheduleHistory.create(
    null,
    'workflow-condensed',
    'deploy.yml',
    targets,
    { environmentId: 'default', triggeredBy: 'operator' },
  );
  db.scheduleHistory.complete(condensedId, 'success', 'ok');
  const excludedId = db.scheduleHistory.create(
    null,
    'workflow-excluded',
    'deploy.yml',
    'all:!pve001',
    { environmentId: 'default', triggeredBy: 'operator' },
  );
  db.scheduleHistory.complete(excludedId, 'success', 'ok');

  const condensed = await request(app)
    .get('/api/operations?source=Workflow&q=host-14')
    .set(headers);
  assert.equal(condensed.status, 200);
  assert.equal(condensed.body.items[0].target, '14 hosts');
  assert.equal(condensed.body.items[0].target_detail, targets);

  const excluded = await request(app)
    .get('/api/operations?source=Workflow&q=workflow-excluded')
    .set(headers);
  assert.equal(excluded.status, 200);
  assert.equal(excluded.body.items[0].target, 'All hosts except pve001');
  assert.equal(excluded.body.items[0].target_detail, 'all:!pve001');
});

test('isolated deployment activity uses the visible VM name and VM route id', async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Shipyard-Environment': 'default',
  };
  db.db.prepare(`
    INSERT INTO tofu_workspaces
      (id, name, path, environment_id, workspace_kind)
    VALUES (?, ?, ?, 'default', 'isolated_vm')
  `).run('activity-workspace', 'vm-f6a0-internal', '/tmp/activity-workspace');
  db.db.prepare(`
    INSERT INTO tofu_proxmox_vms (id, workspace_id, name, config, is_isolated)
    VALUES (?, ?, ?, '{}', 1)
  `).run('activity-vm', 'activity-workspace', 'payments-db-01');
  db.db.prepare(`
    INSERT INTO tofu_runs (id, workspace_id, action, status, started_by, completed_at)
    VALUES (?, ?, 'plan', 'success', 'operator', datetime('now'))
  `).run('activity-run', 'activity-workspace');

  const response = await request(app)
    .get('/api/operations?source=Deployment&q=payments-db-01')
    .set(headers);
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].target, 'payments-db-01');
  assert.equal(response.body.items[0].target_detail, 'vm-f6a0-internal');
  assert.deepEqual(response.body.items[0].params, { id: 'activity-vm' });
});

test('failed activity can be acknowledged without removing its history', async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Shipyard-Environment': 'default',
  };
  const historyId = db.updateHistory.create(visibleHost.id, 'acknowledge-me', 'operator');
  db.updateHistory.updateStatus(historyId, 'failed', 'command exited with status 1');

  const beforeAck = await request(app)
    .get('/api/operations?source=Host&q=acknowledge-me&scope=failed')
    .set(headers);
  assert.equal(beforeAck.status, 200);
  assert.equal(beforeAck.body.counts.failed, 1);
  assert.equal(beforeAck.body.items.length, 1);
  assert.equal(beforeAck.body.items[0].acknowledged, false);

  const acknowledged = await request(app)
    .post(`/api/operations/host-${historyId}/acknowledge`)
    .set(headers);
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.acknowledged, true);
  assert.equal(acknowledged.body.acknowledged_by, 'admin');

  const openFailures = await request(app)
    .get('/api/operations?source=Host&q=acknowledge-me&scope=failed')
    .set(headers);
  assert.equal(openFailures.status, 200);
  assert.equal(openFailures.body.counts.failed, 0);
  assert.equal(openFailures.body.items.length, 0);

  const history = await request(app)
    .get('/api/operations?source=Host&q=acknowledge-me')
    .set(headers);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].status, 'failed');
  assert.equal(history.body.items[0].acknowledged, true);
  assert.ok(history.body.items[0].acknowledged_at);
});

test('all currently visible failures can be acknowledged together', async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Shipyard-Environment': 'default',
  };
  for (const action of ['bulk-ack-one', 'bulk-ack-two']) {
    const id = db.updateHistory.create(visibleHost.id, action, 'operator');
    db.updateHistory.updateStatus(id, 'failed', `${action} failed`);
  }

  const acknowledged = await request(app)
    .post('/api/operations/acknowledge-all')
    .set(headers);
  assert.equal(acknowledged.status, 200);
  assert.ok(acknowledged.body.acknowledged >= 2);

  for (const query of ['bulk-ack-one', 'bulk-ack-two']) {
    const response = await request(app)
      .get(`/api/operations?source=Host&q=${query}&scope=failed`)
      .set(headers);
    assert.equal(response.status, 200);
    assert.equal(response.body.counts.failed, 0);
    assert.equal(response.body.items.length, 0);
  }
});

test('execution details return the exact scoped log and UTC duration', async () => {
  const id = db.updateHistory.create(visibleHost.id, 'compose_pull_media', 'operator');
  db.updateHistory.updateStatus(id, 'success', 'pulling\n2 images updated');
  db.db.prepare('UPDATE update_history SET started_at = ?, completed_at = ? WHERE id = ?')
    .run('2026-09-09 01:00:00', '2026-09-09T01:02:00Z', id);
  const response = await request(app).get(`/api/operations/host-${id}/details`)
    .set({ Authorization: `Bearer ${restrictedHistoryToken}`, 'X-Shipyard-Environment': 'default' });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, 'Pull container images · media');
  assert.equal(response.body.execution_id, id);
  assert.equal(response.body.duration_seconds, 120);
  assert.equal(response.body.summary, '2 images updated');
  assert.equal(response.body.output, 'pulling\n2 images updated');
});

test('execution details do not expose another host or environment', async () => {
  const id = db.updateHistory.create(hiddenHost.id, 'system_update', 'operator');
  db.updateHistory.updateStatus(id, 'success', 'private output');
  const response = await request(app).get(`/api/operations/host-${id}/details`)
    .set({ Authorization: `Bearer ${restrictedHistoryToken}`, 'X-Shipyard-Environment': 'default' });
  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(response.body).includes('private output'), false);
});

test('execution output is bounded and keeps the most recent lines', async () => {
  const id = db.updateHistory.create(visibleHost.id, 'system_update', 'operator');
  db.updateHistory.updateStatus(id, 'success', 'x'.repeat(210000) + '\nFinished');
  const response = await request(app).get(`/api/operations/host-${id}/details`)
    .set({ Authorization: `Bearer ${token}`, 'X-Shipyard-Environment': 'default' });
  assert.equal(response.status, 200);
  assert.equal(response.body.output.length, 200000);
  assert.equal(response.body.output_truncated, true);
  assert.equal(response.body.summary, 'Finished');
});

test('viewing update counts does not implicitly grant access to host logs', async () => {
  const role = db.roles.create('Updates without history', { servers: 'all', canViewUpdates: true });
  const user = db.users.create('updates-no-history', '', 'unused', role.id, '');
  const viewerToken = jwt.sign({ userId: user.id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const id = db.updateHistory.create(visibleHost.id, 'system_update', 'operator');
  const response = await request(app).get(`/api/operations/host-${id}/details`)
    .set({ Authorization: `Bearer ${viewerToken}`, 'X-Shipyard-Environment': 'default' });
  assert.equal(response.status, 403);
});


test('dashboard count request includes all permitted running and queued rows before scope and pagination', async () => {
  const ids=[];
  try {
    for(let i=0;i<12;i++) {
      const id=db.updateHistory.create(visibleHost.id, 'count-active-fixture', 'operator'); ids.push(id);
      db.db.prepare('UPDATE update_history SET status=? WHERE id=?').run(i%2 ? 'queued' : 'running',id);
    }
    const hidden=db.updateHistory.create(hiddenHost.id,'count-active-fixture','operator');ids.push(hidden);
    const headers={Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'};
    const dashboard=await request(app).get('/api/operations?scope=failed&q=count-active-fixture&page_size=1').set(headers);
    const active=await request(app).get('/api/operations?scope=active&q=count-active-fixture&page_size=1').set(headers);
    assert.equal(dashboard.status,200);assert.equal(active.status,200);
    assert.equal(dashboard.body.counts.active,12);assert.equal(dashboard.body.items.length,0);
    assert.equal(active.body.total,12);assert.equal(active.body.items.length,1);
    assert.equal(active.body.counts.active,dashboard.body.counts.active);
  } finally {for(const id of ids)db.db.prepare('DELETE FROM update_history WHERE id=?').run(id);}
});

test('deleted host executions retain their original name only for complete host scope', async () => {
  const host=db.servers.create({name:'Historical database',hostname:'retained-host',ip_address:'192.0.2.99'});
  const assignedRole=db.roles.create('Former host viewer',{servers:{groups:[],servers:[host.id]},canViewServerHistory:true});
  const assignedUser=db.users.create('former-host-viewer','','unused',assignedRole.id,'');
  const assignedToken=jwt.sign({userId:assignedUser.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
  const id=db.updateHistory.create(host.id,'system_update','operator');
  db.updateHistory.updateStatus(id,'failed','Repository unavailable');
  db.db.prepare('UPDATE servers SET name=? WHERE id=?').run('Renamed database',host.id);
  db.servers.delete(host.id);
  const adminHeaders={Authorization:`Bearer ${token}`,'X-Shipyard-Environment':'default'};
  const list=await request(app).get('/api/operations?q=Historical%20database').set(adminHeaders);
  assert.equal(list.status,200);assert.equal(list.body.items.length,1);
  assert.equal(list.body.items[0].target,'Historical database');assert.equal(list.body.items[0].target_deleted,true);assert.equal(list.body.items[0].href,null);
  const details=await request(app).get(`/api/operations/host-${id}/details`).set(adminHeaders);
  assert.equal(details.status,200);assert.equal(details.body.output,'Repository unavailable');
  const restricted=await request(app).get(`/api/operations/host-${id}/details`).set({Authorization:`Bearer ${assignedToken}`,'X-Shipyard-Environment':'default'});
  assert.equal(restricted.status,404);
  assert.throws(()=>db.updateHistory.create(host.id,'system_update'),/Host not found/);
});

test('workflow history preserves original schedule, playbook, targets and dry-run mode after schedule edits and deletion', async () => {
  const scheduleId=db.schedules.create('Original maintenance','update.yml',visibleHost.name,'0 1 * * *');
  const id=db.scheduleHistory.create(scheduleId,'Original maintenance','update.yml',visibleHost.name,{checkMode:true,triggeredBy:'Planner'});
  db.scheduleHistory.complete(id,'success','Dry run complete');
  db.schedules.update(scheduleId,{name:'Renamed maintenance',playbook:'different.yml',targets:hiddenHost.name});
  db.schedules.delete(scheduleId);
  const response=await request(app).get(`/api/operations/workflow-${id}/details`).set({Authorization:`Bearer ${token}`,'X-Shipyard-Environment':'default'});
  assert.equal(response.status,200);assert.equal(response.body.name,'Original maintenance');
  assert.equal(response.body.playbook,'update.yml');assert.equal(response.body.target,visibleHost.name);
  assert.equal(response.body.check_mode,true);assert.equal(response.body.schedule_deleted,true);
  assert.equal(response.body.initiator,'Planner');assert.equal(response.body.output,'Dry run complete');
  const manual=db.scheduleHistory.create(null,'Manual run','update.yml',visibleHost.name);
  const manualResponse=await request(app).get(`/api/operations/workflow-${manual}/details`).set({Authorization:`Bearer ${token}`,'X-Shipyard-Environment':'default'});
  assert.equal(manualResponse.status,200);assert.equal(manualResponse.body.schedule_deleted,false);assert.equal(manualResponse.body.check_mode,false);
  assert.equal(manualResponse.body.host_results[0].name, visibleHost.name);
  assert.equal(manualResponse.body.host_results[0].status, 'unknown');
  assert.equal(manualResponse.body.host_results[0].ok, null);
});


test('workflow endpoints bind access and host association to recorded IDs across name reuse',async()=>{
 const original=db.servers.create({name:'reused-target',hostname:'reused-target',ip_address:'192.0.2.70'});
 const run=db.scheduleHistory.create(null,'Identity test','update.yml',original.name);db.scheduleHistory.complete(run,'success','Private original output');
 db.db.prepare('UPDATE servers SET name=? WHERE id=?').run('renamed-target',original.id);
 const oldRole=db.roles.create('Original workflow viewer',{servers:{servers:[original.id],groups:[]},playbooks:'all',canViewSchedules:true,canViewServerHistory:true});
 const oldUser=db.users.create('original-workflow-viewer','','unused',oldRole.id,'');
 const oldToken=jwt.sign({userId:oldUser.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 const headers={Authorization:`Bearer ${oldToken}`,'X-Shipyard-Environment':'default'};
 assert.equal((await request(app).get(`/api/schedule-history/${run}`).set(headers)).status,200);
 assert.equal((await request(app).get(`/api/operations/workflow-${run}/details`).set(headers)).status,200);
 const renamedHistory=await request(app).get(`/api/servers/${original.id}/history`).set(headers);
 assert.ok(renamedHistory.body.some(row=>row.id===run));
 db.servers.delete(original.id);
 const replacement=db.servers.create({name:'reused-target',hostname:'replacement-target',ip_address:'192.0.2.71'});
 const newRole=db.roles.create('Replacement workflow viewer',{servers:{servers:[replacement.id],groups:[]},playbooks:'all',canViewSchedules:true,canViewServerHistory:true});
 const newUser=db.users.create('replacement-workflow-viewer','','unused',newRole.id,'');
 const newToken=jwt.sign({userId:newUser.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 const newHeaders={Authorization:`Bearer ${newToken}`,'X-Shipyard-Environment':'default'};
 assert.equal((await request(app).get(`/api/schedule-history/${run}`).set(newHeaders)).status,403);
 assert.equal((await request(app).get(`/api/operations/workflow-${run}/details`).set(newHeaders)).status,404);
 const list=await request(app).get('/api/schedule-history').set(newHeaders);assert.equal(list.body.some(row=>row.id===run),false);
 const adminDetails=await request(app).get(`/api/operations/workflow-${run}/details`).set({Authorization:`Bearer ${token}`,'X-Shipyard-Environment':'default'});
 assert.equal(adminDetails.body.host_results[0].server_id,null);
 const history=await request(app).get(`/api/servers/${replacement.id}/history`).set(newHeaders);assert.equal(history.body.some(row=>row.id===run),false);
});


test('history limits apply after workflow permissions',async()=>{
 const host=db.servers.create({name:'limit-allowed',hostname:'limit-allowed',ip_address:'192.0.2.80'});
 const own=db.scheduleHistory.create('limit-fixture','Older permitted run','update.yml',host.name);
 db.db.prepare('UPDATE schedule_history SET started_at=? WHERE id=?').run('2020-01-01 00:00:00',own);
 for(let i=0;i<201;i++)db.scheduleHistory.create('limit-fixture','Newer hidden run','update.yml',hiddenHost.name);
 const role=db.roles.create('Limit viewer',{servers:{servers:[host.id],groups:[]},playbooks:'all',canViewSchedules:true,canViewServerHistory:true});
 const user=db.users.create('limit-viewer','','unused',role.id,'');
 const userToken=jwt.sign({userId:user.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 const response=await request(app).get('/api/schedule-history?limit=1&scheduleId=limit-fixture').set({Authorization:`Bearer ${userToken}`,'X-Shipyard-Environment':'default'});
 assert.equal(response.status,200);assert.deepEqual(response.body.map(row=>row.id),[own]);
 const local=await request(app).get(`/api/servers/${host.id}/history`).set({Authorization:`Bearer ${userToken}`,'X-Shipyard-Environment':'default'});
 assert.equal(local.status,200);assert.ok(local.body.some(row=>row.id===own));
});


test('cancel preview requires run and target permissions without requiring or exposing logs',async()=>{
 const run=db.scheduleHistory.create(null,'Preview cancellation','update.yml',visibleHost.name);
 db.scheduleHistory.appendOutput(run,'PRIVATE OUTPUT');
 const role=db.roles.create('Run without logs',{servers:{servers:[visibleHost.id],groups:[]},playbooks:'all',canRunPlaybooks:true});
 const user=db.users.create('cancel-preview-viewer','','unused',role.id,'');
 const viewer=jwt.sign({userId:user.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 const response=await request(app).get(`/api/ansible/runs/${run}/cancel-preview`).set({Authorization:`Bearer ${viewer}`,'X-Shipyard-Environment':'default'});
 assert.equal(response.status,200);assert.equal(response.body.id,run);assert.equal(response.body.targets,visibleHost.name);
 assert.equal(JSON.stringify(response.body).includes('PRIVATE'),false);assert.equal(response.body.output,undefined);
 assert.equal(db.scheduleHistory.getById(run).status,'running');
 const forbidden=db.scheduleHistory.create(null,'Other host','update.yml',hiddenHost.name);
 assert.equal((await request(app).get(`/api/ansible/runs/${forbidden}/cancel-preview`).set({Authorization:`Bearer ${viewer}`,'X-Shipyard-Environment':'default'})).status,403);
 assert.equal((await request(app).get(`/api/ansible/runs/${run}/cancel-preview`).set({Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'})).status,403);
});

test('run status is available without history rights while output and live events remain scoped', async () => {
 const host=db.servers.create({name:'run-status-host',hostname:'run-status-host',ip_address:'10.95.2.1'});
 const run=db.scheduleHistory.create(null,'Status check','update.yml',host.name);
 db.scheduleHistory.appendOutput(run,'PRIVATE RUN LOG');
 const perms={servers:{servers:[host.id],groups:[]},playbooks:['update.yml'],canRunPlaybooks:true,canViewPlaybooks:true};
 const role=db.roles.create('Status only',perms);
 const user=db.users.create('status-only','','unused',role.id,'');
 const viewer=jwt.sign({userId:user.id,tv:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 const headers={Authorization:`Bearer ${viewer}`,'X-Shipyard-Environment':'default'};
 const status=await request(app).get(`/api/ansible/runs/${run}/status`).set(headers);
 assert.equal(status.status,200); assert.equal(status.body.status,'running');
 assert.equal(status.body.output_available,false);assert.equal(status.body.output,undefined);
 assert.equal(JSON.stringify(status.body).includes('PRIVATE'),false);
 assert.equal((await request(app).get(`/api/schedule-history/${run}`).set(headers)).status,403);
 const {canReceive}=require('../ws');
 const event={type:'ansible_output',historyId:run,runId:run,environmentId:'default'};
 assert.equal(canReceive(event,{perms,environmentId:'default'}),false);
 const logPerms={...perms,canViewSchedules:true};
 assert.equal(canReceive(event,{perms:logPerms,environmentId:'default'}),true);
 const multi=db.scheduleHistory.create(null,'Mixed targets','update.yml',`${host.name},${hiddenHost.name}`);
 assert.equal(canReceive({...event,historyId:multi,runId:multi},{perms:logPerms,environmentId:'default'}),false);
 assert.equal((await request(app).get(`/api/ansible/runs/${multi}/status`).set(headers)).status,403);
 const wrongPlaybook=db.scheduleHistory.create(null,'Other playbook','other.yml',host.name);
 assert.equal((await request(app).get(`/api/ansible/runs/${wrongPlaybook}/status`).set(headers)).status,403);
 const admin=await request(app).get(`/api/ansible/runs/${run}/status`).set({...headers,Authorization:`Bearer ${token}`});
 assert.equal(admin.status,200);assert.equal(admin.body.output,'PRIVATE RUN LOG');
 assert.equal(admin.body.output_available,true);
 assert.equal((await request(app).get(`/api/ansible/runs/${run}/status`).set({...headers,Authorization:`Bearer ${restrictedHistoryToken}`})).status,403);
 db.scheduleHistory.complete(run,'success','PRIVATE RUN LOG');
 assert.equal((await request(app).get(`/api/ansible/runs/${run}/status`).set(headers)).body.status,'success');
 db.servers.update(host.id,{...host,name:'renamed-status-host'});
 assert.equal(canReceive(event,{perms:logPerms,environmentId:'default'}),true);
 db.servers.delete(host.id);
 db.servers.create({name:'run-status-host',hostname:'replacement-status-host',ip_address:'10.95.2.2'});
 assert.equal(canReceive(event,{perms:logPerms,environmentId:'default'}),false);
 assert.equal((await request(app).get(`/api/ansible/runs/${run}/status`).set(headers)).status,404);
});

test('failed execution summary preserves the error before trailing cleanup', async () => {
 const id=db.updateHistory.create(visibleHost.id,'system_update','operator');
 const output='Starting\n\u001b[31mERROR: Package lock unavailable\u001b[0m\nCleanup completed\nDisconnected';
 db.updateHistory.updateStatus(id,'failed',output);
 const response=await request(app).get(`/api/operations/host-${id}/details`).set({Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'});
 assert.equal(response.status,200);
 assert.equal(response.body.summary,'ERROR: Package lock unavailable');
 assert.equal(response.body.output,output);
 db.updateHistory.updateStatus(id,'failed','Cleanup completed');
 const unknown=await request(app).get(`/api/operations/host-${id}/details`).set({Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'});
 assert.equal(unknown.body.summary,'Failure cause not identified; open the full log.');
});

test('execution duration does not turn reversed or missing timestamps into zero',async()=>{
 const id=db.updateHistory.create(visibleHost.id,'reboot','operator');
 for(const [start,end,expected] of [
  ['2026-09-11 06:01:00','2026-09-11 06:00:00',null],
  ['2026-09-11 06:01:00',null,null],
  ['invalid','2026-09-11 06:00:00',null],
  ['2026-09-11 06:00:00','2026-09-11 06:00:00',0],
 ]){
  db.db.prepare('UPDATE update_history SET started_at=?,completed_at=? WHERE id=?').run(start,end,id);
  const result=await request(app).get(`/api/operations/host-${id}/details`).set({Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'});
  assert.equal(result.status,200);assert.equal(result.body.duration_seconds,expected);
 }
});

test('active counts, filtering and ordering include pending and cancelling operations',async()=>{
 const ids=[];
 for(const status of ['pending','cancelling','success']){
  const id=db.updateHistory.create(visibleHost.id,`active-consistency-${status}`,'operator');ids.push(id);
  db.db.prepare('UPDATE update_history SET status=?,started_at=?,completed_at=? WHERE id=?').run(status,status==='success'?'2026-09-11 07:00:00':'2026-09-11 06:00:00',status==='success'?'2026-09-11 07:01:00':null,id);
 }
 const headers={Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'};
 const all=await request(app).get('/api/operations?q=active-consistency').set(headers);
 assert.equal(all.status,200);assert.equal(all.body.counts.active,2);assert.equal(all.body.items.at(-1).status,'success');
 const active=await request(app).get('/api/operations?q=active-consistency&scope=active').set(headers);
 assert.equal(active.status,200);assert.deepEqual(active.body.items.map(row=>row.status).sort(),['cancelling','pending']);
 for(const row of active.body.items)assert.equal(row.statusTone,'info');
});

test('operations filter the displayed Zurich day and reject invalid dates',async()=>{
 const expected=[];
 for(const [index,time] of ['2026-09-10 21:59:59','2026-09-10 22:00:00','2026-09-11T21:59:59Z','2026-09-11T22:00:00Z'].entries()){
  const id=db.updateHistory.create(visibleHost.id,`zurich-boundary-${index}`,'operator');
  db.db.prepare("UPDATE update_history SET status='success',started_at=?,completed_at=? WHERE id=?").run(time,time,id);
  if(index===1||index===2)expected.push(`host-${id}`);
 }
 const headers={Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'};
 const result=await request(app).get('/api/operations?q=zurich-boundary&from=2026-09-11&to=2026-09-11').set(headers);
 assert.equal(result.status,200);assert.deepEqual(result.body.items.map(row=>row.id).sort(),expected.sort());
 for(const query of ['from=2026-02-30','from=2026-09-12&to=2026-09-11'])assert.equal((await request(app).get(`/api/operations?${query}`).set(headers)).status,400);
});

test('sync groups expose every permitted execution for direct log navigation',async()=>{
 const ids=[];
 for(let i=0;i<3;i++){
  const id=db.updateHistory.create(visibleHost.id,'inventory sync group-probe','operator');ids.push(`host-${id}`);
  db.updateHistory.updateStatus(id,'success',`Sync output ${i}`);
  db.db.prepare('UPDATE update_history SET completed_at=? WHERE id=?').run(`2026-09-11 06:00:0${i}`,id);
 }
 const hidden=db.updateHistory.create(hiddenHost.id,'inventory sync group-probe','operator');db.updateHistory.updateStatus(hidden,'success','Private sync');
 const headers={Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'};
 const list=await request(app).get('/api/operations?q=group-probe').set(headers);
 assert.equal(list.status,200);assert.equal(list.body.items.length,1);
 assert.equal(list.body.items[0].grouped_count,3);
 assert.deepEqual(list.body.items[0].executions.map(run=>run.id).sort(),ids.sort());
 for(const id of ids){const details=await request(app).get(`/api/operations/${id}/details`).set(headers);assert.equal(details.status,200);assert.match(details.body.output,/Sync output/);}
});

test('filters individual syncs before grouping so an older matching run is retained',async()=>{
 const older=db.updateHistory.create(visibleHost.id,'inventory sync filter-group-probe','older-operator');
 const newer=db.updateHistory.create(visibleHost.id,'inventory sync filter-group-probe','newer-operator');
 for(const [id,time] of [[older,'2026-09-11 21:00:00'],[newer,'2026-09-11 23:00:00']]){
  db.updateHistory.updateStatus(id,'success','Synchronized');
  db.db.prepare('UPDATE update_history SET started_at=?,completed_at=? WHERE id=?').run(time,time,id);
 }
 const headers={Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'};
 for(const query of ['q=older-operator','q=filter-group-probe&from=2026-09-11&to=2026-09-11']){
  const response=await request(app).get(`/api/operations?${query}`).set(headers);
  assert.equal(response.status,200);assert.equal(response.body.items.length,1);
  assert.equal(response.body.items[0].id,`host-${older}`);
 }
});


test('sync grouping uses the same Zurich calendar day as displayed date filters', async () => {
  const ids = [];
  for (const time of ['2026-09-10 22:30:00', '2026-09-11T21:30:00Z', '2026-09-11 22:30:00']) {
    const id = db.updateHistory.create(visibleHost.id, 'inventory sync local-day-probe', 'operator');
    db.updateHistory.updateStatus(id, 'success', 'Synchronized');
    db.db.prepare('UPDATE update_history SET started_at=?,completed_at=? WHERE id=?').run(time, time, id);
    ids.push(`host-${id}`);
  }
  const headers = { Authorization: `Bearer ${restrictedHistoryToken}`, 'X-Shipyard-Environment': 'default' };
  const response = await request(app).get('/api/operations?q=local-day-probe').set(headers);
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  const group = response.body.items.find(row => row.grouped_count);
  assert.deepEqual(group.executions.map(row => row.id).sort(), ids.slice(0, 2).sort());
  assert.ok(response.body.items.some(row => row.id === ids[2]));
  const filtered = await request(app).get('/api/operations?q=local-day-probe&from=2026-09-11&to=2026-09-11').set(headers);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.items, [group]);
});

test('start page completed scope excludes active jobs and retains host permissions', async () => {
  const ids=[];
  try {
    for (const [server,status] of [[visibleHost,'running'],[visibleHost,'queued'],[visibleHost,'success'],[visibleHost,'failed'],[hiddenHost,'success']]) {
      const id=db.updateHistory.create(server.id,'start-completed-scope','operator');ids.push(id);
      db.updateHistory.updateStatus(id,status,'result');
    }
    const result=await request(app).get('/api/operations?scope=completed&q=start-completed-scope&page_size=5').set({Authorization:`Bearer ${restrictedHistoryToken}`,'X-Shipyard-Environment':'default'});
    assert.equal(result.status,200);
    assert.equal(result.body.total,2);
    assert.deepEqual(result.body.items.map(row=>row.status).sort(),['failed','success']);
    assert.ok(result.body.items.every(row=>row.target===visibleHost.name));
  } finally { for(const id of ids) db.db.prepare('DELETE FROM update_history WHERE id=?').run(id); }
});
