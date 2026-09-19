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
const db = require('../db');

const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const systemInfo = require('../services/system-info');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
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

test('POST /api/servers rejects unsafe ansible inventory names', async () => {
  for (const name of ['all', 'localhost', '-bad', 'bad name']) {
    const res = await request(app)
      .post('/api/servers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, ip_address: '10.0.0.2' });
    assert.equal(res.status, 400);
  }
});

let serverId;
let productionGroupId;

test('POST /api/servers creates server with defaults', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'my-server',
      ip_address: '192.168.1.50',
      links: [
        { name: 'Sonarr', url: 'http://192.168.1.50:8989' },
        { name: 'Radarr', url: 'https://radarr.example.test' },
      ],
      storage_mounts: [
        { name: 'Media', path: '/mnt/media' },
        { name: 'Backups', path: '/mnt/backups' },
      ],
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'my-server');
  assert.equal(res.body.ip_address, '192.168.1.50');
  assert.equal(res.body.ssh_port, 22);
  assert.equal(res.body.ssh_user, 'root');
  assert.deepEqual(res.body.tags, []);
  assert.deepEqual(res.body.links, [
    { name: 'Sonarr', url: 'http://192.168.1.50:8989/' },
    { name: 'Radarr', url: 'https://radarr.example.test/' },
  ]);
  assert.deepEqual(res.body.storage_mounts, [
    { name: 'Media', path: '/mnt/media' },
    { name: 'Backups', path: '/mnt/backups' },
  ]);
  assert.ok(typeof res.body.id === 'string');
  serverId = res.body.id;
});

test('POST /api/servers respects custom SSH settings and owner', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'custom-server', ip_address: '10.0.0.5', ssh_port: 2222, ssh_user: 'admin', owner: 'Platform Operations' });
  assert.equal(res.status, 201);
  assert.equal(res.body.ssh_port, 2222);
  assert.equal(res.body.ssh_user, 'admin');
  assert.equal(res.body.owner, 'Platform Operations');
});

test('POST /api/servers rejects an oversized owner', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'owner-too-long', ip_address: '10.0.0.6', owner: 'x'.repeat(101) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Owner too long/);
});

test('POST /api/servers/groups creates a folder for tag auto-grouping', async () => {
  const res = await request(app)
    .post('/api/servers/groups')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'production', color: '#ff0000' });
  assert.equal(res.status, 200);
  productionGroupId = res.body.id;
});

test('POST /api/servers auto-assigns group from matching tag', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'tagged-server', ip_address: '10.0.0.55', tags: ['production'] });
  assert.equal(res.status, 201);
  assert.equal(res.body.group_id, productionGroupId);
});

// ── List ──────────────────────────────────────────────────────────────────────

test('GET /api/servers returns all created servers', async () => {
  const res = await request(app)
    .get('/api/servers')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 3);
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
    .send({
      name: 'renamed-server',
      ip_address: '192.168.1.99',
      links: [{ name: 'Admin', url: 'https://admin.example.test/ui' }],
      storage_mounts: [{ name: 'Archive', path: '/srv/archive' }],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'renamed-server');
  assert.equal(res.body.ip_address, '192.168.1.99');
  assert.deepEqual(res.body.links, [{ name: 'Admin', url: 'https://admin.example.test/ui' }]);
  assert.deepEqual(res.body.storage_mounts, [{ name: 'Archive', path: '/srv/archive' }]);
});

test('POST /api/servers rejects invalid server link protocol', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'bad-link-server',
      ip_address: '10.0.0.61',
      links: [{ name: 'SMB', url: 'smb://10.0.0.61/share' }],
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /http or https/i);
});

test('POST /api/servers rejects invalid storage mount path', async () => {
  const res = await request(app)
    .post('/api/servers')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'bad-mount-server',
      ip_address: '10.0.0.60',
      storage_mounts: [{ name: 'Bad', path: 'relative/path' }],
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid/i);
});

test('POST /api/servers/auto-group-by-tags moves existing matching servers into folders', async () => {
  const opsGroup = await request(app)
    .post('/api/servers/groups')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'ops', color: '#00ff00' });
  assert.equal(opsGroup.status, 200);

  const stray = db.servers.create({
    name: 'stray-server',
    hostname: 'stray.local',
    ip_address: '10.0.0.88',
    tags: ['ops'],
    services: [],
  });
  assert.equal(db.servers.getById(stray.id).group_id, null);

  const res = await request(app)
    .post('/api/servers/auto-group-by-tags')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.moved >= 1, true);
  assert.equal(db.servers.getById(stray.id).group_id, opsGroup.body.id);
});

