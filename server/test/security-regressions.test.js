'use strict';

// Must be set before any require that loads db.js
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_security_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-security';
process.env.SHIPYARD_KEY_SECRET = 'test-master-key-security';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const serversRouter = require('../routes/servers');
const createServerActionsRouter = require('../routes/server-actions');
const createAnsibleRouter = require('../routes/ansible');
const scheduleHistoryRouter = require('../routes/schedule-history');
const schedulesRouter = require('../routes/schedules');
const playbooksRouter = require('../routes/playbooks');
const adhocRouter = require('../routes/adhoc');
const usersRouter = require('../routes/users');
const systemRouter = require('../routes/system');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const { getPermissions, filterPlaybooks } = require('../utils/permissions');
const { testLimiter } = require('../utils/rate-limiters');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/servers', createServerActionsRouter());
app.use('/api/servers', serversRouter);
app.use('/api/ansible', createAnsibleRouter());
app.use('/api/schedule-history', scheduleHistoryRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/playbooks', playbooksRouter);
app.use('/api/adhoc', adhocRouter);
app.use('/api/users', usersRouter);
app.use('/api/system', systemRouter);

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

function wipeDb() {
  for (const table of ['users', 'servers', 'schedules', 'schedule_history', 'server_groups']) {
    try { db.db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
  try { db.db.prepare('DELETE FROM roles WHERE is_system = 0').run(); } catch {}
  try { db.db.prepare('DELETE FROM app_settings').run(); } catch {}
}

async function setupAdmin() {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
}

async function login(username, password) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  return res.body.token;
}

test('setup mode blocks non-auth API routes (prevents data exposure after reset/auth)', async () => {
  wipeDb();
  const res = await request(app).get('/api/schedule-history');
  assert.equal(res.status, 503);
});

test('setup preserves username case', async () => {
  wipeDb();
  const res = await request(app)
    .post('/api/auth/setup')
    .send({ username: 'Admin.User', password: 'testpass12345' });
  assert.equal(res.status, 200);

  const user = db.users.getByUsername('admin.user');
  assert.equal(user.username, 'Admin.User');
});

test('user email validation is bounded and rejects malformed values', async () => {
  wipeDb();
  await setupAdmin();
  const adminToken = await login('admin', 'testpass12345');

  const accepted = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      username: 'mailvalid',
      email: ' Valid.User@Example.COM ',
      password: 'newuserpass12345',
      role: 'user',
    });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.email, 'valid.user@example.com');

  const empty = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      username: 'mailempty',
      email: '',
      password: 'newuserpass12345',
      role: 'user',
    });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.email, '');

  const invalidEmails = [
    42,
    `${'a'.repeat(250)}@example.com`,
    'a@',
    '@example.com',
    'a@example',
    'a@.com',
    '.a@example.com',
    'a.@example.com',
    'a @domain.com',
  ];

  for (const [i, email] of invalidEmails.entries()) {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: `badmail${i}`,
        email,
        password: 'newuserpass12345',
        role: 'user',
      });
    assert.equal(res.status, 400);
  }
});

test('usernames preserve case but remain unique and loginable case-insensitively', async () => {
  wipeDb();
  await setupAdmin();
  const adminToken = await login('ADMIN', 'testpass12345');

  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      username: 'Max.User',
      password: 'newuserpass12345',
      role: 'user',
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.username, 'Max.User');

  const duplicate = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      username: 'max.user',
      password: 'newuserpass12345',
      role: 'user',
    });
  assert.equal(duplicate.status, 409);

  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'MAX.USER', password: 'newuserpass12345' });
  assert.equal(loginRes.status, 200);
  assert.equal(typeof loginRes.body.token, 'string');
});

test('custom roles do not inherit omitted dangerous permissions', async () => {
  wipeDb();
  await setupAdmin();

  const role = db.roles.create('sparse-viewer', {
    canViewServers: true,
    servers: 'all',
  });
  const hash = await bcrypt.hash('sparsepass12345', 12);
  db.users.create('sparseuser', '', hash, role.id);
  const token = await login('sparseuser', 'sparsepass12345');

  const profile = await request(app)
    .get('/api/auth/profile')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.permissions.canViewServers, true);
  assert.equal(profile.body.permissions.canDeleteServers, false);
  assert.equal(profile.body.permissions.canRunPlaybooks, false);
  assert.deepEqual(profile.body.permissions.playbooks, []);
  assert.deepEqual(profile.body.permissions.plugins, []);

  const forbidden = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'all', module: 'ping' });
  assert.equal(forbidden.status, 403);
});

