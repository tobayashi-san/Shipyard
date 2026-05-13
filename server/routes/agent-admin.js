const express = require('express');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');
const manifestService = require('../services/agent-manifest');
const { encrypt, decrypt } = require('../utils/crypto');
const { adminOnly } = require('../middleware/auth');
const { serverError } = require('../utils/http-error');

const router = express.Router();

function requireServer(id, res) {
  const server = db.servers.getById(id);
  if (!server) {
    res.status(404).json({ error: 'Server not found' });
    return null;
  }
  return server;
}

function inferShipyardUrl(req) {
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${req.get('host')}`;
}

function isHttpsUrl(url) {
  return /^https:\/\//i.test(String(url || ''));
}

function resolveShipyardUrl(req, explicit) {
  const candidate = String(explicit || '').trim();
  if (candidate) return candidate;
  return inferShipyardUrl(req);
}

function ansibleBackendPrecheck(res) {
  if (!ansibleRunner.isInstalled()) {
    res.status(503).json({ error: 'Ansible backend is not available on this Shipyard instance' });
    return false;
  }
  return true;
}

function handleAgentBackendError(res, e, ctx) {
  const msg = String(e?.message || '');
  if (msg.includes('Playbook not found')) {
    return res.status(500).json({ error: 'Agent playbooks are missing (or overridden by mounted /app/server/playbooks)' });
  }
  if (msg.includes('Failed to run ansible-playbook')) {
    return res.status(503).json({ error: 'Ansible runtime is not available or failed to start' });
  }
  if (msg.includes('Invalid playbook path')) {
    return res.status(500).json({ error: 'Invalid internal playbook path' });
  }
  return serverError(res, e, ctx);
}

function getAgentToken(cfg) {
  if (!cfg?.token) {
    return { token: crypto.randomBytes(32).toString('hex'), generated: true };
  }
  const stored = decrypt(cfg.token);
  if (!stored || String(stored).startsWith('enc:')) {
    const err = new Error('Stored agent token cannot be decrypted. Rotate the token to recover this agent.');
    err.status = 409;
    throw err;
  }
  return { token: stored, generated: false };
}

function normalizeCaPem(input) {
  const pem = typeof input === 'string' ? input.trim() : '';
  if (!pem) return '';
  if (!pem.includes('BEGIN CERTIFICATE') || !pem.includes('END CERTIFICATE')) {
    throw new Error('Invalid CA certificate PEM');
  }
  if (pem.length > 128 * 1024) {
    throw new Error('CA certificate PEM too large');
  }
  return pem;
}

function isTlsTrustError(err) {
  return [
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ].includes(err?.code);
}

async function verifyServerTlsTrust(shipyardUrl) {
  const u = new URL(shipyardUrl);
  if (u.protocol !== 'https:') throw new Error('shipyard_url must use https://');
  const host = u.hostname;
  const port = Number(u.port || 443);

  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: true,
      timeout: 6000,
    });

    sock.on('secureConnect', () => {
      sock.end();
      resolve();
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS handshake timed out')); });
    sock.on('error', reject);
  });
}

async function resolveCaPemForDeployment(shipyardUrl, providedCaPem) {
  if (providedCaPem) return providedCaPem;
  let parsed;
  try { parsed = new URL(shipyardUrl); } catch { throw new Error('Invalid shipyard_url'); }
  if (parsed.protocol !== 'https:') return '';
  // Self-signed/private CA setups must provide shipyard_ca_cert_pem explicitly
  // instead of trusting whatever certificate was seen on the network.
  try {
    await verifyServerTlsTrust(shipyardUrl);
  } catch (e) {
    if (isTlsTrustError(e)) {
      throw new Error('TLS certificate is not trusted. Provide the Shipyard CA certificate manually.');
    }
  }
  return '';
}

router.use(adminOnly);
router.use((req, res, next) => {
  if (db.settings.get('agent_enabled') !== '1') return res.status(403).json({ error: 'Agent feature is disabled' });
  next();
});

router.get('/servers/:id/agent/status', (req, res) => {
  const server = requireServer(req.params.id, res);
  if (!server) return;

  const cfg = db.agentConfig.getByServerId(server.id);
  const latestManifest = db.agentManifests.getLatest();
  const recentMetric = db.agentMetrics.recentByServer(server.id, 1)[0] || null;

  res.json({
    installed: !!cfg,
    mode: cfg?.mode || 'legacy',
    interval: cfg?.interval || 30,
    installedAt: cfg?.installed_at || null,
    lastSeen: cfg?.last_seen || null,
    runnerVersion: cfg?.runner_version || null,
    manifestVersion: cfg?.last_manifest_version || null,
    shipyardUrl: cfg?.shipyard_url || null,
    latestManifestVersion: latestManifest?.version || 1,
    hasRecentMetrics: !!recentMetric,
  });
});

router.post('/servers/:id/agent/install', async (req, res) => {
  if (!ansibleBackendPrecheck(res)) return;
  const server = requireServer(req.params.id, res);
  if (!server) return;

  const requestedMode = String(req.body?.mode || 'auto');
  const mode = ['auto', 'push', 'pull'].includes(requestedMode) ? requestedMode : 'auto';
  const interval = Math.max(5, Math.min(3600, parseInt(req.body?.interval, 10) || 30));
  let caPem = '';
  try { caPem = normalizeCaPem(req.body?.shipyard_ca_cert_pem); } catch (e) { return res.status(400).json({ error: e.message }); }
  const shipyardUrl = resolveShipyardUrl(req, req.body?.shipyard_url);
  if ((mode === 'auto' || mode === 'push') && !isHttpsUrl(shipyardUrl)) {
    return res.status(400).json({ error: 'HTTPS is required for push/auto mode agent communication' });
  }
  try { caPem = await resolveCaPemForDeployment(shipyardUrl, caPem); } catch (e) { return res.status(400).json({ error: `Could not validate Shipyard TLS certificate: ${e.message}` }); }

  const token = crypto.randomBytes(32).toString('hex');

  try {
    manifestService.ensureSeeded();

    const result = await ansibleRunner.runPlaybook(
      'system/agent/agent-deploy.yml',
      server.name,
      {
        shipyard_url: shipyardUrl,
        agent_token: token,
        agent_mode: mode,
        agent_interval: interval,
        shipyard_ca_cert_pem: caPem,
      },
    );

    if (!result.success) {
      return res.status(500).json({ error: 'Agent deploy failed', stderr: result.stderr });
    }

    db.agentConfig.upsert({
      server_id: server.id,
      mode: mode === 'auto' ? 'push' : mode,
      token: encrypt(token),
      shipyard_url: shipyardUrl,
      interval,
      installed_at: new Date().toISOString(),
    });

    db.auditLog.write('agent.install', `Agent installed on ${server.name} (${mode})`, req.ip, true, req.user?.username);
    res.json({ success: true, mode, interval });
  } catch (e) {
    db.auditLog.write('agent.install', `Agent install failed on ${server.name}`, req.ip, false, req.user?.username);
    handleAgentBackendError(res, e, 'agent install');
  }
});

router.post('/servers/:id/agent/update', async (req, res) => {
  if (!ansibleBackendPrecheck(res)) return;
  const server = requireServer(req.params.id, res);
  if (!server) return;
  try {
    const result = await ansibleRunner.runPlaybook('system/agent/agent-update.yml', server.name, {});
    if (!result.success) return res.status(500).json({ error: 'Agent update failed', stderr: result.stderr });
    db.auditLog.write('agent.update', `Agent updated on ${server.name}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    db.auditLog.write('agent.update', `Agent update failed on ${server.name}`, req.ip, false, req.user?.username);
    handleAgentBackendError(res, e, 'agent update');
  }
});

