'use strict';

// Scheduled, encrypted database backups copied to a remote destination with
// rclone. Remotes are defined through environment variables for each call, so
// credentials never land in an rclone config file. Only archives named by
// Fleet are ever deleted at the destination.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cron = require('node-cron');
const db = require('../db');
const cryptoUtil = require('../utils/crypto');
const log = require('../utils/logger').child('backup-targets');
const backupService = require('./database-backup');
const { notify } = require('./notifier');
const { validateExecutableSchedule } = require('../utils/schedule-preview');

const ARCHIVE_RE = /^fleet-database-\d{8}-\d{6}\.backup$/;
const RCLONE_TIMEOUT_MS = 30 * 60 * 1000;
const TYPES = {
  smb: { label: 'SMB / Windows share', fields: ['host', 'share', 'user', 'domain'], secrets: ['pass'], required: ['host', 'share'] },
  sftp: { label: 'SFTP', fields: ['host', 'port', 'user'], secrets: ['pass', 'key_pem'], required: ['host', 'user'] },
  s3: { label: 'S3-compatible', fields: ['provider', 'endpoint', 'region', 'bucket'], secrets: ['access_key_id', 'secret_access_key'], required: ['bucket', 'access_key_id', 'secret_access_key'] },
  drive: { label: 'Google Drive', fields: ['root_folder_id'], secrets: ['token', 'client_id', 'client_secret'], required: ['token'] },
  webdav: { label: 'WebDAV / Nextcloud', fields: ['url', 'vendor', 'user'], secrets: ['pass'], required: ['url'] },
  local: { label: 'Folder in the container', fields: [], secrets: [], required: [] },
};
const S3_PROVIDERS = ['AWS', 'Minio', 'Wasabi', 'Ceph', 'Cloudflare', 'GCS', 'DigitalOcean', 'Other'];
const running = new Set();
const tasks = new Map();

function readSettings(row) {
  try { return JSON.parse(cryptoUtil.decrypt(row.settings) || '{}'); } catch { return {}; }
}

