'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_ansible_${Date.now()}.db`);
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const ansibleRunner = require('../services/ansible-runner');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('generateInventory sanitizes tag-based group names for ansible ini syntax', () => {
  db.servers.create({
    name: 'ubuntu-server-01',
    hostname: 'ubuntu-server-01',
    ip_address: '10.30.1.200',
    ssh_port: 22,
    ssh_user: 'ubuntu',
    tags: ['opentofu:Proxmox', 'group with spaces'],
    services: [],
  });

  const inventoryPath = ansibleRunner.generateInventory('/tmp/test-key');
  const content = fs.readFileSync(inventoryPath, 'utf8');

  assert.match(content, /\[opentofu_Proxmox\]/);
  assert.match(content, /\[group_with_spaces\]/);
  assert.doesNotMatch(content, /\[opentofu:Proxmox\]/);

  fs.unlinkSync(inventoryPath);
});
