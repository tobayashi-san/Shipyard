'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_opentofu_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-opentofu-core';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const opentofuFeature = require('../features/opentofu');

const {
  extractManagedServersFromState,
  reconcileManagedServers,
  cleanupManagedServersForWorkspace,
  waitForManagedServers,
  detectTerraformResources,
  generateShipyardOutputsBlock,
  upsertManagedShipyardOutputs,
  applyFleetProxmoxBlueprintMetadata,
  extractProxmoxGuestIpv4,
  pruneWorkspaceRuns,
  moveWorkspaceDirectory,
  destroyConfirmationPhrase,
  hasValidDestroyConfirmation,
  destroyVmConfirmationPhrase,
  hasValidDestroyVmConfirmation,
  normalizePostDeployPlaybooks,
  normalizeProxmoxVmTemplate,
  normalizedWorkspaceName,
  terraformConfigurationHash,
  summarizePlanJson,
  redactTofuOutput,
  createStreamingRedactor,
} = opentofuFeature._test;

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('destroy requires a workspace-specific confirmation phrase', () => {
  const phrase = destroyConfirmationPhrase('production');
  assert.equal(phrase, 'DESTROY production');
  assert.equal(hasValidDestroyConfirmation(phrase, 'production'), true);
  assert.equal(hasValidDestroyConfirmation('production', 'production'), false);
  assert.equal(hasValidDestroyConfirmation('DESTROY staging', 'production'), false);
  assert.equal(hasValidDestroyConfirmation(null, 'production'), false);
});

test('targeted VM destroy requires a workspace and VM-specific confirmation phrase', () => {
  const phrase = destroyVmConfirmationPhrase('production', 'web-01');
  assert.equal(phrase, 'DESTROY production/web-01');
  assert.equal(hasValidDestroyVmConfirmation(phrase, 'production', 'web-01'), true);
  assert.equal(hasValidDestroyVmConfirmation('DESTROY production', 'production', 'web-01'), false);
  assert.equal(hasValidDestroyVmConfirmation('DESTROY production/db-01', 'production', 'web-01'), false);
});

test('workspace names are safe for the Git workspace and plans are summarized', () => {
  assert.equal(normalizedWorkspaceName('prod-app_01'), 'prod-app_01');
  assert.throws(() => normalizedWorkspaceName('../../escape'), /deployment name/i);
  assert.throws(() => normalizedWorkspaceName('bad/name'), /deployment name/i);
  assert.deepEqual(summarizePlanJson({ resource_changes: [
    { change: { actions: ['create'] } },
    { change: { actions: ['update'] } },
    { change: { actions: ['delete'] } },
    { change: { actions: ['delete', 'create'] } },
  ] }), { create: 1, update: 1, delete: 1, replace: 1, no_op: 0, read: 0 });
});

test('configuration hash changes with Terraform files and variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tofu-hash-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "x" "a" {}\n');
    const first = terraformConfigurationHash(dir, { TF_VAR_token: 'one' });
    const same = terraformConfigurationHash(dir, { TF_VAR_token: 'one', PATH: '/ignored' });
    const changed = terraformConfigurationHash(dir, { TF_VAR_token: 'two' });
    assert.equal(first, same);
    assert.notEqual(first, changed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenTofu output redacts workspace variable values before persistence', () => {
  assert.equal(
    redactTofuOutput('provider failed with super-secret-token', { TF_VAR_token: 'super-secret-token' }),
    'provider failed with ********'
  );
  const chunks = [];
  const stream = createStreamingRedactor({ TF_VAR_token: 'super-secret-token' }, chunk => chunks.push(chunk));
  stream.write('provider: super-sec');
  stream.write('ret-token failed');
  stream.flush();
  assert.equal(chunks.join(''), 'provider: ******** failed');
});

test('post-deploy playbook selections are normalized and path-safe', () => {
  assert.deepEqual(
    normalizePostDeployPlaybooks(['docker-install.yml', 'system/agent/agent-update.yml', 'docker-install.yml']),
    ['docker-install.yml', 'system/agent/agent-update.yml']
  );
  assert.throws(() => normalizePostDeployPlaybooks(['../../escape.yml']), /Invalid playbook name/);
  assert.throws(() => normalizePostDeployPlaybooks('docker-install.yml'), /provided as a list/);
});

