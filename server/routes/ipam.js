const express = require("express");
const http = require("http");
const https = require("https");
const db = require("../db");
const {
  getPermissions,
  can,
  canAccessEnvironment,
} = require("../utils/permissions");
const { encrypt, decrypt } = require("../utils/crypto");

const router = express.Router();
const guard = (cap) => (req, res, next) =>
  can(getPermissions(req.user), cap)
    ? next()
    : res.status(403).json({ error: "Permission denied" });
const guardEnvironment = (req, res, environmentId) => {
  if (canAccessEnvironment(getPermissions(req.user), environmentId))
    return true;
  res.status(403).json({ error: "Keine Berechtigung für diese Umgebung." });
  return false;
};
const SUBNET_STATUSES = new Set([
  "active",
  "container",
  "reserved",
  "deprecated",
]);
const ADDRESS_STATUSES = new Set(["active", "reserved", "dhcp", "deprecated"]);
const ADDRESS_ROLES = new Set(["", "gateway", "loopback", "vip", "secondary"]);
const SOURCE_TYPES = new Set(["unifi", "pfsense"]);
const syncingSources = new Set();

function validEndpoint(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
function publicSource(row) {
  return {
    ...row,
    api_token: undefined,
    api_token_configured: Boolean(String(row.api_token || "").trim()),
    insecure: Boolean(row.insecure),
    enabled: Boolean(row.enabled),
    auto_sync: row.auto_sync === undefined ? true : Boolean(row.auto_sync),
    sync_interval_min: syncIntervalMinutes(row.sync_interval_min),
  };
}
// A source is an operational inventory, not merely a saved URL. Expose a
// small, credential-free health summary so the console can answer the three
// questions an operator actually has: did it run, how much did it contribute,
// and does it currently disagree with Fleet's source of truth?
function sourceSummary(row) {
  const source = publicSource(row);
  const inventory = db.db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ipam_reservations
    WHERE source_ref LIKE ?
  `,
    )
    .get(`${row.id}:%`);
  const conflicts = db.db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ipam_sync_conflicts
    WHERE source_id = ?
  `,
    )
    .get(row.id);
  return {
    ...source,
    inventory_count: Number(inventory?.count || 0),
    conflict_count: Number(conflicts?.count || 0),
  };
}

function syncIntervalMinutes(value, fallback = 15) {
  const interval = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(interval)
    ? Math.min(1440, Math.max(5, interval))
    : fallback;
}
function sourceRequest(endpoint, path, token, insecure) {
  const base = validEndpoint(endpoint);
  if (!base) return Promise.reject(new Error("Ungültige Quellen-URL."));
  const url = new URL(path || "/", base);
  if (url.origin !== base.origin)
    return Promise.reject(
      new Error("Der API-Pfad darf die konfigurierte Quelle nicht verlassen."),
    );
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token
            ? { Authorization: `Bearer ${token}`, "X-API-KEY": token }
            : {}),
        },
        ...(url.protocol === "https:" && insecure
          ? { rejectUnauthorized: false }
          : {}),
        timeout: 15000,
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
          if (data.length > 2_000_000)
            req.destroy(new Error("Antwort der Quelle ist zu groß."));
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(
              new Error(`Quelle antwortet mit HTTP ${response.statusCode}.`),
            );
          try {
            resolve(JSON.parse(data || "[]"));
          } catch {
            reject(
              new Error("Quelle hat keine gültige JSON-Antwort geliefert."),
            );
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Zeitüberschreitung beim Abruf der Quelle.")),
    );
    req.on("error", reject);
    req.end();
  });
}
function sourceList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  throw new Error(
    "Quelle hat kein unterstütztes Listenformat geliefert. Erwartet wird ein Array oder data/items/results.",
  );
}
function sourceRecords(type, payload) {
  const sourceItems = sourceList(payload);
  const records = sourceItems
    .map((item, index) => {
      // UniFi's client endpoint returns an active DHCP address as `last_ip`
      // (rather than `ip`) for many wired clients.  Keep that field alongside
      // the generic controller variants so a valid lease is never silently
      // omitted from the IPAM inventory.
      const address = String(
        item.ip ||
          item.ip_address ||
          item.address ||
          item.ipaddr ||
          item.last_ip ||
          item["ip-address"] ||
          "",
      )
        .trim()
        .split("/")[0];
      const mac = String(
        item.mac ||
          item.mac_address ||
          item.macaddr ||
          item["mac-address"] ||
          "",
      ).trim();
      const hostname = String(
        item.hostname || item.name || item.host || item.client_hostname || "",
      ).trim();
      const ref = String(
        item._id ||
          item.id ||
          item.uuid ||
          item.mac ||
          `${type}-${index}-${address}`,
      ).trim();
      return { address, mac, hostname, ref };
    })
    .filter((record) => ipv4(record.address) !== null);
  // An empty array is a valid observation: there may currently be no DHCP
  // leases. A non-empty response without even one usable IPv4 address is not.
  // Treating it as empty would delete the source's prior inventory on sync.
  if (sourceItems.length > 0 && records.length === 0) {
    throw new Error(
      "Quelle lieferte Einträge, aber keine auslesbaren IPv4-Adressen. Bestehende Lease-Daten wurden nicht verändert.",
    );
  }
  return records;
}
function findSubnetForAddress(environmentId, address) {
  const ip = ipv4(address);
  if (ip === null) return null;
  return (
    db.db
      .prepare("SELECT * FROM ipam_subnets WHERE environment_id = ?")
      .all(environmentId)
      .map((subnet) => ({ subnet, parsed: parseCidr(subnet.cidr) }))
      .filter(
        (item) =>
          item.parsed && (ip & item.parsed.mask) >>> 0 === item.parsed.network,
      )
      .sort((left, right) => right.parsed.prefix - left.parsed.prefix)[0]
      ?.subnet || null
  );
}

