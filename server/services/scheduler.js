const { collectionQueue } = require('./collection-queue');
const pollingObservations = require('../utils/polling-observations').createPollingObservations();
const cron = require("node-cron");
const { workflowHostIds } = require("../utils/workflow-history-scope");
const { notify } = require("./notifier");
const { nextMatches } = require("../utils/cron-next-matches");
const log = require("../utils/logger").child("scheduler");
const db = require("../db");
const ansibleRunner = require("./ansible-runner");
const systemInfo = require("./system-info");
const sshManager = require("./ssh-manager");
const { parseImageUpdateReport } = require("../utils/parse-image-updates");
const gitSync = require("./git-sync");
const { resolveTargets } = require("../utils/validate");
const resourceAlerts = require("./resource-alerts");
const { syncIpamSource } = require("../routes/ipam");

// In-memory map: scheduleId -> cron task
const jobs = new Map();
// Track currently running jobs to prevent overlapping runs
const running = new Set();

// Polling intervals
let infoPoller = null;
let updatesPoller = null;
let imageUpdatesPoller = null;
let customUpdatesPoller = null;
let ipamSourcesPoller = null;
let infoPolling = false;
let updatesPolling = false;
let imageUpdatesPolling = false;
let customUpdatesPolling = false;
let ipamSourcesPolling = false;

const STALE_THRESHOLD_MS = 4 * 60 * 1000;
const DEFAULT_TIMEZONE =
  process.env.SHIPYARD_TIMEZONE || process.env.TZ || "Europe/Zurich";

function getSchedulerTimezone() {
  return db.settings.get("scheduler_timezone") || DEFAULT_TIMEZONE;
}

// Defaults (used when DB has no value)
const DEFAULTS = {
  poll_info_enabled: "1",
  poll_info_interval_min: "5",
  poll_updates_enabled: "1",
  poll_updates_interval_min: "60",
  poll_image_updates_enabled: "1",
  poll_image_updates_interval_min: "360",
  poll_custom_updates_enabled: "1",
  poll_custom_updates_interval_min: "360",
  // Check due sources every minute. Every source still has its own interval
  // (minimum five minutes), so arbitrary values do not get rounded to a
  // five-minute scheduler boundary.
  poll_ipam_sources_enabled: "1",
  poll_ipam_sources_interval_min: "1",
};

function getPollingConfig() {
  const g = (key) => db.settings.get(key) ?? DEFAULTS[key];
  const safeMs = (key, fallback) => {
    const val = parseInt(g(key, 10));
    return (Number.isFinite(val) && val > 0 ? val : fallback) * 60 * 1000;
  };
  return {
    info: {
      enabled: g("poll_info_enabled") !== "0",
      intervalMs: safeMs("poll_info_interval_min", 5),
    },
    updates: {
      enabled: g("poll_updates_enabled") !== "0",
      intervalMs: safeMs("poll_updates_interval_min", 60),
    },
    imageUpdates: {
      enabled: g("poll_image_updates_enabled") !== "0",
      intervalMs: safeMs("poll_image_updates_interval_min", 360),
    },
    customUpdates: {
      enabled: g("poll_custom_updates_enabled") !== "0",
      intervalMs: safeMs("poll_custom_updates_interval_min", 360),
    },
    ipamSources: {
      enabled: g("poll_ipam_sources_enabled") !== "0",
      intervalMs: safeMs("poll_ipam_sources_interval_min", 1),
    },
  };
}

let lastInfoPollTime = 0;

function runNow(pollFn, label) {
  pollFn().catch((err) => log.error({ err, label }, "Poller error"));
}

function makePoller(pollFn, label, intervalMs) {
  return setInterval(() => runNow(pollFn, label), Math.min(intervalMs, 60_000));
}

