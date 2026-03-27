'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_crypto_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-crypto';
process.env.NODE_ENV = 'test';

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── encrypt/decrypt without SHIPYARD_KEY_SECRET ───────────────────────────────

describe('crypto without SHIPYARD_KEY_SECRET', () => {
  // Clear the key before importing
  const originalKey = process.env.SHIPYARD_KEY_SECRET;

  test('encrypt returns plaintext when no key set', () => {
    delete process.env.SHIPYARD_KEY_SECRET;
    // Re-require to reset state
    delete require.cache[require.resolve('../utils/crypto')];
    const { encrypt } = require('../utils/crypto');
    assert.equal(encrypt('hello'), 'hello');
  });

  test('decrypt returns value as-is for non-encrypted values', () => {
    delete process.env.SHIPYARD_KEY_SECRET;
    delete require.cache[require.resolve('../utils/crypto')];
    const { decrypt } = require('../utils/crypto');
    assert.equal(decrypt('plaintext'), 'plaintext');
    assert.equal(decrypt(null), null);
    assert.equal(decrypt(''), '');
  });

  // Restore
  after(() => {
    if (originalKey) process.env.SHIPYARD_KEY_SECRET = originalKey;
  });
});

// ── encrypt/decrypt with SHIPYARD_KEY_SECRET ──────────────────────────────────

describe('crypto with SHIPYARD_KEY_SECRET', () => {
  test('encrypts and decrypts correctly', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-master-key-for-crypto';
    delete require.cache[require.resolve('../utils/crypto')];
    const { encrypt, decrypt } = require('../utils/crypto');

    const plaintext = 'my-secret-password-123!';
    const encrypted = encrypt(plaintext);

    assert.ok(encrypted.startsWith('enc:'), 'encrypted value should start with enc:');
    assert.notEqual(encrypted, plaintext);

    const decrypted = decrypt(encrypted);
    assert.equal(decrypted, plaintext);
  });

  test('each encryption produces different ciphertext (random IV)', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-master-key-for-crypto';
    delete require.cache[require.resolve('../utils/crypto')];
    const { encrypt } = require('../utils/crypto');

    const a = encrypt('same-value');
    const b = encrypt('same-value');
    assert.notEqual(a, b, 'two encryptions of the same value should differ');
  });

  test('decrypt returns opaque blob when key is missing', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-master-key-for-crypto';
    delete require.cache[require.resolve('../utils/crypto')];
    const { encrypt } = require('../utils/crypto');
    const encrypted = encrypt('secret');

    // Now remove key and try to decrypt
    delete process.env.SHIPYARD_KEY_SECRET;
    delete require.cache[require.resolve('../utils/crypto')];
    const { decrypt } = require('../utils/crypto');
    const result = decrypt(encrypted);
    assert.equal(result, encrypted, 'should return the encrypted blob when key is missing');
  });

  test('encrypt handles empty/null input', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-master-key-for-crypto';
    delete require.cache[require.resolve('../utils/crypto')];
    const { encrypt } = require('../utils/crypto');
    assert.equal(encrypt(''), '');
    assert.equal(encrypt(null), null);
    assert.equal(encrypt(undefined), undefined);
  });

  after(() => {
    delete process.env.SHIPYARD_KEY_SECRET;
  });
});

// ── getSecret / setSecret ─────────────────────────────────────────────────────

describe('getSecret / setSecret', () => {
  test('stores and retrieves encrypted secrets', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-key-for-get-set';
    delete require.cache[require.resolve('../utils/crypto')];
    const { getSecret, setSecret } = require('../utils/crypto');
    const db = require('../db');

    setSecret(db, 'test_secret_key', 'my-api-token');
    const raw = db.settings.get('test_secret_key');
    assert.ok(raw.startsWith('enc:'), 'stored value should be encrypted');

    const value = getSecret(db, 'test_secret_key');
    assert.equal(value, 'my-api-token');
  });

  test('getSecret returns null for missing key', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-key-for-get-set';
    delete require.cache[require.resolve('../utils/crypto')];
    const { getSecret } = require('../utils/crypto');
    const db = require('../db');
    assert.equal(getSecret(db, 'nonexistent_key'), null);
  });

  test('getSecret auto-encrypts plaintext values', () => {
    process.env.SHIPYARD_KEY_SECRET = 'test-key-for-auto-encrypt';
    delete require.cache[require.resolve('../utils/crypto')];
    const { getSecret } = require('../utils/crypto');
    const db = require('../db');

    // Store a plaintext value directly
    db.settings.set('test_plain', 'unencrypted-value');
    const result = getSecret(db, 'test_plain');
    assert.equal(result, 'unencrypted-value');

    // After getSecret, it should now be encrypted in DB
    const raw = db.settings.get('test_plain');
    assert.ok(raw.startsWith('enc:'), 'should have been auto-encrypted');
  });

  after(() => {
    delete process.env.SHIPYARD_KEY_SECRET;
  });
});
