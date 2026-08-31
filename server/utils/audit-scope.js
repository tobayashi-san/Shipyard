'use strict';

const db = require('../db');
const { canAccessTargets, filterServers } = require('./permissions');

function auditRowVisibleToServers(row, permissions, environmentId = 'default') {
  if (!permissions) return false;
  if (permissions.full || permissions.servers === 'all') return true;

  const servers = db.servers.getAll(environmentId);
  const visibleServers = filterServers(servers, permissions);
  if (!visibleServers.length) return false;
  const visibleIds = new Set(visibleServers.map(server => String(server.id)));
  const byId = new Map(servers.map(server => [String(server.id), server]));
  const byName = new Map(servers.map(server => [String(server.name), server]));
  const detail = String(row?.detail || '');

  const targetExpression = detail.match(/(?:^|\s)targets=(.+?)(?=\s+(?:status|error|playbook|action)=|$)/)?.[1];
  if (targetExpression) return canAccessTargets(permissions, targetExpression, servers);

  const referencedIds = [];
  for (const match of detail.matchAll(/(?:^|\s)type=server\s+target=([^\s]+)/g)) referencedIds.push(match[1]);
  for (const match of detail.matchAll(/(?:^|\s)server=([^\s]+)/g)) {
    const server = byName.get(match[1]) || byId.get(match[1]);
    if (!server) return false;
    referencedIds.push(server.id);
  }
  for (const match of detail.matchAll(/\bServer "([^"]+)"/g)) {
    const server = byName.get(match[1]);
    if (!server) return false;
    referencedIds.push(server.id);
  }
  if (String(row?.action || '').startsWith('agent.')) {
    const named = detail.match(/\bon (.+?)(?: \(|$)/)?.[1];
    const server = named ? byName.get(named) : null;
    if (!server) return false;
    referencedIds.push(server.id);
  }

  return referencedIds.length > 0 && referencedIds.every(id => visibleIds.has(String(id)));
}

function filterAuditRows(rows, permissions, environmentId = 'default') {
  return (Array.isArray(rows) ? rows : []).filter(row => auditRowVisibleToServers(row, permissions, environmentId));
}

function queryVisibleAuditRows(filters, permissions) {
  const environmentId = filters.environmentId || 'default';
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = db.auditLog.query({ ...filters, limit: 500, offset });
    rows.push(...filterAuditRows(batch, permissions, environmentId));
    if (batch.length < 500) break;
    offset += batch.length;
  }
  return rows;
}

const PRIMARY_CHANGE_PREFIXES = [
  'auth.', 'login.', 'users.', 'roles.', 'system.', 'environment.', 'reset.',
  'ssh.assignment.', 'maintenance_window.', 'schedule.', 'plugin.',
  'server.create', 'server.created', 'server.update', 'server.delete',
  'server.deleted', 'server.hidden', 'server.visible', 'servers.group_',
  'opentofu.install',
];

function filterAuditFocus(rows, focus) {
  if (focus !== 'changes') return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const action = String(row?.action || '').toLowerCase();
    return PRIMARY_CHANGE_PREFIXES.some(prefix => action.startsWith(prefix));
  });
}

module.exports = { auditRowVisibleToServers, filterAuditRows, filterAuditFocus, queryVisibleAuditRows };
