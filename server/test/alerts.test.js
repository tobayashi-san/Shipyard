'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_alerts_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-alerts';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const resourceAlerts = require('../services/resource-alerts');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

function createServer(name = 'alert-node') {
  return db.servers.create({
    name,
    hostname: name,
    ip_address: '10.20.30.40',
    tags: [],
    services: [],
    links: [],
    storage_mounts: [],
  });
}

test('resource alert threshold is inclusive', () => {
  const server = createServer('threshold-inclusive');
  db.alertSettings.upsert(server.id, {
    trigger_after_seconds: 0,
    thresholds: { ram: 85, disk: 85, cpu: 90, storage: 85 },
  });
  db.serverInfo.upsert(server.id, {
    ram_total_mb: 1000,
    ram_used_mb: 850,
    disk_total_gb: 100,
    disk_used_gb: 84,
    cpu_usage_pct: 89,
  });
  db.servers.updateStatus(server.id, 'online');

  resourceAlerts.evaluateServer(server.id);
  const alerts = db.resourceAlerts.list({ statuses: ['active'], serverIds: [server.id] });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'ram');
  assert.equal(alerts[0].value, 85);
});

test('acknowledged alert stays quiet until condition resolves', () => {
  const server = createServer('ack-until-ok');
  db.alertSettings.upsert(server.id, { trigger_after_seconds: 0, thresholds: { disk: 85 } });
  db.serverInfo.upsert(server.id, {
    ram_total_mb: 1000,
    ram_used_mb: 100,
    disk_total_gb: 100,
    disk_used_gb: 90,
  });
  db.servers.updateStatus(server.id, 'online');

  resourceAlerts.evaluateServer(server.id);
  let alert = db.resourceAlerts.list({ statuses: ['active'], serverIds: [server.id] })[0];
  assert.equal(alert.type, 'disk');

  db.resourceAlerts.acknowledge(alert.id, 'tester');
  resourceAlerts.evaluateServer(server.id);
  alert = db.resourceAlerts.getById(alert.id);
  assert.equal(alert.status, 'acknowledged');

  db.serverInfo.upsert(server.id, {
    ram_total_mb: 1000,
    ram_used_mb: 100,
    disk_total_gb: 100,
    disk_used_gb: 20,
  });
  resourceAlerts.evaluateServer(server.id);
  alert = db.resourceAlerts.getById(alert.id);
  assert.equal(alert.status, 'resolved');
});

test('server specific thresholds override defaults', () => {
  const server = createServer('custom-threshold');
  db.alertSettings.upsert(server.id, { trigger_after_seconds: 0, thresholds: { cpu: 50 } });
  db.serverInfo.upsert(server.id, {
    ram_total_mb: 1000,
    ram_used_mb: 100,
    disk_total_gb: 100,
    disk_used_gb: 20,
    cpu_usage_pct: 50,
  });
  db.servers.updateStatus(server.id, 'online');

  resourceAlerts.evaluateServer(server.id);
  const alerts = db.resourceAlerts.list({ statuses: ['active'], serverIds: [server.id] });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'cpu');
});

test('available updates do not create resource alerts', () => {
  const server = createServer('updates-not-alerts');
  db.alertSettings.upsert(server.id, { trigger_after_seconds: 0 });
  db.servers.updateStatus(server.id, 'online');

  db.updatesCache.set(server.id, [
    { name: 'openssl', version: '3.0.1', phased: false },
    { name: 'curl', version: '8.0.0', phased: true },
  ]);
  db.dockerImageUpdatesCache.set(server.id, [
    { name: 'web', image: 'nginx:latest', status: 'update_available' },
  ]);
  const task = db.customUpdateTasks.create(server.id, {
    name: 'App update',
    type: 'command',
    check_command: 'echo update',
    update_command: '',
  });
  db.customUpdateTasks.setVersionInfo(task.id, '1.0.0', '1.1.0', true);

  resourceAlerts.evaluateServer(server.id);
  const alerts = db.resourceAlerts.list({ statuses: ['active'], serverIds: [server.id] });

  assert.deepEqual(alerts.map(a => a.type), []);
});

test('stale update alerts resolve after evaluation', () => {
  const server = createServer('resolve-update-alerts');
  db.alertSettings.upsert(server.id, { trigger_after_seconds: 0 });
  db.servers.updateStatus(server.id, 'online');
  const alert = db.resourceAlerts.createPending({
    serverId: server.id,
    type: 'updates',
    value: 2,
    threshold: 1,
    message: 'updates available',
  });
  db.resourceAlerts.activate(alert.id);

  resourceAlerts.evaluateServer(server.id);
  const resolved = db.resourceAlerts.getById(alert.id);

  assert.equal(resolved.status, 'resolved');
});
