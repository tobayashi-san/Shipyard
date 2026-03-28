/**
 * Shared input validators used across route handlers.
 */

// Playbook filenames: only letters, digits, _ and -, ending in .yml or .yaml
const PLAYBOOK_RE = /^[a-zA-Z0-9_-]+\.ya?ml$/;

// Ansible targets: server names, groups, 'all', comma-separated lists
// Allows letters, digits, underscore, hyphen, dot, comma, colon, ! and space
const TARGETS_RE = /^[a-zA-Z0-9_.,:!@\s-]+$/;
const SIMPLE_TARGET_RE = /^[a-zA-Z0-9_.-]+$/;

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

function parseTargetExpression(targets) {
  const raw = String(targets || '').trim();
  if (!raw) return { kind: 'empty', included: [], excluded: [] };
  if (raw === 'all') return { kind: 'all', included: ['all'], excluded: [] };

  const colonParts = raw.split(':').map(t => t.trim()).filter(Boolean);
  if (
    colonParts[0] === 'all' &&
    colonParts.length > 1 &&
    colonParts.slice(1).every(t => t.startsWith('!') && SIMPLE_TARGET_RE.test(t.slice(1)))
  ) {
    return {
      kind: 'all_except',
      included: ['all'],
      excluded: colonParts.slice(1).map(t => t.slice(1)),
    };
  }

  const commaParts = raw.split(',').map(t => t.trim()).filter(Boolean);
  if (commaParts.length > 0 && commaParts.every(t => SIMPLE_TARGET_RE.test(t))) {
    return { kind: 'list', included: commaParts, excluded: [] };
  }

  return { kind: 'pattern', included: [], excluded: [], raw };
}

function targetIncludesServer(targets, serverName) {
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'all') return true;
  if (parsed.kind === 'all_except') return !parsed.excluded.includes(serverName);
  if (parsed.kind === 'list') return parsed.included.includes('all') || parsed.included.includes(serverName);
  return false;
}

module.exports = {
  isValidPlaybook,
  validateTargets,
  parseTargetExpression,
  targetIncludesServer,
  PLAYBOOK_RE,
};
