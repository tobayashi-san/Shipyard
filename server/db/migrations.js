const CURRENT_SCHEMA_VERSION = 13;

const REQUIRED_COLUMNS = {
  servers: ['id', 'name', 'hostname', 'ip_address', 'environment_id', 'host_fingerprint', 'docker_enabled', 'owner'],
  server_info: ['server_id', 'storage_mount_metrics', 'cpu_usage_pct', 'zfs_pools', 'detected_mounts'],
  server_groups: ['id', 'environment_id'],
  custom_update_tasks: ['id', 'trigger_output', 'latest_command', 'last_check_error', 'last_attempted_at', 'snapshot_before_run'],
  audit_log: ['id', 'environment_id', 'user'],
  operation_acknowledgements: ['environment_id', 'operation_id', 'acknowledged_at', 'acknowledged_by'],
  update_history: ['id', 'environment_id', 'server_id', 'server_name_snapshot'],
  agent_config: ['server_id', 'token', 'pending_token'],
  environments: ['id', 'name'],
  ipam_subnets: ['id', 'environment_id', 'status', 'role', 'dhcp_start', 'dhcp_end'],
  ipam_reservations: ['id', 'subnet_id', 'status', 'role', 'source_type'],
  ipam_device_names: ['environment_id', 'mac_address', 'name'],
  ipam_ip_ranges: ['id', 'subnet_id', 'start_address', 'end_address'],
  ipam_sync_sources: ['id', 'environment_id', 'auto_sync', 'sync_interval_min', 'last_record_count', 'last_ignored_count'],
  ssh_key_assignments: ['id', 'key_name', 'target_type', 'target_id', 'environment_id'],
  server_alert_settings: ['server_id', 'enabled', 'thresholds_json'],
  resource_alerts: ['id', 'server_id', 'type', 'status'],
  schedules: ['id', 'environment_id', 'extra_vars', 'check_mode', 'forks'],
  schedule_history: ['id', 'environment_id', 'triggered_by', 'check_mode', 'target_server_ids'],
  ansible_vars: ['id', 'environment_id', 'key', 'value', 'is_secret', 'rotation_due', 'value_updated_at', 'value_type'],
  users: ['id', 'username', 'role', 'disabled', 'last_login_at', 'token_version'],
  docker_containers: ['id', 'server_id', 'container_name', 'cpu_percent', 'memory_usage', 'memory_percent'],
};

function validateMigratedSchema(db) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    if (columns.size === 0) throw new Error(`required table '${table}' is missing`);
    for (const column of expectedColumns) {
      if (!columns.has(column)) throw new Error(`required column '${table}.${column}' is missing`);
    }
  }

  const quickCheck = db.pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`SQLite quick_check failed: ${quickCheck}`);
}

