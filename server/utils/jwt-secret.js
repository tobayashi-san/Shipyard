const crypto = require('crypto');
const log = require('./logger').child('security');
const db = require('../db');
const { getSecret, setSecret } = require('./crypto');

let _warnedOnce = false;

function getJwtSecret() {
  // Prefer environment variable – avoids storing the secret in the DB at rest
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // Fail closed in production: a DB-stored secret can be forged by anyone with
  // DB access, especially when SHIPYARD_KEY_SECRET is also missing (plaintext).
  if (process.env.NODE_ENV === 'production') {
    log.fatal('JWT_SECRET env var is required in production. Refusing to start.');
    // Throw so startup code (app.js / index.js) aborts with a clear error.
    throw new Error('JWT_SECRET must be set in production');
  }

  if (!_warnedOnce) {
    log.warn('JWT_SECRET env var not set — falling back to DB-stored secret. Set JWT_SECRET for production use.');
    _warnedOnce = true;
  }
  // getSecret auto-encrypts any existing plaintext value on first read
  let secret = getSecret(db, 'auth_jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    setSecret(db, 'auth_jwt_secret', secret);
  }
  return secret;
}

/**
 * Rotate the DB-stored JWT secret, invalidating all existing sessions.
 * No-op if JWT_SECRET env var is set (env var takes precedence; rotate it there).
 * Returns true if rotated, false if env var is in use.
 */
function rotateJwtSecret() {
  if (process.env.JWT_SECRET) return false;
  const newSecret = crypto.randomBytes(64).toString('hex');
  setSecret(db, 'auth_jwt_secret', newSecret);
  return true;
}

module.exports = { getJwtSecret, rotateJwtSecret };
