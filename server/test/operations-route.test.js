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
  assert.deepEqual(response.body.items.map(item => item.name), ['server.visible']);
  assert.equal(response.body.items[0].target, visibleHost.name);
  assert.equal(response.body.items.some(item => item.target === hiddenHost.name), false);
  assert.equal(response.body.items.some(item => item.name === 'system.global'), false);
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
  assert.equal(oldest.body.items[0].name, 'dataset-item-00');
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
