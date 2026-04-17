'use strict';

const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_ws_auth_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-ws-auth';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { getJwtSecret } = require('../utils/jwt-secret');
const { verifyWsAuth, getWsUser } = require('../ws/auth');

// Seed a user
const passwordHash = bcrypt.hashSync('SuperSecret-12345', 10);
db.users.create('alice', passwordHash, 'admin');
const user = db.users.getByUsername('alice');

function fakeWs() {
  const calls = [];
  return {
    closed: null,
    close(code, reason) { this.closed = { code, reason }; calls.push({ code, reason }); },
    calls,
  };
}

function urlWith(token) {
  return new URL(`http://x/?token=${encodeURIComponent(token)}`);
}

test('verifyWsAuth rejects 2FA-pending temp token', () => {
  const tempToken = jwt.sign({ totp_pending: true, userId: user.id }, getJwtSecret(), { expiresIn: '5m' });
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, urlWith(tempToken));
  assert.equal(ok, false);
  assert.equal(ws.closed.code, 4001);
});

test('verifyWsAuth rejects token without userId', () => {
  const claimsOnly = jwt.sign({ foo: 'bar' }, getJwtSecret(), { expiresIn: '5m' });
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, urlWith(claimsOnly));
  assert.equal(ok, false);
  assert.equal(ws.closed.code, 4001);
});

test('verifyWsAuth rejects unknown user id', () => {
  const token = jwt.sign({ userId: 999999 }, getJwtSecret(), { expiresIn: '5m' });
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, urlWith(token));
  assert.equal(ok, false);
});

test('verifyWsAuth rejects token with stale token_version', () => {
  const token = jwt.sign({ userId: user.id, tv: 999 }, getJwtSecret(), { expiresIn: '5m' });
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, urlWith(token));
  assert.equal(ok, false);
});

test('verifyWsAuth accepts a valid full session token', () => {
  const token = jwt.sign({ userId: user.id, tv: user.token_version || 0 }, getJwtSecret(), { expiresIn: '1h' });
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, urlWith(token));
  assert.equal(ok, true);
  assert.equal(ws.closed, null);
});

test('getWsUser returns null for 2FA-pending temp token', () => {
  const tempToken = jwt.sign({ totp_pending: true, userId: user.id }, getJwtSecret(), { expiresIn: '5m' });
  assert.equal(getWsUser(urlWith(tempToken)), null);
});

test('getWsUser returns user for valid session token', () => {
  const token = jwt.sign({ userId: user.id, tv: user.token_version || 0 }, getJwtSecret(), { expiresIn: '1h' });
  const u = getWsUser(urlWith(token));
  assert.ok(u);
  assert.equal(u.id, user.id);
});

test('verifyWsAuth rejects missing token', () => {
  const ws = fakeWs();
  const ok = verifyWsAuth(ws, new URL('http://x/'));
  assert.equal(ok, false);
});
