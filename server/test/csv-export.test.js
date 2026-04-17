'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_csv_export_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-csv-export';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');

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

async function createServer(payload) {
  const r = await request(app).post('/api/servers').set('Authorization', `Bearer ${token}`).send(payload);
  assert.equal(r.status, 201, `create failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

test('CSV export defuses formula injection in name field', async () => {
  await createServer({
    name: '=cmd|"/c calc"!A1',
    hostname: 'evil-host',
    ip_address: '10.0.0.1',
    ssh_port: 22,
    ssh_user: 'root',
  });

  const r = await request(app)
    .get('/api/servers/export?format=csv')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  // The dangerous "=cmd..." value must be quoted AND prefixed with "'"
  assert.match(r.text, /"'=cmd\|""\/c calc""!A1"/);
  // It must not appear unquoted starting a cell
  assert.doesNotMatch(r.text, /(^|,)=cmd/m);
});

test('CSV export defuses leading +, -, @, tab, and CR', async () => {
  const dangerous = ['+SUM(1+1)', '-2+3', '@SUM(A1)', '\tfoo', '\rbar'];
  for (let i = 0; i < dangerous.length; i++) {
    await createServer({
      name: dangerous[i],
      hostname: `host-${i}`,
      ip_address: `10.0.1.${i + 1}`,
      ssh_port: 22,
      ssh_user: 'root',
    });
  }
  const r = await request(app)
    .get('/api/servers/export?format=csv')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  for (const v of dangerous) {
    // Each dangerous prefix must appear inside a quoted cell preceded by "'"
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"'${escaped}`);
    assert.match(r.text, re, `value ${JSON.stringify(v)} not properly escaped`);
  }
});

test('CSV export leaves benign values unquoted', async () => {
  await createServer({
    name: 'normal-server',
    hostname: 'normal-host',
    ip_address: '10.0.2.1',
    ssh_port: 22,
    ssh_user: 'root',
  });
  const r = await request(app)
    .get('/api/servers/export?format=csv')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  // benign row should appear without quoting around plain fields
  assert.match(r.text, /(^|\r\n)normal-server,normal-host,10\.0\.2\.1,22,root,/);
});
