'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lab_test_plugin_ui_'));
process.env.DB_PATH = path.join(tmpRoot, 'test.db');
process.env.JWT_SECRET = 'test-jwt-secret-plugin-ui';
process.env.NODE_ENV = 'test';
process.env.PLUGINS_DIR = path.join(tmpRoot, 'plugins');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const db = require('../db');
const { createApp } = require('../app');

fs.mkdirSync(process.env.PLUGINS_DIR, { recursive: true });

function writePlugin(id, files = {}) {
  const pluginDir = path.join(process.env.PLUGINS_DIR, id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id, name: id }), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(pluginDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('serves ui.js only from an enabled plugin directory', async () => {
  writePlugin('safe_plugin', { 'ui.js': 'window.safePluginLoaded = true;\n' });
  db.settings.set('plugin_safe_plugin_enabled', '1');

  const { app } = createApp();
  const res = await request(app).get('/plugins/safe_plugin/ui.js');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/javascript/);
  assert.equal(res.text, 'window.safePluginLoaded = true;\n');
});

test('rejects invalid plugin UI path inputs', async () => {
  const { app } = createApp();
  const invalidPaths = [
    '/plugins/%2e%2e/ui.js',
    '/plugins/bad.plugin/ui.js',
    '/plugins/x%2fy/ui.js',
    '/plugins/x/y/ui.js',
  ];

  for (const url of invalidPaths) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404);
  }
});

test('returns 404 when enabled plugin has no ui.js', async () => {
  writePlugin('no_ui');
  db.settings.set('plugin_no_ui_enabled', '1');

  const { app } = createApp();
  const res = await request(app).get('/plugins/no_ui/ui.js');

  assert.equal(res.status, 404);
  assert.match(res.text, /ui\.js not found/);
});

test('serves frontend assets imported by an enabled plugin ui module', async () => {
  writePlugin('asset_plugin', {
    'ui.js': 'import { ensureStyles } from "./src/styles.js";\n',
    'src/styles.js': 'export function ensureStyles() {}\n',
    'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  });
  db.settings.set('plugin_asset_plugin_enabled', '1');

  const { app } = createApp();
  const jsRes = await request(app).get('/plugins/asset_plugin/src/styles.js');
  const svgRes = await request(app).get('/plugins/asset_plugin/assets/icon.svg');

  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers['content-type'], /application\/javascript/);
  assert.equal(jsRes.text, 'export function ensureStyles() {}\n');
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers['content-type'], /image\/svg\+xml/);
});

test('does not serve plugin frontend assets when plugin is disabled', async () => {
  writePlugin('disabled_assets', {
    'ui.js': 'import "./src/styles.js";\n',
    'src/styles.js': 'export const ok = true;\n',
  });

  const { app } = createApp();
  const res = await request(app).get('/plugins/disabled_assets/src/styles.js');

  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/javascript/);
  assert.match(res.text, /not found or not enabled/);
});

test('rejects private plugin files and unsafe asset paths', async () => {
  writePlugin('private_assets', {
    'ui.js': 'export function mount() {}\n',
    'index.js': 'module.exports = {};\n',
    'manifest.json': '{"id":"private_assets","name":"private_assets"}',
    'data/devices.js': 'export const secret = true;\n',
    'src/.hidden.js': 'export const hidden = true;\n',
  });
  db.settings.set('plugin_private_assets_enabled', '1');

  const { app } = createApp();
  const blockedPaths = [
    '/plugins/private_assets/index.js',
    '/plugins/private_assets/manifest.json',
    '/plugins/private_assets/data/devices.js',
    '/plugins/private_assets/src/.hidden.js',
    '/plugins/private_assets/src/../index.js',
  ];

  for (const url of blockedPaths) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /application\/javascript/);
  }
});
