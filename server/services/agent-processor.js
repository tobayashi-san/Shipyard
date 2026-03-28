const db = require('../db');
const log = require('../utils/logger').child('agent:processor');

function normalizeCollectorOutput(text) {
  // Some runner environments can emit NUL-separated lines.
  // Normalize to plain newlines so parsers remain stable.
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '\n');
}

function parseKeyValueLines(text) {
  const out = {};
  normalizeCollectorOutput(text).split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
  });
  return out;
}

function parseMeminfo(text) {
  const map = {};
  normalizeCollectorOutput(text).split('\n').forEach((line) => {
    const m = line.match(/^([A-Za-z_]+):\s+(\d+)/);
    if (m) map[m[1]] = parseInt(m[2], 10);
  });
  const totalKb = map.MemTotal || 0;
  // Fallback for systems where MemAvailable is absent or parsing was partial.
  const availFallback = (map.MemFree || 0) + (map.Buffers || 0) + (map.Cached || 0) + (map.SReclaimable || 0);
  const availKb = map.MemAvailable || availFallback || map.MemFree || 0;
  const usedKb = Math.max(0, totalKb - availKb);
  return {
    ram_total_mb: Math.round(totalKb / 1024),
    ram_used_mb: Math.round(usedKb / 1024),
  };
}

function parseDfTotals(text) {
  const lines = normalizeCollectorOutput(text).split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return { disk_total_gb: null, disk_used_gb: null };
  let totalMb = 0;
  let usedMb = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;
    const total = parseInt(String(cols[1]).replace(/M$/, ''), 10);
    const used = parseInt(String(cols[2]).replace(/M$/, ''), 10);
    if (Number.isFinite(total)) totalMb += total;
    if (Number.isFinite(used)) usedMb += used;
  }
  return {
    disk_total_gb: totalMb > 0 ? Math.round((totalMb / 1024) * 10) / 10 : null,
    disk_used_gb: usedMb > 0 ? Math.round((usedMb / 1024) * 10) / 10 : null,
  };
}

function collectorMap(report) {
  const map = new Map();
  const collectors = Array.isArray(report.collectors) ? report.collectors : [];
  for (const c of collectors) {
    if (!c || typeof c.id !== 'string') continue;
    map.set(c.id, c);
  }
  return map;
}

function parseCpuStatLine(text) {
  const line = normalizeCollectorOutput(text).split('\n').find((l) => l.trim().startsWith('cpu ')) || '';
  const clean = line.trim();
  if (!clean) return null;
  const parts = clean.split(/\s+/);
  if (parts[0] !== 'cpu' || parts.length < 5) return null;
  const nums = parts.slice(1).map(n => Number.parseInt(n, 10));
  if (nums.some(n => !Number.isFinite(n))) return null;
  return nums;
}

function computeCpuPct(prevText, currText) {
  const prev = parseCpuStatLine(prevText);
  const curr = parseCpuStatLine(currText);
  if (!prev || !curr || prev.length !== curr.length) return null;

  const totalPrev = prev.reduce((a, b) => a + b, 0);
  const totalCurr = curr.reduce((a, b) => a + b, 0);
  const idlePrev = (prev[3] || 0) + (prev[4] || 0);
  const idleCurr = (curr[3] || 0) + (curr[4] || 0);

  const totalDelta = totalCurr - totalPrev;
  const idleDelta = idleCurr - idlePrev;
  if (totalDelta <= 0) return null;

  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

function getPreviousCollectorOutput(serverId, collectorId) {
  const recent = db.agentMetrics.recentByServer(serverId, 2);
  if (recent.length < 2) return null;
  try {
    const prev = JSON.parse(recent[1].data);
    const collectors = collectorMap(prev);
    return collectors.get(collectorId)?.output || null;
  } catch {
    return null;
  }
}

function toServerInfo(serverId, report) {
  const collectors = collectorMap(report);
  const existing = db.serverInfo.get(serverId) || {};
  const mem = parseMeminfo(collectors.get('memory')?.output || '');
  const disk = parseDfTotals(collectors.get('disk')?.output || '');
  const osInfo = parseKeyValueLines(collectors.get('os_info')?.output || '');
  const uptimeVal = Number.parseFloat(normalizeCollectorOutput(collectors.get('uptime')?.output || '').trim());
  const cores = Number.parseInt(normalizeCollectorOutput(collectors.get('nproc')?.output || '').trim(), 10);
  const prevCpu = getPreviousCollectorOutput(serverId, 'cpu');
  const cpuPct = computeCpuPct(prevCpu, collectors.get('cpu')?.output || '');

  let loadAvg = null;
  const loadRaw = normalizeCollectorOutput(collectors.get('load')?.output || '').trim();
  if (loadRaw) {
    const parts = loadRaw.split(/\s+/);
    if (parts.length >= 3) loadAvg = `${parts[0]} ${parts[1]} ${parts[2]}`;
  }

  return {
    os: osInfo.PRETTY_NAME || osInfo.NAME || existing.os || null,
    kernel: existing.kernel || null,
    cpu: existing.cpu || null,
    cpu_cores: Number.isFinite(cores) ? cores : (existing.cpu_cores ?? null),
    ram_total_mb: mem.ram_total_mb || existing.ram_total_mb || null,
    ram_used_mb: Number.isFinite(mem.ram_used_mb) ? mem.ram_used_mb : (existing.ram_used_mb ?? null),
    disk_total_gb: disk.disk_total_gb || existing.disk_total_gb || null,
    disk_used_gb: Number.isFinite(disk.disk_used_gb) ? disk.disk_used_gb : (existing.disk_used_gb ?? null),
    uptime_seconds: Number.isFinite(uptimeVal) ? Math.floor(uptimeVal) : (existing.uptime_seconds ?? null),
    load_avg: loadAvg || existing.load_avg || null,
    reboot_required: existing.reboot_required || false,
    cpu_usage_pct: cpuPct ?? existing.cpu_usage_pct ?? null,
  };
}

function processIncomingReport({ serverId, report, source = 'push' }) {
  if (!serverId) throw new Error('serverId is required');
  if (!report || typeof report !== 'object') throw new Error('report must be an object');

  const ts = Number.isFinite(report.timestamp) ? report.timestamp : Math.floor(Date.now() / 1000);
  const manifestVersion = Number.isInteger(report.manifest_version) ? report.manifest_version : null;

  db.agentMetrics.insert({
    serverId,
    timestamp: ts,
    manifestVersion,
    data: JSON.stringify(report),
  });

  const info = toServerInfo(serverId, report);
  db.serverInfo.upsert(serverId, info);
  db.servers.updateStatus(serverId, 'online');
  db.agentConfig.setSeen(serverId, report.runner_version || null, manifestVersion);

  log.debug({ serverId, source, manifestVersion }, 'Agent report processed');
  return { ok: true };
}

module.exports = { processIncomingReport, toServerInfo };
