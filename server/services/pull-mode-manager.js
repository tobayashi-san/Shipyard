const sshManager = require('./ssh-manager');
const db = require('../db');
const manifestService = require('./agent-manifest');
const { processIncomingReport } = require('./agent-processor');
const log = require('../utils/logger').child('agent:pull');

const REMOTE_DIR = '/var/lib/shipyard-agent';
const REMOTE_MANIFEST = `${REMOTE_DIR}/manifest.json`;
const REMOTE_REPORT = `${REMOTE_DIR}/report.json`;

async function writeManifest(server, manifestContent) {
  const b64 = Buffer.from(manifestContent, 'utf8').toString('base64');
  const cmd = [
    `mkdir -p '${REMOTE_DIR}'`,
    `printf '%s' '${b64}' | base64 -d > '${REMOTE_MANIFEST}.tmp'`,
    `mv -f '${REMOTE_MANIFEST}.tmp' '${REMOTE_MANIFEST}'`,
    `chmod 640 '${REMOTE_MANIFEST}' || true`,
  ].join(' && ');
  await sshManager.execCommand(server, cmd);
}

async function fetchAndDeleteReport(server) {
  const cmd = `if [ -f '${REMOTE_REPORT}' ]; then cat '${REMOTE_REPORT}' && rm -f '${REMOTE_REPORT}'; fi`;
  const result = await sshManager.execCommand(server, cmd);
  return (result.stdout || '').trim();
}

async function pollServer(server) {
  const cfg = db.agentConfig.getByServerId(server.id);
  if (!cfg || cfg.mode !== 'pull') return { ok: true, skipped: true };

  const latest = manifestService.getLatestParsed();
  try {
    await writeManifest(server, latest.content);
  } catch (e) {
    log.debug({ err: e, server: server.name }, 'Pull mode manifest write failed');
    return { ok: false, step: 'write_manifest', error: e.message };
  }

  try {
    const reportRaw = await fetchAndDeleteReport(server);
    if (!reportRaw) return { ok: true, report: false };
    const report = JSON.parse(reportRaw);
    processIncomingReport({ serverId: server.id, report, source: 'pull' });
    return { ok: true, report: true };
  } catch (e) {
    log.debug({ err: e, server: server.name }, 'Pull mode report fetch/parse failed');
    return { ok: false, step: 'read_report', error: e.message };
  }
}

module.exports = {
  pollServer,
};