async function pollIpamSources() {
  if (ipamSourcesPolling) return;
  ipamSourcesPolling = true;
  const observation = pollingObservations.begin('ipamSources');
  try {
    const now = Date.now();
    const sources = db.db
      .prepare(
        `SELECT * FROM ipam_sync_sources WHERE enabled = 1 AND COALESCE(auto_sync, 1) = 1`,
      )
      .all();
    const due = sources.filter((source) => {
      const interval =
        Math.min(
          1440,
          Math.max(5, Number.parseInt(source.sync_interval_min, 10) || 15),
        ) *
        60 *
        1000;
      const last = Date.parse(source.last_synced_at || "");
      return !Number.isFinite(last) || now - last >= interval;
    });
    const sourceResults = await Promise.allSettled(
      due.map(source => collectionQueue.run('ipam', {id:`ipam-source-${source.id}`}, () => syncIpamSource(source, {actor:'scheduler'}))),
    );
    const sourceFailed = sourceResults.filter(
      (result) => result.status === "rejected",
    ).length;
    observation.errors += sourceFailed;
    if (due.length) {
      broadcast({ type: "cache_updated", scope: "ipam" });
      log.info(
        {
          sourcesConfigured: sources.length,
          sourcesSynced: due.length - sourceFailed,
          sourcesFailed: sourceFailed,
        },
        "IPAM sources refreshed",
      );
    }
  } catch (err) {
    observation.errors++;
    log.error({ err }, "IPAM source poll failed");
  } finally {
    pollingObservations.finish('ipamSources', observation);
    ipamSourcesPolling = false;
  }
}

// Broadcast function (set during init)
let broadcast = () => {};

/**
 * Initialize scheduler: load all enabled schedules and register cron jobs.
 */
function init(broadcastFn) {
  broadcast = broadcastFn || broadcast;

  try {
    const staleCount = db.scheduleHistory.failStaleRunning();
    if (staleCount > 0) {
      log.warn(
        { count: staleCount },
        "Marked stale running schedule history entries as failed",
      );
    }
  } catch (e) {
    log.error({ err: e }, "Failed to mark stale schedule history entries");
  }

  let schedules = [];
  try {
    schedules = db.schedules.getAll();
  } catch (e) {
    log.error({ err: e }, "Failed to load schedules from DB");
    return;
  }
  for (const s of schedules) {
    if (s.enabled) {
      try {
        register(s);
      } catch (e) {
        log.error({ err: e, schedule: s.name }, "Failed to register schedule");
      }
    }
  }
  log.info(
    { count: schedules.filter((s) => s.enabled).length },
    "Loaded active schedules",
  );
}

/**
 * Register a cron job for a schedule row.
 */