function ipv4(value) {
  const chunks = String(value || "")
    .trim()
    .split(".");
  if (
    chunks.length !== 4 ||
    chunks.some((chunk) => !/^\d{1,3}$/.test(chunk) || Number(chunk) > 255)
  )
    return null;
  return chunks.reduce((total, chunk) => total * 256 + Number(chunk), 0) >>> 0;
}
function parseCidr(value) {
  const [address, prefixText, extra] = String(value || "")
    .trim()
    .split("/");
  const prefix = Number(prefixText);
  const ip = ipv4(address);
  if (
    extra ||
    ip === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  )
    return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // Persist and compare every prefix in canonical network notation. Without
  // this, values such as 10.44.0.64/25 describe the same network as
  // 10.44.0.0/25 but could bypass duplicate-prefix checks.
  const network = (ip & mask) >>> 0;
  return { cidr: `${toIpv4(network)}/${prefix}`, prefix, network, mask };
}
function usableAddressCount(parsed) {
  const count = 2 ** (32 - parsed.prefix);
  return parsed.prefix <= 30 ? Math.max(0, count - 2) : count;
}
function toIpv4(number) {
  return [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join(".");
}
function isUsableAddress(number, parsed) {
  if ((number & parsed.mask) >>> 0 !== parsed.network) return false;
  if (parsed.prefix > 30) return true;
  const broadcast = (parsed.network | (~parsed.mask >>> 0)) >>> 0;
  return number !== parsed.network && number !== broadcast;
}
function usableRange(parsed) {
  const size = 2 ** (32 - parsed.prefix);
  const first = parsed.prefix <= 30 ? parsed.network + 1 : parsed.network;
  const last =
    parsed.prefix <= 30 ? parsed.network + size - 2 : parsed.network + size - 1;
  return { first: first >>> 0, last: last >>> 0 };
}
function prefixRange(parsed) {
  const size = 2 ** (32 - parsed.prefix);
  return { first: parsed.network, last: (parsed.network + size - 1) >>> 0 };
}
function cidrContains(container, child) {
  const containerRange = prefixRange(container);
  const childRange = prefixRange(child);
  return (
    containerRange.first <= childRange.first &&
    containerRange.last >= childRange.last
  );
}
function rangesOverlap(left, right) {
  return left.first <= right.last && right.first <= left.last;
}
function validateChoice(value, choices, fallback = "") {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase();
  if (!choices.has(normalized))
    throw new Error("Ungültiger Status oder Rolle.");
  return normalized;
}
function getRanges(subnetId) {
  return db.db
    .prepare("SELECT * FROM ipam_ip_ranges WHERE subnet_id = ?")
    .all(subnetId);
}
function getUsage(subnet, directChildren = []) {
  const parsed = parseCidr(subnet.cidr);
  if (!parsed)
    return { usable: 0, used: 0, free: 0, reservationCount: 0, rangeCount: 0 };
  const reservations = db.db
    .prepare("SELECT address FROM ipam_reservations WHERE subnet_id = ?")
    .all(subnet.id);
  const ranges = getRanges(subnet.id);
  const rangeUsage = ranges.reduce((total, row) => {
    const start = ipv4(row.start_address);
    const end = ipv4(row.end_address);
    return start === null || end === null ? total : total + end - start + 1;
  }, 0);
  const usable = usableAddressCount(parsed);
  // A direct child prefix consumes its entire address block in the parent.
  // Counting only direct children avoids counting nested prefixes twice.
  const childUsage = directChildren.reduce((total, child) => {
    const childParsed = parseCidr(child.cidr);
    return total + (childParsed ? 2 ** (32 - childParsed.prefix) : 0);
  }, 0);
  const used = Math.min(usable, reservations.length + rangeUsage + childUsage);
  return {
    usable,
    used,
    free: Math.max(0, usable - used),
    reservationCount: reservations.length,
    rangeCount: ranges.length,
    childUsage,
  };
}
function enrichSubnet(subnet, allSubnets) {
  const parsed = parseCidr(subnet.cidr);
  const parents = (allSubnets || [])
    .filter((candidate) => candidate.id !== subnet.id)
    .map((candidate) => ({ candidate, parsed: parseCidr(candidate.cidr) }))
    .filter(
      (item) =>
        item.parsed &&
        parsed &&
        item.parsed.prefix < parsed.prefix &&
        cidrContains(item.parsed, parsed),
    )
    .sort((left, right) => right.parsed.prefix - left.parsed.prefix);
  const parentId = parents[0]?.candidate.id || null;
  const directChildren = (allSubnets || []).filter((candidate) => {
    if (candidate.id === subnet.id) return false;
    const child = parseCidr(candidate.cidr);
    if (
      !child ||
      !parsed ||
      child.prefix <= parsed.prefix ||
      !cidrContains(parsed, child)
    )
      return false;
    const ancestor = (allSubnets || [])
      .filter((other) => other.id !== candidate.id)
      .map((other) => ({ other, parsed: parseCidr(other.cidr) }))
      .filter(
        (item) =>
          item.parsed &&
          item.parsed.prefix < child.prefix &&
          cidrContains(item.parsed, child),
      )
      .sort((left, right) => right.parsed.prefix - left.parsed.prefix)[0];
    return ancestor?.other.id === subnet.id;
  });
  const usage = getUsage(subnet, directChildren);
  let dnsServers = [];
  try {
    dnsServers = JSON.parse(subnet.dns_servers || "[]");
  } catch {
    dnsServers = [];
  }
  return {
    ...subnet,
    dns_servers: Array.isArray(dnsServers) ? dnsServers : [],
    parent_id: parentId,
    parent_cidr: parents[0]?.candidate.cidr || null,
    child_prefix_count: directChildren.length,
    child_prefix_address_count: usage.childUsage,
    usable_address_count: usage.usable,
    used_address_count: usage.used,
    free_address_count: usage.free,
    reservation_count: usage.reservationCount,
    range_count: usage.rangeCount,
    next_free_address: parsed ? nextFreeAddress(subnet, parsed) : null,
  };
}
function nextFreeAddress(subnet, parsed) {
  const taken = new Set(
    db.db
      .prepare("SELECT address FROM ipam_reservations WHERE subnet_id = ?")
      .all(subnet.id)
      .map((row) => ipv4(row.address))
      .filter((value) => value !== null),
  );
  const occupiedRanges = getRanges(subnet.id)
    .map((row) => ({
      start: ipv4(row.start_address),
      end: ipv4(row.end_address),
    }))
    .filter((range) => range.start !== null && range.end !== null);
  const { first, last } = usableRange(parsed);
  // Do not turn a malformed /0 into a long-running request. Normal IPAM
  // prefixes find their next gap almost immediately; very large networks are
  // still represented by their exact free count.
  const ceiling = Math.min(last, first + 1000000);
  for (let current = first; current <= ceiling; current += 1)
    if (
      !taken.has(current) &&
      !occupiedRanges.some(
        (range) => current >= range.start && current <= range.end,
      )
    )
      return toIpv4(current);
  return null;
}
function parseDns(value) {
  if (!Array.isArray(value)) return [];
  const servers = value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (servers.some((server) => ipv4(server) === null))
    throw new Error("DNS-Server müssen IPv4-Adressen sein.");
  return [...new Set(servers)].slice(0, 6);
}
function normalizedHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}
function normalizedMac(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "");
}

