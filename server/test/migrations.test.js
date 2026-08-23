const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { applySchema } = require('../db/schema');
const { applyMigrations, CURRENT_SCHEMA_VERSION } = require('../db/migrations');

test('database migrations are transactional, versioned, and idempotent', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    applyMigrations(db);
    applyMigrations(db);

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(versions, [{ version: CURRENT_SCHEMA_VERSION }]);
    assert.equal(db.inTransaction, false);
  } finally {
    db.close();
  }
});

test('database migrations preserve rows while restoring legacy columns and tables', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    db.prepare(`INSERT INTO servers (id, name, hostname, ip_address)
      VALUES ('legacy-server', 'Legacy server', 'legacy-server', '10.0.0.8')`).run();
    db.exec('DROP TABLE maintenance_windows');
    db.exec('ALTER TABLE servers DROP COLUMN host_fingerprint');
    db.exec('ALTER TABLE servers DROP COLUMN docker_enabled');

    applyMigrations(db);

    const columns = new Set(db.prepare('PRAGMA table_info(servers)').all().map((column) => column.name));
    assert.equal(columns.has('host_fingerprint'), true);
    assert.equal(columns.has('docker_enabled'), true);
    assert.equal(db.prepare('SELECT name FROM servers WHERE id = ?').get('legacy-server').name, 'Legacy server');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_windows'").get().name, 'maintenance_windows');
  } finally {
    db.close();
  }
});

test('database migrations rename the untouched legacy default environment', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    db.prepare("UPDATE environments SET name = 'Standardumgebung' WHERE id = 'default'").run();

    applyMigrations(db);

    assert.equal(db.prepare("SELECT name FROM environments WHERE id = 'default'").get().name, 'Default environment');
  } finally {
    db.close();
  }
});

test('database migrations keep a legacy default name when the replacement name is already taken', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    db.prepare("UPDATE environments SET name = 'Standardumgebung' WHERE id = 'default'").run();
    db.prepare("INSERT INTO environments (id, name) VALUES ('existing-english', 'Default environment')").run();

    applyMigrations(db);

    assert.equal(db.prepare("SELECT name FROM environments WHERE id = 'default'").get().name, 'Standardumgebung');
  } finally {
    db.close();
  }
});

test('database migrations rename the untouched legacy product name', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('wl_app_name', 'Fleet')").run();

    applyMigrations(db);

    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'wl_app_name'").get().value, 'Shipyard');
  } finally {
    db.close();
  }
});

test('database migrations fail loudly and roll back when required schema is corrupt', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE servers (id TEXT PRIMARY KEY)');
    assert.throws(() => applyMigrations(db), /Database migration failed: required column 'servers\.name' is missing/);
    assert.equal(db.inTransaction, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get().count, 0);
  } finally {
    db.close();
  }
});