test('schedule-history list allows restricted user to see multi-target entries they partially have access to', async () => {
  wipeDb();
  await setupAdmin();

  // Create two servers and two schedule history entries
  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });
  db.scheduleHistory.create(null, 'nightly', 'deploy.yml', 'web-1,db-1');
  db.scheduleHistory.create(null, 'nightly', 'deploy.yml', 'db-1');
  const otherPlaybookHistId = db.scheduleHistory.create(null, 'nightly', 'other.yml', 'web-1');

  // Restricted role: only web-1
  const viewerRole = db.roles.create('viewer', {
    servers: { servers: [webId], groups: [] },
    playbooks: ['deploy.yml'],
    canViewServers: true,
    canViewSchedules: true,
  });
  const hash = await bcrypt.hash('viewerpass12345', 12);
  db.users.create('viewer', '', hash, viewerRole.id);

  const token = await login('viewer', 'viewerpass12345');

  const res = await request(app)
    .get('/api/schedule-history?limit=50')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // Should include the 'web-1,db-1' entry (because viewer can access web-1)
  assert.ok(res.body.some(r => r.targets === 'web-1,db-1'));
  // Should NOT include db-only entry
  assert.ok(!res.body.some(r => r.targets === 'db-1'));
  // Should NOT include entries for playbooks outside the allowlist
  assert.ok(!res.body.some(r => r.playbook === 'other.yml'));

  const detailForbidden = await request(app)
    .get(`/api/schedule-history/${otherPlaybookHistId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(detailForbidden.status, 403);
});

test('adhoc run is blocked for restricted user targeting inaccessible server', async () => {
  wipeDb();
  await setupAdmin();

  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });

  // Role: can only access web-1
  const role = db.roles.create('web-only', {
    servers: { servers: [webId], groups: [] },
    canRunPlaybooks: true,
  });
  const hash = await bcrypt.hash('webpass12345', 12);
  db.users.create('webonly', '', hash, role.id);
  const token = await login('webonly', 'webpass12345');

  // Attempt to run against db-1 (not permitted)
  const forbidden = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'db-1', module: 'ping' });
  assert.equal(forbidden.status, 403);

  // Attempt to run against 'all' (not permitted for restricted user)
  const allForbidden = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'all', module: 'ping' });
  assert.equal(allForbidden.status, 403);

  const originalRunAdHoc = ansibleRunner.runAdHoc;
  ansibleRunner.runAdHoc = async () => ({ success: true, stdout: '', stderr: '', code: 0 });
  try {
    // Targeting own server is allowed
    const allowed = await request(app)
      .post('/api/adhoc/run')
      .set('Authorization', `Bearer ${token}`)
      .send({ targets: 'web-1', module: 'ping' });
    assert.equal(allowed.status, 200);
  } finally {
    ansibleRunner.runAdHoc = originalRunAdHoc;
  }
});

test('ansible entrypoints reject unknown or option-like targets for all-scope roles', async () => {
  wipeDb();
  await setupAdmin();

  db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: ['production'], services: [] });
  const role = db.roles.create('runner-all', {
    servers: 'all',
    playbooks: 'all',
    canRunPlaybooks: true,
  });
  const hash = await bcrypt.hash('runnerpass12345', 12);
  db.users.create('runner', '', hash, role.id);
  const token = await login('runner', 'runnerpass12345');

  const adhocLocalhost = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: 'localhost', module: 'ping' });
  assert.equal(adhocLocalhost.status, 400);

  const adhocOption = await request(app)
    .post('/api/adhoc/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ targets: '--list-hosts', module: 'ping' });
  assert.equal(adhocOption.status, 400);

  const playbookLocalhost = await request(app)
    .post('/api/ansible/run')
    .set('Authorization', `Bearer ${token}`)
    .send({ playbook: 'deploy.yml', targets: 'localhost' });
  assert.equal(playbookLocalhost.status, 400);
});

test('playbook whitelist is enforced for restricted roles', async () => {
  wipeDb();
  await setupAdmin();

  // Role with a specific playbook allowlist
  const role = db.roles.create('restricted-playbooks', {
    servers: 'all',
    playbooks: ['deploy.yml'],
    canRunPlaybooks: true,
  });
  const hash = await bcrypt.hash('plpass12345', 12);
  db.users.create('pluser', '', hash, role.id);
  const token = await login('pluser', 'plpass12345');

  // Verify filterPlaybooks reflects the whitelist
  const user = db.users.getByUsername('pluser');
  const perms = getPermissions(user);
  const allowed = filterPlaybooks([
    { filename: 'deploy.yml' },
    { filename: 'other.yml' },
  ], perms);
  assert.deepEqual(allowed.map(p => p.filename), ['deploy.yml']);

  // Accessing a non-whitelisted playbook returns an empty list from filterPlaybooks
  assert.equal(allowed.some(p => p.filename === 'other.yml'), false);
});

test('playbook content and write endpoints enforce playbook whitelist', async () => {
  wipeDb();
  await setupAdmin();

  const role = db.roles.create('restricted-playbook-api', {
    servers: 'all',
    playbooks: ['deploy.yml'],
    canViewPlaybooks: true,
    canEditPlaybooks: true,
    canDeletePlaybooks: true,
  });
  const hash = await bcrypt.hash('playbookapipass12345', 12);
  db.users.create('playbookapi', '', hash, role.id);
  const token = await login('playbookapi', 'playbookapipass12345');

  const readForbidden = await request(app)
    .get('/api/playbooks/other.yml')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(readForbidden.status, 403);

  const writeForbidden = await request(app)
    .post('/api/playbooks')
    .set('Authorization', `Bearer ${token}`)
    .send({ filename: 'other.yml', content: '---\n- hosts: all\n' });
  assert.equal(writeForbidden.status, 403);
});

test('schedule routes enforce playbook and server scope', async () => {
  wipeDb();
  await setupAdmin();

  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });
  db.schedules.create('db-only', 'deploy.yml', 'db-1', '0 3 * * *');

  const role = db.roles.create('schedule-scoped', {
    servers: { servers: [webId], groups: [] },
    playbooks: ['deploy.yml'],
    canViewSchedules: true,
    canAddSchedules: true,
    canEditSchedules: true,
    canDeleteSchedules: true,
    canToggleSchedules: true,
  });
  const hash = await bcrypt.hash('schedulepass12345', 12);
  db.users.create('scheduleuser', '', hash, role.id);
  const token = await login('scheduleuser', 'schedulepass12345');

  const allForbidden = await request(app)
    .post('/api/schedules')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'all servers', playbook: 'deploy.yml', targets: 'all', cronExpression: '0 2 * * *' });
  assert.equal(allForbidden.status, 403);

  const playbookForbidden = await request(app)
    .post('/api/schedules')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'other playbook', playbook: 'other.yml', targets: 'web-1', cronExpression: '0 2 * * *' });
  assert.equal(playbookForbidden.status, 403);

  const allowed = await request(app)
    .post('/api/schedules')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'web deploy', playbook: 'deploy.yml', targets: 'web-1', cronExpression: '0 2 * * *' });
  assert.equal(allowed.status, 200);

  const list = await request(app)
    .get('/api/schedules')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.some(s => s.name === 'web deploy'), true);
  assert.equal(list.body.some(s => s.name === 'db-only'), false);

  const cleanup = await request(app)
    .delete(`/api/schedules/${allowed.body.id}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(cleanup.status, 200);
});

