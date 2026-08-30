'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildServerAttention } = require('../utils/server-attention');

test('attention keeps reboot requirements and failed automation as separate reasons', () => {
  const attention = buildServerAttention({
    server: { status: 'online' },
    info: { reboot_required: 1 },
    updates: [],
    history: [
      { status: 'failed', started_at: '2026-08-30 10:00:00' },
      { status: 'success', started_at: '2026-08-30 09:00:00' },
      { status: 'failed', started_at: '2026-08-30 08:00:00' },
      { status: 'failed', started_at: '2026-08-30 07:00:00' },
      { status: 'failed', started_at: '2026-08-30 06:00:00' },
    ],
    includeUpdates: true,
    includeHistory: true,
  });

  assert.equal(attention.requiresAttention, true);
  assert.equal(attention.severity, 'warning');
  assert.deepEqual(attention.reasons.map(reason => [reason.code, reason.count]), [
    ['reboot_required', 1],
    ['failed_operations', 3],
  ]);
});

test('attention does not expose inputs excluded by permissions', () => {
  const attention = buildServerAttention({
    server: { status: 'online' },
    info: { reboot_required: 1 },
    updates: [{ name: 'openssl' }],
    history: [{ status: 'failed' }],
  });

  assert.deepEqual(attention, { requiresAttention: false, severity: 'healthy', reasons: [] });
});

test('offline and critical resource alerts produce critical attention', () => {
  const attention = buildServerAttention({
    server: { status: 'offline' },
    alerts: [{ status: 'active', severity: 'critical' }],
  });

  assert.equal(attention.severity, 'critical');
  assert.deepEqual(attention.reasons.map(reason => reason.code), ['offline', 'active_alerts']);
});