/** Public shape: secrets are reported only as configured or not. */
function publicTarget(row) {
  const settings = readSettings(row);
  const type = TYPES[row.type];
  return {
    id: row.id, name: row.name, type: row.type, remote_path: row.remote_path,
    cron_expression: row.cron_expression, keep_count: row.keep_count, enabled: Boolean(row.enabled),
    settings: Object.fromEntries((type?.fields || []).map(field => [field, settings[field] ?? ''])),
    secrets: Object.fromEntries((type?.secrets || []).map(field => [field, Boolean(settings[field])])),
    passphrase_set: Boolean(row.passphrase),
    last_run_at: row.last_run_at, last_status: row.last_status, last_error: row.last_error, last_file: row.last_file,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

const text = (value, max = 255) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Validate input and merge it with the stored target. Empty secret fields keep
 * the stored value, so editing never requires re-entering credentials.
 */
/** Folder as stored: trimmed, without leading or trailing slashes. A loop, not a regex, keeps long input linear. */
function normalizeRemotePath(value) {
  const path = text(value, 500);
  let start = 0, end = path.length;
  while (start < end && path[start] === '/') start++;
  while (end > start && path[end - 1] === '/') end--;
  return path.slice(start, end);
}

function prepareTarget(input, existing = null) {
  const type = existing ? existing.type : input?.type;
  const spec = TYPES[type];
  if (!spec) return { error: 'Choose a destination type.' };
  const name = text(input.name, 100);
  if (!name) return { error: 'A name is required.' };
  const remotePath = normalizeRemotePath(input.remote_path);
  if (type === 'local' ? !/^\/?[A-Za-z0-9._/-]+$/.test(`/${remotePath}`) || remotePath.includes('..') : /\.\.|[\0\r\n]/.test(remotePath)) {
    return { error: type === 'local' ? 'Enter an absolute folder path inside the container, e.g. /backups.' : 'The folder must not contain "..".' };
  }
  if (type === 'local' && !remotePath) return { error: 'Enter the folder path inside the container.' };
  const cronExpression = text(input.cron_expression, 100);
  try { validateExecutableSchedule(cronExpression, require('./scheduler').getSchedulerTimezone()); }
  catch (error) { return { error: `Schedule: ${error.message}` }; }
  const keep = Number(input.keep_count);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) return { error: 'Keep between 1 and 365 backups.' };

  const previous = existing ? readSettings(existing) : {};
  const settings = {};
  for (const field of spec.fields) settings[field] = text(input.settings?.[field], 500);
  for (const field of spec.secrets) {
    const value = typeof input.secrets?.[field] === 'string' ? input.secrets[field].trim() : '';
    settings[field] = value || previous[field] || '';
  }
  for (const field of spec.required) if (!settings[field]) return { error: `${field.replace(/_/g, ' ')} is required.` };
  if (type === 'sftp' && !settings.pass && !settings.key_pem) return { error: 'Enter a password or a private key for SFTP.' };
  if (type === 'sftp' && settings.port && !/^\d{1,5}$/.test(settings.port)) return { error: 'Enter a valid SFTP port.' };
  if (type === 's3' && settings.provider && !S3_PROVIDERS.includes(settings.provider)) return { error: 'Choose a listed S3 provider.' };
  if (type === 'webdav' && !/^https?:\/\//.test(settings.url)) return { error: 'Enter the WebDAV URL starting with https://.' };
  if (type === 'drive') { try { JSON.parse(settings.token); } catch { return { error: 'Paste the token JSON from "rclone authorize drive".' }; } }

  const passphrase = typeof input.passphrase === 'string' ? input.passphrase : '';
  if (passphrase && (passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024)) return { error: 'The backup passphrase needs at least 12 characters.' };
  if (!passphrase && !existing?.passphrase) return { error: 'Set a backup passphrase.' };

  return {
    row: {
      name, type, remote_path: remotePath, cron_expression: cronExpression, keep_count: keep,
      enabled: input.enabled === undefined ? (existing ? existing.enabled : 1) : (input.enabled ? 1 : 0),
      settings: cryptoUtil.encrypt(JSON.stringify(settings)),
      passphrase: passphrase ? cryptoUtil.encrypt(passphrase) : existing.passphrase,
    },
  };
}

function runRclone(args, env, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), RCLONE_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new Error('rclone is not installed in this Fleet image.') : error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      // rclone logs "ERROR : ..." lines; the last one names the cause.
      const reason = stderr.split('\n').map(line => line.replace(/^.*?(ERROR|Failed to [a-z]+)\s*:?\s*/, '$1: ').trim()).filter(Boolean).pop();
      reject(new Error(reason ? reason.slice(0, 400) : `rclone exited with code ${code}`));
    });
    child.stdin.end(input || '');
  });
}

async function obscure(value) {
  return (await runRclone(['obscure', '-'], baseEnv(), { input: value })).trim();
}

function baseEnv() {
  return { PATH: process.env.PATH, HOME: os.tmpdir(), RCLONE_CONFIG: path.join(os.tmpdir(), 'fleet-rclone-none.conf') };
}

/** Environment defining the remote "fleet" plus the path of the backup folder on it. */
async function remoteFor(row) {
  const s = readSettings(row);
  const env = baseEnv();
  const set = (key, value) => { if (value !== undefined && value !== '') env[`RCLONE_CONFIG_FLEET_${key.toUpperCase()}`] = String(value); };
  let root = row.remote_path;
  switch (row.type) {
    case 'smb':
      set('type', 'smb'); set('host', s.host); set('user', s.user); set('domain', s.domain);
      if (s.pass) set('pass', await obscure(s.pass));
      root = [s.share, row.remote_path].filter(Boolean).join('/');
      break;
    case 'sftp':
      set('type', 'sftp'); set('host', s.host); set('port', s.port); set('user', s.user);
      if (s.pass) set('pass', await obscure(s.pass));
      if (s.key_pem) set('key_pem', s.key_pem.replace(/\r?\n/g, '\\n'));
      break;
    case 's3':
      set('type', 's3'); set('provider', s.provider || 'Other'); set('endpoint', s.endpoint); set('region', s.region);
      set('access_key_id', s.access_key_id); set('secret_access_key', s.secret_access_key);
      root = [s.bucket, row.remote_path].filter(Boolean).join('/');
      break;
    case 'drive':
      set('type', 'drive'); set('scope', 'drive.file'); set('token', s.token); set('root_folder_id', s.root_folder_id);
      set('client_id', s.client_id); set('client_secret', s.client_secret);
      break;
    case 'webdav':
      set('type', 'webdav'); set('url', s.url); set('vendor', s.vendor || 'other'); set('user', s.user);
      if (s.pass) set('pass', await obscure(s.pass));
      break;
    case 'local':
      set('type', 'local');
      root = `/${row.remote_path}`;
      break;
    default:
      throw new Error('Unknown destination type.');
  }
  return { env, remote: `fleet:${root}` };
}

