'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `fleet_test_key_assignment_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-key-assignment';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const systemRouter = require('../routes/system');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/system', systemRouter);

let token;
let auditViewerToken;
let envA;
let envB;
let host;
let workspace;
let template;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  const auditRole = db.roles.create('audit-viewer', { canViewAudit: true, servers: 'all' });
  const viewerHash = await bcrypt.hash('auditviewerpass123', 4);
  db.users.create('audit-viewer', '', viewerHash, auditRole.id, 'Audit Viewer');
  const viewerLogin = await request(app).post('/api/auth/login').send({ username: 'audit-viewer', password: 'auditviewerpass123' });
  auditViewerToken = viewerLogin.body.token;
  envA = db.uuidv4(); envB = db.uuidv4();
  db.db.prepare('INSERT INTO environments (id, name) VALUES (?, ?), (?, ?)').run(envA, 'Security A', envB, 'Security B');
  host = db.servers.create({ name: 'app-a', hostname: 'app-a', ip_address: '10.0.1.5', environment_id: envA });
  db.db.exec(`CREATE TABLE tofu_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, environment_id TEXT NOT NULL);
    CREATE TABLE tofu_proxmox_vm_templates (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}');`);
  workspace = db.uuidv4(); template = db.uuidv4();
  db.db.prepare('INSERT INTO tofu_workspaces (id, name, environment_id) VALUES (?, ?, ?)').run(workspace, 'Deployment A', envA);
  db.db.prepare('INSERT INTO tofu_proxmox_vm_templates (id, workspace_id, name) VALUES (?, ?, ?)').run(template, workspace, 'Ubuntu Standard');
});

after(() => { for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {} } });

test('SSH-key assignments are target-validated, environment-scoped and auditable', async () => {
  const auth = { Authorization: `Bearer ${token}` };
  const targets = await request(app).get(`/api/system/key-assignment-targets?environment_id=${envA}`).set(auth);
  assert.equal(targets.status, 200);
  assert.deepEqual(targets.body.servers.map(row => row.id), [host.id]);
  assert.deepEqual(targets.body.deployments.map(row => row.id), [workspace]);
  assert.deepEqual(targets.body.vm_templates.map(row => row.id), [template]);

  const created = await request(app).put('/api/system/key-assignments').set(auth).send({ environment_id: envA, target_type: 'server', target_id: host.id });
  assert.equal(created.status, 201);
  assert.equal(created.body.target_label, 'app-a · 10.0.1.5');

  const templateAssignment = await request(app).put('/api/system/key-assignments').set(auth).send({ environment_id: envA, target_type: 'vm_template', target_id: template });
  assert.equal(templateAssignment.status, 201);

  const crossEnvironment = await request(app).put('/api/system/key-assignments').set(auth).send({ environment_id: envB, target_type: 'server', target_id: host.id });
  assert.equal(crossEnvironment.status, 400);

  const listed = await request(app).get(`/api/system/key-assignments?environment_id=${envA}`).set(auth);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 2);
  const removed = await request(app).delete(`/api/system/key-assignments/${created.body.id}`).set(auth);
  assert.equal(removed.status, 204);
  assert.ok(db.auditLog.query({ action: 'ssh.assignment' }).some(row => row.action === 'ssh.assignment.upsert'));
});

test('audit entries expose safe links to their current Fleet host and deployment', async () => {
  const auth = { Authorization: `Bearer ${token}` };
  db.auditLog.write('ssh.assignment.upsert', `key=fleet type=server target=${host.id}`, '127.0.0.1', true, 'admin', envA);
  db.auditLog.write('tofu.apply', 'workspace=Deployment A vm=app-a status=success', '127.0.0.1', true, 'admin', envA);

  const response = await request(app).get(`/api/system/audit?limit=20&environment_id=${envA}`).set(auth);
  assert.equal(response.status, 200);
  const serverEvent = response.body.find(row => row.detail === `key=fleet type=server target=${host.id}`);
  const deploymentEvent = response.body.find(row => row.detail === 'workspace=Deployment A vm=app-a status=success');
  assert.deepEqual(serverEvent.object_links, [{ kind: 'server', id: host.id, label: 'app-a', href: `/servers/${host.id}` }]);
  assert.deepEqual(deploymentEvent.object_links, [{ kind: 'deployment', id: workspace, label: 'Deployment A', href: `/deployments/${workspace}` }]);
});

test('audit read access follows the assigned capability instead of requiring admin', async () => {
  const response = await request(app).get('/api/system/audit?limit=5').set({ Authorization: `Bearer ${auditViewerToken}` });
  assert.equal(response.status, 200);

  const meta = await request(app).get('/api/system/audit/meta').set({ Authorization: `Bearer ${auditViewerToken}` });
  assert.equal(meta.status, 200);
});
