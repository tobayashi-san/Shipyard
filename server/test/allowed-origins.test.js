const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_ORIGINS,
  isAllowedRequestOrigin,
  parseAllowedOrigins,
} = require('../utils/allowed-origins');

test('default dev origins include the current Vite frontend port', () => {
  assert.deepEqual(DEFAULT_ORIGINS, ['http://localhost:3000', 'http://localhost:5174']);
  assert.deepEqual(parseAllowedOrigins(''), DEFAULT_ORIGINS);
  assert.equal(isAllowedRequestOrigin(DEFAULT_ORIGINS, 'http://localhost:5174'), true);
});