test('VM templates preserve a validated post-deploy order', () => {
  const template = normalizeProxmoxVmTemplate({
    name: 'Ubuntu App Server',
    config: {
      name: 'app-01', node_name: 'pve001', disk_datastore: 'local-lvm',
      post_deploy_playbooks: ['system/update.yml', 'docker/install.yml'],
    },
  });
  assert.equal(template.name, 'Ubuntu App Server');
  assert.deepEqual(template.config.post_deploy_playbooks, ['system/update.yml', 'docker/install.yml']);
  assert.throws(() => normalizeProxmoxVmTemplate({ name: 'Bad', config: null }), /valid configuration/);
});

test('extractManagedServersFromState prefers explicit shipyard outputs', () => {
  const state = {
    values: {
      outputs: {
        shipyard_servers: {
          value: {
            web: { name: 'web-1', ip_address: '10.0.0.10', ssh_user: 'ubuntu', tags: ['web'] },
            db: '10.0.0.11',
          },
        },
      },
    },
  };

  const result = extractManagedServersFromState(state, 'lab-a');
  assert.equal(result.authoritative, true);
  assert.equal(result.source, 'outputs');
  assert.equal(result.servers.length, 2);

  const web = result.servers.find(server => server.name === 'web-1');
  const dbNode = result.servers.find(server => server.name === 'db');

  assert.equal(web.ip_address, '10.0.0.10');
  assert.equal(web.ssh_user, 'ubuntu');
  assert.ok(web.tags.includes('opentofu'));
  assert.ok(web.tags.includes('opentofu:lab-a'));

  assert.equal(dbNode.ip_address, '10.0.0.11');
  assert.equal(dbNode.ssh_port, 22);
});

test('extractManagedServersFromState falls back to VM-like resources in state', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          {
            address: 'proxmox_virtual_environment_vm.web',
            type: 'proxmox_virtual_environment_vm',
            values: {
              name: 'web-1',
              ipv4_addresses: [['192.168.50.10']],
              ssh_user: 'debian',
              ssh_port: 2222,
              tags: ['edge'],
            },
          },
        ],
      },
    },
  };

  const result = extractManagedServersFromState(state, 'lab-b');
  assert.equal(result.authoritative, false);
  assert.equal(result.source, 'state');
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].resource_key, 'resource:proxmox_virtual_environment_vm.web');
  assert.equal(result.servers[0].ip_address, '192.168.50.10');
  assert.equal(result.servers[0].ssh_user, 'debian');
  assert.equal(result.servers[0].ssh_port, 2222);
});

test('extractManagedServersFromState ignores Proxmox loopback addresses and DHCP markers', () => {
  const state = {
    values: { root_module: { resources: [{
      address: 'proxmox_virtual_environment_vm.dhcp',
      type: 'proxmox_virtual_environment_vm',
      values: {
        name: 'dhcp-node',
        ipv4_address: 'dhcp',
        ipv4_addresses: [['127.0.0.1', '10.10.1.101']],
      },
    }] } },
  };
  const result = extractManagedServersFromState(state, 'lab-dhcp');
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].ip_address, '10.10.1.101');
});

test('waitForManagedServers retries until DHCP-style IP appears in state', async () => {
  let calls = 0;
  const result = await waitForManagedServers({
    workspaceName: 'lab-dhcp',
    maxWaitMs: 100,
    retryMs: 1,
    sleepFn: async () => {},
    loadState: async () => {
      calls++;
      if (calls < 3) {
        return {
          values: {
            root_module: {
              resources: [{
                address: 'proxmox_virtual_environment_vm.dhcp',
                type: 'proxmox_virtual_environment_vm',
                values: { name: 'dhcp-node' },
              }],
            },
          },
        };
      }
      return {
        values: {
          root_module: {
            resources: [{
              address: 'proxmox_virtual_environment_vm.dhcp',
              type: 'proxmox_virtual_environment_vm',
              values: {
                name: 'dhcp-node',
                network: [{ ip: '192.168.77.25/24' }],
              },
            }],
          },
        },
      };
    },
  });

  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].ip_address, '192.168.77.25');
  assert.equal(result.attempts, 3);
  assert.equal(result.timedOut, false);
});

