'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_known_hosts_${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const sshManager = require('../services/ssh-manager');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('removeKnownHostEntries removes matching hosts from known_hosts and reports missing ones', () => {
  const knownHostsPath = sshManager.getKnownHostsPath();
  fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
  const pub = fs.readFileSync(path.join(__dirname, '..', 'data', 'ssh', 'exp_test.pub'), 'utf8').trim();

  fs.writeFileSync(knownHostsPath, `10.30.1.200 ${pub}\nubuntu-server-01 ${pub}\n`, 'utf8');

  const result = sshManager.removeKnownHostEntries(['10.30.1.200', 'missing-host']);
  const afterContent = fs.readFileSync(knownHostsPath, 'utf8');

  assert.deepEqual(result.removed, ['10.30.1.200']);
  assert.deepEqual(result.missing, ['missing-host']);
  assert.ok(!afterContent.includes('10.30.1.200'));
  assert.ok(afterContent.includes('ubuntu-server-01'));
});
