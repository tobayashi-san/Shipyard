/**
 * Shared input validators used across route handlers.
 */

// Playbook filenames: only letters, digits, _ and -, ending in .yml or .yaml
const PLAYBOOK_RE = /^[a-zA-Z0-9_-]+\.ya?ml$/;

// Ansible targets: server names, groups, 'all', comma-separated lists
// Allows letters, digits, underscore, hyphen, dot, comma, space
const TARGETS_RE = /^[a-zA-Z0-9_.,:@\s-]+$/;

/**
 * Returns true if the value is a valid playbook filename (not a path).
 */
function isValidPlaybook(name) {
  return typeof name === 'string' && PLAYBOOK_RE.test(name);
}

/**
 * Returns an error string if targets is invalid, or null if valid.
 * Undefined/null is accepted (callers default to 'all').
 */
function validateTargets(targets) {
  if (targets === undefined || targets === null) return null;
  if (typeof targets !== 'string') return 'targets must be a string';
  if (targets.length > 500) return 'targets too long (max 500)';
  if (!TARGETS_RE.test(targets)) return 'targets contains invalid characters';
  return null;
}

module.exports = { isValidPlaybook, validateTargets, PLAYBOOK_RE };
