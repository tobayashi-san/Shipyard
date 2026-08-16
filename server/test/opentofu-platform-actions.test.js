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

const calls = [];
const originalRequest = https.request;
let inventory = [{ type: 'qemu', node: 'pve001', vmid: 101, name: 'app-01' }];

function installProxmoxMock() {
  https.request = (url, options, callback) => {
    const requestStream = new EventEmitter();
    let body = '';
    requestStream.setTimeout = () => requestStream;
    requestStream.destroy = error => { if (error) requestStream.emit('error', error); };
    requestStream.write = chunk => { body += String(chunk); };
    requestStream.end = () => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, search: parsed.search, method: options.method, body, authorization: options.headers.Authorization });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      const data = parsed.pathname.endsWith('/cluster/resources') ? inventory
        : parsed.pathname.endsWith('/nodes') ? [{ node: 'pve001', status: 'online' }]
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
        : parsed.pathname.endsWith('/agent/network-get-interfaces') ? {
          result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }, { name: 'ens18', 'hardware-address': 'AA:BB:CC:DD:EE:FF', 'ip-addresses': [{ 'ip-address': '10.20.1.42', 'ip-address-type': 'ipv4' }] }],
        }
        : 'UPID:mock:task';
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
