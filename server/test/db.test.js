'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_db_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-db';
process.env.NODE_ENV = 'test';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── Servers CRUD ──────────────────────────────────────────────────────────────

describe('db.servers', () => {
  let serverId;

  test('create returns server with generated ID', () => {
    const s = db.servers.create({ name: 'test-srv', hostname: 'test.local', ip_address: '10.0.0.1', ssh_port: 22, ssh_user: 'root', tags: ['web'], services: [] });
    assert.ok(s.id);
    assert.equal(s.name, 'test-srv');
    assert.equal(s.ip_address, '10.0.0.1');
    serverId = s.id;
  });

  test('getAll returns created servers', () => {
    const all = db.servers.getAll();
    assert.ok(all.length >= 1);
  });

  test('getById returns correct server', () => {
    const s = db.servers.getById(serverId);
    assert.equal(s.name, 'test-srv');
  });

  test('getById returns undefined for unknown ID', () => {
    assert.equal(db.servers.getById('nonexistent'), undefined);
  });

  test('update modifies fields', () => {
    const s = db.servers.update(serverId, { name: 'updated-srv', hostname: 'test.local', ip_address: '10.0.0.2', ssh_port: 2222, ssh_user: 'admin', tags: ['db'], services: ['mysql'] });
    assert.equal(s.name, 'updated-srv');
    assert.equal(s.ip_address, '10.0.0.2');
    assert.equal(s.ssh_port, 2222);
  });

  test('updateStatus sets status', () => {
    db.servers.updateStatus(serverId, 'online');
    const s = db.servers.getById(serverId);
    assert.equal(s.status, 'online');
    assert.ok(s.last_seen); // online sets last_seen
  });

  test('setNotes and retrieve', () => {
    db.servers.setNotes(serverId, 'Test note');
    const s = db.servers.getById(serverId);
    assert.equal(s.notes, 'Test note');
  });

  test('delete removes server', () => {
    db.servers.delete(serverId);
    assert.equal(db.servers.getById(serverId), undefined);
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe('db.settings', () => {
  test('get returns null for missing key', () => {
    assert.equal(db.settings.get('nonexistent_setting'), null);
  });

  test('set and get round-trip', () => {
    db.settings.set('test_key', 'test_value');
    assert.equal(db.settings.get('test_key'), 'test_value');
  });

  test('set overwrites existing value', () => {
    db.settings.set('test_key', 'new_value');
    assert.equal(db.settings.get('test_key'), 'new_value');
  });

  test('getAll returns all settings', () => {
    db.settings.set('key_a', 'val_a');
    db.settings.set('key_b', 'val_b');
    const all = db.settings.getAll();
    assert.equal(all.key_a, 'val_a');
    assert.equal(all.key_b, 'val_b');
  });
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

describe('db.auditLog', () => {
  test('write and getRecent', () => {
    db.auditLog.write('test.action', 'Test detail', '127.0.0.1', true);
    db.auditLog.write('test.fail', 'Failed test', '10.0.0.1', false);
    const logs = db.auditLog.getRecent(10);
    assert.ok(logs.length >= 2);
    const latest = logs[0];
    assert.equal(latest.action, 'test.fail');
    assert.equal(latest.success, 0);
  });
});

// ── Roles ─────────────────────────────────────────────────────────────────────

describe('db.roles', () => {
  test('system roles exist', () => {
    const all = db.roles.getAll();
    const admin = all.find(r => r.id === 'admin');
    const user = all.find(r => r.id === 'user');
    assert.ok(admin, 'admin role should exist');
    assert.ok(user, 'user role should exist');
    assert.equal(admin.is_system, 1);
    assert.equal(user.is_system, 1);
  });

  test('create custom role', () => {
    const role = db.roles.create('viewer', { canViewServers: true });
    assert.ok(role.id);
    assert.equal(role.name, 'viewer');
    assert.equal(role.is_system, 0);
    const perms = JSON.parse(role.permissions);
    assert.equal(perms.canViewServers, true);
  });

  test('update role', () => {
    const role = db.roles.getAll().find(r => r.name === 'viewer');
    const updated = db.roles.update(role.id, 'viewer-v2', { canViewServers: true, canViewPlaybooks: true });
    assert.equal(updated.name, 'viewer-v2');
    const perms = JSON.parse(updated.permissions);
    assert.equal(perms.canViewPlaybooks, true);
  });

  test('delete custom role', () => {
    const role = db.roles.getAll().find(r => r.name === 'viewer-v2');
    db.roles.delete(role.id);
    assert.equal(db.roles.getById(role.id), undefined);
  });
});

// ── Users ─────────────────────────────────────────────────────────────────────

describe('db.users', () => {
  let userId;

  test('create user', () => {
    const u = db.users.create('testuser', 'test@example.com', '$2a$12$fakehash', 'user', 'Test User');
    assert.ok(u.id);
    assert.equal(u.username, 'testuser');
    assert.equal(u.display_name, 'Test User');
    userId = u.id;
  });

  test('getByUsername returns correct user', () => {
    const u = db.users.getByUsername('testuser');
    assert.ok(u);
    assert.equal(u.username, 'testuser');
    assert.ok(u.password_hash); // full user returned
  });

  test('getById returns user without password_hash', () => {
    const u = db.users.getById(userId);
    assert.equal(u.username, 'testuser');
    assert.equal(u.password_hash, undefined);
  });

  test('update user fields', () => {
    const u = db.users.update(userId, { email: 'new@example.com', display_name: 'New Name' });
    assert.equal(u.email, 'new@example.com');
    assert.equal(u.display_name, 'New Name');
  });

  test('incrementTokenVersion increments', () => {
    const before = db.users.getById(userId);
    db.users.incrementTokenVersion(userId);
    const after = db.users.getById(userId);
    assert.equal(after.token_version, (before.token_version || 0) + 1);
  });

  test('count returns correct number', () => {
    const c = db.users.count();
    assert.ok(c >= 1);
  });

  test('delete user', () => {
    db.users.delete(userId);
    assert.equal(db.users.getById(userId), undefined);
  });
});

// ── Schedules ─────────────────────────────────────────────────────────────────

describe('db.schedules', () => {
  let scheduleId;

  test('create schedule', () => {
    scheduleId = db.schedules.create('Nightly backup', 'backup.yml', 'all', '0 2 * * *');
    assert.ok(scheduleId);
  });

  test('getById returns correct schedule', () => {
    const s = db.schedules.getById(scheduleId);
    assert.equal(s.name, 'Nightly backup');
    assert.equal(s.playbook, 'backup.yml');
    assert.equal(s.cron_expression, '0 2 * * *');
    assert.equal(s.enabled, 1);
  });

  test('update schedule fields', () => {
    db.schedules.update(scheduleId, { name: 'Daily backup', enabled: 0 });
    const s = db.schedules.getById(scheduleId);
    assert.equal(s.name, 'Daily backup');
    assert.equal(s.enabled, 0);
  });

  test('update rejects invalid field', () => {
    assert.throws(() => db.schedules.update(scheduleId, { invalidField: 'x' }), /Invalid field/);
  });

  test('updateLastRun sets timestamp and status', () => {
    db.schedules.updateLastRun(scheduleId, 'success');
    const s = db.schedules.getById(scheduleId);
    assert.equal(s.last_status, 'success');
    assert.ok(s.last_run);
  });

  test('delete schedule', () => {
    db.schedules.delete(scheduleId);
    assert.equal(db.schedules.getById(scheduleId), undefined);
  });
});

// ── Server Groups ─────────────────────────────────────────────────────────────

describe('db.serverGroups', () => {
  let groupId;

  test('create group', () => {
    const g = db.serverGroups.create('Production', '#ff0000', null);
    assert.ok(g.id);
    assert.equal(g.name, 'Production');
    assert.equal(g.color, '#ff0000');
    groupId = g.id;
  });

  test('update group', () => {
    db.serverGroups.update(groupId, 'Prod', '#00ff00');
    const all = db.serverGroups.getAll();
    const g = all.find(x => x.id === groupId);
    assert.equal(g.name, 'Prod');
    assert.equal(g.color, '#00ff00');
  });

  test('setServerGroup links server to group', () => {
    const s = db.servers.create({ name: 'grouped-srv', hostname: 'g.local', ip_address: '10.0.0.99', tags: [], services: [] });
    db.serverGroups.setServerGroup(s.id, groupId);
    const updated = db.servers.getById(s.id);
    assert.equal(updated.group_id, groupId);
    db.servers.delete(s.id);
  });

  test('delete group', () => {
    db.serverGroups.delete(groupId);
    const all = db.serverGroups.getAll();
    assert.equal(all.find(x => x.id === groupId), undefined);
  });
});

// ── Ansible Vars ──────────────────────────────────────────────────────────────

describe('db.ansibleVars', () => {
  let varId;

  test('create var', () => {
    const v = db.ansibleVars.create('env', 'production', 'Environment name');
    assert.ok(v.id);
    assert.equal(v.key, 'env');
    assert.equal(v.value, 'production');
    varId = v.id;
  });

  test('toExtraVars returns key-value map', () => {
    const vars = db.ansibleVars.toExtraVars();
    assert.equal(vars.env, 'production');
  });

  test('update var', () => {
    const v = db.ansibleVars.update(varId, 'env', 'staging', 'Updated');
    assert.equal(v.value, 'staging');
  });

  test('delete var', () => {
    db.ansibleVars.delete(varId);
    const all = db.ansibleVars.getAll();
    assert.equal(all.find(v => v.id === varId), undefined);
  });
});
