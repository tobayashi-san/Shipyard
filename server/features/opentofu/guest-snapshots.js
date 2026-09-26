'use strict';

// Recovery points taken automatically before a host operation. Only snapshots
// carrying the Fleet prefix are pruned; manual snapshots are never touched.
const db = require('../../db');
const log = require('../../utils/logger').child('features:opentofu:guest-snapshots');
const { writeObjectAudit } = require('./object-audit');
const { requestProxmoxApi } = require('./proxmox-client');
const { readSavedProxmoxConnection } = require('./saved-connection');
const { linkedGuest } = require('./host-guest');

const AUTO_PREFIX = 'fleet-pre-';
const KEEP_AUTO_SNAPSHOTS = 3;
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const TASK_POLL_MS = 2000;

function autoSnapshotName(label, date = new Date()) {
  const slug = String(label || 'update').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'update';
  const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `${AUTO_PREFIX}${slug}-${stamp}`;
}

async function waitForTask(connection, nodeName, taskId) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await requestProxmoxApi(connection, `/nodes/${encodeURIComponent(nodeName)}/tasks/${encodeURIComponent(taskId)}/status`);
    if (result?.status === 'stopped') return typeof result.exitstatus === 'string' ? result.exitstatus : 'unknown';
    await new Promise(resolve => setTimeout(resolve, TASK_POLL_MS));
  }
  throw new Error('The Proxmox task did not finish within 10 minutes.');
}

async function resolveTarget(server) {
  const guest = linkedGuest(server);
  if (!guest) throw new Error('This host is not linked to a Proxmox VM or container.');
  const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(guest.connection_id);
  const connection = readSavedProxmoxConnection(source);
  // Confirm the guest exists before acting on it. Guest IDs are unique per
  // cluster, so the live node is used; the guest may have migrated.
  const resources = await requestProxmoxApi(connection, '/cluster/resources?type=vm');
  const resource = (Array.isArray(resources) ? resources : []).find(item =>
    String(item?.type) === guest.guest_type && Number(item?.vmid) === guest.vm_id);
  if (!resource?.node) throw new Error(`Proxmox ${guest.guest_type === 'lxc' ? 'container' : 'VM'} ${guest.vm_id} was not found on this platform.`);
  const vm = { name: String(resource.name || guest.vm_id), node_name: String(resource.node), vm_id: guest.vm_id, guest_type: guest.guest_type };
  return { source, connection, vm, path: `/nodes/${encodeURIComponent(vm.node_name)}/${vm.guest_type}/${vm.vm_id}` };
}

function recordTask(target, taskId, action, name, status = 'unknown', exitStatus = null) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 512) return;
  db.db.prepare(`INSERT OR REPLACE INTO proxmox_guest_tasks (connection_id, environment_id, endpoint, node_name, vm_id, task_id, action, resource_name, status, exit_status, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(target.source.id, target.source.environment_id, target.source.endpoint, target.vm.node_name, target.vm.vm_id, taskId, action, name, status, exitStatus);
}

function audit(target, action, detail, { ip, actor }) {
  db.db.transaction(() => {
    const id = writeObjectAudit(db, target.source, target.vm.node_name, action, `source_id=${JSON.stringify(target.source.id)} node=${JSON.stringify(target.vm.node_name)} source=${target.source.name} vm=${target.vm.name} vm_id=${target.vm.vm_id} ${detail}`, ip, actor);
    db.db.prepare('INSERT INTO proxmox_guest_audit (audit_id, connection_id, environment_id, node_name, vm_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, target.source.id, target.source.environment_id, target.vm.node_name, target.vm.vm_id);
  })();
}

async function runTask(target, method, suffix, payload, action, name) {
  const taskId = await requestProxmoxApi(target.connection, `${target.path}${suffix}`, { method, payload });
  const exitStatus = typeof taskId === 'string' ? await waitForTask(target.connection, target.vm.node_name, taskId) : 'OK';
  recordTask(target, taskId, action, name, exitStatus === 'OK' ? 'succeeded' : 'failed', exitStatus);
  if (exitStatus !== 'OK') throw new Error(`Proxmox reported: ${exitStatus}`);
}

/**
 * Take a disk-only snapshot of the host's linked guest and wait until Proxmox
 * finishes it. Throws when the snapshot cannot be confirmed.
 */
async function createPreRunSnapshot(server, label, { reason, ip = null, actor = null } = {}) {
  const target = await resolveTarget(server);
  const name = autoSnapshotName(label);
  const payload = { snapname: name, description: String(reason || `Taken by Fleet before ${label}`).slice(0, 512) };
  if (target.vm.guest_type === 'qemu') payload.vmstate = 0;
  await runTask(target, 'POST', '/snapshot', payload, 'snapshot_create', name);
  audit(target, 'infrastructure.snapshot_create', `snapshot=${name} automatic=true`, { ip, actor });
  return { name, guest: target.vm };
}

/** Delete older Fleet snapshots so only the newest few remain. */
async function pruneAutoSnapshots(server, { ip = null, actor = null, keep = KEEP_AUTO_SNAPSHOTS } = {}) {
  const target = await resolveTarget(server);
  const snapshots = await requestProxmoxApi(target.connection, `${target.path}/snapshot`);
  const stale = (Array.isArray(snapshots) ? snapshots : [])
    .filter(item => typeof item?.name === 'string' && item.name.startsWith(AUTO_PREFIX))
    .sort((a, b) => Number(b.snaptime || 0) - Number(a.snaptime || 0))
    .slice(keep);
  const removed = [];
  for (const snapshot of stale) {
    await runTask(target, 'DELETE', `/snapshot/${encodeURIComponent(snapshot.name)}`, undefined, 'snapshot_delete', snapshot.name);
    audit(target, 'infrastructure.snapshot_delete', `snapshot=${snapshot.name} automatic=true`, { ip, actor });
    removed.push(snapshot.name);
  }
  if (removed.length) log.info({ server: server.name, removed }, 'Pruned automatic snapshots');
  return removed;
}

module.exports = { AUTO_PREFIX, KEEP_AUTO_SNAPSHOTS, autoSnapshotName, createPreRunSnapshot, pruneAutoSnapshots };
