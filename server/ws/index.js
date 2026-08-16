const { WebSocketServer } = require('ws');
const db = require('../db');
const scheduler = require('../services/scheduler');
const { isAllowedRequestOrigin } = require('../utils/allowed-origins');
const { getPermissions, filterServers, canAccessEnvironment, can } = require('../utils/permissions');
const { parseTargetExpression, targetIncludesServer } = require('../utils/validate');
const { verifyWsAuth, getWsUser } = require('./auth');
const { attachSshTerminal } = require('./ssh-terminal');

function canAccessServer(meta, serverId) {
  const server = db.servers.getById(serverId);
  if (!server) return false;
  if (String(server.environment_id || 'default') !== meta.environmentId) return false;
  if (!meta.perms || meta.perms.full) return true;
  return filterServers([server], meta.perms).length > 0;
}

function getTargetServerIds(targets, environmentId) {
  if (!targets) return [];
  const servers = db.servers.getAll(environmentId);
  const parsed = parseTargetExpression(targets);
  if (parsed.kind === 'pattern') return null;
  return servers
    .filter(server => targetIncludesServer(targets, server.name))
    .map(server => server.id);
}

function getVisibleServerIds(data, environmentId) {
  if (data.serverId) return [data.serverId];

  if (data.historyId) {
    const history = db.db.prepare('SELECT server_id FROM update_history WHERE id = ?').get(data.historyId);
    if (history?.server_id) {
      if (history.server_id === 'bulk_update') return null;
      const server = db.servers.getById(history.server_id);
      if (server) return [server.id];
      return getTargetServerIds(history.server_id, environmentId);
    }
    const workflow = db.scheduleHistory.getById(data.historyId);
    if (workflow?.targets) return getTargetServerIds(workflow.targets, environmentId);
  }

  if (data.runId) {
    const workflow = db.scheduleHistory.getById(data.runId);
    if (workflow?.targets) return getTargetServerIds(workflow.targets, environmentId);
  }

  if (data.scheduleId) {
    const schedule = db.schedules.getById(data.scheduleId);
    if (schedule?.targets) return getTargetServerIds(schedule.targets, environmentId);
  }

  return null;
}

function getEventEnvironment(data) {
  if (data.environmentId) return String(data.environmentId);
  if (data.serverId) return String(db.servers.getById(data.serverId)?.environment_id || '');
  if (data.historyId) {
    const updateEnvironment = db.db.prepare('SELECT environment_id FROM update_history WHERE id = ?').get(data.historyId)?.environment_id;
    if (updateEnvironment) return String(updateEnvironment);
    const workflowEnvironment = db.scheduleHistory.getById(data.historyId)?.environment_id;
    if (workflowEnvironment) return String(workflowEnvironment);
  }
  if (data.runId) return String(db.scheduleHistory.getById(data.runId)?.environment_id || '');
  if (data.scheduleId) return String(db.schedules.getById(data.scheduleId)?.environment_id || '');
  if (data.workspaceId) return String(db.db.prepare('SELECT environment_id FROM tofu_workspaces WHERE id = ?').get(data.workspaceId)?.environment_id || '');
  return '';
}

function canReceiveEventType(data, permissions) {
  const type = String(data.type || '');
  if (!type) return false;

  if (type.startsWith('tofu_') || data.workspaceId) {
    return can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments');
  }
  if (type.startsWith('ansible_')) return can(permissions, 'canViewPlaybooks');
  if (type.startsWith('schedule_') || data.scheduleId) return can(permissions, 'canViewSchedules');
  if (type.startsWith('bulk_update_')) return can(permissions, 'canViewUpdates');
  if (type.startsWith('resource_alert')) return can(permissions, 'canViewServers');

  if (type === 'cache_updated') {
    const scopeCapability = {
      info: 'canViewServers',
      updates: 'canViewUpdates',
      image_updates: 'canViewUpdates',
      custom_updates: 'canViewCustomUpdates',
      ipam: 'canViewNetworks',
    }[String(data.scope || '')];
    return Boolean(scopeCapability && can(permissions, scopeCapability));
  }

  if (type.startsWith('update_')) {
    if (data.historyId) {
      const action = db.db.prepare('SELECT action FROM update_history WHERE id = ?').get(data.historyId)?.action || '';
      if (String(action).startsWith('custom_update:')) return can(permissions, 'canViewCustomUpdates');
      if (String(action).startsWith('restart_docker_') || String(action).startsWith('compose_')) {
        return can(permissions, 'canViewDocker');
      }
    }
    return can(permissions, 'canViewUpdates');
  }

  // Restricted sessions only receive event families with an explicit policy.
  return false;
}

function canReceive(data, meta) {
  const eventEnvironment = getEventEnvironment(data);
  if (eventEnvironment && eventEnvironment !== meta.environmentId) return false;
  if (!meta.perms || meta.perms.full) return true;
  if (!canReceiveEventType(data, meta.perms)) return false;

  // Cache notifications contain no resource payload. OpenTofu runs are
  // environment-scoped rather than managed-host-scoped; their capability and
  // environment checks above are therefore the complete authorization rule.
  const type = String(data.type || '');
  if (type === 'cache_updated' || type.startsWith('tofu_')) return true;

  const serverIds = getVisibleServerIds(data, meta.environmentId);
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
    // Only honor X-Forwarded-Host when an upstream proxy is trusted; otherwise
    // a malicious client could spoof the "same-host" origin check.
    const trustProxy = process.env.TRUST_PROXY === '1';
    const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
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
    const environmentId = String(url.searchParams.get('environment') || 'default').trim() || 'default';
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)
        || !canAccessEnvironment(perms, environmentId)) {
      ws.close(4003, 'Environment access denied');
      return;
    }
    clients.set(ws, { user: wsUser, perms, environmentId });
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

module.exports = { createWebSocketHub, canReceive };
