'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_environment_integrity_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-environment-integrity';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { setupOpenTofuDatabase } = require('../features/opentofu/schema');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const environmentsRouter = require('../routes/environments');
const serversRouter = require('../routes/servers');

setupOpenTofuDatabase(db.db);

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
app.use('/api/environments', environmentsRouter);
app.use('/api/servers', serversRouter);

let adminToken;

async function login(username, password) {
  const response = await request(app).post('/api/auth/login').send({ username, password });
  assert.equal(response.status, 200);
  return response.body.token;
}

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  adminToken = await login('admin', 'testpass12345');
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('restricted server editors cannot move or create hosts outside their environment scope', async () => {
  const envA = db.uuidv4();
  const envB = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(envA, 'Scoped A');
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(envB, 'Scoped B');
  const host = db.servers.create({ name: 'scope-host', hostname: 'scope-host', ip_address: '10.80.0.10', environment_id: envA });
  const role = db.roles.create('Scoped editor', {
    servers: { servers: [host.id], groups: [] },
    canViewServers: true,
    canAddServers: true,
    canEditServers: true,
  });
  db.users.create('scoped-editor', '', await bcrypt.hash('scoped-pass-123', 4), role.id);
  const token = await login('scoped-editor', 'scoped-pass-123');
  const auth = { Authorization: `Bearer ${token}` };

  const moved = await request(app).put(`/api/servers/${host.id}`).set(auth).send({ environment_id: envB });
  assert.equal(moved.status, 403);
  assert.equal(db.servers.getById(host.id).environment_id, envA);

  const created = await request(app).post('/api/servers').set(auth).send({
    name: 'scope-escape', ip_address: '10.81.0.10', environment_id: envB,
  });
  assert.equal(created.status, 403);
  assert.equal(db.db.prepare('SELECT 1 FROM servers WHERE name = ?').get('scope-escape'), undefined);
});

test('tag auto-grouping stays inside the selected environment', async () => {
  const environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'Grouping target');
  db.serverGroups.create('production', '#111111', null, 'default');
  const targetGroup = db.serverGroups.create('production', '#222222', null, environmentId);
  const auth = { Authorization: `Bearer ${adminToken}` };

  const created = await request(app).post('/api/servers').set(auth).send({
    name: 'grouped-target-host', ip_address: '10.82.0.10', environment_id: environmentId, tags: ['production'],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.group_id, targetGroup.id);

  const defaultGroup = db.serverGroups.create('legacy-folder', '#333333', null, 'default');
  const movable = db.servers.create({ name: 'move-and-clear', hostname: 'move-and-clear', ip_address: '10.82.0.11', environment_id: 'default' });
  db.serverGroups.setServerGroup(movable.id, defaultGroup.id);
  const moved = await request(app).put(`/api/servers/${movable.id}`).set(auth).send({ environment_id: environmentId });
  assert.equal(moved.status, 200);
  assert.equal(db.servers.getById(movable.id).group_id, null);
});

