const express = require('express');
const path = require('path');
const { Transform } = require('stream');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const { getPermissions, filterServers, can, guardServerAccess } = require('../utils/permissions');
const { serverError } = require('../utils/http-error');

const router = express.Router();
const DEFAULT_MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;

function maxTransferBytes() {
  const configured = Number(process.env.SHIPYARD_MAX_FILE_TRANSFER_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_TRANSFER_BYTES;
}

function remotePath(value, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const raw = String(value || '');
  if (!raw || raw.length > 4096 || raw.includes('\0') || /[\x00-\x1f\x7f]/.test(raw)) {
    const error = new Error('Invalid remote path');
    error.statusCode = 400;
    throw error;
  }
  if (!path.posix.isAbsolute(raw)) {
    const error = new Error('Remote path must be absolute');
    error.statusCode = 400;
    throw error;
  }
  return path.posix.normalize(raw);
}

function allow(capability) {
  return (req, res, next) => can(getPermissions(req.user), capability)
    ? next()
    : res.status(403).json({ error: 'Permission denied' });
}

function audit(req, action, details, success = true) {
  db.auditLog.write(action, details, req.ip, success, req.user?.username || null);
}

router.get('/:id/files', guardServerAccess, allow('canViewFiles'), async (req, res) => {
  try {
    const requestedPath = remotePath(req.query.path, { optional: true });
    res.json(await sshManager.listFiles(req.server, requestedPath));
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'list remote files');
  }
});

router.get('/:id/files/download', guardServerAccess, allow('canViewFiles'), async (req, res) => {
  let requestedPath;
  try {
    requestedPath = remotePath(req.query.path);
    const stream = await sshManager.createReadStream(req.server, requestedPath);
    const filename = path.posix.basename(requestedPath).replace(/["\\\r\n]/g, '_') || 'download';
    res.setHeader('Content-Type', 'application/octet-stream');
    const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`);
    let completed = false;
    res.on('finish', () => {
      completed = true;
      audit(req, 'server.file_download', `server=${req.server.name} path=${requestedPath}`);
    });
    stream.on('error', error => {
      if (!completed) audit(req, 'server.file_download', `server=${req.server.name} path=${requestedPath} error=${error.message}`, false);
      if (!res.headersSent) serverError(res, error, 'download remote file');
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'download remote file');
  }
});

router.get('/:id/files/archive', guardServerAccess, allow('canViewFiles'), async (req, res) => {
  let requestedPath;
  try {
    requestedPath = remotePath(req.query.path);
    const stream = await sshManager.createDirectoryArchiveStream(req.server, requestedPath);
    const directoryName = path.posix.basename(requestedPath) || 'root';
    const filename = `${directoryName.replace(/["\\\r\n]/g, '_')}.tar.gz`;
    const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`);
    let completed = false;
    res.on('finish', () => {
      completed = true;
      audit(req, 'server.directory_download', `server=${req.server.name} path=${requestedPath}`);
    });
    res.on('close', () => {
      if (!completed && !stream.destroyed) stream.destroy();
    });
    stream.on('error', error => {
      if (!completed) audit(req, 'server.directory_download', `server=${req.server.name} path=${requestedPath} error=${error.message}`, false);
      if (!res.headersSent) serverError(res, error, 'download remote directory');
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'download remote directory');
  }
});

router.put('/:id/files/upload', guardServerAccess, allow('canManageFiles'), async (req, res) => {
  let requestedPath;
  try {
    requestedPath = remotePath(req.query.path);
    if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Upload must use application/octet-stream' });
    const overwrite = req.query.overwrite === 'true';
    const declaredLength = Number(req.get('content-length') || 0);
    const maximum = maxTransferBytes();
    if (declaredLength > maximum) return res.status(413).json({ error: 'File exceeds the configured transfer limit' });
    if (!overwrite && await sshManager.remoteFileExists(req.server, requestedPath)) {
      return res.status(409).json({ error: 'A file already exists at the destination' });
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maximum) return callback(Object.assign(new Error('File exceeds the configured transfer limit'), { statusCode: 413 }));
        callback(null, chunk);
      },
    });
    req.pipe(limiter);
    await sshManager.uploadStream(req.server, requestedPath, limiter);
    audit(req, 'server.file_upload', `server=${req.server.name} path=${requestedPath} bytes=${received}`);
    res.status(201).json({ success: true, path: requestedPath, bytes: received });
  } catch (error) {
    audit(req, 'server.file_upload', `server=${req.server?.name || req.params.id} path=${requestedPath || 'invalid'} error=${error.message}`, false);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'upload remote file');
  }
});

router.post('/:id/files/transfer', guardServerAccess, allow('canManageFiles'), async (req, res) => {
  let sourcePath;
  let targetPath;
  try {
    sourcePath = remotePath(req.body?.source_path);
    targetPath = remotePath(req.body?.target_path);
    const targetServer = db.servers.getById(String(req.body?.target_server_id || ''));
    if (!targetServer || String(targetServer.environment_id || 'default') !== String(req.environmentId || 'default')) {
      return res.status(404).json({ error: 'Destination server not found' });
    }
    const permissions = getPermissions(req.user);
    if (filterServers([targetServer], permissions).length === 0) {
      return res.status(403).json({ error: 'Destination server access denied' });
    }
    if (!req.body?.overwrite && await sshManager.remoteFileExists(targetServer, targetPath)) {
      return res.status(409).json({ error: 'A file already exists at the destination' });
    }
    const bytes = await sshManager.transferFile(req.server, sourcePath, targetServer, targetPath, maxTransferBytes());
    audit(req, 'server.file_transfer', `source=${req.server.name}:${sourcePath} destination=${targetServer.name}:${targetPath} bytes=${bytes}`);
    res.status(201).json({ success: true, source_path: sourcePath, target_path: targetPath, target_server_id: targetServer.id, bytes });
  } catch (error) {
    audit(req, 'server.file_transfer', `source=${req.server?.name || req.params.id}:${sourcePath || 'invalid'} destination=${targetPath || 'invalid'} error=${error.message}`, false);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    serverError(res, error, 'transfer remote file');
  }
});

module.exports = router;
