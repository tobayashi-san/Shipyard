'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');

process.env.DB_PATH  = path.join(os.tmpdir(), `lab_test_ssh_${Date.now()}.db`);
process.env.NODE_ENV = 'test';
delete process.env.SHIPYARD_KEY_SECRET; // no AES wrapping during tests

const { describe, it, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const { execFileSync } = require('child_process');

const sshManager = require('../services/ssh-manager');
const db         = require('../db');

const SSH_DIR = path.join(__dirname, '..', 'data', 'ssh');

// Clean state: wipe ssh_keys table and disk files
function resetKeys() {
  try {
    for (const f of fs.readdirSync(SSH_DIR)) {
      try { fs.unlinkSync(path.join(SSH_DIR, f)); } catch {}
    }
  } catch {}
  db.sshKeys.clear();
}

// Helper: generate an ed25519 key in a temp dir, return private key content
function makeKey(passphrase = '') {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mk-'));
  const keyFile = path.join(tmpDir, 'id');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyFile, '-N', passphrase, '-C', 'test'], { stdio: 'pipe' });
  const content = fs.readFileSync(keyFile, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return content;
}

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
  try { sshManager.closeAll(); } catch {}
});

describe('importKey', () => {
  before(resetKeys);

  it('replaces existing key in DB', () => {
    sshManager.generateKey('initial');
    const before = sshManager.getKeyInfo();
    assert.ok(before, 'initial key should exist');

    const content = makeKey();
    sshManager.importKey(content, 'imported');

    const after = sshManager.getKeyInfo();
    assert.equal(after.name, 'imported', 'imported key should be active');
    assert.notEqual(after.publicKey, before.publicKey, 'public key should differ');
    assert.equal(db.sshKeys.getAll().length, 1, 'only one key in DB');
  });

  it('strips passphrase from imported key so it is usable without one', () => {
    const content = makeKey('secret123');
    sshManager.importKey(content, 'imported_pass', 'secret123');

    // Key on disk should now be passphrase-free
    const keyPath = path.join(SSH_DIR, 'imported_pass');
    const pub = execFileSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' });
    assert.ok(pub.startsWith('ssh-ed25519'));
  });

  it('throws a descriptive error when passphrase is wrong', () => {
    const content = makeKey('correct');
    assert.throws(
      () => sshManager.importKey(content, 'bad', 'wrong'),
      /passphrase|Invalid/i
    );
  });
});

describe('getPrivateKeyExport', () => {
  before(() => {
    resetKeys();
    sshManager.generateKey('exp_test');
  });

  it('returns plain key when no passphrase given', () => {
    const key = sshManager.getPrivateKeyExport('');
    assert.ok(key.includes('BEGIN OPENSSH PRIVATE KEY'));
  });

  it('returned key requires the given passphrase', () => {
    const key = sshManager.getPrivateKeyExport('mypassword');

    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-exp-'));
    const tmpFile = path.join(tmpDir, 'key');
    try {
      fs.writeFileSync(tmpFile, key, { mode: 0o600 });

      // Correct passphrase → works
      const pub = execFileSync('ssh-keygen', ['-y', '-f', tmpFile, '-P', 'mypassword'], { encoding: 'utf8' });
      assert.ok(pub.startsWith('ssh-ed25519'));

      // Wrong passphrase → throws
      assert.throws(() =>
        execFileSync('ssh-keygen', ['-y', '-f', tmpFile, '-P', 'wrongpass'], { stdio: 'pipe' })
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