// A reservation may be valid inside its own prefix while still conflict with
// a child/parent prefix or a second inventory source.  Keep the data instead
// of silently overwriting it and expose the conflict at the allocation where
// an administrator can resolve it.
function withReservationConflicts(rows, environmentId) {
  const all = db.db
    .prepare(
      `
    SELECT reservation.id, reservation.address, reservation.hostname, reservation.mac_address, subnet.cidr AS subnet_cidr
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    WHERE subnet.environment_id = ?
  `,
    )
    .all(environmentId);
  const byAddress = new Map();
  const byHostname = new Map();
  const byMac = new Map();
  const externalConflicts = db.db
    .prepare(
      `
    SELECT conflict.address, conflict.reason, source.name AS source_name, 'external' AS source_kind
    FROM ipam_sync_conflicts conflict
    LEFT JOIN ipam_sync_sources source ON source.id = conflict.source_id
    WHERE conflict.environment_id = ?
    UNION ALL
    SELECT conflict.address, conflict.reason, '' AS source_name, 'proxmox' AS source_kind
    FROM ipam_proxmox_sync_conflicts conflict
    WHERE conflict.environment_id = ?
  `,
    )
    .all(environmentId, environmentId);
  const externalByAddress = new Map();
  for (const conflict of externalConflicts) {
    const key = String(conflict.address || "").trim();
    const bucket = externalByAddress.get(key) || [];
    bucket.push(conflict);
    externalByAddress.set(key, bucket);
  }
  for (const row of all) {
    const add = (map, key) => {
      if (!key) return;
      const bucket = map.get(key) || [];
      bucket.push(row);
      map.set(key, bucket);
    };
    add(byAddress, String(row.address || "").trim());
    add(byHostname, normalizedHostname(row.hostname));
    add(byMac, normalizedMac(row.mac_address));
  }
  return rows.map((row) => {
    const conflicts = [];
    if (
      (byAddress.get(String(row.address || "").trim()) || []).some(
        (other) => other.id !== row.id,
      )
    )
      conflicts.push("IP-Adresse mehrfach in der Umgebung erfasst");
    const hostname = normalizedHostname(row.hostname);
    if (
      hostname &&
      (byHostname.get(hostname) || []).some((other) => other.id !== row.id)
    )
      conflicts.push("Hostname mehrfach vergeben");
    const mac = normalizedMac(row.mac_address);
    if (mac && (byMac.get(mac) || []).some((other) => other.id !== row.id))
      conflicts.push("MAC-Adresse mehrfach vergeben");
    for (const external of externalByAddress.get(
      String(row.address || "").trim(),
    ) || []) {
      const origin =
        external.source_kind === "proxmox"
          ? `Proxmox ${external.source_name || "Verbindung"}`
          : external.source_name || "externer Quelle";
      conflicts.push(`Konflikt mit ${origin}: ${external.reason}`);
    }
    return { ...row, conflicts, conflict: conflicts.length > 0 };
  });
}

router.get("/subnets", guard("canViewServers"), (req, res) => {
  const environmentId =
    String(req.query.environment_id || "default").trim() || "default";
  if (!guardEnvironment(req, res, environmentId)) return;
  const rows = db.db
    .prepare(
      "SELECT * FROM ipam_subnets WHERE environment_id = ? ORDER BY cidr",
    )
    .all(environmentId);
  res.json(rows.map((row) => enrichSubnet(row, rows)));
});

router.get("/subnets/:id", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const allSubnets = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE environment_id = ?")
    .all(subnet.environment_id);
  res.json(enrichSubnet(subnet, allSubnets));
});

router.post("/subnets", guard("canEditServers"), (req, res) => {
  try {
    const body = req.body || {};
    const environmentId =
      String(body.environment_id || "default").trim() || "default";
    if (!guardEnvironment(req, res, environmentId)) return;
    const name = String(body.name || "")
      .trim()
      .slice(0, 80);
    const parsed = parseCidr(body.cidr);
    const gateway = String(body.gateway || "").trim();
    if (!name || !parsed)
      return res
        .status(400)
        .json({ error: "Name und gültiges IPv4-CIDR sind erforderlich." });
    if (
      !db.db
        .prepare("SELECT 1 FROM environments WHERE id = ?")
        .get(environmentId)
    )
      return res.status(400).json({ error: "Umgebung nicht gefunden." });
    if (
      gateway &&
      (ipv4(gateway) === null ||
        (ipv4(gateway) & parsed.mask) >>> 0 !== parsed.network)
    )
      return res.status(400).json({ error: "Gateway liegt nicht im Subnetz." });
    const vlan =
      body.vlan_id === "" || body.vlan_id === undefined
        ? null
        : Number(body.vlan_id);
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094))
      return res
        .status(400)
        .json({ error: "VLAN muss zwischen 1 und 4094 liegen." });
    const existing = db.db
      .prepare("SELECT cidr FROM ipam_subnets WHERE environment_id = ?")
      .all(environmentId);
    const invalidOverlap = existing.some((row) => {
      const other = parseCidr(row.cidr);
      if (!other || !rangesOverlap(prefixRange(parsed), prefixRange(other)))
        return false;
      // NetBox-like automatic hierarchy: contained prefix is valid, only
      // partial overlaps and exact duplicates are rejected.
      return !(cidrContains(parsed, other) || cidrContains(other, parsed));
    });
    if (invalidOverlap)
      return res
        .status(409)
        .json({
          error:
            "Dieses Prefix überschneidet sich nur teilweise mit einem bestehenden Prefix.",
        });
    if (existing.some((row) => parseCidr(row.cidr)?.cidr === parsed.cidr))
      return res
        .status(409)
        .json({ error: "Dieses Prefix existiert in dieser Umgebung bereits." });
    const id = db.uuidv4();
    const status = validateChoice(body.status, SUBNET_STATUSES, "active");
    const role = String(body.role || "")
      .trim()
      .slice(0, 60);
    db.db
      .prepare(
        "INSERT INTO ipam_subnets (id, environment_id, name, cidr, gateway, dns_servers, vlan_id, bridge, description, status, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        environmentId,
        name,
        parsed.cidr,
        gateway,
        JSON.stringify(parseDns(body.dns_servers)),
        vlan,
        String(body.bridge || "")
          .trim()
          .slice(0, 80),
        String(body.description || "")
          .trim()
          .slice(0, 500),
        status,
        role,
      );
    db.auditLog.write(
      "ipam.subnet_create",
      `subnet=${name} cidr=${parsed.cidr}`,
      req.ip,
      true,
      req.user?.username,
    );
    res
      .status(201)
      .json(db.db.prepare("SELECT * FROM ipam_subnets WHERE id = ?").get(id));
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "Subnetz konnte nicht erstellt werden.",
      });
  }
});

