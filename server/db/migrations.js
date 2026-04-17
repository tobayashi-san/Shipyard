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
}

module.exports = { applyMigrations };
