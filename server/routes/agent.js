const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { decrypt } = require('../utils/crypto');
const manifestService = require('../services/agent-manifest');
const { processIncomingReport } = require('../services/agent-processor');
const log = require('../utils/logger').child('routes:agent');

const router = express.Router();
const reportWindowMs = 10 * 1000;
const lastReportByServer = new Map();
// Hard cap to bound memory if many distinct server_ids report.
const MAX_TRACKED_SERVERS = 10000;

function pruneStaleReports(now) {
  const cutoff = now - reportWindowMs;
  for (const [id, ts] of lastReportByServer) {
    if (ts <= cutoff) lastReportByServer.delete(id);
  }
}

const preAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many agent API requests. Please slow down.' },
});

router.use(preAuthLimiter);

function getBearerToken(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function isSecureReq(req) {
  return !!req.secure;
}

function authenticateAgent(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const rows = db.agentConfig.getAll();
  for (const row of rows) {
    if (!row.token) continue;
    const stored = decrypt(row.token);
    if (stored && secureEqual(stored, token)) return row;
  }
  return null;
}

router.get('/manifest', (req, res) => {
  if (!isSecureReq(req)) {
    return res.status(400).json({ error: 'HTTPS is required for agent communication' });
  }

  const cfg = authenticateAgent(req);
  if (!cfg) return res.status(401).json({ error: 'Unauthorized' });

  const latest = manifestService.getLatestParsed();
  const etag = `"agent-manifest-v${latest.version}"`;
  res.setHeader('ETag', etag);
  if (String(req.headers['if-none-match'] || '') === etag) {
    return res.status(304).end();
  }

  // Strip _comment (human-readable, not needed by agent)
  const { _comment, ...manifest } = latest.parsed;
  // Pretty-print so the agent's lightweight awk parser can process line by line
  res.type('json').send(JSON.stringify(manifest, null, 2));
});

router.post('/report', (req, res) => {
  if (!isSecureReq(req)) {
    return res.status(400).json({ error: 'HTTPS is required for agent communication' });
  }

  const cfg = authenticateAgent(req);
  if (!cfg) return res.status(401).json({ error: 'Unauthorized' });

  const now = Date.now();
  const last = lastReportByServer.get(cfg.server_id) || 0;
  if (now - last < reportWindowMs) {
    return res.status(429).json({ error: 'Rate limit exceeded for this agent token' });
  }
  // Opportunistic prune: stale entries (older than the rate-limit window) are
  // useless and otherwise grow the map unbounded as new server_ids report.
  if (lastReportByServer.size >= MAX_TRACKED_SERVERS) {
    pruneStaleReports(now);
    // If still at cap after pruning, drop the oldest entry to make room.
    if (lastReportByServer.size >= MAX_TRACKED_SERVERS) {
      const oldestKey = lastReportByServer.keys().next().value;
      if (oldestKey !== undefined) lastReportByServer.delete(oldestKey);
    }
  }
  lastReportByServer.set(cfg.server_id, now);

  try {
    processIncomingReport({
      serverId: cfg.server_id,
      report: req.body,
      source: 'push',
    });
    res.json({ ok: true });
  } catch (e) {
    log.warn({ err: e, serverId: cfg.server_id }, 'Agent report rejected');
    res.status(400).json({ error: e.message || 'Invalid report payload' });
  }
});

module.exports = router;
