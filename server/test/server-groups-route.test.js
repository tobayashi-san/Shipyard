'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_server_groups_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-server-groups';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/servers', serversRouter);

let token;
let sourceIds;
let targetGroup;
let otherEnvironmentGroup;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  const otherEnvironment = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(otherEnvironment, 'Andere Umgebung');
  targetGroup = db.serverGroups.create('Produktion', '#2563eb', null, 'default');
  otherEnvironmentGroup = db.serverGroups.create('Fremd', '#2563eb', null, otherEnvironment);
  sourceIds = ['bulk-a', 'bulk-b'].map((name, index) => db.servers.create({
    name, hostname: `${name}.example`, ip_address: `10.250.0.${index + 10}`, tags: [], services: [], environment_id: 'default',
  }).id);
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('bulk folder move is atomic and cannot cross an environment boundary', async () => {
  const auth = { Authorization: `Bearer ${token}` };
  const moved = await request(app).put('/api/servers/group/bulk').set(auth).send({ server_ids: sourceIds, group_id: targetGroup.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.moved, 2);
  assert.deepEqual(db.db.prepare(`SELECT group_id FROM servers WHERE id IN (?, ?) ORDER BY id`).all(...sourceIds).map(row => row.group_id), [targetGroup.id, targetGroup.id]);

  const rejected = await request(app).put('/api/servers/group/bulk').set(auth).send({ server_ids: sourceIds, group_id: otherEnvironmentGroup.id });
  assert.equal(rejected.status, 400);
  assert.deepEqual(db.db.prepare(`SELECT group_id FROM servers WHERE id IN (?, ?) ORDER BY id`).all(...sourceIds).map(row => row.group_id), [targetGroup.id, targetGroup.id]);
  assert.ok(db.auditLog.query({ action: 'servers.group_bulk_move' }).some(row => row.success));
});

test('restricted operators cannot move a host into an unassigned folder', async () => {
  const allowedGroup = db.serverGroups.create('Erlaubter Ordner', '#2563eb', null, 'default');
  const forbiddenGroup = db.serverGroups.create('Fremder Ordner', '#dc2626', null, 'default');
  const restrictedHost = db.servers.create({
    name: 'restricted-host', hostname: 'restricted-host.example', ip_address: '10.250.0.30',
    tags: [], services: [], environment_id: 'default',
  });
  db.serverGroups.setServerGroup(restrictedHost.id, allowedGroup.id);
  const role = db.roles.create('Folder operator', {
    servers: { groups: [allowedGroup.id], servers: [] },
    canViewServers: true,
    canEditServers: true,
  });
  const passwordHash = await bcrypt.hash('restricted-pass-123', 4);
  db.users.create('folder-operator', '', passwordHash, role.id, 'Folder operator');
  const login = await request(app).post('/api/auth/login').send({ username: 'folder-operator', password: 'restricted-pass-123' });
  assert.equal(login.status, 200);
  const auth = { Authorization: `Bearer ${login.body.token}` };

  const visible = await request(app).get('/api/servers/groups?environment_id=default').set(auth);
  assert.equal(visible.status, 200);
  assert.ok(visible.body.some(group => group.id === allowedGroup.id));
  assert.ok(!visible.body.some(group => group.id === forbiddenGroup.id));

  const denied = await request(app).put('/api/servers/group/bulk').set(auth).send({
    server_ids: [restrictedHost.id], group_id: forbiddenGroup.id,
  });
  assert.equal(denied.status, 403);
  assert.equal(db.servers.getById(restrictedHost.id).group_id, allowedGroup.id);

  const renameDenied = await request(app).put(`/api/servers/groups/${forbiddenGroup.id}`).set(auth).send({ name: 'Nicht erlaubt' });
  assert.equal(renameDenied.status, 403);
  assert.equal(db.serverGroups.getAll('default').find(group => group.id === forbiddenGroup.id).name, 'Fremder Ordner');
});
