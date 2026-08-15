'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_ipam_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-ipam';
process.env.SHIPYARD_KEY_SECRET = 'test-ipam-source-encryption-key';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const ipamRouter = require('../routes/ipam');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/ipam', ipamRouter);

let token;
let environmentId;
let parentSubnetId;

const auth = (call) => call.set('Authorization', `Bearer ${token}`);

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  environmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(environmentId, 'IPAM-Test');
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('IPAM supports a prefix hierarchy and rejects duplicate prefixes written with host bits', async () => {
  const parent = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId, name: 'Produktivnetz', cidr: '10.44.0.0/24',
    gateway: '10.44.0.1', dns_servers: ['10.44.0.53'], vlan_id: 440, bridge: 'vmbr0',
  });
  assert.equal(parent.status, 201);
  parentSubnetId = parent.body.id;

  const child = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId, name: 'Applikationen', cidr: '10.44.0.128/25', vlan_id: 440,
  });
  assert.equal(child.status, 201);

  const duplicateAlias = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId, name: 'Doppeltes Teilnetz', cidr: '10.44.0.129/25',
  });
  assert.equal(duplicateAlias.status, 409);

  const listed = await auth(request(app).get(`/api/ipam/subnets?environment_id=${environmentId}`));
  assert.equal(listed.status, 200);
  const listedParent = listed.body.find((row) => row.id === parentSubnetId);
  assert.equal(listedParent.child_prefix_count, 1);
  assert.equal(listedParent.gateway, '10.44.0.1');

  const children = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/children`));
  assert.equal(children.status, 200);
  assert.equal(children.body.length, 1);
  assert.equal(children.body[0].cidr, '10.44.0.128/25');
});

test('IPAM combines individual addresses and ranges and exposes address conflicts', async () => {
  const first = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.20', hostname: 'app-a', mac_address: '02:00:00:00:00:01', status: 'active', description: 'Manuelle Zuordnung',
  });
  assert.equal(first.status, 201);

  const duplicate = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.20', hostname: 'app-b', status: 'reserved',
  });
  assert.equal(duplicate.status, 409);

  const range = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations/range`)).send({
    start_address: '10.44.0.40', end_address: '10.44.0.49', status: 'dhcp', description: 'DHCP-Bereich',
  });
  assert.equal(range.status, 201);
  assert.equal(range.body.count, 10);

  const insideRange = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.42', hostname: 'must-fail',
  });
  assert.equal(insideRange.status, 409);

  const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
  assert.equal(allocations.status, 200);
  assert.deepEqual(allocations.body.map((row) => row.kind), ['address', 'range']);
  assert.equal(allocations.body[0].address, '10.44.0.20');
  assert.equal(allocations.body[1].address_count, 10);

  const edit = await auth(request(app).put(`/api/ipam/reservations/${first.body.id}`)).send({
    address: '10.44.0.21', hostname: 'app-a', mac_address: '02:00:00:00:00:01', role: 'vip', description: 'Aktualisiert',
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.address, '10.44.0.21');
  assert.equal(edit.body.role, 'vip');

  const deletedAddress = await auth(request(app).delete(`/api/ipam/reservations/${first.body.id}`));
  assert.equal(deletedAddress.status, 200);
  // Ranges return their count only. Resolve its generated ID from inventory
  // to exercise the audited deletion endpoint.
  const current = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
  const rangeRow = current.body.find(row => row.kind === 'range' && row.start_address === '10.44.0.40');
  const deletedRange = await auth(request(app).delete(`/api/ipam/ranges/${rangeRow.id}`));
  assert.equal(deletedRange.status, 200);
  const audit = db.auditLog.query({ action: 'ipam.reservation_delete' });
  assert.ok(audit.some(row => /address=10\.44\.0\.21/.test(row.detail)));
  const rangeAudit = db.auditLog.query({ action: 'ipam.reservation_range_delete' });
  assert.ok(rangeAudit.some(row => /start=10\.44\.0\.40 end=10\.44\.0\.49/.test(row.detail)));
});

test('IPAM keeps duplicate hostnames and MAC addresses visible as resolvable conflicts', async () => {
  const first = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.80', hostname: 'duplicate-owner', mac_address: '02:00:00:00:00:80', description: 'Erste Zuordnung',
  });
  const second = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.81', hostname: 'duplicate-owner', mac_address: '02:00:00:00:00:80', description: 'Zweite Zuordnung',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
  const firstRow = allocations.body.find(row => row.address === '10.44.0.80');
  const secondRow = allocations.body.find(row => row.address === '10.44.0.81');
  assert.equal(firstRow.conflict, true);
  assert.equal(secondRow.conflict, true);
  assert.match(firstRow.conflicts.join(' '), /Hostname mehrfach vergeben/);
  assert.match(secondRow.conflicts.join(' '), /MAC-Adresse mehrfach vergeben/);
});

