'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_opentofu_platform_actions_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-opentofu-platform-actions';
process.env.SHIPYARD_KEY_SECRET = 'test-key-secret-opentofu-platform-actions';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const https = require('https');
const bcrypt = require('bcryptjs');
const db = require('../db');
const cryptoUtil = require('../utils/crypto');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const opentofu = require('../features/opentofu');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
const openTofuRouter = express.Router();
opentofu.register({ router: openTofuRouter, db, broadcast: () => {} });
app.use('/api/opentofu', openTofuRouter);
const scheduler = require('../services/scheduler');

const calls = [];
let storageInventory = [{ storage: 'local-zfs', type: 'zfspool', active: 1, used: 219902325555, total: 1979120929996, avail: 1759218604441 }];
const originalRequest = https.request;
let inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];
let lxcInterfacesAvailable = true;
let beforeInventoryResponse = null;
let storageHttpStatus = 200;
let networkHttpStatus = 200;
let networkInventory = [];
let taskStatusResponse = {status:'running'};
let taskResponse = 'UPID:mock:task';
let recoveryPoints = [];

function installProxmoxMock() {
  https.request = (url, options, callback) => {
    const requestStream = new EventEmitter();
    let body = '';
    requestStream.setTimeout = () => requestStream;
    requestStream.destroy = error => { if (error) requestStream.emit('error', error); };
    requestStream.write = chunk => { body += String(chunk); };
    requestStream.end = () => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/cluster/resources') && beforeInventoryResponse) {
        const hook = beforeInventoryResponse; beforeInventoryResponse = null; hook();
      }
      calls.push({ path: parsed.pathname, search: parsed.search, method: options.method, body, authorization: options.headers.Authorization });
      const response = new EventEmitter();
      response.statusCode = parsed.pathname.endsWith('/storage') ? storageHttpStatus : parsed.pathname.endsWith('/network') ? networkHttpStatus : 200;
      response.setEncoding = () => {};
      callback(response);
      const data = parsed.pathname.includes('/tasks/') && parsed.pathname.endsWith('/status') ? taskStatusResponse
        : parsed.pathname.endsWith('/version') ? { version: '8.4.2' }
        : parsed.pathname.endsWith('/access/permissions') ? { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 }, '/vms/101': { 'VM.PowerMgmt': 1 } }
        : parsed.pathname.endsWith('/snapshot') && options.method === 'GET' ? recoveryPoints
        : parsed.pathname.endsWith('/cluster/resources') ? inventory
        : parsed.pathname.endsWith('/nodes') ? [{ node: 'pve001', status: 'online' }]
        : parsed.pathname.endsWith('/nodes/pve001/storage') ? storageInventory
        : parsed.pathname.endsWith('/nodes/pve001/network') ? networkInventory
        : parsed.pathname.endsWith('/nodes/pve001/apt/update') && options.method === 'GET' ? [{
          Package: 'pve-manager', Title: 'Proxmox VE Manager', Description: 'The Proxmox VE management stack',
          Origin: 'Proxmox', OldVersion: '8.4.1', Version: '8.4.2', Priority: 'optional', Section: 'admin', Arch: 'amd64',
        }]
        : parsed.pathname.endsWith('/nodes/pve001/qemu/101/config') ? {
          cores: 2, sockets: 1, memory: 4096, ostype: 'l26', agent: 'enabled=1',
          scsi0: 'NVME_VM_Store:vm-101-disk-0,size=40G,discard=on',
          net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=2010,firewall=1',
          ipconfig0: 'ip=10.20.1.42/24,gw=10.20.1.1', ciuser: 'ubuntu',
          cipassword: 'must-never-leave-proxmox',
        }
        : parsed.pathname.endsWith('/nodes/pve001/lxc/202/config') ? {
          cores: 1, memory: 1024, ostype: 'debian', arch: 'amd64', unprivileged: 1, swap: 0, cpulimit: '1.5',
          rootfs: 'local-zfs:subvol-202-disk-0,size=8G',
          net0: 'name=eth0,bridge=vmbr0,hwaddr=02:00:00:00:02:02,ip=10.20.1.52/24,gw=10.20.1.1,type=veth,tag=20',
        }
        : parsed.pathname.endsWith('/nodes/pve001/lxc/202/interfaces') && lxcInterfacesAvailable ? [
          { name: 'lo', inet: '127.0.0.1/8' },
          { name: 'eth0', inet: '10.20.1.52/24', hwaddr: '02:00:00:00:02:02' },
        ]
        : parsed.pathname.endsWith('/nodes/pve001/lxc/202/interfaces') ? []
        : parsed.pathname.endsWith('/agent/network-get-interfaces') ? {
          result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }, { name: 'ens18', 'hardware-address': 'AA:BB:CC:DD:EE:FF', 'ip-addresses': [{ 'ip-address': '10.20.1.42', 'ip-address-type': 'ipv4' }] }],
        }
        : taskResponse;
      process.nextTick(() => {
        response.emit('data', JSON.stringify({ data }));
        response.emit('end');
      });
    };
    return requestStream;
  };
}

let token;
let noDeploymentAccessToken;
let readOnlyPlatformToken;
const connectionId = 'connection-platform-actions';
const vmPath = `/api/opentofu/proxmox-connections/${connectionId}/vms/pve001/101`;

before(async () => {
  installProxmoxMock();
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  const restrictedRole = db.roles.create('Platform operator without deployment access', {
    servers: 'all',
    canViewServers: true,
    canEditServers: true,
    canRebootServers: true,
  });
  db.users.create('no-plugin', '', await bcrypt.hash('testpass12345', 4), restrictedRole.id, 'No plugin');
  const restrictedLogin = await request(app).post('/api/auth/login').send({ username: 'no-plugin', password: 'testpass12345' });
  noDeploymentAccessToken = restrictedLogin.body.token;
  const readOnlyRole = db.roles.create('Read-only platform operator', {
    servers: 'all',
    canViewServers: true,
    canViewInfrastructure: true,
    canManageDeployments: true,
    canManageDeploymentPlatforms: false,
    canRunUpdates: false,
  });
  db.users.create('platform-reader', '', await bcrypt.hash('testpass12345', 4), readOnlyRole.id, 'Platform reader');
  const readOnlyLogin = await request(app).post('/api/auth/login').send({ username: 'platform-reader', password: 'testpass12345' });
  readOnlyPlatformToken = readOnlyLogin.body.token;
  db.db.prepare(`
    INSERT INTO tofu_proxmox_connections (id, environment_id, name, endpoint, api_token, insecure, ssh_public_key)
    VALUES (?, 'default', 'Test Proxmox', 'https://pve.example.test:8006', ?, 1, '')
  `).run(connectionId, cryptoUtil.encrypt('root@pam!fleet=secret'));
});

