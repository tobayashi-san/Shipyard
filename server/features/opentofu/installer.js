'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function normalizeArchitecture(architecture = process.arch) {
  if (architecture === 'arm64') return 'arm64';
  if (architecture === 'x64') return 'amd64';
  throw new Error(`OpenTofu installation is not supported on ${architecture}.`);
}

function parseChecksum(contents, filename) {
  for (const line of String(contents || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function installOpenTofu({ version, architecture, installPath, releases, downloadFile, execFile }) {
  if (!VERSION_RE.test(String(version || '')) || !releases.includes(version)) {
    const error = new Error('Select a published stable OpenTofu release.');
    error.status = 400;
    throw error;
  }
  const arch = normalizeArchitecture(architecture);
  const filename = `tofu_${version}_linux_${arch}.zip`;
  const releaseRoot = `https://github.com/opentofu/opentofu/releases/download/v${version}`;
  const installDir = path.dirname(installPath);
  const operationId = randomUUID().slice(0, 12);
  const archivePath = path.join('/tmp', `tofu-${operationId}.zip`);
  const checksumPath = path.join('/tmp', `tofu-${operationId}.sha256sums`);
  const stagingDir = path.join(installDir, `.tofu-install-${operationId}`);
  const stagedBinary = path.join(stagingDir, 'tofu');

  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  try {
    await downloadFile(`${releaseRoot}/${filename}`, archivePath);
    await downloadFile(`${releaseRoot}/tofu_${version}_SHA256SUMS`, checksumPath);
    const expected = parseChecksum(fs.readFileSync(checksumPath, 'utf8'), filename);
    if (!expected || sha256File(archivePath) !== expected) {
      throw new Error('The downloaded OpenTofu archive failed SHA-256 verification.');
    }
    await execFile('unzip', ['-q', archivePath, 'tofu', '-d', stagingDir]);
    fs.chmodSync(stagedBinary, 0o755);
    const result = await execFile(stagedBinary, ['version', '-json'], { encoding: 'utf8', timeout: 10_000 });
    const parsed = JSON.parse(result.stdout || result);
    const installedVersion = String(parsed.terraform_version || parsed.tofu_version || '');
    if (installedVersion !== version) throw new Error('The downloaded OpenTofu binary reported an unexpected version.');
    fs.renameSync(stagedBinary, installPath);
    return installedVersion;
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.unlinkSync(checksumPath); } catch {}
  }
}

module.exports = { VERSION_RE, installOpenTofu, normalizeArchitecture, parseChecksum, sha256File };