test('IPAM external sources encrypt credentials, hide them from the API, and sync DHCP inventory into matching prefixes', async () => {
  const controller = http.createServer((req, res) => {
    assert.equal(req.url, '/api/v2/status/dhcp_leases');
    assert.match(String(req.headers.authorization || ''), /^Bearer test-source-token$/);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { ip_address: '10.44.0.60', hostname: 'dhcp-client', mac_address: '02:00:00:00:00:60', id: 'lease-60' },
      // UniFi's client inventory uses `last_ip` for wired DHCP clients.
      { last_ip: '10.44.0.64', name: 'unifi-wired-client', mac: '02:00:00:00:00:64', _id: 'unifi-client-64' },
      { ip_address: '192.0.2.5', hostname: 'outside-prefix', id: 'outside' },
    ] }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  const port = controller.address().port;
  try {
    const created = await auth(request(app).post('/api/ipam/sources')).send({
      environment_id: environmentId,
      type: 'pfsense',
      name: 'pfSense Test',
      endpoint: `http://127.0.0.1:${port}`,
      api_token: 'test-source-token',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.api_token, undefined);
    assert.equal(created.body.api_token_configured, true);
    assert.equal(created.body.auto_sync, true);
    assert.equal(created.body.sync_interval_min, 15);
    const raw = db.db.prepare('SELECT api_token FROM ipam_sync_sources WHERE id = ?').get(created.body.id);
    assert.notEqual(raw.api_token, 'test-source-token');

    const updated = await auth(request(app).put(`/api/ipam/sources/${created.body.id}`)).send({
      name: 'pfSense Test (deaktiviert)', endpoint: `http://127.0.0.1:${port}`, path: '/api/v2/status/dhcp_leases', enabled: false, auto_sync: false, sync_interval_min: 30,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'pfSense Test (deaktiviert)');
    assert.equal(updated.body.enabled, false);
    assert.equal(updated.body.auto_sync, false);
    assert.equal(updated.body.sync_interval_min, 30);
    assert.equal(updated.body.api_token_configured, true);
    const disabledTest = await auth(request(app).post(`/api/ipam/sources/${created.body.id}/test`));
    assert.equal(disabledTest.status, 409);
    const enabled = await auth(request(app).put(`/api/ipam/sources/${created.body.id}`)).send({ enabled: true });
    assert.equal(enabled.status, 200);

    const testConnection = await auth(request(app).post(`/api/ipam/sources/${created.body.id}/test`));
    assert.equal(testConnection.status, 200);
    assert.deepEqual({ records: testConnection.body.records, matching: testConnection.body.matching_prefixes, outside: testConnection.body.outside_prefixes }, { records: 3, matching: 2, outside: 1 });
    const sourcesAfterTest = await auth(request(app).get(`/api/ipam/sources?environment_id=${environmentId}`));
    const testedSource = sourcesAfterTest.body.find(row => row.id === created.body.id);
    assert.equal(testedSource.last_test_status, 'success');
    assert.ok(testedSource.last_tested_at);
    const beforeSync = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    assert.equal(beforeSync.body.some(row => row.start_address === '10.44.0.60'), false);

    const sync = await auth(request(app).post(`/api/ipam/sources/${created.body.id}/sync`));
    assert.equal(sync.status, 200);
    assert.deepEqual({ created: sync.body.created, updated: sync.body.updated, conflicts: sync.body.conflicts, ignored: sync.body.ignored }, { created: 2, updated: 0, conflicts: 0, ignored: 1 });

    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    const synced = allocations.body.find(row => row.start_address === '10.44.0.60');
    assert.equal(synced.source_type, 'pfsense');
    assert.equal(synced.hostname, 'dhcp-client');
    assert.equal(synced.status, 'dhcp');
    const uniFiSynced = allocations.body.find(row => row.start_address === '10.44.0.64');
    assert.equal(uniFiSynced.hostname, 'unifi-wired-client');
  } finally {
    await new Promise(resolve => controller.close(resolve));
  }
});

test('IPAM source sync releases only stale leases owned by the same source', async () => {
  let leases = [
    { ip_address: '10.44.0.61', hostname: 'first-lease', id: 'lease-first' },
    { ip_address: '10.44.0.62', hostname: 'second-lease', id: 'lease-second' },
  ];
  const controller = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: leases }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const source = await auth(request(app).post('/api/ipam/sources')).send({
      environment_id: environmentId, type: 'pfsense', name: 'Stale lease source', endpoint: `http://127.0.0.1:${controller.address().port}`, api_token: 'stale-token',
    });
    assert.equal(source.status, 201);
    const firstSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(firstSync.status, 200);
    assert.equal(firstSync.body.created, 2);

    leases = [{ ip_address: '10.44.0.62', hostname: 'second-lease-renamed', id: 'lease-second' }];
    const secondSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(secondSync.status, 200);
    assert.equal(secondSync.body.updated, 1);
    assert.equal(secondSync.body.removed, 1);

    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    assert.equal(allocations.body.some(row => row.address === '10.44.0.61'), false);
    assert.equal(allocations.body.find(row => row.address === '10.44.0.62')?.hostname, 'second-lease-renamed');
    const sources = await auth(request(app).get(`/api/ipam/sources?environment_id=${environmentId}`));
    const summary = sources.body.find(row => row.id === source.body.id);
    assert.equal(summary.inventory_count, 1);
    assert.equal(summary.conflict_count, 0);
  } finally { await new Promise(resolve => controller.close(resolve)); }
});