after(() => {
  https.request = originalRequest;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('Proxmox power and snapshot routes resolve the current inventory target before invoking the API', async () => {
  calls.length = 0;
  inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];

  const power = await request(app).post(`${vmPath}/power`).set('Authorization', `Bearer ${token}`).send({ action: 'reboot' });
  assert.equal(power.status, 202, JSON.stringify(power.body));
  assert.equal(power.body.action, 'reboot');
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
    'GET /api2/json/cluster/resources?type=vm',
    'POST /api2/json/nodes/pve001/qemu/101/status/reboot',
  ]);
  assert.equal(calls[1].authorization, 'PVEAPIToken=root@pam!fleet=secret');

  calls.length = 0;
  const create = await request(app).post(`${vmPath}/snapshots`).set('Authorization', `Bearer ${token}`).send({ name: 'before-update', description: 'Safe checkpoint' });
  assert.equal(create.status, 202);
  assert.match(calls[1].body, /snapname=before-update/);
  assert.match(calls[1].body, /vmstate=1/);
  assert.match(calls[1].body, /description=Safe\+checkpoint/);

  calls.length = 0;
  const remove = await request(app).delete(`${vmPath}/snapshots/before-update`).set('Authorization', `Bearer ${token}`);
  assert.equal(remove.status, 202);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
    'GET /api2/json/cluster/resources?type=vm',
    'DELETE /api2/json/nodes/pve001/qemu/101/snapshot/before-update',
  ]);
});

test('LXC guests use container API paths for configuration, snapshots, power and adoption', async () => {
  calls.length = 0;
  inventory = [{ type: 'lxc', node: 'pve001', vmid: 202, name: 'web-ct' }];
  const ctPath = `/api/opentofu/proxmox-connections/${connectionId}/vms/pve001/202`;

  const configuration = await request(app).get(`${ctPath}/configuration`).set('Authorization', `Bearer ${token}`);
  assert.equal(configuration.status, 200, JSON.stringify(configuration.body));
  assert.equal(configuration.body.guest_type, 'lxc');
  assert.equal(configuration.body.hardware.agent_enabled, null);
  assert.deepEqual(configuration.body.container, { architecture: 'amd64', unprivileged: true, swap_mb: 0, cpu_limit: 1.5 });
  assert.deepEqual(configuration.body.disks, [{ bus: 'rootfs', storage: 'local-zfs:subvol-202-disk-0', size: '8G', format: null, discard: false }]);
  assert.deepEqual(configuration.body.networks, [{ interface: 'net0', model: 'veth', bridge: 'vmbr0', vlan_id: '20', mac_address: '02:00:00:00:02:02', firewall: false }]);

  calls.length = 0;
  const power = await request(app).post(`${ctPath}/power`).set('Authorization', `Bearer ${token}`).send({ action: 'reboot' });
  assert.equal(power.status, 202, JSON.stringify(power.body));
  assert.ok(calls.some(call => call.path.endsWith('/nodes/pve001/lxc/202/status/reboot')));

  calls.length = 0;
  const snapshot = await request(app).post(`${ctPath}/snapshots`).set('Authorization', `Bearer ${token}`).send({ name: 'before-update' });
  assert.equal(snapshot.status, 202, JSON.stringify(snapshot.body));
  assert.ok(calls.some(call => call.path.endsWith('/nodes/pve001/lxc/202/snapshot')));
  assert.doesNotMatch(calls.at(-1).body, /vmstate=/);

  calls.length = 0;
  const imported = await request(app)
    .post(`/api/opentofu/proxmox-connections/${connectionId}/import-vm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'fleet-web-ct', node_name: 'pve001', vm_id: 202, ssh_user: 'root' });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.server.ip_address, '10.20.1.52');
  assert.ok(calls.some(call => call.path.endsWith('/nodes/pve001/lxc/202/interfaces')));
  const mapping = db.db.prepare('SELECT guest_type FROM proxmox_inventory_servers WHERE server_id = ?').get(imported.body.server.id);
  assert.equal(mapping.guest_type, 'lxc');

  calls.length = 0;
  lxcInterfacesAvailable = false;
  const stoppedIp = await request(app)
    .get(`/api/opentofu/proxmox-connections/${connectionId}/guest-ip?node=pve001&vm_id=202`)
    .set('Authorization', `Bearer ${token}`);
  lxcInterfacesAvailable = true;
  assert.equal(stoppedIp.status, 200, JSON.stringify(stoppedIp.body));
  assert.equal(stoppedIp.body.ip_address, '10.20.1.52');
  assert.ok(calls.some(call => call.path.endsWith('/nodes/pve001/lxc/202/config')));
});

test('infrastructure inventory includes QEMU VMs and LXC containers with their guest type', async () => {
  inventory = [
    { type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01', status: 'running', disk: 0, maxdisk: 32 * 1024 ** 3 },
    { type: 'lxc', node: 'pve001', vmid: 202, name: 'web-ct', status: 'running', disk: 0, maxdisk: 8 * 1024 ** 3 },
  ];
  const response = await request(app)
    .get('/api/opentofu/infrastructure?environment_id=default')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const guests = response.body.clusters[0].vms;
  assert.deepEqual(guests.map(guest => [guest.vm_id, guest.guest_type]), [[101, 'qemu'], [202, 'lxc']]);
  assert.equal(guests[0].disk, null, 'an unreported QEMU disk must not be presented as measured 0%');
  assert.equal(guests[1].disk, 0, 'host-observable LXC disk usage may be a measured zero');
});

test('infrastructure summary persists a fast object overview and serves it without detail calls', async () => {
  inventory = [
    { type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01', status: 'running', cpu: 0.5, maxmem: 4096, disk: 0, maxdisk: 32 * 1024 ** 3 },
    { type: 'lxc', node: 'pve001', vmid: 202, name: 'web-ct', status: 'stopped', mem: 1024 },
  ];
  calls.length = 0;
  const initial = await request(app)
    .get('/api/opentofu/infrastructure-summary?environment_id=default')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.cached, false);
  assert.equal(initial.body.refreshing, false);
  assert.deepEqual(initial.body.clusters[0].vms.map(vm => vm.name), ['app-01', 'web-ct']);
  assert.equal('cpu' in initial.body.clusters[0].nodes[0], true);
  assert.equal(initial.body.clusters[0].vms[0].maxmem, 4096);
  assert.equal(initial.body.clusters[0].vms[0].disk, null);
  assert.equal(initial.body.clusters[0].datastores[0].id, 'local-zfs');
  assert.equal(initial.body.clusters[0].datastores[0].total, 1979120929996);
  assert.deepEqual(calls.map(call => call.path).sort(), [
    '/api2/json/cluster/resources',
    '/api2/json/nodes',
    '/api2/json/nodes/pve001/storage',
  ], 'summary refreshes load atomic storage totals without network, package or VM detail calls');

  calls.length = 0;
  const cached = await request(app)
    .get('/api/opentofu/infrastructure-summary?environment_id=default')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(cached.status, 200, JSON.stringify(cached.body));
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.refreshing, false);
  assert.equal(calls.length, 0, 'a fresh snapshot must not wait for or call Proxmox');

  db.db.prepare('UPDATE tofu_proxmox_connections SET name = ? WHERE id = ?')
    .run('Renamed Proxmox source', connectionId);
  const changed = await request(app)
    .get('/api/opentofu/infrastructure-summary?environment_id=default')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.cached, false, 'a changed source must refresh before responding');
  assert.equal(changed.body.refreshing, false);
  assert.deepEqual(changed.body.clusters[0].connections.map(connection => connection.name), ['Renamed Proxmox source']);
  assert.deepEqual(calls.map(call => call.path).sort(), [
    '/api2/json/cluster/resources',
    '/api2/json/nodes',
    '/api2/json/nodes/pve001/storage',
  ]);
});

test('Proxmox actions reject invalid or stale targets before an action endpoint is reached', async () => {
  calls.length = 0;
  const invalid = await request(app).post(`${vmPath}/power`).set('Authorization', `Bearer ${token}`).send({ action: 'format-all' });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 0);

  const invalidSnapshot = await request(app).post(`${vmPath}/snapshots`).set('Authorization', `Bearer ${token}`).send({ name: '../unsafe' });
  assert.equal(invalidSnapshot.status, 400);
  assert.equal(calls.length, 0);

  inventory = [];
  const stale = await request(app).post(`${vmPath}/power`).set('Authorization', `Bearer ${token}`).send({ action: 'stop' });
  assert.equal(stale.status, 404);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), ['GET /api2/json/cluster/resources?type=vm']);
  inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];
});

test('Proxmox update routes list packages and refresh the package catalog', async () => {
  calls.length = 0;
  const updatesPath = `/api/opentofu/proxmox-connections/${connectionId}/nodes/pve001/updates`;

  const listed = await request(app).get(updatesPath).set('Authorization', `Bearer ${token}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.node_name, 'pve001');
  assert.equal(listed.body.updates[0].Package, 'pve-manager');

  const refreshed = await request(app).post(`${updatesPath}/refresh`).set('Authorization', `Bearer ${token}`);
  assert.equal(refreshed.status, 202);
  assert.equal(refreshed.body.status, 'started');
  assert.equal(refreshed.body.task_id, 'UPID:mock:task');
  const event = db.db.prepare("SELECT * FROM audit_log WHERE action = 'infrastructure.proxmox_update_catalog' ORDER BY id DESC LIMIT 1").get();
  assert.ok(event.detail.includes(`source_id=${JSON.stringify(connectionId)}`));
  assert.ok(event.detail.includes('node="pve001"'));

  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    'GET /api2/json/nodes',
    'GET /api2/json/nodes/pve001/apt/update',
    'GET /api2/json/nodes',
    'POST /api2/json/nodes/pve001/apt/update',
  ]);
});

