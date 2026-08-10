const express = require('express');
const db = require('../db');
const { getPermissions, can } = require('../utils/permissions');

const router = express.Router();
const guard = (cap) => (req, res, next) => can(getPermissions(req.user), cap) ? next() : res.status(403).json({ error: 'Permission denied' });

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
  return { cidr: `${address}/${prefix}`, network: (ip & mask) >>> 0, mask };
}
function parseDns(value) {
  if (!Array.isArray(value)) return [];
  const servers = value.map(item => String(item || '').trim()).filter(Boolean);
  if (servers.some(server => ipv4(server) === null)) throw new Error('DNS-Server müssen IPv4-Adressen sein.');
  return [...new Set(servers)].slice(0, 6);
}

router.get('/subnets', guard('canViewServers'), (req, res) => {
  const environmentId = String(req.query.environment_id || 'default').trim() || 'default';
  const rows = db.db.prepare(`
    SELECT subnet.*, COUNT(reservation.id) AS reservation_count
    FROM ipam_subnets subnet
    LEFT JOIN ipam_reservations reservation ON reservation.subnet_id = subnet.id
    WHERE subnet.environment_id = ?
    GROUP BY subnet.id ORDER BY subnet.name COLLATE NOCASE
  `).all(environmentId).map(row => ({ ...row, dns_servers: JSON.parse(row.dns_servers || '[]') }));
  res.json(rows);
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
    const id = db.uuidv4();
    db.db.prepare('INSERT INTO ipam_subnets (id, environment_id, name, cidr, gateway, dns_servers, vlan_id, bridge, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, environmentId, name, parsed.cidr, gateway, JSON.stringify(parseDns(body.dns_servers)), vlan, String(body.bridge || '').trim().slice(0, 80), String(body.description || '').trim().slice(0, 500));
    db.auditLog.write('ipam.subnet_create', `subnet=${name} cidr=${parsed.cidr}`, req.ip, true, req.user?.username);
    res.status(201).json(db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(id));
  } catch (error) { res.status(400).json({ error: error.message || 'Subnetz konnte nicht erstellt werden.' }); }
});

router.get('/subnets/:id/reservations', guard('canViewServers'), (req, res) => {
  res.json(db.db.prepare(`SELECT reservation.*, server.name AS server_name FROM ipam_reservations reservation LEFT JOIN servers server ON server.id = reservation.server_id WHERE reservation.subnet_id = ? ORDER BY reservation.address`).all(req.params.id));
});

router.post('/subnets/:id/reservations', guard('canEditServers'), (req, res) => {
  const subnet = db.db.prepare('SELECT * FROM ipam_subnets WHERE id = ?').get(req.params.id);
  const address = String(req.body?.address || '').trim();
  const parsed = subnet && parseCidr(subnet.cidr);
  if (!subnet || !parsed) return res.status(404).json({ error: 'Subnetz nicht gefunden.' });
  const numeric = ipv4(address);
  if (numeric === null || ((numeric & parsed.mask) >>> 0) !== parsed.network) return res.status(400).json({ error: 'Adresse liegt nicht im Subnetz.' });
  const id = db.uuidv4();
  try {
    db.db.prepare('INSERT INTO ipam_reservations (id, subnet_id, address, hostname, server_id, mac_address, description) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, subnet.id, address, String(req.body?.hostname || '').trim().slice(0, 100), String(req.body?.server_id || '').trim() || null, String(req.body?.mac_address || '').trim().slice(0, 32), String(req.body?.description || '').trim().slice(0, 500));
    db.auditLog.write('ipam.reservation_create', `subnet=${subnet.cidr} address=${address}`, req.ip, true, req.user?.username);
    res.status(201).json(db.db.prepare('SELECT * FROM ipam_reservations WHERE id = ?').get(id));
  } catch (error) { res.status(409).json({ error: error.message || 'Adresse ist bereits reserviert.' }); }
});

router.delete('/reservations/:id', guard('canEditServers'), (req, res) => {
  const result = db.db.prepare('DELETE FROM ipam_reservations WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Reservierung nicht gefunden.' });
  res.json({ success: true });
});

module.exports = router;
