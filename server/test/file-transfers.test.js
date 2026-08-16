'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { PassThrough, Readable, Writable } = require('stream');
const jwt = require('jsonwebtoken');
process.env.DB_PATH = path.join(os.tmpdir(), `shipyard_file_transfers_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-for-file-transfer-tests';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const db = require('../db');
const { router: authRouter } = require('../routes/auth');
const authMiddleware = require('../middleware/auth');
const fileTransfersRouter = require('../routes/file-transfers');
const sshManager = require('../services/ssh-manager');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api', authMiddleware);
app.use('/api/servers', fileTransfersRouter);

let token;
let source;
let target;
let readOnlyToken;
let sourceOnlyToken;

before(async () => {
  await request(app).post('/api/auth/setup').send({ password: 'testpass12345' });
  const login = await request(app).post('/api/auth/login').send({ password: 'testpass12345' });
  token = login.body.token;
  source = db.servers.create({ name: 'file-source', hostname: 'file-source', ip_address: '10.60.0.10' });
  target = db.servers.create({ name: 'file-target', hostname: 'file-target', ip_address: '10.60.0.11' });
  const readOnlyRole = db.roles.create('File reader', {
    servers: { groups: [], servers: [source.id] },
    canViewFiles: true,
    canManageFiles: false,
  });
  const sourceOnlyRole = db.roles.create('Source file manager', {
    servers: { groups: [], servers: [source.id] },
    canViewFiles: true,
    canManageFiles: true,
  });
  const readOnlyUser = db.users.create('file-reader', '', 'unused', readOnlyRole.id, '');
  const sourceOnlyUser = db.users.create('source-manager', '', 'unused', sourceOnlyRole.id, '');
  readOnlyToken = jwt.sign({ userId: readOnlyUser.id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  sourceOnlyToken = jwt.sign({ userId: sourceOnlyUser.id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
});

after(() => {
  for (const extension of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + extension); } catch {}
  }
});

test('file listing requires an absolute path and returns SFTP metadata', async () => {
  const original = sshManager.listFiles;
  sshManager.listFiles = async (_server, remotePath) => ({
    path: remotePath,
    entries: [{ name: 'release.tar.gz', type: 'file', size: 42, modified_at: 123, permissions: 0o640 }],
  });
  try {
    const invalid = await request(app).get(`/api/servers/${source.id}/files?path=relative`).set('Authorization', `Bearer ${token}`);
    assert.equal(invalid.status, 400);

    const result = await request(app).get(`/api/servers/${source.id}/files?path=${encodeURIComponent('/srv/releases')}`).set('Authorization', `Bearer ${token}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.path, '/srv/releases');
    assert.equal(result.body.entries[0].name, 'release.tar.gz');
  } finally {
    sshManager.listFiles = original;
  }
});

test('download streams the remote file without exposing a local path', async () => {
  const original = sshManager.createReadStream;
  sshManager.createReadStream = async () => Readable.from([Buffer.from('remote contents')]);
  try {
    const result = await request(app)
      .get(`/api/servers/${source.id}/files/download?path=${encodeURIComponent('/srv/release.txt')}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'remote contents');
    assert.match(result.headers['content-disposition'], /release\.txt/);
  } finally {
    sshManager.createReadStream = original;
  }
});

test('directory download streams a gzip archive with a safe filename', async () => {
  const original = sshManager.createDirectoryArchiveStream;
  sshManager.createDirectoryArchiveStream = async () => Readable.from([Buffer.from('gzip archive')]);
  try {
    const result = await request(app)
      .get(`/api/servers/${source.id}/files/archive?path=${encodeURIComponent('/srv/My Project')}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'gzip archive');
    assert.equal(result.headers['content-type'], 'application/gzip');
    assert.match(result.headers['content-disposition'], /My%20Project\.tar\.gz/);
  } finally {
    sshManager.createDirectoryArchiveStream = original;
  }
});

