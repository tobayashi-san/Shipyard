'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createComposeTempFile, buildComposeWriteOperations } = require('../utils/compose-write');

test('createComposeTempFile writes content and cleans up temp directory', () => {
  const content = 'services:\n  app:\n    image: nginx:latest\n';
  const temp = createComposeTempFile(content);
  try {
    assert.equal(fs.readFileSync(temp.tmpFile, 'utf8'), content);
    assert.ok(fs.existsSync(temp.tmpDir));
  } finally {
    temp.cleanup();
  }
  assert.equal(fs.existsSync(temp.tmpDir), false);
});

test('buildComposeWriteOperations uses ansible file and copy modules', () => {
  const ops = buildComposeWriteOperations('/opt/stacks/demo', '/tmp/shipyard-compose-123/docker-compose.yml');
  assert.deepEqual(ops, {
    ensureDir: {
      module: 'file',
      args: 'path=/opt/stacks/demo state=directory mode=0755',
    },
    copyFile: {
      module: 'copy',
      args: 'src=/tmp/shipyard-compose-123/docker-compose.yml dest=/opt/stacks/demo/docker-compose.yml mode=0644',
    },
  });
});
