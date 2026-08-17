'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { downloadFile } = require('../features/opentofu/proxmox-client');

function fakeRequest(responseFactory) {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = error => request.emit('error', error);
  process.nextTick(responseFactory);
  return request;
}

test('OpenTofu downloads complete through HTTPS and write the requested file', async () => {
  const originalGet = https.get;
  const destination = path.join(os.tmpdir(), `shipyard-tofu-download-${Date.now()}`);
  https.get = (_url, _options, callback) => fakeRequest(() => {
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = { 'content-length': '7' };
    callback(response);
    response.end('archive');
  });

  try {
    await downloadFile('https://example.invalid/tofu.zip', destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'archive');
  } finally {
    https.get = originalGet;
    try { fs.unlinkSync(destination); } catch {}
  }
});

test('OpenTofu downloads reject insecure redirects without leaving a partial file', async () => {
  const originalGet = https.get;
  const destination = path.join(os.tmpdir(), `shipyard-tofu-redirect-${Date.now()}`);
  https.get = (_url, _options, callback) => fakeRequest(() => {
    const response = new PassThrough();
    response.statusCode = 302;
    response.headers = { location: 'http://example.invalid/tofu.zip' };
    callback(response);
    response.end();
  });

  try {
    await assert.rejects(
      () => downloadFile('https://example.invalid/tofu.zip', destination),
      /require HTTPS/,
    );
    assert.equal(fs.existsSync(destination), false);
  } finally {
    https.get = originalGet;
    try { fs.unlinkSync(destination); } catch {}
  }
});
