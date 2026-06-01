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
 * Undefined/null is accepted for callers that intentionally default elsewhere.
 */
function validateTargets(targets) {
  if (targets === undefined || targets === null) return null;
  if (typeof targets !== 'string') return 'targets must be a string';
  if (!targets.trim()) return 'targets is required';
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

function sanitizeInventoryName(v) {
  return String(v ?? '').replace(/[\r\n\s=\[\]#;]/g, '_');
}

function sanitizeInventoryGroupName(v) {
  const normalized = String(v ?? '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'group';
}

function getKnownInventoryTargets(allServers = []) {
  const known = new Set(['all']);
  for (const server of allServers) {
    if (server?.name) {
      known.add(String(server.name));
      known.add(sanitizeInventoryName(server.name));
    }
    let tags = [];
    try { tags = JSON.parse(server.tags || '[]'); } catch {}
    if (!Array.isArray(tags)) tags = [];
    tags
      .filter(tag => typeof tag === 'string' && tag.trim())
      .forEach(tag => known.add(sanitizeInventoryGroupName(tag)));
  }
  return known;
}

function hasOptionLikeTarget(parsedTargets) {
  const values = [
    ...(parsedTargets.included || []),
    ...(parsedTargets.excluded || []),
  ];
  return values.some(target => typeof target === 'string' && target.startsWith('-'));
}

function validateKnownInventoryTargets(targets, allServers = []) {
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'empty') return 'targets is required';
  if (parsed.kind === 'pattern') return 'targets must reference known inventory hosts or tag groups';
  if (hasOptionLikeTarget(parsed)) return 'targets must not start with -';
  if (parsed.kind === 'all') return null;

  const known = getKnownInventoryTargets(allServers);
  const candidates = parsed.kind === 'all_except' ? parsed.excluded : parsed.included;
  const unknown = candidates.filter(target => !known.has(target));
  if (unknown.length > 0) {
    return `Unknown target(s): ${unknown.join(', ')}`;
  }
  return null;
}

function validateInventoryHostName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Name is required';
  const trimmed = name.trim();
  if (!SIMPLE_TARGET_RE.test(trimmed)) return 'Name may only contain letters, numbers, dots, underscores, and hyphens';
  if (trimmed.startsWith('-')) return 'Name must not start with -';
  if (trimmed === 'all' || trimmed === 'localhost') return 'Name is reserved';
  return null;
}

function targetIncludesServer(targets, serverName) {
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'all') return true;
  if (parsed.kind === 'all_except') return !parsed.excluded.includes(serverName);
  if (parsed.kind === 'list') return parsed.included.includes('all') || parsed.included.includes(serverName);
  return false;
}

/**
 * Resolve 'all' / 'all:!excluded' targets to the concrete server name list
 * that exists right now, so history records are pinned to actual servers.
 */
function resolveTargets(targets, allServers) {
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'all') {
    return allServers.map(s => s.name).join(',');
  }
  if (parsed.kind === 'all_except') {
    const excluded = new Set(parsed.excluded);
    return allServers.map(s => s.name).filter(n => !excluded.has(n)).join(',');
  }
  return targets;
}

module.exports = {
  isValidPlaybook,
  validateTargets,
  parseTargetExpression,
  validateKnownInventoryTargets,
  validateInventoryHostName,
  sanitizeInventoryGroupName,
  targetIncludesServer,
  resolveTargets,
  PLAYBOOK_RE,
};
