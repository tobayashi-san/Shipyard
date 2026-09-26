'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const Database = require('better-sqlite3');
const {withVerifiedDatabaseBackup} = require('./database-backup');
const {withVerifiedApplicationBackup} = require('./application-backup');

const actions = new Set(['servers', 'schedules', 'playbooks', 'auth', 'all']);
const hostChildren = ['server_info', 'docker_containers', 'compose_projects', 'server_updates_cache', 'docker_image_updates_cache', 'docker_image_check_exclusions', 'custom_update_tasks', 'agent_config', 'agent_metrics', 'server_alert_settings', 'resource_alerts', 'server_note_revisions', 'ipam_reservations'];
const hash = value => createHash('sha256').update(value).digest('hex');

function playbookState(directory) {
  let names;
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.some(name => name.startsWith('.fleet-reset-'))) throw Error('Interrupted playbook reset requires recovery before backup comparison');
  return names.filter(name => /\.ya?ml$/.test(name)).sort().map(name => {
    const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw Error('Reset requires regular user playbook files');
      return [name, hash(fs.readFileSync(fd))];
    } finally { fs.closeSync(fd); }
  });
}

// The fingerprint covers data removed by the selected reset, not volatile audit
// entries written by backup verification. Call again immediately before deletion.
function resetBackupState({database, action, environmentId, playbooksDirectory}) {
  if (!actions.has(action)) throw Error('Unknown reset action');
  const scoped = action === 'servers' || action === 'schedules';
  if (scoped && (typeof environmentId !== 'string' || !environmentId)) throw Error('Reset environment is required');
  const tables = database.transaction(() => {
    const result = [];
    const rows = (table, where = '', args = []) => {
      const values = database.prepare(`SELECT * FROM ${table} ${where}`).all(...args);
      // Sort serialized complete rows, independent of insertion order and PK shape.
      result.push([table, values.map(row => JSON.stringify(row)).sort()]);
    };
    if (action === 'servers' || action === 'all') {
      const condition = scoped ? 'WHERE environment_id = ?' : '';
      const args = scoped ? [environmentId] : [];
      for (const table of ['servers', 'server_groups', 'update_history']) rows(table, condition, args);
      for (const table of hostChildren) rows(table, scoped ? 'WHERE server_id IN (SELECT id FROM servers WHERE environment_id = ?)' : '', args);
    }
    if (action === 'schedules' || action === 'all') {
      for (const table of ['schedules', 'schedule_history']) rows(table, scoped ? 'WHERE environment_id = ?' : '', scoped ? [environmentId] : []);
    }
    if (action === 'auth' || action === 'all') {
      rows('users');
      rows('app_settings', "WHERE key <> 'reset_database_id' AND key NOT LIKE 'reset_commit:%'");
    }
    if (action === 'all') rows('operation_acknowledgements');
    return result;
  })();
  const files = action === 'playbooks' || action === 'all' ? playbookState(playbooksDirectory) : [];
  return hash(JSON.stringify({action, scope: scoped ? environmentId : 'all-environments', tables, files}));
}

async function verifyResetBackup({filename, passphrase, format, ...target}) {
  const requiresFiles = target.action === 'playbooks' || target.action === 'all';
  if (!['database', 'application'].includes(format)) throw Error('Unsupported backup format');
  if (requiresFiles && format !== 'application') throw Error('This reset requires an application backup containing user playbook files');
  const compare = (snapshot, directory) => {
    const archived = new Database(snapshot, {readonly: true, fileMustExist: true});
    try {
      const expected = resetBackupState({...target, database: archived, playbooksDirectory: directory});
      const current = resetBackupState(target);
      if (expected !== current) throw Error('Backup does not match the current reset data. Create and verify a new backup before continuing.');
      return {action: target.action, scope: ['servers', 'schedules'].includes(target.action) ? target.environmentId : 'all-environments', fingerprint: current, verifiedAt: new Date().toISOString()};
    } finally { archived.close(); }
  };
  if (format === 'database') return withVerifiedDatabaseBackup(filename, passphrase, snapshot => compare(snapshot));
  return withVerifiedApplicationBackup(filename, passphrase, (contents, manifest) => {
    const root = manifest.roots.find(root => root.id === 'playbooks');
    if (requiresFiles && root?.status !== 'included') throw Error('Application backup must include the user playbooks root');
    return withVerifiedDatabaseBackup(path.join(contents, 'database.backup'), passphrase,
      snapshot => compare(snapshot, path.join(contents, 'files', 'playbooks')));
  });
}

module.exports = {resetBackupState, verifyResetBackup};
