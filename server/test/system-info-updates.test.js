'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');

const server = { id: 'system-updates-test', ip_address: '127.0.0.1', ssh_user: 'root', ssh_port: 22 };

test('package update checks expose a remote failure instead of reporting no updates', async () => {
  const original = sshManager.execCommand;
  sshManager.execCommand = async () => ({ code: 1, stdout: '', stderr: 'apt metadata refresh failed' });
  try {
    await assert.rejects(
      systemInfo.getAvailableUpdates(server),
      /Failed to check available updates: apt metadata refresh failed/,
    );
  } finally {
    sshManager.execCommand = original;
  }
});

test('package update checks still parse a successful fresh result', async () => {
  const original = sshManager.execCommand;
  let command = '';
  sshManager.execCommand = async (_server, value) => {
    command = value;
    return {
    code: 0,
    // The production awk expression emits just the package name after
    // `---PHASED---`, not the complete apt simulation line.
    stdout: 'openssl/jammy-updates 3.0.2\nlinux-image/jammy-updates 6.8\n---PHASED---\nopenssl\n---WOULDUPGRADE---\n',
    stderr: '',
    };
  };
  try {
    assert.deepEqual(await systemInfo.getAvailableUpdates(server), [
      { package: 'openssl', version: '3.0.2', source: '', phased: false },
      { package: 'linux-image', version: '6.8', source: '', phased: true },
    ]);
    assert.match(command, /run_privileged apt-get update -qq/);
    assert.match(command, /sudo -n/);
  } finally {
    sshManager.execCommand = original;
  }
});
