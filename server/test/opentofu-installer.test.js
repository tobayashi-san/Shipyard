'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { installOpenTofu, normalizeArchitecture, parseChecksum } = require('../features/opentofu/installer');

test('checksum parsing selects the exact OpenTofu archive', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksum(`${'b'.repeat(64)}  other.zip\n${hash}  tofu_1.9.0_linux_amd64.zip\n`, 'tofu_1.9.0_linux_amd64.zip'), hash);
  assert.equal(parseChecksum(`${hash}  tofu_1.9.0_linux_arm64.zip\n`, 'tofu_1.9.0_linux_amd64.zip'), null);
});

test('installer verifies and atomically replaces the persistent OpenTofu binary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-tofu-installer-'));
  const installPath = path.join(root, 'bin', 'tofu');
  fs.mkdirSync(path.dirname(installPath), { recursive: true });
  fs.writeFileSync(installPath, 'old binary');
  const archive = Buffer.from('verified archive fixture');
  const checksum = crypto.createHash('sha256').update(archive).digest('hex');

  try {
    const version = await installOpenTofu({
      version: '1.9.0',
      architecture: 'x64',
      installPath,
      releases: ['1.9.0'],
      downloadFile: async (url, destination) => {
        fs.writeFileSync(destination, url.endsWith('SHA256SUMS')
          ? `${checksum}  tofu_1.9.0_linux_amd64.zip\n`
          : archive);
      },
      execFile: async (command, args) => {
        if (command === 'unzip') {
          fs.writeFileSync(path.join(args.at(-1), 'tofu'), 'new binary');
          return { stdout: '' };
        }
        return { stdout: JSON.stringify({ terraform_version: '1.9.0' }) };
      },
    });
    assert.equal(version, '1.9.0');
    assert.equal(fs.readFileSync(installPath, 'utf8'), 'new binary');
    assert.equal(fs.statSync(installPath).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.dirname(installPath)), ['tofu']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects unpublished releases and unsupported container architectures', async () => {
  await assert.rejects(() => installOpenTofu({
    version: '9.9.9', architecture: 'x64', installPath: '/tmp/unused-tofu', releases: [],
    downloadFile: async () => {}, execFile: async () => ({ stdout: '' }),
  }), /published stable/);
  assert.throws(() => normalizeArchitecture('riscv64'), /not supported/);
});
