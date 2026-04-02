const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const log = require('./utils/logger').child('db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'shipyard.db');

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    ssh_port INTEGER DEFAULT 22,
    ssh_user TEXT DEFAULT 'root',
    tags TEXT DEFAULT '[]',
    services TEXT DEFAULT '[]',
    storage_mounts TEXT DEFAULT '[]',
    status TEXT DEFAULT 'unknown',
    last_seen TEXT,
    notes TEXT NOT NULL DEFAULT '',
    group_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS server_info (
    server_id TEXT PRIMARY KEY,
    os TEXT,
    kernel TEXT,
    cpu TEXT,
    cpu_cores INTEGER,
    ram_total_mb INTEGER,
    ram_used_mb INTEGER,
    disk_total_gb REAL,
    disk_used_gb REAL,
    storage_mount_metrics TEXT DEFAULT '[]',
    uptime_seconds INTEGER,
    load_avg TEXT,
    reboot_required BOOLEAN DEFAULT 0,
    cpu_usage_pct REAL DEFAULT NULL,
    zfs_pools TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS update_history (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    output TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ssh_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    private_key_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS docker_containers (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    image TEXT NOT NULL,
    state TEXT,
    status TEXT,
    created_at_container TEXT,
    compose_project TEXT,
    compose_working_dir TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS compose_projects (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(server_id, project_name),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    playbook TEXT NOT NULL,
    targets TEXT DEFAULT 'all',
    cron_expression TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    last_status TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Indexes for foreign keys and common queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_server_info_server_id      ON server_info(server_id);
  CREATE INDEX IF NOT EXISTS idx_update_history_server_id   ON update_history(server_id);
  CREATE INDEX IF NOT EXISTS idx_update_history_started_at  ON update_history(started_at);
  CREATE INDEX IF NOT EXISTS idx_docker_containers_server   ON docker_containers(server_id);
  CREATE INDEX IF NOT EXISTS idx_compose_projects_server    ON compose_projects(server_id);
`);

// Updates cache table
db.exec(`
  CREATE TABLE IF NOT EXISTS server_updates_cache (
    server_id TEXT PRIMARY KEY,
    updates_json TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Docker image updates cache
db.exec(`
  CREATE TABLE IF NOT EXISTS docker_image_updates_cache (
    server_id TEXT PRIMARY KEY,
    results_json TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Custom update tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_update_tasks (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'script',
    check_command TEXT,
    github_repo TEXT,
    update_command TEXT NOT NULL,
    trigger_output TEXT,
    last_version TEXT,
    current_version TEXT,
    has_update INTEGER DEFAULT 0,
    last_checked_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_custom_update_tasks_server ON custom_update_tasks(server_id);
`);

// Agent system tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_config (
    server_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'legacy',
    token TEXT,
    shipyard_url TEXT,
    interval INTEGER DEFAULT 30,
    installed_at TEXT,
    last_seen TEXT,
    runner_version TEXT,
    last_manifest_version INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT,
    changelog TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    manifest_v INTEGER,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_metrics_server_ts ON agent_metrics(server_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_metrics_ts ON agent_metrics(timestamp);
`);

// Forward-compatible additive migrations for existing installs
try { db.exec('ALTER TABLE agent_config ADD COLUMN shipyard_url TEXT'); } catch {}
try { db.exec('ALTER TABLE servers ADD COLUMN storage_mounts TEXT DEFAULT \'[]\''); } catch {}
try { db.exec('ALTER TABLE server_info ADD COLUMN storage_mount_metrics TEXT DEFAULT \'[]\''); } catch {}
try { db.exec('ALTER TABLE custom_update_tasks ADD COLUMN trigger_output TEXT'); } catch {}
try { db.exec('ALTER TABLE server_info ADD COLUMN zfs_pools TEXT DEFAULT \'[]\''); } catch {}

// App settings table
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// Audit log
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    detail TEXT,
    user TEXT,
    ip TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);`);
// Migration: add user column if missing (pre-1.0.3 DBs)
try { db.exec(`ALTER TABLE audit_log ADD COLUMN user TEXT`); } catch {}
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user);`);


// Schedule execution history
db.exec(`
  CREATE TABLE IF NOT EXISTS schedule_history (
    id TEXT PRIMARY KEY,
    schedule_id TEXT,
    schedule_name TEXT NOT NULL,
    playbook TEXT NOT NULL,
    targets TEXT DEFAULT 'all',
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT DEFAULT 'running',
    output TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_history_started  ON schedule_history(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_schedule_history_sched_id ON schedule_history(schedule_id);
`);

// Ansible variables (global extra_vars injected into every playbook run)
db.exec(`
  CREATE TABLE IF NOT EXISTS ansible_vars (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    parent_id TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    totp_secret TEXT DEFAULT '',
    totp_enabled INTEGER DEFAULT 0,
    totp_secret_pending TEXT DEFAULT '',
    token_version INTEGER DEFAULT 0,
    display_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);


// Roles table
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    is_system INTEGER DEFAULT 0,
    permissions TEXT DEFAULT '{}'
  );
`);

// Seed built-in roles
(function seedRoles() {
  try {
    const adminPerm = JSON.stringify({ full: true });
    const userPerm  = JSON.stringify({
      servers: 'all', playbooks: 'all', plugins: 'all',
      canViewServers: true, canAddServers: true, canEditServers: true, canDeleteServers: true,
      canViewPlaybooks: true, canEditPlaybooks: true, canDeletePlaybooks: true, canRunPlaybooks: true,
      canViewSchedules: true, canAddSchedules: true, canEditSchedules: true, canDeleteSchedules: true, canToggleSchedules: true,
      canViewVars: true, canAddVars: true, canEditVars: true, canDeleteVars: true,
      canViewAudit: true,
    });
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, is_system, permissions) VALUES ('admin', 'Admin', 1, ?)`).run(adminPerm);
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, is_system, permissions) VALUES ('user', 'User', 1, ?)`).run(userPerm);
  } catch (e) { log.error({ err: e }, 'Role seed error'); }
})();

// Migration: if users table is empty AND auth_password_hash contains a real hash,
// create the legacy admin user from settings.
(function migrateAdminUser() {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (userCount > 0) return;
    const hash = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_password_hash'").get();
    if (!hash || !String(hash.value || '').trim()) return;
    const usernameRow = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_username'").get();
    const emailRow    = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_email'").get();
    const totpSecretRow  = db.prepare("SELECT value FROM app_settings WHERE key = 'totp_secret'").get();
    const totpEnabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'totp_enabled'").get();
    const id = uuidv4();
    const username = (usernameRow && usernameRow.value) ? usernameRow.value : 'admin';
    const email    = (emailRow    && emailRow.value)    ? emailRow.value    : '';
    const totpSecret  = (totpSecretRow  && totpSecretRow.value)  ? totpSecretRow.value  : '';
    const totpEnabled = (totpEnabledRow && totpEnabledRow.value === '1') ? 1 : 0;
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, totp_secret, totp_enabled)
      VALUES (?, ?, ?, ?, 'admin', ?, ?)
    `).run(id, username, email, hash.value, totpSecret, totpEnabled);
    log.info('Migrated admin user from settings to users table');
  } catch (e) {
    log.error({ err: e }, 'Admin migration error');
  }
})();

