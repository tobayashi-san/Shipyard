const jwt = require('jsonwebtoken');
const db = require('../db');
const { getJwtSecret } = require('../utils/jwt-secret');

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

const authMiddleware = function authMiddleware(req, res, next) {
  // Initial setup mode: no users AND no legacy password hash
  const userCount = db.users.count();
  const legacyHash = db.settings.get('auth_password_hash');
  if (userCount === 0 && !legacyHash) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const secret = getJwtSecret();
  if (!secret) return res.status(500).json({ error: 'Server misconfigured' });

  let payload;
  try {
    payload = jwt.verify(authHeader.slice(7), secret);
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }

  // New-style token: has userId
  if (payload.userId) {
    const user = db.users.getById(payload.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    return next();
  }

  // Legacy token: has ok: true (no userId)
  if (payload.ok === true) {
    // Find first admin user for backward compat
    const admins = db.users.getAll().filter(u => u.role === 'admin');
    if (admins.length > 0) {
      req.user = admins[0];
    } else {
      // Fallback: create a synthetic user object from settings
      req.user = {
        id: 'legacy',
        username: db.settings.get('auth_username') || 'admin',
        email: db.settings.get('auth_email') || '',
        role: 'admin',
      };
    }
    return next();
  }

  return res.status(401).json({ error: 'Invalid token' });
};

module.exports = authMiddleware;
module.exports.adminOnly = adminOnly;
