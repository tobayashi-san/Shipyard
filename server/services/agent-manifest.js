const fs = require('fs');
const path = require('path');
const db = require('../db');

const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'playbooks', 'system', 'agent', 'files', 'default-manifest.json');

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return 'Manifest must be a JSON object';
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    return 'Manifest.version must be a positive integer';
  }
  if (!Number.isInteger(manifest.interval) || manifest.interval < 5 || manifest.interval > 3600) {
    return 'Manifest.interval must be between 5 and 3600 seconds';
  }
  if (!Array.isArray(manifest.collectors) || manifest.collectors.length === 0) {
    return 'Manifest.collectors must be a non-empty array';
  }
  for (const c of manifest.collectors) {
    if (!c || typeof c !== 'object') return 'Invalid collector entry';
    if (!c.id || typeof c.id !== 'string') return 'Collector.id is required';
    if (!c.cmd || typeof c.cmd !== 'string') return `Collector ${c.id}: cmd is required`;
    if (c.cmd.length > 1000) return `Collector ${c.id}: cmd too long`;
  }
  return null;
}

function normalizeForStorage(manifest, version) {
  return {
    ...manifest,
    version,
    interval: Number.isInteger(manifest.interval) ? manifest.interval : 30,
  };
}

function ensureSeeded() {
  const existing = db.agentManifests.getLatest();
  if (existing) return existing;

  let parsed = {
    version: 1,
    interval: 30,
    collectors: [],
  };
  try {
    const content = fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8');
    parsed = JSON.parse(content);
  } catch {}

  const err = validateManifest(parsed);
  if (err) {
    parsed = {
      version: 1,
      interval: 30,
      collectors: [
        { id: 'load', cmd: 'cat /proc/loadavg', timeout: 3, parser: 'loadavg' },
      ],
    };
  }

  const first = normalizeForStorage(parsed, 1);
  return db.agentManifests.createNext({
    content: JSON.stringify(first),
    createdBy: 'system',
    changelog: 'Initial default manifest',
  });
}

function getLatestParsed() {
  const row = ensureSeeded();
  return {
    ...row,
    parsed: JSON.parse(row.content),
  };
}

function createVersion({ content, createdBy, changelog }) {
  const manifest = typeof content === 'string' ? JSON.parse(content) : content;
  const err = validateManifest(manifest);
  if (err) throw new Error(err);

  const latest = ensureSeeded();
  const version = latest.version + 1;
  const normalized = normalizeForStorage(manifest, version);
  return db.agentManifests.createNext({
    content: JSON.stringify(normalized),
    createdBy,
    changelog,
  });
}

module.exports = {
  ensureSeeded,
  getLatestParsed,
  createVersion,
  validateManifest,
};
