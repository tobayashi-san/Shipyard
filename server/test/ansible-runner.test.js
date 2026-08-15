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

test('runAdHoc appends --become when requested', async () => {
  const originalResolve = ansibleRunner._resolveSshKey;
  const originalSpawn = ansibleRunner._spawnProcess;
  const originalGenerateInventory = ansibleRunner.generateInventory;

  let capturedArgs = null;
  ansibleRunner._resolveSshKey = () => ({ keyPath: '/tmp/test-key', cleanup: () => {} });
  ansibleRunner.generateInventory = () => '/tmp/test-inventory.ini';
  ansibleRunner._spawnProcess = async (_binary, args) => {
    capturedArgs = args;
    return { success: true, stdout: '', stderr: '', code: 0 };
  };

  try {
    await ansibleRunner.runAdHoc('ubuntu-server-01', 'command', 'whoami', null, { become: true });
    assert.deepEqual(capturedArgs, [
      '-i', '/tmp/test-inventory.ini',
      'ubuntu-server-01',
      '-m', 'command',
      '-a', 'whoami',
      '--become',
    ]);
  } finally {
    ansibleRunner._resolveSshKey = originalResolve;
    ansibleRunner._spawnProcess = originalSpawn;
    ansibleRunner.generateInventory = originalGenerateInventory;
    ansibleRunner.clearRun('run-test');
  }
});

test('runAdHoc rejects option-like target arguments before spawning ansible', async () => {
  await assert.rejects(
    () => ansibleRunner.runAdHoc('--list-hosts', 'ping'),
    /Invalid Ansible target/
  );
});

test('ansible environment uses longer ssh tolerance defaults', () => {
  const env = ansibleRunner._ansibleEnv;

  assert.equal(env.ANSIBLE_TIMEOUT, '60');
  assert.equal(env.ANSIBLE_PIPELINING, 'True');
  assert.match(env.ANSIBLE_SSH_ARGS, /StrictHostKeyChecking=accept-new/);
  assert.match(env.ANSIBLE_SSH_ARGS, /ServerAliveInterval=30/);
  assert.match(env.ANSIBLE_SSH_ARGS, /ServerAliveCountMax=6/);
});

test('generateInventory includes only servers from the requested environment', () => {
  db.db.prepare("INSERT OR IGNORE INTO environments (id, name) VALUES ('runner-staging', 'Runner staging')").run();
  db.servers.create({ name: 'stage-only', hostname: 'stage-only', ip_address: '10.30.2.10', environment_id: 'runner-staging', tags: [], services: [] });
  const inventoryPath = ansibleRunner.generateInventory('/tmp/test-key', 'runner-staging');
  const content = fs.readFileSync(inventoryPath, 'utf8');
  assert.match(content, /stage-only/);
  assert.doesNotMatch(content, /ubuntu-server-01/);
  fs.unlinkSync(inventoryPath);
});

test('runPlaybook merges environment variables and applies dry-run and fork options', async () => {
  db.ansibleVars.create('global_value', 'from-store', '', { environmentId: 'default' });
  db.ansibleVars.create('secret_value', 'do-not-log', '', { environmentId: 'default', isSecret: true });
  const originalResolve = ansibleRunner._resolveSshKey;
  const originalSpawn = ansibleRunner._spawnProcess;
  const originalGenerateInventory = ansibleRunner.generateInventory;
  let capturedArgs;
  let streamedOutput = '';
  ansibleRunner._resolveSshKey = () => ({ keyPath: '/tmp/test-key', cleanup: () => {} });
  ansibleRunner.generateInventory = () => '/tmp/test-inventory.ini';
  ansibleRunner._spawnProcess = async (_binary, args, onOutput) => {
    capturedArgs = args;
    onOutput('stdout', 'value=do-not-log');
    return { success: true, stdout: 'value=do-not-log', stderr: '', code: 0 };
  };
  try {
    const result = await ansibleRunner.runPlaybook('update.yml', 'ubuntu-server-01', { run_value: 'manual' }, (_type, data) => { streamedOutput += data; }, {
      environmentId: 'default', checkMode: true, forks: 2, runId: 'run-test',
    });
    const varsIndex = capturedArgs.indexOf('-e');
    assert.deepEqual(JSON.parse(capturedArgs[varsIndex + 1]), { global_value: 'from-store', secret_value: 'do-not-log', run_value: 'manual' });
    assert.ok(capturedArgs.includes('--check'));
    assert.ok(capturedArgs.includes('--diff'));
    assert.deepEqual(capturedArgs.slice(-2), ['--forks', '2']);
    assert.equal(streamedOutput, 'value=********');
    assert.equal(result.stdout, 'value=********');
  } finally {
    ansibleRunner._resolveSshKey = originalResolve;
    ansibleRunner._spawnProcess = originalSpawn;
    ansibleRunner.generateInventory = originalGenerateInventory;
    db.db.prepare("DELETE FROM ansible_vars WHERE key IN ('global_value', 'secret_value')").run();
  }
});

test('a prepared playbook run can be cancelled before Ansible is spawned', async () => {
  const originalResolve = ansibleRunner._resolveSshKey;
  const originalSpawn = ansibleRunner._spawnProcess;
  const originalGenerateInventory = ansibleRunner.generateInventory;
  const runId = 'cancel-before-spawn';
  let spawned = false;
  ansibleRunner._resolveSshKey = () => ({ keyPath: '/tmp/test-key', cleanup: () => {} });
  ansibleRunner.generateInventory = () => '/tmp/test-inventory.ini';
  ansibleRunner._spawnProcess = async () => {
    spawned = true;
    return { success: true, stdout: '', stderr: '', code: 0 };
  };

  try {
    ansibleRunner.prepareRun(runId);
    assert.equal(ansibleRunner.cancelRun(runId), true);
    const result = await ansibleRunner.runPlaybook('update.yml', 'ubuntu-server-01', {}, null, { runId });
    assert.equal(result.cancelled, true);
    assert.equal(spawned, false);
    assert.equal(ansibleRunner.isRunActive(runId), false);
  } finally {
    ansibleRunner._resolveSshKey = originalResolve;
    ansibleRunner._spawnProcess = originalSpawn;
    ansibleRunner.generateInventory = originalGenerateInventory;
    ansibleRunner.clearRun(runId);
  }
});
