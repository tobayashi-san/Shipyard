'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_custom_updates_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-custom-updates';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const scheduler = require('../services/scheduler');
const sshManager = require('../services/ssh-manager');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('trigger custom update task marks update when command output matches trigger output exactly', async () => {
  const server = db.servers.create({ name: 'truenas', hostname: 'truenas.local', ip_address: '10.0.0.70' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'TrueNAS',
    type: 'trigger',
    check_command: 'midclt call update.check_available',
    trigger_output: 'AVAILABLE',
    update_command: '',
  });

  const original = sshManager.execCommand;
  sshManager.execCommand = async () => ({ code: 0, stdout: 'AVAILABLE\n' });
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = original;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, 'AVAILABLE');
  assert.equal(updated.last_version, 'AVAILABLE');
  assert.equal(updated.has_update, 1);
});

test('trigger custom update task stays clear when output does not match trigger output', async () => {
  const server = db.servers.create({ name: 'truenas-2', hostname: 'truenas-2.local', ip_address: '10.0.0.71' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'TrueNAS',
    type: 'trigger',
    check_command: 'midclt call update.check_available',
    trigger_output: 'AVAILABLE',
    update_command: '',
  });

  const original = sshManager.execCommand;
  sshManager.execCommand = async () => ({ code: 0, stdout: 'UNAVAILABLE\n' });
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = original;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, 'UNAVAILABLE');
  assert.equal(updated.last_version, 'AVAILABLE');
  assert.equal(updated.has_update, 0);
});
