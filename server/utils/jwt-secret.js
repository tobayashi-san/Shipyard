const crypto = require('crypto');
const db = require('../db');

function getJwtSecret() {
  // Prefer environment variable – avoids storing the secret in the DB at rest
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let secret = db.settings.get('auth_jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    db.settings.set('auth_jwt_secret', secret);
  }
  return secret;
}

module.exports = { getJwtSecret };
