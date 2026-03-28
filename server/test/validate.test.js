'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateTargets, parseTargetExpression, targetIncludesServer } = require('../utils/validate');

test('validateTargets accepts all-except syntax', () => {
  assert.equal(validateTargets('all:!web-1:!db-1'), null);
});

test('validateTargets rejects blank targets', () => {
  assert.equal(validateTargets('   '), 'targets is required');
});

test('parseTargetExpression parses all-except syntax', () => {
  assert.deepEqual(parseTargetExpression('all:!web-1:!db-1'), {
    kind: 'all_except',
    included: ['all'],
    excluded: ['web-1', 'db-1'],
  });
});

test('parseTargetExpression parses explicit target lists', () => {
  assert.deepEqual(parseTargetExpression('web-1,db-1'), {
    kind: 'list',
    included: ['web-1', 'db-1'],
    excluded: [],
  });
});

test('targetIncludesServer respects all-except exclusions', () => {
  assert.equal(targetIncludesServer('all:!db-1', 'web-1'), true);
  assert.equal(targetIncludesServer('all:!db-1', 'db-1'), false);
});

test('targetIncludesServer matches explicit target lists', () => {
  assert.equal(targetIncludesServer('web-1,db-1', 'web-1'), true);
  assert.equal(targetIncludesServer('web-1,db-1', 'cache-1'), false);
});