test('schedule routes reject unknown all-scope targets', async () => {
  wipeDb();
  await setupAdmin();

  db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] });
  const role = db.roles.create('schedule-all-scope', {
    servers: 'all',
    playbooks: 'all',
    canAddSchedules: true,
  });
  const hash = await bcrypt.hash('scheduleallpass12345', 12);
  db.users.create('scheduleall', '', hash, role.id);
  const token = await login('scheduleall', 'scheduleallpass12345');

  const res = await request(app)
    .post('/api/schedules')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'localhost job', playbook: 'deploy.yml', targets: 'localhost', cronExpression: '0 2 * * *' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Target servers not permitted for your role');
});

test('bulk update-all is scoped to servers visible to restricted role', async () => {
  wipeDb();
  await setupAdmin();

  const webId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;
  db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });

  const role = db.roles.create('update-scoped', {
    servers: { servers: [webId], groups: [] },
    canRunUpdates: true,
  });
  const hash = await bcrypt.hash('updatepass12345', 12);
  db.users.create('updateuser', '', hash, role.id);
  const token = await login('updateuser', 'updatepass12345');

  const calls = [];
  const originalRunPlaybook = ansibleRunner.runPlaybook;
  ansibleRunner.runPlaybook = async (playbook, targets) => {
    calls.push({ playbook, targets });
    return { success: false, stdout: '', stderr: '' };
  };

  try {
    const res = await request(app)
      .post('/api/servers/update-all')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ playbook: 'update.yml', targets: 'web-1' }]);
  } finally {
    ansibleRunner.runPlaybook = originalRunPlaybook;
  }
});

