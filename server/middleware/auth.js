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
  // Initial setup mode: no users exist yet.
  // IMPORTANT: Do NOT allow access to non-auth API routes in this state.
  // Otherwise, a reset of /api/reset/auth would make existing operational data public.
  if (db.users.count() === 0) {
    req.setupMode = true;
    return res.status(503).json({ error: 'Setup required' });
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

  if (!payload.userId) {
    return res.status(401).json({ error: 'Invalid token — please log in again' });
  }

  const user = db.users.getById(payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  // Reject tokens issued before a password change
  if (payload.tv !== undefined && payload.tv !== (user.token_version || 0)) {
    return res.status(401).json({ error: 'Token revoked' });
  }
  req.user = user;
  return next();
};

module.exports = authMiddleware;
module.exports.adminOnly = adminOnly;
module.exports.requireCap = requireCap;
