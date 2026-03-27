const fs   = require('fs');
const path = require('path');
const log  = require('../utils/logger').child('plugins');

const PLUGINS_DIR  = process.env.PLUGINS_DIR || '/app/plugins';
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const _loaded = new Map(); // id -> { manifest, router }
const _failed = new Map(); // id -> error message (plugins that loaded their manifest but threw during register)
let _helpers  = null;

// ── DB helpers ──────────────────────────────────────────────────────────────

function _db()          { return require('../db'); }
function isEnabled(id)  { if (!PLUGIN_ID_RE.test(id)) return false; return _db().settings.get(`plugin_${id}_enabled`) === '1'; }

function setEnabled(id, enabled) {
  if (!_loaded.has(id)) throw new Error(`Plugin '${id}' is not loaded`);
  _db().settings.set(`plugin_${id}_enabled`, enabled ? '1' : '0');
}

// ── Manifest ────────────────────────────────────────────────────────────────

function _readManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found');
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { throw new Error(`manifest.json parse error: ${e.message}`); }
  if (!m.id || !PLUGIN_ID_RE.test(m.id)) throw new Error('manifest.id is missing or invalid (must be lowercase a-z, 0-9, - or _)');
  if (m.id !== path.basename(pluginDir))  throw new Error(`manifest.id "${m.id}" must match the directory name "${path.basename(pluginDir)}"`);
  if (!m.name) throw new Error('manifest.name is required');
  return m;
}

// ── Loader ──────────────────────────────────────────────────────────────────

function _loadOne(pluginDir) {
  const manifest = _readManifest(pluginDir);
  const { id }   = manifest;

  const express        = require('express');
  const authMiddleware = require('../middleware/auth');
  const pluginRouter   = express.Router();
  pluginRouter.use(authMiddleware);

  const indexPath = path.join(pluginDir, 'index.js');
  if (fs.existsSync(indexPath)) {
    // Clear from require cache so repeated reload() calls work
    delete require.cache[require.resolve(indexPath)];
    const mod = require(indexPath);
    if (typeof mod.register === 'function') {
      mod.register({ ..._helpers, router: pluginRouter, pluginId: id, pluginDir });
    }
  }

  _loaded.set(id, { manifest, router: pluginRouter });
  return manifest;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called once at server startup with the shared helper context.
 * helpers = { db, broadcast, sshManager, ansibleRunner, scheduler }
 */
function loadAll(helpers) {
  _helpers = helpers;
  if (!fs.existsSync(PLUGINS_DIR)) return;
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(PLUGINS_DIR, entry.name);
    try {
      _loadOne(pluginDir);
      _failed.delete(entry.name);
      log.info({ plugin: entry.name }, 'Loaded plugin');
    } catch (e) {
      _failed.set(entry.name, e.message || String(e));
      log.warn({ err: e, plugin: entry.name }, 'Failed to load plugin');
    }
  }
}

/**
 * Reload a single plugin from disk (hot-reload without restart).
 */
function reload(id) {
  if (!_helpers) throw new Error('Plugin loader not initialized');
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Invalid plugin ID: ${id}`);
  const pluginDir = path.join(PLUGINS_DIR, id);
  if (!fs.existsSync(pluginDir)) throw new Error(`Plugin directory not found: ${id}`);
  try {
    _loadOne(pluginDir);
    _failed.delete(id);
  } catch (e) {
    _failed.set(id, e.message || String(e));
    throw e;
  }
}

/**
 * Reload all plugins (scans directory again for new ones too).
 */
function reloadAll() {
  if (!_helpers) throw new Error('Plugin loader not initialized');
  _loaded.clear();
  _failed.clear();
  loadAll(_helpers);
}

/**
 * Returns an array of all known plugins (loaded + failed to load).
 */
function list() {
  const result = [];
  const seen   = new Set();

  for (const [id, { manifest }] of _loaded) {
    result.push({ ...manifest, enabled: isEnabled(id), loaded: true });
    seen.add(id);
  }

  // Also include directories that failed to load (broken plugins)
  if (fs.existsSync(PLUGINS_DIR)) {
    for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const pluginDir = path.join(PLUGINS_DIR, entry.name);
      const loadError = _failed.get(entry.name) || null;
      try {
        const manifest = _readManifest(pluginDir);
        result.push({ ...manifest, enabled: false, loaded: false, error: loadError || 'Plugin not loaded' });
      } catch (e) {
        result.push({ id: entry.name, name: entry.name, enabled: false, loaded: false, error: loadError || e.message });
      }
    }
  }

  return result.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
}

/**
 * Returns the Express router for a plugin (only if the plugin is enabled).
 */
function getRouter(id) {
  if (!isEnabled(id)) return null;
  return _loaded.get(id)?.router || null;
}

/**
 * Returns the absolute path to a plugin's ui.js, or null if not found.
 */
function getUiPath(id) {
  if (!PLUGIN_ID_RE.test(id)) return null;
  const uiPath = path.join(PLUGINS_DIR, id, 'ui.js');
  return fs.existsSync(uiPath) ? uiPath : null;
}

module.exports = { loadAll, reload, reloadAll, list, isEnabled, setEnabled, getRouter, getUiPath, PLUGINS_DIR };