test('Proxmox package catalog refresh requires update permission', async () => {
  calls.length = 0;
  const updatesPath = `/api/opentofu/proxmox-connections/${connectionId}/nodes/pve001/updates`;
  const listed = await request(app).get(updatesPath).set('Authorization', `Bearer ${readOnlyPlatformToken}`);
  assert.equal(listed.status, 200);

  calls.length = 0;
  const denied = await request(app).post(`${updatesPath}/refresh`).set('Authorization', `Bearer ${readOnlyPlatformToken}`);
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0);
});

test('OpenTofu platform APIs cannot be reached without infrastructure access', async () => {
  calls.length = 0;
  const denied = await request(app).post(`${vmPath}/power`).set('Authorization', `Bearer ${noDeploymentAccessToken}`).send({ action: 'reboot' });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /OpenTofu access/);
  assert.equal(calls.length, 0);
});

test('VM configuration projects hardware and network facts without leaking cloud-init secrets', async () => {
  calls.length = 0;
  inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];
  const response = await request(app).get(`${vmPath}/configuration`).set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.container, undefined);
  assert.deepEqual(response.body.hardware, {
    sockets: 1, cores: 2, memory_mb: 4096, os_type: 'l26', bios: null,
    machine: null, scsi_controller: null, agent_enabled: true, boot_order: null,
  });
  assert.deepEqual(response.body.disks, [{ bus: 'scsi0', storage: 'NVME_VM_Store:vm-101-disk-0', size: '40G', format: null, discard: true }]);
  assert.deepEqual(response.body.networks, [{ interface: 'net0', model: 'virtio=AA:BB:CC:DD:EE:FF', bridge: 'vmbr0', vlan_id: '2010', mac_address: 'AA:BB:CC:DD:EE:FF', firewall: true }]);
  assert.deepEqual(response.body.guest, { username: 'ubuntu', ip_config: [{ interface: 'net0', ipv4: '10.20.1.42/24', gateway: '10.20.1.1' }] });
  assert.equal(JSON.stringify(response.body).includes('must-never-leave-proxmox'), false);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
    'GET /api2/json/cluster/resources?type=vm',
    'GET /api2/json/nodes/pve001/qemu/101/config',
  ]);
});

test('inventory import reads the guest agent address, preserves SSH metadata and rejects duplicate adoption', async () => {
  calls.length = 0;
  inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];
  const imported = await request(app)
    .post(`/api/opentofu/proxmox-connections/${connectionId}/import-vm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'fleet-app-01', node_name: 'pve001', vm_id: 101, ssh_user: 'ubuntu', ssh_port: 2222 });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.server.ip_address, '10.20.1.42');
  assert.equal(imported.body.server.ssh_user, 'ubuntu');
  assert.equal(imported.body.server.ssh_port, 2222);
  assert.ok(calls.some(call => call.path.endsWith('/nodes/pve001/qemu/101/agent/network-get-interfaces')));
  const map = db.db.prepare('SELECT * FROM proxmox_inventory_servers WHERE server_id = ?').get(imported.body.server.id);
  assert.deepEqual({ connection: map.connection_id, node: map.node_name, vm: map.vm_id }, { connection: connectionId, node: 'pve001', vm: 101 });

  const duplicate = await request(app)
    .post(`/api/opentofu/proxmox-connections/${connectionId}/import-vm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'fleet-app-01', node_name: 'pve001', vm_id: 101, ip_address: '10.20.1.42' });
  assert.equal(duplicate.status, 409);
});

test('Proxmox IPAM synchronization stores guest interface MAC addresses', async () => {
  const subnetId = 'platform-actions-ipam-prefix';
  db.db.prepare("INSERT OR IGNORE INTO ipam_subnets (id, environment_id, name, cidr) VALUES (?, 'default', 'Proxmox guests', '10.20.1.0/24')")
    .run(subnetId);
  inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];
  const sync = await request(app)
    .post(`/api/opentofu/proxmox-connections/${connectionId}/sync-ipam`)
    .set('Authorization', `Bearer ${token}`)
    .send({ subnet_id: subnetId });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.created, 1);
  const reservation = db.db.prepare('SELECT address, mac_address, source_type FROM ipam_reservations WHERE subnet_id = ?').get(subnetId);
  assert.deepEqual(reservation, {
    address: '10.20.1.42', mac_address: 'aa:bb:cc:dd:ee:ff', source_type: 'proxmox',
  });
});

test('Proxmox IPAM synchronization without a prefix processes every environment prefix', async () => {
  const secondSubnetId = 'platform-actions-second-prefix';
  db.db.prepare("INSERT OR IGNORE INTO ipam_subnets (id, environment_id, name, cidr) VALUES (?, 'default', 'Other network', '10.30.1.0/24')")
    .run(secondSubnetId);
  const sync = await request(app)
    .post(`/api/opentofu/proxmox-connections/${connectionId}/sync-ipam`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.prefixes, 2);
  assert.equal(sync.body.discovered, 1);
  const connection = db.db.prepare('SELECT last_ipam_status, last_ipam_synced_at FROM tofu_proxmox_connections WHERE id = ?').get(connectionId);
  assert.equal(connection.last_ipam_status, 'success');
  assert.ok(connection.last_ipam_synced_at);
});

