'use strict';

const RESOURCE_WARNING_THRESHOLDS = Object.freeze({
  cpu: 90,
  ram: 85,
  disk: 85,
  storage: 85,
});
const RESOURCE_CRITICAL_THRESHOLD = 95;

function percent(used, total) {
  const usedNumber = Number(used);
  const totalNumber = Number(total);
  if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0) return null;
  return Math.round((usedNumber / totalNumber) * 100);
}

function resourceSeverity(value) {
  return value >= RESOURCE_CRITICAL_THRESHOLD ? 'critical' : 'warning';
}

/**
 * Build the canonical, presentation-neutral attention state for a host.
 * Callers decide which inputs a user is allowed to see before invoking this
 * helper, so restricted roles never learn about update or audit metadata.
 */
function buildServerAttention({
  server,
  info,
  updates = [],
  imageUpdates = null,
  customUpdatesCount = 0,
  history = [],
  alerts = [],
  includeUpdates = false,
  includeDockerUpdates = false,
  includeCustomUpdates = false,
  includeHistory = false,
} = {}) {
  const reasons = [];

  if (server?.status === 'offline') {
    reasons.push({ code: 'offline', severity: 'critical', count: 1 });
  }

  // Resource health belongs to the canonical attention state rather than a
  // page-local colour rule. This keeps the host overview, host filters and
  // dashboard queue aligned even when alert notifications are disabled.
  if (server?.status === 'online') {
    const cpu = Number.isFinite(Number(info?.cpu_usage_pct)) ? Math.round(Number(info.cpu_usage_pct)) : null;
    const ram = percent(info?.ram_used_mb, info?.ram_total_mb);
    const disk = percent(info?.disk_used_gb, info?.disk_total_gb);
    for (const [code, value, threshold] of [
      ['cpu_capacity', cpu, RESOURCE_WARNING_THRESHOLDS.cpu],
      ['ram_capacity', ram, RESOURCE_WARNING_THRESHOLDS.ram],
      ['disk_capacity', disk, RESOURCE_WARNING_THRESHOLDS.disk],
    ]) {
      if (value !== null && value >= threshold) {
        reasons.push({ code, severity: resourceSeverity(value), count: 1, value, threshold });
      }
    }

    const constrainedMounts = (Array.isArray(info?.storage_mount_metrics) ? info.storage_mount_metrics : [])
      .map(mount => ({
        name: mount?.name || mount?.path || 'Storage mount',
        value: Number.isFinite(Number(mount?.usage_pct))
          ? Math.round(Number(mount.usage_pct))
          : percent(mount?.used_gb, mount?.total_gb),
      }))
      .filter(mount => mount.value !== null && mount.value >= RESOURCE_WARNING_THRESHOLDS.storage);
    if (constrainedMounts.length > 0) {
      const value = Math.max(...constrainedMounts.map(mount => mount.value));
      reasons.push({
        code: 'storage_capacity',
        severity: resourceSeverity(value),
        count: constrainedMounts.length,
        value,
        threshold: RESOURCE_WARNING_THRESHOLDS.storage,
        targets: constrainedMounts.map(mount => mount.name),
      });
    }
  }

  const activeAlerts = alerts.filter(alert => alert?.status === 'active' && !alert?.acknowledged_at);
  if (activeAlerts.length > 0) {
    reasons.push({
      code: 'active_alerts',
      severity: activeAlerts.some(alert => ['critical', 'error'].includes(alert.severity)) ? 'critical' : 'warning',
      count: activeAlerts.length,
    });
  }

  if (includeUpdates && info?.reboot_required) {
    reasons.push({ code: 'reboot_required', severity: 'warning', count: 1 });
  }
  const osUpdates = includeUpdates ? updates.filter(update => !update?.phased).length : 0;
  if (osUpdates > 0) reasons.push({ code: 'os_updates', severity: 'warning', count: osUpdates });

  const containerUpdates = includeDockerUpdates && Array.isArray(imageUpdates)
    ? imageUpdates.filter(update => update?.status === 'update_available').length
    : 0;
  if (containerUpdates > 0) reasons.push({ code: 'image_updates', severity: 'warning', count: containerUpdates });
  if (includeCustomUpdates && customUpdatesCount > 0) {
    reasons.push({ code: 'custom_updates', severity: 'warning', count: customUpdatesCount });
  }

  const recentRuns = includeHistory ? history.slice(0, 4) : [];
  const failedRuns = recentRuns.filter(run => run?.status === 'failed');
  if (failedRuns.length > 0) {
    reasons.push({
      code: 'failed_operations',
      severity: 'warning',
      count: failedRuns.length,
      lastOccurredAt: failedRuns[0]?.started_at || failedRuns[0]?.completed_at || null,
    });
  }

  const severity = reasons.some(reason => reason.severity === 'critical')
    ? 'critical'
    : reasons.length > 0 ? 'warning' : 'healthy';

  return {
    requiresAttention: reasons.length > 0,
    severity,
    reasons,
    thresholds: {
      warning: RESOURCE_WARNING_THRESHOLDS,
      critical: RESOURCE_CRITICAL_THRESHOLD,
    },
  };
}

module.exports = {
  RESOURCE_CRITICAL_THRESHOLD,
  RESOURCE_WARNING_THRESHOLDS,
  buildServerAttention,
};
