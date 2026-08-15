'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_dashboard_updates_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-dashboard-updates';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const dashboardRouter = require('../routes/dashboard');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/dashboard', dashboardRouter);

let token;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('dashboard exposes custom desired-state deviations without exposing executable commands', async () => {
  const server = db.servers.create({ name: 'app-host', hostname: 'app-host.local', ip_address: '10.0.0.50' });
  db.servers.updateStatus(server.id, 'online');
  const task = db.customUpdateTasks.create(server.id, {
    name: 'My App', type: 'script', check_command: '/opt/app --version',
    latest_command: 'curl -fsS https://example.test/version', update_command: '/opt/app update',
  });
  db.customUpdateTasks.setVersionInfo(task.id, '1.0.0', '1.1.0', true);

  const res = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  const host = res.body.servers.find((item) => item.id === server.id);
  assert.equal(host.custom_updates_count, 1);
  assert.deepEqual(host.custom_update_tasks, [{
    id: task.id, name: 'My App', type: 'script', current_version: '1.0.0', last_version: '1.1.0',
    trigger_output: null, has_update: true, last_checked_at: host.custom_update_tasks[0].last_checked_at,
  }]);
  assert.equal('check_command' in host.custom_update_tasks[0], false);
  assert.equal('update_command' in host.custom_update_tasks[0], false);
});

test('dashboard omits agent presentation data while the agent feature is hidden', async () => {
  const server = db.servers.create({ name: 'hidden-agent-host', hostname: 'hidden-agent-host.local', ip_address: '10.0.0.51' });
  db.servers.updateStatus(server.id, 'online');
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: 'test-agent-token', interval: 30 });

  db.settings.set('agent_enabled', '0');
  const hidden = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.agentEnabled, false);
  const hiddenHost = hidden.body.servers.find((item) => item.id === server.id);
  assert.equal(hiddenHost.agent_mode, 'legacy');
  assert.equal(hiddenHost.agent_state, 'legacy');
  assert.equal(hiddenHost.agent_last_seen, null);

  db.settings.set('agent_enabled', '1');
  const visible = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.agentEnabled, true);
  const visibleHost = visible.body.servers.find((item) => item.id === server.id);
  assert.equal(visibleHost.agent_mode, 'push');
});
