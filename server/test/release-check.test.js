'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewerStable } = require('../services/release-check');

test('only newer stable releases count as updates', () => {
  assert.equal(isNewerStable('v3.2.0', '3.1.0'), true);
  assert.equal(isNewerStable('3.1.1', '3.1.0'), true);
  assert.equal(isNewerStable('3.10.0', '3.9.4'), true);
  assert.equal(isNewerStable('3.1.0', '3.1.0'), false);
  assert.equal(isNewerStable('3.0.9', '3.1.0'), false);
  assert.equal(isNewerStable('3.2.0-rc.1', '3.1.0'), false);
  assert.equal(isNewerStable('3.2.0', '3.2.0-rc.4'), true);
  assert.equal(isNewerStable('latest', '3.1.0'), false);
});
