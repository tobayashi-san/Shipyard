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
      environment_id TEXT DEFAULT 'default',
      host_fingerprint TEXT DEFAULT '',
      docker_enabled INTEGER DEFAULT 0,
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
      environment_id TEXT NOT NULL DEFAULT 'default',
      action TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      output TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      triggered_by TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- A key is stored once; assignments describe where Shipyard is allowed to
    -- use it. target_type/target_id stay polymorphic so the core can point to
    -- optional OpenTofu deployments and VM templates without a hard DB link.
    CREATE TABLE IF NOT EXISTS ssh_key_assignments (
      id TEXT PRIMARY KEY,
      key_name TEXT NOT NULL DEFAULT 'fleet',
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_label TEXT NOT NULL DEFAULT '',
      environment_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(key_name, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ssh_key_assignments_environment ON ssh_key_assignments(environment_id, target_type);

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
      environment_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      playbook TEXT NOT NULL,
      targets TEXT DEFAULT 'all',
      cron_expression TEXT NOT NULL,
      extra_vars TEXT NOT NULL DEFAULT '{}',
      check_mode INTEGER NOT NULL DEFAULT 0,
      forks INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      last_status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO environments (id, name) VALUES ('default', 'Default environment');
  `);

  // IPAM is environment-scoped, so the same RFC1918 ranges can exist in
  // isolated lab, staging and production environments without ambiguity.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ipam_subnets (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      cidr TEXT NOT NULL,
      gateway TEXT DEFAULT '',
      dhcp_start TEXT DEFAULT '',
      dhcp_end TEXT DEFAULT '',
      dns_servers TEXT DEFAULT '[]',
      vlan_id INTEGER,
      bridge TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(environment_id, cidr)
    );
    CREATE TABLE IF NOT EXISTS ipam_reservations (
      id TEXT PRIMARY KEY,
      subnet_id TEXT NOT NULL,
      address TEXT NOT NULL,
      hostname TEXT DEFAULT '',
      server_id TEXT,
      mac_address TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT DEFAULT '',
      description TEXT DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT DEFAULT '',
      last_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(subnet_id, address),
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS ipam_ip_ranges (
      id TEXT PRIMARY KEY,
      subnet_id TEXT NOT NULL,
      start_address TEXT NOT NULL,
      end_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      role TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ipam_subnets_environment ON ipam_subnets(environment_id);
    CREATE INDEX IF NOT EXISTS idx_ipam_reservations_subnet ON ipam_reservations(subnet_id);
    CREATE INDEX IF NOT EXISTS idx_ipam_ranges_subnet ON ipam_ip_ranges(subnet_id);

    -- Operator-assigned device names belong to the hardware identity, not to
    -- a lease. A reservation can therefore move to another DHCP address
    -- without losing the name chosen in Shipyard.
    CREATE TABLE IF NOT EXISTS ipam_device_names (
      environment_id TEXT NOT NULL,
      mac_address TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (environment_id, mac_address),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ipam_device_names_name ON ipam_device_names(environment_id, name);

    -- Repair legacy cross-environment links and enforce the boundary for every
    -- writer, not only the HTTP route validation.
    UPDATE ipam_reservations
    SET server_id = NULL
    WHERE server_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM servers s
        JOIN ipam_subnets n ON n.id = ipam_reservations.subnet_id
        WHERE s.id = ipam_reservations.server_id
          AND s.environment_id = n.environment_id
      );
    CREATE TRIGGER IF NOT EXISTS ipam_reservation_server_environment_insert
    BEFORE INSERT ON ipam_reservations
    WHEN NEW.server_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM servers s
        JOIN ipam_subnets n ON n.id = NEW.subnet_id
        WHERE s.id = NEW.server_id
          AND s.environment_id = n.environment_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'Host and IPAM prefix must belong to the same environment');
    END;
    CREATE TRIGGER IF NOT EXISTS ipam_reservation_server_environment_update
    BEFORE UPDATE OF server_id, subnet_id ON ipam_reservations
    WHEN NEW.server_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM servers s
        JOIN ipam_subnets n ON n.id = NEW.subnet_id
        WHERE s.id = NEW.server_id
          AND s.environment_id = n.environment_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'Host and IPAM prefix must belong to the same environment');
    END;

    -- External inventory sources deliberately live separately from prefixes.
    -- A source can contribute addresses to several prefixes, while its
    -- credential remains encrypted and is never exposed through the API.
    CREATE TABLE IF NOT EXISTS ipam_sync_sources (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      api_token TEXT NOT NULL DEFAULT '',
      site TEXT DEFAULT 'default',
      path TEXT DEFAULT '',
      insecure INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_sync INTEGER NOT NULL DEFAULT 1,
      sync_interval_min INTEGER NOT NULL DEFAULT 15,
      last_synced_at TEXT,
      last_status TEXT DEFAULT '',
      last_error TEXT DEFAULT '',
      last_tested_at TEXT,
      last_test_status TEXT DEFAULT '',
      last_test_error TEXT DEFAULT '',
      last_record_count INTEGER NOT NULL DEFAULT 0,
      last_ignored_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ipam_sync_sources_environment ON ipam_sync_sources(environment_id);

    -- A unique address reservation cannot represent a collision without
    -- losing one of the inventories. Keep the competing observation here so
    -- operators can see and resolve it in the affected prefix.
    CREATE TABLE IF NOT EXISTS ipam_sync_conflicts (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      address TEXT NOT NULL,
      hostname TEXT DEFAULT '',
      mac_address TEXT DEFAULT '',
      reason TEXT NOT NULL,
      existing_reservation_id TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES ipam_sync_sources(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ipam_sync_conflicts_source_address ON ipam_sync_conflicts(source_id, address);
    CREATE INDEX IF NOT EXISTS idx_ipam_sync_conflicts_subnet ON ipam_sync_conflicts(subnet_id);

    -- Keep every controller observation even when several sources describe
    -- the same machine. The reservation remains the canonical IPAM object;
    -- observations provide provenance and safe source lifecycle handling.
    CREATE TABLE IF NOT EXISTS ipam_source_observations (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      reservation_id TEXT,
      address TEXT NOT NULL,
      hostname TEXT DEFAULT '',
      mac_address TEXT DEFAULT '',
      last_seen_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES ipam_sync_sources(id) ON DELETE CASCADE,
      FOREIGN KEY (reservation_id) REFERENCES ipam_reservations(id) ON DELETE SET NULL,
      UNIQUE(source_id, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_ipam_source_observations_reservation ON ipam_source_observations(reservation_id);
    CREATE INDEX IF NOT EXISTS idx_ipam_source_observations_source ON ipam_source_observations(source_id);
    INSERT OR IGNORE INTO ipam_source_observations (
      id, environment_id, subnet_id, source_id, source_ref, reservation_id,
      address, hostname, mac_address, last_seen_at
    )
    SELECT
      lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
        substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
        lower(hex(randomblob(6))),
      subnet.environment_id, reservation.subnet_id, source.id,
      reservation.source_ref, reservation.id, reservation.address,
      reservation.hostname, reservation.mac_address,
      COALESCE(reservation.last_synced_at, reservation.created_at, datetime('now'))
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    WHERE reservation.source_ref != '';

    -- Proxmox connections are not external IPAM sources, but their guest
    -- agent inventory can report a competing address as well.  Keep those
    -- observations separately so the foreign-key lifecycle of API sources
    -- remains intact and every conflict still has an explicit provenance.
    CREATE TABLE IF NOT EXISTS ipam_proxmox_sync_conflicts (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      address TEXT NOT NULL,
      hostname TEXT DEFAULT '',
      mac_address TEXT DEFAULT '',
      reason TEXT NOT NULL,
      existing_reservation_id TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
      FOREIGN KEY (subnet_id) REFERENCES ipam_subnets(id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES tofu_proxmox_connections(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ipam_proxmox_conflicts_connection_address ON ipam_proxmox_sync_conflicts(connection_id, subnet_id, address);
    CREATE INDEX IF NOT EXISTS idx_ipam_proxmox_conflicts_subnet ON ipam_proxmox_sync_conflicts(subnet_id);

    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_windows_environment_time ON maintenance_windows(environment_id, starts_at, ends_at);
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
      pending_token TEXT,
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
    CREATE TABLE IF NOT EXISTS server_alert_settings (
      server_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      notify_enabled INTEGER NOT NULL DEFAULT 1,
      trigger_after_seconds INTEGER NOT NULL DEFAULT 60,
      thresholds_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

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
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_alerts_active_key
      ON resource_alerts(server_id, type, target_key)
      WHERE status IN ('pending', 'active', 'acknowledged');
    CREATE INDEX IF NOT EXISTS idx_resource_alerts_status ON resource_alerts(status);
    CREATE INDEX IF NOT EXISTS idx_resource_alerts_server ON resource_alerts(server_id);
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
      environment_id TEXT NOT NULL DEFAULT 'default',
      action TEXT NOT NULL,
      detail TEXT,
      user TEXT,
      ip TEXT,
      success INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);`,
  );
  // Legacy databases receive environment_id in the migration phase below.
  // Creating this index here is therefore best-effort until that phase ran.
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_audit_log_environment_created ON audit_log(environment_id, created_at DESC);`,
    );
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_history (
      id TEXT PRIMARY KEY,
      schedule_id TEXT,
      environment_id TEXT NOT NULL DEFAULT 'default',
      schedule_name TEXT NOT NULL,
      playbook TEXT NOT NULL,
      targets TEXT DEFAULT 'all',
      triggered_by TEXT,
      check_mode INTEGER NOT NULL DEFAULT 0,
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
      environment_id TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(environment_id, key)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_groups (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      parent_id TEXT,
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
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
      disabled INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);`,
    );
  } catch {}

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
