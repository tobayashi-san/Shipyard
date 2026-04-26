const db = require('../db');
const ansibleRunner = require('./ansible-runner');
const log = require('../utils/logger').child('services:docker-inventory');

/**
 * Run gather-docker.yml against a server and sync the parsed container list
 * into the dockerContainers table. Returns true on success, false otherwise.
 *
 * Extracted from routes/servers.js so other routes (compose actions etc.)
 * can trigger a fresh poll after mutating state on the server.
 */
async function refreshDockerCache(server) {
  try {
    const result = await ansibleRunner.runPlaybook('gather-docker.yml', server.name);
    if (!result.success) return false;
    const marker = result.stdout.indexOf('"msg": [');
    if (marker === -1) return false;
    const arrayStart = result.stdout.indexOf('[', marker);
    let depth = 0, jsonEnd = -1;
    for (let i = arrayStart; i < result.stdout.length; i++) {
      if (result.stdout[i] === '[') depth++;
      else if (result.stdout[i] === ']') { depth--; if (depth === 0) { jsonEnd = i; break; } }
    }
    if (jsonEnd === -1) return false;
    const jsonStr = result.stdout.substring(arrayStart, jsonEnd + 1);
    const containers = JSON.parse(jsonStr)
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
    db.dockerContainers.syncForServer(server.id, containers);
    return true;
  } catch (err) {
    log.error({ err, server: server.name }, 'Failed to refresh docker cache');
    return false;
  }
}

module.exports = { refreshDockerCache };