test('IPAM refuses an invalid non-empty source response without releasing existing leases', async () => {
  let payload = { data: [{ ip_address: '10.44.0.63', hostname: 'preserve-this-lease', id: 'preserve-63' }] };
  const controller = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const source = await auth(request(app).post('/api/ipam/sources')).send({
      environment_id: environmentId, type: 'pfsense', name: 'Malformed response source', endpoint: `http://127.0.0.1:${controller.address().port}`, api_token: 'malformed-token',
    });
    assert.equal(source.status, 201);
    const firstSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(firstSync.status, 200);
    assert.equal(firstSync.body.created, 1);

    payload = { data: [{ hostname: 'missing-address', id: 'bad-record' }] };
    const failedSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(failedSync.status, 502);
    assert.match(failedSync.body.error, /keine auslesbaren IPv4-Adressen/);
    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    assert.equal(allocations.body.some(row => row.address === '10.44.0.63'), true);
    const sources = await auth(request(app).get(`/api/ipam/sources?environment_id=${environmentId}`));
    const summary = sources.body.find(row => row.id === source.body.id);
    assert.equal(summary.last_status, 'failed');
  } finally { await new Promise(resolve => controller.close(resolve)); }
});

test('IPAM keeps externally reported address collisions visible instead of silently dropping them', async () => {
  const manual = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({ address: '10.44.0.70', hostname: 'manual-owner' });
  assert.equal(manual.status, 201);
  const controller = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ ip_address: '10.44.0.70', hostname: 'controller-owner', id: 'collision-70' }] }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const source = await auth(request(app).post('/api/ipam/sources')).send({ environment_id: environmentId, type: 'pfsense', name: 'Collision source', endpoint: `http://127.0.0.1:${controller.address().port}`, api_token: 'collision-token' });
    const sync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(sync.status, 200);
    assert.equal(sync.body.conflicts, 1);
    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    const row = allocations.body.find(item => item.address === '10.44.0.70');
    assert.equal(row.conflict, true);
    assert.match(row.conflicts.join(' '), /Collision source/);
    const conflicts = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/conflicts`));
    assert.equal(conflicts.status, 200);
    assert.equal(conflicts.body.length, 1);
    assert.equal(conflicts.body[0].source_name, 'Collision source');
    assert.equal(conflicts.body[0].existing_hostname, 'manual-owner');
  } finally { await new Promise(resolve => controller.close(resolve)); }
});

test('restricted operators cannot use IPAM routes to cross an environment boundary', async () => {
  const scopedEnvironmentId = db.uuidv4();
  const blockedEnvironmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?), (?, ?)')
    .run(scopedEnvironmentId, 'Erlaubte IPAM-Umgebung', blockedEnvironmentId, 'Gesperrte IPAM-Umgebung');
  const assignedHost = db.servers.create({
    name: 'ipam-scoped-host', hostname: 'ipam-scoped-host.example', ip_address: '10.240.0.10',
    tags: [], services: [], environment_id: scopedEnvironmentId,
  });
  const scopedSubnet = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: scopedEnvironmentId, name: 'Erlaubt', cidr: '10.240.0.0/24',
  });
  const blockedSubnet = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: blockedEnvironmentId, name: 'Gesperrt', cidr: '10.241.0.0/24',
  });
  assert.equal(scopedSubnet.status, 201);
  assert.equal(blockedSubnet.status, 201);

  const role = db.roles.create('IPAM scoped operator', {
    servers: { servers: [assignedHost.id], groups: [] }, canViewServers: true, canEditServers: true,
  });
  const passwordHash = await bcrypt.hash('ipam-scoped-pass', 4);
  db.users.create('ipam-scoped-operator', '', passwordHash, role.id, 'IPAM scoped operator');
  const login = await request(app).post('/api/auth/login').send({ username: 'ipam-scoped-operator', password: 'ipam-scoped-pass' });
  assert.equal(login.status, 200);
  const scopedAuth = { Authorization: `Bearer ${login.body.token}` };

  const allowed = await request(app).get(`/api/ipam/subnets?environment_id=${scopedEnvironmentId}`).set(scopedAuth);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.length, 1);
  const blocked = await request(app).get(`/api/ipam/subnets/${blockedSubnet.body.id}/allocations`).set(scopedAuth);
  assert.equal(blocked.status, 403);
  const blockedCreate = await request(app).post('/api/ipam/subnets').set(scopedAuth).send({
    environment_id: blockedEnvironmentId, name: 'Nicht erlaubt', cidr: '10.242.0.0/24',
  });
  assert.equal(blockedCreate.status, 403);
});
