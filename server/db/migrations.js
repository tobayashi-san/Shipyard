function applyMigrations(db) {
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)'); } catch {}
  try { db.exec('ALTER TABLE agent_config ADD COLUMN shipyard_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN storage_mounts TEXT DEFAULT \'[]\''); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN links TEXT DEFAULT \'[]\''); } catch {}
  try { db.exec('ALTER TABLE server_info ADD COLUMN storage_mount_metrics TEXT DEFAULT \'[]\''); } catch {}
  try { db.exec('ALTER TABLE custom_update_tasks ADD COLUMN trigger_output TEXT'); } catch {}
  try { db.exec('ALTER TABLE server_info ADD COLUMN zfs_pools TEXT DEFAULT \'[]\''); } catch {}
  try { db.exec('ALTER TABLE audit_log ADD COLUMN user TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user)'); } catch {}
  try { db.exec('ALTER TABLE custom_update_tasks ADD COLUMN latest_command TEXT'); } catch {}
  // Trust-on-first-use SSH host key fingerprint, sha256 base64 of server-presented host key.
  try { db.exec("ALTER TABLE servers ADD COLUMN host_fingerprint TEXT DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN docker_enabled INTEGER DEFAULT 0'); } catch {}
  try { db.exec("CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now'))) "); } catch {}
  try { db.exec("INSERT OR IGNORE INTO environments (id, name) VALUES ('default', 'Standardumgebung')"); } catch {}
  try { db.exec("ALTER TABLE servers ADD COLUMN environment_id TEXT DEFAULT 'default'"); } catch {}
  try { db.exec("UPDATE servers SET environment_id = 'default' WHERE environment_id IS NULL OR environment_id = ''"); } catch {}
  // Rename the untouched legacy product default without overwriting a custom white-label name.
  try { db.exec("UPDATE app_settings SET value = 'Fleet' WHERE key = 'wl_app_name' AND value = 'Shipyard'"); } catch {}
  try { db.exec("ALTER TABLE update_history ADD COLUMN triggered_by TEXT"); } catch {}
  // NetBox-style IPAM metadata. These additive migrations preserve all early
  // Fleet subnet and reservation data.
  try { db.exec("ALTER TABLE ipam_subnets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch {}
  try { db.exec("ALTER TABLE ipam_subnets ADD COLUMN role TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE ipam_reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch {}
  try { db.exec("ALTER TABLE ipam_reservations ADD COLUMN role TEXT DEFAULT ''"); } catch {}
  try { db.exec("CREATE TABLE IF NOT EXISTS ipam_ip_ranges (id TEXT PRIMARY KEY, subnet_id TEXT NOT NULL, start_address TEXT NOT NULL, end_address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved', role TEXT DEFAULT '', description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE)"); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_ipam_ranges_subnet ON ipam_ip_ranges(subnet_id)'); } catch {}
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
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_alerts_active_key ON resource_alerts(server_id, type, target_key) WHERE status IN ('pending', 'active', 'acknowledged')"); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_resource_alerts_status ON resource_alerts(status)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_resource_alerts_server ON resource_alerts(server_id)'); } catch {}
}

module.exports = { applyMigrations };
