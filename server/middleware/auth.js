const jwt = require('jsonwebtoken');
const db = require('../db');
const { getJwtSecret } = require('../utils/jwt-secret');

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireCap(capability) {
  return (req, res, next) => {
    const { getPermissions, can } = require('../utils/permissions');
    if (!can(getPermissions(req.user), capability)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}

const authMiddleware = function authMiddleware(req, res, next) {
  // Initial setup mode: no users AND no legacy password hash
  // Only allow unauthenticated access to setup — req.user stays null,
  // and can(null, ...) returns false so capability-gated routes are blocked.
  const userCount = db.users.count();
  const legacyHash = db.settings.get('auth_password_hash');
  if (userCount === 0 && !legacyHash) {
    // Mark as setup mode so routes can detect it, but do NOT grant permissions
    req.setupMode = true;
    return next();
  }

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
    // Reject tokens issued before a password change
    if (payload.tv !== undefined && payload.tv !== (user.token_version || 0)) {
      return res.status(401).json({ error: 'Token revoked' });
    }
    req.user = user;
    return next();
  }

  // Legacy token: has ok: true (no userId)
  // Deprecated: kept for backward compat during migration window.
  // Legacy tokens have no token_version so they cannot be selectively revoked.
  if (payload.ok === true) {
    console.warn('[auth] Legacy token used — consider re-logging in to obtain a modern token');
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
module.exports.requireCap = requireCap;
