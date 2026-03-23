/**
 * Unified notification service — sends webhooks and/or SMTP email.
 * Call notify(title, message, success) anywhere in the app.
 */
const https = require('https');
const http = require('http');
const db = require('../db');
const { getSecret } = require('../utils/crypto');

// ── Webhook ────────────────────────────────────────────────────────────────

async function sendWebhook(title, message, success) {
  const url = db.settings.get('webhook_url');
  if (!url) return;

  const secret = getSecret(db, 'webhook_secret') || '';
  let payload;

  try {
    const parsedUrl = new URL(url);

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

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized: !secure },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

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
