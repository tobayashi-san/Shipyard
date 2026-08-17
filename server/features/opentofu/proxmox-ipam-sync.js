'use strict';

const { randomUUID } = require('crypto');
const db = require('../../db');
const log = require('../../utils/logger').child('features:opentofu:ipam-sync');
const cryptoUtil = require('../../utils/crypto');
const {
  extractProxmoxGuestNetworkRecords,
  extractProxmoxLxcNetworkRecords,
  ipv4Number,
  subnetContainsIpv4,
} = require('./proxmox-blueprints');
const { createProxmoxConnection, requestProxmoxApi } = require('./proxmox-client');

const activeSyncs = new Set();

function guestApiPath(guest, suffix = '') {
  return `/nodes/${encodeURIComponent(guest.node_name)}/${guest.guest_type}/${guest.vm_id}${suffix}`;
}

async function getGuestNetworkRecords(connection, guest) {
  if (guest.guest_type === 'lxc') {
    try {
      const payload = await requestProxmoxApi(connection, guestApiPath(guest, '/interfaces'));
      const records = extractProxmoxLxcNetworkRecords(payload);
      if (records.length) return records;
    } catch {}
    const config = await requestProxmoxApi(connection, guestApiPath(guest, '/config'));
    const interfaces = Object.entries(config && typeof config === 'object' ? config : {})
      .filter(([key, value]) => /^net\d+$/.test(key) && typeof value === 'string')
      .map(([name, value]) => {
        const options = String(value).split(',').reduce((result, item) => {
          const separator = item.indexOf('=');
          if (separator > 0) result[item.slice(0, separator)] = item.slice(separator + 1);
          return result;
        }, {});
        return { name: options.name || name, inet: options.ip || '', hwaddr: options.hwaddr || '' };
      });
    return extractProxmoxLxcNetworkRecords(interfaces);
  }
  const payload = await requestProxmoxApi(connection, guestApiPath(guest, '/agent/network-get-interfaces'));
  return extractProxmoxGuestNetworkRecords(payload);
}

function readConnection(source) {
  const token = cryptoUtil.decrypt(String(source.api_token || ''));
  if (!token || String(token).startsWith('enc:')) throw new Error(`Credentials for Proxmox connection "${source.name}" cannot be read.`);
  return createProxmoxConnection(source.endpoint, token, Boolean(source.insecure));
}

function prefixLength(cidr) {
  return Number.parseInt(String(cidr || '').split('/')[1], 10) || 0;
}