function register(schedule) {
  unregister(schedule.id);

  if (!cron.validate(schedule.cron_expression)) {
    log.error(
      { cron: schedule.cron_expression, schedule: schedule.name },
      "Invalid cron expression",
    );
    return;
  }

  const task = cron.createTask(
    schedule.cron_expression,
    async () => {
      // A callback may already be queued when a reset/delete destroys its task.
      // Recheck persisted state before any history, broadcasts or remote work.
      const current = db.schedules.getById(schedule.id);
      if (!current || !current.enabled) return;
      if (running.has(schedule.id)) {
        const environmentId = current.environment_id || "default";
        const targets = resolveTargets(current.targets, db.servers.getAll().filter(server =>
          String(server.environment_id || "default") === String(environmentId)));
        const skippedId = db.db.transaction(() => {
          const id = db.scheduleHistory.create(current.id, current.name, current.playbook, targets, {
            environmentId, triggeredBy: "scheduler", checkMode: Boolean(current.check_mode),
          });
          db.scheduleHistory.complete(id, "skipped",
            "Skipped because a previous execution of this schedule is still running. This occurrence was not queued and will not be retried. The next regular occurrence follows the schedule.");
          db.scheduleHistory.prune();
          return id;
        })();
        broadcast({ type: "schedule_skipped", scheduleId: current.id, runId: skippedId, name: current.name, status: "skipped" });
        log.info(
          { schedule: schedule.name },
          "Skipping – previous run still in progress",
        );
        return;
      }
      running.add(schedule.id);
      log.info(
        {
          schedule: schedule.name,
          playbook: schedule.playbook,
          targets: schedule.targets,
        },
        "Running schedule",
      );
      broadcast({
        type: "schedule_start",
        scheduleId: schedule.id,
        name: schedule.name,
      });

      const resolvedTargets = resolveTargets(
        schedule.targets,
        db.servers.getAll().filter(server =>
          String(server.environment_id || "default") === String(schedule.environment_id || "default")),
      );
      const histId = db.scheduleHistory.create(
        schedule.id,
        schedule.name,
        schedule.playbook,
        resolvedTargets,
        {
          environmentId: schedule.environment_id || "default",
          triggeredBy: "scheduler",
          checkMode: Boolean(schedule.check_mode),
        },
      );
      const notificationServerIds = workflowHostIds(db.scheduleHistory.getById(histId));
      ansibleRunner.prepareRun(histId);
      const outputLines = [];

      try {
        // Sync playbooks from git before running. Failures are recorded as a
        // run result instead of leaving the schedule stuck in "running".
        await gitSync.autoPull();
        const result = await ansibleRunner.runPlaybook(
          schedule.playbook,
          schedule.targets || "all",
          schedule.extra_vars || {},
          (type, data) => {
            broadcast({
              type: "update_output",
              scheduleId: schedule.id,
              name: schedule.name,
              stream: type,
              data,
            });
            outputLines.push(data);
            db.scheduleHistory.appendOutput(histId, data);
          },
          {
            environmentId: schedule.environment_id || "default",
            checkMode: Boolean(schedule.check_mode),
            forks: schedule.forks,
            runId: histId,
          },
        );

        const status = result.cancelled ? "cancelled" : result.success ? "success" : "failed";
        db.schedules.updateLastRun(schedule.id, status);
        db.scheduleHistory.complete(histId, status, outputLines.join(""));
        if (status === 'failed' && db.settings.get('notify_playbook_failed') !== '0') notify(`Scheduled playbook failed: ${schedule.name}`, `Playbook: ${schedule.playbook}. Targets: ${resolvedTargets}. Review execution history for details.`, false, {environmentId: schedule.environment_id || 'default', serverIds: notificationServerIds}).catch(() => {});
        db.scheduleHistory.prune();
        broadcast({
          type: "schedule_complete",
          scheduleId: schedule.id,
          runId: histId,
          name: schedule.name,
          success: result.success,
          status,
        });
        log.info({ schedule: schedule.name, status }, "Schedule completed");
      } catch (error) {
        ansibleRunner.clearRun(histId);
        db.schedules.updateLastRun(schedule.id, "failed");
        db.scheduleHistory.complete(
          histId,
          "failed",
          outputLines.join("") +
            (outputLines.length ? "\n" : "") +
            error.message,
        );
        broadcast({
          type: "schedule_error",
          scheduleId: schedule.id,
          name: schedule.name,
          error: error.message,
        });
        if (db.settings.get('notify_playbook_failed') !== '0') notify(`Scheduled playbook failed: ${schedule.name}`, error.message, false, {environmentId: schedule.environment_id || 'default', serverIds: notificationServerIds}).catch(() => {});
        log.error({ err: error, schedule: schedule.name }, "Schedule error");
      } finally {
        running.delete(schedule.id);
      }
    },
    { timezone: getSchedulerTimezone() },
  );

  // Share the DST-correct next-match calculation with the form preview.
  task.timeMatcher.getNextMatch = (from) => {
    const next = nextMatches(task.timeMatcher, from, 1)[0];
    if (!next) throw new Error('No execution found within the next 13 years.');
    return next;
  };
  try { task.start(); } catch (error) { task.destroy(); throw error; }
  jobs.set(schedule.id, task);
}

/**
 * Unregister (stop + remove) a cron job.
 */
function unregister(scheduleId) {
  if (jobs.has(scheduleId)) {
    jobs.get(scheduleId).destroy();
    jobs.delete(scheduleId);
  }
}