test('server endpoints that trigger SSH/polling are capability-gated', async () => {
  wipeDb();
  await setupAdmin();

  const serverId = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] }).id;

  // Create a limited role: can view servers, but cannot view updates and cannot use terminal
  const role = db.roles.create('limited', {
    servers: 'all',
    canViewServers: true,
    canViewUpdates: false,
    canUseTerminal: false,
  });

  const hash = await bcrypt.hash('limitedpass12345', 12);
  db.users.create('limited', '', hash, role.id);

  const limitedToken = await login('limited', 'limitedpass12345');

  // canUseTerminal is false
  const testRes = await request(app)
    .post(`/api/servers/${serverId}/test`)
    .set('Authorization', `Bearer ${limitedToken}`);
  assert.equal(testRes.status, 403);

  // canViewUpdates is false
  const updatesRes = await request(app)
    .get(`/api/servers/${serverId}/updates`)
    .set('Authorization', `Bearer ${limitedToken}`);
  assert.equal(updatesRes.status, 403);
});

test('docker logs accepts dotted container names and rejects option-like names', async () => {
  wipeDb();
  await setupAdmin();

  const srv = db.servers.create({ name: 'srv-logs', hostname: 'srv-logs', ip_address: '10.0.0.12', tags: [], services: [] });
  const role = db.roles.create('docker-logs', {
    servers: 'all',
    canViewDocker: true,
  });
  const hash = await bcrypt.hash('dockerlogspass12345', 12);
  db.users.create('dockerlogs', '', hash, role.id);
  const token = await login('dockerlogs', 'dockerlogspass12345');

  const commands = [];
  const originalRunAdHoc = ansibleRunner.runAdHoc;
  ansibleRunner.runAdHoc = async (_target, _module, command) => {
    commands.push(command);
    return { success: true, stdout: 'hello\n', stderr: '' };
  };

  try {
    const dotted = await request(app)
      .get(`/api/servers/${srv.id}/docker/project.app-1/logs`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(dotted.status, 200);
    assert.equal(commands[0], '$(command -v docker 2>/dev/null || command -v podman 2>/dev/null) logs --tail "200" --timestamps -- "project.app-1" 2>&1');

    const optionLike = await request(app)
      .get(`/api/servers/${srv.id}/docker/-bad/logs`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(optionLike.status, 400);
  } finally {
    ansibleRunner.runAdHoc = originalRunAdHoc;
  }
});

test('admin can disable another user\'s 2FA from user management', async () => {
  wipeDb();
  await setupAdmin();

  const role = db.roles.create('viewer', {
    servers: 'all',
    canViewServers: true,
  });
  const hash = await bcrypt.hash('viewerpass12345', 12);
  const created = db.users.create('viewer2fa', '', hash, role.id);
  db.users.setPendingTotp(created.id, 'PENDING_SECRET');
  db.users.setTotp(created.id, 'ACTIVE_SECRET', true);

  const before = db.users.getByUsername('viewer2fa');
  assert.equal(before.totp_enabled, 1);
  // Stored row must NOT contain the plaintext secret (encrypted at rest);
  // helper returns the decrypted value.
  assert.notEqual(before.totp_secret, 'ACTIVE_SECRET');
  assert.equal(db.users.getTotpSecret(created.id), 'ACTIVE_SECRET');
  assert.equal(before.token_version || 0, 0);

  const adminToken = await login('admin', 'testpass12345');
  const res = await request(app)
    .put(`/api/users/${created.id}/totp-disable`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  const after = db.users.getByUsername('viewer2fa');
  assert.equal(after.totp_enabled, 0);
  assert.equal(after.totp_secret, '');
  assert.equal(after.totp_secret_pending, '');
  assert.equal(after.token_version, 1);
});

test('deploy-all key endpoint is admin-only and returns per-server results', async () => {
  wipeDb();
  await setupAdmin();

  const role = db.roles.create('viewer', {
    servers: 'all',
    canViewServers: true,
  });
  const hash = await bcrypt.hash('viewerpass12345', 12);
  db.users.create('viewer-noadmin', '', hash, role.id);

  const web = db.servers.create({ name: 'web-1', hostname: 'web-1', ip_address: '10.0.0.10', tags: [], services: [] });
  const dbs = db.servers.create({ name: 'db-1', hostname: 'db-1', ip_address: '10.0.0.11', tags: [], services: [] });

  const originalDeploy = sshManager.deployKey.bind(sshManager);
  sshManager.deployKey = async (ip) => {
    if (ip === '10.0.0.10') return { success: true };
    throw new Error('Auth failed');
  };

  try {
    const userToken = await login('viewer-noadmin', 'viewerpass12345');
    const keyInfoForbidden = await request(app)
      .get('/api/system/key')
      .set('Authorization', `Bearer ${userToken}`);
    assert.equal(keyInfoForbidden.status, 403);

    const forbidden = await request(app)
      .post('/api/system/deploy-all')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password: 'pw' });
    assert.equal(forbidden.status, 403);

    const adminToken = await login('admin', 'testpass12345');
    const res = await request(app)
      .post('/api/system/deploy-all')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'pw', serverIds: [web.id, dbs.id] });

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.succeeded, 1);
    assert.equal(res.body.failed, 1);
    assert.equal(Array.isArray(res.body.results), true);
  } finally {
    sshManager.deployKey = originalDeploy;
  }
});

