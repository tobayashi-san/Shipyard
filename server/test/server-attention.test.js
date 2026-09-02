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

  assert.equal(attention.requiresAttention, false);
  assert.equal(attention.severity, 'healthy');
  assert.deepEqual(attention.reasons, []);
});

test('offline and critical resource alerts produce critical attention', () => {
  const attention = buildServerAttention({
    server: { status: 'offline' },
    alerts: [{ status: 'active', severity: 'critical' }],
  });

  assert.equal(attention.severity, 'critical');
  assert.deepEqual(attention.reasons.map(reason => reason.code), ['offline', 'active_alerts']);
});

test('resource usage uses the same warning thresholds as the dashboard queue', () => {
  const attention = buildServerAttention({
    server: { status: 'online' },
    info: {
      cpu_usage_pct: 22,
      ram_used_mb: 70,
      ram_total_mb: 100,
      disk_used_gb: 88,
      disk_total_gb: 100,
      storage_mount_metrics: [{ name: 'archive', usage_pct: 96 }],
    },
  });

  assert.equal(attention.requiresAttention, true);
  assert.equal(attention.severity, 'critical');
  assert.deepEqual(attention.reasons.map(reason => [reason.code, reason.severity]), [
    ['disk_capacity', 'warning'],
    ['storage_capacity', 'critical'],
  ]);
  assert.equal(attention.thresholds.warning.disk, 85);
});