function getNextRun(scheduleId) {
  const task = jobs.get(scheduleId);
  const next = task?.getNextRun?.();
  return next instanceof Date && Number.isFinite(next.getTime()) ? next.toISOString() : null;
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

function reloadAllSchedules() {
  stopJobs();
  let schedules = [];
  try {
    schedules = db.schedules.getAll();
  } catch (e) {
    log.error({ err: e }, "Failed to reload schedules from DB");
    return;
  }
  for (const s of schedules) {
    if (s.enabled) {
      try {
        register(s);
      } catch (e) {
        log.error({ err: e, schedule: s.name }, "Failed to register schedule");
      }
    }
  }
  log.info(
    {
      count: schedules.filter((s) => s.enabled).length,
      timezone: getSchedulerTimezone(),
    },
    "Reloaded active schedules",
  );
}

/**
 * Poll system info for all servers in parallel and update the DB cache.
 */
async function pollSystemInfo() {
  if (infoPolling) return;
  infoPolling = true;
  const observation = pollingObservations.begin('info');
  lastInfoPollTime = Date.now();
  try {
    const servers = db.servers.getAll();
    collectionQueue.prune(servers.map(server => server.id));
    const outcomes = await Promise.allSettled(
      servers.filter(server => collectionQueue.due('info', server)).map(async (server) => {
        try {
          const info = await collectionQueue.run('info', server, () => systemInfo.getSystemInfo(server), {baseMs:getPollingConfig().info.intervalMs});
          db.serverInfo.upsert(server.id, info);
          db.servers.updateStatus(server.id, "online");
        } catch (err) {
          pollingObservations.fail(observation,server,'System information check failed. Inspect host connectivity and SSH access.');
          log.debug({ err, server: server.name }, "System info poll failed");
          if (!["COLLECTION_QUEUE_FULL", "SSH_QUEUE_FULL", "SSH_QUEUE_TIMEOUT"].includes(err.code)) db.servers.updateStatus(server.id, "offline");
        }
      }),
    );
    observation.errors += outcomes.filter(result => result.status === 'rejected').length;
    resourceAlerts.evaluateAll();
    broadcast({ type: "cache_updated", scope: "info" });
    log.info({ count: servers.length }, "System info refreshed");
  } catch (error) {
    observation.errors++;
    throw error;
  } finally {
    pollingObservations.finish('info', observation);
    infoPolling = false;
  }
}

/**
 * Poll available updates for all servers in parallel and update the DB cache.
 */
async function pollUpdates() {
  if (updatesPolling) return;
  updatesPolling = true;
  const observation = pollingObservations.begin('updates');
  try {
    const servers = db.servers.getAll();
    const outcomes = await Promise.allSettled(
      servers.filter(server => collectionQueue.due('updates', server)).map(async (server) => {
        try {
          const updates = await collectionQueue.run('updates', server, () => systemInfo.getAvailableUpdates(server), {baseMs:getPollingConfig().updates.intervalMs});
          db.updatesCache.set(server.id, updates);
        } catch (err) {
          pollingObservations.fail(observation,server,'Package check failed. Check host connectivity and package manager access.');
          db.checkAttempts.failed(server.id, 'os', 'Package check failed. Check host connectivity and package manager access.');
          log.debug({ err, server: server.name }, "Updates poll failed");
        }
      }),
    );
    observation.errors += outcomes.filter(result => result.status === 'rejected').length;
    resourceAlerts.evaluateAll();
    broadcast({ type: "cache_updated", scope: "updates" });
    log.info({ count: servers.length }, "Updates cache refreshed");
  } catch (error) {
    observation.errors++;
    throw error;
  } finally {
    pollingObservations.finish('updates', observation);
    updatesPolling = false;
  }
}

/**
 * Poll docker image update status for all servers in parallel and cache results.
 */
async function pollImageUpdates() {
  if (imageUpdatesPolling) return;
  imageUpdatesPolling = true;
  const observation = pollingObservations.begin('imageUpdates');
  try {
    const servers = db.servers.getAll().filter((s) => s.status === "online" && s.docker_enabled);
    const outcomes = await Promise.allSettled(
      servers.filter(server => collectionQueue.due('imageUpdates', server)).map(async (server) => {
        try {
          const report = await collectionQueue.run('imageUpdates', server, async () => {
            const result = await ansibleRunner.runPlaybook(
              "check-image-updates.yml", server.name, {}, null,
              { environmentId: server.environment_id || "default" },
            );
            const report = parseImageUpdateReport(result.stdout);
            if (!result.success || !report.complete) throw Object.assign(new Error('Image update check did not complete. Existing results were kept.'), {code:'IMAGE_CHECK_INCOMPLETE'});
            return report;
          }, {baseMs:getPollingConfig().imageUpdates.intervalMs});
          db.dockerImageUpdatesCache.set(server.id, report.results);
        } catch (err) {
          pollingObservations.fail(observation,server,'Image check failed. Check host connectivity, container runtime and registry access.');
          db.checkAttempts.failed(server.id, 'images', 'Image check failed. Check host connectivity, container runtime and registry access.');
          log.debug({ err, server: server.name }, "Image updates poll failed");
        }
      }),
    );
    observation.errors += outcomes.filter(result => result.status === 'rejected').length;
    resourceAlerts.evaluateAll();
    broadcast({ type: "cache_updated", scope: "image_updates" });
    log.info({ count: servers.length }, "Docker image updates checked");
  } catch (error) {
    observation.errors++;
    throw error;
  } finally {
    pollingObservations.finish('imageUpdates', observation);
    imageUpdatesPolling = false;
  }
}

/**
 * Check a single custom update task: fetch GitHub latest release and/or
 * run the check_command via SSH to determine current version.
 */
async function checkCustomTask(server, task) {
  try {
    const result = await performCustomTaskCheck(server, task);
    db.customUpdateTasks.setVersionInfo(task.id, result.current_version, result.last_version, result.has_update, task);
    return result;
  }
  catch (error) {
    db.customUpdateTasks.setCheckFailure(task.id, task);
    throw error;
  }
}

async function performCustomTaskCheck(server, task) {
  if (!task.check_command?.trim() || (task.type === 'script' && !task.latest_command?.trim()) || (task.type === 'github' && !task.github_repo) || (task.type === 'trigger' && !task.trigger_output?.trim())) {
    throw new Error('The check configuration is incomplete. Edit this custom update task.');
  }
  let lastVersion = task.last_version;
  let currentVersion = task.current_version;
  let hasUpdate = false;

  if (task.type === "github" && task.github_repo) {
    try {
      const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Shipyard/1.0",
      };
      if (process.env.GITHUB_TOKEN)
        headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
      const parts = String(task.github_repo).split('/');
      if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Invalid GitHub repository');
      const releaseUrl = new URL('https://api.github.com');
      releaseUrl.pathname = `/repos/${parts.map(encodeURIComponent).join('/')}/releases/latest`;
      const res = await fetch(releaseUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.tag_name !== "string" || !data.tag_name.trim()) throw new Error("Release tag missing");
        lastVersion = data.tag_name;
      } else { throw new Error("Release lookup rejected"); }
    } catch (err) {
      log.debug({ err, repo: task.github_repo }, "GitHub release check failed");
      throw new Error("GitHub release check failed. Previous check results were retained.");
    }
  }

  if (task.type === "script" && task.latest_command) {
    try {
      const result = await sshManager.execCommand(server, task.latest_command, { timeoutMs: 30000 });
      if (result.code !== 0 || !result.stdout.trim()) throw new Error("No successful version output");
      lastVersion = result.stdout.trim();
    } catch (err) {
      log.debug(
        { err, server: server.name, task: task.name },
        "Latest version command failed",
      );
      throw new Error("Latest-version command failed or returned no version. Previous check results were retained.");
    }
  }

  if (task.check_command) {
    try {
      const result = await sshManager.execCommand(server, task.check_command, { timeoutMs: 30000 });
      if (result.code !== 0 || (task.type !== "trigger" && !result.stdout.trim())) throw new Error("No successful version output");
      currentVersion = result.stdout.trim();
    } catch (err) {
      log.debug(
        { err, server: server.name, task: task.name },
        "Custom update check command failed",
      );
      throw new Error("Installed-version check failed or returned no version. Previous check results were retained.");
    }
  }

  const normalize = (v) => (v ? v.trim().replace(/^v/i, "") : v);
  if (task.type !== "trigger") {
    currentVersion = normalize(currentVersion);
    lastVersion = normalize(lastVersion);
  }

  if (task.type === "trigger") {
    lastVersion = task.trigger_output || null;
    hasUpdate =
      typeof currentVersion === "string" &&
      typeof task.trigger_output === "string" &&
      currentVersion.trim() === task.trigger_output.trim();
  } else {
    hasUpdate = !!(
      lastVersion &&
      currentVersion &&
      lastVersion !== currentVersion
    );
  }

  return { current_version: currentVersion || null, last_version: lastVersion || null, has_update: hasUpdate };
}