// Keep bulk changes deliberately narrow: changing a prefix lifecycle state is
// reversible and does not alter its CIDR, reservations, or child prefixes.
router.patch("/subnets/:id/status", guard("canEditServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  try {
    const status = validateChoice(req.body?.status, SUBNET_STATUSES);
    db.db
      .prepare("UPDATE ipam_subnets SET status = ? WHERE id = ?")
      .run(status, subnet.id);
    db.auditLog.write(
      "ipam.subnet_status_update",
      `subnet=${subnet.cidr} status=${status}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json(
      db.db.prepare("SELECT * FROM ipam_subnets WHERE id = ?").get(subnet.id),
    );
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "Prefix-Status konnte nicht geändert werden.",
      });
  }
});

router.get("/subnets/:id/reservations", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const rows = db.db
    .prepare(
      `
    SELECT reservation.*, server.name AS server_name, source.name AS source_name
    FROM ipam_reservations reservation
    LEFT JOIN servers server ON server.id = reservation.server_id
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    WHERE reservation.subnet_id = ?
  `,
    )
    .all(req.params.id);
  rows.sort(
    (left, right) => (ipv4(left.address) ?? 0) - (ipv4(right.address) ?? 0),
  );
  res.json(withReservationConflicts(rows, subnet.environment_id));
});

// Conflicts are intentionally exposed separately from the normal allocation
// list.  An address remains usable and visible in its current source of truth;
// this endpoint supplies the operator with the competing observation and its
// origin, rather than encouraging an unsafe overwrite during a sync.
router.get("/subnets/:id/conflicts", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT id, environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const externalRows = db.db
    .prepare(
      `
    SELECT
      conflict.id, conflict.address, conflict.hostname, conflict.mac_address,
      conflict.reason, conflict.last_seen_at, 'external' AS source_kind,
      source.type AS source_type, COALESCE(source.name, 'Externe Quelle') AS source_name,
      reservation.id AS existing_reservation_id, reservation.address AS existing_address,
      reservation.hostname AS existing_hostname, reservation.source_type AS existing_source_type,
      server.id AS existing_server_id, server.name AS existing_server_name
    FROM ipam_sync_conflicts conflict
    LEFT JOIN ipam_sync_sources source ON source.id = conflict.source_id
    LEFT JOIN ipam_reservations reservation ON reservation.id = conflict.existing_reservation_id
    LEFT JOIN servers server ON server.id = reservation.server_id
    WHERE conflict.subnet_id = ?
  `,
    )
    .all(subnet.id);
  // OpenTofu owns its connection table and can be disabled entirely. IPAM
  // remains available in installations without that plugin, so only query its
  // conflict inventory when the plugin schema has actually been installed.
  const hasProxmoxConnections = Boolean(
    db.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tofu_proxmox_connections'",
      )
      .get(),
  );
  const proxmoxRows = hasProxmoxConnections
    ? db.db
        .prepare(
          `
    SELECT
      conflict.id, conflict.address, conflict.hostname, '' AS mac_address,
      conflict.reason, conflict.last_seen_at, 'proxmox' AS source_kind,
      'proxmox' AS source_type, COALESCE(connection.name, 'Proxmox') AS source_name,
      reservation.id AS existing_reservation_id, reservation.address AS existing_address,
      reservation.hostname AS existing_hostname, reservation.source_type AS existing_source_type,
      server.id AS existing_server_id, server.name AS existing_server_name
    FROM ipam_proxmox_sync_conflicts conflict
    LEFT JOIN tofu_proxmox_connections connection ON connection.id = conflict.connection_id
    LEFT JOIN ipam_reservations reservation ON reservation.id = conflict.existing_reservation_id
    LEFT JOIN servers server ON server.id = reservation.server_id
    WHERE conflict.subnet_id = ?
  `,
        )
        .all(subnet.id)
    : [];
  const rows = [...externalRows, ...proxmoxRows];
  rows.sort(
    (left, right) => (ipv4(left.address) ?? 0) - (ipv4(right.address) ?? 0),
  );
  res.json(rows);
});

// The server detail is an operational view, while IPAM remains the source of
// truth for address ownership. This narrow lookup lets the console show a
// host's allocations without making the client scan every prefix.
router.get("/reservations", guard("canViewServers"), (req, res) => {
  const serverId = String(req.query?.server_id || "").trim();
  if (!serverId)
    return res.status(400).json({ error: "server_id is required" });
  const server = db.db
    .prepare("SELECT environment_id FROM servers WHERE id = ?")
    .get(serverId);
  if (!server)
    return res.status(404).json({ error: "Fleet-Host nicht gefunden." });
  if (!guardEnvironment(req, res, server.environment_id)) return;
  const rows = db.db
    .prepare(
      `
    SELECT reservation.*, subnet.cidr AS subnet_cidr, subnet.name AS subnet_name, source.name AS source_name
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    WHERE reservation.server_id = ?
    ORDER BY subnet.cidr, reservation.address
  `,
    )
    .all(serverId);
  res.json(rows);
});

// A prefix is operated as one address space. Return single IP reservations and
// larger reservations together so clients do not have to switch between two
// unrelated lists just to understand what is already allocated.
router.get("/subnets/:id/allocations", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT id, environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const addresses = withReservationConflicts(
    db.db
      .prepare(
        `
    SELECT reservation.*, server.name AS server_name, source.name AS source_name
    FROM ipam_reservations reservation
    LEFT JOIN servers server ON server.id = reservation.server_id
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    WHERE reservation.subnet_id = ?
  `,
      )
      .all(subnet.id),
    subnet.environment_id,
  ).map((row) => ({
    ...row,
    kind: "address",
    start_address: row.address,
    end_address: row.address,
    address_count: 1,
  }));
  const ranges = getRanges(subnet.id).map((row) => {
    const start = ipv4(row.start_address);
    const end = ipv4(row.end_address);
    return {
      ...row,
      kind: "range",
      address_count: start === null || end === null ? 0 : end - start + 1,
    };
  });
  const rows = [...addresses, ...ranges];
  rows.sort(
    (left, right) =>
      (ipv4(left.start_address) ?? 0) - (ipv4(right.start_address) ?? 0),
  );
  res.json(rows);
});

router.get("/subnets/:id/children", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const parsed = parseCidr(subnet.cidr);
  const all = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE environment_id = ?")
    .all(subnet.environment_id);
  if (!parsed) return res.status(400).json({ error: "Ungültiges Prefix." });
  res.json(
    all
      .filter(
        (candidate) => enrichSubnet(candidate, all).parent_id === subnet.id,
      )
      .map((child) => enrichSubnet(child, all)),
  );
});

router.get("/subnets/:id/ranges", guard("canViewServers"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const rows = getRanges(req.params.id).sort(
    (left, right) =>
      (ipv4(left.start_address) ?? 0) - (ipv4(right.start_address) ?? 0),
  );
  res.json(rows);
});

router.post(
  "/subnets/:id/reservations",
  guard("canEditServers"),
  (req, res) => {
    const subnet = db.db
      .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
      .get(req.params.id);
    const address = String(req.body?.address || "").trim();
    const parsed = subnet && parseCidr(subnet.cidr);
    if (!subnet || !parsed)
      return res.status(404).json({ error: "Subnetz nicht gefunden." });
    if (!guardEnvironment(req, res, subnet.environment_id)) return;
    const numeric = ipv4(address);
    if (numeric === null || !isUsableAddress(numeric, parsed))
      return res
        .status(400)
        .json({
          error: "Adresse ist keine verwendbare Host-Adresse dieses Netzwerks.",
        });
    const id = db.uuidv4();
    try {
      const rangeOverlap = getRanges(subnet.id).some(
        (range) =>
          numeric >= ipv4(range.start_address) &&
          numeric <= ipv4(range.end_address),
      );
      if (rangeOverlap)
        return res
          .status(409)
          .json({
            error: "Adresse ist bereits Teil eines reservierten IP-Bereichs.",
          });
      const status = validateChoice(
        req.body?.status,
        ADDRESS_STATUSES,
        "active",
      );
      const role = validateChoice(req.body?.role, ADDRESS_ROLES, "");
      db.db
        .prepare(
          "INSERT INTO ipam_reservations (id, subnet_id, address, hostname, server_id, mac_address, status, role, description, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          subnet.id,
          address,
          String(req.body?.hostname || "")
            .trim()
            .slice(0, 100),
          String(req.body?.server_id || "").trim() || null,
          String(req.body?.mac_address || "")
            .trim()
            .slice(0, 32),
          status,
          role,
          String(req.body?.description || "")
            .trim()
            .slice(0, 500),
          "manual",
        );
      db.auditLog.write(
        "ipam.reservation_create",
        `subnet=${subnet.cidr} address=${address}`,
        req.ip,
        true,
        req.user?.username,
      );
      res
        .status(201)
        .json(
          db.db.prepare("SELECT * FROM ipam_reservations WHERE id = ?").get(id),
        );
    } catch (error) {
      res
        .status(409)
        .json({ error: error.message || "Adresse ist bereits reserviert." });
    }
  },
);

router.put("/reservations/:id", guard("canEditServers"), (req, res) => {
  const reservation = db.db
    .prepare("SELECT * FROM ipam_reservations WHERE id = ?")
    .get(req.params.id);
  if (!reservation)
    return res.status(404).json({ error: "IP-Adresse nicht gefunden." });
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(reservation.subnet_id);
  const parsed = subnet && parseCidr(subnet.cidr);
  if (!subnet || !parsed)
    return res.status(404).json({ error: "Prefix nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  try {
    const address = String(req.body?.address || reservation.address).trim();
    const numeric = ipv4(address);
    if (numeric === null || !isUsableAddress(numeric, parsed))
      return res
        .status(400)
        .json({
          error: "Adresse ist keine verwendbare Host-Adresse dieses Prefixes.",
        });
    if (
      getRanges(subnet.id).some(
        (range) =>
          numeric >= ipv4(range.start_address) &&
          numeric <= ipv4(range.end_address),
      )
    )
      return res
        .status(409)
        .json({ error: "Adresse ist Teil eines reservierten IP-Bereichs." });
    const status = validateChoice(
      req.body?.status,
      ADDRESS_STATUSES,
      reservation.status || "active",
    );
    const role = validateChoice(
      req.body?.role,
      ADDRESS_ROLES,
      reservation.role || "",
    );
    const serverId = String(req.body?.server_id || "").trim() || null;
    if (
      serverId &&
      !db.db.prepare("SELECT 1 FROM servers WHERE id = ?").get(serverId)
    )
      return res
        .status(400)
        .json({ error: "Zugewiesener Fleet-Host wurde nicht gefunden." });
    db.db
      .prepare(
        "UPDATE ipam_reservations SET address = ?, hostname = ?, server_id = ?, mac_address = ?, status = ?, role = ?, description = ? WHERE id = ?",
      )
      .run(
        address,
        String(req.body?.hostname || "")
          .trim()
          .slice(0, 100),
        serverId,
        String(req.body?.mac_address || "")
          .trim()
          .slice(0, 32),
        status,
        role,
        String(req.body?.description || "")
          .trim()
          .slice(0, 500),
        reservation.id,
      );
    db.auditLog.write(
      "ipam.reservation_update",
      `subnet=${subnet.cidr} address=${address}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json(
      db.db
        .prepare("SELECT * FROM ipam_reservations WHERE id = ?")
        .get(reservation.id),
    );
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "IP-Adresse konnte nicht gespeichert werden.",
      });
  }
});

