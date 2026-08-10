const express = require('express');
const db = require('../db');
const { getPermissions, can } = require('../utils/permissions');

const router = express.Router();
const guard = (cap) => (req, res, next) => can(getPermissions(req.user), cap) ? next() : res.status(403).json({ error: 'Permission denied' });
const SUBNET_STATUSES = new Set(['active', 'container', 'reserved', 'deprecated']);
const ADDRESS_STATUSES = new Set(['active', 'reserved', 'dhcp', 'deprecated']);
const ADDRESS_ROLES = new Set(['', 'gateway', 'loopback', 'vip', 'secondary']);

function ipv4(value) {
  const chunks = String(value || '').trim().split('.');
  if (chunks.length !== 4 || chunks.some(chunk => !/^\d{1,3}$/.test(chunk) || Number(chunk) > 255)) return null;
  return chunks.reduce((total, chunk) => total * 256 + Number(chunk), 0) >>> 0;
}
function parseCidr(value) {
  const [address, prefixText, extra] = String(value || '').trim().split('/');
  const prefix = Number(prefixText);
  const ip = ipv4(address);
  if (extra || ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return { cidr: `${address}/${prefix}`, prefix, network: (ip & mask) >>> 0, mask };
}
function usableAddressCount(parsed) { const count = 2 ** (32 - parsed.prefix); return parsed.prefix <= 30 ? Math.max(0, count - 2) : count; }
function toIpv4(number) { return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.'); }
function isUsableAddress(number, parsed) {
  if (((number & parsed.mask) >>> 0) !== parsed.network) return false;
  if (parsed.prefix > 30) return true;
  const broadcast = (parsed.network | (~parsed.mask >>> 0)) >>> 0;
  return number !== parsed.network && number !== broadcast;
}
function usableRange(parsed) {
  const size = 2 ** (32 - parsed.prefix);
  const first = parsed.prefix <= 30 ? parsed.network + 1 : parsed.network;
  const last = parsed.prefix <= 30 ? parsed.network + size - 2 : parsed.network + size - 1;
  return { first: first >>> 0, last: last >>> 0 };
}
function prefixRange(parsed) {
  const size = 2 ** (32 - parsed.prefix);
  return { first: parsed.network, last: (parsed.network + size - 1) >>> 0 };
}
function cidrContains(container, child) {
  const containerRange = prefixRange(container); const childRange = prefixRange(child);
  return containerRange.first <= childRange.first && containerRange.last >= childRange.last;
}
function rangesOverlap(left, right) { return left.first <= right.last && right.first <= left.last; }
function validateChoice(value, choices, fallback = '') {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (!choices.has(normalized)) throw new Error('Ungültiger Status oder Rolle.');
  return normalized;
}
function getRanges(subnetId) { return db.db.prepare('SELECT * FROM ipam_ip_ranges WHERE subnet_id = ?').all(subnetId); }
function getUsage(subnet, directChildren = []) {
  const parsed = parseCidr(subnet.cidr); if (!parsed) return { usable: 0, used: 0, free: 0, reservationCount: 0, rangeCount: 0 };
  const reservations = db.db.prepare('SELECT address FROM ipam_reservations WHERE subnet_id = ?').all(subnet.id);
  const ranges = getRanges(subnet.id);
  const rangeUsage = ranges.reduce((total, row) => { const start = ipv4(row.start_address); const end = ipv4(row.end_address); return start === null || end === null ? total : total + end - start + 1; }, 0);
  const usable = usableAddressCount(parsed);
  // A direct child prefix consumes its entire address block in the parent.
  // Counting only direct children avoids counting nested prefixes twice.
  const childUsage = directChildren.reduce((total, child) => {
    const childParsed = parseCidr(child.cidr);
    return total + (childParsed ? 2 ** (32 - childParsed.prefix) : 0);
  }, 0);
  const used = Math.min(usable, reservations.length + rangeUsage + childUsage);
  return { usable, used, free: Math.max(0, usable - used), reservationCount: reservations.length, rangeCount: ranges.length, childUsage };
}
function enrichSubnet(subnet, allSubnets) {
  const parsed = parseCidr(subnet.cidr);
  const parents = (allSubnets || []).filter(candidate => candidate.id !== subnet.id).map(candidate => ({ candidate, parsed: parseCidr(candidate.cidr) })).filter(item => item.parsed && parsed && item.parsed.prefix < parsed.prefix && cidrContains(item.parsed, parsed)).sort((left, right) => right.parsed.prefix - left.parsed.prefix);
  const parentId = parents[0]?.candidate.id || null;
  const directChildren = (allSubnets || []).filter(candidate => {
    if (candidate.id === subnet.id) return false;
    const child = parseCidr(candidate.cidr);
    if (!child || !parsed || child.prefix <= parsed.prefix || !cidrContains(parsed, child)) return false;
    const ancestor = (allSubnets || []).filter(other => other.id !== candidate.id).map(other => ({ other, parsed: parseCidr(other.cidr) })).filter(item => item.parsed && item.parsed.prefix < child.prefix && cidrContains(item.parsed, child)).sort((left, right) => right.parsed.prefix - left.parsed.prefix)[0];
    return ancestor?.other.id === subnet.id;
  });
  const usage = getUsage(subnet, directChildren);
  let dnsServers = [];
  try { dnsServers = JSON.parse(subnet.dns_servers || '[]'); } catch { dnsServers = []; }
  return { ...subnet, dns_servers: Array.isArray(dnsServers) ? dnsServers : [], parent_id: parentId, parent_cidr: parents[0]?.candidate.cidr || null, child_prefix_count: directChildren.length, child_prefix_address_count: usage.childUsage, usable_address_count: usage.usable, used_address_count: usage.used, free_address_count: usage.free, reservation_count: usage.reservationCount, range_count: usage.rangeCount, next_free_address: parsed ? nextFreeAddress(subnet, parsed) : null };
}
function nextFreeAddress(subnet, parsed) {
  const taken = new Set(db.db.prepare('SELECT address FROM ipam_reservations WHERE subnet_id = ?').all(subnet.id).map(row => ipv4(row.address)).filter(value => value !== null));
  const occupiedRanges = getRanges(subnet.id).map(row => ({ start: ipv4(row.start_address), end: ipv4(row.end_address) })).filter(range => range.start !== null && range.end !== null);
  const { first, last } = usableRange(parsed);
  // Do not turn a malformed /0 into a long-running request. Normal IPAM
  // prefixes find their next gap almost immediately; very large networks are
  // still represented by their exact free count.
  const ceiling = Math.min(last, first + 1000000);
  for (let current = first; current <= ceiling; current += 1) if (!taken.has(current) && !occupiedRanges.some(range => current >= range.start && current <= range.end)) return toIpv4(current);
  return null;
}
function parseDns(value) {
  if (!Array.isArray(value)) return [];
  const servers = value.map(item => String(item || '').trim()).filter(Boolean);
  if (servers.some(server => ipv4(server) === null)) throw new Error('DNS-Server müssen IPv4-Adressen sein.');
  return [...new Set(servers)].slice(0, 6);
}

router.get('/subnets', guard('canViewServers'), (req, res) => {
  const environmentId = String(req.query.environment_id || 'default').trim() || 'default';
  const rows = db.db.prepare('SELECT * FROM ipam_subnets WHERE environment_id = ? ORDER BY cidr').all(environmentId);
  res.json(rows.map(row => enrichSubnet(row, rows)));
});

router.get('/subnets/:id', guard('canViewServers'), (req, res) => {
  const subnet = db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Netzwerk nicht gefunden.' });
  const allSubnets = db.db.prepare('SELECT * FROM ipam_subnets WHERE environment_id = ?').all(subnet.environment_id);
  res.json(enrichSubnet(subnet, allSubnets));
});

router.post('/subnets', guard('canEditServers'), (req, res) => {
  try {
    const body = req.body || {};
    const environmentId = String(body.environment_id || 'default').trim() || 'default';
    const name = String(body.name || '').trim().slice(0, 80);
    const parsed = parseCidr(body.cidr);
    const gateway = String(body.gateway || '').trim();
    if (!name || !parsed) return res.status(400).json({ error: 'Name und gültiges IPv4-CIDR sind erforderlich.' });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Umgebung nicht gefunden.' });
    if (gateway && (ipv4(gateway) === null || ((ipv4(gateway) & parsed.mask) >>> 0) !== parsed.network)) return res.status(400).json({ error: 'Gateway liegt nicht im Subnetz.' });
    const vlan = body.vlan_id === '' || body.vlan_id === undefined ? null : Number(body.vlan_id);
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094)) return res.status(400).json({ error: 'VLAN muss zwischen 1 und 4094 liegen.' });
    const existing = db.db.prepare('SELECT cidr FROM ipam_subnets WHERE environment_id = ?').all(environmentId);
    const invalidOverlap = existing.some(row => {
      const other = parseCidr(row.cidr);
      if (!other || !rangesOverlap(prefixRange(parsed), prefixRange(other))) return false;
      // NetBox-like automatic hierarchy: contained prefix is valid, only
      // partial overlaps and exact duplicates are rejected.
      return !(cidrContains(parsed, other) || cidrContains(other, parsed));
    });
    if (invalidOverlap) return res.status(409).json({ error: 'Dieses Prefix überschneidet sich nur teilweise mit einem bestehenden Prefix.' });
    if (existing.some(row => parseCidr(row.cidr)?.cidr === parsed.cidr)) return res.status(409).json({ error: 'Dieses Prefix existiert in dieser Umgebung bereits.' });
    const id = db.uuidv4();
    const status = validateChoice(body.status, SUBNET_STATUSES, 'active'); const role = String(body.role || '').trim().slice(0, 60);
    db.db.prepare('INSERT INTO ipam_subnets (id, environment_id, name, cidr, gateway, dns_servers, vlan_id, bridge, description, status, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, environmentId, name, parsed.cidr, gateway, JSON.stringify(parseDns(body.dns_servers)), vlan, String(body.bridge || '').trim().slice(0, 80), String(body.description || '').trim().slice(0, 500), status, role);
    db.auditLog.write('ipam.subnet_create', `subnet=${name} cidr=${parsed.cidr}`, req.ip, true, req.user?.username);
    res.status(201).json(db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(id));
  } catch (error) { res.status(400).json({ error: error.message || 'Subnetz konnte nicht erstellt werden.' }); }
});

router.get('/subnets/:id/reservations', guard('canViewServers'), (req, res) => {
  const rows = db.db.prepare(`SELECT reservation.*, server.name AS server_name FROM ipam_reservations reservation LEFT JOIN servers server ON server.id = reservation.server_id WHERE reservation.subnet_id = ?`).all(req.params.id);
  rows.sort((left, right) => (ipv4(left.address) ?? 0) - (ipv4(right.address) ?? 0));
  res.json(rows);
});

router.get('/subnets/:id/children', guard('canViewServers'), (req, res) => {
  const subnet = db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Netzwerk nicht gefunden.' });
  const parsed = parseCidr(subnet.cidr); const all = db.db.prepare('SELECT * FROM ipam_subnets WHERE environment_id = ?').all(subnet.environment_id);
  if (!parsed) return res.status(400).json({ error: 'Ungültiges Prefix.' });
  res.json(all.filter(candidate => enrichSubnet(candidate, all).parent_id === subnet.id).map(child => enrichSubnet(child, all)));
});

router.get('/subnets/:id/ranges', guard('canViewServers'), (req, res) => {
  const rows = getRanges(req.params.id).sort((left, right) => (ipv4(left.start_address) ?? 0) - (ipv4(right.start_address) ?? 0));
  res.json(rows);
});

router.post('/subnets/:id/reservations', guard('canEditServers'), (req, res) => {
  const subnet = db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(req.params.id);
  const address = String(req.body?.address || '').trim();
  const parsed = subnet && parseCidr(subnet.cidr);
  if (!subnet || !parsed) return res.status(404).json({ error: 'Subnetz nicht gefunden.' });
  const numeric = ipv4(address);
  if (numeric === null || !isUsableAddress(numeric, parsed)) return res.status(400).json({ error: 'Adresse ist keine verwendbare Host-Adresse dieses Netzwerks.' });
  const id = db.uuidv4();
  try {
    const rangeOverlap = getRanges(subnet.id).some(range => numeric >= ipv4(range.start_address) && numeric <= ipv4(range.end_address));
    if (rangeOverlap) return res.status(409).json({ error: 'Adresse ist bereits Teil eines reservierten IP-Bereichs.' });
    const status = validateChoice(req.body?.status, ADDRESS_STATUSES, 'active'); const role = validateChoice(req.body?.role, ADDRESS_ROLES, '');
    db.db.prepare('INSERT INTO ipam_reservations (id, subnet_id, address, hostname, server_id, mac_address, status, role, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, subnet.id, address, String(req.body?.hostname || '').trim().slice(0, 100), String(req.body?.server_id || '').trim() || null, String(req.body?.mac_address || '').trim().slice(0, 32), status, role, String(req.body?.description || '').trim().slice(0, 500));
    db.auditLog.write('ipam.reservation_create', `subnet=${subnet.cidr} address=${address}`, req.ip, true, req.user?.username);
    res.status(201).json(db.db.prepare('SELECT * FROM ipam_reservations WHERE id = ?').get(id));
  } catch (error) { res.status(409).json({ error: error.message || 'Adresse ist bereits reserviert.' }); }
});

router.post('/subnets/:id/reservations/range', guard('canEditServers'), (req, res) => {
  const subnet = db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(req.params.id);
  const parsed = subnet && parseCidr(subnet.cidr);
  const start = ipv4(req.body?.start_address); const end = ipv4(req.body?.end_address);
  if (!subnet || !parsed) return res.status(404).json({ error: 'Netzwerk nicht gefunden.' });
  if (start === null || end === null || start > end || !isUsableAddress(start, parsed) || !isUsableAddress(end, parsed)) return res.status(400).json({ error: 'Der Bereich muss aus verwendbaren Adressen dieses Netzwerks bestehen.' });
  const count = end - start + 1;
  try {
    const reservedAddress = db.db.prepare('SELECT address FROM ipam_reservations WHERE subnet_id = ?').all(subnet.id).map(row => ipv4(row.address));
    const overlap = reservedAddress.some(value => value !== null && value >= start && value <= end) || getRanges(subnet.id).some(range => {
      const rangeStart = ipv4(range.start_address); const rangeEnd = ipv4(range.end_address);
      return rangeStart !== null && rangeEnd !== null && rangesOverlap({ first: start, last: end }, { first: rangeStart, last: rangeEnd });
    });
    if (overlap) return res.status(409).json({ error: 'Mindestens eine Adresse des Bereichs ist bereits reserviert.' });
    const status = validateChoice(req.body?.status, ADDRESS_STATUSES, 'reserved'); const role = validateChoice(req.body?.role, ADDRESS_ROLES, '');
    db.db.prepare('INSERT INTO ipam_ip_ranges (id, subnet_id, start_address, end_address, status, role, description) VALUES (?, ?, ?, ?, ?, ?, ?)').run(db.uuidv4(), subnet.id, toIpv4(start), toIpv4(end), status, role, String(req.body?.description || '').trim().slice(0, 500));
    db.auditLog.write('ipam.reservation_range_create', `subnet=${subnet.cidr} start=${toIpv4(start)} end=${toIpv4(end)}`, req.ip, true, req.user?.username);
    res.status(201).json({ success: true, count });
  } catch (error) { res.status(409).json({ error: 'Mindestens eine Adresse des Bereichs ist bereits reserviert.' }); }
});

router.delete('/reservations/:id', guard('canEditServers'), (req, res) => {
  const result = db.db.prepare('DELETE FROM ipam_reservations WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Reservierung nicht gefunden.' });
  res.json({ success: true });
});

router.delete('/ranges/:id', guard('canEditServers'), (req, res) => {
  const result = db.db.prepare('DELETE FROM ipam_ip_ranges WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'IP-Bereich nicht gefunden.' });
  res.json({ success: true });
});

module.exports = router;
