function applyMigrations(db) {
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
  try { db.exec("ALTER TABLE update_history ADD COLUMN triggered_by TEXT"); } catch {}
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
