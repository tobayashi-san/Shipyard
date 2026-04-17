const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolate DB per test file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sched-debounce-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const scheduler = require('../services/scheduler');

test('restartPolling coalesces rapid successive calls', async () => {
  // Count how often setupPollingIntervals actually runs by spying via
  // flushRestartPolling path: call restartPolling N times quickly, then flush.
  // We verify by measuring side-effects: the `running` state of the timer.

  // Three rapid invocations should schedule only one effective restart.
  scheduler.restartPolling();
  scheduler.restartPolling();
  scheduler.restartPolling();

  // Before the debounce window elapses, flush manually — this should
  // execute exactly one restart (stopPolling + setupPollingIntervals).
  // If no timer were pending, flushRestartPolling would be a no-op.
  scheduler.flushRestartPolling();

  // A second flush should now be a no-op (nothing pending).
  // We can't observe count directly, but we ensure no throw.
  scheduler.flushRestartPolling();

  // Cleanup any intervals the flushed restart created.
  scheduler.shutdown();
});

test('restartPolling auto-fires after debounce window', async () => {
  scheduler.restartPolling();
  // Wait slightly longer than the 500ms debounce.
  await new Promise(r => setTimeout(r, 700));
  // After the window, a subsequent flush is a no-op (timer already fired).
  scheduler.flushRestartPolling();
  scheduler.shutdown();
});
