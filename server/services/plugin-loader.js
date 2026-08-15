const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const log  = require('../utils/logger').child('plugins');

const PLUGINS_DIR  = process.env.PLUGINS_DIR || '/app/plugins';
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PUBLIC_UI_DIRS = new Set(['assets', 'dist', 'public', 'src']);
const PUBLIC_UI_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.mjs',
  '.png',
  '.svg',
  '.ttf',
  '.wasm',
  '.webp',
  '.woff',
  '.woff2',
]);
const PRIVATE_UI_FILES = new Set([
  'index.js',
  'manifest.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const PRIVATE_UI_DIRS = new Set([
  'data',
  'node_modules',
  'private',
  'secrets',
  'server',
  'storage',
]);

// Operators often keep an on-disk copy while upgrading a plugin. These are
// not plugins and should neither produce startup warnings nor appear as a
// broken plugin in the console.
function isIgnoredPluginDirectory(name) {
  // OpenTofu is a reserved core feature registered from server/routes/opentofu.js.
  // Ignore an on-disk copy left behind by installations that predate the move
  // from plugins/ to server/features/.
  return name === 'opentofu' || name.startsWith('.') || /(?:^|\.)bak(?:\.|$)/i.test(name) || /(?:^|[-_.])backup(?:[-_.]|$)/i.test(name);
}

const _loaded = new Map(); // id -> { manifest, router }
const _failed = new Map(); // id -> error message (plugins that loaded their manifest but threw during register)
let _helpers  = null;

// Plugins execute inside the Shipyard process and must therefore be treated as
// trusted server-side code. Operators can opt into an allowlist by setting
// SHIPYARD_PLUGIN_TRUST_POLICY=enforce and providing id:sha256 pairs in
// SHIPYARD_TRUSTED_PLUGIN_SHA256. "warn" is the production default to keep
// existing installations compatible while exposing the verification state.
const TRUST_POLICY = ['off', 'warn', 'enforce'].includes(process.env.SHIPYARD_PLUGIN_TRUST_POLICY)
  ? process.env.SHIPYARD_PLUGIN_TRUST_POLICY
  : (process.env.NODE_ENV === 'production' ? 'warn' : 'off');

function trustedPluginDigests() {
  const trusted = new Map();
  for (const raw of (process.env.SHIPYARD_TRUSTED_PLUGIN_SHA256 || '').split(',')) {
    const [id, digest] = raw.trim().split(':');
    if (PLUGIN_ID_RE.test(id || '') && /^[a-f0-9]{64}$/i.test(digest || '')) trusted.set(id, digest.toLowerCase());
  }
  return trusted;
}

function pluginDigest(pluginDir) {
  const files = [];
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.bundle-version') continue;
      const rel = path.posix.join(relative, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, rel);
      else if (entry.isFile()) files.push([rel, full]);
    }
  };
  visit(pluginDir);
  files.sort(([a], [b]) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const [relative, full] of files) {
    hash.update(relative).update('\0').update(fs.readFileSync(full)).update('\0');
  }
  return hash.digest('hex');
}

function pluginTrust(id, digest) {
  const expected = trustedPluginDigests().get(id);
  return { digest, trusted: Boolean(expected && expected === digest), policy: TRUST_POLICY };
}

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
  const trust = pluginTrust(id, pluginDigest(pluginDir));
  if (TRUST_POLICY === 'enforce' && !trust.trusted) {
    throw new Error(`Plugin '${id}' is not trusted by SHIPYARD_TRUSTED_PLUGIN_SHA256`);
  }
  if (TRUST_POLICY === 'warn' && !trust.trusted) {
    log.warn({ plugin: id, digest: trust.digest }, 'Loaded untrusted plugin; configure a digest allowlist before enabling strict plugin trust');
  }

  const express        = require('express');
  const authMiddleware = require('../middleware/auth');
  const { pluginApiLimiter } = require('../utils/rate-limiters');
  const pluginRouter   = express.Router();
  pluginRouter.use(pluginApiLimiter);
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

  _loaded.set(id, { manifest, router: pluginRouter, trust });
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
    if (!entry.isDirectory() || isIgnoredPluginDirectory(entry.name)) continue;
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

  for (const [id, { manifest, trust }] of _loaded) {
    result.push({ ...manifest, enabled: isEnabled(id), loaded: true, trust });
    seen.add(id);
  }

  // Also include directories that failed to load (broken plugins)
  if (fs.existsSync(PLUGINS_DIR)) {
    for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || isIgnoredPluginDirectory(entry.name) || seen.has(entry.name)) continue;
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
 * Returns the safe root directory for a plugin's ui.js, or null if not found.
 */
function getUiRoot(id) {
  if (!PLUGIN_ID_RE.test(id)) return null;
  const pluginsRoot = path.resolve(PLUGINS_DIR);
  const pluginDir = path.resolve(pluginsRoot, id);
  if (!pluginDir.startsWith(`${pluginsRoot}${path.sep}`)) return null;
  const uiPath = path.join(pluginDir, 'ui.js');
  try {
    if (!fs.statSync(uiPath).isFile()) return null;
  } catch {
    return null;
  }
  return pluginDir;
}

/**
 * Resolves a frontend asset imported by ui.js.
 *
 * Public plugin UI files may live at the plugin root or below src/, assets/,
 * public/, or dist/. Backend and metadata files stay private.
 */
function getUiAsset(id, requestPath) {
  const uiRoot = getUiRoot(id);
  if (!uiRoot || typeof requestPath !== 'string') return null;
  if (requestPath.includes('\0') || requestPath.includes('\\')) return null;

  const normalized = path.posix.normalize(requestPath.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;

  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts.some(part => PRIVATE_UI_DIRS.has(part))) return null;

  const ext = path.extname(normalized).toLowerCase();
  if (!PUBLIC_UI_EXTENSIONS.has(ext)) return null;

  const rootFile = parts.length === 1;
  if (rootFile && PRIVATE_UI_FILES.has(parts[0].toLowerCase())) return null;
  if (!rootFile && !PUBLIC_UI_DIRS.has(parts[0])) return null;

  const filePath = path.resolve(uiRoot, ...parts);
  if (!filePath.startsWith(`${uiRoot}${path.sep}`)) return null;
  try {
    if (!fs.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return { root: uiRoot, file: normalized, ext };
}

module.exports = {
  loadAll,
  reload,
  reloadAll,
  list,
  isEnabled,
  setEnabled,
  getRouter,
  getUiRoot,
  getUiAsset,
  PLUGINS_DIR,
};