router.put('/servers/:id/agent/config', async (req, res) => {
  if (!ansibleBackendPrecheck(res)) return;
  const server = requireServer(req.params.id, res);
  if (!server) return;

  const cfg = db.agentConfig.getByServerId(server.id);
  if (!cfg) return res.status(404).json({ error: 'Agent is not installed on this server' });

  const requestedMode = String(req.body?.mode || cfg.mode || 'pull');
  const mode = ['push', 'pull', 'legacy'].includes(requestedMode) ? requestedMode : cfg.mode;
  const interval = Math.max(5, Math.min(3600, parseInt(req.body?.interval, 10) || cfg.interval || 30));
  let caPem = '';
  try { caPem = normalizeCaPem(req.body?.shipyard_ca_cert_pem); } catch (e) { return res.status(400).json({ error: e.message }); }
  const shipyardUrl = resolveShipyardUrl(req, req.body?.shipyard_url || cfg.shipyard_url);
  if (mode === 'push' && !isHttpsUrl(shipyardUrl)) {
    return res.status(400).json({ error: 'HTTPS is required for push mode agent communication' });
  }
  try { caPem = await resolveCaPemForDeployment(shipyardUrl, caPem); } catch (e) { return res.status(400).json({ error: `Could not validate Shipyard TLS certificate: ${e.message}` }); }

  try {
    const { token, generated } = getAgentToken(cfg);
    const result = await ansibleRunner.runPlaybook(
      'system/agent/agent-configure.yml',
      server.name,
      {
        shipyard_url: shipyardUrl,
        agent_token: token,
        agent_mode: mode,
        agent_interval: interval,
        shipyard_ca_cert_pem: caPem,
      },
    );
    if (!result.success) return res.status(500).json({ error: 'Agent reconfigure failed', stderr: result.stderr });
    db.agentConfig.updateModeInterval(server.id, mode, interval, shipyardUrl);
    if (generated) db.agentConfig.setToken(server.id, encrypt(token));
    db.auditLog.write('agent.configure', `Agent configured on ${server.name} (${mode}/${interval}s)`, req.ip, true, req.user?.username);
    res.json({ success: true, mode, interval });
  } catch (e) {
    db.auditLog.write('agent.configure', `Agent configure failed on ${server.name}`, req.ip, false, req.user?.username);
    if (e?.status) return res.status(e.status).json({ error: e.message });
    handleAgentBackendError(res, e, 'agent configure');
  }
});