router.post(
  "/subnets/:id/reservations/range",
  guard("canEditServers"),
  (req, res) => {
    const subnet = db.db
      .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
      .get(req.params.id);
    const parsed = subnet && parseCidr(subnet.cidr);
    const start = ipv4(req.body?.start_address);
    const end = ipv4(req.body?.end_address);
    if (!subnet || !parsed)
      return res.status(404).json({ error: "Netzwerk nicht gefunden." });
    if (!guardEnvironment(req, res, subnet.environment_id)) return;
    if (
      start === null ||
      end === null ||
      start > end ||
      !isUsableAddress(start, parsed) ||
      !isUsableAddress(end, parsed)
    )
      return res
        .status(400)
        .json({
          error:
            "Der Bereich muss aus verwendbaren Adressen dieses Netzwerks bestehen.",
        });
    const count = end - start + 1;
    try {
      const reservedAddress = db.db
        .prepare("SELECT address FROM ipam_reservations WHERE subnet_id = ?")
        .all(subnet.id)
        .map((row) => ipv4(row.address));
      const overlap =
        reservedAddress.some(
          (value) => value !== null && value >= start && value <= end,
        ) ||
        getRanges(subnet.id).some((range) => {
          const rangeStart = ipv4(range.start_address);
          const rangeEnd = ipv4(range.end_address);
          return (
            rangeStart !== null &&
            rangeEnd !== null &&
            rangesOverlap(
              { first: start, last: end },
              { first: rangeStart, last: rangeEnd },
            )
          );
        });
      if (overlap)
        return res
          .status(409)
          .json({
            error:
              "Mindestens eine Adresse des Bereichs ist bereits reserviert.",
          });
      const status = validateChoice(
        req.body?.status,
        ADDRESS_STATUSES,
        "reserved",
      );
      const role = validateChoice(req.body?.role, ADDRESS_ROLES, "");
      db.db
        .prepare(
          "INSERT INTO ipam_ip_ranges (id, subnet_id, start_address, end_address, status, role, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          db.uuidv4(),
          subnet.id,
          toIpv4(start),
          toIpv4(end),
          status,
          role,
          String(req.body?.description || "")
            .trim()
            .slice(0, 500),
        );
      db.auditLog.write(
        "ipam.reservation_range_create",
        `subnet=${subnet.cidr} start=${toIpv4(start)} end=${toIpv4(end)}`,
        req.ip,
        true,
        req.user?.username,
      );
      res.status(201).json({ success: true, count });
    } catch (error) {
      res
        .status(409)
        .json({
          error: "Mindestens eine Adresse des Bereichs ist bereits reserviert.",
        });
    }
  },
);

