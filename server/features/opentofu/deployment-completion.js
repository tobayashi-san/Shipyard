'use strict';

// This stage never runs OpenTofu apply. It is safe to resume after provisioning.
async function completeDeployment({ discover, register, connect, postDeploy, phase, log, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, connectionTimeoutMs = 90_000, allowEmpty = false }) {
  phase('register_host');
  const sync = await discover();
  if (allowEmpty && sync.source === 'state' && !sync.servers.length) { phase('ready'); return []; }
  if (sync.timedOut || !sync.authoritative || !sync.servers.length) {
    throw new Error('VM created, but its address is not available. Check networking and the guest agent, then retry host connection.');
  }
  const hosts = await register(sync);
  if (hosts.length !== sync.servers.length) throw new Error('Host registration is incomplete. Check the deployment log and retry host connection.');
  phase('connect_host');
  for (const host of hosts) {
    const started = now();
    let cause = 'SSH is not reachable';
    while (true) {
      try {
        if (await connect(host)) break;
      } catch (error) { cause = error.message || cause; }
      if (now() - started >= connectionTimeoutMs) throw new Error(`VM created, but ${host.name} cannot connect: ${cause}. Check its address and SSH credentials, then retry host connection.`);
      await wait(Math.min(5_000, connectionTimeoutMs - (now() - started)));
    }
    log(`Host connected: ${host.name}.`);
  }
  phase('post_deploy');
  const result = await postDeploy(sync.servers);
  if (result.failed) throw new Error('Post-deploy playbook failed. Review its job log and retry deployment completion.');
  phase('ready');
  return hosts;
}
module.exports = { completeDeployment };
