'use strict';

// Keeps long-lived history from growing without bound. Rows stay, so counts
// and results remain visible; only the full log of old runs is cut down to
// its tail, where the recap and the final error line are.
const log = require('../utils/logger').child('history-retention');
const db = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_DAYS = 90;
const OUTPUT_TAIL_CHARS = 16 * 1024;
const TRIM_MARKER = '[Fleet] Earlier output was removed by history retention.\n…\n';

function outputRetentionDays(env = process.env) {
  const days = parseInt(env.FLEET_HISTORY_OUTPUT_DAYS || '90', 10);
  return Number.isFinite(days) && days >= 1 ? days : 90;
}

function trimOldOutput(days, tailChars = OUTPUT_TAIL_CHARS) {
  return db.db.prepare(`
    UPDATE update_history
    SET output = ? || substr(output, -?)
    WHERE completed_at IS NOT NULL
      AND completed_at < datetime('now', ?)
      AND length(output) > ?
      AND substr(output, 1, length(?)) <> ?
  `).run(TRIM_MARKER, tailChars, `-${days} days`, tailChars + TRIM_MARKER.length, TRIM_MARKER, TRIM_MARKER).changes;
}

function runRetention(env = process.env) {
  const result = { audit: 0, trimmed: 0 };
  try { result.audit = db.auditLog.pruneOlderThan(AUDIT_RETENTION_DAYS)?.changes || 0; }
  catch (err) { log.warn({ err }, 'Audit log retention failed'); }
  try { result.trimmed = trimOldOutput(outputRetentionDays(env)); }
  catch (err) { log.warn({ err }, 'Execution output retention failed'); }
  if (result.audit || result.trimmed) log.info(result, 'History retention applied');
  return result;
}

function startHistoryRetention() {
  runRetention();
  setInterval(runRetention, DAY_MS).unref?.();
}

module.exports = { startHistoryRetention, runRetention, trimOldOutput, outputRetentionDays, TRIM_MARKER };
