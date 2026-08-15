'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_environment_permissions_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-environment-permissions';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { canAccessEnvironment } = require('../utils/permissions');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('restricted roles cannot use an environment-scoped API as a server-scope bypass', () => {
  const envA = db.uuidv4();
  const envB = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(envA, 'A');
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(envB, 'B');
  const host = db.servers.create({ name: 'host-a', hostname: 'host-a', ip_address: '10.0.0.10', environment_id: envA });
  const folder = db.uuidv4();
  db.db.prepare('INSERT INTO server_groups (id, name, environment_id) VALUES (?, ?, ?)').run(folder, 'Folder B', envB);

  assert.equal(canAccessEnvironment({ servers: { servers: [host.id], groups: [] } }, envA), true);
  assert.equal(canAccessEnvironment({ servers: { servers: [host.id], groups: [] } }, envB), false);
  assert.equal(canAccessEnvironment({ servers: { servers: [], groups: [folder] } }, envB), true);
  assert.equal(canAccessEnvironment({ servers: { servers: [], groups: [] } }, envA), false);
  assert.equal(canAccessEnvironment({ servers: 'all' }, envA), true);
  assert.equal(canAccessEnvironment({ full: true }, envB), true);
});
