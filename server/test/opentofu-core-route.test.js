'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `shipyard_test_opentofu_core_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-opentofu-core';
process.env.SHIPYARD_KEY_SECRET = 'test-key-secret-opentofu-core';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createApp } = require('../app');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test('OpenTofu is served as an integrated API, not an optional plugin', async () => {
  const { app } = createApp();
  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ username: 'admin', password: 'testpass12345' });
  assert.equal(setup.status, 200);

  const core = await request(app)
    .get('/api/opentofu/status')
    .set('Authorization', `Bearer ${setup.body.token}`);
  assert.equal(core.status, 200);
  assert.equal(typeof core.body.installed, 'boolean');
  assert.equal(typeof core.body.installing, 'boolean');

  const invalidInstall = await request(app)
    .post('/api/opentofu/install')
    .set('Authorization', `Bearer ${setup.body.token}`)
    .send({ version: '../unsafe' });
  assert.equal(invalidInstall.status, 400);

  const securedWorkspace = await request(app)
    .post('/api/opentofu/workspaces')
    .set('Authorization', `Bearer ${setup.body.token}`)
    .send({ name: 'secret-workspace', path: '/workspaces/secret-workspace', environment_id: 'default', env_vars: { TF_VAR_api_key: 'never-return-me' } });
  assert.equal(securedWorkspace.status, 200);
  const storedWorkspace = db.db.prepare('SELECT env_vars FROM tofu_workspaces WHERE id = ?').get(securedWorkspace.body.id);
  assert.match(storedWorkspace.env_vars, /^enc:/);
  assert.equal(storedWorkspace.env_vars.includes('never-return-me'), false);
  const workspaceInventory = await request(app)
    .get('/api/opentofu/workspaces?environment_id=default')
    .set('Authorization', `Bearer ${setup.body.token}`);
  const projectedWorkspace = workspaceInventory.body.find(row => row.id === securedWorkspace.body.id);
  assert.deepEqual(projectedWorkspace.env_var_keys, ['TF_VAR_api_key']);
  assert.equal('env_vars' in projectedWorkspace, false);

  const plugins = await request(app)
    .get('/api/plugins')
    .set('Authorization', `Bearer ${setup.body.token}`);
  assert.equal(plugins.status, 200);
  assert.equal(plugins.body.some(plugin => plugin.id === 'opentofu'), false);

  const legacy = await request(app)
    .get('/api/plugin/opentofu/status')
    .set('Authorization', `Bearer ${setup.body.token}`);
  assert.equal(legacy.status, 404);
  assert.equal(db.settings.get('plugin_opentofu_enabled'), null);

  const role = db.roles.create('no-deployments', { servers: 'all', canViewServers: true });
  db.users.create('restricted', '', await bcrypt.hash('restrictedpass123', 12), role.id);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'restricted', password: 'restrictedpass123' });
  const denied = await request(app)
    .get('/api/opentofu/status')
    .set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(denied.status, 403);
  const installDenied = await request(app)
    .post('/api/opentofu/install')
    .set('Authorization', `Bearer ${login.body.token}`)
    .send({ version: '1.9.0' });
  assert.equal(installDenied.status, 403);
  assert.equal(installDenied.body.capability, 'canManageDeploymentPlatforms');
});

test('OpenTofu enforces granular capabilities and persisted environment scope', async () => {
  const { app } = createApp();
  db.db.prepare("INSERT OR IGNORE INTO environments (id, name) VALUES ('tofu-env-a', 'Tofu A'), ('tofu-env-b', 'Tofu B')").run();
  db.db.prepare("INSERT OR IGNORE INTO server_groups (id, environment_id, name) VALUES ('tofu-group-a', 'tofu-env-a', 'A')").run();
  db.db.prepare(`
    INSERT OR IGNORE INTO tofu_workspaces (id, name, path, description, env_vars, environment_id)
    VALUES ('tofu-ws-a', 'safe-a', '/workspaces/safe-a', '', '{}', 'tofu-env-a'),
           ('tofu-ws-b', 'safe-b', '/workspaces/safe-b', '', '{}', 'tofu-env-b')
  `).run();
  const role = db.roles.create('deployment-viewer', {
    servers: { groups: ['tofu-group-a'], servers: [] },
    canViewDeployments: true,
  });
  db.users.create('deployment-viewer', '', await bcrypt.hash('viewerpass12345', 12), role.id);
  const login = await request(app).post('/api/auth/login').send({ username: 'deployment-viewer', password: 'viewerpass12345' });
  const auth = { Authorization: `Bearer ${login.body.token}` };

  const own = await request(app).get('/api/opentofu/workspaces?environment_id=tofu-env-a').set(auth);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.map(row => row.id), ['tofu-ws-a']);
  assert.equal('env_vars' in own.body[0], false);

  const omitted = await request(app).get('/api/opentofu/workspaces').set(auth);
  assert.equal(omitted.status, 400);
  const foreign = await request(app).get('/api/opentofu/workspaces?environment_id=tofu-env-b').set(auth);
  assert.equal(foreign.status, 404);
  const foreignById = await request(app).get('/api/opentofu/workspaces/tofu-ws-b/runs')
    .set({ ...auth, 'X-Shipyard-Environment': 'tofu-env-a' });
  assert.equal(foreignById.status, 404);

  const scopedAuth = { ...auth, 'X-Shipyard-Environment': 'tofu-env-a' };
  const editDenied = await request(app).patch('/api/opentofu/workspaces/tofu-ws-a/metadata').set(scopedAuth).send({ name: 'safe-a', description: 'x' });
  assert.equal(editDenied.status, 403);
  assert.equal(editDenied.body.capability, 'canEditDeployments');
  const planDenied = await request(app).post('/api/opentofu/workspaces/tofu-ws-a/run').set(scopedAuth).send({ action: 'plan' });
  assert.equal(planDenied.status, 403);
  assert.equal(planDenied.body.capability, 'canPlanDeployments');
});
