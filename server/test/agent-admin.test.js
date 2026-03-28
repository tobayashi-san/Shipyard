'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_agent_admin_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-agent-admin';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');
const agentAdminRouter = require('../routes/agent-admin');
const { encrypt } = require('../utils/crypto');

function wipeDb() {
  const tables = [
    'agent_metrics',
    'agent_config',
    'agent_manifests',
    'audit_log',
    'server_info',
    'servers',
  ];
  for (const t of tables) {
    try { db.db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', username: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/v1', agentAdminRouter);
  return app;
}

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('agent install does not persist config when deploy playbook fails', async () => {
  wipeDb();
  const app = makeApp();
  const server = db.servers.create({ name: 'agent-host-1', hostname: 'agent-host-1', ip_address: '10.0.0.21' });

  const originalIsInstalled = ansibleRunner.isInstalled;
  const originalRunPlaybook = ansibleRunner.runPlaybook;
  ansibleRunner.isInstalled = () => true;
  ansibleRunner.runPlaybook = async () => ({ success: false, stderr: 'boom' });

  try {
    const res = await request(app)
      .post(`/api/v1/servers/${server.id}/agent/install`)
      .send({ mode: 'pull', interval: 30 });

    assert.equal(res.status, 500);
    assert.equal(db.agentConfig.getByServerId(server.id), undefined);
  } finally {
    ansibleRunner.isInstalled = originalIsInstalled;
    ansibleRunner.runPlaybook = originalRunPlaybook;
  }
});

test('agent manifest validation errors return 400', async () => {
  wipeDb();
  const app = makeApp();

  const res = await request(app)
    .put('/api/v1/agent-manifest')
    .send({
      content: {
        version: 2,
        interval: 30,
        collectors: [{ id: 'memory' }],
      },
      changelog: 'invalid manifest test',
    });

  assert.equal(res.status, 400);
  assert.match(String(res.body.error || ''), /cmd is required/i);
});

test('agent configure rejects undecryptable stored token with 409', async () => {
  wipeDb();
  const app = makeApp();
  const server = db.servers.create({ name: 'agent-host-2', hostname: 'agent-host-2', ip_address: '10.0.0.22' });

  const originalIsInstalled = ansibleRunner.isInstalled;
  const originalRunPlaybook = ansibleRunner.runPlaybook;
  ansibleRunner.isInstalled = () => true;
  ansibleRunner.runPlaybook = async () => ({ success: true, stdout: '', stderr: '' });

  const originalSecret = process.env.SHIPYARD_KEY_SECRET;
  process.env.SHIPYARD_KEY_SECRET = 'agent-admin-secret';
  const encryptedToken = encrypt('agent-token-123');
  delete process.env.SHIPYARD_KEY_SECRET;

  db.agentConfig.upsert({
    server_id: server.id,
    mode: 'pull',
    token: encryptedToken,
    shipyard_url: 'http://shipyard.local',
    interval: 30,
    installed_at: new Date().toISOString(),
  });

  try {
    const res = await request(app)
      .put(`/api/v1/servers/${server.id}/agent/config`)
      .send({ mode: 'pull', interval: 45, shipyard_url: 'http://shipyard.local' });

    assert.equal(res.status, 409);
    assert.match(String(res.body.error || ''), /cannot be decrypted|rotate the token/i);
  } finally {
    ansibleRunner.isInstalled = originalIsInstalled;
    ansibleRunner.runPlaybook = originalRunPlaybook;
    if (originalSecret === undefined) delete process.env.SHIPYARD_KEY_SECRET;
    else process.env.SHIPYARD_KEY_SECRET = originalSecret;
  }
});
