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
const { setupOpenTofuDatabase } = require('../features/opentofu/schema');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const environmentContext = require('../middleware/environment-context');
const ipamRouter = require('../routes/ipam');
const { testLimiter } = require('../utils/rate-limiters');

setupOpenTofuDatabase(db.db);

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/ipam', ipamRouter);

// A second harness mirrors the production middleware order for the focused
// environment-boundary regression below. The remaining route tests keep their
// deliberately isolated IPAM-router setup.
const environmentAwareApp = express();
environmentAwareApp.use(express.json());
environmentAwareApp.use('/api/auth', authRouter);
environmentAwareApp.use('/api', testLimiter, authMiddleware);
environmentAwareApp.use('/api', environmentContext);
environmentAwareApp.use('/api/ipam', ipamRouter);

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
    start_address: '10.44.0.40', end_address: '10.44.0.49', status: 'reserved', description: 'Reservierter Bereich',
  });
  assert.equal(range.status, 201);
  assert.equal(range.body.count, 10);

  const insideRange = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.42', hostname: 'must-fail',
  });
  assert.equal(insideRange.status, 409);

  const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
  assert.equal(allocations.status, 200);
  assert.deepEqual(allocations.body.map((row) => row.kind), ['address', 'address', 'range']);
  assert.deepEqual(
    {
      address: allocations.body[0].address,
      role: allocations.body[0].role,
      managed: allocations.body[0].system_managed,
    },
    { address: '10.44.0.1', role: 'gateway', managed: true },
  );
  assert.equal(allocations.body[1].address, '10.44.0.20');
  assert.equal(allocations.body[2].address_count, 10);

  const reserveGateway = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.1', hostname: 'must-not-replace-gateway',
  });
  assert.equal(reserveGateway.status, 409);
  const rangeAcrossGateway = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations/range`)).send({
    start_address: '10.44.0.1', end_address: '10.44.0.5',
  });
  assert.equal(rangeAcrossGateway.status, 409);

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

test('IPAM validates one DHCP pool per prefix and derives address status only from that pool', async () => {
  const incomplete = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId,
    name: 'Incomplete DHCP pool',
    cidr: '10.47.0.0/24',
    dhcp_start: '10.47.0.100',
  });
  assert.equal(incomplete.status, 400);

  const includesGateway = await auth(request(app).put(`/api/ipam/subnets/${parentSubnetId}`)).send({
    dhcp_start: '10.44.0.1',
    dhcp_end: '10.44.0.10',
  });
  assert.equal(includesGateway.status, 400);

  const overlapsChild = await auth(request(app).put(`/api/ipam/subnets/${parentSubnetId}`)).send({
    dhcp_start: '10.44.0.120',
    dhcp_end: '10.44.0.140',
  });
  assert.equal(overlapsChild.status, 400);

  const configured = await auth(request(app).put(`/api/ipam/subnets/${parentSubnetId}`)).send({
    dhcp_start: '10.44.0.60',
    dhcp_end: '10.44.0.62',
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.dhcp_start, '10.44.0.60');
  assert.equal(configured.body.dhcp_end, '10.44.0.62');
  assert.equal(configured.body.dhcp_address_count, 3);

  const childInsidePool = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId,
    name: 'Child inside DHCP pool',
    cidr: '10.44.0.56/29',
  });
  assert.equal(childInsidePool.status, 409);

  const manualDhcpClaim = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.75',
    status: 'dhcp',
  });
  assert.equal(manualDhcpClaim.status, 400, JSON.stringify(manualDhcpClaim.body));
});

test('IPAM uses MAC identity to distinguish the same machine from real hostname conflicts', async () => {
  const first = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.80', hostname: 'same-machine', mac_address: '02:00:00:00:00:80', description: 'Erste Zuordnung',
  });
  const second = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.81', hostname: 'same-machine', mac_address: '02-00-00-00-00-80', description: 'Zweite Zuordnung',
  });
  const third = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.82', hostname: 'genuine-duplicate', mac_address: '02:00:00:00:00:82',
  });
  const fourth = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.83', hostname: 'genuine-duplicate', mac_address: '02:00:00:00:00:83',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.mac_address, '02:00:00:00:00:80');
  assert.equal(third.status, 201);
  assert.equal(fourth.status, 201);

  const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
  const firstRow = allocations.body.find(row => row.address === '10.44.0.80');
  const secondRow = allocations.body.find(row => row.address === '10.44.0.81');
  const thirdRow = allocations.body.find(row => row.address === '10.44.0.82');
  assert.equal(firstRow.conflict, false);
  assert.equal(secondRow.conflict, false);
  assert.equal(thirdRow.conflict, true);
  assert.match(thirdRow.conflicts.join(' '), /Hostname mehrfach vergeben/);
});

test('IPAM returns free address sections before, between, and after allocations', async () => {
  const prefix = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId, name: 'Free gaps', cidr: '10.46.0.0/29',
  });
  await auth(request(app).post(`/api/ipam/subnets/${prefix.body.id}/reservations`)).send({ address: '10.46.0.2' });
  await auth(request(app).post(`/api/ipam/subnets/${prefix.body.id}/reservations`)).send({ address: '10.46.0.5' });
  const page = await auth(request(app).get(`/api/ipam/subnets/${prefix.body.id}/allocations?paginated=1&page=1&page_size=50&status=all`));
  assert.equal(page.status, 200);
  assert.deepEqual(
    page.body.free_segments.map(segment => [segment.start_address, segment.end_address, segment.address_count, segment.before_allocation_key]),
    [
      ['10.46.0.1', '10.46.0.1', 1, `address:${page.body.items[0].id}`],
      ['10.46.0.3', '10.46.0.4', 2, `address:${page.body.items[1].id}`],
      ['10.46.0.6', '10.46.0.6', 1, null],
    ],
  );
});

test('IPAM prevents cross-environment host assignments', async () => {
  const otherEnvironmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(otherEnvironmentId, 'Foreign IPAM environment');
  const localServer = db.servers.create({
    name: 'ipam-local-server', hostname: 'ipam-local-server', ip_address: '10.44.0.30', environment_id: environmentId,
  });
  const foreignServer = db.servers.create({
    name: 'ipam-foreign-server', hostname: 'ipam-foreign-server', ip_address: '10.250.0.30', environment_id: otherEnvironmentId,
  });

  const foreignCreate = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.30', server_id: foreignServer.id,
  });
  assert.equal(foreignCreate.status, 400);
  assert.throws(
    () => db.db.prepare(`INSERT INTO ipam_reservations (id, subnet_id, address, server_id)
      VALUES (?, ?, ?, ?)`).run(db.uuidv4(), parentSubnetId, '10.44.0.31', foreignServer.id),
    /same environment/,
  );

  const created = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.30', server_id: localServer.id,
  });
  assert.equal(created.status, 201);
  const foreignUpdate = await auth(request(app).put(`/api/ipam/reservations/${created.body.id}`)).send({
    address: '10.44.0.30', server_id: foreignServer.id,
  });
  assert.equal(foreignUpdate.status, 400);
  const stored = db.db.prepare('SELECT server_id FROM ipam_reservations WHERE id = ?').get(created.body.id);
  assert.equal(stored.server_id, localServer.id);
});

test('IPAM treats delegated child prefixes as occupied address space', async () => {
  const hierarchyEnvironmentId = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?)').run(hierarchyEnvironmentId, 'Delegated hierarchy');
  const parent = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: hierarchyEnvironmentId, name: 'Parent', cidr: '10.120.0.0/24',
  });
  const child = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: hierarchyEnvironmentId, name: 'Delegated child', cidr: '10.120.0.0/26',
  });
  assert.equal(parent.status, 201);
  assert.equal(child.status, 201);

  const detail = await auth(request(app).get(`/api/ipam/subnets/${parent.body.id}`));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.next_free_address, '10.120.0.64');
  const freePage = await auth(request(app).get(`/api/ipam/subnets/${parent.body.id}/allocations?paginated=1&page=1&page_size=50&status=all`));
  assert.deepEqual(
    freePage.body.free_segments.map(segment => [segment.start_address, segment.end_address, segment.address_count]),
    [['10.120.0.64', '10.120.0.254', 191]],
  );

  const delegatedAddress = await auth(request(app).post(`/api/ipam/subnets/${parent.body.id}/reservations`)).send({
    address: '10.120.0.10',
  });
  assert.equal(delegatedAddress.status, 409);
  const delegatedRange = await auth(request(app).post(`/api/ipam/subnets/${parent.body.id}/reservations/range`)).send({
    start_address: '10.120.0.60', end_address: '10.120.0.70',
  });
  assert.equal(delegatedRange.status, 409);
});

test('IPAM supports prefix editing, deletion, global search, and paginated inventories', async () => {
  const edited = await auth(request(app).put(`/api/ipam/subnets/${parentSubnetId}`)).send({
    name: 'Produktivnetz aktualisiert', gateway: '10.44.0.2', dns_servers: ['10.44.0.54'],
    vlan_id: 441, bridge: 'vmbr1', description: 'Updated prefix', role: 'production', status: 'reserved',
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.name, 'Produktivnetz aktualisiert');
  assert.equal(edited.body.gateway, '10.44.0.2');
  assert.deepEqual(edited.body.dns_servers, ['10.44.0.54']);
  assert.equal(edited.body.vlan_id, 441);

  const pages = await auth(request(app).get(`/api/ipam/subnets?environment_id=${environmentId}&paginated=1&page=1&page_size=1&status=all`));
  assert.equal(pages.status, 200);
  assert.equal(pages.body.items.length, 1);
  assert.ok(pages.body.total >= 2);
  assert.equal(pages.body.page_size, 1);
  assert.ok(pages.body.summary.usable_address_count > 0);

  const searchable = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.90', hostname: 'globally-find-me', mac_address: '02:00:00:00:00:90',
  });
  assert.equal(searchable.status, 201);
  const search = await auth(request(app).get(`/api/ipam/search?environment_id=${environmentId}&q=globally-find-me&page=1&page_size=10`));
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].subnet_id, parentSubnetId);
  const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations?paginated=1&page=1&page_size=1&q=globally-find-me`));
  assert.equal(allocations.status, 200);
  assert.equal(allocations.body.total, 1);

  const disposable = await auth(request(app).post('/api/ipam/subnets')).send({
    environment_id: environmentId, name: 'Disposable', cidr: '10.45.0.0/24',
  });
  const reservation = await auth(request(app).post(`/api/ipam/subnets/${disposable.body.id}/reservations`)).send({ address: '10.45.0.10' });
  assert.equal(reservation.status, 201);
  const removed = await auth(request(app).delete(`/api/ipam/subnets/${disposable.body.id}`));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted.reservations, 1);
  assert.equal(db.db.prepare('SELECT 1 FROM ipam_subnets WHERE id = ?').get(disposable.body.id), undefined);
});