/**
 * Poll all custom update tasks for all servers.
 */
async function pollCustomUpdates() {
  if (customUpdatesPolling) return;
  customUpdatesPolling = true;
  const observation = pollingObservations.begin('customUpdates');
  try {
    const servers = db.servers.getAll();
    const outcomes = await Promise.allSettled(
      servers.filter(server => collectionQueue.due('customUpdates', server)).map(async (server) => {
        const tasks = db.customUpdateTasks.getByServer(server.id);
        try {
          await collectionQueue.run('customUpdates', server, async () => {
            const results = [];
            for (const task of tasks) results.push(await checkCustomTask(server, task));
            return results;
          }, {baseMs:getPollingConfig().customUpdates.intervalMs});
        } catch (err) { pollingObservations.fail(observation,server,'Custom update check failed.'); }

      }),
    );
    observation.errors += outcomes.filter(result => result.status === 'rejected').length;
    resourceAlerts.evaluateAll();
    broadcast({ type: "cache_updated", scope: "custom_updates" });
    log.info("Custom update tasks checked");
  } catch (error) {
    observation.errors++;
    throw error;
  } finally {
    pollingObservations.finish('customUpdates', observation);
    customUpdatesPolling = false;
  }
}

/**
 * Set up polling intervals based on current DB config (does not run immediately).
 */
