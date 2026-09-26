const {test} = require('node:test');
const assert = require('node:assert/strict');
const {collectStorageResults} = require('../features/opentofu/storage-inventory');

test('storage inventory keeps current capacity without time series or persistence', () => {
  const nodes = [{name:'pve01'}, {name:'unavailable'}];
  const stores = collectStorageResults(nodes, [
    {status:'fulfilled',value:[{storage:'local',type:'dir',active:1,enabled:1,used:10,total:100,avail:90}]},
    {status:'rejected',reason:new Error('offline')},
  ]);
  assert.equal(stores.length,1);
  assert.equal(stores[0].used,10);
  assert.equal(stores[0].capacity_history,undefined);
  assert.equal(stores[0].capacity_history_hourly,undefined);
  assert.equal(nodes[0].datastores_status,'available');
  assert.equal(nodes[1].datastores_status,'unavailable');
});

test('upgrading removes capacity histories and preserves current host facts', () => {
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  try {
    const {applySchema} = require('../db/schema');
    const {setupOpenTofuDatabase} = require('../features/opentofu/schema');
    applySchema(database);
    database.exec("CREATE TABLE server_info_history (server_id TEXT, cpu_usage REAL); INSERT INTO server_info_history VALUES ('host',42); CREATE TABLE proxmox_storage_history (used INTEGER); INSERT INTO proxmox_storage_history VALUES (123);");
    database.prepare('INSERT INTO servers (id,name,hostname,ip_address) VALUES (?,?,?,?)').run('host','host','host','192.0.2.1');
    applySchema(database);
    setupOpenTofuDatabase(database);
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('server_info_history','proxmox_storage_history')").get().count,0);
    assert.equal(database.prepare('SELECT ip_address FROM servers WHERE id=?').get('host').ip_address,'192.0.2.1');
  } finally { database.close(); }
});

test('mount metrics match the configured path even when df reports the parent mount point', () => {
  const { collectStorageMountMetrics, MOUNT_MARKER } = require('../utils/storage-mounts');
  const output = [
    `${MOUNT_MARKER}/mnt/nas/backup`,
    'Filesystem 1G-blocks Used Available Use% Mounted on',
    '//nas/share 900G 450G 450G 50% /mnt/nas',
    `${MOUNT_MARKER}/srv/missing`,
    `${MOUNT_MARKER}/mnt/de`,
    'Dateisystem 1G-Blöcke Benutzt Verfügbar Verw% Eingehängt auf',
    'nas:/movies 2000G 500G 1500G 25% /mnt/de',
  ].join('\n');
  const metrics = collectStorageMountMetrics([{ name: 'Backup', path: '/mnt/nas/backup' }, { name: 'Missing', path: '/srv/missing' }, { name: 'German', path: '/mnt/de' }], output);
  assert.equal(metrics[0].mounted, true);
  assert.equal(metrics[0].total_gb, 900);
  assert.equal(metrics[0].filesystem, '//nas/share');
  assert.equal(metrics[1].mounted, false);
  assert.equal(metrics[2].filesystem, 'nas:/movies');
  assert.equal(metrics[2].total_gb, 2000);
});