test('SSH manager quotes directory names and streams the remote tar output', async () => {
  const originalGetConnection = sshManager.getConnection;
  const archivePayload = Buffer.from('archive stream');
  let command = '';
  const connection = {
    requestSFTP: async () => ({
      stat: (_path, callback) => callback(null, { isDirectory: () => true }),
    }),
    connection: {
      exec: (value, callback) => {
        command = value;
        const channel = new PassThrough({ autoDestroy: false });
        channel.stderr = new PassThrough({ autoDestroy: false });
        callback(null, channel);
        queueMicrotask(() => {
          channel.write(archivePayload);
          channel.end();
          channel.stderr.end();
          channel.emit('close', 0);
        });
      },
    },
  };
  sshManager.getConnection = async () => connection;
  const directory = "/srv/releases/project'$(touch hacked)";
  try {
    const stream = await sshManager.createDirectoryArchiveStream(source, directory);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), archivePayload);
    assert.equal(command, `LC_ALL=C tar -C '/srv/releases' -czf - -- 'project'"'"'$(touch hacked)'`);
  } finally {
    sshManager.getConnection = originalGetConnection;
    sshManager.refCounts.delete(sshManager._connectionKey(source));
  }
});

test('directory archive accepts SSH servers that report exit status only on exit', async () => {
  const originalGetConnection = sshManager.getConnection;
  const archivePayload = Buffer.from('archive from exit-only server');
  const connection = {
    requestSFTP: async () => ({
      stat: (_path, callback) => callback(null, { isDirectory: () => true }),
    }),
    connection: {
      exec: (_command, callback) => {
        const channel = new PassThrough({ autoDestroy: false });
        channel.stderr = new PassThrough({ autoDestroy: false });
        callback(null, channel);
        queueMicrotask(() => {
          channel.write(archivePayload);
          channel.end();
          channel.stderr.end();
          channel.emit('exit', 0);
          channel.emit('close');
        });
      },
    },
  };
  sshManager.getConnection = async () => connection;
  try {
    const stream = await sshManager.createDirectoryArchiveStream(source, '/srv/releases');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), archivePayload);
  } finally {
    sshManager.getConnection = originalGetConnection;
    sshManager.refCounts.delete(sshManager._connectionKey(source));
  }
});

test('directory archive remains downloadable when a live file changes during tar', async () => {
  const originalGetConnection = sshManager.getConnection;
  const archivePayload = Buffer.from('valid archive with a changing file');
  const connection = {
    requestSFTP: async () => ({
      stat: (_path, callback) => callback(null, { isDirectory: () => true }),
    }),
    connection: {
      exec: (_command, callback) => {
        const channel = new PassThrough({ autoDestroy: false });
        channel.stderr = new PassThrough({ autoDestroy: false });
        callback(null, channel);
        queueMicrotask(() => {
          channel.write(archivePayload);
          channel.end();
          channel.stderr.end('tar: releases/config/database.db: file changed as we read it\n');
          channel.emit('exit', 1);
          channel.emit('close');
        });
      },
    },
  };
  sshManager.getConnection = async () => connection;
  try {
    const stream = await sshManager.createDirectoryArchiveStream(source, '/srv/releases');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), archivePayload);
  } finally {
    sshManager.getConnection = originalGetConnection;
    sshManager.refCounts.delete(sshManager._connectionKey(source));
  }
});

test('upload refuses replacement by default and streams binary data when allowed', async () => {
  const originalExists = sshManager.remoteFileExists;
  const originalUpload = sshManager.uploadStream;
  let received = Buffer.alloc(0);
  sshManager.remoteFileExists = async () => true;
  sshManager.uploadStream = async (_server, _path, input) => {
    const chunks = [];
    for await (const chunk of input) chunks.push(chunk);
    received = Buffer.concat(chunks);
  };
  try {
    const conflict = await request(app)
      .put(`/api/servers/${source.id}/files/upload?path=${encodeURIComponent('/tmp/release.bin')}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('new data'));
    assert.equal(conflict.status, 409);

    const uploaded = await request(app)
      .put(`/api/servers/${source.id}/files/upload?path=${encodeURIComponent('/tmp/release.bin')}&overwrite=true`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('new data'));
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.bytes, 8);
    assert.equal(received.toString(), 'new data');
  } finally {
    sshManager.remoteFileExists = originalExists;
    sshManager.uploadStream = originalUpload;
  }
});

test('server transfer validates both hosts and delegates a bounded stream copy', async () => {
  const originalExists = sshManager.remoteFileExists;
  const originalTransfer = sshManager.transferFile;
  let call;
  sshManager.remoteFileExists = async () => false;
  sshManager.transferFile = async (...args) => { call = args; return 512; };
  try {
    const result = await request(app)
      .post(`/api/servers/${source.id}/files/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ source_path: '/srv/image.raw', target_server_id: target.id, target_path: '/var/tmp/image.raw' });
    assert.equal(result.status, 201);
    assert.equal(result.body.bytes, 512);
    assert.equal(call[0].id, source.id);
    assert.equal(call[2].id, target.id);
    assert.equal(call[4], 1024 * 1024 * 1024);
  } finally {
    sshManager.remoteFileExists = originalExists;
    sshManager.transferFile = originalTransfer;
  }
});

