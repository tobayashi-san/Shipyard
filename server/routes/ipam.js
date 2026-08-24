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
  if (req.environmentId && String(environmentId || "default") !== req.environmentId) {
    res.status(404).json({ error: "Ressource in dieser Umgebung nicht gefunden." });
    return false;
  }
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
// DHCP is derived from the prefix pool and cannot be assigned by a user or an
// inventory source. This keeps UniFi/pfSense observations from claiming that
// every address they report is necessarily a DHCP lease.
const ADDRESS_STATUSES = new Set(["active", "reserved", "deprecated"]);
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
// and does it currently disagree with Shipyard's source of truth?
function sourceSummary(row) {
  const source = publicSource(row);
  const inventory = db.db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM ipam_source_observations
    WHERE source_id = ?
  `,
    )
    .get(row.id);
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
    record_count: Number(source.last_record_count || 0),
    ignored_count: Number(source.last_ignored_count || 0),
    conflict_count: Number(conflicts?.count || 0),
  };
}

function withProxmoxSourceNames(rows) {
  const hasConnections = Boolean(
    db.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tofu_proxmox_connections'",
      )
      .get(),
  );
  if (!hasConnections) return rows;
  const names = new Map(
    db.db
      .prepare("SELECT id, name FROM tofu_proxmox_connections")
      .all()
      .map((connection) => [connection.id, connection.name]),
  );
  return rows.map((row) => {
    if (row.source_type !== "proxmox" || row.source_name) return row;
    const connectionId = String(row.source_ref || "").split(":")[0];
    return { ...row, source_name: names.get(connectionId) || "Proxmox" };
  });
}

function syncIntervalMinutes(value, fallback = 15) {
  const interval = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(interval)
    ? Math.min(1440, Math.max(5, interval))
    : fallback;
}
function sourceRequest(type, endpoint, path, token, insecure) {
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
            ? type === "pfsense"
              ? { "X-API-Key": token }
              // UniFi deployments differ between integration API keys and
              // legacy controller tokens, so retain both read-only headers.
              : { Authorization: `Bearer ${token}`, "X-API-Key": token }
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
      const mac = canonicalMac(
        item.mac ||
          item.mac_address ||
          item.macaddr ||
          item["mac-address"] ||
          "",
      );
      const hostname = String(
        item.hostname || item.name || item.host || item.client_hostname || "",
      ).trim();
      const description = String(
        item.descr || item.description || item.comment || item.note || "",
      ).trim();
      const ref = String(
        item._id ||
          item.id ||
          item.uuid ||
          item.mac ||
          `${type}-${index}-${address}`,
      ).trim();
      return { address, mac, hostname, description, ref };
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
function pagination(query, fallback = 50, maximum = 200) {
  const page = Math.max(1, Number.parseInt(String(query?.page || "1"), 10) || 1);
  const pageSize = Math.min(
    maximum,
    Math.max(1, Number.parseInt(String(query?.page_size || fallback), 10) || fallback),
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function paginated(items, page, pageSize, extra = {}) {
  const total = items.length;
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    ...extra,
  };
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
function allocationKey(row) {
  return `${row.kind}:${row.id}`;
}
function freeSpaceSegments(subnet, allocations) {
  const parsed = parseCidr(subnet.cidr);
  if (!parsed) return [];
  const usable = usableRange(parsed);
  const allSubnets = db.db
    .prepare("SELECT id, cidr FROM ipam_subnets WHERE environment_id = ?")
    .all(subnet.environment_id);
  const occupied = allocations
    .map((row) => ({
      first: ipv4(row.start_address),
      last: ipv4(row.end_address),
    }))
    .filter((range) => range.first !== null && range.last !== null)
    .concat(
      directChildrenOf(subnet, allSubnets)
        .map((child) => parseCidr(child.cidr))
        .filter(Boolean)
        .map(prefixRange),
    )
    .map((range) => ({
      first: Math.max(usable.first, range.first),
      last: Math.min(usable.last, range.last),
    }))
    .filter((range) => range.first <= range.last)
    .sort((left, right) => left.first - right.first || left.last - right.last);
  const merged = [];
  for (const range of occupied) {
    const previous = merged[merged.length - 1];
    if (previous && range.first <= previous.last + 1)
      previous.last = Math.max(previous.last, range.last);
    else merged.push({ ...range });
  }
  const gaps = [];
  let cursor = usable.first;
  for (const range of merged) {
    if (cursor < range.first) gaps.push({ first: cursor, last: range.first - 1 });
    cursor = Math.max(cursor, range.last + 1);
  }
  if (cursor <= usable.last) gaps.push({ first: cursor, last: usable.last });
  const sortedAllocations = allocations
    .map((row) => ({ row, first: ipv4(row.start_address) }))
    .filter((entry) => entry.first !== null)
    .sort((left, right) => left.first - right.first);
  return gaps.map((gap) => {
    const next = sortedAllocations.find((entry) => entry.first > gap.last);
    return {
      start_address: toIpv4(gap.first),
      end_address: toIpv4(gap.last),
      address_count: gap.last - gap.first + 1,
      before_allocation_key: next ? allocationKey(next.row) : null,
    };
  });
}
function gatewayNumber(subnet) {
  const parsed = parseCidr(subnet?.cidr);
  const gateway = ipv4(subnet?.gateway);
  return parsed && gateway !== null && isUsableAddress(gateway, parsed)
    ? gateway
    : null;
}
function configuredDhcpRange(subnet) {
  const start = ipv4(subnet?.dhcp_start);
  const end = ipv4(subnet?.dhcp_end);
  return start !== null && end !== null && start <= end
    ? { first: start, last: end }
    : null;
}
function effectiveReservationStatus(row, subnet) {
  const address = ipv4(row?.address ?? row?.start_address);
  const pool = configuredDhcpRange(subnet);
  if (address !== null && pool && address >= pool.first && address <= pool.last)
    return "dhcp";
  return row?.status === "dhcp" ? "active" : row?.status;
}
function withEffectiveReservationStatus(row, subnet) {
  return {
    ...row,
    configured_status: row.status === "dhcp" ? "active" : row.status,
    status: effectiveReservationStatus(row, subnet),
  };
}
function requestedDhcpRange(body, subnet, parsed, otherSubnets = []) {
  const startText = String(body.dhcp_start ?? subnet?.dhcp_start ?? "").trim();
  const endText = String(body.dhcp_end ?? subnet?.dhcp_end ?? "").trim();
  if (!startText && !endText)
    return { dhcpStart: "", dhcpEnd: "", range: null };
  if (!startText || !endText)
    throw new Error("DHCP-Start und DHCP-Ende müssen gemeinsam angegeben werden.");
  const start = ipv4(startText);
  const end = ipv4(endText);
  if (
    start === null ||
    end === null ||
    start > end ||
    !isUsableAddress(start, parsed) ||
    !isUsableAddress(end, parsed)
  )
    throw new Error("Der DHCP-Bereich muss aus verwendbaren Adressen dieses Prefixes bestehen.");
  const gateway = ipv4(String(body.gateway ?? subnet?.gateway ?? "").trim());
  if (gateway !== null && gateway >= start && gateway <= end)
    throw new Error("Der DHCP-Bereich darf das konfigurierte Gateway nicht enthalten.");
  const overlapsChild = otherSubnets.some((candidate) => {
    if (candidate.id && subnet?.id && candidate.id === subnet.id) return false;
    const child = parseCidr(candidate.cidr);
    if (!child || child.prefix <= parsed.prefix || !cidrContains(parsed, child))
      return false;
    return rangesOverlap({ first: start, last: end }, prefixRange(child));
  });
  if (overlapsChild)
    throw new Error("Der DHCP-Bereich darf kein delegiertes Child-Prefix überdecken.");
  return {
    dhcpStart: toIpv4(start),
    dhcpEnd: toIpv4(end),
    range: { first: start, last: end },
  };
}
function allocationCoversAddress(rows, address) {
  return rows.some((row) => {
    const start = ipv4(row.start_address ?? row.address);
    const end = ipv4(row.end_address ?? row.address);
    return start !== null && end !== null && address >= start && address <= end;
  });
}
function systemGatewayAllocation(subnet, existingAllocations) {
  const gateway = gatewayNumber(subnet);
  if (gateway === null || allocationCoversAddress(existingAllocations, gateway))
    return null;
  const address = toIpv4(gateway);
  const observations = db.db
    .prepare(
      `SELECT source.name, source.type, observation.hostname,
              observation.mac_address, observation.last_seen_at
       FROM ipam_source_observations observation
       JOIN ipam_sync_sources source ON source.id = observation.source_id
       WHERE observation.subnet_id = ? AND observation.address = ?
         AND observation.reservation_id IS NULL
       ORDER BY observation.last_seen_at DESC, source.name COLLATE NOCASE`,
    )
    .all(subnet.id, address);
  const primary = observations.find(
    (observation) => observation.hostname || observation.mac_address,
  );
  const observedMacs = new Set(
    observations.map((observation) => canonicalMac(observation.mac_address)).filter(Boolean),
  );
  const conflicts = observedMacs.size > 1
    ? ["Gateway wird von externen Quellen mit unterschiedlichen MAC-Adressen beobachtet"]
    : [];
  const sourceObservations = observations.map((observation) => ({
    name: observation.name,
    type: observation.type,
    last_seen_at: observation.last_seen_at,
  }));
  return {
    id: `gateway:${subnet.id}`,
    subnet_id: subnet.id,
    kind: "address",
    address,
    start_address: address,
    end_address: address,
    address_count: 1,
    hostname: primary?.hostname || "Gateway",
    mac_address: canonicalMac(primary?.mac_address),
    status: "reserved",
    role: "gateway",
    description: "Configured gateway",
    source_type: "system",
    system_managed: true,
    conflicts,
    conflict: conflicts.length > 0,
    source_observations: sourceObservations,
    observed_sources: sourceObservations.map((observation) => observation.name),
  };
}
function gatewayHasStoredCollision(subnet, gateway) {
  if (gateway === null) return false;
  const address = toIpv4(gateway);
  if (
    db.db
      .prepare("SELECT 1 FROM ipam_reservations WHERE subnet_id = ? AND address = ?")
      .get(subnet.id, address)
  )
    return true;
  return getRanges(subnet.id).some((row) => {
    const start = ipv4(row.start_address);
    const end = ipv4(row.end_address);
    return start !== null && end !== null && gateway >= start && gateway <= end;
  });
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
  const gateway = gatewayNumber(subnet);
  const gatewayCovered = gateway === null ||
    reservations.some((row) => ipv4(row.address) === gateway) ||
    ranges.some((row) => {
      const start = ipv4(row.start_address);
      const end = ipv4(row.end_address);
      return start !== null && end !== null && gateway >= start && gateway <= end;
    }) ||
    directChildren.some((child) => {
      const parsedChild = parseCidr(child.cidr);
      return parsedChild && rangesOverlap(
        { first: gateway, last: gateway },
        prefixRange(parsedChild),
      );
    });
  const gatewayUsage = gatewayCovered ? 0 : 1;
  const used = Math.min(
    usable,
    reservations.length + rangeUsage + childUsage + gatewayUsage,
  );
  return {
    usable,
    used,
    free: Math.max(0, usable - used),
    reservationCount: reservations.length + gatewayUsage,
    rangeCount: ranges.length,
    childUsage,
  };
}
function directChildrenOf(subnet, allSubnets) {
  const parsed = parseCidr(subnet.cidr);
  return (allSubnets || []).filter((candidate) => {
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
  const directChildren = directChildrenOf(subnet, allSubnets);
  const usage = getUsage(subnet, directChildren);
  const dhcpPool = configuredDhcpRange(subnet);
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
    dhcp_address_count: dhcpPool ? dhcpPool.last - dhcpPool.first + 1 : 0,
    next_free_address: parsed
      ? nextFreeAddress(subnet, parsed, directChildren)
      : null,
  };
}
function nextFreeAddress(subnet, parsed, directChildren = []) {
  const taken = new Set(
    db.db
      .prepare("SELECT address FROM ipam_reservations WHERE subnet_id = ?")
      .all(subnet.id)
      .map((row) => ipv4(row.address))
      .filter((value) => value !== null),
  );
  const gateway = gatewayNumber(subnet);
  if (gateway !== null) taken.add(gateway);
  const occupiedRanges = getRanges(subnet.id)
    .map((row) => ({
      start: ipv4(row.start_address),
      end: ipv4(row.end_address),
    }))
    .filter((range) => range.start !== null && range.end !== null);
  const delegatedRanges = directChildren
    .map((child) => parseCidr(child.cidr))
    .filter(Boolean)
    .map(prefixRange);
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
      ) &&
      !delegatedRanges.some(
        (range) => current >= range.first && current <= range.last,
      )
    )
      return toIpv4(current);
  return null;
}

function assignedServerError(environmentId, serverId) {
  if (!serverId) return null;
  const server = db.db
    .prepare("SELECT environment_id FROM servers WHERE id = ?")
    .get(serverId);
  if (!server || String(server.environment_id || "default") !== environmentId)
    return "Zugewiesener Host wurde in dieser Umgebung nicht gefunden.";
  return null;
}

function overlapsDelegatedPrefix(subnet, start, end = start) {
  const all = db.db
    .prepare("SELECT id, cidr FROM ipam_subnets WHERE environment_id = ?")
    .all(subnet.environment_id);
  return directChildrenOf(subnet, all).some((child) => {
    const parsed = parseCidr(child.cidr);
    return parsed && rangesOverlap(
      { first: start, last: end },
      prefixRange(parsed),
    );
  });
}

function overlapsEnvironmentAllocation(environmentId, subnetId, start, end = start, ignoredReservationId = null) {
  const reservations = db.db.prepare(`
    SELECT reservation.id, reservation.address
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    WHERE subnet.environment_id = ? AND reservation.subnet_id <> ?
  `).all(environmentId, subnetId);
  if (reservations.some((row) => row.id !== ignoredReservationId && (() => {
    const value = ipv4(row.address);
    return value !== null && value >= start && value <= end;
  })())) return true;
  const ranges = db.db.prepare(`
    SELECT range.start_address, range.end_address
    FROM ipam_ip_ranges range
    JOIN ipam_subnets subnet ON subnet.id = range.subnet_id
    WHERE subnet.environment_id = ? AND range.subnet_id <> ?
  `).all(environmentId, subnetId);
  return ranges.some((row) => {
    const otherStart = ipv4(row.start_address);
    const otherEnd = ipv4(row.end_address);
    return otherStart !== null && otherEnd !== null && rangesOverlap(
      { first: start, last: end },
      { first: otherStart, last: otherEnd },
    );
  });
}

function reservationSpaceError(subnet, start, end = start) {
  const parsed = subnet && parseCidr(subnet.cidr);
  if (!subnet || !parsed) return "Netzwerk wurde nicht gefunden.";
  if (
    start === null || end === null || start > end ||
    !isUsableAddress(start, parsed) || !isUsableAddress(end, parsed)
  )
    return start === end
      ? "Adresse liegt ausserhalb des nutzbaren Bereichs dieses Prefixes."
      : "Der Bereich muss vollständig innerhalb der nutzbaren Adressen dieses Prefixes liegen.";
  const gateway = gatewayNumber(subnet);
  if (gateway !== null && gateway >= start && gateway <= end)
    return "Die Auswahl enthält das konfigurierte Gateway.";
  if (overlapsDelegatedPrefix(subnet, start, end))
    return "Die Auswahl überschneidet sich mit einem delegierten Child-Prefix.";
  if (overlapsEnvironmentAllocation(subnet.environment_id, subnet.id, start, end))
    return "Die Auswahl überschneidet sich mit einer Belegung in einem anderen Prefix.";
  const addressOverlap = db.db
    .prepare("SELECT address FROM ipam_reservations WHERE subnet_id = ?")
    .all(subnet.id)
    .some((row) => {
      const value = ipv4(row.address);
      return value !== null && value >= start && value <= end;
    });
  const rangeOverlap = getRanges(subnet.id).some((row) => {
    const otherStart = ipv4(row.start_address);
    const otherEnd = ipv4(row.end_address);
    return otherStart !== null && otherEnd !== null && rangesOverlap(
      { first: start, last: end },
      { first: otherStart, last: otherEnd },
    );
  });
  if (addressOverlap || rangeOverlap)
    return "Die Auswahl überschneidet sich mit einer bestehenden Reservierung.";
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
  const compact = String(value || "")
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "");
  return compact.length === 12 ? compact : "";
}
function canonicalMac(value) {
  const compact = normalizedMac(value);
  return compact ? compact.match(/.{2}/g).join(":") : "";
}
function parseMac(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const mac = canonicalMac(input);
  if (!mac) throw new Error("MAC-Adresse muss aus 12 hexadezimalen Zeichen bestehen.");
  return mac;
}
function sameMachine(left, right) {
  const leftMac = normalizedMac(left?.mac_address ?? left?.mac);
  const rightMac = normalizedMac(right?.mac_address ?? right?.mac);
  return Boolean(leftMac && rightMac && leftMac === rightMac);
}
function canEnrichAutomatedMachine(observation, reservation) {
  return Boolean(
    normalizedMac(observation?.mac_address ?? observation?.mac) &&
      !normalizedMac(reservation?.mac_address ?? reservation?.mac) &&
      reservation?.source_type &&
      reservation.source_type !== "manual",
  );
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
  const observations = db.db
    .prepare(
      `SELECT observation.reservation_id, source.name, source.type,
              observation.last_seen_at
       FROM ipam_source_observations observation
       JOIN ipam_sync_sources source ON source.id = observation.source_id
       WHERE observation.environment_id = ? AND observation.reservation_id IS NOT NULL
       ORDER BY source.name`,
    )
    .all(environmentId);
  const sourcesByReservation = new Map();
  for (const observation of observations) {
    const bucket = sourcesByReservation.get(observation.reservation_id) || [];
    if (!bucket.some((source) => source.name === observation.name))
      bucket.push({
        name: observation.name,
        type: observation.type,
        last_seen_at: observation.last_seen_at,
      });
    sourcesByReservation.set(observation.reservation_id, bucket);
  }
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
  }
  return rows.map((row) => {
    const conflicts = [];
    if (
      (byAddress.get(String(row.address || "").trim()) || []).some(
        (other) => other.id !== row.id && !sameMachine(row, other),
      )
    )
      conflicts.push("IP-Adresse mehrfach in der Umgebung erfasst");
    for (const external of externalByAddress.get(
      String(row.address || "").trim(),
    ) || []) {
      const origin =
        external.source_kind === "proxmox"
          ? `Proxmox ${external.source_name || "Verbindung"}`
          : external.source_name || "externer Quelle";
      conflicts.push(`Konflikt mit ${origin}: ${external.reason}`);
    }
    return {
      ...row,
      mac_address: canonicalMac(row.mac_address),
      source_observations: sourcesByReservation.get(row.id) || [],
      observed_sources: (sourcesByReservation.get(row.id) || []).map(
        (source) => source.name,
      ),
      conflicts,
      conflict: conflicts.length > 0,
    };
  });
}

router.get("/subnets", guard("canViewNetworks"), (req, res) => {
  const environmentId =
    req.environmentId || String(req.query.environment_id || "default").trim() || "default";
  if (!guardEnvironment(req, res, environmentId)) return;
  const rows = db.db
    .prepare(
      "SELECT * FROM ipam_subnets WHERE environment_id = ? ORDER BY cidr",
    )
    .all(environmentId);
  const enriched = rows.map((row) => enrichSubnet(row, rows));
  if (String(req.query.paginated || "") !== "1") return res.json(enriched);
  const query = String(req.query.q || "").trim().toLowerCase();
  const status = String(req.query.status || "current").trim().toLowerCase();
  const filtered = enriched.filter((row) => {
    const matchesQuery = !query || [row.name, row.cidr, row.description, row.gateway, row.dhcp_start, row.dhcp_end, row.bridge, row.role]
      .some((value) => String(value || "").toLowerCase().includes(query));
    const matchesStatus = status === "all"
      || (status === "current" ? row.status !== "deprecated" : row.status === status);
    return matchesQuery && matchesStatus;
  });
  const roots = enriched.filter((row) => !row.parent_id);
  const totalAddresses = roots.reduce((sum, row) => sum + row.usable_address_count, 0);
  const usedAddresses = roots.reduce((sum, row) => sum + row.used_address_count, 0);
  const { page, pageSize } = pagination(req.query);
  res.json(paginated(filtered, page, pageSize, {
    summary: {
      prefix_count: roots.length,
      child_prefix_count: enriched.length - roots.length,
      usable_address_count: totalAddresses,
      used_address_count: usedAddresses,
      free_address_count: Math.max(0, totalAddresses - usedAddresses),
      reservation_count: roots.reduce((sum, row) => sum + row.reservation_count, 0),
      range_count: roots.reduce((sum, row) => sum + row.range_count, 0),
    },
  }));
});

router.get("/search", guard("canViewNetworks"), (req, res) => {
  const environmentId = req.environmentId
    || String(req.query.environment_id || "default").trim()
    || "default";
  if (!guardEnvironment(req, res, environmentId)) return;
  const query = String(req.query.q || "").trim();
  const { page, pageSize } = pagination(req.query, 30, 100);
  if (!query) return res.json(paginated([], page, pageSize));
  const like = `%${query}%`;
  const prefixes = db.db.prepare(`
    SELECT 'prefix' AS kind, subnet.id, subnet.cidr AS label, subnet.name AS secondary,
           subnet.id AS subnet_id, subnet.cidr AS subnet_cidr, subnet.status,
           subnet.description, NULL AS server_id
    FROM ipam_subnets subnet
    WHERE subnet.environment_id = ?
      AND (subnet.cidr LIKE ? OR subnet.name LIKE ? OR subnet.gateway LIKE ?
        OR subnet.dhcp_start LIKE ? OR subnet.dhcp_end LIKE ?
        OR subnet.description LIKE ? OR subnet.bridge LIKE ? OR CAST(subnet.vlan_id AS TEXT) LIKE ?)
  `).all(environmentId, like, like, like, like, like, like, like, like);
  const addresses = db.db.prepare(`
    SELECT 'address' AS kind, reservation.id, reservation.address,
           reservation.address AS label,
           COALESCE(NULLIF(device.name, ''), NULLIF(reservation.hostname, ''), server.name, 'IP address') AS secondary,
           subnet.id AS subnet_id, subnet.cidr AS subnet_cidr, reservation.status,
           subnet.dhcp_start, subnet.dhcp_end,
           reservation.description, reservation.server_id
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    LEFT JOIN servers server ON server.id = reservation.server_id AND server.environment_id = subnet.environment_id
    LEFT JOIN ipam_device_names device ON device.environment_id = subnet.environment_id AND device.mac_address = reservation.mac_address
    WHERE subnet.environment_id = ?
      AND (reservation.address LIKE ? OR reservation.hostname LIKE ? OR reservation.mac_address LIKE ?
        OR reservation.description LIKE ? OR server.name LIKE ? OR device.name LIKE ?)
  `).all(environmentId, like, like, like, like, like, like);
  const ranges = db.db.prepare(`
    SELECT 'range' AS kind, range.id,
           range.start_address || ' – ' || range.end_address AS label,
           COALESCE(NULLIF(range.description, ''), 'Reserved range') AS secondary,
           subnet.id AS subnet_id, subnet.cidr AS subnet_cidr, range.status,
           range.description, NULL AS server_id
    FROM ipam_ip_ranges range
    JOIN ipam_subnets subnet ON subnet.id = range.subnet_id
    WHERE subnet.environment_id = ?
      AND (range.start_address LIKE ? OR range.end_address LIKE ? OR range.description LIKE ?)
  `).all(environmentId, like, like, like);
  const effectiveAddresses = addresses.map((row) =>
    withEffectiveReservationStatus(row, row),
  );
  const results = [...prefixes, ...effectiveAddresses, ...ranges].sort((left, right) =>
    String(left.label).localeCompare(String(right.label), undefined, { numeric: true }),
  );
  res.json(paginated(results, page, pageSize));
});

router.get("/subnets/:id", guard("canViewNetworks"), (req, res) => {
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

router.post("/subnets", guard("canEditNetworks"), (req, res) => {
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
        !isUsableAddress(ipv4(gateway), parsed))
    )
      return res.status(400).json({ error: "Gateway ist keine verwendbare Adresse im Subnetz." });
    const vlan =
      body.vlan_id === "" || body.vlan_id === undefined
        ? null
        : Number(body.vlan_id);
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094))
      return res
        .status(400)
        .json({ error: "VLAN muss zwischen 1 und 4094 liegen." });
    const existing = db.db
      .prepare("SELECT id, cidr, dhcp_start, dhcp_end FROM ipam_subnets WHERE environment_id = ?")
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
    const overlapsParentDhcpPool = existing.some((row) => {
      const parent = parseCidr(row.cidr);
      const pool = configuredDhcpRange(row);
      return Boolean(
        parent &&
          pool &&
          parent.prefix < parsed.prefix &&
          cidrContains(parent, parsed) &&
          rangesOverlap(pool, prefixRange(parsed)),
      );
    });
    if (overlapsParentDhcpPool)
      return res.status(409).json({
        error: "Das Child-Prefix überschneidet sich mit dem DHCP-Bereich seines Parent-Prefixes.",
      });
    const { dhcpStart, dhcpEnd } = requestedDhcpRange(
      body,
      { gateway },
      parsed,
      existing,
    );
    const id = db.uuidv4();
    const status = validateChoice(body.status, SUBNET_STATUSES, "active");
    const role = String(body.role || "")
      .trim()
      .slice(0, 60);
    db.db
      .prepare(
        "INSERT INTO ipam_subnets (id, environment_id, name, cidr, gateway, dhcp_start, dhcp_end, dns_servers, vlan_id, bridge, description, status, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        environmentId,
        name,
        parsed.cidr,
        gateway,
        dhcpStart,
        dhcpEnd,
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

router.put("/subnets/:id", guard("canEditNetworks"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  try {
    const body = req.body || {};
    if (body.cidr !== undefined && parseCidr(body.cidr)?.cidr !== subnet.cidr)
      return res.status(409).json({
        error: "Das CIDR eines bestehenden Prefixes kann nicht geändert werden. Erstelle dafür ein neues Prefix.",
      });
    const parsed = parseCidr(subnet.cidr);
    const name = String(body.name ?? subnet.name).trim().slice(0, 80);
    const gateway = String(body.gateway ?? subnet.gateway ?? "").trim();
    if (!name) return res.status(400).json({ error: "Name ist erforderlich." });
    if (gateway && (ipv4(gateway) === null || !isUsableAddress(ipv4(gateway), parsed)))
      return res.status(400).json({
        error: "Gateway ist keine verwendbare Adresse im Subnetz.",
      });
    const gatewayValue = gateway ? ipv4(gateway) : null;
    if (
      gateway !== String(subnet.gateway || "").trim() &&
      (gatewayHasStoredCollision(subnet, gatewayValue) ||
        (gatewayValue !== null && overlapsDelegatedPrefix(subnet, gatewayValue)))
    )
      return res.status(409).json({
        error: "Die Gateway-Adresse ist bereits durch eine Adresse, einen Bereich oder ein Child-Prefix belegt.",
      });
    const vlanValue = body.vlan_id === undefined ? subnet.vlan_id : body.vlan_id;
    const vlan = vlanValue === "" || vlanValue === null ? null : Number(vlanValue);
    if (vlan !== null && (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094))
      return res.status(400).json({ error: "VLAN muss zwischen 1 und 4094 liegen." });
    const dnsServers = body.dns_servers === undefined
      ? (() => { try { return JSON.parse(subnet.dns_servers || "[]"); } catch { return []; } })()
      : parseDns(body.dns_servers);
    const allSubnets = db.db
      .prepare("SELECT id, cidr FROM ipam_subnets WHERE environment_id = ?")
      .all(subnet.environment_id);
    const { dhcpStart, dhcpEnd } = requestedDhcpRange(
      body,
      { ...subnet, gateway },
      parsed,
      allSubnets,
    );
    const status = validateChoice(body.status, SUBNET_STATUSES, subnet.status || "active");
    db.db.prepare(`
      UPDATE ipam_subnets
      SET name = ?, gateway = ?, dhcp_start = ?, dhcp_end = ?, dns_servers = ?, vlan_id = ?, bridge = ?,
          description = ?, status = ?, role = ?
      WHERE id = ?
    `).run(
      name,
      gateway,
      dhcpStart,
      dhcpEnd,
      JSON.stringify(dnsServers),
      vlan,
      String(body.bridge ?? subnet.bridge ?? "").trim().slice(0, 80),
      String(body.description ?? subnet.description ?? "").trim().slice(0, 500),
      status,
      String(body.role ?? subnet.role ?? "").trim().slice(0, 60),
      subnet.id,
    );
    db.auditLog.write(
      "ipam.subnet_update",
      `subnet=${subnet.cidr} name=${name}`,
      req.ip,
      true,
      req.user?.username,
    );
    const updated = db.db.prepare("SELECT * FROM ipam_subnets WHERE id = ?").get(subnet.id);
    const all = db.db.prepare("SELECT * FROM ipam_subnets WHERE environment_id = ?").all(subnet.environment_id);
    res.json(enrichSubnet(updated, all));
  } catch (error) {
    res.status(400).json({ error: error.message || "Prefix konnte nicht gespeichert werden." });
  }
});

router.delete("/subnets/:id", guard("canEditNetworks"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const counts = {
    reservations: Number(db.db.prepare("SELECT COUNT(*) AS count FROM ipam_reservations WHERE subnet_id = ?").get(subnet.id)?.count || 0),
    ranges: Number(db.db.prepare("SELECT COUNT(*) AS count FROM ipam_ip_ranges WHERE subnet_id = ?").get(subnet.id)?.count || 0),
  };
  const transaction = db.db.transaction(() => {
    db.db.prepare("DELETE FROM ipam_sync_conflicts WHERE subnet_id = ?").run(subnet.id);
    const hasProxmoxConflicts = db.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('ipam_proxmox_sync_conflicts', 'tofu_proxmox_connections')
    `).get()?.count === 2;
    if (hasProxmoxConflicts)
      db.db.prepare("DELETE FROM ipam_proxmox_sync_conflicts WHERE subnet_id = ?").run(subnet.id);
    db.db.prepare("DELETE FROM ipam_reservations WHERE subnet_id = ?").run(subnet.id);
    db.db.prepare("DELETE FROM ipam_ip_ranges WHERE subnet_id = ?").run(subnet.id);
    db.db.prepare("DELETE FROM ipam_subnets WHERE id = ?").run(subnet.id);
  });
  try {
    transaction();
  } catch (error) {
    return res.status(409).json({
      error: error.message || "Prefix konnte nicht gelöscht werden.",
    });
  }
  db.auditLog.write(
    "ipam.subnet_delete",
    `subnet=${subnet.cidr} reservations=${counts.reservations} ranges=${counts.ranges}`,
    req.ip,
    true,
    req.user?.username,
  );
  res.json({ success: true, deleted: counts });
});