function applyMigrations(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE users ADD COLUMN last_login_at TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE agent_config ADD COLUMN fleet_url TEXT");
  } catch {}
  // Databases created under the Shipyard name store the agent callback URL as shipyard_url.
  const agentColumns = new Set(db.prepare('PRAGMA table_info(agent_config)').all().map(column => column.name));
  if (agentColumns.has('shipyard_url') && agentColumns.has('fleet_url')) {
    db.exec('UPDATE agent_config SET fleet_url = shipyard_url WHERE fleet_url IS NULL AND shipyard_url IS NOT NULL');
  }
  try {
    db.exec("ALTER TABLE servers ADD COLUMN storage_mounts TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec("ALTER TABLE servers ADD COLUMN links TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec(
      "ALTER TABLE server_info ADD COLUMN storage_mount_metrics TEXT DEFAULT '[]'",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE server_info ADD COLUMN detected_mounts TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec("ALTER TABLE custom_update_tasks ADD COLUMN trigger_output TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE server_info ADD COLUMN zfs_pools TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec("ALTER TABLE audit_log ADD COLUMN user TEXT");
  } catch {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user)");
  } catch {}
  try {
    db.exec("ALTER TABLE custom_update_tasks ADD COLUMN latest_command TEXT");
  } catch {}
  const customTaskColumns = new Set(db.prepare('PRAGMA table_info(custom_update_tasks)').all().map(column => column.name));
  for (const column of ['last_check_error', 'last_attempted_at']) {
    if (customTaskColumns.size > 0 && !customTaskColumns.has(column)) db.exec(`ALTER TABLE custom_update_tasks ADD COLUMN ${column} TEXT`);
  }
  if (customTaskColumns.size > 0 && !customTaskColumns.has('snapshot_before_run')) db.exec('ALTER TABLE custom_update_tasks ADD COLUMN snapshot_before_run INTEGER NOT NULL DEFAULT 0');
  // Trust-on-first-use SSH host key fingerprint, sha256 base64 of server-presented host key.
  try {
    db.exec("ALTER TABLE servers ADD COLUMN host_fingerprint TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec("ALTER TABLE servers ADD COLUMN docker_enabled INTEGER DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE servers ADD COLUMN owner TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now'))) ",
    );
  } catch {}
  try {
    db.exec(`
      INSERT OR IGNORE INTO environments (id, name) VALUES ('default', 'Default environment');
      UPDATE environments SET name = 'Default environment'
      WHERE id = 'default'
        AND name = 'Standardumgebung'
        AND NOT EXISTS (
          SELECT 1 FROM environments
          WHERE id <> 'default' AND name = 'Default environment'
        );
    `);
  } catch {}
  try {
    db.exec(
      "ALTER TABLE servers ADD COLUMN environment_id TEXT DEFAULT 'default'",
    );
  } catch {}
  try {
    db.exec(
      "UPDATE servers SET environment_id = 'default' WHERE environment_id IS NULL OR environment_id = ''",
    );
  } catch {}
  // Folders are scoped to an environment just like their hosts. Older
  // installations keep their existing folders in the default environment.
  try {
    db.exec(
      "ALTER TABLE server_groups ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'default'",
    );
  } catch {}
  try {
    db.exec(
      "UPDATE server_groups SET environment_id = 'default' WHERE environment_id IS NULL OR environment_id = ''",
    );
  } catch {}
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_server_groups_environment ON server_groups(environment_id, position, name)",
    );
  } catch {}
  // The product is called Fleet again: rename the untouched default name, never a custom white-label name.
  try {
    db.exec(
      "UPDATE app_settings SET value = 'Fleet' WHERE key = 'wl_app_name' AND value = 'Shipyard'",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE update_history ADD COLUMN triggered_by TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE update_history ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'default'");
  } catch {}
  // Preserve execution evidence when a host is removed. Old history can only
  // be backfilled while its host still exists; previously cascaded rows cannot
  // be recovered by migration.
  const historyColumns = new Set(db.prepare('PRAGMA table_info(update_history)').all().map(column => column.name));
  if (historyColumns.size) {
  if (!historyColumns.has('server_name_snapshot')) db.exec('ALTER TABLE update_history ADD COLUMN server_name_snapshot TEXT');
  db.exec(`UPDATE update_history SET server_name_snapshot = (SELECT name FROM servers WHERE servers.id = update_history.server_id) WHERE server_name_snapshot IS NULL`);
  if (db.prepare('PRAGMA foreign_key_list(update_history)').all().some(key => key.table === 'servers')) {
    db.exec(`
      CREATE TABLE update_history_retained (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL, server_name_snapshot TEXT,
        environment_id TEXT NOT NULL DEFAULT 'default', action TEXT NOT NULL,
        status TEXT DEFAULT 'pending', output TEXT, started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT, triggered_by TEXT
      );
      INSERT INTO update_history_retained SELECT id, server_id, server_name_snapshot, environment_id, action, status, output, started_at, completed_at, triggered_by FROM update_history;
      DROP TABLE update_history;
      ALTER TABLE update_history_retained RENAME TO update_history;
      CREATE INDEX idx_update_history_server_id ON update_history(server_id);
      CREATE INDEX idx_update_history_started_at ON update_history(started_at);
    `);
  }
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_update_history_environment_started ON update_history(environment_id, started_at DESC)");
  } catch {}
  try {
    db.exec("ALTER TABLE audit_log ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'default'");
  } catch {}
  try {
    db.exec("ALTER TABLE agent_config ADD COLUMN pending_token TEXT");
  } catch {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_log_environment_created ON audit_log(environment_id, created_at DESC)");
  } catch {}
  // NetBox-style IPAM metadata. These additive migrations preserve all early
  // Fleet subnet and reservation data.
  try {
    db.exec(
      "ALTER TABLE ipam_subnets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_subnets ADD COLUMN role TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_subnets ADD COLUMN dhcp_start TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_subnets ADD COLUMN dhcp_end TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_reservations ADD COLUMN role TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_reservations ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'",
    );
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_reservations ADD COLUMN source_ref TEXT DEFAULT ''",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_reservations ADD COLUMN last_synced_at TEXT");
  } catch {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ipam_device_names (
      environment_id TEXT NOT NULL, mac_address TEXT NOT NULL, name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (environment_id, mac_address),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ipam_device_names_name ON ipam_device_names(environment_id, name)");
  } catch {}
  // DHCP is defined by the prefix pool. Older source imports marked every
  // observed address as DHCP, so remove that legacy claim before deriving the
  // effective status from dhcp_start/dhcp_end.
  try {
    db.exec("UPDATE ipam_reservations SET status = 'active' WHERE status = 'dhcp'");
  } catch {}
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS ipam_ip_ranges (id TEXT PRIMARY KEY, subnet_id TEXT NOT NULL, start_address TEXT NOT NULL, end_address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', role TEXT DEFAULT '', description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE)",
    );
  } catch {}
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ipam_ranges_subnet ON ipam_ip_ranges(subnet_id)",
    );
  } catch {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ipam_sync_sources (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL DEFAULT 'default', type TEXT NOT NULL,
      name TEXT NOT NULL, endpoint TEXT NOT NULL, api_token TEXT NOT NULL DEFAULT '',
      site TEXT DEFAULT 'default', path TEXT DEFAULT '', insecure INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, auto_sync INTEGER NOT NULL DEFAULT 1,
      sync_interval_min INTEGER NOT NULL DEFAULT 15, last_synced_at TEXT, last_status TEXT DEFAULT '',
      last_error TEXT DEFAULT '', last_tested_at TEXT, last_test_status TEXT DEFAULT '',
      last_test_error TEXT DEFAULT '', last_record_count INTEGER NOT NULL DEFAULT 0,
      last_ignored_count INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ipam_sync_sources_environment ON ipam_sync_sources(environment_id)",
    );
  } catch {}
  try {
    db.exec("ALTER TABLE ipam_sync_sources ADD COLUMN last_tested_at TEXT");
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN last_test_status TEXT DEFAULT ''",
    );
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN last_test_error TEXT DEFAULT ''",
    );
  } catch {}
  // Controller inventories are intended to follow lease changes without an
  // operator having to press Sync. Existing sources get the safe defaults.
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1",
    );
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN sync_interval_min INTEGER NOT NULL DEFAULT 15",
    );
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN last_record_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch {}
  try {
    db.exec(
      "ALTER TABLE ipam_sync_sources ADD COLUMN last_ignored_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch {}
  // Source ownership is exposed separately in the IPAM UI. Remove only the
  // generated legacy descriptions so the description field contains actual
  // operator/controller metadata instead of a duplicate source label.
  try {
    db.exec(`
      UPDATE ipam_reservations
      SET description = ''
      WHERE (source_type IN ('unifi', 'pfsense') AND description LIKE 'Synchronisiert aus %')
         OR (source_type = 'proxmox' AND description LIKE 'Aus Proxmox % synchronisiert')
    `);
  } catch {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ipam_sync_conflicts (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, subnet_id TEXT NOT NULL,
      source_id TEXT NOT NULL, address TEXT NOT NULL, hostname TEXT DEFAULT '',
      mac_address TEXT DEFAULT '', reason TEXT NOT NULL, existing_reservation_id TEXT,
      last_seen_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES ipam_sync_sources(id) ON DELETE CASCADE
    )`);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ipam_sync_conflicts_source_address ON ipam_sync_conflicts(source_id, address)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ipam_sync_conflicts_subnet ON ipam_sync_conflicts(subnet_id)",
    );
  } catch {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ipam_source_observations (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, subnet_id TEXT NOT NULL,
      source_id TEXT NOT NULL, source_ref TEXT NOT NULL, reservation_id TEXT,
      address TEXT NOT NULL, hostname TEXT DEFAULT '', mac_address TEXT DEFAULT '',
      last_seen_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES ipam_sync_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (reservation_id) REFERENCES ipam_reservations(id) ON DELETE SET NULL,
      UNIQUE(source_id, source_ref)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ipam_source_observations_reservation ON ipam_source_observations(reservation_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ipam_source_observations_source ON ipam_source_observations(source_id)");
  } catch {}
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ipam_proxmox_sync_conflicts (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, subnet_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, address TEXT NOT NULL, hostname TEXT DEFAULT '', mac_address TEXT DEFAULT '',
      reason TEXT NOT NULL, existing_reservation_id TEXT, last_seen_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES tofu_proxmox_connections(id) ON DELETE CASCADE
    )`);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ipam_proxmox_conflicts_connection_address ON ipam_proxmox_sync_conflicts(connection_id, subnet_id, address)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ipam_proxmox_conflicts_subnet ON ipam_proxmox_sync_conflicts(subnet_id)",
    );
  } catch {}
  try { db.exec("ALTER TABLE ipam_proxmox_sync_conflicts ADD COLUMN mac_address TEXT DEFAULT ''"); } catch {}
  // Maintenance windows were retired; remove their table and notification preference.
  db.exec('DROP TABLE IF EXISTS maintenance_windows');
  try { db.exec("DELETE FROM app_settings WHERE key = 'notify_suppress_maintenance'"); } catch {}
  // SSH keys are stored centrally; this mapping makes their permitted hosts,
  // deployments and VM templates visible without coupling the core schema to
  // an optional OpenTofu installation.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ssh_key_assignments (
      id TEXT PRIMARY KEY, key_name TEXT NOT NULL DEFAULT 'fleet', target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, target_label TEXT NOT NULL DEFAULT '', environment_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(key_name, target_type, target_id)
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_ssh_key_assignments_environment ON ssh_key_assignments(environment_id, target_type)",
    );
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_alert_settings (
        server_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_enabled INTEGER NOT NULL DEFAULT 1,
        trigger_after_seconds INTEGER NOT NULL DEFAULT 60,
        thresholds_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      )
    `);
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_alerts (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        type TEXT NOT NULL,
        target_key TEXT NOT NULL DEFAULT '',
        severity TEXT NOT NULL DEFAULT 'warning',
        status TEXT NOT NULL DEFAULT 'pending',
        value REAL,
        threshold REAL,
        message TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT DEFAULT (datetime('now')),
        triggered_at TEXT,
        last_seen_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        notification_sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      )
    `);
  } catch {}
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_alerts_active_key ON resource_alerts(server_id, type, target_key) WHERE status IN ('pending', 'active', 'acknowledged')",
    );
  } catch {}
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_resource_alerts_status ON resource_alerts(status)",
    );
  } catch {}
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_resource_alerts_server ON resource_alerts(server_id)",
    );
  } catch {}
  // Playbook execution is isolated per console environment. Existing global
  // schedules, run history and variables remain available in the default
  // environment after upgrading.
  for (const statement of [
    "ALTER TABLE schedules ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE schedules ADD COLUMN extra_vars TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE schedules ADD COLUMN check_mode INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE schedules ADD COLUMN forks INTEGER NOT NULL DEFAULT 5",
    "ALTER TABLE schedule_history ADD COLUMN environment_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE schedule_history ADD COLUMN triggered_by TEXT",
    "ALTER TABLE schedule_history ADD COLUMN check_mode INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(statement); } catch {}
  }
  for (const statement of [
    "ALTER TABLE docker_containers ADD COLUMN cpu_percent REAL",
    "ALTER TABLE docker_containers ADD COLUMN memory_usage TEXT",
    "ALTER TABLE docker_containers ADD COLUMN memory_percent REAL",
  ]) {
    try { db.exec(statement); } catch {}
  }
  try {
    const ansibleVarsExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ansible_vars'").get());
    const ansibleVarColumns = ansibleVarsExists
      ? new Set(db.prepare('PRAGMA table_info(ansible_vars)').all().map(column => column.name))
      : new Set();
    if (ansibleVarsExists && (!ansibleVarColumns.has('environment_id') || !ansibleVarColumns.has('is_secret'))) {
      db.exec(`
        CREATE TABLE ansible_vars_v2 (
          id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL DEFAULT 'default',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          is_secret INTEGER NOT NULL DEFAULT 0,
          description TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(environment_id, key)
        );
        INSERT INTO ansible_vars_v2 (id, environment_id, key, value, is_secret, description, created_at)
          SELECT id, 'default', key, value, 0, description, created_at FROM ansible_vars;
        DROP TABLE ansible_vars;
        ALTER TABLE ansible_vars_v2 RENAME TO ansible_vars;
      `);
    }
  } catch (error) {
    throw new Error(`failed to migrate ansible variables: ${error.message}`);
  }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_schedules_environment ON schedules(environment_id, created_at)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_history_environment ON schedule_history(environment_id, started_at DESC)"); } catch {}
  const variableColumns = new Set(db.prepare('PRAGMA table_info(ansible_vars)').all().map(column => column.name));
  for (const column of ['rotation_due', 'value_updated_at']) {
    if (variableColumns.size && !variableColumns.has(column)) db.exec(`ALTER TABLE ansible_vars ADD COLUMN ${column} TEXT`);
  }
  if (variableColumns.size && !variableColumns.has('value_type')) db.exec("ALTER TABLE ansible_vars ADD COLUMN value_type TEXT NOT NULL DEFAULT 'string'");
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ansible_vars_environment ON ansible_vars(environment_id, key)"); } catch {}
  // Destinations for scheduled encrypted database backups (settings and passphrase are encrypted).
  db.exec(`
      CREATE TABLE IF NOT EXISTS backup_targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        settings TEXT NOT NULL,
        remote_path TEXT NOT NULL DEFAULT '',
        cron_expression TEXT NOT NULL,
        keep_count INTEGER NOT NULL DEFAULT 14,
        passphrase TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        last_file TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
  `);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operation_acknowledgements (
        environment_id TEXT NOT NULL DEFAULT 'default',
        operation_id TEXT NOT NULL,
        acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged_by TEXT,
        PRIMARY KEY (environment_id, operation_id),
        FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_operation_acknowledgements_environment
        ON operation_acknowledgements(environment_id, acknowledged_at DESC);
    `);
  } catch (error) {
    throw new Error(`failed to create operation acknowledgements: ${error.message}`);
  }

    const workflowColumns = new Set(db.prepare('PRAGMA table_info(schedule_history)').all().map(column => column.name));
    // Historical names cannot prove historical identity. Leave legacy rows
    // unbound rather than linking them to today's inventory by name.
    if (workflowColumns.size && !workflowColumns.has('target_server_ids')) db.exec('ALTER TABLE schedule_history ADD COLUMN target_server_ids TEXT');
    validateMigratedSchema(db);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw new Error(`Database migration failed: ${error.message}`, { cause: error });
  }
}

module.exports = { applyMigrations, CURRENT_SCHEMA_VERSION, validateMigratedSchema };