test('scheduler never polls Proxmox inventory, including previously enabled connections', async () => {
  db.db.prepare("UPDATE tofu_proxmox_connections SET auto_sync_ipam = 1, sync_interval_min = 5, last_ipam_synced_at = NULL, last_ipam_status = '' WHERE id = ?")
    .run(connectionId);
  await scheduler.pollIpamSources();
  assert.equal(
    db.db.prepare('SELECT last_ipam_status FROM tofu_proxmox_connections WHERE id = ?').get(connectionId).last_ipam_status,
    '',
  );

  db.db.prepare("UPDATE tofu_proxmox_connections SET auto_sync_ipam = 0, last_ipam_synced_at = NULL, last_ipam_status = 'disabled' WHERE id = ?")
    .run(connectionId);
  await scheduler.pollIpamSources();
  assert.equal(
    db.db.prepare('SELECT last_ipam_status FROM tofu_proxmox_connections WHERE id = ?').get(connectionId).last_ipam_status,
    'disabled',
  );
});

test('connection writes reject invalid inputs without silently truncating or clamping stored values', async () => {
  const route = `/api/opentofu/proxmox-connections/${connectionId}`;
  const before = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(connectionId);
  for (const [field, value] of [
    ['name', 'x'.repeat(81)], ['name', '  '], ['name', {}],
    ['endpoint', []], ['endpoint', 'http://fixture.test'], ['endpoint', 'https://user:pass@fixture.test'], ['api_token', 123], ['ssh_public_key', true], ['ca_certificate', 'not a PEM certificate'],
    ['insecure', 'false'], ['auto_sync_ipam', 0],
    ...[null, false, '', '15minutes', '1e2', 4, 1441, 5.5].map(value => ['sync_interval_min', value]),
  ]) {
    const response = await request(app).put(route).set('Authorization', `Bearer ${token}`).send({ [field]: value });
    assert.equal(response.status, 400, `${field}=${JSON.stringify(value)}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.field, field);
    assert.deepEqual(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(connectionId), before);
  }
  const mismatch = await request(app).put(route).set('Authorization', `Bearer ${token}`).send({ environment_id: 'other', name: 'Wrong target' });
  assert.equal(mismatch.status, 409);
  assert.deepEqual(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(connectionId), before);
});

test('connection test checks authentication, inventory and reported permissions without saving the draft', async () => {
  calls.length = 0;
  const before = db.db.prepare('SELECT COUNT(*) AS n FROM tofu_proxmox_connections').get().n;
  const response = await request(app).post('/api/opentofu/proxmox-connections/test').set('Authorization', `Bearer ${token}`).send({
    environment_id: 'default', endpoint: 'https://verify.example.test:8006', api_token: 'shipyard@pve!automation=fixture', insecure: false,
    ca_certificate: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.authenticated, true);
  assert.equal(response.body.inventory_access, true);
  assert.equal(response.body.identity, 'shipyard@pve!automation');
  assert.equal(response.body.version, '8.4.2');
  assert.equal(response.body.node_count, 1);
  assert.deepEqual(response.body.recommended_missing, []);
  assert.ok(response.body.permissions.includes('VM.PowerMgmt'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM tofu_proxmox_connections').get().n, before);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('connection create/update preserves secrets and interval defaults with explicit valid boundaries', async () => {
  const route = '/api/opentofu/proxmox-connections';
  const caCertificate = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
  const body = { environment_id: 'default', name: 'Validation fixture', endpoint: 'https://validation.example.test:8006', api_token: 'shipyard@pve!automation=fixture', ca_certificate: caCertificate };
  const missingToken = await request(app).post(route).set('Authorization', `Bearer ${token}`).send({ ...body, api_token: '' });
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.body.field, 'api_token');
  const invalid = await request(app).post(route).set('Authorization', `Bearer ${token}`).send({ ...body, sync_interval_min: '15minutes' });
  assert.equal(invalid.status, 400);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM tofu_proxmox_connections WHERE name = ?').get(body.name).n, 0);
  const created = await request(app).post(route).set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal(created.body.sync_interval_min, 15);
  assert.equal(created.body.api_token, undefined);
  assert.equal(created.body.ca_certificate_configured, true);
  assert.equal(created.body.ca_certificate, undefined);
  assert.equal(cryptoUtil.decrypt(db.db.prepare('SELECT ca_certificate FROM tofu_proxmox_connections WHERE id = ?').get(id).ca_certificate), caCertificate);
  for (const interval of [5, '1440']) {
    const updated = await request(app).put(`${route}/${id}`).set('Authorization', `Bearer ${token}`).send({ sync_interval_min: interval, api_token: '', auto_sync_ipam: false });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.sync_interval_min, Number(interval));
    assert.equal(updated.body.auto_sync_ipam, false);
    assert.equal(cryptoUtil.decrypt(db.db.prepare('SELECT api_token FROM tofu_proxmox_connections WHERE id = ?').get(id).api_token), body.api_token);
  }
  const renamed = await request(app).put(`${route}/${id}`).set('Authorization', `Bearer ${token}`).send({ name: 'Renamed fixture' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.sync_interval_min, 1440);
  assert.equal(renamed.body.auto_sync_ipam, false);
  db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id = ?').run(id);
});

test('connection removal protects adopted hosts and permits only authorized removal of unused connections', async () => {
  const route = '/api/opentofu/proxmox-connections';
  const adopted = db.db.prepare('SELECT COUNT(*) AS n FROM proxmox_inventory_servers WHERE connection_id = ?').get(connectionId);
  assert.ok(adopted.n > 0, 'Fixture must contain an adopted host');
  const blocked = await request(app).delete(`${route}/${connectionId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /adopted host/);
  assert.ok(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(connectionId));
  const created = await request(app).post(route).set('Authorization', `Bearer ${token}`).send({environment_id:'default', name:'Removable fixture', endpoint:'https://remove.example.test', api_token:'fixture-token'});
  assert.equal(created.status, 201);
  const id = created.body.id;
  const denied = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${readOnlyPlatformToken}`);
  assert.equal(denied.status, 403);
  assert.ok(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(id));
  const callsBefore = calls.length;
  const removed = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(removed.status, 200);
  assert.equal(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(id), undefined);
  assert.equal(calls.length, callsBefore, 'Removal must not call Proxmox');
  const missing = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(missing.status, 404);
});

test('deployment dependency and removal audit are preserved atomically', async () => {
  const route = '/api/opentofu/proxmox-connections';
  const name = 'Connection with spaces "and quotes"';
  const created = await request(app).post(route).set('Authorization', `Bearer ${token}`).send({environment_id:'default',name,endpoint:'https://atomic.example.test',api_token:'fixture-token'});
  assert.equal(created.status, 201);
  const id = created.body.id;
  db.db.prepare('INSERT INTO tofu_workspaces (id, name, path, environment_id, proxmox_connection_id) VALUES (?, ?, ?, ?, ?)').run('dependency-fixture','Dependency fixture','/unused/fixture','default',id);
  const blocked = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /1 deployment/);
  assert.ok(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(id));
  db.db.prepare('DELETE FROM tofu_workspaces WHERE id = ?').run('dependency-fixture');
  const competingWriter = new (require('better-sqlite3'))(process.env.DB_PATH);
  const previousTimeout = db.db.pragma('busy_timeout', { simple: true });
  db.db.pragma('busy_timeout = 1');
  competingWriter.exec('BEGIN IMMEDIATE');
  try {
    const busy = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /another operation/);
    assert.ok(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(id));
  } finally {
    competingWriter.exec('ROLLBACK');
    competingWriter.close();
    db.db.pragma(`busy_timeout = ${previousTimeout}`);
  }
  const countBefore = db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tofu.connection_remove'").get().n;
  const originalWrite = db.auditLog.write;
  db.auditLog.write = (...args) => { originalWrite(...args); throw new Error('Simulated audit write failure'); };
  try {
    const failed = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(failed.status, 500);
    assert.ok(db.db.prepare('SELECT id FROM tofu_proxmox_connections WHERE id = ?').get(id));
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tofu.connection_remove'").get().n,countBefore);
  } finally { db.auditLog.write = originalWrite; }
  const removed = await request(app).delete(`${route}/${id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(removed.status, 200);
  const audit = db.db.prepare("SELECT * FROM audit_log WHERE action = 'tofu.connection_remove' AND detail LIKE ?").get(`%${id}%`);
  assert.ok(audit);
  assert.equal(audit.environment_id,'default');
  assert.equal(audit.success,1);
  assert.ok(audit.detail.includes(`connection=${JSON.stringify(name)}`));
  assert.match(audit.detail,/remote_data_kept=true/);
  assert.equal(audit.detail.includes('fixture-token'),false);
});

test('duplicate adoption under a different name/IP leaves no orphan host', async () => {
  inventory = [{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
  const before = db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
  const response = await request(app).post(`/api/opentofu/proxmox-connections/${connectionId}/import-vm`).set('Authorization', `Bearer ${token}`).send({name:'Duplicate different name',ip_address:'10.20.1.250',node_name:'pve001',vm_id:101});
  assert.equal(response.status,409);
  assert.match(response.body.error,/already adopted/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,before);
});

test('adoption revalidates a connection changed or deleted while discovery is in flight', async () => {
  inventory = [{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
  for (const change of ['delete','credentials','endpoint']) {
    const id = `racing-${change}`;
    db.db.prepare("INSERT INTO tofu_proxmox_connections (id,environment_id,name,endpoint,api_token) VALUES (?,'default',?,'https://race.example.test',?)").run(id,id,cryptoUtil.encrypt('fixture-token'));
    const before = db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
    beforeInventoryResponse = () => {
      if (change === 'delete') db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id = ?').run(id);
      else if (change === 'credentials') db.db.prepare('UPDATE tofu_proxmox_connections SET api_token = ? WHERE id = ?').run(cryptoUtil.encrypt('replacement-token'),id);
      else db.db.prepare("UPDATE tofu_proxmox_connections SET endpoint = 'https://replacement.example.test' WHERE id = ?").run(id);
    };
    try {
      const response = await request(app).post(`/api/opentofu/proxmox-connections/${id}/import-vm`).set('Authorization', `Bearer ${token}`).send({name:`Race ${change}`,ip_address:'10.20.1.249',node_name:'pve001',vm_id:101});
      assert.equal(response.status,409,JSON.stringify(response.body));
      assert.match(response.body.error,/changed or was removed/);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,before);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM proxmox_inventory_servers WHERE connection_id = ?').get(id).n,0);
    } finally { beforeInventoryResponse = null; db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id = ?').run(id); }
  }
});

test('adoption rolls back the host and mapping when audit persistence fails', async () => {
  inventory = [{type:'qemu',node:'pve001',vmid:777,name:'rollback-guest'}];
  const hostsBefore = db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
  const mapsBefore = db.db.prepare('SELECT COUNT(*) AS n FROM proxmox_inventory_servers').get().n;
  const auditBefore = db.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const originalWrite = db.auditLog.write;
  db.auditLog.write = (...args) => { originalWrite(...args); throw new Error('Simulated audit failure'); };
  try {
    const response = await request(app).post(`/api/opentofu/proxmox-connections/${connectionId}/import-vm`).set('Authorization', `Bearer ${token}`).send({name:'Rollback host',ip_address:'10.20.1.248',node_name:'pve001',vm_id:777});
    assert.equal(response.status,400);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,hostsBefore);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM proxmox_inventory_servers').get().n,mapsBefore);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,auditBefore);
  } finally { db.auditLog.write = originalWrite; }
});

test('snapshot options distinguish VM memory from LXC and reject invalid input before submission', async () => {
  inventory = [{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
  calls.length=0;
  const diskOnly=await request(app).post(`${vmPath}/snapshots`).set('Authorization',`Bearer ${token}`).send({name:'disk-only',include_memory:false});
  assert.equal(diskOnly.status,202);
  assert.match(calls.find(call=>call.method==='POST').body,/vmstate=0/);
  for(const body of [{name:'current'},{name:'bad name'},{name:'valid',description:'x'.repeat(513)},{name:'valid',include_memory:'false'}]){
    calls.length=0;
    const invalid=await request(app).post(`${vmPath}/snapshots`).set('Authorization',`Bearer ${token}`).send(body);
    assert.equal(invalid.status,400,JSON.stringify(invalid.body));
    assert.equal(calls.length,0);
  }
  inventory=[{type:'lxc',node:'pve001',vmid:202,name:'container'}];
  const ct=`/api/opentofu/proxmox-connections/${connectionId}/vms/pve001/202/snapshots`;
  calls.length=0;
  const invalidCt=await request(app).post(ct).set('Authorization',`Bearer ${token}`).send({name:'ct-memory',include_memory:true});
  assert.equal(invalidCt.status,400);
  assert.equal(calls.filter(call=>call.method==='POST').length,0);
  const validCt=await request(app).post(ct).set('Authorization',`Bearer ${token}`).send({name:'ct-disk',include_memory:false});
  assert.equal(validCt.status,202);
  assert.equal(calls.find(call=>call.method==='POST').body.includes('vmstate'),false);
});

test('snapshot task status is bound to the recorded guest and keeps unknown outcomes explicit',async()=>{
 const taskId='UPID:mock:task';
 const route=`${vmPath}/tasks/${encodeURIComponent(taskId)}/status`;
 assert.ok(db.db.prepare('SELECT 1 FROM proxmox_guest_tasks WHERE connection_id = ? AND vm_id = 101').get(connectionId));
 for(const [response,expected] of [[{status:'running'},'running'],[{status:'stopped',exitstatus:'OK'},'succeeded'],[{status:'stopped',exitstatus:'storage error'},'failed'],[{status:'stopped'},'unknown'],[{},'unknown']]){
   taskStatusResponse=response;
   const result=await request(app).get(route).set('Authorization',`Bearer ${token}`);
   assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.status,expected);
   assert.equal(result.body.api_token,undefined);
 }
 calls.length=0;
 for(const path of [`${vmPath}/tasks/untracked/status`,route.replace('/vms/pve001/101/','/vms/pve001/999/')]){
   const rejected=await request(app).get(path).set('Authorization',`Bearer ${token}`);
   assert.equal(rejected.status,404);assert.equal(calls.length,0);
 }
 const denied=await request(app).get(route).set('Authorization',`Bearer ${noDeploymentAccessToken}`);
 assert.equal(denied.status,403);assert.equal(calls.length,0);
 const source=db.db.prepare('SELECT endpoint FROM tofu_proxmox_connections WHERE id = ?').get(connectionId);
 db.db.prepare("UPDATE tofu_proxmox_connections SET endpoint='https://other.example.test' WHERE id=?").run(connectionId);
 try {const changed=await request(app).get(route).set('Authorization',`Bearer ${token}`);assert.equal(changed.status,409);assert.equal(calls.length,0);}
 finally {db.db.prepare('UPDATE tofu_proxmox_connections SET endpoint=? WHERE id=?').run(source.endpoint,connectionId);}
});

test('persisted snapshot task list is paginated and excludes other guests and connection metadata',async()=>{
 const route=`${vmPath}/tasks`;
 for(let i=0;i<23;i++) db.db.prepare("INSERT INTO proxmox_guest_tasks (connection_id,environment_id,endpoint,node_name,vm_id,task_id,action,resource_name) VALUES (?,'default','https://pve.example.test:8006','pve001',101,?,'snapshot_create',?)").run(connectionId,`list-task-${i}`,`snapshot-${i}`);
 db.db.prepare("INSERT INTO proxmox_guest_tasks (connection_id,environment_id,endpoint,node_name,vm_id,task_id,action,resource_name) VALUES (?,'default','https://pve.example.test:8006','pve001',999,'foreign-task','snapshot_create','foreign-snapshot')").run(connectionId);
 calls.length=0;
 const first=await request(app).get(route).set('Authorization',`Bearer ${token}`);
 assert.equal(first.status,200);assert.equal(first.body.tasks.length,20);assert.ok(first.body.total>=23);
 assert.equal(first.body.tasks.some(row=>row.task_id==='foreign-task'),false);
 for(const row of first.body.tasks){assert.equal(row.endpoint,undefined);assert.equal(row.environment_id,undefined);assert.equal(row.api_token,undefined);}
 const second=await request(app).get(`${route}?offset=20`).set('Authorization',`Bearer ${token}`);
 assert.equal(second.status,200);assert.equal(second.body.tasks.length,first.body.total-20);
 assert.equal(second.body.tasks.some(row=>first.body.tasks.some(previous=>previous.task_id===row.task_id)),false);
 const invalid=await request(app).get(`${route}?offset=-1`).set('Authorization',`Bearer ${token}`);assert.equal(invalid.status,400);
 const denied=await request(app).get(route).set('Authorization',`Bearer ${noDeploymentAccessToken}`);assert.equal(denied.status,403);
 assert.equal(calls.length,0,'Listing must use the durable registry without contacting Proxmox');
 const reopened=new (require('better-sqlite3'))(process.env.DB_PATH,{readonly:true});
 try{assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM proxmox_guest_tasks WHERE connection_id=? AND vm_id=101').get(connectionId).n,first.body.total);}finally{reopened.close();}
});

test('snapshot deletion records a guest-bound task without claiming synchronous completion',async()=>{
 inventory=[{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
 taskResponse='UPID:delete:task';
 try{
  const response=await request(app).delete(`${vmPath}/snapshots/old-backup`).set('Authorization',`Bearer ${token}`);
  assert.equal(response.status,202);assert.equal(response.body.task,taskResponse);
  const row=db.db.prepare('SELECT * FROM proxmox_guest_tasks WHERE task_id=?').get(taskResponse);
  assert.equal(row.action,'snapshot_delete');assert.equal(row.resource_name,'old-backup');assert.equal(row.vm_id,101);assert.equal(row.status,'unknown');
  taskStatusResponse={status:'stopped',exitstatus:'OK'};
  const status=await request(app).get(`${vmPath}/tasks/${encodeURIComponent(taskResponse)}/status`).set('Authorization',`Bearer ${token}`);
  assert.equal(status.status,200);assert.equal(status.body.status,'succeeded');assert.equal(status.body.action,'snapshot_delete');
 }finally{taskResponse='UPID:mock:task';}
});

test('force stop verifies the current guest name and power tasks remain traceable',async()=>{
 inventory=[{type:'qemu',node:'pve001',vmid:101,name:'current-guest-name'}];
 for(const confirm of [undefined,'old-guest-name']){
  calls.length=0;
  const rejected=await request(app).post(`${vmPath}/power`).set('Authorization',`Bearer ${token}`).send({action:'stop',confirm_guest_name:confirm});
  assert.equal(rejected.status,409);assert.equal(calls.filter(call=>call.method==='POST').length,0);
 }
 taskResponse='UPID:force-stop:fixture';
 try{
  const accepted=await request(app).post(`${vmPath}/power`).set('Authorization',`Bearer ${token}`).send({action:'stop',confirm_guest_name:'current-guest-name'});
  assert.equal(accepted.status,202);
  const row=db.db.prepare('SELECT * FROM proxmox_guest_tasks WHERE task_id=?').get(taskResponse);
  assert.equal(row.action,'power_stop');assert.equal(row.resource_name,'current-guest-name');assert.equal(row.vm_id,101);
  taskStatusResponse={status:'stopped',exitstatus:'OK'};
  const result=await request(app).get(`${vmPath}/tasks/${encodeURIComponent(taskResponse)}/status`).set('Authorization',`Bearer ${token}`);
  assert.equal(result.body.status,'succeeded');assert.equal(result.body.action,'power_stop');
 }finally{taskResponse='UPID:mock:task';}
});


test('snapshot restoration rejects stale recovery points and records VM and LXC rollback tasks',async()=>{
 const route=`${vmPath}/snapshots/before-change/restore`;
 inventory=[{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
 recoveryPoints=[{name:'before-change',snaptime:1700000000}];
 const body={confirm_guest_name:'app-01',confirm_snaptime:1700000000};
 for(const invalid of [{...body,confirm_guest_name:'old-name'},{...body,confirm_snaptime:1600000000},{confirm_guest_name:'app-01'}]){
  calls.length=0;
  const response=await request(app).post(route).set('Authorization',`Bearer ${token}`).send(invalid);
  assert.equal(response.status,409);assert.equal(calls.some(call=>call.method==='POST'),false);
 }
 calls.length=0;
 const denied=await request(app).post(route).set('Authorization',`Bearer ${readOnlyPlatformToken}`).send(body);
 assert.equal(denied.status,403);assert.equal(calls.length,0);
 recoveryPoints=[];
 const missing=await request(app).post(route).set('Authorization',`Bearer ${token}`).send(body);assert.equal(missing.status,409);
 recoveryPoints=[{name:'before-change',snaptime:1700000000}];
 try{
  for(const [type,id] of [['qemu',101],['lxc',202]]){
   inventory=[{type,node:'pve001',vmid:id,name:'app-01'}];calls.length=0;taskResponse=`UPID:restore:${type}`;
   const response=await request(app).post(`/api/opentofu/proxmox-connections/${connectionId}/vms/pve001/${id}/snapshots/before-change/restore`).set('Authorization',`Bearer ${token}`).send(body);
   assert.equal(response.status,202);assert.equal(response.body.task,taskResponse);
   const action=calls.find(call=>call.method==='POST');assert.equal(action.path,`/api2/json/nodes/pve001/${type}/${id}/snapshot/before-change/rollback`);
   assert.equal(calls.filter(call=>call.method==='POST').length,1);
   const row=db.db.prepare('SELECT * FROM proxmox_guest_tasks WHERE task_id=?').get(taskResponse);
   assert.equal(row.action,'snapshot_restore');assert.equal(row.resource_name,'before-change');assert.equal(row.vm_id,id);assert.equal(row.status,'unknown');
  }
 }finally{taskResponse='UPID:mock:task';recoveryPoints=[];}
});


test('guest audit uses exact identity, paginates before display and survives source unavailability',async()=>{
 inventory=[{type:'qemu',node:'pve001',vmid:101,name:'app-01'}];
 const response=await request(app).post(`${vmPath}/power`).set('Authorization',`Bearer ${token}`).send({action:'start'});
 assert.equal(response.status,202);
 const linked=db.db.prepare('SELECT a.* FROM proxmox_guest_audit g JOIN audit_log a ON a.id=g.audit_id WHERE g.connection_id=? AND g.vm_id=101 AND a.action=?').all(connectionId,'infrastructure.vm_power');
 assert.ok(linked.length>0);
 assert.ok(linked.at(-1).detail.includes(`source_id=${JSON.stringify(connectionId)}`));
 assert.ok(linked.at(-1).detail.includes('node="pve001"'));
 const ids=[];
 try{
  for(let i=0;i<25;i++){
   const id=db.auditLog.write('infrastructure.vm_power','name reused vm_id=101',null,true,'fixture','default');ids.push(id);
   db.db.prepare('INSERT INTO proxmox_guest_audit VALUES (?,?,?,?,?)').run(id,connectionId,'default','pve001',101);
  }
  for(const [node,id,conn,env] of [['pve001',1010,connectionId,'default'],['pve002',101,connectionId,'default'],['pve001',101,'other-source','default'],['pve001',101,connectionId,'other']]){
   const auditId=db.auditLog.write('infrastructure.vm_power','vm=app-01 vm_id=101 foreign',null,true,'fixture',env);ids.push(auditId);
   db.db.prepare('INSERT INTO proxmox_guest_audit VALUES (?,?,?,?,?)').run(auditId,conn,env,node,id);
  }
  ids.push(db.auditLog.write('infrastructure.vm_power','vm=app-01 vm_id=101 legacy',null,true,'fixture','default'));
  inventory=[];calls.length=0;
  const first=await request(app).get(`${vmPath}/audit`).set('Authorization',`Bearer ${token}`);
  assert.equal(first.status,200);assert.equal(first.body.events.length,20);assert.ok(first.body.total>=25);
  assert.equal(first.body.events.some(row=>/foreign|legacy/.test(row.detail)),false);
  const second=await request(app).get(`${vmPath}/audit?offset=20`).set('Authorization',`Bearer ${token}`);
  assert.equal(second.status,200);assert.ok(second.body.events.length>0);
  assert.equal(second.body.events.some(row=>first.body.events.some(previous=>previous.id===row.id)),false);
  assert.equal(calls.length,0,'Audit reads must not contact Proxmox');
  assert.equal((await request(app).get(`${vmPath}/audit`).set('Authorization',`Bearer ${readOnlyPlatformToken}`)).status,403);
  assert.equal((await request(app).get(`${vmPath}/audit?offset=-1`).set('Authorization',`Bearer ${token}`)).status,400);
 }finally{
  for(const id of ids)db.db.prepare('DELETE FROM audit_log WHERE id=?').run(id);
  for(const id of ids)assert.equal(db.db.prepare('SELECT 1 FROM proxmox_guest_audit WHERE audit_id=?').get(id),undefined);
 }
});


test('malformed guest IDs never resolve to a numeric prefix or reach Proxmox',async()=>{
 for(const id of ['101suffix','101.5','1e2','+101','0101','0','-1','9007199254740992']){
  calls.length=0;
  const path=vmPath.replace('/101',`/${encodeURIComponent(id)}`);
  for(const suffix of ['/configuration','/tasks','/audit'])assert.equal((await request(app).get(path+suffix).set('Authorization',`Bearer ${token}`)).status,400,id+suffix);
  assert.equal((await request(app).post(path+'/power').set('Authorization',`Bearer ${token}`).send({action:'start'})).status,400,id);
  assert.equal((await request(app).get(`/api/opentofu/proxmox-connections/${connectionId}/guest-ip`).query({node:'pve001',vm_id:id}).set('Authorization',`Bearer ${token}`)).status,400,id);
  assert.equal(calls.length,0);
 }
});

test('adoption rejects coerced or truncated host inputs before discovery',async()=>{
 const route=`/api/opentofu/proxmox-connections/${connectionId}/import-vm`;
 const base={node_name:'pve001',vm_id:101,name:'valid-host',ip_address:'192.0.2.55',ssh_user:'root',ssh_port:22};
 const before=db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
 for(const invalid of [{vm_id:'101tail'},{vm_id:[101]},{ssh_port:'22tail'},{ssh_port:22.5},{ssh_port:0},{ssh_port:null},{ssh_port:true},{ssh_user:''},{ssh_user:'x'.repeat(101)},{name:'x'.repeat(101)},{name:123},{node_name:['pve001']},{ip_address:123},{group_id:{id:'folder'}}]){
  calls.length=0;
  const result=await request(app).post(route).set('Authorization',`Bearer ${token}`).send({...base,...invalid});
  assert.equal(result.status,400,JSON.stringify(invalid));assert.equal(calls.length,0);
 }
 assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,before);
});

test('platform audit paginates scoped identities before unrelated activity and enforces access', async () => {
 const {writeObjectAudit}=require('../features/opentofu/object-audit');
 const source=db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id=?').get(connectionId);
 const ids=[];
 const add=(connection,node,detail)=>{const id=writeObjectAudit(db,connection,node,'infrastructure.vm_power',detail,null,'fixture');ids.push(id);return id;};
 const alias={...source,id:'audit-alias',name:'Audit alias',endpoint:source.endpoint+'/'};
 db.db.prepare('INSERT INTO tofu_proxmox_connections (id,environment_id,name,endpoint,api_token) VALUES (?,?,?,?,?)').run(alias.id,alias.environment_id,alias.name,alias.endpoint,source.api_token);
 try {
  const expected=[];
  for(let i=0;i<25;i++)expected.push(add(i===24?alias:source,'audit-node',`target ${i}`));
  for(let i=0;i<310;i++)add(source,'audit-node-other',`noise ${i}`);
  add({...source,id:'foreign-platform'},'audit-node','foreign source');
  add({...source,environment_id:'foreign-environment'},'audit-node','foreign environment');
  ids.push(db.auditLog.write('infrastructure.vm_power','node=audit-node legacy',null,true,'fixture','default'));
  const path=`/api/opentofu/proxmox-connections/${connectionId}/audit`;
  calls.length=0;
  const first=await request(app).get(path).query({node_name:'audit-node',environment_id:'default'}).set('Authorization',`Bearer ${token}`);
  assert.equal(first.status,200);assert.equal(first.body.total,25);assert.equal(first.body.events.length,20);
  const second=await request(app).get(path).query({node_name:'audit-node',offset:20}).set('Authorization',`Bearer ${token}`);
  assert.equal(second.status,200);assert.equal(second.body.events.length,5);
  assert.deepEqual(new Set([...first.body.events,...second.body.events].map(row=>row.id)),new Set(expected));
  const all=await request(app).get(path).set('Authorization',`Bearer ${token}`);
  assert.equal(all.status,200);assert.ok(all.body.total>=335);
  assert.equal(calls.length,0,'Historical audit must not contact infrastructure');
  assert.equal((await request(app).get(path).set('Authorization',`Bearer ${readOnlyPlatformToken}`)).status,403);
  assert.equal((await request(app).get(path).set('Authorization',`Bearer ${noDeploymentAccessToken}`)).status,403);
  assert.equal((await request(app).get(path).query({environment_id:'foreign-environment'}).set('Authorization',`Bearer ${token}`)).status,404);
  for(const query of [{offset:-1},{offset:0.5},{node_name:'../bad'}])assert.equal((await request(app).get(path).query(query).set('Authorization',`Bearer ${token}`)).status,400);
 } finally {
  for(const id of ids)db.db.prepare('DELETE FROM audit_log WHERE id=?').run(id);
  for(const id of ids)assert.equal(db.db.prepare('SELECT 1 FROM proxmox_object_audit WHERE audit_id=?').get(id),undefined);
  db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id=?').run(alias.id);
 }
});

test('object identity persistence rolls back an audit event when linking fails',()=>{
 const {writeObjectAudit}=require('../features/opentofu/object-audit');
 const before=db.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
 assert.throws(()=>writeObjectAudit(db,{id:null,environment_id:'default'},'pve001','fixture.failure','must roll back',null,'fixture'));
 assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,before);
});

test('platform inventory retains inactive and non-ZFS stores without inventing backend types', async()=>{
 const original=storageInventory;
 storageInventory=[
  {storage:'local-zfs',type:'zfspool',active:1,total:100,used:10,avail:90},
  {storage:'local-lvm',type:'lvmthin',active:1,total:200,used:20,avail:180},
  {storage:'local',type:'dir',active:1,total:100,used:10,avail:90,content:'iso, backup,iso',shared:0},
  {storage:'unknown-backend',active:1,total:100,avail:100},
  {storage:'offline-store',type:'nfs',active:0,total:100},
 ];
 try {
  const result=await request(app).get('/api/opentofu/infrastructure?environment_id=default&refresh=1').set('Authorization',`Bearer ${token}`);
  assert.equal(result.status,200);
  const platform=result.body.clusters.find(cluster=>cluster.connections.some(source=>source.id===connectionId));
  assert.ok(platform);
  assert.deepEqual(platform.datastores.map(store=>store.id),['local-zfs','local-lvm','local','unknown-backend','offline-store']);
  assert.equal(platform.datastores.find(store=>store.id==='offline-store').active,false);
  assert.equal(platform.datastores.find(store=>store.id==='local-zfs').active,true);
  assert.deepEqual(platform.datastores.find(store=>store.id==='local').content,['iso','backup']);
  assert.equal(platform.datastores.find(store=>store.id==='local').shared,false);
  assert.equal(platform.datastores.find(store=>store.id==='unknown-backend').shared,null);
  assert.equal(platform.datastores.find(store=>store.id==='unknown-backend').content,null);
  assert.equal(platform.datastores.find(store=>store.id==='unknown-backend').type,'');
  assert.equal(platform.datastores.find(store=>store.id==='unknown-backend').capacity_reported,false);
  assert.equal(platform.datastores.find(store=>store.id==='local-zfs').capacity_reported,true);
  assert.deepEqual(platform.nodes.find(node=>node.name==='pve001').datastores,platform.datastores);
 }finally{storageInventory=original;storageHttpStatus=200;}
});

test('storage collection distinguishes a valid empty list from an invalid response and records its attempt time',async()=>{
 const original=storageInventory;
 try {
  for(const [payload,status,http] of [[[], 'available',200],[{unexpected:'shape'},'unavailable',200],[[],'unavailable',403]]){
   storageInventory=payload; storageHttpStatus=http;
   const response=await request(app).get('/api/opentofu/infrastructure?environment_id=default&refresh=1').set('Authorization',`Bearer ${token}`);
   assert.equal(response.status,200);
   const platform=response.body.clusters.find(cluster=>cluster.connections.some(source=>source.id===connectionId));
   const node=platform.nodes.find(node=>node.name==='pve001');
   assert.equal(node.datastores_status,status);
   assert.ok(Number.isFinite(Date.parse(node.datastores_checked_at)));
   assert.deepEqual(node.datastores,[]);
  }
 }finally{storageInventory=original;storageHttpStatus=200;}
});

test('network inventory differentiates a successful empty list from denied collection',async()=>{
 try{
  for(const [http,status] of [[200,'available'],[403,'unavailable']]){
   networkHttpStatus=http;
   const response=await request(app).get('/api/opentofu/infrastructure?environment_id=default&refresh=1').set('Authorization',`Bearer ${token}`);
   assert.equal(response.status,200);
   const node=response.body.clusters.find(cluster=>cluster.connections.some(source=>source.id===connectionId)).nodes[0];
   assert.equal(node.network_status,status);
   assert.ok(Number.isFinite(Date.parse(node.network_checked_at)));
  }
 }finally{networkHttpStatus=200;}
});

test('bridge inventory preserves unknown fields instead of coercing them into inactive or a zero prefix',async()=>{
 networkInventory=[{iface:'vmbr0',address:'10.0.0.1',cidr:null},{iface:'vmbr1',type:'bridge',active:0,cidr:0,cidr6:128},{iface:'vmbr2',type:'bridge',active:1,cidr:'24'},{iface:'vmbr3',cidr:99,cidr6:129},{iface:'vmbr4',cidr:''}];
 try {
  const response=await request(app).get('/api/opentofu/infrastructure?environment_id=default&refresh=1').set('Authorization',`Bearer ${token}`);
  assert.equal(response.status,200);
  const bridges=response.body.clusters.find(cluster=>cluster.connections.some(source=>source.id===connectionId)).nodes[0].bridges;
  assert.equal(bridges[0].active,null);assert.equal(bridges[0].cidr,null);assert.equal(bridges[0].type,'');
  assert.equal(bridges[1].active,false);assert.equal(bridges[1].cidr,0);
  assert.equal(bridges[2].active,true);assert.equal(bridges[2].cidr,24);
  assert.equal(bridges[3].cidr,null);assert.equal(bridges[4].cidr,null);
  assert.equal(bridges[1].cidr6,128);assert.equal(bridges[3].cidr6,null);
 }finally {networkInventory=[];}
});

test('node network inventory includes non-bridge interfaces without mixing them into bridge defaults',async()=>{
 networkInventory=[{iface:'vmbr0',type:'bridge',active:1},{iface:'eno1',type:'eth',active:1},{iface:'bond0',type:'bond',active:1},{iface:'eno1.20',type:'vlan',active:0,address6:'2001:db8::10',cidr6:'64',gateway6:'2001:db8::1'}];
 try{
  const response=await request(app).get('/api/opentofu/infrastructure?environment_id=default&refresh=1').set('Authorization',`Bearer ${token}`);
  assert.equal(response.status,200);
  const node=response.body.clusters.find(cluster=>cluster.connections.some(source=>source.id===connectionId)).nodes[0];
  assert.deepEqual(node.network_interfaces.map(item=>item.name),['vmbr0','eno1','bond0','eno1.20']);
  assert.deepEqual(node.bridges.map(item=>item.name),['vmbr0']);
  assert.equal(node.network_interfaces[3].active,false);
  assert.equal(node.network_interfaces[3].address6,'2001:db8::10');
  assert.equal(node.network_interfaces[3].cidr6,64);
  assert.equal(node.network_interfaces[3].gateway6,'2001:db8::1');
  assert.equal(node.network_interfaces[0].cidr6,null);
 }finally {networkInventory=[];}
});
