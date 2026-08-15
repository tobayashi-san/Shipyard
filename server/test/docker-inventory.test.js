const test = require('node:test');
const assert = require('node:assert/strict');

const { extractContainerLines, extractMarkedContainerLines, parseContainerLines } = require('../services/docker-inventory');

test('docker inventory accepts Ansible debug output regardless of msg whitespace', () => {
  const lines = extractContainerLines('ok: [host] => {"msg":["web|nginx:latest|running|Up 2 hours|today|site|/srv/site"]}');
  assert.deepEqual(lines, ['web|nginx:latest|running|Up 2 hours|today|site|/srv/site']);
  assert.deepEqual(parseContainerLines(lines), [{
    name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', createdAt: 'today', composeProject: 'site', composeWorkingDir: '/srv/site',
  }]);
});

test('docker inventory ignores unrelated debug messages before the container result', () => {
  const lines = extractContainerLines('"msg": "other"\n"msg" : ["db|postgres:16|running|Up|today||"]');
  assert.deepEqual(lines, ['db|postgres:16|running|Up|today||']);
});

test('docker inventory reads marker-prefixed lines from an ad-hoc Ansible response', () => {
  const lines = extractMarkedContainerLines('host | CHANGED | rc=0 >>\n__SHIPYARD_CONTAINER__web|nginx:latest|running|Up 2 hours|today|site|/srv/site');
  assert.deepEqual(lines, ['web|nginx:latest|running|Up 2 hours|today|site|/srv/site']);
});
