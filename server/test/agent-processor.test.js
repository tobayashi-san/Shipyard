'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_agent_processor_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-agent-processor';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { processIncomingReport } = require('../services/agent-processor');

function wipeDb() {
  for (const table of ['agent_metrics', 'agent_config', 'server_info', 'servers']) {
    try { db.db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
}

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('agent reports populate RAM, disk, load and derive CPU usage from previous cpu collector', () => {
  wipeDb();
  const server = db.servers.create({ name: 'agent-srv', hostname: 'agent-srv', ip_address: '10.0.0.50' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: 'tok', interval: 30 });

  db.serverInfo.upsert(server.id, {
    os: 'Debian 12',
    kernel: '6.1.0',
    cpu: 'Intel Test CPU',
    cpu_cores: 2,
    ram_total_mb: 0,
    ram_used_mb: 0,
    disk_total_gb: 0,
    disk_used_gb: 0,
    uptime_seconds: 0,
    load_avg: null,
    reboot_required: false,
    cpu_usage_pct: null,
  });

  processIncomingReport({
    serverId: server.id,
    report: {
      timestamp: 1000,
      manifest_version: 1,
      runner_version: '3.0.0',
      collectors: [
        { id: 'cpu', output: 'cpu  100 0 100 700 50 0 0 0 0 0' },
        { id: 'memory', output: 'MemTotal: 1048576\nMemAvailable: 524288\n' },
        { id: 'disk', output: 'Filesystem 1M-blocks Used Available Use% Mounted on\n/dev/sda1 1000 250 750 25% /\n' },
        { id: 'load', output: '0.10 0.20 0.30 1/100 999' },
        { id: 'uptime', output: '12345.67' },
        { id: 'os_info', output: 'PRETTY_NAME=\"Debian 12\"\n' },
        { id: 'nproc', output: '2' },
      ],
    },
  });

  processIncomingReport({
    serverId: server.id,
    report: {
      timestamp: 1030,
      manifest_version: 1,
      runner_version: '3.0.0',
      collectors: [
        { id: 'cpu', output: 'cpu  130 0 120 730 60 0 0 0 0 0' },
        { id: 'memory', output: 'MemTotal: 1048576\nMemAvailable: 262144\n' },
        { id: 'disk', output: 'Filesystem 1M-blocks Used Available Use% Mounted on\n/dev/sda1 1000 400 600 40% /\n' },
        { id: 'load', output: '0.40 0.50 0.60 2/100 1000' },
        { id: 'uptime', output: '12400.00' },
        { id: 'os_info', output: 'PRETTY_NAME=\"Debian 12\"\n' },
        { id: 'nproc', output: '2' },
      ],
    },
  });

  const info = db.serverInfo.get(server.id);
  assert.equal(info.os, 'Debian 12');
  assert.equal(info.kernel, '6.1.0');
  assert.equal(info.cpu, 'Intel Test CPU');
  assert.equal(info.cpu_cores, 2);
  assert.equal(info.ram_total_mb, 1024);
  assert.equal(info.ram_used_mb, 768);
  assert.equal(info.disk_total_gb, 1);
  assert.equal(info.disk_used_gb, 0.4);
  assert.equal(info.uptime_seconds, 12400);
  assert.equal(info.load_avg, '0.40 0.50 0.60');
  assert.equal(info.cpu_usage_pct, 56);
});
