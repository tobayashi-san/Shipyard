function findMatchingBracket(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const UPDATE_STATUSES = new Set([
  'up_to_date',
  'update_available',
  'not_checkable',
  'unknown',
  'updated',
]);

function parseUpdateLine(line) {
  const parts = String(line || '').split('|').map(part => part.trim());
  if (parts.length >= 3 && UPDATE_STATUSES.has(parts[2])) {
    const [container_name, image, status] = parts;
    return { container_name, image, status };
  }
  if (parts.length === 2 && UPDATE_STATUSES.has(parts[1])) {
    const [image, status] = parts;
    return { image, status };
  }
  return null;
}

function parseLegacyOutput(text) {
  text = String(text || '');
  const message = /["']msg["']\s*:\s*/g;
  let match;
  while ((match = message.exec(text))) {
    const arrayStart = match.index + match[0].length;
    if (text[arrayStart] !== '[') continue;
    const jsonEnd = findMatchingBracket(text, arrayStart);
    if (jsonEnd === -1) continue;
    try {
      return JSON.parse(text.substring(arrayStart, jsonEnd + 1))
        .filter(line => typeof line === 'string' && line.includes('|'))
        .map(parseUpdateLine)
        .filter(Boolean);
    } catch {
      // Try a later Ansible debug message instead of treating formatting as a
      // successful, empty update check.
    }
  }
  return [];
}

/**
 * Parse the explicitly marked playbook output. Ansible can render debug data
 * in several callback formats, so parsing its surrounding JSON is fragile.
 * `complete` distinguishes a valid zero-container result from a failed or
 * truncated invocation; callers must not replace a known cache with the
 * latter.
 */
function parseImageUpdateReport(stdout) {
  const text = String(stdout || '');
  const results = [];
  const seen = new Set();
  const marker = /__SHIPYARD_IMAGE_UPDATE__([^|\\"'\s]+)\|([^|\\"'\s]+)\|(up_to_date|update_available|not_checkable|unknown|updated)/g;
  let match;

  while ((match = marker.exec(text))) {
    const result = {
      container_name: match[1],
      image: match[2],
      status: match[3],
    };
    const key = `${result.container_name}\u0000${result.image}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(result);
    }
  }

  if (results.length > 0 || text.includes('__SHIPYARD_IMAGE_UPDATE_DONE__')) {
    return { results, complete: text.includes('__SHIPYARD_IMAGE_UPDATE_DONE__') };
  }

  // Keep supporting the previous playbook during a rolling application
  // upgrade, but deliberately mark it incomplete so it cannot clear a cache.
  return { results: parseLegacyOutput(text), complete: false };
}

function parseImageUpdateOutput(stdout) {
  return parseImageUpdateReport(stdout).results;
}

module.exports = { parseImageUpdateOutput, parseImageUpdateReport };