async function testTarget(row) {
  const { env, remote } = await remoteFor(row);
  await runRclone(['mkdir', remote], env);
  const entries = JSON.parse(await runRclone(['lsjson', '--files-only', remote], env) || '[]');
  return { reachable: true, backups: entries.filter(entry => ARCHIVE_RE.test(entry.Name)).length };
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function pruneArchives(row, env, remote) {
  const entries = JSON.parse(await runRclone(['lsjson', '--files-only', remote], env) || '[]');
  const stale = entries.map(entry => entry.Name).filter(name => ARCHIVE_RE.test(name)).sort().reverse().slice(row.keep_count);
  for (const name of stale) await runRclone(['deletefile', `${remote}/${name}`], env);
  return stale;
}

/** Create, verify and upload one archive, then apply retention. */
async function runBackup(id, { actor = 'scheduler', ip = null } = {}) {
  if (running.has(id)) throw Object.assign(new Error('A backup to this destination is already running.'), { status: 409 });
  const row = db.backupTargets.getById(id);
  if (!row) throw Object.assign(new Error('Backup destination not found.'), { status: 404 });
  running.add(id);
  db.backupTargets.setResult(id, 'running', null, null);
  let dir;
  try {
    const passphrase = cryptoUtil.decrypt(row.passphrase);
    if (!passphrase || passphrase.startsWith('enc:')) throw new Error('The backup passphrase cannot be read with the current FLEET_KEY_SECRET.');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-target-'));
    const file = `fleet-database-${stamp()}.backup`;
    const archive = path.join(dir, file);
    const info = await backupService.createEncryptedDatabaseBackup(db.db, archive, passphrase);
    await backupService.verifyEncryptedDatabaseBackup(archive, passphrase);
    const { env, remote } = await remoteFor(row);
    await runRclone(['copyto', archive, `${remote}/${file}`], env);
    let removed = [];
    try { removed = await pruneArchives(row, env, remote); }
    catch (error) { log.warn({ err: error, target: row.name }, 'Old backups could not be removed'); }
    db.backupTargets.setResult(id, 'success', null, file);
    db.auditLog.write('backup.target_run', `Encrypted database backup uploaded to "${row.name}"; file=${file}; bytes=${info.bytes}; removed=${removed.length}`, ip, true, actor);
    return { file, bytes: info.bytes, removed };
  } catch (error) {
    const message = String(error.message || 'Backup failed').slice(0, 500);
    db.backupTargets.setResult(id, 'failed', message, null);
    db.auditLog.write('backup.target_run', `Backup to "${row.name}" failed: ${message}`, ip, false, actor);
    notify(`Fleet backup failed: ${row.name}`, message, false).catch(() => {});
    throw error;
  } finally {
    running.delete(id);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function register(row) {
  tasks.get(row.id)?.stop();
  tasks.delete(row.id);
  if (!row.enabled) return;
  const task = cron.schedule(row.cron_expression, () => {
    runBackup(row.id).catch(error => log.error({ err: error, target: row.name }, 'Scheduled backup failed'));
  }, { timezone: require('./scheduler').getSchedulerTimezone() });
  tasks.set(row.id, task);
}

function reload() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
  for (const row of db.backupTargets.getAll()) {
    try { register(row); } catch (error) { log.error({ err: error, target: row.name }, 'Backup schedule could not be registered'); }
  }
}

function unregister(id) {
  tasks.get(id)?.stop();
  tasks.delete(id);
}

module.exports = { ARCHIVE_RE, S3_PROVIDERS, TYPES, normalizeRemotePath, prepareTarget, publicTarget, register, reload, remoteFor, runBackup, stamp, testTarget, unregister };
