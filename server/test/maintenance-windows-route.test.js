'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_maintenance_windows_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-maintenance-windows';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const maintenanceWindowsRouter = require('../routes/maintenance-windows');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/maintenance-windows', maintenanceWindowsRouter);

let token;
let environmentId;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'Maintenance test');
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('maintenance windows validate their period and are scoped to the environment', async () => {
  const invalid = await request(app).post('/api/maintenance-windows').set('Authorization', `Bearer ${token}`).send({
    environment_id: environmentId,
    name: 'Invalid period',
    starts_at: '2099-08-12T12:00:00.000Z',
    ends_at: '2099-08-12T11:00:00.000Z',
  });
  assert.equal(invalid.status, 400);

  const invalidTimezone = await request(app).post('/api/maintenance-windows').set('Authorization', `Bearer ${token}`).send({
    environment_id: environmentId,
    name: 'Invalid timezone',
    starts_at: '2099-08-12T12:00:00.000Z',
    ends_at: '2099-08-12T14:00:00.000Z',
    timezone: 'Zurich-ish',
  });
  assert.equal(invalidTimezone.status, 400);

  const created = await request(app).post('/api/maintenance-windows').set('Authorization', `Bearer ${token}`).send({
    environment_id: environmentId,
    name: 'Proxmox maintenance',
    starts_at: '2099-08-12T12:00:00.000Z',
    ends_at: '2099-08-12T14:00:00.000Z',
    description: 'Update node',
    affected_resources: 'Cluster pve-prod, node pve-01',
    timezone: 'Europe/Zurich',
    owner: 'Platform team',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.environment_id, environmentId);
  assert.equal(created.body.state, 'scheduled');
  assert.equal(created.body.affected_resources, 'Cluster pve-prod, node pve-01');
  assert.equal(created.body.timezone, 'Europe/Zurich');
  assert.equal(created.body.owner, 'Platform team');

  const ownEnvironment = await request(app).get(`/api/maintenance-windows?environment_id=${environmentId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(ownEnvironment.status, 200);
  assert.equal(ownEnvironment.body.length, 1);
  const defaultEnvironment = await request(app).get('/api/maintenance-windows?environment_id=default').set('Authorization', `Bearer ${token}`);
  assert.equal(defaultEnvironment.status, 200);
  assert.equal(defaultEnvironment.body.length, 0);
});

test('maintenance windows can be updated and deleted with an audit trail', async () => {
  const created = await request(app).post('/api/maintenance-windows').set('Authorization', `Bearer ${token}`).send({
    environment_id: environmentId,
    name: 'Planned maintenance',
    starts_at: '2099-08-13T12:00:00.000Z',
    ends_at: '2099-08-13T14:00:00.000Z',
  });
  assert.equal(created.status, 201);

  const updated = await request(app).put(`/api/maintenance-windows/${created.body.id}`).set('Authorization', `Bearer ${token}`).send({
    name: 'Rescheduled maintenance',
    starts_at: '2099-08-13T13:00:00.000Z',
    ends_at: '2099-08-13T15:00:00.000Z',
    description: 'Followed by a reboot',
    affected_resources: 'Managed hosts tagged production',
    timezone: 'Europe/Zurich',
    owner: 'Operations',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Rescheduled maintenance');
  assert.equal(updated.body.affected_resources, 'Managed hosts tagged production');
  assert.equal(updated.body.owner, 'Operations');

  const deleted = await request(app).delete(`/api/maintenance-windows/${created.body.id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(deleted.status, 204);
  const audit = db.auditLog.query({ action: 'maintenance_window' });
  assert.ok(audit.some(row => row.action === 'maintenance_window.create'));
  assert.ok(audit.some(row => row.action === 'maintenance_window.update'));
  assert.ok(audit.some(row => row.action === 'maintenance_window.delete'));
});
