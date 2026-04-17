'use strict';

const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_totp_enc_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-totp';
process.env.SHIPYARD_KEY_SECRET = 'test-master-key-totp';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const db = require('../db');

const passwordHash = bcrypt.hashSync('Password-12345', 10);
const user = db.users.create('totp_user', '', passwordHash, 'admin');

test('setTotp stores encrypted ciphertext, not plaintext', () => {
  db.users.setTotp(user.id, 'JBSWY3DPEHPK3PXP', true);
  const row = db.users.getByUsername('totp_user');
  assert.notEqual(row.totp_secret, 'JBSWY3DPEHPK3PXP');
  assert.match(row.totp_secret, /^enc:/);
});

test('getTotpSecret returns the decrypted plaintext', () => {
  assert.equal(db.users.getTotpSecret(user.id), 'JBSWY3DPEHPK3PXP');
});

test('setPendingTotp also encrypts', () => {
  db.users.setPendingTotp(user.id, 'PENDINGSECRET');
  const row = db.users.getByUsername('totp_user');
  assert.match(row.totp_secret_pending, /^enc:/);
  assert.equal(db.users.getPendingTotpSecret(user.id), 'PENDINGSECRET');
});

test('clearing TOTP stores empty string (not encrypted "")', () => {
  db.users.setTotp(user.id, '', false);
  db.users.setPendingTotp(user.id, '');
  const row = db.users.getByUsername('totp_user');
  assert.equal(row.totp_secret, '');
  assert.equal(row.totp_secret_pending, '');
  assert.equal(db.users.getTotpSecret(user.id), '');
});

test('legacy plaintext row is opportunistically encrypted on first read', () => {
  // Simulate a legacy row by writing raw plaintext directly.
  db.db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run('LEGACY_PLAINTEXT', user.id);
  // First helper read: returns plaintext to caller AND upgrades the row.
  assert.equal(db.users.getTotpSecret(user.id), 'LEGACY_PLAINTEXT');
  const row = db.users.getByUsername('totp_user');
  assert.match(row.totp_secret, /^enc:/);
});