function setupPollingIntervals() {
  const cfg = getPollingConfig();

  if (cfg.info.enabled) {
    infoPoller = makePoller(pollSystemInfo, "System info", cfg.info.intervalMs);
  }

  if (cfg.updates.enabled)
    updatesPoller = makePoller(pollUpdates, "Updates", cfg.updates.intervalMs);
  if (cfg.imageUpdates.enabled)
    imageUpdatesPoller = makePoller(
      pollImageUpdates,
      "Image updates",
      cfg.imageUpdates.intervalMs,
    );
  if (cfg.customUpdates.enabled)
    customUpdatesPoller = makePoller(
      pollCustomUpdates,
      "Custom updates",
      cfg.customUpdates.intervalMs,
    );
  if (cfg.ipamSources.enabled)
    ipamSourcesPoller = makePoller(
      pollIpamSources,
      "IPAM sources",
      cfg.ipamSources.intervalMs,
    );

  log.info(
    {
      info: cfg.info.enabled ? cfg.info.intervalMs / 60000 + "min" : "off",
      updates: cfg.updates.enabled
        ? cfg.updates.intervalMs / 60000 + "min"
        : "off",
      images: cfg.imageUpdates.enabled
        ? cfg.imageUpdates.intervalMs / 60000 + "min"
        : "off",
      custom: cfg.customUpdates.enabled
        ? cfg.customUpdates.intervalMs / 60000 + "min"
        : "off",
      ipamSources: cfg.ipamSources.enabled
        ? cfg.ipamSources.intervalMs / 60000 + "min check"
        : "off",
    },
    "Poller config",
  );
}

/**
 * Start background polling for system info and updates (runs immediately on startup).
 */