router.post('/servers/:id/agent/token-rotate', async (req, res) => {
  if (!ansibleBackendPrecheck(res)) return;
  const server = requireServer(req.params.id, res);
  if (!server) return;

  const cfg = db.agentConfig.getByServerId(server.id);
  if (!cfg) return res.status(404).json({ error: 'Agent is not installed on this server' });

  const mode = cfg.mode || 'pull';
  const interval = cfg.interval || 30;
  let caPem = '';
  try { caPem = normalizeCaPem(req.body?.shipyard_ca_cert_pem); } catch (e) { return res.status(400).json({ error: e.message }); }
  const shipyardUrl = resolveShipyardUrl(req, req.body?.shipyard_url || cfg.shipyard_url);
  if (mode === 'push' && !isHttpsUrl(shipyardUrl)) {
    return res.status(400).json({ error: 'HTTPS is required for push mode agent communication' });
  }
  try { caPem = await resolveCaPemForDeployment(shipyardUrl, caPem); } catch (e) { return res.status(400).json({ error: `Could not validate Shipyard TLS certificate: ${e.message}` }); }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    db.agentConfig.setToken(server.id, encrypt(token));
    const result = await ansibleRunner.runPlaybook(
      'system/agent/agent-configure.yml',
      server.name,
      {
        shipyard_url: shipyardUrl,
        agent_token: token,
        agent_mode: mode,
        agent_interval: interval,
        shipyard_ca_cert_pem: caPem,
      },
    );
    if (!result.success) return res.status(500).json({ error: 'Agent token rotate failed', stderr: result.stderr });
    db.auditLog.write('agent.token.rotate', `Agent token rotated on ${server.name}`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    db.auditLog.write('agent.token.rotate', `Agent token rotate failed on ${server.name}`, req.ip, false, req.user?.username);
    handleAgentBackendError(res, e, 'agent token rotate');
  }
});

router.delete('/servers/:id/agent', async (req, res) => {
  if (!ansibleBackendPrecheck(res)) return;
  const server = requireServer(req.params.id, res);
  if (!server) return;
  try {
    const result = await ansibleRunner.runPlaybook('system/agent/agent-remove.yml', server.name, {});
    if (!result.success) return res.status(500).json({ error: 'Agent remove failed', stderr: result.stderr });
    db.agentConfig.delete(server.id);
    db.auditLog.write('agent.remove', `Agent removed from ${server.name}`, req.ip, true, req.user?.username);
    res.json({ success: true, mode: 'legacy' });
  } catch (e) {
    db.auditLog.write('agent.remove', `Agent remove failed on ${server.name}`, req.ip, false, req.user?.username);
    handleAgentBackendError(res, e, 'agent remove');
  }
});

router.get('/agent-manifest', (req, res) => {
  try {
    const latest = manifestService.getLatestParsed();
    res.json({ version: latest.version, content: latest.parsed });
  } catch (e) {
    serverError(res, e, 'agent manifest read');
  }
});

router.get('/agent-manifest/history', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    res.json(db.agentManifests.listRecent(limit));
  } catch (e) {
    serverError(res, e, 'agent manifest history');
  }
});

router.put('/agent-manifest', (req, res) => {
  try {
    const createdBy = req.user?.id || req.user?.username || 'admin';
    const changelog = String(req.body?.changelog || '').slice(0, 500);
    const content = req.body?.content;
    const row = manifestService.createVersion({ content, createdBy, changelog });
    db.auditLog.write('agent.manifest.update', `Agent manifest updated to v${row.version}`, req.ip, true, req.user?.username);
    res.json({ success: true, version: row.version });
  } catch (e) {
    db.auditLog.write('agent.manifest.update', 'Agent manifest update failed', req.ip, false, req.user?.username);
    if (e?.status === 400 || e instanceof SyntaxError || /Manifest\./.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    serverError(res, e, 'agent manifest update');
  }
});

module.exports = router;
