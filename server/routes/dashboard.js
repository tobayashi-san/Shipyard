const express = require('express');
const db = require('../db');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    const servers = filterServers(db.servers.getAll(), perms);
    const online = servers.filter(s => s.status === 'online').length;
    const offline = servers.filter(s => s.status === 'offline').length;

    let rebootRequired = 0;
    let totalUpdates = 0;
    let criticalDisk = 0;
    let criticalRam = 0;

    const serverStats = servers.map(s => {
      const info = db.serverInfo.get(s.id);
      const updates = db.updatesCache.get(s.id) || [];
      const containers = db.dockerContainers.getByServer(s.id);
      const imageUpdatesMeta = db.dockerImageUpdatesCache.getWithMeta(s.id);
      const imageUpdates = imageUpdatesMeta ? imageUpdatesMeta.results : null;
      const agentCfg = db.agentConfig.getByServerId(s.id);

      if (info?.reboot_required) rebootRequired++;
      totalUpdates += updates.filter(u => !u.phased).length;

      const isOnline = s.status === 'online';
      const ramPct = (isOnline && info?.ram_total_mb) ? Math.round((info.ram_used_mb / info.ram_total_mb) * 100) : null;
      const diskPct = (isOnline && info?.disk_total_gb) ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : null;
      if (ramPct > 85) criticalRam++;
      if (diskPct > 85) criticalDisk++;

      let agentMode = 'legacy';
      let agentState = 'legacy';
      let agentLastSeen = null;
      if (agentCfg && agentCfg.mode && agentCfg.mode !== 'legacy') {
        agentMode = agentCfg.mode;
        agentLastSeen = agentCfg.last_seen || null;
        const intervalSec = Math.max(5, parseInt(agentCfg.interval, 10) || 30);
        const seenMs = agentCfg.last_seen ? new Date(agentCfg.last_seen).getTime() : 0;
        if (!seenMs) {
          agentState = 'failed';
        } else {
          const ageMs = Date.now() - seenMs;
          if (ageMs <= intervalSec * 3 * 1000) agentState = 'ok';
          else if (ageMs <= intervalSec * 10 * 1000) agentState = 'warning';
          else agentState = 'failed';
        }
      }

      return {
        id: s.id,
        name: s.name,
        ip_address: s.ip_address,
        tags: JSON.parse(s.tags || '[]'),
        status: s.status,
        last_seen: s.last_seen,
        os: info?.os || null,
        uptime_seconds: isOnline ? (info?.uptime_seconds || null) : null,
        ram_pct: ramPct,
        disk_pct: diskPct,
        cpu_pct: isOnline ? (info?.cpu_usage_pct ?? null) : null,
        load_avg: isOnline ? (info?.load_avg || null) : null,
        reboot_required: !!info?.reboot_required,
        updates_count: updates.filter(u => !u.phased).length,
        containers_running: containers.filter(c => c.state === 'running').length,
        containers_total: containers.length,
        image_updates_count: imageUpdates === null ? null : imageUpdates.filter(r => r.status === 'update_available').length,
        image_updates_checked_at: imageUpdatesMeta?.updated_at || null,
        custom_updates_count: db.customUpdateTasks.countHasUpdate(s.id),
        info_cached_at: info?.updated_at || null,
        agent_mode: agentMode,
        agent_state: agentState,
        agent_last_seen: agentLastSeen,
      };
    });

    const allRecentHistory = db.db.prepare(`
      SELECT h.*, s.name as server_name
      FROM update_history h
      LEFT JOIN servers s ON h.server_id = s.id
      ORDER BY h.started_at DESC LIMIT 500
    `).all();

    const isServerRestricted = perms && !perms.full && perms.servers !== 'all' && perms.servers != null;
    const allowedServerIds = new Set(servers.map(s => s.id));
    const allowedServerNames = new Set(servers.map(s => s.name));

    const recentHistory = allRecentHistory.filter(h => {
      if (allowedServerIds.has(h.server_id)) return true;
      if (allowedServerNames.has(h.server_id)) return true;
      if (!isServerRestricted) return true;
      return false;
    }).slice(0, 8);

    res.json({
      summary: { total: servers.length, online, offline, unknown: servers.length - online - offline, rebootRequired, totalUpdates, criticalDisk, criticalRam },
      servers: serverStats,
      recentHistory,
    });
  } catch (e) {
    serverError(res, e, 'dashboard stats');
  }
});

module.exports = router;
