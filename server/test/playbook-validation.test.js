const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlaybookContent } = require('../utils/playbook-validation');

test('accepts regular and imported Ansible plays', () => {
  assert.deepEqual(validatePlaybookContent(`
- name: Configure web nodes
  hosts: web
  tasks:
    - name: Ping hosts
      ansible.builtin.ping:
- import_playbook: shared.yml
`), { valid: true });
});

test('reports YAML parser locations', () => {
  const result = validatePlaybookContent('- hosts: all\n  tasks: [');
  assert.equal(result.valid, false);
  assert.match(result.error, /Invalid YAML at line \d+, column \d+:/);
});

test('rejects a YAML mapping instead of a play list', () => {
  const result = validatePlaybookContent('hosts: all\ntasks: []');
  assert.deepEqual(result, {
    valid: false,
    error: 'Playbook must be a YAML list of plays.',
  });
});

test('rejects plays without a target and malformed task sections', () => {
  assert.match(validatePlaybookContent('- name: Missing target\n  tasks: []').error, /needs a non-empty "hosts" target/);
  assert.match(validatePlaybookContent('- hosts: all\n  tasks: ping').error, /"tasks" must be a list/);
});
