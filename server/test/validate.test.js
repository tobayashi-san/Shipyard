'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateTargets,
  parseTargetExpression,
  targetIncludesServer,
  validateKnownInventoryTargets,
  validateInventoryHostName,
  sanitizeInventoryGroupName,
} = require('../utils/validate');

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

test('validateKnownInventoryTargets rejects unknown and option-like targets', () => {
  const servers = [
    { name: 'web-1', tags: JSON.stringify(['production']) },
    { name: 'db-1', tags: JSON.stringify(['db cluster']) },
  ];
  assert.equal(validateKnownInventoryTargets('web-1,db-1', servers), null);
  assert.equal(validateKnownInventoryTargets('production', servers), null);
  assert.equal(validateKnownInventoryTargets('db_cluster', servers), null);
  assert.equal(validateKnownInventoryTargets('localhost', servers), 'Unknown target(s): localhost');
  assert.equal(validateKnownInventoryTargets('--list-hosts', servers), 'targets must not start with -');
});

test('validateInventoryHostName rejects reserved or unsafe ansible host names', () => {
  assert.equal(validateInventoryHostName('web-1'), null);
  assert.equal(validateInventoryHostName('all'), 'Name is reserved');
  assert.equal(validateInventoryHostName('localhost'), 'Name is reserved');
  assert.equal(validateInventoryHostName('-bad'), 'Name must not start with -');
  assert.equal(validateInventoryHostName('web 1'), 'Name may only contain letters, numbers, dots, underscores, and hyphens');
});

test('sanitizeInventoryGroupName matches ansible inventory tag normalization', () => {
  assert.equal(sanitizeInventoryGroupName('db cluster'), 'db_cluster');
  assert.equal(sanitizeInventoryGroupName('prod/api'), 'prod_api');
});
