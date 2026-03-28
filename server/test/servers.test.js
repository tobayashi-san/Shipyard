'use strict';

// Must be set before any require that loads db.js
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_servers_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-server-tests';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');
const sshManager = require('../services/ssh-manager');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
app.use('/api/servers', serversRouter);

let token;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const { body } = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = body.token;
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── Auth guard ────────────────────────────────────────────────────────────────

test('GET /api/servers returns 401 without token', async () => {
  const res = await request(app).get('/api/servers');
  assert.equal(res.status, 401);
});

// ── Create ────────────────────────────────────────────────────────────────────

test('POST /api/servers rejects missing ip_address', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'no-ip-server' });
  assert.equal(res.status, 400);
});

test('POST /api/servers rejects missing name', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ ip_address: '10.0.0.1' });
  assert.equal(res.status, 400);
});

let serverId;

test('POST /api/servers creates server with defaults', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'my-server', ip_address: '192.168.1.50' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'my-server');
  assert.equal(res.body.ip_address, '192.168.1.50');
  assert.equal(res.body.ssh_port, 22);
  assert.equal(res.body.ssh_user, 'root');
  assert.deepEqual(res.body.tags, []);
  assert.ok(typeof res.body.id === 'string');
  serverId = res.body.id;
});

test('POST /api/servers respects custom ssh_port and ssh_user', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'custom-server', ip_address: '10.0.0.5', ssh_port: 2222, ssh_user: 'admin' });
  assert.equal(res.status, 201);
  assert.equal(res.body.ssh_port, 2222);
  assert.equal(res.body.ssh_user, 'admin');
});

// ── List ──────────────────────────────────────────────────────────────────────

test('GET /api/servers returns all created servers', async () => {
  const res = await request(app)
    .get('/api/servers')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
});

// ── Get by ID ─────────────────────────────────────────────────────────────────

test('GET /api/servers/:id returns correct server', async () => {
  const res = await request(app)
    .get(`/api/servers/${serverId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, serverId);
  assert.equal(res.body.name, 'my-server');
});

test('GET /api/servers/:id returns 404 for unknown id', async () => {
  const res = await request(app)
    .get('/api/servers/does-not-exist')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

// ── Update ────────────────────────────────────────────────────────────────────

test('PUT /api/servers/:id updates name and ip', async () => {
  const res = await request(app)
    .put(`/api/servers/${serverId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'renamed-server', ip_address: '192.168.1.99' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'renamed-server');
  assert.equal(res.body.ip_address, '192.168.1.99');
});

test('PUT /api/servers/:id returns 404 for unknown id', async () => {
  const res = await request(app)
    .put('/api/servers/does-not-exist')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'ghost' });
  assert.equal(res.status, 404);
});

// ── Notes ─────────────────────────────────────────────────────────────────────

test('PUT /api/servers/:id/notes saves and GET reads notes', async () => {
  const putRes = await request(app)
    .put(`/api/servers/${serverId}/notes`)
    .set('Authorization', `Bearer ${token}`)
    .send({ notes: 'This is a test note.' });
  assert.equal(putRes.status, 200);

  const getRes = await request(app)
    .get(`/api/servers/${serverId}/notes`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.notes, 'This is a test note.');
});

test('POST /api/servers/:id/reset-host-key removes stale known_hosts entries', async () => {
  const original = sshManager.removeKnownHostEntries;
  sshManager.removeKnownHostEntries = (hosts) => ({ removed: hosts.filter(Boolean), missing: [] });
  try {
    const res = await request(app)
      .post(`/api/servers/${serverId}/reset-host-key`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing, []);
    assert.ok(res.body.removed.includes('192.168.1.99'));
  } finally {
    sshManager.removeKnownHostEntries = original;
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

test('DELETE /api/servers/:id removes server', async () => {
  const res = await request(app)
    .delete(`/api/servers/${serverId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
});

test('GET /api/servers/:id returns 404 after deletion', async () => {
  const res = await request(app)
    .get(`/api/servers/${serverId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});

test('DELETE /api/servers/:id returns 404 for already deleted server', async () => {
  const res = await request(app)
    .delete(`/api/servers/${serverId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 404);
});
