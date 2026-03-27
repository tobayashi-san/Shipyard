const log = require('./logger').child('http-error');

/**
 * Send a sanitized 500 response. Logs the real error internally but never
 * exposes internal details (file paths, DB schema, stack traces) to clients.
 *
 * @param {object} res   - Express response object
 * @param {Error}  err   - The caught error
 * @param {string} [ctx] - Short context string for the log entry (e.g. 'list playbooks')
 */
function serverError(res, err, ctx) {
  log.error({ err, ctx }, ctx || 'Unhandled server error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { serverError };
