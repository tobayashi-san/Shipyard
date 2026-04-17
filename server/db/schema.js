function applySchema(db) {
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
      links TEXT DEFAULT '[]',
      storage_mounts TEXT DEFAULT '[]',
      status TEXT DEFAULT 'unknown',
      last_seen TEXT,
      notes TEXT NOT NULL DEFAULT '',
      group_id TEXT,
      host_fingerprint TEXT DEFAULT '',
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_info_server_id      ON server_info(server_id);
    CREATE INDEX IF NOT EXISTS idx_update_history_server_id   ON update_history(server_id);
    CREATE INDEX IF NOT EXISTS idx_update_history_started_at  ON update_history(started_at);
    CREATE INDEX IF NOT EXISTS idx_docker_containers_server   ON docker_containers(server_id);
    CREATE INDEX IF NOT EXISTS idx_compose_projects_server    ON compose_projects(server_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_updates_cache (
      server_id TEXT PRIMARY KEY,
      updates_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS docker_image_updates_cache (
      server_id TEXT PRIMARY KEY,
      results_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_update_tasks (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'script',
      check_command TEXT,
      github_repo TEXT,
      update_command TEXT DEFAULT '',
      trigger_output TEXT,
      latest_command TEXT,
      last_version TEXT,
      current_version TEXT,
      has_update INTEGER DEFAULT 0,
      last_checked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_custom_update_tasks_server ON custom_update_tasks(server_id);
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);`);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      is_system INTEGER DEFAULT 0,
      permissions TEXT DEFAULT '{}'
    );
  `);
}

module.exports = { applySchema };
