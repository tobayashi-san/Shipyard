const { WebSocketServer } = require('ws');
const db = require('../db');
const scheduler = require('../services/scheduler');
const { isAllowedRequestOrigin } = require('../utils/allowed-origins');
const { getPermissions, filterServers } = require('../utils/permissions');
const { parseTargetExpression, targetIncludesServer } = require('../utils/validate');
const { verifyWsAuth, getWsUser } = require('./auth');
const { attachSshTerminal } = require('./ssh-terminal');

function canAccessServer(meta, serverId) {
  if (!meta.perms || meta.perms.full) return true;
  const server = db.servers.getById(serverId);
  if (!server) return false;
  return filterServers([server], meta.perms).length > 0;
}

function getTargetServerIds(targets) {
  if (!targets) return [];
  const servers = db.servers.getAll();
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'pattern') return null;
  return servers
    .filter(server => targetIncludesServer(targets, server.name))
    .map(server => server.id);
}

function getVisibleServerIds(data) {
  if (data.serverId) return [data.serverId];

  if (data.historyId) {
    const history = db.db.prepare('SELECT server_id FROM update_history WHERE id = ?').get(data.historyId);
    if (history?.server_id) {
      if (history.server_id === 'bulk_update') return null;
      const server = db.servers.getById(history.server_id);
      if (server) return [server.id];
      return getTargetServerIds(history.server_id);
    }
  }

  if (data.scheduleId) {
    const schedule = db.schedules.getById(data.scheduleId);
    if (schedule?.targets) return getTargetServerIds(schedule.targets);
  }

  return null;
}

function canReceive(data, meta) {
  if (!meta.perms || meta.perms.full) return true;

  const serverIds = getVisibleServerIds(data);
  if (serverIds === null) {
    return false;
  }
  if (!serverIds.length) {
    return true;
  }

  return serverIds.some(serverId => canAccessServer(meta, serverId));
}

function createWebSocketHub({ server, allowedOrigins }) {
  const wss = new WebSocketServer({ noServer: true });
  const wssSsh = new WebSocketServer({ noServer: true });
  const clients = new Map();

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin && !isAllowedRequestOrigin(allowedOrigins, origin, host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } else if (pathname === '/ws/ssh') {
      wssSsh.handleUpgrade(req, socket, head, ws => wssSsh.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  attachSshTerminal(wssSsh);

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (!verifyWsAuth(ws, url)) return;

    const wsUser = getWsUser(url);
    const perms = getPermissions(wsUser);
    clients.set(ws, { user: wsUser, perms });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    scheduler.onClientConnect();
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const [client, meta] of clients) {
      if (client.readyState !== 1) continue;

      if (!canReceive(data, meta)) continue;

      client.send(msg);
    }
  }

  return { wss, wssSsh, broadcast };
}

module.exports = { createWebSocketHub };
