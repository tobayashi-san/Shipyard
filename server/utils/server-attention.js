'use strict';

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

  return { requiresAttention: reasons.length > 0, severity, reasons };
}

module.exports = { buildServerAttention };
