'use strict';

const log = require('../../utils/logger').child('features:opentofu:schema');
const { ensureManagedServersTable, removeOrphanedServerMappings } = require('./managed-servers');

/**
 * Applies the idempotent OpenTofu schema and repairs run state that cannot
 * survive a server restart.
 * @param {import('better-sqlite3').Database} database
 */
function setupOpenTofuDatabase(database) {
  const db = { db: database };
  // ── DB setup ──────────────────────────────────────────────────────────────
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      env_vars    TEXT NOT NULL DEFAULT '{}',
      environment_id TEXT NOT NULL DEFAULT 'default',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_connections (
      id             TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL DEFAULT 'default',
      name           TEXT NOT NULL,
      endpoint       TEXT NOT NULL,
      api_token      TEXT NOT NULL,
      insecure       INTEGER NOT NULL DEFAULT 0,
      ssh_public_key TEXT NOT NULL DEFAULT '',
      auto_sync_ipam INTEGER NOT NULL DEFAULT 1,
      sync_interval_min INTEGER NOT NULL DEFAULT 15,
      last_ipam_synced_at TEXT,
      last_ipam_status TEXT NOT NULL DEFAULT '',
      last_ipam_error TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(environment_id, name)
    )
  `).run();
  try { db.db.prepare('ALTER TABLE tofu_proxmox_connections ADD COLUMN auto_sync_ipam INTEGER NOT NULL DEFAULT 1').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_connections ADD COLUMN sync_interval_min INTEGER NOT NULL DEFAULT 15').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_connections ADD COLUMN last_ipam_synced_at TEXT').run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_proxmox_connections ADD COLUMN last_ipam_status TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_proxmox_connections ADD COLUMN last_ipam_error TEXT NOT NULL DEFAULT ''").run(); } catch {}
  // Existing Proxmox guests can be adopted as hosts without becoming OpenTofu
  // resources. The mapping keeps Proxmox-only actions such as snapshots
  // available while preserving the VM's current configuration.
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS proxmox_inventory_servers (
      server_id     TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      node_name     TEXT NOT NULL,
      vm_id         INTEGER NOT NULL,
      guest_type    TEXT NOT NULL DEFAULT 'qemu',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connection_id, node_name, vm_id)
    )
  `).run();
  try { db.db.prepare("ALTER TABLE proxmox_inventory_servers ADD COLUMN guest_type TEXT NOT NULL DEFAULT 'qemu'").run(); } catch {}
  // Existing Shipyard installations get the same default environment as legacy
  // servers. The guards keep this migration safe for fresh and old databases.
  try { db.db.prepare("CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now'))) ").run(); } catch {}
  try { db.db.prepare("INSERT OR IGNORE INTO environments (id, name) VALUES ('default', 'Standardumgebung')").run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_workspaces ADD COLUMN environment_id TEXT DEFAULT 'default'").run(); } catch {}
  // A deployment may consume an environment-level Proxmox source. Keeping the
  // relation on the workspace (instead of copying a token into it) makes one
  // cluster usable by many deployments and keeps credentials in one place.
  try { db.db.prepare('ALTER TABLE tofu_workspaces ADD COLUMN proxmox_connection_id TEXT').run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_workspaces ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'legacy'").run(); } catch {}
  try { db.db.prepare("ALTER TABLE tofu_workspaces ADD COLUMN migration_status TEXT NOT NULL DEFAULT ''").run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_workspaces ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  db.db.prepare("UPDATE tofu_workspaces SET migration_status = 'interrupted', read_only = 0 WHERE migration_status = 'running'").run();
  try { db.db.prepare("UPDATE tofu_workspaces SET environment_id = 'default' WHERE environment_id IS NULL OR environment_id = ''").run(); } catch {}
  try { db.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_tofu_workspace_name_unique ON tofu_workspaces(name COLLATE NOCASE)').run(); }
  catch (error) { log.error({ err: error }, 'Existing duplicate OpenTofu workspace names require manual resolution'); }
  
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_runs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      output       TEXT NOT NULL DEFAULT '',
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `).run();
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN plan_path TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN config_hash TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN plan_summary TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN approved_plan_id TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN started_by TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN plan_safe INTEGER').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_runs ADD COLUMN plan_validation TEXT').run(); } catch {}
  // Processes cannot survive an application restart. Repair stale rows before
  // enabling the database-enforced one-run-per-workspace lock.
  db.db.prepare(`
    UPDATE tofu_runs
    SET status = 'interrupted',
        output = output || '\n[Shipyard] Run interrupted by a restart. Review state before a new apply.\n',
        completed_at = datetime('now')
    WHERE status IN ('running', 'cancelling')
  `).run();
  db.db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_tofu_one_running_workspace ON tofu_runs(workspace_id) WHERE status IN ('running', 'cancelling')").run();
  
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_vms (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      config       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, name)
    )
  `).run();
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vms ADD COLUMN connection_id TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vms ADD COLUMN template_id TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vms ADD COLUMN vm_numeric_id INTEGER').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vms ADD COLUMN is_isolated INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  // Legacy workspaces may contain multiple VMs until an operator runs the
  // explicit state migration. New VM units are isolated immediately.
  db.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_one_isolated_vm_per_workspace ON tofu_proxmox_vms(workspace_id) WHERE is_isolated = 1').run();
  db.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_tofu_vm_id_per_connection ON tofu_proxmox_vms(connection_id, vm_numeric_id) WHERE connection_id IS NOT NULL AND vm_numeric_id IS NOT NULL').run();
  
  // Templates are environment/platform-scoped. workspace_id remains nullable
  // as a compatibility column for legacy installations.
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_vm_templates (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      config       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, name)
    )
  `).run();
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vm_templates ADD COLUMN environment_id TEXT').run(); } catch {}
  try { db.db.prepare('ALTER TABLE tofu_proxmox_vm_templates ADD COLUMN connection_id TEXT').run(); } catch {}
  db.db.prepare(`
    UPDATE tofu_proxmox_vm_templates
    SET environment_id = COALESCE(environment_id, (
      SELECT environment_id FROM tofu_workspaces WHERE tofu_workspaces.id = tofu_proxmox_vm_templates.workspace_id
    ), 'default')
    WHERE environment_id IS NULL OR environment_id = ''
  `).run();
  try { db.db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_tofu_template_environment_name ON tofu_proxmox_vm_templates(environment_id, name COLLATE NOCASE) WHERE environment_id IS NOT NULL').run(); }
  catch (error) { log.warn({ err: error }, 'Legacy duplicate VM template names must be resolved before the global uniqueness index can be created'); }
  
  // Successful post-deploy steps are recorded per VM and playbook. This makes
  // a bootstrap idempotent across later `tofu apply` runs, while a failed step
  // remains eligible for a retry on the next apply.
  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS tofu_proxmox_playbook_runs (
      workspace_id TEXT NOT NULL,
      vm_id        TEXT NOT NULL,
      playbook     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      output       TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, vm_id, playbook)
    )
  `).run();
  
  ensureManagedServersTable(db);
  removeOrphanedServerMappings(db);
  
  
}

module.exports = { setupOpenTofuDatabase };
