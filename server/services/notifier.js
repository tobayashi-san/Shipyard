/**
 * Unified notification service — sends webhooks and/or SMTP email.
 * Call notify(title, message, success) anywhere in the app.
 */
const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const log = require('../utils/logger').child('webhook');
const db = require('../db');
const { getSecret } = require('../utils/crypto');

// ── SSRF IP-range check (applied to both hostname and resolved IP) ──────────

function isPrivateOrSpecialIpv4(ip) {
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some(n => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function parseMappedIpv4FromIpv6(v6) {
  const m = String(v6).toLowerCase().match(/^::ffff:(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (tail.includes('.')) return isPrivateOrSpecialIpv4(tail) ? tail : null;

  const hexGroups = tail.split(':').filter(Boolean);
  if (hexGroups.length !== 2) return null;
  const hi = Number.parseInt(hexGroups[0], 16);
  const lo = Number.parseInt(hexGroups[1], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null;

  const ipv4 = [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff,
  ].join('.');
  return isPrivateOrSpecialIpv4(ipv4) ? ipv4 : null;
}

function isBlockedHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const blockedHosts = ['localhost', '0.0.0.0', 'metadata.google.internal',
    'metadata.google.internal.', '169.254.169.254'];
  if (blockedHosts.includes(h)) return true;
  if (isPrivateOrSpecialIpv4(h)) return true;

  // IPv6 loopback, link-local, and private ranges
  const hLower = h.toLowerCase();
  if (parseMappedIpv4FromIpv6(hLower)) return true;
  if (hLower === '::1' || hLower === '::' ||
      hLower.startsWith('fe80:') || hLower.startsWith('fc') || hLower.startsWith('fd')) return true;
  return false;
}

// ── Webhook ────────────────────────────────────────────────────────────────

async function sendWebhook(title, message, success) {
  const url = db.settings.get('webhook_url');
  if (!url) return;

  const secret = getSecret(db, 'webhook_secret') || '';
  let payload;

  try {
    const parsedUrl = new URL(url);

    // Block obviously internal hostnames/IPs before DNS resolution
    if (isBlockedHost(parsedUrl.hostname)) {
      log.warn({ host: parsedUrl.hostname }, 'Blocked request to internal address');
      return { ok: false };
    }

    // Resolve hostname and re-check the resulting IP (prevents DNS-rebinding / SSRF via
    // public domains that point to private addresses)
    try {
      const resolvedIps = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
      for (const record of resolvedIps) {
        if (isBlockedHost(record.address)) {
          log.warn({ host: parsedUrl.hostname, resolvedIp: record.address }, 'Blocked: hostname resolves to internal IP');
          return { ok: false };
        }
      }
    } catch {
      log.warn({ host: parsedUrl.hostname }, 'Blocked: DNS resolution failed');
      return { ok: false };
    }

    if (parsedUrl.hostname.includes('discord.com') || parsedUrl.pathname.startsWith('/api/webhooks')) {
      payload = {
        embeds: [{
          title,
          description: message,
          color: success ? 0x22c55e : 0xef4444,
          timestamp: new Date().toISOString(),
        }],
      };
    } else if (parsedUrl.hostname === 'hooks.slack.com') {
      payload = {
        text: `${success ? '✅' : '❌'} *${title}*`,
        attachments: [{ text: message, color: success ? '#22c55e' : '#ef4444' }],
      };
    } else {
      payload = { title, message, success, timestamp: new Date().toISOString() };
    }

    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;

    return new Promise((resolve) => {
      const req = (parsedUrl.protocol === 'https:' ? https : http).request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || undefined,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers,
          timeout: 10000,
        },
        (res) => {
          res.resume();
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
        }
      );
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    });
  } catch {
    return { ok: false };
  }
}

// ── SMTP ───────────────────────────────────────────────────────────────────

let _smtpTransporter = null;
let _smtpConfigHash  = '';

async function sendEmail(title, message, success) {
  const host = db.settings.get('smtp_host');
  const to   = db.settings.get('smtp_to');
  if (!host || !to) return;

  const nodemailer = require('nodemailer');

  const port     = parseInt(db.settings.get('smtp_port') || '587');
  const user     = db.settings.get('smtp_user') || '';
  const pass     = getSecret(db, 'smtp_pass') || '';
  const from     = db.settings.get('smtp_from') || user;
  const secure   = port === 465;

  // Reuse transporter unless SMTP config has changed
  const cfgHash = `${host}:${port}:${user}:${pass}:${secure}`;
  if (_smtpTransporter && _smtpConfigHash !== cfgHash) {
    try { _smtpTransporter.close(); } catch {}
    _smtpTransporter = null;
  }
  if (!_smtpTransporter) {
    _smtpTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    _smtpConfigHash = cfgHash;
  }
  const transporter = _smtpTransporter;

  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const icon = success ? '✅' : '❌';
  await transporter.sendMail({
    from,
    to,
    subject: `${icon} ${title}`,
    text: `${title}\n\n${message}`,
    html: `<p><strong>${icon} ${escHtml(title)}</strong></p><p>${escHtml(message).replace(/\n/g, '<br>')}</p>`,
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

async function notify(title, message, success) {
  await Promise.allSettled([
    sendWebhook(title, message, success),
    sendEmail(title, message, success),
  ]);
}

module.exports = { notify, sendWebhook, sendEmail };
