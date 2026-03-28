'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_opentofu_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-opentofu-plugin';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const opentofuPlugin = require('../../plugins/opentofu/index.js');

const {
  extractManagedServersFromState,
  reconcileManagedServers,
  cleanupManagedServersForWorkspace,
  waitForManagedServers,
  detectTerraformResources,
  generateShipyardOutputsBlock,
  upsertManagedShipyardOutputs,
} = opentofuPlugin._test;

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
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
  assert.match(block, /proxmox_virtual_environment_vm\.ubuntu_cloud_vm\.ipv4_addresses\[1\]\[0\]/);
  assert.match(block, /tags\s+= \["proxmox"\]/);
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

test('reconcileManagedServers creates, updates and cleans up plugin-managed servers', async () => {
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
  assert.deepEqual(created, { created: 1, updated: 0, deleted: 0, untracked: 0 });

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
  assert.deepEqual(updated, { created: 0, updated: 1, deleted: 0, untracked: 0 });

  const updatedServer = db.servers.getById(mapping.server_id);
  assert.equal(updatedServer.ip_address, '10.10.10.42');
  assert.equal(updatedServer.ssh_port, 2222);
  assert.ok(JSON.parse(updatedServer.tags).includes('prod'));
  assert.ok(JSON.parse(updatedServer.tags).includes('opentofu:lab-managed'));

  const cleaned = cleanupManagedServersForWorkspace({ db, workspace });
  assert.deepEqual(cleaned, { deleted: 1, untracked: 0 });
  assert.equal(db.servers.getById(mapping.server_id), undefined);
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

  assert.deepEqual(result, { created: 0, updated: 1, deleted: 0, untracked: 0 });

  const mapping = db.db.prepare('SELECT * FROM tofu_managed_servers WHERE workspace_id = ?').get(workspace.id);
  assert.ok(mapping);
  assert.equal(mapping.server_id, manual.id);
  assert.equal(mapping.created_by_plugin, 0);

  const cleaned = cleanupManagedServersForWorkspace({ db, workspace });
  assert.deepEqual(cleaned, { deleted: 0, untracked: 1 });
  assert.ok(db.servers.getById(manual.id));
});