// Server CRUD
const serverQueries = {
  getAll: db.prepare('SELECT * FROM servers ORDER BY name'),
  getById: db.prepare('SELECT * FROM servers WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO servers (id, name, hostname, ip_address, ssh_port, ssh_user, tags, services, storage_mounts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE servers SET name = ?, hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, tags = ?, services = ?, storage_mounts = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM servers WHERE id = ?'),
  updateStatus: db.prepare(`UPDATE servers SET status = ? WHERE id = ?`),
  updateStatusOnline: db.prepare(`UPDATE servers SET status = ?, last_seen = datetime('now') WHERE id = ?`),
};

// Server Info
const infoQueries = {
  get: db.prepare('SELECT * FROM server_info WHERE server_id = ?'),
  upsert: db.prepare(`
    INSERT INTO server_info (server_id, os, kernel, cpu, cpu_cores, ram_total_mb, ram_used_mb, disk_total_gb, disk_used_gb, storage_mount_metrics, uptime_seconds, load_avg, reboot_required, cpu_usage_pct, zfs_pools, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(server_id) DO UPDATE SET
      os = excluded.os, kernel = excluded.kernel, cpu = excluded.cpu, cpu_cores = excluded.cpu_cores,
      ram_total_mb = excluded.ram_total_mb, ram_used_mb = excluded.ram_used_mb,
      disk_total_gb = excluded.disk_total_gb, disk_used_gb = excluded.disk_used_gb,
      storage_mount_metrics = excluded.storage_mount_metrics,
      uptime_seconds = excluded.uptime_seconds, load_avg = excluded.load_avg,
      reboot_required = excluded.reboot_required,
      cpu_usage_pct = excluded.cpu_usage_pct,
      zfs_pools = excluded.zfs_pools,
      updated_at = datetime('now')
  `),
};