test('file capabilities separate read access from uploads', async () => {
  const originalList = sshManager.listFiles;
  const originalUpload = sshManager.uploadStream;
  sshManager.listFiles = async () => ({ path: '/tmp', entries: [] });
  sshManager.uploadStream = async () => { throw new Error('must not be reached'); };
  try {
    const listed = await request(app)
      .get(`/api/servers/${source.id}/files?path=${encodeURIComponent('/tmp')}`)
      .set('Authorization', `Bearer ${readOnlyToken}`);
    assert.equal(listed.status, 200);

    const uploaded = await request(app)
      .put(`/api/servers/${source.id}/files/upload?path=${encodeURIComponent('/tmp/blocked')}`)
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('blocked'));
    assert.equal(uploaded.status, 403);
  } finally {
    sshManager.listFiles = originalList;
    sshManager.uploadStream = originalUpload;
  }
});

test('server transfer cannot use an inaccessible destination host', async () => {
  const originalTransfer = sshManager.transferFile;
  sshManager.transferFile = async () => { throw new Error('must not be reached'); };
  try {
    const result = await request(app)
      .post(`/api/servers/${source.id}/files/transfer`)
      .set('Authorization', `Bearer ${sourceOnlyToken}`)
      .send({ source_path: '/tmp/source', target_server_id: target.id, target_path: '/tmp/target' });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'Destination server access denied');
  } finally {
    sshManager.transferFile = originalTransfer;
  }
});

test('server transfer cannot cross an environment boundary', async () => {
  const otherEnvironment = db.servers.create({
    name: 'other-environment-target',
    hostname: 'other-environment-target',
    ip_address: '10.61.0.11',
    environment_id: 'staging',
  });
  const originalTransfer = sshManager.transferFile;
  sshManager.transferFile = async () => { throw new Error('must not be reached'); };
  try {
    const result = await request(app)
      .post(`/api/servers/${source.id}/files/transfer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ source_path: '/tmp/source', target_server_id: otherEnvironment.id, target_path: '/tmp/target' });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'Destination server not found');
  } finally {
    sshManager.transferFile = originalTransfer;
  }
});

test('SSH manager streams host-to-host data and enforces the byte limit', async () => {
  const originalGetConnection = sshManager.getConnection;
  const payload = Buffer.from('streamed between managed hosts');
  let destination = Buffer.alloc(0);
  const sourceConnection = {
    requestSFTP: async () => ({
      stat: (_path, callback) => callback(null, { size: payload.length, isFile: () => true }),
      createReadStream: () => Readable.from([payload]),
    }),
  };
  const targetConnection = {
    requestSFTP: async () => ({
      createWriteStream: () => new Writable({
        write(chunk, _encoding, callback) {
          destination = Buffer.concat([destination, chunk]);
          callback();
        },
      }),
    }),
  };
  sshManager.getConnection = async server => server.id === source.id ? sourceConnection : targetConnection;
  try {
    const bytes = await sshManager.transferFile(source, '/source', target, '/target', payload.length);
    assert.equal(bytes, payload.length);
    assert.deepEqual(destination, payload);

    destination = Buffer.alloc(0);
    await assert.rejects(
      () => sshManager.transferFile(source, '/source', target, '/target', payload.length - 1),
      error => error.statusCode === 413,
    );
  } finally {
    sshManager.getConnection = originalGetConnection;
    sshManager.refCounts.delete(sshManager._connectionKey(source));
    sshManager.refCounts.delete(sshManager._connectionKey(target));
  }
});
