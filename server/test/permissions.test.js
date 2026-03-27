'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_perms_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-perms';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { getPermissions, filterServers, filterPlaybooks, filterPlugins, can, ALLOWED_PERMISSION_KEYS } = require('../utils/permissions');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── can() ─────────────────────────────────────────────────────────────────────

test('can() returns false for null permissions', () => {
  assert.equal(can(null, 'canViewServers'), false);
});

test('can() returns true for full permissions', () => {
  assert.equal(can({ full: true }, 'canViewServers'), true);
  assert.equal(can({ full: true }, 'anything'), true);
});

test('can() returns true when capability is explicitly true', () => {
  assert.equal(can({ canViewServers: true }, 'canViewServers'), true);
});

test('can() returns false when capability is missing (fail-closed)', () => {
  assert.equal(can({ canViewServers: true }, 'canDeleteServers'), false);
});

test('can() returns false when capability is explicitly false', () => {
  assert.equal(can({ canViewServers: false }, 'canViewServers'), false);
});

// ── getPermissions() ──────────────────────────────────────────────────────────

test('getPermissions() returns null for no user', () => {
  assert.equal(getPermissions(null), null);
  assert.equal(getPermissions(undefined), null);
});

test('getPermissions() returns full for admin role', () => {
  const perms = getPermissions({ role: 'admin' });
  assert.deepEqual(perms, { full: true });
});

test('getPermissions() returns fail-closed for unknown role', () => {
  const perms = getPermissions({ role: 'nonexistent-role-id' });
  assert.deepEqual(perms, { servers: [], playbooks: [], plugins: [] });
});

test('getPermissions() merges role permissions with defaults for user role', () => {
  const perms = getPermissions({ role: 'user' });
  assert.equal(perms.canViewServers, true);
  assert.equal(perms.canAddServers, true);
  assert.equal(perms.servers, 'all');
});

test('getPermissions() returns correct permissions for custom role', () => {
  db.roles.create('viewer', { canViewServers: true, canEditServers: false, servers: 'all' });
  const role = db.roles.getAll().find(r => r.name === 'viewer');
  const perms = getPermissions({ role: role.id });
  assert.equal(perms.canViewServers, true);
  assert.equal(perms.canEditServers, false);
  assert.equal(perms.servers, 'all');
});

// ── filterServers() ───────────────────────────────────────────────────────────

const sampleServers = [
  { id: 's1', name: 'web1', group_id: 'g1' },
  { id: 's2', name: 'db1', group_id: 'g2' },
  { id: 's3', name: 'cache1', group_id: null },
];

test('filterServers() returns empty for null permissions', () => {
  assert.deepEqual(filterServers(sampleServers, null), []);
});

test('filterServers() returns all for full permissions', () => {
  assert.deepEqual(filterServers(sampleServers, { full: true }), sampleServers);
});

test('filterServers() returns all when servers is "all"', () => {
  assert.deepEqual(filterServers(sampleServers, { servers: 'all' }), sampleServers);
});

test('filterServers() filters by server IDs', () => {
  const perms = { servers: { servers: ['s1', 's3'], groups: [] } };
  const result = filterServers(sampleServers, perms);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(s => s.id), ['s1', 's3']);
});

test('filterServers() filters by group IDs', () => {
  const perms = { servers: { servers: [], groups: ['g2'] } };
  const result = filterServers(sampleServers, perms);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 's2');
});

test('filterServers() returns empty when servers is not object or "all"', () => {
  assert.deepEqual(filterServers(sampleServers, { servers: false }), []);
  assert.deepEqual(filterServers(sampleServers, {}), []);
});

// ── filterPlaybooks() ─────────────────────────────────────────────────────────

const samplePlaybooks = [
  { filename: 'deploy.yml' },
  { filename: 'backup.yml' },
  { filename: 'update.yml' },
];

test('filterPlaybooks() returns empty for null permissions', () => {
  assert.deepEqual(filterPlaybooks(samplePlaybooks, null), []);
});

test('filterPlaybooks() returns all for full permissions', () => {
  assert.deepEqual(filterPlaybooks(samplePlaybooks, { full: true }), samplePlaybooks);
});

test('filterPlaybooks() returns all when playbooks is "all"', () => {
  assert.deepEqual(filterPlaybooks(samplePlaybooks, { playbooks: 'all' }), samplePlaybooks);
});

test('filterPlaybooks() filters by filename list', () => {
  const perms = { playbooks: ['deploy.yml'] };
  const result = filterPlaybooks(samplePlaybooks, perms);
  assert.equal(result.length, 1);
  assert.equal(result[0].filename, 'deploy.yml');
});

// ── filterPlugins() ───────────────────────────────────────────────────────────

const samplePlugins = [
  { id: 'opentofu' },
  { id: 'backup' },
];

test('filterPlugins() returns empty for null permissions', () => {
  assert.deepEqual(filterPlugins(samplePlugins, null), []);
});

test('filterPlugins() returns all for full permissions', () => {
  assert.deepEqual(filterPlugins(samplePlugins, { full: true }), samplePlugins);
});

test('filterPlugins() filters by plugin ID list', () => {
  const perms = { plugins: ['backup'] };
  const result = filterPlugins(samplePlugins, perms);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'backup');
});

// ── ALLOWED_PERMISSION_KEYS ──────────────────────────────────────────────────

test('ALLOWED_PERMISSION_KEYS does not include "full"', () => {
  assert.equal(ALLOWED_PERMISSION_KEYS.has('full'), false);
});

test('ALLOWED_PERMISSION_KEYS does not include resource lists', () => {
  assert.equal(ALLOWED_PERMISSION_KEYS.has('servers'), false);
  assert.equal(ALLOWED_PERMISSION_KEYS.has('playbooks'), false);
  assert.equal(ALLOWED_PERMISSION_KEYS.has('plugins'), false);
});

test('ALLOWED_PERMISSION_KEYS includes capability keys', () => {
  assert.equal(ALLOWED_PERMISSION_KEYS.has('canViewServers'), true);
  assert.equal(ALLOWED_PERMISSION_KEYS.has('canDeleteServers'), true);
  assert.equal(ALLOWED_PERMISSION_KEYS.has('canRunPlaybooks'), true);
  assert.equal(ALLOWED_PERMISSION_KEYS.has('canViewAudit'), true);
});
