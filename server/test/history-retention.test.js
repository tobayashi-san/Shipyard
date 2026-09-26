const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-retention-'));
process.env.DB_PATH = path.join(root, 'test.db');
process.env.NODE_ENV = 'test';
const db = require('../db');
const { runRetention, trimOldOutput, outputRetentionDays, TRIM_MARKER } = require('../services/history-retention');
after(() => { db.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const host = db.servers.create({ name: 'retention-host', hostname: 'retention-host', ip_address: '192.0.2.10' });
const output = row => db.db.prepare('SELECT output FROM update_history WHERE id = ?').get(row).output;
function run(completedDaysAgo, text) {
  const id = db.updateHistory.create(host.id, 'update');
  db.updateHistory.updateStatus(id, 'success', text);
  db.db.prepare("UPDATE update_history SET completed_at = datetime('now', ?) WHERE id = ?").run(`-${completedDaysAgo} days`, id);
  return id;
}

test('old output keeps its tail and a marker; recent and short output stay whole', () => {
  const long = `${'x'.repeat(50_000)}\nPLAY RECAP\nhost : ok=3 failed=0\n`;
  const old = run(120, long);
  const recent = run(5, long);
  const short = run(120, 'done\n');

  assert.equal(trimOldOutput(90, 1024), 1);
  const trimmed = output(old);
  assert.ok(trimmed.startsWith(TRIM_MARKER));
  assert.ok(trimmed.endsWith('PLAY RECAP\nhost : ok=3 failed=0\n'));
  assert.equal(trimmed.length, TRIM_MARKER.length + 1024);
  assert.equal(output(recent), long);
  assert.equal(output(short), 'done\n');

  assert.equal(trimOldOutput(90, 1024), 0, 'already trimmed rows are left alone');
});

test('retention prunes old audit entries and reads the configured output age', () => {
  db.auditLog.write('test.old', 'old entry', null, true, 'tester');
  db.db.prepare("UPDATE audit_log SET created_at = datetime('now', '-200 days') WHERE action = 'test.old'").run();
  assert.ok(runRetention({ FLEET_HISTORY_OUTPUT_DAYS: '30' }).audit >= 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'test.old'").get().c, 0);

  assert.equal(outputRetentionDays({ FLEET_HISTORY_OUTPUT_DAYS: '30' }), 30);
  assert.equal(outputRetentionDays({ FLEET_HISTORY_OUTPUT_DAYS: '0' }), 90);
  assert.equal(outputRetentionDays({}), 90);
});
