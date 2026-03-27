'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_notifier_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-notifier';
process.env.NODE_ENV = 'test';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { sendWebhook } = require('../services/notifier');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

// ── SSRF Protection ──────────────────────────────────────────────────────────

describe('webhook SSRF protection', () => {
  const blockedUrls = [
    'http://localhost/hook',
    'http://0.0.0.0/hook',
    'http://127.0.0.1/hook',
    'http://10.0.0.1/hook',
    'http://192.168.1.1/hook',
    'http://172.16.0.1/hook',
    'http://172.31.255.255/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/',
    'http://[::1]/hook',
    'http://[fe80::1]/hook',
    'http://[fc00::1]/hook',
    'http://[fd00::1]/hook',
    'http://[::ffff:172.16.0.1]/hook',
  ];

  for (const url of blockedUrls) {
    test(`blocks ${url}`, async () => {
      db.settings.set('webhook_url', url);
      const result = await sendWebhook('Test', 'test message', true);
      assert.deepEqual(result, { ok: false });
    });
  }

  test('blocks domain that resolves to internal IP (DNS SSRF bypass)', async () => {
    const dns = require('dns').promises;
    const originalLookup = dns.lookup;
    // Simulate a public domain that points to the AWS metadata IP
    dns.lookup = async (hostname, opts) => {
      if (hostname === 'evil.ssrf-test.example') {
        if (opts?.all) return [{ address: '169.254.169.254', family: 4 }];
        return { address: '169.254.169.254', family: 4 };
      }
      return originalLookup(hostname, opts);
    };
    try {
      db.settings.set('webhook_url', 'https://evil.ssrf-test.example/hook');
      const result = await sendWebhook('Test', 'SSRF test', true);
      assert.deepEqual(result, { ok: false });
    } finally {
      dns.lookup = originalLookup;
    }
  });

  test('blocks domain that resolves to loopback (127.x DNS bypass)', async () => {
    const dns = require('dns').promises;
    const originalLookup = dns.lookup;
    dns.lookup = async (hostname, opts) => {
      if (hostname === 'loopback.ssrf-test.example') {
        if (opts?.all) return [{ address: '127.0.0.1', family: 4 }];
        return { address: '127.0.0.1', family: 4 };
      }
      return originalLookup(hostname, opts);
    };
    try {
      db.settings.set('webhook_url', 'http://loopback.ssrf-test.example/hook');
      const result = await sendWebhook('Test', 'SSRF test', true);
      assert.deepEqual(result, { ok: false });
    } finally {
      dns.lookup = originalLookup;
    }
  });

  test('blocks when one of multiple DNS records resolves internally', async () => {
    const dns = require('dns').promises;
    const originalLookup = dns.lookup;
    dns.lookup = async (hostname, opts) => {
      if (hostname === 'mixed.ssrf-test.example') {
        if (opts?.all) {
          return [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ];
        }
        return { address: '93.184.216.34', family: 4 };
      }
      return originalLookup(hostname, opts);
    };
    try {
      db.settings.set('webhook_url', 'https://mixed.ssrf-test.example/hook');
      const result = await sendWebhook('Test', 'SSRF test', true);
      assert.deepEqual(result, { ok: false });
    } finally {
      dns.lookup = originalLookup;
    }
  });

  test('returns undefined when no webhook URL configured', async () => {
    db.settings.set('webhook_url', '');
    const result = await sendWebhook('Test', 'test message', true);
    assert.equal(result, undefined);
  });
});