// Update History
const historyQueries = {
  getByServer: db.prepare('SELECT * FROM update_history WHERE server_id = ? ORDER BY started_at DESC LIMIT 20'),
  insert: db.prepare('INSERT INTO update_history (id, server_id, action, status) VALUES (?, ?, ?, ?)'),
  updateStatus: db.prepare(`UPDATE update_history SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?`),
};

// SSH Keys
const sshKeyQueries = {
  getAll: db.prepare('SELECT id, name, public_key, created_at FROM ssh_keys'),
  getFirst: db.prepare('SELECT * FROM ssh_keys LIMIT 1'),
  insert: db.prepare('INSERT INTO ssh_keys (id, name, public_key, private_key_path) VALUES (?, ?, ?, ?)'),
  deleteAll: db.prepare('DELETE FROM ssh_keys'),
};

// Docker Containers
const dockerContainerQueries = {
  getByServer: db.prepare('SELECT * FROM docker_containers WHERE server_id = ? ORDER BY container_name'),
  clearForServer: db.prepare('DELETE FROM docker_containers WHERE server_id = ?'),
  insert: db.prepare(`
    INSERT INTO docker_containers (id, server_id, container_name, image, state, status, created_at_container, compose_project, compose_working_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
};

const composeProjectQueries = {
  getByServer: db.prepare('SELECT * FROM compose_projects WHERE server_id = ? ORDER BY project_name'),
  getByServerAndPath: db.prepare('SELECT * FROM compose_projects WHERE server_id = ? AND working_dir = ? LIMIT 1'),
  upsert: db.prepare(`
    INSERT INTO compose_projects (id, server_id, project_name, working_dir)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id, project_name) DO UPDATE SET
      working_dir = excluded.working_dir,
      updated_at = datetime('now')
  `),
  delete: db.prepare('DELETE FROM compose_projects WHERE server_id = ? AND project_name = ?')
};

const agentConfigQueries = {
  getByServerId: db.prepare('SELECT * FROM agent_config WHERE server_id = ?'),
  getAll: db.prepare('SELECT * FROM agent_config'),
  upsert: db.prepare(`
    INSERT INTO agent_config (server_id, mode, token, shipyard_url, interval, installed_at, last_seen, runner_version, last_manifest_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(server_id) DO UPDATE SET
      mode = excluded.mode,
      token = excluded.token,
      shipyard_url = COALESCE(excluded.shipyard_url, agent_config.shipyard_url),
      interval = excluded.interval,
      installed_at = COALESCE(excluded.installed_at, agent_config.installed_at),
      last_seen = COALESCE(excluded.last_seen, agent_config.last_seen),
      runner_version = COALESCE(excluded.runner_version, agent_config.runner_version),
      last_manifest_version = COALESCE(excluded.last_manifest_version, agent_config.last_manifest_version),
      updated_at = datetime('now')
  `),
  setSeen: db.prepare(`
    UPDATE agent_config
    SET last_seen = datetime('now'),
        runner_version = COALESCE(?, runner_version),
        last_manifest_version = COALESCE(?, last_manifest_version),
        updated_at = datetime('now')
    WHERE server_id = ?
  `),
  updateModeInterval: db.prepare(`
    UPDATE agent_config
    SET mode = ?, interval = ?, shipyard_url = COALESCE(?, shipyard_url), updated_at = datetime('now')
    WHERE server_id = ?
  `),
  setToken: db.prepare('UPDATE agent_config SET token = ?, updated_at = datetime(\'now\') WHERE server_id = ?'),
  delete: db.prepare('DELETE FROM agent_config WHERE server_id = ?'),
};

const agentManifestQueries = {
  getLatest: db.prepare('SELECT * FROM agent_manifests ORDER BY version DESC LIMIT 1'),
  getByVersion: db.prepare('SELECT * FROM agent_manifests WHERE version = ?'),
  listRecent: db.prepare('SELECT id, version, created_at, created_by, changelog FROM agent_manifests ORDER BY version DESC LIMIT ?'),
  insert: db.prepare('INSERT INTO agent_manifests (version, content, created_by, changelog) VALUES (?, ?, ?, ?)'),
};

const agentMetricsQueries = {
  insert: db.prepare('INSERT INTO agent_metrics (server_id, timestamp, manifest_v, data) VALUES (?, ?, ?, ?)'),
  recentByServer: db.prepare('SELECT * FROM agent_metrics WHERE server_id = ? ORDER BY timestamp DESC LIMIT ?'),
  pruneOlderThan: db.prepare('DELETE FROM agent_metrics WHERE timestamp < ?'),
};

module.exports = {
  db,
  uuidv4,
  servers: {
    getAll: () => serverQueries.getAll.all(),
    getById: (id) => serverQueries.getById.get(id),
    create: (server) => {
      const id = uuidv4();
      serverQueries.insert.run(
        id,
        server.name,
        server.hostname,
        server.ip_address,
        server.ssh_port || 22,
        server.ssh_user || 'root',
        JSON.stringify(server.tags || []),
        JSON.stringify(server.services || []),
        JSON.stringify(server.storage_mounts || [])
      );
      return serverQueries.getById.get(id);
    },
    update: (id, server) => {
      serverQueries.update.run(
        server.name,
        server.hostname,
        server.ip_address,
        server.ssh_port || 22,
        server.ssh_user || 'root',
        JSON.stringify(server.tags || []),
        JSON.stringify(server.services || []),
        JSON.stringify(server.storage_mounts || []),
        id
      );
      return serverQueries.getById.get(id);
    },
    delete: (id) => serverQueries.delete.run(id),
    updateStatus: (id, status) => {
      if (status === 'online') serverQueries.updateStatusOnline.run(status, id);
      else serverQueries.updateStatus.run(status, id);
    },
    setNotes: (id, notes) => db.prepare("UPDATE servers SET notes = ? WHERE id = ?").run(notes, id),
  },
  serverInfo: {
    get: (serverId) => {
      const row = infoQueries.get.get(serverId);
      if (!row) return row;
      return {
        ...row,
        storage_mount_metrics: parseJsonArray(row.storage_mount_metrics),
        zfs_pools: parseJsonArray(row.zfs_pools),
      };
    },
    upsert: (serverId, info) => {
      infoQueries.upsert.run(
        serverId,
        info.os,
        info.kernel,
        info.cpu,
        info.cpu_cores,
        info.ram_total_mb,
        info.ram_used_mb,
        info.disk_total_gb,
        info.disk_used_gb,
        JSON.stringify(info.storage_mount_metrics || []),
        info.uptime_seconds,
        info.load_avg,
        info.reboot_required ? 1 : 0,
        info.cpu_usage_pct ?? null,
        JSON.stringify(info.zfs_pools || [])
      );
    },
  },
  updateHistory: {
    getByServer: (serverId) => historyQueries.getByServer.all(serverId),
    create: (serverId, action) => {
      const id = uuidv4();
      try {
        historyQueries.insert.run(id, serverId, action, 'pending');
      } catch (e) {
        if (e.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          throw e;
        }
      }
      return id;
    },
    updateStatus: (id, status, output) => historyQueries.updateStatus.run(status, output, id),
  },
  sshKeys: {
    getAll: () => sshKeyQueries.getAll.all(),
    getFirst: () => sshKeyQueries.getFirst.get(),
    create: (name, publicKey, privateKeyPath) => {
      const id = uuidv4();
      sshKeyQueries.insert.run(id, name, publicKey, privateKeyPath);
      return id;
    },
    replace: (name, publicKey, privateKeyPath) => {
      sshKeyQueries.deleteAll.run();
      const id = uuidv4();
      sshKeyQueries.insert.run(id, name, publicKey, privateKeyPath);
      return id;
    },
    clear: () => sshKeyQueries.deleteAll.run(),
  },
  dockerContainers: {
    getByServer: (serverId) => dockerContainerQueries.getByServer.all(serverId),
    syncForServer: (serverId, containers) => {
      const transaction = db.transaction(() => {
        dockerContainerQueries.clearForServer.run(serverId);
        for (const c of containers) {
          if (c.composeProject && c.composeWorkingDir) {
            composeProjectQueries.upsert.run(uuidv4(), serverId, c.composeProject, c.composeWorkingDir);
          }
          dockerContainerQueries.insert.run(uuidv4(), serverId, c.name, c.image, c.state, c.status, c.createdAt, c.composeProject || null, c.composeWorkingDir || null);
        }
      });
      transaction();
    }
  },
  composeProjects: {
    getByServer: (serverId) => composeProjectQueries.getByServer.all(serverId),
    getByServerAndPath: (serverId, workingDir) => composeProjectQueries.getByServerAndPath.get(serverId, workingDir),
    upsert: (serverId, projectName, workingDir) => {
      composeProjectQueries.upsert.run(uuidv4(), serverId, projectName, workingDir);
    },
    delete: (serverId, projectName) => {
      composeProjectQueries.delete.run(serverId, projectName);
    }
  },

  // ── Schedules ──────────────────────────────────────────
  schedules: {
    getAll: () => db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all(),
    getById: (id) => db.prepare('SELECT * FROM schedules WHERE id = ?').get(id),
    create: (name, playbook, targets, cronExpression) => {
      const id = uuidv4();
      db.prepare('INSERT INTO schedules (id, name, playbook, targets, cron_expression) VALUES (?, ?, ?, ?, ?)').run(id, name, playbook, targets || 'all', cronExpression);
      return id;
    },
    update: (id, fields) => {
      const fieldMap = {
        name:           'name',
        playbook:       'playbook',
        targets:        'targets',
        cronExpression: 'cron_expression',
        enabled:        'enabled',
      };
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!fieldMap[k]) throw new Error(`Invalid field: ${k}`);
        sets.push(`${fieldMap[k]} = ?`);
        vals.push(v);
      }
      vals.push(id);
      db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    delete: (id) => db.prepare('DELETE FROM schedules WHERE id = ?').run(id),
    updateLastRun: (id, status) => {
      db.prepare("UPDATE schedules SET last_run = datetime('now'), last_status = ? WHERE id = ?").run(status, id);
    }
  },

  auditLog: {
    write: (action, detail, ip, success = true, user = null) => {
      const id = uuidv4();
      db.prepare('INSERT INTO audit_log (id, action, detail, user, ip, success) VALUES (?, ?, ?, ?, ?, ?)').run(id, action, detail || null, user || null, ip || null, success ? 1 : 0);
    },
    getRecent: (limit = 100) => db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit),
    query: ({ action, user, ip, success, from, to, limit = 200, offset = 0 } = {}) => {
      const conditions = [];
      const params = [];
      if (action) { conditions.push('action LIKE ?'); params.push(`${action}%`); }
      if (user) { conditions.push('user = ?'); params.push(user); }
      if (ip) { conditions.push('ip LIKE ?'); params.push(`%${ip}%`); }
      if (success !== undefined && success !== '') { conditions.push('success = ?'); params.push(Number(success)); }
      if (from) { conditions.push('created_at >= ?'); params.push(from); }
      if (to) { conditions.push('created_at <= ?'); params.push(to); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(Math.min(limit, 500), offset);
      return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params);
    },
    countAll: () => db.prepare('SELECT COUNT(*) as count FROM audit_log').get().count,
    distinctActions: () => db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(r => r.action),
    distinctUsers: () => db.prepare("SELECT DISTINCT user FROM audit_log WHERE user IS NOT NULL AND user != '' ORDER BY user").all().map(r => r.user),
    pruneOlderThan: (days) => db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)").run(`-${days} days`),
  },

  settings: {
    get: (key) => {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },
    set: (key, value) => {
      db.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    },
    getAll: () => {
      const rows = db.prepare('SELECT key, value FROM app_settings').all();
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
  },

  agentConfig: {
    getByServerId: (serverId) => agentConfigQueries.getByServerId.get(serverId),
    getAll: () => agentConfigQueries.getAll.all(),
    upsert: ({ server_id, mode, token, shipyard_url, interval, installed_at, last_seen, runner_version, last_manifest_version }) => {
      agentConfigQueries.upsert.run(
        server_id,
        mode || 'legacy',
        token || null,
        shipyard_url || null,
        Number.isFinite(interval) ? interval : 30,
        installed_at || null,
        last_seen || null,
        runner_version || null,
        Number.isInteger(last_manifest_version) ? last_manifest_version : null,
      );
      return agentConfigQueries.getByServerId.get(server_id);
    },
    setSeen: (serverId, runnerVersion, manifestVersion) => agentConfigQueries.setSeen.run(runnerVersion || null, Number.isInteger(manifestVersion) ? manifestVersion : null, serverId),
    updateModeInterval: (serverId, mode, interval, shipyardUrl = null) => agentConfigQueries.updateModeInterval.run(mode, interval, shipyardUrl, serverId),
    setToken: (serverId, token) => agentConfigQueries.setToken.run(token, serverId),
    delete: (serverId) => agentConfigQueries.delete.run(serverId),
  },

  agentManifests: {
    getLatest: () => agentManifestQueries.getLatest.get(),
    getByVersion: (version) => agentManifestQueries.getByVersion.get(version),
    listRecent: (limit = 50) => agentManifestQueries.listRecent.all(limit),
    createNext: ({ content, createdBy, changelog }) => {
      const latest = agentManifestQueries.getLatest.get();
      const nextVersion = latest ? latest.version + 1 : 1;
      agentManifestQueries.insert.run(nextVersion, content, createdBy || null, changelog || null);
      return agentManifestQueries.getByVersion.get(nextVersion);
    },
  },

  agentMetrics: {
    insert: ({ serverId, timestamp, manifestVersion, data }) => {
      agentMetricsQueries.insert.run(serverId, timestamp, Number.isInteger(manifestVersion) ? manifestVersion : null, data);
    },
    recentByServer: (serverId, limit = 100) => agentMetricsQueries.recentByServer.all(serverId, limit),
    pruneOlderThanDays: (days) => {
      const keepSeconds = Math.max(1, parseInt(days, 10) || 7) * 24 * 60 * 60;
      const cutoff = Math.floor(Date.now() / 1000) - keepSeconds;
      return agentMetricsQueries.pruneOlderThan.run(cutoff);
    },
  },

  customUpdateTasks: {
    getByServer: (serverId) => db.prepare('SELECT * FROM custom_update_tasks WHERE server_id = ? ORDER BY created_at').all(serverId),
    getById: (id) => db.prepare('SELECT * FROM custom_update_tasks WHERE id = ?').get(id),
    create: (serverId, fields) => {
      const id = uuidv4();
      db.prepare(`INSERT INTO custom_update_tasks (id, server_id, name, type, check_command, github_repo, update_command, trigger_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, serverId, fields.name, fields.type, fields.check_command || null, fields.github_repo || null, fields.update_command || '', fields.trigger_output || null);
      return db.prepare('SELECT * FROM custom_update_tasks WHERE id = ?').get(id);
    },
    update: (id, fields) => {
      db.prepare(`UPDATE custom_update_tasks SET name = ?, type = ?, check_command = ?, github_repo = ?, update_command = ?, trigger_output = ? WHERE id = ?`)
        .run(fields.name, fields.type, fields.check_command || null, fields.github_repo || null, fields.update_command || '', fields.trigger_output || null, id);
      return db.prepare('SELECT * FROM custom_update_tasks WHERE id = ?').get(id);
    },
    delete: (id) => db.prepare('DELETE FROM custom_update_tasks WHERE id = ?').run(id),
    setVersionInfo: (id, currentVersion, lastVersion, hasUpdate) =>
      db.prepare(`UPDATE custom_update_tasks SET current_version = ?, last_version = ?, has_update = ?, last_checked_at = datetime('now') WHERE id = ?`)
        .run(currentVersion || null, lastVersion || null, hasUpdate ? 1 : 0, id),
    countHasUpdate: (serverId) =>
      db.prepare('SELECT COUNT(*) as c FROM custom_update_tasks WHERE server_id = ? AND has_update = 1').get(serverId).c,
  },

  serverGroups: {
    getAll: () => db.prepare('SELECT * FROM server_groups ORDER BY position, name').all(),
    create: (name, color, parentId) => {
      const id = uuidv4();
      db.prepare('INSERT INTO server_groups (id, name, color, parent_id) VALUES (?, ?, ?, ?)').run(id, name, color || '#6366f1', parentId || null);
      return db.prepare('SELECT * FROM server_groups WHERE id = ?').get(id);
    },
    update: (id, name, color) => db.prepare('UPDATE server_groups SET name = ?, color = ? WHERE id = ?').run(name, color || '#6366f1', id),
    delete: (id) => db.prepare('DELETE FROM server_groups WHERE id = ?').run(id),
    setServerGroup: (serverId, groupId) => db.prepare('UPDATE servers SET group_id = ? WHERE id = ?').run(groupId || null, serverId),
    setGroupParent: (groupId, parentId) => db.prepare('UPDATE server_groups SET parent_id = ? WHERE id = ?').run(parentId || null, groupId),
  },

  updatesCache: {
    get: (serverId) => {
      const row = db.prepare('SELECT * FROM server_updates_cache WHERE server_id = ?').get(serverId);
      if (!row) return null;
      try { return JSON.parse(row.updates_json); } catch { return []; }
    },
    set: (serverId, updates) => {
      db.prepare(`
        INSERT INTO server_updates_cache (server_id, updates_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(server_id) DO UPDATE SET updates_json = excluded.updates_json, updated_at = datetime('now')
      `).run(serverId, JSON.stringify(updates));
    },
    delete: (serverId) => {
      db.prepare('DELETE FROM server_updates_cache WHERE server_id = ?').run(serverId);
    },
  },

  scheduleHistory: {
    getAll: (limit = 100, scheduleId = null) => {
      if (scheduleId) return db.prepare('SELECT id,schedule_id,schedule_name,playbook,targets,started_at,completed_at,status FROM schedule_history WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?').all(scheduleId, limit);
      return db.prepare('SELECT id,schedule_id,schedule_name,playbook,targets,started_at,completed_at,status FROM schedule_history ORDER BY started_at DESC LIMIT ?').all(limit);
    },
    getById: (id) => db.prepare('SELECT * FROM schedule_history WHERE id = ?').get(id),
    create: (scheduleId, scheduleName, playbook, targets) => {
      const id = uuidv4();
      db.prepare('INSERT INTO schedule_history (id, schedule_id, schedule_name, playbook, targets) VALUES (?, ?, ?, ?, ?)').run(id, scheduleId || null, scheduleName, playbook, targets || 'all');
      return id;
    },
    complete: (id, status, output) => {
      db.prepare("UPDATE schedule_history SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?").run(status, output || '', id);
    },
    prune: () => {
      db.prepare("DELETE FROM schedule_history WHERE id NOT IN (SELECT id FROM schedule_history ORDER BY started_at DESC LIMIT 200)").run();
    },
  },

  ansibleVars: {
    getAll: () => db.prepare('SELECT * FROM ansible_vars ORDER BY key').all(),
    create: (key, value, description) => {
      const id = uuidv4();
      db.prepare('INSERT INTO ansible_vars (id, key, value, description) VALUES (?, ?, ?, ?)').run(id, key, value, description || '');
      return db.prepare('SELECT * FROM ansible_vars WHERE id = ?').get(id);
    },
    update: (id, key, value, description) => {
      db.prepare('UPDATE ansible_vars SET key = ?, value = ?, description = ? WHERE id = ?').run(key, value, description || '', id);
      return db.prepare('SELECT * FROM ansible_vars WHERE id = ?').get(id);
    },
    delete: (id) => db.prepare('DELETE FROM ansible_vars WHERE id = ?').run(id),
    toExtraVars: () => {
      const rows = db.prepare('SELECT key, value FROM ansible_vars').all();
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
  },

  dockerImageUpdatesCache: {
    get: (serverId) => {
      const row = db.prepare('SELECT * FROM docker_image_updates_cache WHERE server_id = ?').get(serverId);
      if (!row) return null;
      try { return JSON.parse(row.results_json); } catch { return []; }
    },
    getWithMeta: (serverId) => {
      const row = db.prepare('SELECT * FROM docker_image_updates_cache WHERE server_id = ?').get(serverId);
      if (!row) return null;
      try { return { results: JSON.parse(row.results_json), updated_at: row.updated_at }; } catch { return null; }
    },
    set: (serverId, results) => {
      db.prepare(`
        INSERT INTO docker_image_updates_cache (server_id, results_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(server_id) DO UPDATE SET results_json = excluded.results_json, updated_at = datetime('now')
      `).run(serverId, JSON.stringify(results));
    },
  },

  roles: {
    getAll:  () => db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all(),
    getById: (id) => db.prepare('SELECT * FROM roles WHERE id = ?').get(id),
    create:  (name, permissions) => {
      const id = uuidv4();
      db.prepare('INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?)').run(id, name, JSON.stringify(permissions || {}));
      return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    },
    update:  (id, name, permissions) => {
      db.prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?').run(name, JSON.stringify(permissions), id);
      return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    },
    delete:  (id) => db.prepare('DELETE FROM roles WHERE id = ?').run(id),
  },

  users: {
    getAll: () => db.prepare('SELECT id, username, display_name, email, role, totp_enabled, token_version, created_at FROM users ORDER BY created_at').all(),
    getById: (id) => db.prepare('SELECT id, username, display_name, email, role, totp_enabled, token_version, created_at FROM users WHERE id = ?').get(id),
    getByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    create: (username, email, passwordHash, role, displayName) => {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO users (id, username, display_name, email, password_hash, role)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, username, displayName || '', email || '', passwordHash, role || 'user');
      return db.prepare('SELECT id, username, display_name, email, role, totp_enabled, token_version, created_at FROM users WHERE id = ?').get(id);
    },
    update: (id, fields) => {
      const allowed = { username: 'username', display_name: 'display_name', email: 'email', role: 'role' };
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed[k]) continue;
        sets.push(`${allowed[k]} = ?`);
        vals.push(v);
      }
      if (!sets.length) return;
      vals.push(id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return db.prepare('SELECT id, username, display_name, email, role, totp_enabled, token_version, created_at FROM users WHERE id = ?').get(id);
    },
    setPasswordHash: (id, hash) => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id),
    setTotp: (id, secret, enabled) => db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?').run(secret, enabled ? 1 : 0, id),
    setPendingTotp: (id, secret) => db.prepare('UPDATE users SET totp_secret_pending = ? WHERE id = ?').run(secret, id),
    incrementTokenVersion: (id) => db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(id),
    delete: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
    count: () => db.prepare('SELECT COUNT(*) as c FROM users').get().c,
  },
};
