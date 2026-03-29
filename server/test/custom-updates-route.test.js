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

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
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
