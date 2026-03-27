const db = require('../db');
const log = require('../utils/logger').child('agent:processor');

function parseKeyValueLines(text) {
  const out = {};
  String(text || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
  });
  return out;
}

function parseMeminfo(text) {
  const map = {};
  String(text || '').split('\n').forEach((line) => {
    const m = line.match(/^([A-Za-z_]+):\s+(\d+)/);
    if (m) map[m[1]] = parseInt(m[2], 10);
  });
  const totalKb = map.MemTotal || 0;
  const availKb = map.MemAvailable || map.MemFree || 0;
  const usedKb = Math.max(0, totalKb - availKb);
  return {
    ram_total_mb: Math.round(totalKb / 1024),
    ram_used_mb: Math.round(usedKb / 1024),
  };
}

function parseDfTotals(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
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

function toServerInfo(report) {
  const collectors = collectorMap(report);
  const mem = parseMeminfo(collectors.get('memory')?.output || '');
  const disk = parseDfTotals(collectors.get('disk')?.output || '');
  const osInfo = parseKeyValueLines(collectors.get('os_info')?.output || '');
  const uptimeVal = Number.parseFloat((collectors.get('uptime')?.output || '').trim());
  const cores = Number.parseInt((collectors.get('nproc')?.output || '').trim(), 10);

  let loadAvg = null;
  const loadRaw = (collectors.get('load')?.output || '').trim();
  if (loadRaw) {
    const parts = loadRaw.split(/\s+/);
    if (parts.length >= 3) loadAvg = `${parts[0]} ${parts[1]} ${parts[2]}`;
  }

  return {
    os: osInfo.PRETTY_NAME || osInfo.NAME || null,
    kernel: null,
    cpu: null,
    cpu_cores: Number.isFinite(cores) ? cores : null,
    ram_total_mb: mem.ram_total_mb,
    ram_used_mb: mem.ram_used_mb,
    disk_total_gb: disk.disk_total_gb,
    disk_used_gb: disk.disk_used_gb,
    uptime_seconds: Number.isFinite(uptimeVal) ? Math.floor(uptimeVal) : null,
    load_avg: loadAvg,
    reboot_required: false,
    cpu_usage_pct: null,
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

  const info = toServerInfo(report);
  db.serverInfo.upsert(serverId, info);
  db.servers.updateStatus(serverId, 'online');
  db.agentConfig.setSeen(serverId, report.runner_version || null, manifestVersion);

  log.debug({ serverId, source, manifestVersion }, 'Agent report processed');
  return { ok: true };
}

module.exports = { processIncomingReport, toServerInfo };