router.delete("/reservations/:id", guard("canEditServers"), (req, res) => {
  const reservation = db.db
    .prepare(
      `SELECT reservation.id, reservation.address, reservation.hostname, reservation.source_type, subnet.environment_id, subnet.cidr FROM ipam_reservations reservation JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id WHERE reservation.id = ?`,
    )
    .get(req.params.id);
  if (!reservation)
    return res.status(404).json({ error: "Reservierung nicht gefunden." });
  if (!guardEnvironment(req, res, reservation.environment_id)) return;
  const result = db.db
    .prepare("DELETE FROM ipam_reservations WHERE id = ?")
    .run(req.params.id);
  if (!result.changes)
    return res.status(404).json({ error: "Reservierung nicht gefunden." });
  db.auditLog.write(
    "ipam.reservation_delete",
    `subnet=${reservation.cidr} address=${reservation.address} source=${reservation.source_type || "manual"} hostname=${reservation.hostname || "-"}`,
    req.ip,
    true,
    req.user?.username,
  );
  res.json({ success: true });
});

router.delete("/ranges/:id", guard("canEditServers"), (req, res) => {
  const range = db.db
    .prepare(
      `SELECT range.id, range.start_address, range.end_address, range.description, subnet.environment_id, subnet.cidr FROM ipam_ip_ranges range JOIN ipam_subnets subnet ON subnet.id = range.subnet_id WHERE range.id = ?`,
    )
    .get(req.params.id);
  if (!range)
    return res.status(404).json({ error: "IP-Bereich nicht gefunden." });
  if (!guardEnvironment(req, res, range.environment_id)) return;
  const result = db.db
    .prepare("DELETE FROM ipam_ip_ranges WHERE id = ?")
    .run(req.params.id);
  if (!result.changes)
    return res.status(404).json({ error: "IP-Bereich nicht gefunden." });
  db.auditLog.write(
    "ipam.reservation_range_delete",
    `subnet=${range.cidr} start=${range.start_address} end=${range.end_address} description=${range.description || "-"}`,
    req.ip,
    true,
    req.user?.username,
  );
  res.json({ success: true });
});

// External sources are observed inventories. Their source stays authoritative
// for DHCP state; Fleet only mirrors it into matching, existing prefixes.
router.get("/sources", guard("canViewServers"), (req, res) => {
  const environmentId =
    String(req.query.environment_id || "default").trim() || "default";
  if (!guardEnvironment(req, res, environmentId)) return;
  const rows = db.db
    .prepare(
      "SELECT * FROM ipam_sync_sources WHERE environment_id = ? ORDER BY name COLLATE NOCASE",
    )
    .all(environmentId);
  res.json(rows.map(sourceSummary));
});