test('DELETE /api/servers/:id/docker/compose/stack validates path parameter and prevents command injection', async () => {
  wipeDb();
  await setupAdmin();

  // Create server and user with canManageDockerCompose capability
  const srv = db.servers.create({ name: 'srv-1', hostname: 'srv-1', ip_address: '10.0.0.12', tags: [], services: [] });
  const composeRole = db.roles.create('compose-manager', {
    servers: 'all',
    canManageDockerCompose: true,
  });
  const hash = await bcrypt.hash('composepass12345', 12);
  db.users.create('composeuser', '', hash, composeRole.id);
  const token = await login('composeuser', 'composepass12345');

  // Stub sshManager.execCommand to record what was executed
  const executedCommands = [];
  const originalExec = sshManager.execCommand;
  sshManager.execCommand = async (server, command) => {
    executedCommands.push({ server, command });
    return { code: 0, stdout: '', stderr: '' };
  };

  try {
    // 1. Rejected payload: injection attempt with semicolon
    const resInjection = await request(app)
      .delete(`/api/servers/${srv.id}/docker/compose/stack?path=/home/user/project; rm -rf /`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(resInjection.status, 400);
    assert.equal(resInjection.body.error, 'Invalid path format');

    // 2. Rejected payload: blocked system directory
    const resBlocked = await request(app)
      .delete(`/api/servers/${srv.id}/docker/compose/stack?path=/etc/nginx`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(resBlocked.status, 400);
    assert.equal(resBlocked.body.error, 'Path not allowed: system directories are protected');

    // 3. Rejected payload: path containing directory traversal
    const resTraversal = await request(app)
      .delete(`/api/servers/${srv.id}/docker/compose/stack?path=/home/user/../etc`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(resTraversal.status, 400);
    assert.equal(resTraversal.body.error, 'Invalid path format');

    db.composeProjects.upsert(srv.id, 'custom_project', '/home/user/stack');
    db.dockerContainers.syncForServer(srv.id, [{
      name: 'custom_project-app-1',
      image: 'demo:latest',
      state: 'running',
      status: 'Up 5 minutes',
      createdAt: '2026-05-29 10:00:00',
      composeProject: 'custom_project',
      composeWorkingDir: '/home/user/stack',
    }]);

    // 4. Accepted payload: valid path, should be executed with single quotes escaping
    const resValid = await request(app)
      .delete(`/api/servers/${srv.id}/docker/compose/stack?path=/home/user/stack`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(resValid.status, 200);
    assert.equal(resValid.body.status, 'deleted');

    // Verify executed command
    assert.equal(executedCommands.length, 1);
    assert.equal(executedCommands[0].command, "cd '/home/user/stack' && docker compose down 2>&1 || true");
    assert.deepEqual(db.composeProjects.getByServer(srv.id), []);
    assert.deepEqual(db.dockerContainers.getByServer(srv.id), []);
  } finally {
    sshManager.execCommand = originalExec;
  }
});
