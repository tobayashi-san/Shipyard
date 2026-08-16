const db = require('../db');
const ansibleRunner = require('./ansible-runner');
const log = require('../utils/logger').child('services:docker-inventory');

const CONTAINER_LINE_PREFIX = '__SHIPYARD_CONTAINER__';
// This deliberately uses Docker's own formatted image field instead of an
// inspect call per container. Besides being much faster, it also works for
// regular Docker installations where a restrictive sudo policy allowed
// `docker ps` but not arbitrary `docker inspect` invocations.
const DOCKER_INVENTORY_COMMAND = String.raw`
runtime="$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)"
[ -n "$runtime" ] || exit 0
format='{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.CreatedAt}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}'
if output="$("$runtime" ps -a --format "$format" 2>/dev/null)"; then
  [ -z "$output" ] || printf '%s\n' "$output" | sed 's/^/__SHIPYARD_CONTAINER__/'
  exit 0
fi
# A non-root Fleet account may not be in the docker group. Use only non-
# interactive sudo as a controlled fallback; never prompt or hang an API call.
output="$(sudo -n "$runtime" ps -a --format "$format" 2>/dev/null)" || exit $?
[ -z "$output" ] || printf '%s\n' "$output" | sed 's/^/__SHIPYARD_CONTAINER__/'
`;

/**
 * Run gather-docker.yml against a server and sync the parsed container list
 * into the dockerContainers table. Returns true on success, false otherwise.
 *
 * Extracted from routes/servers.js so other routes (compose actions etc.)
 * can trigger a fresh poll after mutating state on the server.
 */
function extractContainerLines(output) {
  const text = String(output || '');
  // Ansible's human callback has changed whitespace between releases.  Locate
  // the JSON value following any debug `msg` field instead of relying on the
  // exact `"msg": [` formatting emitted by one callback version.
  const message = /["']msg["']\s*:\s*/g;
  let match;
  while ((match = message.exec(text))) {
    const valueStart = match.index + match[0].length;
    if (text[valueStart] !== '[') continue;
    const arrayStart = valueStart;
    let depth = 0, jsonEnd = -1;
    let quoted = false, escaped = false;
    for (let i = arrayStart; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '[') depth++;
      else if (char === ']') { depth--; if (depth === 0) { jsonEnd = i; break; } }
    }
    if (jsonEnd === -1) continue;
    try {
      const lines = JSON.parse(text.substring(arrayStart, jsonEnd + 1));
      if (Array.isArray(lines)) return lines;
    } catch {
      // Continue with another debug message if this one is not JSON.
    }
  }
  return null;
}

function parseContainerLines(lines) {
  return lines
      .filter(line => typeof line === 'string' && line.trim())
      .map(line => {
        const parts = line.split('|');
        return {
          name:             parts[0] || 'Unknown',
          image:            parts[1] || 'Unknown',
          state:            parts[2] || 'unknown',
          status:           parts[3] || '',
          createdAt:        parts[4] || '',
          composeProject:   parts[5] || null,
          composeWorkingDir:parts[6] || null,
        };
      });
}

function extractMarkedContainerLines(output) {
  return String(output || '').split(/\r?\n/)
    .map(line => line.trimStart())
    .filter(line => line.startsWith(CONTAINER_LINE_PREFIX))
    .map(line => line.slice(CONTAINER_LINE_PREFIX.length));
}

async function refreshDockerCache(server) {
  try {
    const environmentId = String(server.environment_id || 'default');
    // The direct Ansible command has a predictable, marker-prefixed output
    // and avoids coupling runtime discovery to Ansible's human callback
    // format. The playbook remains a compatibility fallback for custom
    // Ansible wrappers.
    const direct = await ansibleRunner.runAdHoc(server.name, 'shell', DOCKER_INVENTORY_COMMAND, null, { become: true, environmentId });
    let lines = direct.success ? extractMarkedContainerLines(direct.stdout) : null;
    if (lines === null) {
      const result = await ansibleRunner.runPlaybook('gather-docker.yml', server.name, {}, null, { environmentId });
      if (!result.success) return false;
      lines = extractContainerLines(result.stdout);
      if (!lines) return false;
    }
    const containers = parseContainerLines(lines);
    db.dockerContainers.syncForServer(server.id, containers);
    return true;
  } catch (err) {
    log.error({ err, server: server.name }, 'Failed to refresh docker cache');
    return false;
  }
}

module.exports = { refreshDockerCache, extractContainerLines, extractMarkedContainerLines, parseContainerLines, DOCKER_INVENTORY_COMMAND };
