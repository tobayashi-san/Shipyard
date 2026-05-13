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
    fs.writeFileSync(path.join(pluginDir, name), content, 'utf8');
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
