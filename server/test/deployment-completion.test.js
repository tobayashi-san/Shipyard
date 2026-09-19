'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeDeployment } = require('../features/opentofu/deployment-completion');
function fixture(overrides = {}) {
  const steps = [];
  const host = { id: 'host', name: 'app01' };
  return { steps, options: {
    phase: phase => steps.push(phase), log: () => {},
    discover: async () => ({ authoritative: true, servers: [host] }),
    register: async () => [host], connect: async () => true,
    postDeploy: async () => ({ failed: 0 }), ...overrides,
  } };
}
test('ready follows registration, successful SSH and post-deploy', async () => {
  const { options, steps } = fixture();
  await completeDeployment(options);
  assert.deepEqual(steps, ['register_host', 'connect_host', 'post_deploy', 'ready']);
});
test('missing IP prevents registration and Ready', async () => {
  const { options, steps } = fixture({ discover: async () => ({ timedOut: true }), register: async () => assert.fail('must not register') });
  await assert.rejects(completeDeployment(options), /address is not available/);
  assert.deepEqual(steps, ['register_host']);
});
test('unreachable SSH prevents post-deploy and can be retried without apply', async () => {
  const { options, steps } = fixture({ connectionTimeoutMs: 0, connect: async () => false, postDeploy: async () => assert.fail('must not run playbooks') });
  await assert.rejects(completeDeployment(options), /cannot connect/);
  assert.deepEqual(steps, ['register_host', 'connect_host']);
  options.connect = async () => true;
  options.postDeploy = async () => ({ failed: 0 });
  await completeDeployment(options);
  assert.equal(steps.at(-1), 'ready');
});
test('failed playbook leaves completion at the post-deploy step', async () => {
  const { options, steps } = fixture({ postDeploy: async () => ({ failed: 1 }) });
  await assert.rejects(completeDeployment(options), /playbook failed/);
  assert.equal(steps.at(-1), 'post_deploy');
});
