const express = require('express');
const db = require('../db');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');
const { authenticatedApiLimiter } = require('../utils/rate-limiters');
const { buildServerAttention } = require('../utils/server-attention');

const router = express.Router();

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get('/', authenticatedApiLimiter, (req, res) => {
  try {
    const perms = getPermissions(req.user);
    if (!can(perms, 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    const environmentId = req.environmentId || 'default';
    const servers = filterServers(db.servers.getAll(environmentId), perms);
    const canViewUpdates = can(perms, 'canViewUpdates');
    const canViewDocker = can(perms, 'canViewDocker');
    const canViewCustomUpdates = can(perms, 'canViewCustomUpdates');
    const agentEnabled = db.settings.get('agent_enabled') === '1';
    const canViewHistory = canViewUpdates || can(perms, 'canViewSchedules') || can(perms, 'canViewAudit');
    const visibleServerIds = servers.map(server => server.id);
    const visibleAlerts = db.resourceAlerts.list({
      statuses: ['active'],
      serverIds: visibleServerIds,
      limit: 500,
    });
    const online = servers.filter(s => s.status === 'online').length;
    const offline = servers.filter(s => s.status === 'offline').length;

    let rebootRequired = 0;
    let totalUpdates = 0;

    const serverStats = servers.map(s => {
      const info = db.serverInfo.get(s.id);
      const updates = canViewUpdates ? (db.updatesCache.get(s.id) || []) : [];
      const containers = canViewDocker ? db.dockerContainers.getByServer(s.id) : [];
      const imageUpdatesMeta = canViewDocker && canViewUpdates ? db.dockerImageUpdatesCache.getWithMeta(s.id) : null;
      const imageUpdates = imageUpdatesMeta ? imageUpdatesMeta.results : null;
      const agentCfg = agentEnabled ? db.agentConfig.getByServerId(s.id) : null;
      const history = canViewHistory ? db.updateHistory.getByServer(s.id) : [];
      const alerts = visibleAlerts.filter(alert => String(alert.server_id) === String(s.id));

      if (canViewUpdates && info?.reboot_required) rebootRequired++;
      if (canViewUpdates) totalUpdates += updates.filter(u => !u.phased).length;

      const isOnline = s.status === 'online';
      const ramPct = (isOnline && info?.ram_total_mb) ? Math.round((info.ram_used_mb / info.ram_total_mb) * 100) : null;
      const diskPct = (isOnline && info?.disk_total_gb) ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : null;

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

      // A dashboard must be able to show why a custom desired state differs,
      // but never expose executable commands through this aggregate endpoint.
      // The task editor remains the only place that returns those fields.
      const customUpdateTasks = canViewCustomUpdates
        ? db.customUpdateTasks.getByServer(s.id).map(task => ({
          id: task.id,
          name: task.name,
          type: task.type,
          current_version: task.current_version,
          last_version: task.last_version,
          trigger_output: task.trigger_output,
          has_update: !!task.has_update,
          last_checked_at: task.last_checked_at,
        }))
        : undefined;

      const customUpdatesCount = canViewCustomUpdates ? db.customUpdateTasks.countHasUpdate(s.id) : 0;
      const attention = buildServerAttention({
        server: s,
        info,
        updates,
        imageUpdates,
        customUpdatesCount,
        history,
        alerts,
        includeUpdates: canViewUpdates,
        includeDockerUpdates: canViewDocker && canViewUpdates,
        includeCustomUpdates: canViewCustomUpdates,
        includeHistory: canViewHistory,
      });

      return {
        id: s.id,
        name: s.name,
        ip_address: s.ip_address,
        tags: JSON.parse(s.tags || '[]'),
        links: parseJsonArray(s.links),
        status: s.status,
        last_seen: s.last_seen,
        os: info?.os || null,
        uptime_seconds: isOnline ? (info?.uptime_seconds || null) : null,
        ram_pct: ramPct,
        disk_pct: diskPct,
        cpu_pct: isOnline ? (info?.cpu_usage_pct ?? null) : null,
        load_avg: isOnline ? (info?.load_avg || null) : null,
        ...(canViewUpdates ? {
          reboot_required: !!info?.reboot_required,
          updates_count: updates.filter(u => !u.phased).length,
        } : {}),
        ...(canViewDocker ? {
          containers_running: containers.filter(c => c.state === 'running').length,
          containers_total: containers.length,
        } : {}),
        ...(canViewDocker && canViewUpdates ? {
          image_updates_count: imageUpdates === null ? null : imageUpdates.filter(r => r.status === 'update_available').length,
          image_updates_checked_at: imageUpdatesMeta?.updated_at || null,
        } : {}),
        ...(canViewCustomUpdates ? { custom_updates_count: customUpdatesCount } : {}),
        ...(customUpdateTasks ? { custom_update_tasks: customUpdateTasks } : {}),
        info_cached_at: info?.updated_at || null,
        agent_mode: agentMode,
        agent_state: agentState,
        agent_last_seen: agentLastSeen,
        attention,
      };
    });

    const allRecentHistory = canViewHistory ? db.db.prepare(`
      SELECT h.*, s.name as server_name
      FROM update_history h
      LEFT JOIN servers s ON h.server_id = s.id
      WHERE h.environment_id = ?
      ORDER BY h.started_at DESC LIMIT 500
    `).all(environmentId) : [];

    const isServerRestricted = perms && !perms.full && perms.servers !== 'all' && perms.servers != null;
    const allowedServerIds = new Set(servers.map(s => s.id));
    const allowedServerNames = new Set(servers.map(s => s.name));

    const recentHistory = allRecentHistory.filter(h => {
      if (allowedServerIds.has(h.server_id)) return true;
      if (allowedServerNames.has(h.server_id)) return true;
      if (!isServerRestricted) return true;
      return false;
    }).map(h => ({
      ...h,
      server_name: h.server_name || (h.server_id === 'bulk_update' ? 'Bulk Update' : h.server_id),
    })).slice(0, 8);
    const failedOperations = allRecentHistory.filter(h => {
      if (h.status !== 'failed') return false;
      if (allowedServerIds.has(h.server_id) || allowedServerNames.has(h.server_id)) return true;
      return !isServerRestricted;
    }).length;

    res.json({
      summary: { total: servers.length, online, offline, unknown: servers.length - online - offline, rebootRequired, totalUpdates, failedOperations },
      servers: serverStats,
      alerts: visibleAlerts,
      agentEnabled,
      recentHistory,
    });
  } catch (e) {
    serverError(res, e, 'dashboard stats');
  }
});

module.exports = router;
