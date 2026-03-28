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

test('agent parser tolerates NUL-separated collector output and avoids bogus 100% RAM', () => {
  wipeDb();
  const server = db.servers.create({ name: 'agent-nul', hostname: 'agent-nul', ip_address: '10.0.0.51' });
  db.agentConfig.upsert({ server_id: server.id, mode: 'push', token: 'tok', interval: 30 });

  // Seed existing values to ensure parser can overwrite stale SSH-derived data.
  db.serverInfo.upsert(server.id, {
    os: 'Old OS',
    kernel: '6.1.0',
    cpu: 'Intel Test CPU',
    cpu_cores: 2,
    ram_total_mb: 4096,
    ram_used_mb: 4096,
    disk_total_gb: 200,
    disk_used_gb: 150,
    uptime_seconds: 0,
    load_avg: null,
    reboot_required: false,
    cpu_usage_pct: null,
  });

  const nul = '\u0000';
  processIncomingReport({
    serverId: server.id,
    report: {
      timestamp: 2000,
      manifest_version: 1,
      runner_version: '3.0.0',
      collectors: [
        { id: 'cpu', output: `cpu  100 0 100 700 50 0 0 0 0 0${nul}` },
        { id: 'memory', output: `MemTotal: 6291456 kB${nul}MemFree: 1048576 kB${nul}Buffers: 262144 kB${nul}Cached: 1048576 kB` },
        { id: 'disk', output: `Filesystem 1M-blocks Used Available Use% Mounted on${nul}/dev/sda1 150000 105000 45000 70% /` },
        { id: 'load', output: '0.89 0.91 0.94 1/100 1234' },
        { id: 'uptime', output: `643500.00${nul}` },
        { id: 'os_info', output: `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"${nul}NAME="Debian GNU/Linux"` },
        { id: 'nproc', output: `4${nul}` },
      ],
    },
  });

  const info = db.serverInfo.get(server.id);
  assert.equal(info.os, 'Debian GNU/Linux 13 (trixie)');
  assert.equal(info.cpu_cores, 4);
  assert.equal(info.ram_total_mb, 6144);
  assert.equal(info.ram_used_mb, 3840);
  assert.equal(info.disk_total_gb, 146.5);
  assert.equal(info.disk_used_gb, 102.5);
  assert.equal(info.load_avg, '0.89 0.91 0.94');
});
