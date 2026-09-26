'use strict';

// Actions that send the whole database elsewhere confirm the current password
// (and the authenticator code when MFA is on), not only the session.
const bcrypt = require('bcryptjs');
const otplib = require('otplib');
const db = require('../db');

/** @returns {Promise<{user?: object, error?: {status: number, body: object}}>} */
async function confirmCurrentUser(username, { password, code } = {}) {
  if (typeof password !== 'string' || !password || password.length > 1024) return { error: { status: 400, body: { error: 'Current password is required', field: 'password' } } };
  const user = db.users.getByUsername(username);
  if (!user || !await bcrypt.compare(password, user.password_hash)) return { error: { status: 403, body: { error: 'Current password is incorrect', field: 'password' } } };
  if (user.totp_enabled) {
    const secret = db.users.getTotpSecret(user.id);
    let validCode = false;
    if (secret && typeof code === 'string' && /^\d{6}$/.test(code)) {
      try { validCode = otplib.verifySync({ token: code, secret }).valid; } catch { /* invalid/unavailable MFA configuration */ }
    }
    if (!validCode) return { error: { status: 403, body: { error: 'A valid authenticator code is required', field: 'code' } } };
  }
  return { user };
}

module.exports = { confirmCurrentUser };