test('generateShipyardOutputsBlock builds a managed output for supported VM resources', () => {
  const resources = detectTerraformResources([{
    name: 'main.tf',
    content: `
      resource "proxmox_virtual_environment_vm" "ubuntu_cloud_vm" {}
      resource "local_file" "inventory" {}
    `,
  }]);

  const block = generateShipyardOutputsBlock(resources);
  assert.match(block, /output "shipyard_servers"/);
  assert.match(block, /"ubuntu_cloud_vm" = \{/);
  assert.match(block, /flatten\(proxmox_virtual_environment_vm\.ubuntu_cloud_vm\.ipv4_addresses\)/);
  assert.match(block, /!startswith\(ip, "127\."\)/);
  assert.match(block, /tags\s+= \["proxmox"\]/);
});

test('Fleet Proxmox blueprints use the selected guest user and guest-agent DHCP address', () => {
  const state = {
    values: { root_module: { resources: [{
      address: 'proxmox_virtual_environment_vm.app',
      type: 'proxmox_virtual_environment_vm',
      values: { name: 'app', node_name: 'pve001', vm_id: 123, ipv4_addresses: [['10.10.10.99']] },
    }] } },
  };
  const result = applyFleetProxmoxBlueprintMetadata({
    state,
    servers: [{ resource_key: 'resource:proxmox_virtual_environment_vm.app', name: 'app', hostname: 'app', ip_address: '10.10.10.99', ssh_user: 'root' }],
    vms: [{ name: 'app', username: 'ubuntu', ipv4_address: 'dhcp', node_name: 'pve001', vm_id: 123 }],
    guestIps: new Map([['resource:proxmox_virtual_environment_vm.app', '10.10.10.24']]),
  });
  assert.equal(result.servers[0].ssh_user, 'ubuntu');
  assert.equal(result.servers[0].ip_address, '10.10.10.24');
  assert.deepEqual(result.pendingDhcpResourceKeys, []);
});

test('extractProxmoxGuestIpv4 ignores loopback and link-local addresses', () => {
  assert.equal(extractProxmoxGuestIpv4({ result: [
    { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] },
    { name: 'ens18', 'ip-addresses': [
      { 'ip-address-type': 'ipv4', 'ip-address': '169.254.3.4' },
      { 'ip-address-type': 'ipv4', 'ip-address': '10.20.30.40' },
    ] },
  ] }), '10.20.30.40');
});

test('upsertManagedShipyardOutputs replaces only the managed section', () => {
  const first = upsertManagedShipyardOutputs(
    '# custom output\noutput "foo" { value = 1 }\n',
    '# BEGIN SHIPYARD MANAGED OUTPUT\noutput "shipyard_servers" { value = {} }\n# END SHIPYARD MANAGED OUTPUT\n'
  );
  assert.match(first, /output "foo"/);
  assert.equal((first.match(/BEGIN SHIPYARD MANAGED OUTPUT/g) || []).length, 1);

  const second = upsertManagedShipyardOutputs(
    first,
    '# BEGIN SHIPYARD MANAGED OUTPUT\noutput "shipyard_servers" { value = { "vm" = {} } }\n# END SHIPYARD MANAGED OUTPUT\n'
  );
  assert.match(second, /"vm" = \{\}/);
  assert.equal((second.match(/BEGIN SHIPYARD MANAGED OUTPUT/g) || []).length, 1);
  assert.match(second, /output "foo"/);
});

