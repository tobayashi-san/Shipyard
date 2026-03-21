'use strict';

// Must be set before any require that loads db.js
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_auth_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-auth-tests';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.get('/api/protected', authMiddleware, (_req, res) => res.json({ ok: true }));

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── Setup ─────────────────────────────────────────────────────────────────────

test('setup – rejects password under 12 chars', async () => {
  const res = await request(app).post('/api/auth/setup').send({ password: '12345678901' });
  assert.equal(res.status, 400);
});

test('setup – returns token for valid password', async () => {
  const res = await request(app).post('/api/auth/setup').send({ password: 'testpass1234' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
});

test('setup – rejects second setup attempt', async () => {
  const res = await request(app).post('/api/auth/setup').send({ password: 'anotherpass123' });
  assert.equal(res.status, 400);
});

// ── Login ─────────────────────────────────────────────────────────────────────

test('login – returns token with correct password', async () => {
  const res = await request(app).post('/api/auth/login').send({ password: 'testpass1234' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
});

test('login – rejects wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({ password: 'wrongpassword' });
  assert.equal(res.status, 401);
});

test('login – rejects missing body', async () => {
  const res = await request(app).post('/api/auth/login').send({});
  assert.equal(res.status, 400);
});

// ── Auth middleware ───────────────────────────────────────────────────────────

test('protected route – rejects missing token', async () => {
  const res = await request(app).get('/api/protected');
  assert.equal(res.status, 401);
});

test('protected route – rejects garbage token', async () => {
  const res = await request(app)
    .get('/api/protected')
    .set('Authorization', 'Bearer not.a.real.token');
  assert.equal(res.status, 401);
});

test('protected route – allows valid token', async () => {
  const { body: { token } } = await request(app)
    .post('/api/auth/login')
    .send({ password: 'testpass1234' });
  const res = await request(app)
    .get('/api/protected')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

// ── Change password ───────────────────────────────────────────────────────────

test('change – rejects wrong current password', async () => {
  const { body: { token } } = await request(app)
    .post('/api/auth/login')
    .send({ password: 'testpass1234' });
  const res = await request(app)
    .post('/api/auth/change')
    .set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: 'wrongcurrent', newPassword: 'newpassword456' });
  assert.equal(res.status, 401);
});

test('change – rejects new password under 12 chars', async () => {
  const { body: { token } } = await request(app)
    .post('/api/auth/login')
    .send({ password: 'testpass1234' });
  const res = await request(app)
    .post('/api/auth/change')
    .set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: 'testpass1234', newPassword: 'short' });
  assert.equal(res.status, 400);
});

test('change – succeeds with valid current password', async () => {
  const { body: { token } } = await request(app)
    .post('/api/auth/login')
    .send({ password: 'testpass1234' });
  const res = await request(app)
    .post('/api/auth/change')
    .set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: 'testpass1234', newPassword: 'newpassword456' });
  assert.equal(res.status, 200);
  assert.ok(res.body.success);
});

test('login – works with new password after change', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ password: 'newpassword456' });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
});

test('login – rejects old password after change', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ password: 'testpass1234' });
  assert.equal(res.status, 401);
});
