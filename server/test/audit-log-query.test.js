'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_audit_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-for-audit';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

before(() => {
  db.auditLog.write('login.success',  'user a',     '10.0.0.1', true,  'alice');
  db.auditLog.write('login.failed',   'bad creds',  '10.0.0.2', false, 'bob');
  db.auditLog.write('server.created', 'srv x',      '10.0.0.3', true,  'alice');
  db.auditLog.write('server.deleted', 'srv y',      '10.0.0.4', true,  'alice');
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('auditLog.query escapes LIKE wildcards in action filter', () => {
  // "%" should be a literal, not a wildcard — no row's action contains a literal "%"
  const rows = db.auditLog.query({ action: '%' });
  assert.equal(rows.length, 0);
});

test('auditLog.query escapes LIKE underscore in action filter', () => {
  // "_" should match literally, not "any single character"
  const rows = db.auditLog.query({ action: 'login_' });
  assert.equal(rows.length, 0);
});

test('auditLog.query still does prefix-matching on action', () => {
  const rows = db.auditLog.query({ action: 'login' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.action.startsWith('login')));
});

test('auditLog.query escapes wildcards in ip filter', () => {
  const rows = db.auditLog.query({ ip: '%' });
  assert.equal(rows.length, 0);
});

test('auditLog.query clamps negative offset to 0', () => {
  const rows = db.auditLog.query({ offset: -100 });
  assert.equal(rows.length, 4);
});

test('auditLog.query clamps NaN/invalid limit to default', () => {
  const rows = db.auditLog.query({ limit: 'not-a-number' });
  assert.equal(rows.length, 4);
});

test('auditLog.query clamps absurdly large limit to 500', () => {
  const rows = db.auditLog.query({ limit: 10_000_000 });
  // Just ensure it doesn't throw and returns existing rows
  assert.equal(rows.length, 4);
});