// Keep bulk changes deliberately narrow: changing a prefix lifecycle state is
// reversible and does not alter its CIDR, reservations, or child prefixes.
router.patch("/subnets/:id/status", guard("canEditNetworks"), (req, res) => {
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

router.get("/subnets/:id/reservations", guard("canViewNetworks"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const rows = db.db
    .prepare(
      `
    SELECT reservation.*, server.name AS server_name, source.name AS source_name,
           device.name AS device_name
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    LEFT JOIN servers server ON server.id = reservation.server_id AND server.environment_id = ?
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    LEFT JOIN ipam_device_names device ON device.environment_id = subnet.environment_id AND device.mac_address = reservation.mac_address
    WHERE reservation.subnet_id = ?
  `,
    )
    .all(subnet.environment_id, req.params.id);
  const sourcedRows = withProxmoxSourceNames(rows);
  sourcedRows.sort(
    (left, right) => (ipv4(left.address) ?? 0) - (ipv4(right.address) ?? 0),
  );
  res.json(withReservationConflicts(sourcedRows, subnet.environment_id));
});

// Conflicts are intentionally exposed separately from the normal allocation
// list.  An address remains usable and visible in its current source of truth;
// this endpoint supplies the operator with the competing observation and its
// origin, rather than encouraging an unsafe overwrite during a sync.
router.get("/subnets/:id/conflicts", guard("canViewNetworks"), (req, res) => {
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
    LEFT JOIN servers server ON server.id = reservation.server_id AND server.environment_id = ?
    WHERE conflict.subnet_id = ?
  `,
    )
    .all(subnet.environment_id, subnet.id);
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
      conflict.id, conflict.address, conflict.hostname, conflict.mac_address,
      conflict.reason, conflict.last_seen_at, 'proxmox' AS source_kind,
      'proxmox' AS source_type, COALESCE(connection.name, 'Proxmox') AS source_name,
      reservation.id AS existing_reservation_id, reservation.address AS existing_address,
      reservation.hostname AS existing_hostname, reservation.source_type AS existing_source_type,
      server.id AS existing_server_id, server.name AS existing_server_name
    FROM ipam_proxmox_sync_conflicts conflict
    LEFT JOIN tofu_proxmox_connections connection ON connection.id = conflict.connection_id
    LEFT JOIN ipam_reservations reservation ON reservation.id = conflict.existing_reservation_id
    LEFT JOIN servers server ON server.id = reservation.server_id AND server.environment_id = ?
    WHERE conflict.subnet_id = ?
  `,
        )
        .all(subnet.environment_id, subnet.id)
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
router.get("/reservations", guard("canViewNetworks"), (req, res) => {
  const serverId = String(req.query?.server_id || "").trim();
  if (!serverId)
    return res.status(400).json({ error: "server_id is required" });
  const server = db.db
    .prepare("SELECT environment_id FROM servers WHERE id = ?")
    .get(serverId);
  if (!server)
    return res.status(404).json({ error: "Host nicht gefunden." });
  if (!guardEnvironment(req, res, server.environment_id)) return;
  const rows = db.db
    .prepare(
      `
    SELECT reservation.*, subnet.cidr AS subnet_cidr, subnet.name AS subnet_name,
           subnet.dhcp_start, subnet.dhcp_end, source.name AS source_name,
           device.name AS device_name
    FROM ipam_reservations reservation
    JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    LEFT JOIN ipam_device_names device ON device.environment_id = subnet.environment_id AND device.mac_address = reservation.mac_address
    WHERE reservation.server_id = ? AND subnet.environment_id = ?
    ORDER BY subnet.cidr, reservation.address
  `,
    )
    .all(serverId, server.environment_id);
  res.json(
    withProxmoxSourceNames(rows).map((row) =>
      withEffectiveReservationStatus(row, row),
    ),
  );
});

// A prefix is operated as one address space. Return single IP reservations and
// larger reservations together so clients do not have to switch between two
// unrelated lists just to understand what is already allocated.
router.get("/subnets/:id/allocations", guard("canViewNetworks"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT id, cidr, gateway, dhcp_start, dhcp_end, environment_id FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const addresses = withReservationConflicts(
    withProxmoxSourceNames(db.db
      .prepare(
        `
    SELECT reservation.*, server.name AS server_name, source.name AS source_name,
           device.name AS device_name
    FROM ipam_reservations reservation
    JOIN ipam_subnets reservation_subnet ON reservation_subnet.id = reservation.subnet_id
    LEFT JOIN servers server ON server.id = reservation.server_id AND server.environment_id = ?
    LEFT JOIN ipam_sync_sources source ON reservation.source_ref LIKE source.id || ':%'
    LEFT JOIN ipam_device_names device ON device.environment_id = reservation_subnet.environment_id AND device.mac_address = reservation.mac_address
    WHERE reservation.subnet_id = ?
  `,
      )
      .all(subnet.environment_id, subnet.id)),
    subnet.environment_id,
  ).map((row) => ({
    ...withEffectiveReservationStatus(row, subnet),
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
  const existingAllocations = [...addresses, ...ranges];
  const gatewayAllocation = systemGatewayAllocation(subnet, existingAllocations);
  const rows = gatewayAllocation
    ? [...existingAllocations, gatewayAllocation]
    : existingAllocations;
  rows.sort(
    (left, right) =>
      (ipv4(left.start_address) ?? 0) - (ipv4(right.start_address) ?? 0),
  );
  if (String(req.query.paginated || "") !== "1") return res.json(rows);
  const query = String(req.query.q || "").trim().toLowerCase();
  const status = String(req.query.status || "all").trim().toLowerCase();
  const filtered = rows.filter((row) => {
    const matchesQuery = !query || [
      row.start_address, row.end_address, row.hostname, row.device_name, row.server_name,
      row.description, row.role, row.source_type, row.source_name, row.mac_address,
      (row.source_observations || []).map((source) => `${source.type} ${source.name}`).join(" "),
    ].some((value) => String(value || "").toLowerCase().includes(query));
    return matchesQuery && (status === "all" || row.status === status);
  });
  const { page, pageSize } = pagination(req.query);
  const response = paginated(filtered, page, pageSize);
  const pageKeys = new Set(response.items.map(allocationKey));
  const lastAllocationKey = rows.length ? allocationKey(rows[rows.length - 1]) : null;
  response.free_segments = freeSpaceSegments(subnet, rows).filter((segment) =>
    segment.before_allocation_key
      ? pageKeys.has(segment.before_allocation_key)
      : rows.length === 0 || pageKeys.has(lastAllocationKey),
  );
  res.json(response);
});

router.get("/subnets/:id/children", guard("canViewNetworks"), (req, res) => {
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

router.get("/subnets/:id/ranges", guard("canViewNetworks"), (req, res) => {
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

// Non-destructive validation for immediate feedback in the reservation dialog.
router.post("/subnets/:id/reservations/validate", guard("canViewNetworks"), (req, res) => {
  const subnet = db.db
    .prepare("SELECT * FROM ipam_subnets WHERE id = ?")
    .get(req.params.id);
  if (!subnet)
    return res.status(404).json({ error: "Netzwerk nicht gefunden." });
  if (!guardEnvironment(req, res, subnet.environment_id)) return;
  const kind = String(req.body?.kind || "address");
  const start = ipv4(kind === "range" ? req.body?.start_address : req.body?.address);
  const end = ipv4(kind === "range" ? req.body?.end_address : req.body?.address);
  const error = reservationSpaceError(subnet, start, end);
  res.json({ valid: !error, message: error || "Adresse ist verfügbar." });
});

router.post(
  "/subnets/:id/reservations",
  guard("canEditNetworks"),
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
    if (gatewayNumber(subnet) === numeric)
      return res.status(409).json({
        error: "Die Adresse ist als Gateway dieses Prefixes belegt.",
      });
    if (overlapsDelegatedPrefix(subnet, numeric))
      return res.status(409).json({
        error: "Adresse gehört zu einem delegierten Child-Prefix.",
      });
    if (overlapsEnvironmentAllocation(subnet.environment_id, subnet.id, numeric))
      return res.status(409).json({
        error: "Adresse ist bereits in einem anderen Prefix dieser Umgebung belegt.",
      });
    if (String(req.body?.status || "").trim().toLowerCase() === "dhcp")
      return res.status(400).json({
        error: "DHCP wird automatisch aus dem Bereich des Prefixes abgeleitet.",
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
      const serverId = String(req.body?.server_id || "").trim() || null;
      const serverError = assignedServerError(subnet.environment_id, serverId);
      if (serverError) return res.status(400).json({ error: serverError });
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
          serverId,
          parseMac(req.body?.mac_address),
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
          withEffectiveReservationStatus(
            db.db.prepare("SELECT * FROM ipam_reservations WHERE id = ?").get(id),
            subnet,
          ),
        );
    } catch (error) {
      res
        .status(409)
        .json({ error: error.message || "Adresse ist bereits reserviert." });
    }
  },
);

router.put("/reservations/:id", guard("canEditNetworks"), (req, res) => {
  const reservation = db.db
    .prepare("SELECT * FROM ipam_reservations WHERE id = ?")
    .get(req.params.id);
  if (!reservation)
    return res.status(404).json({ error: "IP-Adresse nicht gefunden." });
  if (reservation.source_type && reservation.source_type !== "manual")
    return res.status(409).json({
      error: "Synchronisierte Adressen werden in ihrer Quelle gepflegt.",
    });
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
    if (gatewayNumber(subnet) === numeric)
      return res.status(409).json({
        error: "Die Adresse ist als Gateway dieses Prefixes belegt.",
      });
    if (overlapsDelegatedPrefix(subnet, numeric))
      return res.status(409).json({
        error: "Adresse gehört zu einem delegierten Child-Prefix.",
      });
    if (
      overlapsEnvironmentAllocation(
        subnet.environment_id,
        subnet.id,
        numeric,
        reservation.id,
      )
    )
      return res.status(409).json({
        error: "Adresse ist bereits in einem anderen Prefix dieser Umgebung belegt.",
      });
    if (String(req.body?.status || "").trim().toLowerCase() === "dhcp")
      return res.status(400).json({
        error: "DHCP wird automatisch aus dem Bereich des Prefixes abgeleitet.",
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
    const serverError = assignedServerError(subnet.environment_id, serverId);
    if (serverError) return res.status(400).json({ error: serverError });
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
        parseMac(req.body?.mac_address),
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
      withEffectiveReservationStatus(
        db.db
          .prepare("SELECT * FROM ipam_reservations WHERE id = ?")
          .get(reservation.id),
        subnet,
      ),
    );
  } catch (error) {
    res
      .status(400)
      .json({
        error: error.message || "IP-Adresse konnte nicht gespeichert werden.",
      });
  }
});

// A friendly device name is intentionally edited independently from an
// imported reservation. Its key is the normalized MAC address, so DHCP lease
// changes and source-driven reservation moves cannot detach the name.
router.patch("/reservations/:id/device-name", guard("canEditNetworks"), (req, res) => {
  const reservation = db.db
    .prepare(`
      SELECT reservation.id, reservation.address, reservation.mac_address,
             subnet.environment_id, subnet.cidr
      FROM ipam_reservations reservation
      JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id
      WHERE reservation.id = ?
    `)
    .get(req.params.id);
  if (!reservation)
    return res.status(404).json({ error: "IP-Adresse nicht gefunden." });
  if (!guardEnvironment(req, res, reservation.environment_id)) return;

  try {
    const macAddress = parseMac(reservation.mac_address);
    const name = String(req.body?.name || "").trim().slice(0, 100);
    if (name) {
      db.db.prepare(`
        INSERT INTO ipam_device_names (environment_id, mac_address, name)
        VALUES (?, ?, ?)
        ON CONFLICT(environment_id, mac_address) DO UPDATE SET
          name = excluded.name, updated_at = datetime('now')
      `).run(reservation.environment_id, macAddress, name);
    } else {
      db.db.prepare(
        "DELETE FROM ipam_device_names WHERE environment_id = ? AND mac_address = ?",
      ).run(reservation.environment_id, macAddress);
    }
    db.auditLog.write(
      "ipam.device_name_update",
      `subnet=${reservation.cidr} address=${reservation.address} mac=${macAddress} name=${name || "removed"}`,
      req.ip,
      true,
      req.user?.username,
    );
    res.json({ mac_address: macAddress, device_name: name });
  } catch (error) {
    res.status(400).json({
      error: error.message || "Gerätename konnte nicht gespeichert werden.",
    });
  }
});

router.post(
  "/subnets/:id/reservations/range",
  guard("canEditNetworks"),
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
    const gateway = gatewayNumber(subnet);
    if (gateway !== null && gateway >= start && gateway <= end)
      return res.status(409).json({
        error: "Der Bereich enthält das konfigurierte Gateway.",
      });
    if (overlapsDelegatedPrefix(subnet, start, end))
      return res.status(409).json({
        error: "Der Bereich überschneidet sich mit einem delegierten Child-Prefix.",
      });
    if (overlapsEnvironmentAllocation(subnet.environment_id, subnet.id, start, end))
      return res.status(409).json({
        error: "Der Bereich überschneidet eine Belegung in einem anderen Prefix dieser Umgebung.",
      });
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

router.delete("/reservations/:id", guard("canEditNetworks"), (req, res) => {
  const reservation = db.db
    .prepare(
      `SELECT reservation.id, reservation.address, reservation.hostname, reservation.source_type, subnet.environment_id, subnet.cidr FROM ipam_reservations reservation JOIN ipam_subnets subnet ON subnet.id = reservation.subnet_id WHERE reservation.id = ?`,
    )
    .get(req.params.id);
  if (!reservation)
    return res.status(404).json({ error: "Reservierung nicht gefunden." });
  if (!guardEnvironment(req, res, reservation.environment_id)) return;
  if (reservation.source_type && reservation.source_type !== "manual")
    return res.status(409).json({
      error: "Synchronisierte Adressen können nur über ihre Quelle entfernt werden.",
    });
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

router.delete("/ranges/:id", guard("canEditNetworks"), (req, res) => {
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
// for DHCP state; Shipyard only mirrors it into matching, existing prefixes.
router.get("/sources", guard("canViewNetworks"), (req, res) => {
  const environmentId =
    req.environmentId || String(req.query.environment_id || "default").trim() || "default";
  if (!guardEnvironment(req, res, environmentId)) return;
  const rows = db.db
    .prepare(
      "SELECT * FROM ipam_sync_sources WHERE environment_id = ? ORDER BY name COLLATE NOCASE",
    )
    .all(environmentId);
  res.json(rows.map(sourceSummary));
});

router.post("/sources", guard("canEditNetworks"), (req, res) => {
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
        : "/api/v2/status/dhcp_server/leases";
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

router.put("/sources/:id", guard("canEditNetworks"), (req, res) => {
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

router.delete("/sources/:id", guard("canEditNetworks"), (req, res) => {
  const source = db.db
    .prepare("SELECT * FROM ipam_sync_sources WHERE id = ?")
    .get(req.params.id);
  if (!source) return res.status(404).json({ error: "Quelle nicht gefunden." });
  if (!guardEnvironment(req, res, source.environment_id)) return;
  const remove = db.db.transaction(() => {
    const affected = db.db
      .prepare(
        `SELECT DISTINCT reservation_id FROM ipam_source_observations
         WHERE source_id = ? AND reservation_id IS NOT NULL
         UNION SELECT id AS reservation_id FROM ipam_reservations WHERE source_ref LIKE ?`,
      )
      .all(source.id, `${source.id}:%`)
      .map((row) => row.reservation_id);
    db.db.prepare("DELETE FROM ipam_source_observations WHERE source_id = ?").run(source.id);
    let reservations = 0;
    for (const reservationId of affected)
      reservations += reconcileSourceReservation(reservationId, source.id);
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
// mapping before Shipyard creates, updates or releases any lease records.
router.post("/sources/:id/test", guard("canEditNetworks"), async (req, res) => {
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
      source.type,
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
        `UPDATE ipam_sync_sources SET
          last_tested_at = ?, last_test_status = 'success', last_test_error = '',
          last_record_count = ?, last_ignored_count = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(testedAt, records.length, records.length - matching.length, source.id);
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
          mac_address: record.mac || null,
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

function upsertSourceObservation(source, subnet, sourceRef, record, reservationId, now) {
  db.db
    .prepare(
      `INSERT INTO ipam_source_observations (
        id, environment_id, subnet_id, source_id, source_ref, reservation_id,
        address, hostname, mac_address, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, source_ref) DO UPDATE SET
        environment_id = excluded.environment_id,
        subnet_id = excluded.subnet_id,
        reservation_id = excluded.reservation_id,
        address = excluded.address,
        hostname = excluded.hostname,
        mac_address = excluded.mac_address,
        last_seen_at = excluded.last_seen_at`,
    )
    .run(
      db.uuidv4(),
      source.environment_id,
      subnet.id,
      source.id,
      sourceRef,
      reservationId || null,
      record.address,
      record.hostname.slice(0, 100),
      canonicalMac(record.mac),
      now,
    );
}

// If the source that originally created a canonical reservation disappears,
// hand ownership to another observation of the same machine. Delete the
// reservation only when no source still reports it.
function reconcileSourceReservation(reservationId, sourceId) {
  const reservation = db.db
    .prepare("SELECT id, source_ref FROM ipam_reservations WHERE id = ?")
    .get(reservationId);
  if (!reservation || !String(reservation.source_ref || "").startsWith(`${sourceId}:`))
    return 0;
  const replacement = db.db
    .prepare(
      `SELECT observation.source_ref, observation.last_seen_at, source.type
       FROM ipam_source_observations observation
       JOIN ipam_sync_sources source ON source.id = observation.source_id
       WHERE observation.reservation_id = ?
       ORDER BY observation.last_seen_at DESC LIMIT 1`,
    )
    .get(reservationId);
  if (replacement) {
    db.db
      .prepare(
        "UPDATE ipam_reservations SET source_type = ?, source_ref = ?, last_synced_at = ? WHERE id = ?",
      )
      .run(replacement.type, replacement.source_ref, replacement.last_seen_at, reservationId);
    return 0;
  }
  return db.db.prepare("DELETE FROM ipam_reservations WHERE id = ?").run(reservationId).changes;
}

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
      source.type,
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
        const priorObservation = db.db
          .prepare(
            `SELECT reservation_id, subnet_id, address
             FROM ipam_source_observations
             WHERE source_id = ? AND source_ref = ?`,
          )
          .get(source.id, sourceRef);
        const priorReservation = priorObservation?.reservation_id
          ? db.db
              .prepare("SELECT * FROM ipam_reservations WHERE id = ?")
              .get(priorObservation.reservation_id)
          : null;
        const observationMoved = Boolean(
          priorObservation &&
            (String(priorObservation.subnet_id) !== String(subnet.id) ||
              String(priorObservation.address) !== String(record.address)),
        );
        const reconcilePriorReservation = (nextReservationId = null) => {
          const priorReservationId = priorObservation?.reservation_id;
          if (
            priorReservationId &&
            String(priorReservationId) !== String(nextReservationId || "")
          )
            removed += reconcileSourceReservation(priorReservationId, source.id);
        };
        if (gatewayNumber(subnet) === ipv4(record.address)) {
          // A controller reporting the configured gateway confirms the
          // protected system allocation; it does not compete with it. Keep
          // the observation as provenance so the UI can show the gateway's
          // hostname, MAC and source without creating a normal reservation.
          upsertSourceObservation(source, subnet, sourceRef, record, null, now);
          reconcilePriorReservation();
          updated += 1;
          continue;
        }
        // Keep an owned canonical reservation when the source reports that
        // same object at a new address: it can be moved in place below. A
        // shared reservation owned by another source must instead be detached,
        // otherwise the new observation would remain linked to the old IP.
        const existing = priorReservation &&
          (!observationMoved || String(priorReservation.source_ref || "").startsWith(`${source.id}:`))
          ? priorReservation
          : db.db
              .prepare("SELECT * FROM ipam_reservations WHERE source_type = ? AND source_ref = ?")
              .get(source.type, sourceRef);
        const collision = db.db
          .prepare(
            "SELECT id, hostname, mac_address, source_type FROM ipam_reservations WHERE subnet_id = ? AND address = ? AND id != ?",
          )
          .get(subnet.id, record.address, existing?.id || "");
        if (collision) {
          if (
            sameMachine(record, collision) ||
            canEnrichAutomatedMachine(record, collision)
          ) {
            upsertSourceObservation(source, subnet, sourceRef, record, collision.id, now);
            reconcilePriorReservation(collision.id);
            db.db
              .prepare(
                `UPDATE ipam_reservations SET
                  hostname = CASE WHEN hostname = '' THEN ? ELSE hostname END,
                  mac_address = CASE WHEN mac_address = '' THEN ? ELSE mac_address END,
                  last_synced_at = ? WHERE id = ?`,
              )
              .run(
                record.hostname.slice(0, 100),
                canonicalMac(record.mac),
                now,
                collision.id,
              );
            updated += 1;
            continue;
          }
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
              canonicalMac(record.mac),
              `Adresse ist bereits ${collision.source_type === "manual" ? "manuell" : "aus einer anderen Quelle"} reserviert${collision.hostname ? ` (${collision.hostname})` : ""}`,
              collision.id,
              now,
            );
          upsertSourceObservation(source, subnet, sourceRef, record, null, now);
          reconcilePriorReservation();
          conflicts += 1;
          continue;
        }
        if (existing) {
          const ownedBySource = String(existing.source_ref || "").startsWith(`${source.id}:`);
          if (ownedBySource)
            db.db
              .prepare(
                `UPDATE ipam_reservations SET subnet_id = ?, address = ?, hostname = ?, mac_address = ?, status = 'active', description = ?, last_synced_at = ? WHERE id = ?`,
              )
              .run(
                subnet.id,
                record.address,
                record.hostname.slice(0, 100),
                canonicalMac(record.mac),
                record.description.slice(0, 500),
                now,
                existing.id,
              );
          else
            db.db
              .prepare(
                `UPDATE ipam_reservations SET
                  hostname = CASE WHEN hostname = '' THEN ? ELSE hostname END,
                  mac_address = CASE WHEN mac_address = '' THEN ? ELSE mac_address END,
                  last_synced_at = ? WHERE id = ?`,
              )
              .run(record.hostname.slice(0, 100), canonicalMac(record.mac), now, existing.id);
          upsertSourceObservation(source, subnet, sourceRef, record, existing.id, now);
          reconcilePriorReservation(existing.id);
          updated += 1;
        } else {
          const reservationId = db.uuidv4();
          db.db
            .prepare(
              `INSERT INTO ipam_reservations (id, subnet_id, address, hostname, mac_address, status, description, source_type, source_ref, last_synced_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
            )
            .run(
              reservationId,
              subnet.id,
              record.address,
              record.hostname.slice(0, 100),
              canonicalMac(record.mac),
              record.description.slice(0, 500),
              source.type,
              sourceRef,
              now,
            );
          upsertSourceObservation(source, subnet, sourceRef, record, reservationId, now);
          reconcilePriorReservation(reservationId);
          created += 1;
        }
      }
      // A source sync is a complete current observation (DHCP leases or
      // controller clients).  Leaving vanished entries behind makes an IPAM
      // look occupied forever. Delete only reservations owned by this exact
      // source; manual, Proxmox and other controller records are untouched.
      const previous = db.db
        .prepare(
          "SELECT id, source_ref, reservation_id FROM ipam_source_observations WHERE source_id = ?",
        )
        .all(source.id);
      const deleteObservation = db.db.prepare("DELETE FROM ipam_source_observations WHERE id = ?");
      for (const observation of previous) {
        if (!seenSourceRefs.has(String(observation.source_ref || ""))) {
          deleteObservation.run(observation.id);
          if (observation.reservation_id)
            removed += reconcileSourceReservation(observation.reservation_id, source.id);
        }
      }
      db.db
        .prepare(
          `UPDATE ipam_sync_sources SET
            last_synced_at = ?, last_status = 'success', last_error = '',
            last_tested_at = ?, last_test_status = 'success', last_test_error = '',
            last_record_count = ?, last_ignored_count = ?,
            updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(now, now, records.length, ignored, source.id);
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

router.post("/sources/:id/sync", guard("canEditNetworks"), async (req, res) => {
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
