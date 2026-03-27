'use strict';

// Must be set before any require that loads db.js
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_security_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-security';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');
const scheduleHistoryRouter = require('../routes/schedule-history');
const adhocRouter = require('../routes/adhoc');
const { getPermissions, filterPlaybooks } = require('../utils/permissions');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
app.use('/api/servers', serversRouter);
app.use('/api/schedule-history', scheduleHistoryRouter);
app.use('/api/adhoc', adhocRouter);

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

function wipeDb() {
  for (const table of ['users', 'roles', 'servers', 'schedule_history', 'server_groups']) {
    try { db.db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
  try { db.db.prepare('DELETE FROM app_settings').run(); } catch {}
}

async function setupAdmin() {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
}

async function login(username, password) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  return res.body.token;
}

test('setup mode blocks non-auth API routes (prevents data exposure after reset/auth)', async () => {
  wipeDb();
  const res = await request(app).get('/api/schedule-history');
  assert.equal(res.status, 503);
});

test('schedule-history list allows restricted user to see multi-target entries they partially have access to', async () => {
  wipeDb();
  await setupAdmin();

  // Create two servers and two schedule history entries
  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });
  db.scheduleHistory.create(null, 'nightly', 'deploy.yml', 'web-1,db-1');
  db.scheduleHistory.create(null, 'nightly', 'deploy.yml', 'db-1');

  // Restricted role: only web-1
  const viewerRole = db.roles.create('viewer', {
    servers: { servers: [webId], groups: [] },
    canViewServers: true,
  });
  const hash = await bcrypt.hash('viewerpass12345', 12);
  db.users.create('viewer', '', hash, viewerRole.id);

  const token = await login('viewer', 'viewerpass12345');

  const res = await request(app)
    .get('/api/schedule-history?limit=50')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // Should include the 'web-1,db-1' entry (because viewer can access web-1)
  assert.ok(res.body.some(r => r.targets === 'web-1,db-1'));
  // Should NOT include db-only entry
  assert.ok(!res.body.some(r => r.targets === 'db-1'));
});

test('adhoc run is blocked for restricted user targeting inaccessible server', async () => {
  wipeDb();
  await setupAdmin();

  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });

  // Role: can only access web-1
  const role = db.roles.create('web-only', {
    servers: { servers: [webId], groups: [] },
    canRunPlaybooks: true,
  });
  const hash = await bcrypt.hash('webpass12345', 12);
  db.users.create('webonly', '', hash, role.id);
  const token = await login('webonly', 'webpass12345');

  // Attempt to run against db-1 (not permitted)
  const forbidden = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'db-1', module: 'ping' });
  assert.equal(forbidden.status, 403);

  // Attempt to run against 'all' (not permitted for restricted user)
  const allForbidden = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'all', module: 'ping' });
  assert.equal(allForbidden.status, 403);

  // Targeting own server is allowed (actual SSH will fail in test, but auth passes)
  const allowed = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'web-1', module: 'ping' });
  assert.notEqual(allowed.status, 403);
});

test('playbook whitelist is enforced for restricted roles', async () => {
  wipeDb();
  await setupAdmin();

  // Role with a specific playbook allowlist
  const role = db.roles.create('restricted-playbooks', {
    servers: 'all',
    playbooks: ['deploy.yml'],
    canRunPlaybooks: true,
  });
  const hash = await bcrypt.hash('plpass12345', 12);
  db.users.create('pluser', '', hash, role.id);
  const token = await login('pluser', 'plpass12345');

  // Verify filterPlaybooks reflects the whitelist
  const user = db.users.getByUsername('pluser');
  const perms = getPermissions(user);
  const allowed = filterPlaybooks([
    { filename: 'deploy.yml' },
    { filename: 'other.yml' },
  ], perms);
  assert.deepEqual(allowed.map(p => p.filename), ['deploy.yml']);

  // Accessing a non-whitelisted playbook returns an empty list from filterPlaybooks
  assert.equal(allowed.some(p => p.filename === 'other.yml'), false);
});

test('server endpoints that trigger SSH/polling are capability-gated', async () => {
  wipeDb();
  await setupAdmin();

  const serverId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;

  // Create a limited role: can view servers, but cannot view updates and cannot use terminal
  const role = db.roles.create('limited', {
    servers: 'all',
    canViewServers: true,
    canViewUpdates: false,
    canUseTerminal: false,
  });

  const hash = await bcrypt.hash('limitedpass12345', 12);
  db.users.create('limited', '', hash, role.id);

  const limitedToken = await login('limited', 'limitedpass12345');

  // canUseTerminal is false
  const testRes = await request(app)
    .post(`/api/servers/${serverId}/test`)
    .set('Authorization', `Bearer ${limitedToken}`);
  assert.equal(testRes.status, 403);

  // canViewUpdates is false
  const updatesRes = await request(app)
    .get(`/api/servers/${serverId}/updates`)
    .set('Authorization', `Bearer ${limitedToken}`);
  assert.equal(updatesRes.status, 403);
});