test('deleting an environment consolidates every scoped resource without breaking folders', async () => {
  const environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'Consolidate me');
  const group = db.serverGroups.create('Preserved folder', '#123456', null, environmentId);
  const host = db.servers.create({ name: 'preserved-host', hostname: 'preserved-host', ip_address: '10.83.0.10', environment_id: environmentId });
  db.serverGroups.setServerGroup(host.id, group.id);
  const subnetId = db.uuidv4();
  db.db.prepare('INSERT INTO ipam_subnets (id, environment_id, name, cidr) VALUES (?, ?, ?, ?)').run(subnetId, environmentId, 'Preserved subnet', '10.83.0.0/24');
  const sourceId = db.uuidv4();
  db.db.prepare('INSERT INTO ipam_sync_sources (id, environment_id, type, name, endpoint) VALUES (?, ?, ?, ?, ?)')
    .run(sourceId, environmentId, 'unifi', 'Preserved source', 'https://controller.invalid');
  db.db.prepare('INSERT INTO ipam_sync_conflicts (id, environment_id, subnet_id, source_id, address, reason, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))')
    .run(db.uuidv4(), environmentId, subnetId, sourceId, '10.83.0.20', 'test conflict');
  const connectionId = db.uuidv4();
  db.db.prepare('INSERT INTO tofu_proxmox_connections (id, environment_id, name, endpoint, api_token) VALUES (?, ?, ?, ?, ?)')
    .run(connectionId, environmentId, 'Preserved platform', 'https://proxmox.invalid', 'encrypted');
  db.db.prepare('INSERT INTO ipam_proxmox_sync_conflicts (id, environment_id, subnet_id, connection_id, address, reason, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))')
    .run(db.uuidv4(), environmentId, subnetId, connectionId, '10.83.0.21', 'test conflict');
  db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, environment_id) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), 'Preserved workspace', '/workspaces/preserved', environmentId);
  db.db.prepare('INSERT INTO schedules (id, environment_id, name, playbook, targets, cron_expression, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(db.uuidv4(), environmentId, 'Preserved schedule', 'update.yml', 'all', '0 0 * * *');
  db.db.prepare('INSERT INTO schedule_history (id, environment_id, schedule_name, playbook) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), environmentId, 'Preserved history', 'update.yml');
  db.db.prepare('INSERT INTO ansible_vars (id, environment_id, key, value) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), environmentId, 'PRESERVED_VAR', 'value');
  db.db.prepare("INSERT INTO variable_change_events (environment_id,variable_id,variable_key,action,fields) VALUES (?, 'historical-variable', 'PRESERVED_VAR', 'Updated', '[]')").run(environmentId);
  db.db.prepare('INSERT INTO ssh_key_assignments (id, environment_id, target_type, target_id) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), environmentId, 'server', host.id);
  db.db.prepare('INSERT INTO maintenance_windows (id, environment_id, name, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)')
    .run(db.uuidv4(), environmentId, 'Preserved window', '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z');

  const auditId = db.auditLog.write('infrastructure.vm_power', 'action=start', null, true, 'fixture', environmentId);
  db.db.prepare('INSERT INTO proxmox_guest_audit VALUES (?, ?, ?, ?, ?)').run(auditId, connectionId, environmentId, 'pve001', 101);
  db.db.prepare('INSERT INTO proxmox_object_audit VALUES (?, ?, ?, ?)').run(auditId, connectionId, environmentId, 'pve001');
  db.db.prepare('INSERT INTO proxmox_guest_tasks (connection_id,environment_id,endpoint,node_name,vm_id,task_id,action,resource_name,status) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(connectionId, environmentId, 'https://proxmox.invalid', 'pve001', 101, 'UPID:preserved', 'start', 'Preserved VM', 'running');

  const response = await request(app)
    .delete(`/api/environments/${environmentId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(response.status, 200);
  assert.equal(db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId), undefined);
  assert.equal(db.servers.getById(host.id).environment_id, 'default');
  assert.equal(db.db.prepare("SELECT environment_id FROM variable_change_events WHERE variable_id = 'historical-variable'").get().environment_id, 'default');
  assert.equal(db.servers.getById(host.id).group_id, group.id);
  for (const table of ['audit_log', 'proxmox_guest_audit', 'proxmox_object_audit']) {
    const column = table === 'audit_log' ? 'id' : 'audit_id';
    assert.equal(db.db.prepare(`SELECT environment_id FROM ${table} WHERE ${column}=?`).get(auditId).environment_id, 'default');
  }
  const task = db.db.prepare('SELECT * FROM proxmox_guest_tasks WHERE task_id=?').get('UPID:preserved');
  assert.equal(task.environment_id, 'default');
  assert.equal(task.status, 'running');
  assert.equal(task.connection_id, connectionId);

  assert.equal(db.db.prepare('SELECT environment_id FROM server_groups WHERE id = ?').get(group.id).environment_id, 'default');

  for (const table of [
    'ssh_key_assignments', 'schedules', 'schedule_history', 'ansible_vars', 'variable_change_events', 'ipam_subnets',
    'ipam_sync_sources', 'ipam_sync_conflicts', 'ipam_proxmox_sync_conflicts',
    'maintenance_windows', 'tofu_workspaces', 'tofu_proxmox_connections',
    'proxmox_guest_audit', 'proxmox_object_audit', 'proxmox_guest_tasks',
  ]) {
    assert.equal(db.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE environment_id = ?`).get(environmentId).count, 0, table);
  }
});

test('environment consolidation is blocked instead of overwriting unique resources', async () => {
  const environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'Conflicting environment');
  db.db.prepare('INSERT INTO ansible_vars (id, environment_id, key, value) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), 'default', 'DUPLICATE_KEY', 'default value');
  db.db.prepare('INSERT INTO ansible_vars (id, environment_id, key, value) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), environmentId, 'DUPLICATE_KEY', 'source value');

  const response = await request(app)
    .delete(`/api/environments/${environmentId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(response.status, 409);
  assert.ok(db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId));
  assert.equal(db.db.prepare('SELECT environment_id FROM ansible_vars WHERE key = ? AND value = ?').get('DUPLICATE_KEY', 'source value').environment_id, environmentId);
});

test('environment VM definition count excludes empty and legacy workspaces', async () => {
  const environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'Definition counts');
  for (const type of ['empty', 'legacy', 'isolated']) {
    const workspaceId = db.uuidv4();
    db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, environment_id) VALUES (?, ?, ?, ?)')
      .run(workspaceId, type, `/workspaces/${type}`, environmentId);
    if (type !== 'empty') db.db.prepare('INSERT INTO tofu_proxmox_vms (id, workspace_id, name, config, is_isolated) VALUES (?, ?, ?, ?, ?)')
      .run(db.uuidv4(), workspaceId, `${type}-vm`, '{}', type === 'isolated' ? 1 : 0);
  }
  const response = await request(app).get('/api/environments').set('Authorization', `Bearer ${adminToken}`);
  assert.equal(response.status, 200);
  const environment = response.body.find(row => row.id === environmentId);
  assert.equal(environment.deployment_count, 3);
  assert.equal(environment.vm_definition_count, 1);
});

test('failed consolidation audit rolls back the environment and its moved resources', async () => {
 const environmentId=db.uuidv4();
 db.db.prepare('INSERT INTO environments (id,name) VALUES (?,?)').run(environmentId,'Atomic consolidation');
 const host=db.servers.create({name:'atomic-host',hostname:'atomic-host',ip_address:'10.83.0.99',environment_id:environmentId});
 const original=db.auditLog.write;
 const before=db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='environment.delete'").get().n;
 db.auditLog.write=(...args)=>{const id=original(...args);if(args[0]==='environment.delete')throw new Error('Simulated audit storage failure');return id;};
 try {
  const response=await request(app).delete(`/api/environments/${environmentId}`).set('Authorization',`Bearer ${adminToken}`);
  assert.equal(response.status,500);
  assert.ok(db.db.prepare('SELECT 1 FROM environments WHERE id=?').get(environmentId));
  assert.equal(db.servers.getById(host.id).environment_id,environmentId);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='environment.delete'").get().n,before);
 } finally {db.auditLog.write=original;}
});

test('environment names reject coercion and truncation and duplicate renames remain unchanged', async()=>{
 const auth={Authorization:`Bearer ${adminToken}`};
 const created=await request(app).post('/api/environments').set(auth).send({name:'Input validation source'});
 assert.equal(created.status,201);
 for(const name of [123,{},[],null,'   ','x'.repeat(81)]){
  assert.equal((await request(app).post('/api/environments').set(auth).send({name})).status,400);
  assert.equal((await request(app).put(`/api/environments/${created.body.id}`).set(auth).send({name})).status,400);
 }
 assert.equal(db.db.prepare('SELECT name FROM environments WHERE id=?').get(created.body.id).name,'Input validation source');
 const other=await request(app).post('/api/environments').set(auth).send({name:'Input validation target'});
 assert.equal(other.status,201);
 const duplicate=await request(app).put(`/api/environments/${created.body.id}`).set(auth).send({name:other.body.name});
 assert.equal(duplicate.status,409);assert.equal(duplicate.body.field,'name');
 assert.equal(db.db.prepare('SELECT name FROM environments WHERE id=?').get(created.body.id).name,'Input validation source');
 assert.equal((await request(app).post('/api/environments').set(auth).send({name:other.body.name})).status,409);
 const boundary='n'.repeat(80);
 assert.equal((await request(app).put(`/api/environments/${created.body.id}`).set(auth).send({name:boundary})).status,200);
 assert.equal(db.db.prepare('SELECT name FROM environments WHERE id=?').get(created.body.id).name,boundary);
});