test('IPAM external sources encrypt credentials, hide them from the API, and sync DHCP inventory into matching prefixes', async () => {
  const controller = http.createServer((req, res) => {
    assert.equal(req.url, '/api/v2/status/dhcp_server/leases');
    assert.equal(req.headers['x-api-key'], 'test-source-token');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { ip_address: '10.44.0.60', hostname: 'dhcp-client', mac_address: '02:00:00:00:00:60', descr: 'DHCP printer', id: 'lease-60' },
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
      name: 'pfSense Test (deaktiviert)', endpoint: `http://127.0.0.1:${port}`, path: '/api/v2/status/dhcp_server/leases', enabled: false, auto_sync: false, sync_interval_min: 30,
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
    assert.equal(testConnection.body.samples[0].mac_address, '02:00:00:00:00:60');
    const sourcesAfterTest = await auth(request(app).get(`/api/ipam/sources?environment_id=${environmentId}`));
    const testedSource = sourcesAfterTest.body.find(row => row.id === created.body.id);
    assert.equal(testedSource.last_test_status, 'success');
    assert.ok(testedSource.last_tested_at);
    const beforeSync = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    assert.equal(beforeSync.body.some(row => row.start_address === '10.44.0.60'), false);

    const sync = await auth(request(app).post(`/api/ipam/sources/${created.body.id}/sync`));
    assert.equal(sync.status, 200);
    assert.deepEqual({ created: sync.body.created, updated: sync.body.updated, conflicts: sync.body.conflicts, ignored: sync.body.ignored }, { created: 2, updated: 0, conflicts: 0, ignored: 1 });
    const sourcesAfterSync = await auth(request(app).get(`/api/ipam/sources?environment_id=${environmentId}`));
    const syncedSource = sourcesAfterSync.body.find(row => row.id === created.body.id);
    assert.equal(syncedSource.last_test_status, 'success');
    assert.equal(syncedSource.last_test_error, '');
    assert.equal(syncedSource.record_count, 3);
    assert.equal(syncedSource.ignored_count, 1);

    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    const synced = allocations.body.find(row => row.start_address === '10.44.0.60');
    assert.equal(synced.source_type, 'pfsense');
    assert.equal(synced.hostname, 'dhcp-client');
    assert.equal(synced.mac_address, '02:00:00:00:00:60');
    assert.equal(synced.description, 'DHCP printer');
    assert.equal(synced.status, 'dhcp');
    assert.equal(synced.configured_status, 'active');
    assert.deepEqual(synced.source_observations, [{
      name: 'pfSense Test (deaktiviert)',
      type: 'pfsense',
      last_seen_at: synced.last_synced_at,
    }]);
    assert.equal((await auth(request(app).put(`/api/ipam/reservations/${synced.id}`)).send({ hostname: 'local-override' })).status, 409);
    assert.equal((await auth(request(app).delete(`/api/ipam/reservations/${synced.id}`))).status, 409);
    const uniFiSynced = allocations.body.find(row => row.start_address === '10.44.0.64');
    assert.equal(uniFiSynced.hostname, 'unifi-wired-client');
    assert.equal(uniFiSynced.status, 'active');
  } finally {
    await new Promise(resolve => controller.close(resolve));
  }
});

test('IPAM merges identical MAC observations from multiple sources without a conflict', async () => {
  const controller = http.createServer((req, res) => {
    if (req.headers['x-api-key'] === 'token-a') {
      assert.equal(req.headers.authorization, undefined);
    } else {
      assert.equal(req.headers['x-api-key'], 'token-b');
      assert.equal(req.headers.authorization, 'Bearer token-b');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ ip_address: '10.44.0.65', hostname: 'multi-source-host', mac_address: '02:00:00:00:00:65', id: 'shared-machine' }] }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${controller.address().port}`;
    const first = await auth(request(app).post('/api/ipam/sources')).send({ environment_id: environmentId, type: 'pfsense', name: 'Source A', endpoint, api_token: 'token-a' });
    const second = await auth(request(app).post('/api/ipam/sources')).send({ environment_id: environmentId, type: 'unifi', name: 'Source B', endpoint, path: '/api/v2/status/dhcp_leases', api_token: 'token-b' });
    assert.equal((await auth(request(app).post(`/api/ipam/sources/${first.body.id}/sync`))).body.created, 1);
    const secondSync = await auth(request(app).post(`/api/ipam/sources/${second.body.id}/sync`));
    assert.equal(secondSync.body.conflicts, 0);

    const allocations = await auth(request(app).get(`/api/ipam/subnets/${parentSubnetId}/allocations`));
    const shared = allocations.body.filter(row => row.address === '10.44.0.65');
    assert.equal(shared.length, 1);
    assert.equal(shared[0].conflict, false);
    assert.deepEqual(shared[0].observed_sources, ['Source A', 'Source B']);
    assert.equal(shared[0].mac_address, '02:00:00:00:00:65');

    const removeFirst = await auth(request(app).delete(`/api/ipam/sources/${first.body.id}`));
    assert.equal(removeFirst.status, 200);
    const afterTransfer = db.db.prepare('SELECT source_ref FROM ipam_reservations WHERE id = ?').get(shared[0].id);
    assert.match(afterTransfer.source_ref, new RegExp(`^${second.body.id}:`));
  } finally {
    await new Promise(resolve => controller.close(resolve));
  }
});

test('IPAM enriches a missing MAC on an automated reservation without overwriting manual ownership', async () => {
  const automatedId = db.uuidv4();
  db.db.prepare(`INSERT INTO ipam_reservations
    (id, subnet_id, address, hostname, mac_address, source_type, source_ref)
    VALUES (?, ?, '10.44.0.66', 'proxmox-guest', '', 'proxmox', 'test-proxmox:guest-66')`)
    .run(automatedId, parentSubnetId);
  const manual = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
    address: '10.44.0.67', hostname: 'manual-owner',
  });
  assert.equal(manual.status, 201);

  const controller = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [
      { ip_address: '10.44.0.66', hostname: 'proxmox-guest', mac_address: '02:00:00:00:00:66', id: 'guest-66' },
      { ip_address: '10.44.0.67', hostname: 'manual-owner', mac_address: '02:00:00:00:00:67', id: 'manual-67' },
    ] }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const source = await auth(request(app).post('/api/ipam/sources')).send({
      environment_id: environmentId, type: 'unifi', name: 'MAC enrichment',
      endpoint: `http://127.0.0.1:${controller.address().port}`,
      path: '/api/v2/status/dhcp_leases', api_token: 'enrichment-token',
    });
    const sync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(sync.status, 200);
    assert.equal(sync.body.conflicts, 1);
    const automated = db.db.prepare('SELECT mac_address, source_type FROM ipam_reservations WHERE id = ?').get(automatedId);
    assert.deepEqual(automated, { mac_address: '02:00:00:00:00:66', source_type: 'proxmox' });
    const manualStored = db.db.prepare('SELECT mac_address FROM ipam_reservations WHERE id = ?').get(manual.body.id);
    assert.equal(manualStored.mac_address, '');
    const conflicts = db.db.prepare('SELECT address FROM ipam_sync_conflicts WHERE source_id = ?').all(source.body.id);
    assert.deepEqual(conflicts, [{ address: '10.44.0.67' }]);
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

test('IPAM source sync releases the previous address when a stable source object moves into a conflict', async () => {
  let leases = [
    { ip_address: '10.44.0.68', hostname: 'moving-lease', id: 'stable-controller-id' },
  ];
  const controller = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: leases }));
  });
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  try {
    const source = await auth(request(app).post('/api/ipam/sources')).send({
      environment_id: environmentId,
      type: 'pfsense',
      name: 'Moving lease source',
      endpoint: `http://127.0.0.1:${controller.address().port}`,
      api_token: 'moving-token',
    });
    assert.equal(source.status, 201);
    const firstSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(firstSync.status, 200);
    assert.equal(firstSync.body.created, 1);

    const manual = await auth(request(app).post(`/api/ipam/subnets/${parentSubnetId}/reservations`)).send({
      address: '10.44.0.69',
      hostname: 'manual-owner',
    });
    assert.equal(manual.status, 201);
    leases = [
      { ip_address: '10.44.0.69', hostname: 'moving-lease', id: 'stable-controller-id' },
    ];

    const secondSync = await auth(request(app).post(`/api/ipam/sources/${source.body.id}/sync`));
    assert.equal(secondSync.status, 200);
    assert.equal(secondSync.body.conflicts, 1);
    assert.equal(secondSync.body.removed, 1);

    const oldReservation = db.db
      .prepare("SELECT id FROM ipam_reservations WHERE subnet_id = ? AND address = '10.44.0.68'")
      .get(parentSubnetId);
    assert.equal(oldReservation, undefined);
    const observation = db.db.prepare(
      'SELECT address, reservation_id FROM ipam_source_observations WHERE source_id = ?',
    ).get(source.body.id);
    assert.deepEqual(observation, { address: '10.44.0.69', reservation_id: null });
  } finally {
    await new Promise(resolve => controller.close(resolve));
  }
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
    const sourceConflict = conflicts.body.find(item => item.source_name === 'Collision source');
    assert.ok(sourceConflict);
    assert.equal(sourceConflict.existing_hostname, 'manual-owner');
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
    servers: { servers: [assignedHost.id], groups: [] },
    canViewServers: true,
    canEditServers: true,
    canViewNetworks: true,
    canEditNetworks: true,
  });
  const passwordHash = await bcrypt.hash('ipam-scoped-pass', 4);
  db.users.create('ipam-scoped-operator', '', passwordHash, role.id, 'IPAM scoped operator');
  const login = await request(environmentAwareApp).post('/api/auth/login').send({ username: 'ipam-scoped-operator', password: 'ipam-scoped-pass' });
  assert.equal(login.status, 200);
  const scopedAuth = { Authorization: `Bearer ${login.body.token}` };

  const allowed = await request(environmentAwareApp).get(`/api/ipam/subnets?environment_id=${scopedEnvironmentId}`).set(scopedAuth);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.length, 1);
  const blocked = await request(environmentAwareApp)
    .get(`/api/ipam/subnets/${blockedSubnet.body.id}/allocations`)
    .set({ ...scopedAuth, 'X-Shipyard-Environment': scopedEnvironmentId });
  assert.equal(blocked.status, 404);
  const blockedCreate = await request(environmentAwareApp)
    .post('/api/ipam/subnets')
    .set({ ...scopedAuth, 'X-Shipyard-Environment': blockedEnvironmentId })
    .send({
    environment_id: blockedEnvironmentId, name: 'Nicht erlaubt', cidr: '10.242.0.0/24',
  });
  assert.equal(blockedCreate.status, 404);
});
