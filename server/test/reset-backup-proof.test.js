'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const {createEncryptedDatabaseBackup} = require('../services/database-backup');
const {createApplicationBackup} = require('../services/application-backup');
const {resetBackupState, verifyResetBackup} = require('../services/reset-backup-proof');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-backup-proof-'));
const database = new Database(path.join(root, 'source.db'));
database.exec('CREATE TABLE users (id TEXT, token_version INTEGER); CREATE TABLE app_settings (key TEXT, value TEXT); CREATE TABLE environments (id TEXT); CREATE TABLE schedules (id TEXT, environment_id TEXT, name TEXT); CREATE TABLE schedule_history (id TEXT, environment_id TEXT, status TEXT); CREATE TABLE audit_log (action TEXT)');
database.exec("INSERT INTO environments VALUES ('a'), ('b'); INSERT INTO schedules VALUES ('one','a','Daily'), ('two','b','Weekly')");
database.exec('CREATE TABLE servers (id TEXT, environment_id TEXT); CREATE TABLE server_groups (id TEXT, environment_id TEXT); CREATE TABLE update_history (id TEXT, environment_id TEXT); CREATE TABLE operation_acknowledgements (id TEXT)');
const hostChildren = ['server_info', 'docker_containers', 'compose_projects', 'server_updates_cache', 'docker_image_updates_cache', 'docker_image_check_exclusions', 'custom_update_tasks', 'agent_config', 'agent_metrics', 'server_alert_settings', 'resource_alerts', 'server_note_revisions', 'ipam_reservations'];
for (const table of hostChildren) database.exec(`CREATE TABLE ${table} (server_id TEXT, value TEXT); INSERT INTO ${table} VALUES ('host-a','original'), ('host-b','original')`);
database.exec("INSERT INTO servers VALUES ('host-a','a'), ('host-b','b'); INSERT INTO users VALUES ('admin', 1); INSERT INTO app_settings VALUES ('auth_jwt_secret','synthetic')");
const playbooksDirectory = path.join(root, 'playbooks');
fs.mkdirSync(playbooksDirectory);
fs.writeFileSync(path.join(playbooksDirectory, 'run.yml'), 'original');
const passphrase = 'Synthetic reset archive password';
after(() => { database.close(); fs.rmSync(root, {recursive: true, force: true}); });
const target = {database, action: 'schedules', environmentId: 'a', playbooksDirectory};

test('authenticated backup matches selected scope; audit and other-environment activity do not invalidate it', async () => {
  const filename = path.join(root, 'schedules.backup');
  await createEncryptedDatabaseBackup(database, filename, passphrase);
  database.exec("INSERT INTO audit_log VALUES ('backup.verified'); UPDATE schedules SET name='Other change' WHERE environment_id='b'");
  const proof = await verifyResetBackup({...target, filename, passphrase, format: 'database'});
  assert.equal(proof.scope, 'a');
  assert.equal(proof.fingerprint, resetBackupState(target));
  await assert.rejects(verifyResetBackup({...target, filename, passphrase: 'Wrong synthetic password', format: 'database'}), /authentication failed/);
  database.exec("UPDATE schedules SET name='Changed' WHERE environment_id='a'");
  await assert.rejects(verifyResetBackup({...target, filename, passphrase, format: 'database'}), /does not match/);
  assert.notEqual(proof.fingerprint, resetBackupState(target));
  database.exec("UPDATE schedules SET name='Daily' WHERE environment_id='a'");
});

test('new history since backup is detected even when schedule configuration is unchanged', async () => {
  const filename = path.join(root, 'history.backup');
  await createEncryptedDatabaseBackup(database, filename, passphrase);
  database.exec("INSERT INTO schedule_history VALUES ('run','a','success')");
  await assert.rejects(verifyResetBackup({...target, filename, passphrase, format: 'database'}), /does not match/);
});

test('playbook reset requires authenticated application files and rejects content changes and omitted roots', async () => {
  const filename = path.join(root, 'application.backup');
  const options = {database, destination: filename, passphrase, offline: true, roots: [{id: 'playbooks', path: playbooksDirectory, required: true}]};
  await createApplicationBackup(options);
  const request = {...target, action: 'playbooks', filename, passphrase, format: 'application'};
  const proof = await verifyResetBackup(request);
  assert.equal(proof.scope, 'all-environments');
  await assert.rejects(verifyResetBackup({...request, format: 'database'}), /requires an application backup/);
  fs.writeFileSync(path.join(playbooksDirectory, 'run.yml'), 'changed');
  await assert.rejects(verifyResetBackup(request), /does not match/);
  fs.writeFileSync(path.join(playbooksDirectory, 'run.yml'), 'original');
  const omitted = path.join(root, 'omitted.backup');
  await createApplicationBackup({...options, destination: omitted, roots: []});
  await assert.rejects(verifyResetBackup({...request, filename: omitted}), /must include/);
  assert.equal(fs.readFileSync(path.join(playbooksDirectory, 'run.yml'), 'utf8'), 'original');
});

test('unknown actions and absent environment scope cannot produce proof', () => {
  assert.throws(() => resetBackupState({...target, action: 'unexpected'}), /Unknown reset/);
  assert.throws(() => resetBackupState({...target, environmentId: ''}), /environment is required/);
});

test('host proof covers every deleted child table while excluding another environment', () => {
  const hosts = {...target, action: 'servers'};
  const initial = resetBackupState(hosts);
  for (const table of hostChildren) {
    database.prepare(`UPDATE ${table} SET value='other' WHERE server_id='host-b'`).run();
    assert.equal(resetBackupState(hosts), initial);
    database.prepare(`UPDATE ${table} SET value='changed' WHERE server_id='host-a'`).run();
    assert.notEqual(resetBackupState(hosts), initial, table);
    database.prepare(`UPDATE ${table} SET value='original' WHERE server_id='host-a'`).run();
  }
  for (const table of ['server_groups', 'update_history']) {
    database.prepare(`INSERT INTO ${table} VALUES ('new','a')`).run();
    assert.notEqual(resetBackupState(hosts), initial, table);
    database.prepare(`DELETE FROM ${table} WHERE id='new'`).run();
  }
});

test('account and combined reset proofs include credentials, settings and acknowledgement data', async () => {
  const filename = path.join(root, 'combined.backup');
  await createApplicationBackup({database, destination: filename, passphrase, offline: true, roots: [{id: 'playbooks', path: playbooksDirectory, required: true}]});
  const request = {...target, action: 'all', filename, passphrase, format: 'application'};
  const proof = await verifyResetBackup(request);
  const auth = {...target, action: 'auth'};
  const initialAuth = resetBackupState(auth);
  database.exec('UPDATE users SET token_version=2');
  assert.notEqual(resetBackupState(auth), initialAuth);
  await assert.rejects(verifyResetBackup(request), /does not match/);
  database.exec('UPDATE users SET token_version=1');
  database.exec("UPDATE app_settings SET value='changed'");
  assert.notEqual(resetBackupState(auth), initialAuth);
  database.exec("UPDATE app_settings SET value='synthetic'");
  database.exec("INSERT INTO operation_acknowledgements VALUES ('new')");
  assert.notEqual(resetBackupState({...target, action: 'all'}), proof.fingerprint);
  await assert.rejects(verifyResetBackup(request), /does not match/);
});
