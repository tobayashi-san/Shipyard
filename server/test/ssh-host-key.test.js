'use strict';

const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_hostkey_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-hostkey';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../db');
const sshManager = require('../services/ssh-manager');

const { makeHostVerifier, fingerprintHostKey } = sshManager;

// Seed a server row to attach fingerprints to.
const server = db.servers.create({
  name: 'tofu-test',
  hostname: 'tofu.local',
  ip_address: '192.0.2.42',
});

function fakeKey(seed) {
  return crypto.createHash('sha512').update(seed).digest();
}

test('fingerprintHostKey produces SHA256: prefixed base64 (no padding)', () => {
  const fp = fingerprintHostKey(Buffer.from('hello'));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(fp.includes('='), false);
});

test('hostVerifier persists fingerprint on first use (TOFU) and accepts', () => {
  // Ensure clean state
  db.servers.setHostFingerprint(server.id, '');
  assert.equal(db.servers.getHostFingerprint(server.id), '');

  const key = fakeKey('first');
  const expected = fingerprintHostKey(key);

  const verifier = makeHostVerifier({ serverId: server.id, hostLabel: 'tofu.local' });
  let verdict = null;
  verifier(key, v => { verdict = v; });

  assert.equal(verdict, true);
  assert.equal(db.servers.getHostFingerprint(server.id), expected);
});

test('hostVerifier accepts subsequent matching key', () => {
  const key = fakeKey('first'); // same as before
  const verifier = makeHostVerifier({ serverId: server.id, hostLabel: 'tofu.local' });
  let verdict = null;
  verifier(key, v => { verdict = v; });
  assert.equal(verdict, true);
});

test('hostVerifier REJECTS mismatching key (no silent re-trust)', () => {
  const key = fakeKey('attacker');
  const verifier = makeHostVerifier({ serverId: server.id, hostLabel: 'tofu.local' });
  let verdict = null;
  verifier(key, v => { verdict = v; });
  assert.equal(verdict, false);
  // Stored fingerprint must NOT have been overwritten
  const stored = db.servers.getHostFingerprint(server.id);
  assert.notEqual(stored, fingerprintHostKey(key));
});

test('hostVerifier with explicit expectedFingerprint mismatches attacker key', () => {
  const expected = fingerprintHostKey(fakeKey('legit'));
  const verifier = makeHostVerifier({ serverId: null, expectedFingerprint: expected, hostLabel: 'x' });
  let verdict = null;
  verifier(fakeKey('attacker'), v => { verdict = v; });
  assert.equal(verdict, false);
});

test('reset clears fingerprint and the next connect re-learns', () => {
  db.servers.setHostFingerprint(server.id, '');
  const newKey = fakeKey('post-reinstall');
  const verifier = makeHostVerifier({ serverId: server.id, hostLabel: 'tofu.local' });
  let verdict = null;
  verifier(newKey, v => { verdict = v; });
  assert.equal(verdict, true);
  assert.equal(db.servers.getHostFingerprint(server.id), fingerprintHostKey(newKey));
});
