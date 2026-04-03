const jwt = require('jsonwebtoken');
const db = require('../db');
const { getJwtSecret } = require('../utils/jwt-secret');

function verifyWsAuth(ws, url) {
  if (db.users.count() === 0) { ws.close(4001, 'Setup required'); return false; }
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(url.searchParams.get('token'), secret);
    if (payload.userId) {
      const user = db.users.getById(payload.userId);
      if (!user) { ws.close(4001, 'Unauthorized'); return false; }
      if (payload.tv !== undefined && payload.tv !== (user.token_version || 0)) {
        ws.close(4001, 'Token revoked'); return false;
      }
    }
    return true;
  } catch {
    ws.close(4001, 'Unauthorized');
    return false;
  }
}

function getWsUser(url) {
  const secret = getJwtSecret();
  try {
    const payload = jwt.verify(url.searchParams.get('token'), secret);
    if (payload.userId) return db.users.getById(payload.userId) || null;
    return null;
  } catch {
    return null;
  }
}

module.exports = { verifyWsAuth, getWsUser };