router.post("/sources", guard("canEditServers"), (req, res) => {
  try {
    const body = req.body || {};
    const environmentId =
      String(body.environment_id || "default").trim() || "default";
    if (!guardEnvironment(req, res, environmentId)) return;
    const type = String(body.type || "")
      .trim()
      .toLowerCase();
    const name = String(body.name || "")
      .trim()
      .slice(0, 100);
    const endpoint = validEndpoint(body.endpoint);
    const token = String(body.api_token || "").trim();
    if (!SOURCE_TYPES.has(type))
      throw new Error(
        "Als Quelle werden derzeit UniFi oder pfSense unterstützt.",
      );
    if (!name || !endpoint)
      throw new Error("Name und gültige HTTPS-/HTTP-URL sind erforderlich.");
    if (!token)
      throw new Error("Für diese Quelle ist ein API-Token erforderlich.");
    if (
      !db.db
        .prepare("SELECT 1 FROM environments WHERE id = ?")
        .get(environmentId)
    )
      throw new Error("Umgebung nicht gefunden.");
    const id = db.uuidv4();
    const defaultPath =
      type === "unifi"
        ? `/proxy/network/api/s/${encodeURIComponent(String(body.site || "default").trim() || "default")}/stat/sta`
        : "/api/v2/status/dhcp_leases";
    const path = String(body.path || defaultPath).trim();
    if (!path.startsWith("/"))
      throw new Error("Der API-Pfad muss mit / beginnen.");
    const encryptedToken = encrypt(token);
    if (encryptedToken === token)
      throw new Error(
        "SHIPYARD_KEY_SECRET ist erforderlich, damit Quell-Tokens verschlüsselt gespeichert werden.",
      );
    db.db
      .prepare(
        `INSERT INTO ipam_sync_sources (id, environment_id, type, name, endpoint, api_token, site, path, insecure, enabled, auto_sync, sync_interval_min)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        environmentId,
        type,
        name,
        endpoint.toString().replace(/\/$/, ""),
        encryptedToken,
        String(body.site || "default")
          .trim()
          .slice(0, 80),
        path.slice(0, 300),
        body.insecure === true ? 1 : 0,
        body.enabled === false ? 0 : 1,
        body.auto_sync === false ? 0 : 1,
        syncIntervalMinutes(body.sync_interval_min),
      );
    const source = db.db
      .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
      .get(id);
    db.auditLog.write(
      "ipam.source_create",
      `source=${name} type=${type}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.status(201).json(sourceSummary(source));
  } catch (error) {
    res
      .status(400)
      .json({ error: error.message || "Quelle konnte nicht erstellt werden." });
  }
});

router.put("/sources/:id", guard("canEditServers"), (req, res) => {
  try {
    const source = db.db
      .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
      .get(req.params.id);
    if (!source)
      return res.status(404).json({ error: "Quelle nicht gefunden." });
    if (!guardEnvironment(req, res, source.environment_id)) return;
    const body = req.body || {};
    const type = String(body.type || source.type)
      .trim()
      .toLowerCase();
    const name = String(body.name || source.name)
      .trim()
      .slice(0, 100);
    const endpoint = validEndpoint(body.endpoint || source.endpoint);
    const path = String(body.path ?? source.path).trim();
    if (!SOURCE_TYPES.has(type) || !name || !endpoint || !path.startsWith("/"))
      throw new Error("Quelle enthält ungültige Werte.");
    const nextToken =
      typeof body.api_token === "string" && body.api_token.trim()
        ? encrypt(body.api_token.trim())
        : source.api_token;
    if (
      typeof body.api_token === "string" &&
      body.api_token.trim() &&
      nextToken === body.api_token.trim()
    )
      throw new Error(
        "SHIPYARD_KEY_SECRET ist erforderlich, damit Quell-Tokens verschlüsselt gespeichert werden.",
      );
    db.db
      .prepare(
        `UPDATE ipam_sync_sources SET type = ?, name = ?, endpoint = ?, api_token = ?, site = ?, path = ?, insecure = ?, enabled = ?, auto_sync = ?, sync_interval_min = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(
        type,
        name,
        endpoint.toString().replace(/\/$/, ""),
        nextToken,
        String(body.site ?? source.site)
          .trim()
          .slice(0, 80),
        path.slice(0, 300),
        body.insecure === undefined ? source.insecure : body.insecure ? 1 : 0,
        body.enabled === undefined ? source.enabled : body.enabled ? 1 : 0,
        body.auto_sync === undefined
          ? (source.auto_sync ?? 1)
          : body.auto_sync
            ? 1
            : 0,
        syncIntervalMinutes(
          body.sync_interval_min,
          syncIntervalMinutes(source.sync_interval_min),
        ),
        source.id,
      );
    const updated = db.db
      .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
      .get(source.id);
    db.auditLog.write(
      "ipam.source_update",
      `source=${source.name}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json(sourceSummary(updated));
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "Quelle konnte nicht aktualisiert werden.",
      });
  }
});

router.delete("/sources/:id", guard("canEditServers"), (req, res) => {
  const source = db.db
    .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
    .get(req.params.id);
  if (!source) return res.status(404).json({ error: "Quelle nicht gefunden." });
  if (!guardEnvironment(req, res, source.environment_id)) return;
  const remove = db.db.transaction(() => {
    const reservations = db.db
      .prepare("DELETE FROM ipam_reservations WHERE source_ref LIKE ?")
      .run(`${source.id}:%`).changes;
    db.db.prepare("DELETE FROM ipam_sync_sources WHERE id = ?").run(source.id);
    return reservations;
  });
  const reservations = remove();
  db.auditLog.write(
    "ipam.source_delete",
    `source=${source.name} reservations=${reservations}`,
    req.ip,
    true,
    req.user?.username,
  );
  res.json({ deleted: true, reservations_removed: reservations });
});

// Validate a controller without changing IPAM state.  This is deliberately
// separate from sync: operators can verify endpoint, TLS, token and payload
// mapping before Fleet creates, updates or releases any lease records.
router.post("/sources/:id/test", guard("canEditServers"), async (req, res) => {
  const source = db.db
    .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
    .get(req.params.id);
  if (!source) return res.status(404).json({ error: "Quelle nicht gefunden." });
  if (!guardEnvironment(req, res, source.environment_id)) return;
  if (!source.enabled)
    return res.status(409).json({ error: "Diese Quelle ist deaktiviert." });
  const token = decrypt(String(source.api_token || ""));
  if (!token)
    return res
      .status(409)
      .json({
        error:
          "Das Token dieser Quelle kann nicht entschlüsselt werden. Bitte hinterlege es erneut.",
      });
  try {
    const payload = await sourceRequest(
      source.endpoint,
      source.path,
      token,
      Boolean(source.insecure),
    );
    const records = sourceRecords(source.type, payload);
    const matching = records.filter((record) =>
      Boolean(findSubnetForAddress(source.environment_id, record.address)),
    );
    const testedAt = new Date().toISOString();
    db.db
      .prepare(
        `UPDATE ipam_sync_sources SET last_tested_at = ?, last_test_status = 'success', last_test_error = '', updated_at = datetime('now') WHERE id = ?`,
      )
      .run(testedAt, source.id);
    db.auditLog.write(
      "ipam.source_test",
      `source=${source.name} records=${records.length} matching=${matching.length}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json({
      reachable: true,
      tested_at: testedAt,
      records: records.length,
      matching_prefixes: matching.length,
      outside_prefixes: records.length - matching.length,
      samples: records
        .slice(0, 3)
        .map((record) => ({
          address: record.address,
          hostname: record.hostname || null,
        })),
    });
  } catch (error) {
    db.db
      .prepare(
        `UPDATE ipam_sync_sources SET last_tested_at = ?, last_test_status = 'failed', last_test_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        String(error.message || "Verbindungstest fehlgeschlagen.").slice(
          0,
          500,
        ),
        source.id,
      );
    db.auditLog.write(
      "ipam.source_test",
      `source=${source.name} failed`,
      req.ip,
      false,
      req.user?.username,
    );
    res
      .status(502)
      .json({ error: error.message || "Verbindungstest fehlgeschlagen." });
  }
});

