'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_backup_targets_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-backup-targets';
process.env.FLEET_KEY_SECRET = 'test-key-secret-backup-targets-0123456789';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const { testLimiter } = require('../utils/rate-limiters');
const targets = require('../services/backup-targets');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', testLimiter, authMiddleware);
app.use('/api/system/backup-targets', require('../routes/backup-targets'));

let token;
const auth = req => req.set('Authorization', `Bearer ${token}`);
const s3 = { name: 'Offsite', type: 's3', remote_path: '/fleet/', cron_expression: '30 2 * * *', keep_count: 7, settings: { provider: 'Other', endpoint: 'https://s3.example.com', bucket: 'backups' }, secrets: { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'super-secret-key' }, passphrase: 'correct horse battery' };

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  token = (await request(app).post('/api/auth/login').send({ password: 'testpass12345' })).body.token;
});

after(() => {
  targets.reload = () => {};
  for (const row of db.backupTargets.getAll()) targets.unregister(row.id);
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {} }
});

test('creating a destination requires the account password and never returns secrets', async () => {
  assert.equal((await auth(request(app).post('/api/system/backup-targets')).send(s3)).status, 400);
  assert.equal((await auth(request(app).post('/api/system/backup-targets')).send({ ...s3, password: 'wrong' })).status, 403);
  const created = await auth(request(app).post('/api/system/backup-targets')).send({ ...s3, password: 'testpass12345' });
  assert.equal(created.status, 201);
  assert.equal(created.body.remote_path, 'fleet');
  assert.deepEqual(created.body.secrets, { access_key_id: true, secret_access_key: true });
  const listed = await auth(request(app).get('/api/system/backup-targets'));
  const serialized = JSON.stringify(listed.body);
  for (const secret of ['super-secret-key', 'AKIDEXAMPLE', 'correct horse battery']) assert.ok(!serialized.includes(secret));
  const stored = db.backupTargets.getById(created.body.id);
  assert.ok(stored.settings.startsWith('enc:') && stored.passphrase.startsWith('enc:'));
  targets.unregister(created.body.id);
});

test('editing the schedule keeps stored secrets; changing the destination asks for the password again', async () => {
  const id = db.backupTargets.getAll()[0].id;
  const kept = await auth(request(app).put(`/api/system/backup-targets/${id}`)).send({ ...s3, secrets: {}, passphrase: '', keep_count: 3 });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.keep_count, 3);
  const { env, remote } = await targets.remoteFor(db.backupTargets.getById(id));
  assert.equal(remote, 'fleet:backups/fleet');
  assert.equal(env.RCLONE_CONFIG_FLEET_SECRET_ACCESS_KEY, 'super-secret-key');
  assert.equal(env.RCLONE_CONFIG_FLEET_ENDPOINT, 'https://s3.example.com');
  const moved = await auth(request(app).put(`/api/system/backup-targets/${id}`)).send({ ...s3, settings: { ...s3.settings, bucket: 'elsewhere' }, secrets: {}, passphrase: '' });
  assert.equal(moved.status, 400);
  targets.unregister(id);
});

test('destination input is validated and archive names are recognised', () => {
  assert.match(targets.prepareTarget({ ...s3, cron_expression: 'nope' }).error, /Schedule/);
  assert.match(targets.prepareTarget({ ...s3, type: 'local', remote_path: '../etc' }).error, /folder/i);
  assert.match(targets.prepareTarget({ ...s3, type: 'drive', secrets: { token: 'not json' } }).error, /token/i);
  assert.match(targets.prepareTarget({ ...s3, passphrase: 'short' }).error, /passphrase/);
  const name = `fleet-database-${targets.stamp(new Date('2026-09-26T14:05:33Z'))}.backup`;
  assert.equal(name, 'fleet-database-20260926-140533.backup');
  assert.ok(targets.ARCHIVE_RE.test(name));
  assert.ok(!targets.ARCHIVE_RE.test('my-notes.backup'));
});

const hasRclone = require('node:child_process').spawnSync('rclone', ['version']).status === 0;
test('the destination folder is trimmed of slashes in linear time', () => {
  assert.equal(targets.normalizeRemotePath(' //fleet/nightly// '), 'fleet/nightly');
  assert.equal(targets.normalizeRemotePath('///'), '');
  assert.equal(targets.normalizeRemotePath(undefined), '');
  const started = process.hrtime.bigint();
  assert.equal(targets.normalizeRemotePath(`x${'/'.repeat(100000)}`), 'x');
  assert.ok(process.hrtime.bigint() - started < 100_000_000n);
});

test('a run uploads a verified archive and keeps only the newest ones', { skip: !hasRclone && 'rclone is not installed' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-target-test-'));
  fs.writeFileSync(path.join(folder, 'fleet-database-20000101-000000.backup'), 'old');
  fs.writeFileSync(path.join(folder, 'fleet-database-20000102-000000.backup'), 'old');
  fs.writeFileSync(path.join(folder, 'unrelated.txt'), 'keep me');
  const { row } = targets.prepareTarget({ name: 'Local', type: 'local', remote_path: folder, cron_expression: '30 2 * * *', keep_count: 2, passphrase: 'correct horse battery', enabled: false });
  const created = db.backupTargets.create(row);
  assert.deepEqual(await targets.testTarget(created), { reachable: true, backups: 2 });
  const result = await targets.runBackup(created.id, { actor: 'test' });
  assert.deepEqual(result.removed, ['fleet-database-20000101-000000.backup']);
  const files = fs.readdirSync(folder).sort();
  assert.deepEqual(files, ['fleet-database-20000102-000000.backup', result.file, 'unrelated.txt'].sort());
  await require('../services/database-backup').verifyEncryptedDatabaseBackup(path.join(folder, result.file), 'correct horse battery');
  assert.equal(db.backupTargets.getById(created.id).last_status, 'success');
  fs.rmSync(folder, { recursive: true, force: true });
});
