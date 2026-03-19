const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'shipyard.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

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
    status TEXT DEFAULT 'unknown',
    last_seen TEXT,
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
    uptime_seconds INTEGER,
    load_avg TEXT,
    reboot_required BOOLEAN DEFAULT 0,
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

// Updates cache table
db.exec(`
  CREATE TABLE IF NOT EXISTS server_updates_cache (
    server_id TEXT PRIMARY KEY,
    updates_json TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

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
    ip TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migrations
try {
  db.exec('ALTER TABLE server_info ADD COLUMN reboot_required BOOLEAN DEFAULT 0;');
} catch (e) {}

try {
  db.exec("ALTER TABLE servers ADD COLUMN notes TEXT NOT NULL DEFAULT '';");
} catch (e) {}

try {
  db.exec('ALTER TABLE docker_containers ADD COLUMN compose_project TEXT;');
} catch (e) {}

try {
  db.exec('ALTER TABLE docker_containers ADD COLUMN compose_working_dir TEXT;');
} catch (e) {}

try {
  db.exec('ALTER TABLE server_info ADD COLUMN cpu_usage_pct REAL DEFAULT NULL;');
} catch (e) {}

try {
  db.exec('ALTER TABLE servers ADD COLUMN group_id TEXT;');
} catch (e) {}

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

// Migrations for existing server_groups tables
try {
  db.exec("ALTER TABLE server_groups ADD COLUMN color TEXT DEFAULT '#6366f1';");
} catch (e) {}

try {
  db.exec('ALTER TABLE server_groups ADD COLUMN parent_id TEXT;');
} catch (e) {}

// Server CRUD
const serverQueries = {
  getAll: db.prepare('SELECT * FROM servers ORDER BY name'),
  getById: db.prepare('SELECT * FROM servers WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO servers (id, name, hostname, ip_address, ssh_port, ssh_user, tags, services)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE servers SET name = ?, hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, tags = ?, services = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM servers WHERE id = ?'),
  updateStatus: db.prepare(`UPDATE servers SET status = ?, last_seen = datetime('now') WHERE id = ?`),
};

// Server Info
const infoQueries = {
  get: db.prepare('SELECT * FROM server_info WHERE server_id = ?'),
  upsert: db.prepare(`
    INSERT INTO server_info (server_id, os, kernel, cpu, cpu_cores, ram_total_mb, ram_used_mb, disk_total_gb, disk_used_gb, uptime_seconds, load_avg, reboot_required, cpu_usage_pct, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(server_id) DO UPDATE SET
      os = excluded.os, kernel = excluded.kernel, cpu = excluded.cpu, cpu_cores = excluded.cpu_cores,
      ram_total_mb = excluded.ram_total_mb, ram_used_mb = excluded.ram_used_mb,
      disk_total_gb = excluded.disk_total_gb, disk_used_gb = excluded.disk_used_gb,
      uptime_seconds = excluded.uptime_seconds, load_avg = excluded.load_avg,
      reboot_required = excluded.reboot_required,
      cpu_usage_pct = excluded.cpu_usage_pct,
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
  upsert: db.prepare(`
    INSERT INTO compose_projects (id, server_id, project_name, working_dir)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id, project_name) DO UPDATE SET
      working_dir = excluded.working_dir,
      updated_at = datetime('now')
  `),
  delete: db.prepare('DELETE FROM compose_projects WHERE server_id = ? AND project_name = ?')
};

module.exports = {
  db,
  uuidv4,
  servers: {
    getAll: () => serverQueries.getAll.all(),
    getById: (id) => serverQueries.getById.get(id),
    create: (server) => {
      const id = uuidv4();
      serverQueries.insert.run(id, server.name, server.hostname, server.ip_address, server.ssh_port || 22, server.ssh_user || 'root', JSON.stringify(server.tags || []), JSON.stringify(server.services || []));
      return serverQueries.getById.get(id);
    },
    update: (id, server) => {
      serverQueries.update.run(server.name, server.hostname, server.ip_address, server.ssh_port || 22, server.ssh_user || 'root', JSON.stringify(server.tags || []), JSON.stringify(server.services || []), id);
      return serverQueries.getById.get(id);
    },
    delete: (id) => serverQueries.delete.run(id),
    updateStatus: (id, status) => serverQueries.updateStatus.run(status, id),
    setNotes: (id, notes) => db.prepare("UPDATE servers SET notes = ? WHERE id = ?").run(notes, id),
  },
  serverInfo: {
    get: (serverId) => infoQueries.get.get(serverId),
    upsert: (serverId, info) => {
      infoQueries.upsert.run(serverId, info.os, info.kernel, info.cpu, info.cpu_cores, info.ram_total_mb, info.ram_used_mb, info.disk_total_gb, info.disk_used_gb, info.uptime_seconds, info.load_avg, info.reboot_required ? 1 : 0, info.cpu_usage_pct ?? null);
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
    write: (action, detail, ip, success = true) => {
      const id = uuidv4();
      db.prepare('INSERT INTO audit_log (id, action, detail, ip, success) VALUES (?, ?, ?, ?, ?)').run(id, action, detail || null, ip || null, success ? 1 : 0);
    },
    getRecent: (limit = 100) => db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit),
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
  },
};
