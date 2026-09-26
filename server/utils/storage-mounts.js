const STORAGE_MOUNT_PATH_RE = /^\/[A-Za-z0-9._/-]{0,254}$/;

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\u0000/gi, '\n')
    .replace(/\\0/g, '\n')
    .replace(/\u0000/g, '\n')
    .replace(/\uFFFD/g, '\n');
}

function isValidStorageMountPath(path) {
  return typeof path === 'string'
    && STORAGE_MOUNT_PATH_RE.test(path)
    && !path.includes('..');
}

function parseArrayInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseConfiguredStorageMounts(value) {
  const items = parseArrayInput(value);
  const mounts = [];
  const seenPaths = new Set();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const path = String(item.path || '').trim();
    if (!isValidStorageMountPath(path) || seenPaths.has(path)) continue;
    seenPaths.add(path);
    mounts.push({
      name: String(item.name || path).trim().slice(0, 100) || path,
      path,
    });
  }

  return mounts;
}

const NETWORK_FS_TYPES = ['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs', 'glusterfs', 'ceph', 'fuse.ceph', '9p', 'virtiofs', 'fuse.rclone', 'fuse.mergerfs'];
const DETECT_NETWORK_MOUNTS_CMD = `findmnt -rn -t ${NETWORK_FS_TYPES.join(',')} -o TARGET,SOURCE,FSTYPE 2>/dev/null`;

// findmnt escapes spaces and special characters as \xNN in raw output.
function unescapeFindmnt(value) {
  return String(value || '').replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Network shares mounted on the host, as candidates for storage monitoring. */
function parseDetectedMounts(output) {
  const mounts = [];
  const seen = new Set();
  for (const line of normalizeText(output).split('\n')) {
    const [target, source, fstype] = line.trim().split(/\s+/).map(unescapeFindmnt);
    if (!target || !source || !isValidStorageMountPath(target) || seen.has(target)) continue;
    seen.add(target);
    const share = source.replace(/\/+$/, '').split(/[/:]/).filter(Boolean).pop() || target;
    mounts.push({ name: `${share} (${String(fstype || '').replace(/^fuse\./, '').toUpperCase()})`.slice(0, 100), path: target, source: source.slice(0, 255), fstype: String(fstype || '').slice(0, 32) });
  }
  return mounts.slice(0, 50);
}

function parseSizeTokenToGb(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;

  if (raw.endsWith('G')) {
    const num = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(num) ? Math.round(num * 10) / 10 : null;
  }

  if (raw.endsWith('M')) {
    const num = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(num) ? Math.round((num / 1024) * 10) / 10 : null;
  }

  const plain = Number.parseFloat(raw);
  return Number.isFinite(plain) ? Math.round((plain / 1024) * 10) / 10 : null;
}

function parseDfRows(text) {
  const lines = normalizeText(text).split('\n').map(line => line.trim()).filter(Boolean);
  return lines.filter(line => !line.startsWith('Filesystem ')).map((line) => {
    const cols = line.split(/\s+/);
    if (cols.length < 6) return null;

    const filesystem = cols[0];
    const totalRaw = cols[1];
    const usedRaw = cols[2];
    const availableRaw = cols[3];
    const pctRaw = cols[4];
    const path = cols.slice(5).join(' ');
    const usagePct = Number.parseInt(String(pctRaw, 10).replace('%', ''), 10);

    return {
      filesystem,
      path,
      total_gb: parseSizeTokenToGb(totalRaw),
      used_gb: parseSizeTokenToGb(usedRaw),
      available_gb: parseSizeTokenToGb(availableRaw),
      usage_pct: Number.isFinite(usagePct) ? usagePct : null,
    };
  }).filter(Boolean);
}

// df reports the mount point, not the path it was asked about, so a registered
// subdirectory never matched. Each df call is therefore preceded by a marker
// line naming the configured path it measures.
const MOUNT_MARKER = '__FLEET_MOUNT__';

function dfRowsByTarget(dfOutput) {
  const byTarget = new Map();
  let target = null;
  let block = [];
  const flush = () => { if (target !== null) { // The data row follows the (possibly localised) header; take the last one.
      const row = parseDfRows(block.join('\n')).filter(item => item.total_gb !== null).pop(); if (row) byTarget.set(target, row); } };
  for (const line of normalizeText(dfOutput).split('\n')) {
    if (line.startsWith(MOUNT_MARKER)) { flush(); target = line.slice(MOUNT_MARKER.length).trim(); block = []; }
    else block.push(line);
  }
  flush();
  return byTarget;
}

function collectStorageMountMetrics(configuredMounts, dfOutput) {
  const mounts = parseConfiguredStorageMounts(configuredMounts);
  if (mounts.length === 0) return [];

  const marked = normalizeText(dfOutput).includes(MOUNT_MARKER);
  const rowsByPath = marked ? dfRowsByTarget(dfOutput) : new Map(parseDfRows(dfOutput).map(row => [row.path, row]));
  return mounts.map((mount) => {
    const row = rowsByPath.get(mount.path);
    return {
      name: mount.name,
      path: mount.path,
      filesystem: row?.filesystem || null,
      total_gb: row?.total_gb ?? null,
      used_gb: row?.used_gb ?? null,
      available_gb: row?.available_gb ?? null,
      usage_pct: row?.usage_pct ?? null,
      mounted: !!row,
    };
  });
}

module.exports = {
  MOUNT_MARKER,
  collectStorageMountMetrics,
  isValidStorageMountPath,
  normalizeText,
  parseConfiguredStorageMounts,
  parseDfRows,
  DETECT_NETWORK_MOUNTS_CMD,
  parseDetectedMounts,
};
