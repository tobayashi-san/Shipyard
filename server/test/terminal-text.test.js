'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalTextFilter, stripTerminalCodes } = require('../utils/terminal-text');

test('removes colours, screen clears and redrawn lines from script output', () => {
  const raw = '\x1b[H\x1b[2J\x1b[3J\n  \x1b[2K  ⏳   \x1b[33mChecking for update\x1b[m\n\x1b[K\n  ✔️  \x1b[1;92mDone\x1b[m\nProgress 10%\rProgress 100%\n';
  assert.equal(stripTerminalCodes(raw), '\n    ⏳   Checking for update\n\n  ✔️  Done\nProgress 100%\n');
});

test('holds back an escape sequence split across chunks', () => {
  const filter = createTerminalTextFilter();
  assert.equal(filter.write('Warning\x1b[9'), 'Warning');
  assert.equal(filter.write('3mlow disk\x1b[m\n'), 'low disk\n');
  assert.equal(filter.flush(), '');
});

test('execution summary explains a failed update script with its deciding line', () => {
  const { executionSummary } = require('../utils/execution-summary');
  const output = 'Running: Immich\nSnapshot fleet-pre-immich-202609261140 created on CT 101 (pve001).\n\x1b[H\x1b[2J  💡  \x1b[m \x1b[93mWarning: Storage is dangerously low (81%).\x1b[m\n  ✖️   \x1b[93mNot continuing: only 19% of / is free and there is nobody to ask.\x1b[m\n  \x1b[93mAn upgrade that runs out of disk mid-dpkg leaves the container broken.\x1b[m\n';
  assert.equal(executionSummary('failed', output), 'Not continuing: only 19% of / is free and there is nobody to ask.');
  assert.equal(executionSummary('success', 'step one\nstep two\n'), 'step two');
});

test('detected network mounts are named after their share', () => {
  const { parseDetectedMounts } = require('../utils/storage-mounts');
  const output = '/mnt/nfs 10.40.2.10:/volume1/HMS nfs4\n/mnt/nas2 10.40.2.50:/mnt/Plex_Media/movies nfs4\n/mnt/my\\x20share //nas/share cifs\n/mnt/nfs 10.40.2.10:/volume1/HMS nfs4\n';
  assert.deepEqual(parseDetectedMounts(output), [
    { name: 'HMS (NFS4)', path: '/mnt/nfs', source: '10.40.2.10:/volume1/HMS', fstype: 'nfs4' },
    { name: 'movies (NFS4)', path: '/mnt/nas2', source: '10.40.2.50:/mnt/Plex_Media/movies', fstype: 'nfs4' },
  ]);
});
