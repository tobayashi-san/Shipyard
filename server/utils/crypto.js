/**
 * AES-256-GCM encryption for sensitive settings (SMTP password, git token, webhook secret).
 * Reuses the same SHIPYARD_KEY_SECRET used for SSH key encryption at rest.
 * Values are stored with an 'enc:' prefix; plaintext values are auto-encrypted on read.
 */
const crypto = require('crypto');
const log = require('./logger').child('crypto');
const ALGORITHM = 'aes-256-gcm';

function getMasterKey() {
  const secret = process.env.SHIPYARD_KEY_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

let _noKeyWarned = false;

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const masterKey = getMasterKey();
  if (!masterKey) {
    if (!_noKeyWarned) {
      log.warn('SHIPYARD_KEY_SECRET not set — secrets stored unencrypted. Set this env var to enable encryption at rest.');
      _noKeyWarned = true;
    }
    return plaintext;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(value) {
  if (!value || !value.startsWith('enc:')) return value;
  const masterKey = getMasterKey();
  if (!masterKey) return value; // can't decrypt without key — return opaque blob
  try {
    const buf = Buffer.from(value.slice(4), 'base64');
    if (buf.length < 33) throw new Error('ciphertext too short');
    const iv = buf.subarray(0, 16);
    const tag = buf.subarray(16, 32);
    const ciphertext = buf.subarray(32);
    const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    // Corrupt ciphertext, wrong key, or tampering. Return null so callers can
    // handle "secret unavailable" instead of the route crashing with a 500.
    log.warn({ err: err.message }, 'decrypt failed — returning null');
    return null;
  }
}

/**
 * Read a secret setting — auto-encrypts plaintext on read if master key is available.
 */
function getSecret(db, key) {
  const raw = db.settings.get(key);
  if (!raw) return null;
  if (raw.startsWith('enc:')) return decrypt(raw);
  // Auto-encrypt plaintext value in place
  const encrypted = encrypt(raw);
  if (encrypted !== raw) db.settings.set(key, encrypted);
  return raw;
}

/**
 * Write a secret setting — encrypts if master key is available.
 */
function setSecret(db, key, value) {
  db.settings.set(key, encrypt(value || ''));
}

module.exports = { encrypt, decrypt, getSecret, setSecret };
