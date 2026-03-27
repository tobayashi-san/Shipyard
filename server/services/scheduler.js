const cron = require('node-cron');
const log = require('../utils/logger').child('scheduler');
const db = require('../db');
const ansibleRunner = require('./ansible-runner');
const systemInfo = require('./system-info');
const sshManager = require('./ssh-manager');
const { parseImageUpdateOutput } = require('../utils/parse-image-updates');
const gitSync = require('./git-sync');
const pullModeManager = require('./pull-mode-manager');

// In-memory map: scheduleId -> cron task
const jobs = new Map();
// Track currently running jobs to prevent overlapping runs
const running = new Set();

// Polling intervals
let infoPoller = null;
let updatesPoller = null;
let imageUpdatesPoller = null;
let customUpdatesPoller = null;
let agentMetricsPruner = null;
let infoPolling = false;
let updatesPolling = false;
let imageUpdatesPolling = false;
let customUpdatesPolling = false;

const STALE_THRESHOLD_MS = 4 * 60 * 1000;

// Defaults (used when DB has no value)
const DEFAULTS = {
  poll_info_enabled:              '1',
  poll_info_interval_min:         '5',
  poll_updates_enabled:           '1',
  poll_updates_interval_min:      '60',
  poll_image_updates_enabled:     '1',
  poll_image_updates_interval_min:'360',
  poll_custom_updates_enabled:    '1',
  poll_custom_updates_interval_min:'360',
};

function getPollingConfig() {
  const g = (key) => db.settings.get(key) ?? DEFAULTS[key];
  const safeMs = (key, fallback) => {
    const val = parseInt(g(key));
    return (Number.isFinite(val) && val > 0 ? val : fallback) * 60 * 1000;
  };
  return {
    info:          { enabled: g('poll_info_enabled') !== '0',          intervalMs: safeMs('poll_info_interval_min', 5) },
    updates:       { enabled: g('poll_updates_enabled') !== '0',       intervalMs: safeMs('poll_updates_interval_min', 60) },
    imageUpdates:  { enabled: g('poll_image_updates_enabled') !== '0', intervalMs: safeMs('poll_image_updates_interval_min', 360) },
    customUpdates: { enabled: g('poll_custom_updates_enabled') !== '0',intervalMs: safeMs('poll_custom_updates_interval_min', 360) },
  };
}

let lastInfoPollTime = 0;

function runNow(pollFn, label) {
  pollFn().catch(err => log.error({ err, label }, 'Poller error'));
}

function makePoller(pollFn, label, intervalMs) {
  return setInterval(() => runNow(pollFn, label), intervalMs);
}

// Broadcast function (set during init)
let broadcast = () => {};

/**
 * Initialize scheduler: load all enabled schedules and register cron jobs.
 */
function init(broadcastFn) {
  broadcast = broadcastFn || broadcast;

  let schedules = [];
  try {
    schedules = db.schedules.getAll();
  } catch (e) {
    log.error({ err: e }, 'Failed to load schedules from DB');
    return;
  }
  for (const s of schedules) {
    if (s.enabled) {
      try { register(s); }
      catch (e) { log.error({ err: e, schedule: s.name }, 'Failed to register schedule'); }
    }
  }
  log.info({ count: schedules.filter(s => s.enabled).length }, 'Loaded active schedules');
}

/**
 * Register a cron job for a schedule row.
 */
function register(schedule) {
  if (jobs.has(schedule.id)) {
    jobs.get(schedule.id).stop();
  }

  if (!cron.validate(schedule.cron_expression)) {
    log.error({ cron: schedule.cron_expression, schedule: schedule.name }, 'Invalid cron expression');
    return;
  }

  const task = cron.schedule(schedule.cron_expression, async () => {
    if (running.has(schedule.id)) {
      log.info({ schedule: schedule.name }, 'Skipping – previous run still in progress');
      return;
    }
    running.add(schedule.id);
    log.info({ schedule: schedule.name, playbook: schedule.playbook, targets: schedule.targets }, 'Running schedule');
    broadcast({ type: 'schedule_start', scheduleId: schedule.id, name: schedule.name });

    // Sync playbooks from git before running
    await gitSync.autoPull();

    const histId = db.scheduleHistory.create(schedule.id, schedule.name, schedule.playbook, schedule.targets);
    const outputLines = [];

    try {
      const result = await ansibleRunner.runPlaybook(
        schedule.playbook,
        schedule.targets || 'all',
        {},
        (type, data) => {
          broadcast({ type: 'update_output', scheduleId: schedule.id, stream: type, data });
          outputLines.push(data);
        }
      );

      const status = result.success ? 'success' : 'failed';
      db.schedules.updateLastRun(schedule.id, status);
      db.scheduleHistory.complete(histId, status, outputLines.join(''));
      db.scheduleHistory.prune();
      broadcast({ type: 'schedule_complete', scheduleId: schedule.id, success: result.success });
      log.info({ schedule: schedule.name, status }, 'Schedule completed');
    } catch (error) {
      db.schedules.updateLastRun(schedule.id, 'failed');
      db.scheduleHistory.complete(histId, 'failed', outputLines.join('') + (outputLines.length ? '\n' : '') + error.message);
      broadcast({ type: 'schedule_error', scheduleId: schedule.id, error: error.message });
      log.error({ err: error, schedule: schedule.name }, 'Schedule error');
    } finally {
      running.delete(schedule.id);
    }
  });

  jobs.set(schedule.id, task);
}

