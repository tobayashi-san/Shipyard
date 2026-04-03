const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

function normalizeOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(envValue) {
  if (!envValue || !envValue.trim()) return DEFAULT_ORIGINS;
  const parsed = envValue.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter(Boolean);
  // deduplicate while preserving order
  const seen = new Set();
  const unique = [];
  for (const o of parsed) {
    if (!seen.has(o)) { seen.add(o); unique.push(o); }
  }
  return unique.length > 0 ? unique : DEFAULT_ORIGINS;
}

function isAllowedRequestOrigin(allowedOrigins, requestOrigin) {
  // No origin header (non-browser clients) → allow
  if (!requestOrigin) return true;
  try {
    const normalized = new URL(requestOrigin).origin;
    return allowedOrigins.includes(normalized);
  } catch {
    return false;
  }
}

module.exports = { parseAllowedOrigins, isAllowedRequestOrigin, DEFAULT_ORIGINS };
