'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_custom_updates_route_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-custom-updates-route';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const customUpdatesRouter = require('../routes/custom-updates');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/servers/:id/custom-updates', customUpdatesRouter);

let token;
let serverId;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const { body } = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = body.token;
  serverId = db.servers.create({ name: 'truenas-route', hostname: 'truenas-route.local', ip_address: '10.0.0.72' }).id;
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('POST /api/servers/:id/custom-updates accepts trigger tasks', async () => {
  const res = await request(app)
    .post(`/api/servers/${serverId}/custom-updates`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'TrueNAS Updates',
      type: 'trigger',
      check_command: 'midclt call update.check_available',
      trigger_output: 'AVAILABLE',
      update_command: '',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'trigger');
  assert.equal(res.body.trigger_output, 'AVAILABLE');
  assert.equal(res.body.update_command, '');
});

test('POST /api/servers/:id/custom-updates rejects trigger tasks without trigger output', async () => {
  const res = await request(app)
    .post(`/api/servers/${serverId}/custom-updates`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Broken Trigger Task',
      type: 'trigger',
      check_command: 'midclt call update.check_available',
      update_command: '',
    });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /trigger_output/i);
});

test('custom checks require usable commands and nonblank trigger text', async () => {
 for(const input of [
   {name:'Missing installed',type:'github',github_repo:'owner/repo'},
   {name:'Missing desired',type:'script',check_command:'installed'},
   {name:'Blank trigger',type:'trigger',check_command:'check',trigger_output:'   '},
 ]) {
   const response=await request(app).post(`/api/servers/${serverId}/custom-updates`).set('Authorization',`Bearer ${token}`).send(input);
   assert.equal(response.status,400);
 }
});

test('preview returns checked outputs without task writes or executing the update command', async () => {
 const ssh=require('../services/ssh-manager');
 const original=ssh.execCommand;
 const commands=[];
 const before=db.customUpdateTasks.getByServer(serverId);
 ssh.execCommand=async(_server,command)=>{commands.push(command);return {code:0,stdout:command==='installed'?'v1.0':'v2.0'}};
 const draft={name:'Preview',type:'script',check_command:'installed',latest_command:'latest',update_command:'never-execute'};
 try {
   const result=await request(app).post(`/api/servers/${serverId}/custom-updates/preview`).set('Authorization',`Bearer ${token}`).send(draft);
   assert.equal(result.status,200);
   assert.deepEqual(result.body,{current_version:'1.0',last_version:'2.0',has_update:true});
   assert.deepEqual(commands,['latest','installed']);
   assert.deepEqual(db.customUpdateTasks.getByServer(serverId),before);
   ssh.execCommand=async()=>{throw new Error('private exception output')};
   const failed=await request(app).post(`/api/servers/${serverId}/custom-updates/preview`).set('Authorization',`Bearer ${token}`).send(draft);
   assert.equal(failed.status,422);
   assert.equal(JSON.stringify(failed.body).includes('private exception'),false);
   assert.deepEqual(db.customUpdateTasks.getByServer(serverId),before);
 } finally { ssh.execCommand=original; }
});

test('task changes are audited with stable scope and without command contents', async () => {
 const headers={Authorization:`Bearer ${token}`};
 const draft={name:'Audit task',type:'script',check_command:'private-installed-command',latest_command:'private-desired-command'};
 const created=await request(app).post(`/api/servers/${serverId}/custom-updates`).set(headers).send(draft);
 assert.equal(created.status,201);
 const id=created.body.id;
 const edited=await request(app).put(`/api/servers/${serverId}/custom-updates/${id}`).set(headers).send({...draft,check_command:'private-new-command'});
 assert.equal(edited.status,200);
 assert.equal((await request(app).delete(`/api/servers/${serverId}/custom-updates/${id}`).set(headers)).status,200);
 const rows=db.auditLog.query({environmentId:'default',limit:100}).filter(row=>row.detail.includes(id));
 assert.deepEqual(rows.map(row=>row.action).sort(),['custom_update.create','custom_update.delete','custom_update.update']);
 const {auditRowVisibleToServers}=require('../utils/audit-scope');
 for(const row of rows){
   assert.match(row.detail,/name="Audit task"/);
   assert.equal(row.detail.includes('private-'),false);
   assert.equal(auditRowVisibleToServers(row,{servers:{servers:[serverId],groups:[]}}),true);
   assert.equal(auditRowVisibleToServers(row,{servers:{servers:['unrelated'],groups:[]}}),false);
 }
 assert.match(rows.find(row=>row.action==='custom_update.update').detail,/changed_fields="check_command"/);
});

test('custom catalog exposes source and distinguishes missing, fresh and stale checks', async () => {
 const task = db.customUpdateTasks.create(serverId,{name:'Age check',type:'script'});
 const read = async () => {
  const response = await request(app).get(`/api/servers/${serverId}/custom-updates`).set('Authorization',`Bearer ${token}`);
  assert.equal(response.status,200);
  return response.body.find(row => row.id === task.id);
 };
 assert.equal((await read()).stale,true);
 db.db.prepare("UPDATE custom_update_tasks SET last_checked_at=datetime('now') WHERE id=?").run(task.id);
 const fresh = await read();
 assert.equal(fresh.stale,false);
 assert.match(fresh.source,/installed and desired/);
 assert.equal(fresh.stale_after_seconds,43200);
 db.db.prepare("UPDATE custom_update_tasks SET last_checked_at='2000-01-01 00:00:00' WHERE id=?").run(task.id);
 assert.equal((await read()).stale,true);
});

test('snapshot before update requires a linked Proxmox guest', async () => {
  const target = await request(app).get(`/api/servers/${serverId}/custom-updates/snapshot-target`).set('Authorization', `Bearer ${token}`);
  assert.equal(target.status, 200);
  assert.deepEqual(target.body, { available: false });
  const res = await request(app).post(`/api/servers/${serverId}/custom-updates`).set('Authorization', `Bearer ${token}`)
    .send({ name: 'Snapshot app', type: 'github', github_repo: 'owner/repo', check_command: 'cat ~/.app', update_command: 'update', snapshot_before_run: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not linked/);
  const created = await request(app).post(`/api/servers/${serverId}/custom-updates`).set('Authorization', `Bearer ${token}`)
    .send({ name: 'Snapshot app', type: 'github', github_repo: 'owner/repo', check_command: 'cat ~/.app', update_command: 'update', snapshot_before_run: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.snapshot_before_run, 0);
});

test('automatic snapshot names fit Proxmox limits', () => {
  const { autoSnapshotName } = require('../features/opentofu/guest-snapshots');
  const name = autoSnapshotName('Immich Server (Community Script)', new Date('2026-09-26T14:05:00Z'));
  assert.equal(name, 'fleet-pre-immich-server-co-202609261405');
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
  assert.equal(autoSnapshotName('!!!', new Date('2026-09-26T14:05:00Z')), 'fleet-pre-update-202609261405');
});