function reconcileSubnet(source, subnet, observations, mappedServers) {
  const occupiedRanges = db.db.prepare('SELECT start_address, end_address FROM ipam_ip_ranges WHERE subnet_id = ?').all(subnet.id)
    .map(row => ({ start: ipv4Number(row.start_address), end: ipv4Number(row.end_address) }));
  const getReservation = db.db.prepare('SELECT * FROM ipam_reservations WHERE subnet_id = ? AND address = ?');
  const insertReservation = db.db.prepare('INSERT INTO ipam_reservations (id, subnet_id, address, hostname, server_id, mac_address, status, role, description, source_type, source_ref, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))');
  const updateReservation = db.db.prepare('UPDATE ipam_reservations SET hostname = ?, server_id = ?, mac_address = ?, status = ?, source_ref = ?, last_synced_at = datetime(\'now\') WHERE id = ?');
  const insertConflict = db.db.prepare(`INSERT INTO ipam_proxmox_sync_conflicts (id, environment_id, subnet_id, connection_id, address, hostname, mac_address, reason, existing_reservation_id, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
  db.db.prepare('DELETE FROM ipam_proxmox_sync_conflicts WHERE connection_id = ? AND subnet_id = ?').run(source.id, subnet.id);
  const stats = { discovered: 0, created: 0, updated: 0, conflicts: 0, skipped: 0, failed: 0 };
  for (const { vm, record } of observations) {
    const address = record.address;
    const macAddress = record.mac_address;
    stats.discovered += 1;
    const number = ipv4Number(address);
    if (number === null || occupiedRanges.some(range => range.start !== null && range.end !== null && number >= range.start && number <= range.end)) { stats.skipped += 1; continue; }
    const sourceRef = `${source.id}:${vm.node_name}:${vm.vm_id}`;
    const existing = getReservation.get(subnet.id, address);
    const hostname = String(vm.name || `${vm.guest_type === 'lxc' ? 'CT' : 'VM'} ${vm.vm_id}`).slice(0, 100);
    const serverId = mappedServers.get(`${vm.node_name}:${vm.vm_id}`) || null;
    if (number === ipv4Number(subnet.gateway)) {
      insertConflict.run(randomUUID(), source.environment_id, subnet.id, source.id, address, hostname, macAddress, 'Address is configured as the prefix gateway', null);
      stats.conflicts += 1;
    } else if (!existing) {
      insertReservation.run(randomUUID(), subnet.id, address, hostname, serverId, macAddress, 'active', '', '', 'proxmox', sourceRef);
      stats.created += 1;
    } else if (existing.source_type === 'proxmox' && String(existing.source_ref || '').startsWith(`${source.id}:`)) {
      updateReservation.run(hostname, serverId, macAddress, 'active', sourceRef, existing.id);
      stats.updated += 1;
    } else if (macAddress && String(existing.mac_address || '').toLowerCase().replace(/[^a-f0-9]/g, '') === macAddress.replace(/:/g, '')) {
      db.db.prepare("UPDATE ipam_reservations SET mac_address = CASE WHEN mac_address = '' THEN ? ELSE mac_address END, last_synced_at = datetime('now') WHERE id = ?").run(macAddress, existing.id);
      stats.updated += 1;
    } else {
      insertConflict.run(randomUUID(), source.environment_id, subnet.id, source.id, address, hostname, macAddress, `Address is already reserved ${existing.source_type === 'manual' ? 'manually' : 'by another source'}${existing.hostname ? ` (${existing.hostname})` : ''}`, existing.id);
      stats.conflicts += 1;
    }
  }
  return stats;
}

async function syncProxmoxIpam(connectionId, { subnetId = null, actor = 'scheduler', ip = null } = {}) {
  if (activeSyncs.has(connectionId)) throw new Error('This Proxmox IPAM source is already synchronizing.');
  const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(connectionId);
  if (!source) { const error = new Error('Proxmox platform not found.'); error.status = 404; throw error; }
  const subnets = subnetId
    ? db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ? AND environment_id = ?').all(subnetId, source.environment_id)
    : db.db.prepare('SELECT * FROM ipam_subnets WHERE environment_id = ?').all(source.environment_id);
  if (subnetId && !subnets.length) { const error = new Error('IPAM prefix not found.'); error.status = 404; throw error; }
  activeSyncs.add(connectionId);
  try {
    const connection = readConnection(source);
    const resources = await requestProxmoxApi(connection, '/cluster/resources?type=vm');
    const guests = (Array.isArray(resources) ? resources : [])
      .filter(resource => ['qemu', 'lxc'].includes(String(resource?.type || '').toLowerCase()))
      .map(resource => ({ name: resource.name, node_name: String(resource.node || ''), vm_id: Number(resource.vmid), guest_type: String(resource.type).toLowerCase() }))
      .filter(guest => guest.node_name && Number.isInteger(guest.vm_id));
    const mappedServers = new Map(db.db.prepare('SELECT server_id, node_name, vm_id FROM proxmox_inventory_servers WHERE connection_id = ?').all(source.id).map(row => [`${row.node_name}:${row.vm_id}`, row.server_id]));
    const observationsBySubnet = new Map(subnets.map(subnet => [subnet.id, []]));
    let failed = 0;
    for (const vm of guests) {
      try {
        const records = await getGuestNetworkRecords(connection, vm);
        for (const record of records) {
          const matches = subnets.filter(subnet => subnetContainsIpv4(subnet.cidr, record.address)).sort((a, b) => prefixLength(b.cidr) - prefixLength(a.cidr));
          // Only the most-specific matching prefix owns the observation. This
          // avoids duplicate reservations when parent and child prefixes exist.
          const targets = matches.slice(0, 1);
          for (const subnet of targets) observationsBySubnet.get(subnet.id).push({ vm, record });
        }
      } catch (error) {
        failed += 1;
        log.warn({ err: error, connection: source.name, nodeName: vm.node_name, vmId: vm.vm_id }, 'Could not read Proxmox guest addresses for IPAM sync');
      }
    }
    const total = { discovered: 0, created: 0, updated: 0, conflicts: 0, skipped: 0, failed, prefixes: subnets.length };
    for (const subnet of subnets) {
      const stats = reconcileSubnet(source, subnet, observationsBySubnet.get(subnet.id), mappedServers);
      for (const key of ['discovered', 'created', 'updated', 'conflicts', 'skipped']) total[key] += stats[key];
    }
    const now = new Date().toISOString();
    db.db.prepare("UPDATE tofu_proxmox_connections SET last_ipam_synced_at = ?, last_ipam_status = 'success', last_ipam_error = '', updated_at = datetime('now') WHERE id = ?").run(now, source.id);
    db.auditLog.write('ipam.proxmox_sync', `source=${source.name} prefixes=${subnets.length} discovered=${total.discovered} created=${total.created} updated=${total.updated}`, ip, true, actor);
    return total;
  } catch (error) {
    db.db.prepare("UPDATE tofu_proxmox_connections SET last_ipam_status = 'failed', last_ipam_error = ?, updated_at = datetime('now') WHERE id = ?").run(String(error.message || 'Sync failed').slice(0, 500), source.id);
    throw error;
  } finally {
    activeSyncs.delete(connectionId);
  }
}

module.exports = { syncProxmoxIpam };
