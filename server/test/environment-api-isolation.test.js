'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_environment_api_isolation_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-environment-api-isolation';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const environmentContext = require('../middleware/environment-context');
const serversRouter = require('../routes/servers');
const dashboardRouter = require('../routes/dashboard');
const alertsRouter = require('../routes/alerts');
const systemRouter = require('../routes/system');
const maintenanceRouter = require('../routes/maintenance-windows');
const ansibleVarsRouter = require('../routes/ansible-vars');
const schedulesRouter = require('../routes/schedules');
const scheduleHistoryRouter = require('../routes/schedule-history');
const ipamRouter = require('../routes/ipam');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware, environmentContext);
app.use('/api/servers', serversRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/system', systemRouter);
app.use('/api/maintenance-windows', maintenanceRouter);
app.use('/api/ansible-vars', ansibleVarsRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/schedule-history', scheduleHistoryRouter);
app.use('/api/ipam', ipamRouter);

let token;
let envA;
let envB;
let serverA;
let serverB;
let windowB;
let subnetB;
let scheduleB;

const scoped = (environmentId) => ({
  Authorization: `Bearer ${token}`,
  'X-Shipyard-Environment': environmentId,
});

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  token = (await request(app).post('/api/auth/login').send({ password: 'testpass12345' })).body.token;
  envA = db.uuidv4();
  envB = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?), (?, ?)').run(envA, 'Isolated A', envB, 'Isolated B');
  serverA = db.servers.create({ name: 'isolated-a-host', hostname: 'isolated-a-host', ip_address: '10.90.0.10', environment_id: envA });
  serverB = db.servers.create({ name: 'isolated-b-host', hostname: 'isolated-b-host', ip_address: '10.91.0.10', environment_id: envB });

  db.updateHistory.create(serverA.id, 'environment-a-update', 'admin', envA);
  db.updateHistory.create(serverB.id, 'environment-b-update', 'admin', envB);
  db.auditLog.write('environment.a.event', 'server=isolated-a-host', '127.0.0.1', true, 'admin', envA);
  db.auditLog.write('environment.b.event', 'server=isolated-b-host', '127.0.0.1', true, 'admin', envB);

  const alertA = db.resourceAlerts.createPending({ serverId: serverA.id, type: 'cpu', message: 'A alert' });
  const alertB = db.resourceAlerts.createPending({ serverId: serverB.id, type: 'cpu', message: 'B alert' });
  db.resourceAlerts.activate(alertA.id);
  db.resourceAlerts.activate(alertB.id);

  db.ansibleVars.create('ENV_ONLY', 'value-a', '', { environmentId: envA });
  db.ansibleVars.create('ENV_ONLY', 'value-b', '', { environmentId: envB });
  db.schedules.create('Schedule A', 'update.yml', serverA.name, '0 0 * * *', { environmentId: envA });
  scheduleB = db.schedules.create('Schedule B', 'update.yml', serverB.name, '0 0 * * *', { environmentId: envB });

  windowB = db.uuidv4();
  db.db.prepare('INSERT INTO maintenance_windows (id, environment_id, name, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)')
    .run(windowB, envB, 'Window B', '2030-01-01T00:00:00.000Z', '2030-01-01T01:00:00.000Z');
  subnetB = db.uuidv4();
  db.db.prepare('INSERT INTO ipam_subnets (id, environment_id, name, cidr) VALUES (?, ?, ?, ?)')
    .run(subnetB, envB, 'Subnet B', '10.91.0.0/24');
  db.db.prepare('INSERT INTO ipam_subnets (id, environment_id, name, cidr) VALUES (?, ?, ?, ?)')
    .run(db.uuidv4(), envA, 'Subnet A', '10.90.0.0/24');
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('collection APIs only return rows from the request environment', async () => {
  const auth = scoped(envA);
  const servers = await request(app).get('/api/servers').set(auth);
  assert.equal(servers.status, 200);
  assert.deepEqual(servers.body.map(row => row.id), [serverA.id]);

  const dashboard = await request(app).get('/api/dashboard').set(auth);
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.servers.map(row => row.id), [serverA.id]);
  assert.ok(dashboard.body.recentHistory.every(row => row.environment_id === envA));

  const alerts = await request(app).get('/api/alerts?status=all').set(auth);
  assert.equal(alerts.status, 200);
  assert.deepEqual(alerts.body.map(row => row.server_id), [serverA.id]);

  const audit = await request(app).get('/api/system/audit').set(auth);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some(row => row.action === 'environment.a.event'));
  assert.ok(!audit.body.some(row => row.action === 'environment.b.event'));
  assert.ok(audit.body.every(row => row.environment_id === envA));

  const variables = await request(app).get('/api/ansible-vars').set(auth);
  assert.equal(variables.status, 200);
  assert.equal(variables.body.length, 1);
  assert.equal(variables.body[0].environment_id, envA);

  const schedules = await request(app).get('/api/schedules').set(auth);
  assert.equal(schedules.status, 200);
  assert.deepEqual(schedules.body.map(row => row.environment_id), [envA]);

  const subnets = await request(app).get('/api/ipam/subnets').set(auth);
  assert.equal(subnets.status, 200);
  assert.deepEqual(subnets.body.map(row => row.environment_id), [envA]);
});

test('cross-environment IDs and contradictory parameters cannot reveal data', async () => {
  const auth = scoped(envA);
  for (const endpoint of [
    `/api/servers/${serverB.id}`,
    `/api/ipam/subnets/${subnetB}`,
  ]) {
    const response = await request(app).get(endpoint).set(auth);
    assert.equal(response.status, 404, endpoint);
  }

  const maintenance = await request(app).put(`/api/maintenance-windows/${windowB}`).set(auth).send({
    name: 'Must remain hidden',
    starts_at: '2030-01-01T00:00:00.000Z',
    ends_at: '2030-01-01T01:00:00.000Z',
  });
  assert.equal(maintenance.status, 404);
  assert.equal(db.db.prepare('SELECT name FROM maintenance_windows WHERE id = ?').get(windowB).name, 'Window B');

  const schedule = await request(app).get(`/api/schedules/${scheduleB}`).set(auth);
  assert.ok([403, 404].includes(schedule.status));
  assert.notEqual(schedule.status, 200);

  const mismatch = await request(app).get(`/api/servers?environment_id=${encodeURIComponent(envB)}`).set(auth);
  assert.equal(mismatch.status, 409);
});

test('request-generated audit entries inherit the active environment', async () => {
  const created = await request(app).post('/api/maintenance-windows').set(scoped(envA)).send({
    environment_id: envA,
    name: 'Window A',
    starts_at: '2031-01-01T00:00:00.000Z',
    ends_at: '2031-01-01T01:00:00.000Z',
  });
  assert.equal(created.status, 201);

  const inA = db.auditLog.query({ environmentId: envA, action: 'maintenance_window.create' });
  const inB = db.auditLog.query({ environmentId: envB, action: 'maintenance_window.create' });
  assert.equal(inA.length, 1);
  assert.equal(inB.length, 0);
});
