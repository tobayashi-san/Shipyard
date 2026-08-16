const db = require('../db');
const { getPermissions, canAccessEnvironment } = require('../utils/permissions');
const { runWithEnvironment } = require('../utils/request-environment');

const HEADER = 'x-shipyard-environment';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Establish one authoritative environment for every authenticated API request.
 * Query/body values remain supported for API clients, but may never contradict
 * the environment header emitted by the web application.
 */
function environmentContext(req, res, next) {
  // Environment discovery/administration is the control plane used to recover
  // from a stale browser selection (for example after another admin deleted an
  // environment). It is deliberately global and never returns scoped data.
  if (req.path === '/environments' || req.path.startsWith('/environments/')) {
    return next();
  }
  if (req.path === '/opentofu/status') return next();
  const headerEnvironment = clean(req.get(HEADER));
  const queryEnvironment = clean(req.query?.environment_id);
  const bodyEnvironment = clean(req.body?.environment_id);
  const explicitValues = [headerEnvironment, queryEnvironment, bodyEnvironment].filter(Boolean);

  if (new Set(explicitValues).size > 1) {
    return res.status(409).json({ error: 'Environment context mismatch.' });
  }

  const environmentId = explicitValues[0] || 'default';
  if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) {
    return res.status(400).json({ error: 'Environment not found.' });
  }
  if (!canAccessEnvironment(getPermissions(req.user), environmentId)) {
    if (explicitValues.length === 0) {
      return res.status(400).json({ error: 'Environment context is required.' });
    }
    return res.status(404).json({ error: 'Environment not found.' });
  }

  req.environmentId = environmentId;
  return runWithEnvironment(environmentId, next);
}

module.exports = environmentContext;
