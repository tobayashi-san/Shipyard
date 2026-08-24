const test = require('node:test');
const assert = require('node:assert/strict');

const { extractContainerLines, extractMarkedContainerLines, extractMarkedStats, parseContainerLines } = require('../services/docker-inventory');

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

test('docker inventory parses per-container CPU and memory statistics', () => {
  const stats = extractMarkedStats([
    '__SHIPYARD_STATS__web|1.25%|128MiB / 1GiB|12.50%',
    '__SHIPYARD_STATS__db|0.00%|2GiB / 4GiB|50.00%',
  ].join('\n'));
  assert.deepEqual(stats.get('web'), {
    cpuPercent: 1.25,
    memoryUsage: '128MiB / 1GiB',
    memoryPercent: 12.5,
  });
  assert.equal(stats.get('db').memoryPercent, 50);
});