/**
 * Unregister (stop + remove) a cron job.
 */
function unregister(scheduleId) {
  if (jobs.has(scheduleId)) {
    jobs.get(scheduleId).stop();
    jobs.delete(scheduleId);
  }
}

/**
 * Reload a single schedule (after create/update/toggle).
 */
function reload(scheduleId) {
  unregister(scheduleId);
  const schedule = db.schedules.getById(scheduleId);
  if (schedule && schedule.enabled) {
    register(schedule);
  }
}

/**
 * Poll system info for all servers in parallel and update the DB cache.
 */
async function pollSystemInfo() {
  if (infoPolling) return;
  infoPolling = true;
  lastInfoPollTime = Date.now();
  try {
    const servers = db.servers.getAll();
    await Promise.allSettled(servers.map(async server => {
      const agentCfg = db.agentConfig.getByServerId(server.id);
      if (agentCfg?.mode === 'push') {
        const intervalSec = Math.max(5, parseInt(agentCfg.interval, 10) || 30);
        const lastSeenMs = agentCfg.last_seen ? new Date(agentCfg.last_seen).getTime() : 0;
        if (lastSeenMs && (Date.now() - lastSeenMs) <= intervalSec * 10 * 1000) {
          db.servers.updateStatus(server.id, 'online');
        } else {
          db.servers.updateStatus(server.id, 'offline');
        }
        return;
      }

      if (agentCfg?.mode === 'pull') {
        const r = await pullModeManager.pollServer(server);
        if (r.ok) {
          const intervalSec = Math.max(5, parseInt(agentCfg.interval, 10) || 30);
          const lastSeenMs = agentCfg.last_seen ? new Date(agentCfg.last_seen).getTime() : 0;
          if (lastSeenMs && (Date.now() - lastSeenMs) <= intervalSec * 10 * 1000) {
            db.servers.updateStatus(server.id, 'online');
          } else if (!r.report) {
            db.servers.updateStatus(server.id, 'offline');
          }
          return;
        }
      }

      try {
        const info = await systemInfo.getSystemInfo(server);
        db.serverInfo.upsert(server.id, info);
        db.servers.updateStatus(server.id, 'online');
      } catch (err) {
        log.debug({ err, server: server.name }, 'System info poll failed');
        db.servers.updateStatus(server.id, 'offline');
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'info' });
    log.info({ count: servers.length }, 'System info refreshed');
  } finally {
    infoPolling = false;
  }
}

function startAgentMetricsRetention() {
  if (agentMetricsPruner) clearInterval(agentMetricsPruner);
  agentMetricsPruner = setInterval(() => {
    try {
      const days = parseInt(db.settings.get('agent_metrics_retention_days') || '7', 10);
      db.agentMetrics.pruneOlderThanDays(days);
    } catch (err) {
      log.debug({ err }, 'Agent metrics retention prune failed');
    }
  }, 60 * 60 * 1000);
}

/**
 * Poll available updates for all servers in parallel and update the DB cache.
 */
async function pollUpdates() {
  if (updatesPolling) return;
  updatesPolling = true;
  try {
    const servers = db.servers.getAll();
    await Promise.allSettled(servers.map(async server => {
      try {
        const updates = await systemInfo.getAvailableUpdates(server);
        db.updatesCache.set(server.id, updates);
      } catch (err) {
        log.debug({ err, server: server.name }, 'Updates poll failed');
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'updates' });
    log.info({ count: servers.length }, 'Updates cache refreshed');
  } finally {
    updatesPolling = false;
  }
}

/**
 * Poll docker image update status for all servers in parallel and cache results.
 */
async function pollImageUpdates() {
  if (imageUpdatesPolling) return;
  imageUpdatesPolling = true;
  try {
    const servers = db.servers.getAll().filter(s => s.status === 'online');
    await Promise.allSettled(servers.map(async server => {
      try {
        const result = await ansibleRunner.runPlaybook('check-image-updates.yml', server.name);
        const results = parseImageUpdateOutput(result.stdout);
        db.dockerImageUpdatesCache.set(server.id, results);
      } catch (err) {
        log.debug({ err, server: server.name }, 'Image updates poll failed');
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'image_updates' });
    log.info({ count: servers.length }, 'Docker image updates checked');
  } finally {
    imageUpdatesPolling = false;
  }
}

/**
 * Check a single custom update task: fetch GitHub latest release and/or
 * run the check_command via SSH to determine current version.
 */
async function checkCustomTask(server, task) {
  let lastVersion = task.last_version;
  let currentVersion = task.current_version;

  if (task.type === 'github' && task.github_repo) {
    try {
      const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Shipyard/1.0' };
      if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch(`https://api.github.com/repos/${task.github_repo}/releases/latest`, { headers, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        lastVersion = data.tag_name || lastVersion;
      }
    } catch (err) {
      log.debug({ err, repo: task.github_repo }, 'GitHub release check failed');
    }
  }

  if (task.check_command) {
    try {
      const result = await sshManager.execCommand(server, task.check_command);
      if (result.code === 0) currentVersion = result.stdout.trim() || currentVersion;
    } catch (err) {
      log.debug({ err, server: server.name, task: task.name }, 'Custom update check command failed');
    }
  }

  const normalize = v => v ? v.trim().replace(/^v/i, '') : v;
  const hasUpdate = !!(lastVersion && currentVersion && normalize(lastVersion) !== normalize(currentVersion));
  db.customUpdateTasks.setVersionInfo(task.id, currentVersion, lastVersion, hasUpdate);
}

/**
 * Poll all custom update tasks for all servers.
 */
async function pollCustomUpdates() {
  if (customUpdatesPolling) return;
  customUpdatesPolling = true;
  try {
    const servers = db.servers.getAll();
    await Promise.allSettled(servers.map(async server => {
      const tasks = db.customUpdateTasks.getByServer(server.id);
      await Promise.allSettled(tasks.map(task => checkCustomTask(server, task).catch(err => log.debug({ err, server: server.name }, 'Custom task check failed'))));
    }));
    broadcast({ type: 'cache_updated', scope: 'custom_updates' });
    log.info('Custom update tasks checked');
  } finally {
    customUpdatesPolling = false;
  }
}

/**
 * Set up polling intervals based on current DB config (does not run immediately).
 */
function setupPollingIntervals() {
  const cfg = getPollingConfig();

  if (cfg.info.enabled) {
    infoPoller = setInterval(() => {
      if (Date.now() - lastInfoPollTime >= cfg.info.intervalMs) {
        pollSystemInfo().catch(err => log.error({ err }, 'System info poll error'));
      }
    }, 60 * 1000); // tick every minute, decide whether to actually poll
  }

  if (cfg.updates.enabled)       updatesPoller       = makePoller(pollUpdates,       'Updates',        cfg.updates.intervalMs);
  if (cfg.imageUpdates.enabled)  imageUpdatesPoller  = makePoller(pollImageUpdates,  'Image updates',  cfg.imageUpdates.intervalMs);
  if (cfg.customUpdates.enabled) customUpdatesPoller = makePoller(pollCustomUpdates, 'Custom updates', cfg.customUpdates.intervalMs);

  log.info({
    info: cfg.info.enabled ? cfg.info.intervalMs / 60000 + 'min' : 'off',
    updates: cfg.updates.enabled ? cfg.updates.intervalMs / 60000 + 'min' : 'off',
    images: cfg.imageUpdates.enabled ? cfg.imageUpdates.intervalMs / 60000 + 'min' : 'off',
    custom: cfg.customUpdates.enabled ? cfg.customUpdates.intervalMs / 60000 + 'min' : 'off',
  }, 'Poller config');
}

/**
 * Start background polling for system info and updates (runs immediately on startup).
 */
function startPolling() {
  const cfg = getPollingConfig();
  if (cfg.info.enabled)          runNow(pollSystemInfo,    'System info');
  if (cfg.updates.enabled)       runNow(pollUpdates,       'Updates');
  if (cfg.imageUpdates.enabled)  runNow(pollImageUpdates,  'Image updates');
  if (cfg.customUpdates.enabled) runNow(pollCustomUpdates, 'Custom updates');
  setupPollingIntervals();
  startAgentMetricsRetention();
}

/**
 * Restart pollers with current DB config (called after settings change).
 */
function restartPolling() {
  stopPolling();
  setupPollingIntervals();
  log.info('Poller restarted with new config');
}

/**
 * Called when a WebSocket client connects. If system info is stale, trigger
 * an immediate refresh so the dashboard shows fresh data right away.
 */
function onClientConnect() {
  if (Date.now() - lastInfoPollTime > STALE_THRESHOLD_MS) {
    runNow(pollSystemInfo, 'On-connect refresh');
  }
}

/**
 * Stop background polling.
 */
function stopPolling() {
  if (infoPoller)           { clearInterval(infoPoller);           infoPoller = null; }
  if (updatesPoller)        { clearInterval(updatesPoller);        updatesPoller = null; }
  if (imageUpdatesPoller)   { clearInterval(imageUpdatesPoller);   imageUpdatesPoller = null; }
  if (customUpdatesPoller)  { clearInterval(customUpdatesPoller);  customUpdatesPoller = null; }
  if (agentMetricsPruner)   { clearInterval(agentMetricsPruner);   agentMetricsPruner = null; }
}

/**
 * Stop all scheduled cron jobs.
 */
function stopJobs() {
  for (const [id, task] of jobs) {
    task.stop();
  }
  jobs.clear();
}

/**
 * Full shutdown: stop pollers and all cron jobs.
 */
function shutdown() {
  stopPolling();
  stopJobs();
}

module.exports = { init, register, unregister, reload, startPolling, stopPolling, stopJobs, shutdown, restartPolling, onClientConnect, checkCustomTask, getPollingConfig, DEFAULTS };