async function syncIpamSource(source, { ip, actor } = {}) {
  if (!source?.id) throw new Error("Quelle nicht gefunden.");
  if (!source.enabled) throw new Error("Diese Quelle ist deaktiviert.");
  if (syncingSources.has(source.id))
    throw new Error("Diese Quelle wird bereits synchronisiert.");
  const token = decrypt(String(source.api_token || ""));
  if (!token)
    throw new Error(
      "Das Token dieser Quelle kann nicht entschlüsselt werden. Bitte hinterlege es erneut.",
    );
  syncingSources.add(source.id);
  try {
    const payload = await sourceRequest(
      source.endpoint,
      source.path,
      token,
      Boolean(source.insecure),
    );
    const records = sourceRecords(source.type, payload);
    let created = 0;
    let updated = 0;
    let removed = 0;
    let ignored = 0;
    let conflicts = 0;
    const now = new Date().toISOString();
    const transaction = db.db.transaction(() => {
      // A sync is a complete fresh observation. Stale conflicts disappear as
      // soon as the external controller no longer reports them.
      db.db
        .prepare("DELETE FROM ipam_sync_conflicts WHERE source_id = ?")
        .run(source.id);
      const seenSourceRefs = new Set();
      for (const record of records) {
        const subnet = findSubnetForAddress(
          source.environment_id,
          record.address,
        );
        if (!subnet) {
          ignored += 1;
          continue;
        }
        const sourceRef = `${source.id}:${record.ref}`;
        seenSourceRefs.add(sourceRef);
        const existing = db.db
          .prepare(
            "SELECT id FROM ipam_reservations WHERE source_type = ? AND source_ref = ?",
          )
          .get(source.type, sourceRef);
        const collision = db.db
          .prepare(
            "SELECT id, hostname, source_type FROM ipam_reservations WHERE subnet_id = ? AND address = ? AND id != ?",
          )
          .get(subnet.id, record.address, existing?.id || "");
        if (collision) {
          db.db
            .prepare(
              `INSERT INTO ipam_sync_conflicts (id, environment_id, subnet_id, source_id, address, hostname, mac_address, reason, existing_reservation_id, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              db.uuidv4(),
              source.environment_id,
              subnet.id,
              source.id,
              record.address,
              record.hostname.slice(0, 100),
              record.mac.slice(0, 32),
              `Adresse ist bereits ${collision.source_type === "manual" ? "manuell" : "aus einer anderen Quelle"} reserviert${collision.hostname ? ` (${collision.hostname})` : ""}`,
              collision.id,
              now,
            );
          conflicts += 1;
          continue;
        }
        if (existing) {
          db.db
            .prepare(
              `UPDATE ipam_reservations SET subnet_id = ?, address = ?, hostname = ?, mac_address = ?, status = 'dhcp', description = ?, last_synced_at = ? WHERE id = ?`,
            )
            .run(
              subnet.id,
              record.address,
              record.hostname.slice(0, 100),
              record.mac.slice(0, 32),
              `Synchronisiert aus ${source.name}`,
              now,
              existing.id,
            );
          updated += 1;
        } else {
          db.db
            .prepare(
              `INSERT INTO ipam_reservations (id, subnet_id, address, hostname, mac_address, status, description, source_type, source_ref, last_synced_at)
            VALUES (?, ?, ?, ?, ?, 'dhcp', ?, ?, ?, ?)`,
            )
            .run(
              db.uuidv4(),
              subnet.id,
              record.address,
              record.hostname.slice(0, 100),
              record.mac.slice(0, 32),
              `Synchronisiert aus ${source.name}`,
              source.type,
              sourceRef,
              now,
            );
          created += 1;
        }
      }
      // A source sync is a complete current observation (DHCP leases or
      // controller clients).  Leaving vanished entries behind makes an IPAM
      // look occupied forever. Delete only reservations owned by this exact
      // source; manual, Proxmox and other controller records are untouched.
      const previous = db.db
        .prepare(
          "SELECT id, source_ref FROM ipam_reservations WHERE source_ref LIKE ?",
        )
        .all(`${source.id}:%`);
      const deleteStale = db.db.prepare(
        "DELETE FROM ipam_reservations WHERE id = ?",
      );
      for (const reservation of previous) {
        if (!seenSourceRefs.has(String(reservation.source_ref || ""))) {
          deleteStale.run(reservation.id);
          removed += 1;
        }
      }
      db.db
        .prepare(
          `UPDATE ipam_sync_sources SET last_synced_at = ?, last_status = 'success', last_error = '', updated_at = datetime('now') WHERE id = ?`,
        )
        .run(now, source.id);
    });
    transaction();
    db.auditLog.write(
      "ipam.source_sync",
      `source=${source.name} created=${created} updated=${updated} removed=${removed} conflicts=${conflicts} ignored=${ignored}`,
      ip,
      true,
      actor,
    );
    return {
      created,
      updated,
      removed,
      conflicts,
      ignored,
      records: records.length,
      synced_at: now,
    };
  } catch (error) {
    db.db
      .prepare(
        `UPDATE ipam_sync_sources SET last_status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(
        String(error.message || "Synchronisierung fehlgeschlagen").slice(
          0,
          500,
        ),
        source.id,
      );
    db.auditLog.write(
      "ipam.source_sync",
      `source=${source.name} failed`,
      ip,
      false,
      actor,
    );
    throw error;
  } finally {
    syncingSources.delete(source.id);
  }
}

router.post("/sources/:id/sync", guard("canEditServers"), async (req, res) => {
  const source = db.db
    .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
    .get(req.params.id);
  if (!source) return res.status(404).json({ error: "Quelle nicht gefunden." });
  if (!guardEnvironment(req, res, source.environment_id)) return;
  try {
    res.json(
      await syncIpamSource(source, { ip: req.ip, actor: req.user?.username }),
    );
  } catch (error) {
    const message = error.message || "Synchronisierung fehlgeschlagen.";
    const status = /nicht gefunden/.test(message)
      ? 404
      : /deaktiviert|entschl/.test(message)
        ? 409
        : /bereits synchronisiert/.test(message)
          ? 429
          : 502;
    res.status(status).json({ error: message });
  }
});

module.exports = router;
module.exports.syncIpamSource = syncIpamSource;