test('pruneWorkspaceRuns keeps only the newest run entries for a workspace', () => {
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_runs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      output       TEXT NOT NULL DEFAULT '',
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `).run();

  for (let i = 1; i <= 5; i++) {
    db.db.prepare(`
      INSERT INTO tofu_runs (id, workspace_id, action, status, output, started_at)
      VALUES (?, 'ws-prune', 'apply', 'success', '', ?)
    `).run(`run-${i}`, `2026-03-2${i} 10:00:00`);
  }

  pruneWorkspaceRuns(db, 'ws-prune', 3);

  const remaining = db.db.prepare(`
    SELECT id FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC
  `).all('ws-prune').map(row => row.id);

  assert.deepEqual(remaining, ['run-5', 'run-4', 'run-3']);
});

test('moveWorkspaceDirectory moves an existing workspace without losing files', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tofu-move-'));
  const sourceDir = path.join(baseDir, 'old');
  const targetDir = path.join(baseDir, 'new');
  fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'main.tf'), 'resource "x" "y" {}', 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'nested', 'outputs.tf'), 'output "z" { value = 1 }', 'utf8');

  const moved = moveWorkspaceDirectory(sourceDir, targetDir);

  assert.equal(moved, true);
  assert.equal(fs.existsSync(sourceDir), false);
  assert.equal(fs.readFileSync(path.join(targetDir, 'main.tf'), 'utf8'), 'resource "x" "y" {}');
  assert.equal(fs.readFileSync(path.join(targetDir, 'nested', 'outputs.tf'), 'utf8'), 'output "z" { value = 1 }');

  fs.rmSync(baseDir, { recursive: true, force: true });
});

test('reconcileManagedServers creates, updates and detaches deployment-managed servers without deleting inventory', async () => {
  const workspace = { id: 'ws-managed', name: 'lab-managed' };
  const desired = [{
    resource_key: 'output:shipyard_servers:web-1',
    name: 'web-1',
    hostname: 'web-1.local',
    ip_address: '10.10.10.10',
    ssh_user: 'ubuntu',
    ssh_port: 22,
    tags: ['role:web'],
    services: ['nginx'],
  }];

  const created = await reconcileManagedServers({ db, workspace, desiredServers: desired });
  assert.deepEqual(created, { created: 1, updated: 0, detached: 0 });

  const mapping = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').get(workspace.id);
  assert.ok(mapping);
  assert.equal(mapping.created_by_plugin, 1);

  const firstServer = db.servers.getById(mapping.server_id);
  assert.equal(firstServer.name, 'web-1');
  assert.equal(firstServer.ip_address, '10.10.10.10');

  const updated = await reconcileManagedServers({
    db,
    workspace,
    desiredServers: [{
      ...desired[0],
      ip_address: '10.10.10.42',
      ssh_port: 2222,
      tags: ['role:web', 'prod'],
    }],
  });
  assert.deepEqual(updated, { created: 0, updated: 1, detached: 0 });

  const updatedServer = db.servers.getById(mapping.server_id);
  assert.equal(updatedServer.ip_address, '10.10.10.42');
  assert.equal(updatedServer.ssh_port, 2222);
  assert.ok(JSON.parse(updatedServer.tags).includes('prod'));
  assert.ok(JSON.parse(updatedServer.tags).includes('opentofu:lab-managed'));

  const cleaned = cleanupManagedServersForWorkspace({ db, workspace });
  assert.deepEqual(cleaned, { detached: 1 });
  assert.ok(db.servers.getById(mapping.server_id));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM tofu_managed_servers WHERE workspace_id = ?').get(workspace.id).c, 0);
});

test('cleanupManagedServersForWorkspace keeps reused manual servers', async () => {
  const workspace = { id: 'ws-reused', name: 'lab-reused' };
  const manual = db.servers.create({
    name: 'manual-node',
    hostname: 'manual-node.local',
    ip_address: '10.20.30.40',
    ssh_port: 22,
    ssh_user: 'root',
    tags: ['manual'],
    services: [],
  });

  const result = await reconcileManagedServers({
    db,
    workspace,
    desiredServers: [{
      resource_key: 'output:shipyard_servers:manual-node',
      name: 'manual-node',
      hostname: 'manual-node.local',
      ip_address: '10.20.30.40',
      ssh_user: 'root',
      ssh_port: 22,
      tags: ['managed-by-tofu'],
      services: [],
    }],
  });

  assert.deepEqual(result, { created: 0, updated: 1, detached: 0 });

  const mapping = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').get(workspace.id);
  assert.ok(mapping);
  assert.equal(mapping.server_id, manual.id);
  assert.equal(mapping.created_by_plugin, 0);

  const cleaned = cleanupManagedServersForWorkspace({ db, workspace });
  assert.deepEqual(cleaned, { detached: 1 });
  assert.ok(db.servers.getById(manual.id));
});
