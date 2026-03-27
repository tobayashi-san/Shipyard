const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../db');
const { encrypt } = require('../utils/crypto');
const agentRouter = require('../routes/agent');

function wipeDb() {
  const tables = [
    'agent_metrics',
    'agent_config',
    'agent_manifests',
    'server_info',
    'servers',
  ];
  for (const t of tables) db.db.prepare(`DELETE FROM ${t}`).run();
}

function makeApp({ trustProxy = false } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/agent', agentRouter);
  return app;
}

test('agent manifest endpoint rejects insecure transport', async () => {
  wipeDb();
  const app = makeApp();
  const server = db.servers.create({ name: 's1', hostname: 's1', ip_address: '10.0.0.10' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: encrypt('tok1'), interval: 30 });

  const res = await request(app)
    .get('/api/v1/agent/manifest')
    .set('Authorization', 'Bearer tok1');

  assert.equal(res.status, 400);
  assert.match(String(res.body.error || ''), /HTTPS is required/);
});

test('agent manifest endpoint accepts trusted proxy https and token', async () => {
  wipeDb();
  const app = makeApp({ trustProxy: true });
  const server = db.servers.create({ name: 's2', hostname: 's2', ip_address: '10.0.0.11' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: encrypt('tok2'), interval: 30 });

  const res = await request(app)
    .get('/api/v1/agent/manifest')
    .set('X-Forwarded-Proto', 'https')
    .set('Authorization', 'Bearer tok2');

  assert.equal(res.status, 200);
  assert.equal(Number.isInteger(res.body.version), true);
  assert.equal(Array.isArray(res.body.collectors), true);
});

test('agent report endpoint writes metrics and updates server status', async () => {
  wipeDb();
  const app = makeApp({ trustProxy: true });
  const server = db.servers.create({ name: 's3', hostname: 's3', ip_address: '10.0.0.12' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: encrypt('tok3'), interval: 30 });

  const report = {
    timestamp: Math.floor(Date.now() / 1000),
    manifest_version: 1,
    runner_version: '3.0.0',
    collectors: [
      { id: 'memory', output: 'MemTotal: 1024000\nMemAvailable: 512000\n' },
      { id: 'disk', output: 'Filesystem 1M-blocks Used Available Use% Mounted on\n/dev/sda1 1000 250 750 25% /\n' },
      { id: 'load', output: '0.10 0.20 0.30 1/100 9999' },
      { id: 'uptime', output: '12345.67' },
      { id: 'os_info', output: 'PRETTY_NAME="Debian"\n' },
      { id: 'nproc', output: '2' },
    ],
  };

  const res = await request(app)
    .post('/api/v1/agent/report')
    .set('X-Forwarded-Proto', 'https')
    .set('Authorization', 'Bearer tok3')
    .send(report);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const info = db.serverInfo.get(server.id);
  const updatedServer = db.servers.getById(server.id);
  const metrics = db.agentMetrics.recentByServer(server.id, 1);
  const cfg = db.agentConfig.getByServerId(server.id);

  assert.equal(updatedServer.status, 'online');
  assert.equal(info.os, 'Debian');
  assert.equal(Array.isArray(metrics), true);
  assert.equal(metrics.length, 1);
  assert.equal(cfg.runner_version, '3.0.0');
});

test('agent report endpoint is token-protected and rate-limited', async () => {
  wipeDb();
  const app = makeApp({ trustProxy: true });
  const server = db.servers.create({ name: 's4', hostname: 's4', ip_address: '10.0.0.13' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: encrypt('tok4'), interval: 30 });

  const bad = await request(app)
    .post('/api/v1/agent/report')
    .set('X-Forwarded-Proto', 'https')
    .set('Authorization', 'Bearer wrong')
    .send({ collectors: [] });
  assert.equal(bad.status, 401);

  const first = await request(app)
    .post('/api/v1/agent/report')
    .set('X-Forwarded-Proto', 'https')
    .set('Authorization', 'Bearer tok4')
    .send({ timestamp: Math.floor(Date.now() / 1000), collectors: [] });
  assert.equal(first.status, 200);

  const second = await request(app)
    .post('/api/v1/agent/report')
    .set('X-Forwarded-Proto', 'https')
    .set('Authorization', 'Bearer tok4')
    .send({ timestamp: Math.floor(Date.now() / 1000), collectors: [] });
  assert.equal(second.status, 429);
});
