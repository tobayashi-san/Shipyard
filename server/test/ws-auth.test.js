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
const { canReceive } = require('../ws');

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

test('websocket events are isolated by environment even for full-access users', () => {
  const envA = db.uuidv4();
  const envB = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?), (?, ?)').run(envA, 'WS A', envB, 'WS B');
  const serverA = db.servers.create({ name: 'ws-a', hostname: 'ws-a', ip_address: '10.92.0.10', environment_id: envA });
  const serverB = db.servers.create({ name: 'ws-b', hostname: 'ws-b', ip_address: '10.93.0.10', environment_id: envB });
  const metaA = { perms: { full: true }, environmentId: envA };

  assert.equal(canReceive({ type: 'update_output', serverId: serverA.id }, metaA), true);
  assert.equal(canReceive({ type: 'update_output', serverId: serverB.id }, metaA), false);

  const historyB = db.updateHistory.create(serverB.id, 'update', 'admin', envB);
  const workflowB = db.scheduleHistory.create(null, 'WS workflow B', 'update.yml', serverB.name, { environmentId: envB });
  const scheduleB = db.schedules.create('WS schedule B', 'update.yml', serverB.name, '0 0 * * *', { environmentId: envB });
  assert.equal(canReceive({ type: 'update_output', historyId: historyB }, metaA), false);
  assert.equal(canReceive({ type: 'ansible_output', historyId: workflowB, runId: workflowB }, metaA), false);
  assert.equal(canReceive({ type: 'ansible_output', historyId: workflowB, runId: workflowB }, { perms: { full: true }, environmentId: envB }), true);
  assert.equal(canReceive({ type: 'schedule_start', scheduleId: scheduleB }, metaA), false);
  assert.equal(canReceive({ type: 'cache_updated', scope: 'updates' }, metaA), true);
});

test('websocket events require both a matching capability and assigned host', () => {
  const env = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(env, 'WS restricted');
  const allowed = db.servers.create({ name: 'ws-allowed', hostname: 'ws-allowed', ip_address: '10.94.0.10', environment_id: env });
  const hidden = db.servers.create({ name: 'ws-hidden', hostname: 'ws-hidden', ip_address: '10.94.0.11', environment_id: env });
  const assignedOnly = {
    environmentId: env,
    perms: {
      servers: { servers: [allowed.id], groups: [] },
      canViewServers: true,
    },
  };

  assert.equal(canReceive({ type: 'resource_alert_triggered', serverId: allowed.id }, assignedOnly), true);
  assert.equal(canReceive({ type: 'resource_alert_triggered', serverId: hidden.id }, assignedOnly), false);
  assert.equal(canReceive({ type: 'update_output', serverId: allowed.id }, assignedOnly), false);
  assert.equal(canReceive({ type: 'ansible_output', serverId: allowed.id }, assignedOnly), false);
  assert.equal(canReceive({ type: 'tofu_start', environmentId: env }, assignedOnly), false);
  assert.equal(canReceive({ type: 'cache_updated', scope: 'updates', environmentId: env }, assignedOnly), false);
  assert.equal(canReceive({ type: 'cache_updated', scope: 'info', environmentId: env }, assignedOnly), true);
  assert.equal(canReceive({ type: 'unclassified_internal_event', environmentId: env }, assignedOnly), false);

  const updateViewer = {
    ...assignedOnly,
    perms: { ...assignedOnly.perms, canViewUpdates: true },
  };
  assert.equal(canReceive({ type: 'update_output', serverId: allowed.id }, updateViewer), true);
  assert.equal(canReceive({ type: 'update_output', serverId: hidden.id }, updateViewer), false);
});