function startPolling() {
  const cfg = getPollingConfig();
  if (cfg.info.enabled) runNow(pollSystemInfo, "System info");
  if (cfg.updates.enabled) runNow(pollUpdates, "Updates");
  if (cfg.imageUpdates.enabled) runNow(pollImageUpdates, "Image updates");
  if (cfg.customUpdates.enabled) runNow(pollCustomUpdates, "Custom updates");
  if (cfg.ipamSources.enabled) runNow(pollIpamSources, "IPAM sources");
  setupPollingIntervals();
}

/**
 * Restart pollers with current DB config (called after settings change).
 * Debounced to coalesce rapid successive calls (e.g. bulk settings updates).
 */
let restartPollingTimer = null;
const RESTART_POLLING_DEBOUNCE_MS = 500;
function restartPolling() {
  if (restartPollingTimer) clearTimeout(restartPollingTimer);
  restartPollingTimer = setTimeout(() => {
    restartPollingTimer = null;
    stopPolling();
    collectionQueue.resetSchedule();
    setupPollingIntervals();
    log.info("Poller restarted with new config");
  }, RESTART_POLLING_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced restart immediately (used in tests/shutdown).
 */
function flushRestartPolling() {
  if (restartPollingTimer) {
    clearTimeout(restartPollingTimer);
    restartPollingTimer = null;
    stopPolling();
    collectionQueue.resetSchedule();
    setupPollingIntervals();
    log.info("Poller restarted with new config");
  }
}

/**
 * Called when a WebSocket client connects. If system info is stale, trigger
 * an immediate refresh so the dashboard shows fresh data right away.
 */
function onClientConnect() {
  if (Date.now() - lastInfoPollTime > STALE_THRESHOLD_MS) {
    runNow(pollSystemInfo, "On-connect refresh");
  }
}

/**
 * Stop background polling.
 */
function stopPolling() {
  if (infoPoller) {
    clearInterval(infoPoller);
    infoPoller = null;
  }
  if (updatesPoller) {
    clearInterval(updatesPoller);
    updatesPoller = null;
  }
  if (imageUpdatesPoller) {
    clearInterval(imageUpdatesPoller);
    imageUpdatesPoller = null;
  }
  if (customUpdatesPoller) {
    clearInterval(customUpdatesPoller);
    customUpdatesPoller = null;
  }
  if (ipamSourcesPoller) {
    clearInterval(ipamSourcesPoller);
    ipamSourcesPoller = null;
  }

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
  if (restartPollingTimer) {
    clearTimeout(restartPollingTimer);
    restartPollingTimer = null;
  }
  stopPolling();
  stopJobs();
}

function getRuntimeStatus() {
  const config = getPollingConfig();
  const scheduled = {info:!!infoPoller,updates:!!updatesPoller,imageUpdates:!!imageUpdatesPoller,customUpdates:!!customUpdatesPoller,ipamSources:!!ipamSourcesPoller};
  const active = {info:infoPolling,updates:updatesPolling,imageUpdates:imageUpdatesPolling,customUpdates:customUpdatesPolling,ipamSources:ipamSourcesPolling};
  return {
    checkedAt:new Date().toISOString(),
    scope:'current-process',
    collectionQueue:collectionQueue.snapshot(),
    adaptive:true,
    restartPending:!!restartPollingTimer,
    registeredSchedules:jobs.size,
    runningSchedules:running.size,
    pollers:Object.entries(config).map(([id,value])=>({id,enabled:value.enabled,intervalMin:value.intervalMs/60000,scheduled:scheduled[id],running:active[id],observations:pollingObservations.snapshot(id)})),
  };
}

module.exports = {
  init,
  register,
  unregister,
  reload,
  reloadAllSchedules,
  startPolling,
  stopPolling,
  stopJobs,
  shutdown,
  restartPolling,
  flushRestartPolling,
  onClientConnect,
  checkCustomTask,
  previewCustomTask: performCustomTaskCheck,
  pollIpamSources,
  getPollingConfig,
  collectionStatus: () => collectionQueue.snapshot(),
  getRuntimeStatus,
  getSchedulerTimezone,
  getNextRun,
  getRegistrationStatus: (schedule) => !schedule.enabled ? 'paused' : jobs.has(schedule.id) ? 'registered' : 'unregistered',
  DEFAULTS,
};
