const https = require('https');
const http = require('http');
const db = require('../db');

async function sendWebhook(title, message, success) {
  const url = db.settings.get('webhook_url');
  if (!url) return;

  const secret = db.settings.get('webhook_secret') || '';
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
          res.resume(); // drain
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

module.exports = { sendWebhook };
