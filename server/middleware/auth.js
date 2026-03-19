const jwt = require('jsonwebtoken');
const db = require('../db');

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  return db.settings.get('auth_jwt_secret');
}

module.exports = function authMiddleware(req, res, next) {
  // If no password has been configured yet, allow all requests (initial setup mode)
  if (!db.settings.get('auth_password_hash')) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const secret = getJwtSecret();
  if (!secret) return res.status(500).json({ error: 'Server misconfigured' });

  try {
    jwt.verify(authHeader.slice(7), secret);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
};
