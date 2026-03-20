const cron = require('node-cron');
const db = require('../db');
const ansibleRunner = require('./ansible-runner');
const systemInfo = require('./system-info');

// In-memory map: scheduleId -> cron task
const jobs = new Map();
// Track currently running jobs to prevent overlapping runs
const running = new Set();

// Polling intervals
let infoPoller = null;
let updatesPoller = null;
let imageUpdatesPoller = null;
let infoPolling = false;
let updatesPolling = false;
let imageUpdatesPolling = false;

const INFO_INTERVAL_ACTIVE       =  5 * 60 * 1000; // 5 min  – clients connected
const INFO_INTERVAL_IDLE         = 15 * 60 * 1000; // 15 min – no one watching
const UPDATES_INTERVAL_MS        = 60 * 60 * 1000; // 1 hour
const IMAGE_UPDATES_INTERVAL_MS  =  6 * 60 * 60 * 1000; // 6 hours
const STALE_THRESHOLD_MS         =  4 * 60 * 1000; // trigger immediate poll on connect if data > 4 min old

let lastInfoPollTime = 0;
let getClientCount = () => 0; // injected from index.js

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
    console.error('[Scheduler] Failed to load schedules from DB:', e.message);
    return;
  }
  for (const s of schedules) {
    if (s.enabled) {
      try { register(s); }
      catch (e) { console.error(`[Scheduler] Failed to register "${s.name}":`, e.message); }
    }
  }
  console.log(`[Scheduler] Loaded ${schedules.filter(s => s.enabled).length} active schedule(s)`);
}

/**
 * Register a cron job for a schedule row.
 */
function register(schedule) {
  if (jobs.has(schedule.id)) {
    jobs.get(schedule.id).stop();
  }

  if (!cron.validate(schedule.cron_expression)) {
    console.error(`[Scheduler] Invalid cron: "${schedule.cron_expression}" for schedule "${schedule.name}"`);
    return;
  }

  const task = cron.schedule(schedule.cron_expression, async () => {
    if (running.has(schedule.id)) {
      console.log(`[Scheduler] Skipping "${schedule.name}" – previous run still in progress`);
      return;
    }
    running.add(schedule.id);
    console.log(`[Scheduler] Running "${schedule.name}" (${schedule.playbook}) on ${schedule.targets}`);
    broadcast({ type: 'schedule_start', scheduleId: schedule.id, name: schedule.name });

    try {
      const result = await ansibleRunner.runPlaybook(
        schedule.playbook,
        schedule.targets || 'all',
        {},
        (type, data) => {
          broadcast({ type: 'update_output', scheduleId: schedule.id, stream: type, data });
        }
      );

      const status = result.success ? 'success' : 'failed';
      db.schedules.updateLastRun(schedule.id, status);
      broadcast({ type: 'schedule_complete', scheduleId: schedule.id, success: result.success });
      console.log(`[Scheduler] "${schedule.name}" completed: ${status}`);
    } catch (error) {
      db.schedules.updateLastRun(schedule.id, 'failed');
      broadcast({ type: 'schedule_error', scheduleId: schedule.id, error: error.message });
      console.error(`[Scheduler] "${schedule.name}" error:`, error.message);
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
      try {
        const info = await systemInfo.getSystemInfo(server);
        db.serverInfo.upsert(server.id, info);
        db.servers.updateStatus(server.id, 'online');
      } catch {
        db.servers.updateStatus(server.id, 'offline');
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'info' });
    console.log(`[Poller] System info refreshed for ${servers.length} server(s)`);
  } finally {
    infoPolling = false;
  }
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
      } catch {
        // ignore – keep stale cache
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'updates' });
    console.log(`[Poller] Updates cache refreshed for ${servers.length} server(s)`);
  } finally {
    updatesPolling = false;
  }
}

/**
 * Poll docker image update status for all servers in parallel and cache results.
 */
function parseImageUpdateOutput(stdout) {
  const jsonStart = stdout.indexOf('"msg": [');
  if (jsonStart === -1) return [];
  const jsonEnd = stdout.indexOf(']', jsonStart);
  if (jsonEnd === -1) return [];
  try {
    return JSON.parse(stdout.substring(jsonStart + 7, jsonEnd + 1))
      .filter(line => line && line.includes('|'))
      .map(line => {
        const [image, status] = line.split('|');
        return { image: image.trim(), status: (status || 'unknown').trim() };
      });
  } catch { return []; }
}

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
      } catch {
        // keep stale cache
      }
    }));
    broadcast({ type: 'cache_updated', scope: 'image_updates' });
    console.log(`[Poller] Docker image updates checked for ${servers.length} server(s)`);
  } finally {
    imageUpdatesPolling = false;
  }
}

/**
 * Start background polling for system info and updates.
 */
function startPolling() {
  // Run immediately on startup, then on interval
  pollSystemInfo().catch(err => console.error('[Poller] System info error:', err.message));
  pollUpdates().catch(err => console.error('[Poller] Updates error:', err.message));
  pollImageUpdates().catch(err => console.error('[Poller] Image updates error:', err.message));

  // Info polling: runs every INFO_INTERVAL_ACTIVE, but skips when no clients
  // are connected and data is still fresh. A slower idle floor (INFO_INTERVAL_IDLE)
  // is guaranteed via the stale check in onClientConnect.
  infoPoller = setInterval(() => {
    const interval = getClientCount() > 0 ? INFO_INTERVAL_ACTIVE : INFO_INTERVAL_IDLE;
    if (Date.now() - lastInfoPollTime >= interval) {
      pollSystemInfo().catch(err => console.error('[Poller] System info error:', err.message));
    }
  }, 60 * 1000); // tick every minute, decide whether to actually poll

  updatesPoller = setInterval(
    () => pollUpdates().catch(err => console.error('[Poller] Updates error:', err.message)),
    UPDATES_INTERVAL_MS
  );

  imageUpdatesPoller = setInterval(
    () => pollImageUpdates().catch(err => console.error('[Poller] Image updates error:', err.message)),
    IMAGE_UPDATES_INTERVAL_MS
  );

  console.log(`[Poller] Started – active ${INFO_INTERVAL_ACTIVE / 60000}min / idle ${INFO_INTERVAL_IDLE / 60000}min, updates every ${UPDATES_INTERVAL_MS / 60000}min, image updates every ${IMAGE_UPDATES_INTERVAL_MS / 3600000}h`);
}

/**
 * Called when a WebSocket client connects. If system info is stale, trigger
 * an immediate refresh so the dashboard shows fresh data right away.
 */
function onClientConnect() {
  if (Date.now() - lastInfoPollTime > STALE_THRESHOLD_MS) {
    pollSystemInfo().catch(err => console.error('[Poller] On-connect refresh error:', err.message));
  }
}

/**
 * Stop background polling.
 */
function stopPolling() {
  if (infoPoller)          { clearInterval(infoPoller);          infoPoller = null; }
  if (updatesPoller)       { clearInterval(updatesPoller);       updatesPoller = null; }
  if (imageUpdatesPoller)  { clearInterval(imageUpdatesPoller);  imageUpdatesPoller = null; }
}

module.exports = { init, register, unregister, reload, startPolling, stopPolling, onClientConnect, setClientCountFn: fn => { getClientCount = fn; } };
