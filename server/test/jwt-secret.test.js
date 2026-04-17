'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_jwt_secret_${Date.now()}.db`);

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Clean slate env
delete process.env.JWT_SECRET;
delete process.env.NODE_ENV;

const { getJwtSecret } = require('../utils/jwt-secret');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('getJwtSecret prefers JWT_SECRET env var', () => {
  process.env.JWT_SECRET = 'env-secret-value';
  assert.equal(getJwtSecret(), 'env-secret-value');
  delete process.env.JWT_SECRET;
});

test('getJwtSecret falls back to DB secret in non-production', () => {
  delete process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
  const s1 = getJwtSecret();
  assert.ok(typeof s1 === 'string' && s1.length >= 64);
  const s2 = getJwtSecret();
  assert.equal(s1, s2); // persists
});

test('getJwtSecret throws in production without JWT_SECRET', () => {
  delete process.env.JWT_SECRET;
  process.env.NODE_ENV = 'production';
  assert.throws(() => getJwtSecret(), /JWT_SECRET must be set in production/);
  process.env.NODE_ENV = 'test';
});

test('getJwtSecret works in production if JWT_SECRET is set', () => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'prod-secret';
  assert.equal(getJwtSecret(), 'prod-secret');
  delete process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
});