test('PUT /api/servers/:id returns 404 for unknown id', async () => {
  const res = await request(app)
    .put('/api/servers/does-not-exist')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'ghost' });
  assert.equal(res.status, 404);
});

// ── Notes ─────────────────────────────────────────────────────────────────────

test('notes require a current revision and preserve saved text on a stale write', async () => {
  const path = `/api/servers/${serverId}/notes`;
  const auth = { Authorization: `Bearer ${token}` };
  const initial = await request(app).get(path).set(auth);
  assert.equal(initial.status, 200);
  const missing = await request(app).put(path).set(auth).send({ notes: 'Missing revision' });
  assert.equal(missing.status, 428);
  const putRes = await request(app).put(path).set(auth)
    .send({ notes: 'This is a test note.', revision: initial.body.revision });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.revision, initial.body.revision + 1);
  const stale = await request(app).put(path).set(auth)
    .send({ notes: 'Stale overwrite', revision: initial.body.revision });
  assert.equal(stale.status, 409);
  const getRes = await request(app).get(path).set(auth);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.notes, 'This is a test note.');
  assert.equal(getRes.body.revision, putRes.body.revision);
});

test('GET /api/servers/:id/info returns configured storage mount metrics', async () => {
  const original = systemInfo.getSystemInfo;
  systemInfo.getSystemInfo = async () => ({
    os: 'Debian 12',
    kernel: '6.1.0',
    cpu: 'Intel Test CPU',
    cpu_cores: 4,
    ram_total_mb: 4096,
    ram_used_mb: 1024,
    disk_total_gb: 120,
    disk_used_gb: 48,
    storage_mount_metrics: [
      {
        name: 'Archive',
        path: '/srv/archive',
        filesystem: '10.0.0.10:/archive',
        total_gb: 2000,
        used_gb: 750,
        available_gb: 1250,
        usage_pct: 38,
        mounted: true,
      },
    ],
    uptime_seconds: 1234,
    load_avg: '0.10 0.20 0.30',
    reboot_required: false,
    cpu_usage_pct: 12,
  });
  try {
    const res = await request(app)
      .get(`/api/servers/${serverId}/info?force=1`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.storage_mount_metrics, [
      {
        name: 'Archive',
        path: '/srv/archive',
        filesystem: '10.0.0.10:/archive',
        total_gb: 2000,
        used_gb: 750,
        available_gb: 1250,
        usage_pct: 38,
        mounted: true,
      },
    ]);
    assert.equal(res.body._source, 'ssh');
    assert.match(res.body.updated_at, /^\d{4}-\d{2}-\d{2}/);

  } finally {
    systemInfo.getSystemInfo = original;
  }
});

test('host checks keep current facts without recording capacity time series', () => {
  for (let index = 0; index < 55; index++) {
    db.serverInfo.upsert(serverId, {cpu_usage_pct:index,ram_used_mb:1000+index,ram_total_mb:4096,disk_used_gb:40+index,disk_total_gb:200});
  }
  assert.equal(db.serverInfo.get(serverId).cpu_usage_pct,54);
  assert.equal(db.db.prepare("SELECT name FROM sqlite_master WHERE name='server_info_history'").get(),undefined);
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

test('GET /api/servers/:id/docker/:container/logs uses direct host SSH with sudo fallback', async () => {
  const original = sshManager.execCommand;
  let captured = null;
  sshManager.execCommand = async (server, command) => {
    captured = { server, command };
    return { code: 0, stdout: 'log line 1\nlog line 2\n', stderr: '' };
  };
  try {
    const res = await request(app)
      .get(`/api/servers/${serverId}/docker/app-1/logs?tail=50`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.logs, 'log line 1\nlog line 2\n');
    assert.equal(captured.server.id, serverId);
    assert.match(captured.command, /logs --tail 50 --timestamps -- 'app-1'/);
    assert.match(captured.command, /sudo -n/);
  } finally {
    sshManager.execCommand = original;
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
