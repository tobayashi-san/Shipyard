const db = require('../db');
const log = require('../utils/logger').child('resource-alerts');
const { notify } = require('./notifier');

let broadcast = () => {};

function setBroadcast(fn) {
  broadcast = typeof fn === 'function' ? fn : broadcast;
}

function parseDateMs(value) {
  if (!value) return 0;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function pct(used, total) {
  if (!Number.isFinite(Number(used)) || !Number.isFinite(Number(total)) || Number(total) <= 0) return null;
  return Math.round((Number(used) / Number(total)) * 100);
}

function activeKey(alert) {
  return `${alert.type}:${alert.targetKey || ''}`;
}

function pushThresholdAlert(out, { type, targetKey = '', value, threshold, message, meta = {} }) {
  if (value == null || threshold == null) return;
  if (Number(value) >= Number(threshold)) {
    out.push({ type, targetKey, severity: 'warning', value: Number(value), threshold: Number(threshold), message, meta });
  }
}

function collectDesiredAlerts(server, info, settings) {
  const alerts = [];
  const thresholds = settings.thresholds || {};
  const serverName = server?.name || 'Server';

  if (server?.status === 'offline' || server?.status === 'error') {
    alerts.push({
      type: 'server_offline',
      targetKey: '',
      severity: 'critical',
      value: null,
      threshold: null,
      message: `${serverName} is offline`,
      meta: { status: server.status },
    });
  }

  if (info?.reboot_required) {
    alerts.push({
      type: 'reboot_required',
      targetKey: '',
      severity: 'warning',
      value: null,
      threshold: null,
      message: `${serverName} requires a reboot`,
      meta: {},
    });
  }

  const cpuPct = info?.cpu_usage_pct == null ? null : Math.round(Number(info.cpu_usage_pct));
  pushThresholdAlert(alerts, {
    type: 'cpu',
    value: cpuPct,
    threshold: thresholds.cpu,
    message: `${serverName} CPU usage is ${cpuPct}%`,
  });

  const ramPct = pct(info?.ram_used_mb, info?.ram_total_mb);
  pushThresholdAlert(alerts, {
    type: 'ram',
    value: ramPct,
    threshold: thresholds.ram,
    message: `${serverName} RAM usage is ${ramPct}%`,
  });

  const diskPct = pct(info?.disk_used_gb, info?.disk_total_gb);
  pushThresholdAlert(alerts, {
    type: 'disk',
    value: diskPct,
    threshold: thresholds.disk,
    message: `${serverName} disk usage is ${diskPct}%`,
  });

  for (const mount of info?.storage_mount_metrics || []) {
    const usage = mount?.usage_pct == null ? pct(mount?.used_gb, mount?.total_gb) : Math.round(Number(mount.usage_pct));
    const label = mount?.name || mount?.path || 'storage mount';
    pushThresholdAlert(alerts, {
      type: 'storage',
      targetKey: String(mount?.path || label),
      value: usage,
      threshold: thresholds.storage,
      message: `${serverName} storage ${label} is ${usage}% full`,
      meta: { name: mount?.name || '', path: mount?.path || '', filesystem: mount?.filesystem || '' },
    });
  }

  for (const pool of info?.zfs_pools || []) {
    if (!pool?.name || String(pool.health || '').toUpperCase() === 'ONLINE') continue;
    alerts.push({
      type: 'zfs',
      targetKey: String(pool.name),
      severity: 'critical',
      value: null,
      threshold: null,
      message: `${serverName} ZFS pool ${pool.name} is ${pool.health || 'not healthy'}`,
      meta: { name: pool.name, health: pool.health || '' },
    });
  }

  return alerts;
}

function emitUpdate(type, alert) {
  try {
    broadcast({ type, alert, serverId: alert.server_id });
  } catch {}
}

function emitAlertUpdated(alert) {
  emitUpdate('resource_alert_updated', alert);
}

function maybeNotify(alert, settings) {
  if (alert.status !== 'active') return;
  if (alert.notification_sent_at) return;
  if (settings.notify_enabled === false) return;
  if (db.settings.get('notify_resource_alerts') === '0') return;

  db.resourceAlerts.markNotificationSent(alert.id);
  notify(`Monitoring: ${alert.server_name || alert.server_id}`, alert.message, alert.severity !== 'critical').catch((err) => {
    log.debug({ err, alertId: alert.id }, 'Monitoring notification failed');
  });
}

function evaluateServer(serverId) {
  const server = db.servers.getById(serverId);
  if (!server) return [];

  const settings = db.alertSettings.getByServer(serverId);
  const desired = settings.enabled === false ? [] : collectDesiredAlerts(server, db.serverInfo.get(serverId) || {}, settings);
  const desiredKeys = new Set(desired.map(activeKey));
  const changed = [];
  const triggerAfterMs = Math.max(0, Number(settings.trigger_after_seconds || 0) * 1000);
  const now = Date.now();

  for (const desiredAlert of desired) {
    let alert = db.resourceAlerts.getOpenByKey(serverId, desiredAlert.type, desiredAlert.targetKey || '');
    if (!alert) {
      alert = db.resourceAlerts.createPending({ serverId, ...desiredAlert });
      changed.push(alert);
      emitUpdate('resource_alert_updated', alert);
    } else {
      alert = db.resourceAlerts.updateSeen(alert.id, desiredAlert);
    }

    if (alert.status === 'pending' && now - parseDateMs(alert.first_seen_at) >= triggerAfterMs) {
      alert = db.resourceAlerts.activate(alert.id);
      changed.push(alert);
      emitUpdate('resource_alert_triggered', alert);
      maybeNotify(alert, settings);
    } else if (alert.status === 'active') {
      maybeNotify(alert, settings);
    }
  }

  for (const alert of db.resourceAlerts.resolveMissingForServer(serverId, desiredKeys)) {
    changed.push(alert);
    emitUpdate('resource_alert_updated', alert);
  }

  return changed;
}

function evaluateServers(serverIds) {
  const changed = [];
  for (const serverId of serverIds) {
    try {
      changed.push(...evaluateServer(serverId));
    } catch (err) {
      log.debug({ err, serverId }, 'Alert evaluation failed');
    }
  }
  return changed;
}

function evaluateAll() {
  return evaluateServers(db.servers.getAll().map(server => server.id));
}

module.exports = {
  setBroadcast,
  evaluateServer,
  evaluateServers,
  evaluateAll,
  collectDesiredAlerts,
  emitAlertUpdated,
};
