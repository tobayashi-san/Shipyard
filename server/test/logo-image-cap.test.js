'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_logo_cap_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-logo-cap';
process.env.NODE_ENV = 'test';

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const { router: authRouter } = require('../routes/auth');
const systemRouter = require('../routes/system');
const authMiddleware = require('../middleware/auth');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', authRouter);
app.use('/api/system', authMiddleware, systemRouter);

let adminToken = '';

before(async () => {
  const setup = await request(app).post('/api/auth/setup').send({ password: 'testpass1234' });
  adminToken = setup.body.token;
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('logoImage under 32 KB is accepted', async () => {
  const small = 'data:image/png;base64,' + 'A'.repeat(20000);
  const res = await request(app)
    .put('/api/system/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ logoImage: small });
  assert.equal(res.status, 200);
});

test('logoImage at exactly 32 KB boundary is accepted', async () => {
  const boundary = 'A'.repeat(32768);
  const res = await request(app)
    .put('/api/system/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ logoImage: boundary });
  assert.equal(res.status, 200);
});

test('logoImage over 32 KB is rejected with 400 (no silent truncation)', async () => {
  const tooBig = 'A'.repeat(32769);
  const res = await request(app)
    .put('/api/system/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ logoImage: tooBig });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /logoImage too large/i);
});

test('logoImage non-string is rejected with 400', async () => {
  const res = await request(app)
    .put('/api/system/settings')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ logoImage: 12345 });
  assert.equal(res.status, 400);
});
