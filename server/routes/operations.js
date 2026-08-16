const express = require('express');
const db = require('../db');
const {
  can,
  canAccessPlaybook,
  canAccessTargets,
  getPermissions,
} = require('../utils/permissions');
const { filterAuditRows } = require('../utils/audit-scope');

const router = express.Router();
const SOURCE_NAMES = new Set(['Deployment', 'Workflow', 'Audit']);

function numericTime(value) {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (['success', 'completed', 'successful'].includes(value)) return 'success';
  if (['failed', 'error'].includes(value)) return 'danger';
  if (['running', 'queued'].includes(value)) return 'info';
  return 'muted';
}

function permittedRows(req) {
  const permissions = getPermissions(req.user);
  const environmentId = req.environmentId || 'default';
  const rows = [];

  if (can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments')) {
    const deploymentRows = db.db.prepare(`
      SELECT run.id, run.action, run.status, run.started_by, run.started_at,
             run.completed_at, workspace.id AS workspace_id, workspace.name AS workspace_name
      FROM tofu_runs run
      JOIN tofu_workspaces workspace ON workspace.id = run.workspace_id
      WHERE workspace.environment_id = ?
    `).all(environmentId);
    rows.push(...deploymentRows.map(row => ({
      id: `deployment-${row.id}`,
      source: 'Deployment',
      name: row.action || 'OpenTofu run',
      target: row.workspace_name,
      initiator: row.started_by || 'OpenTofu',
      status: row.status || 'unknown',
      statusTone: statusTone(row.status),
      time: row.completed_at || row.started_at,
      href: '/deployments/$id',
      params: { id: row.workspace_id },
    })));
  }

  if (can(permissions, 'canViewSchedules')) {
    const servers = db.servers.getAll(environmentId);
    const workflowRows = db.db.prepare(
      'SELECT * FROM schedule_history WHERE environment_id = ?',
    ).all(environmentId).filter(row =>
      permissions.full || (
        canAccessPlaybook(permissions, row.playbook) &&
        (permissions.servers === 'all' || canAccessTargets(permissions, row.targets, servers))
      ),
    );
    rows.push(...workflowRows.map(row => ({
      id: `workflow-${row.id}`,
      source: 'Workflow',
      name: row.schedule_name || row.playbook || 'Scheduled task',
      target: row.targets || 'Defined hosts',
      initiator: row.triggered_by || 'Scheduler',
      status: row.status || 'unknown',
      statusTone: statusTone(row.status),
      time: row.completed_at || row.started_at,
      href: '/playbooks',
    })));
  }

  if (can(permissions, 'canViewAudit')) {
    const auditRows = filterAuditRows(db.db.prepare(
      'SELECT * FROM audit_log WHERE environment_id = ?',
    ).all(environmentId), permissions, environmentId);
    rows.push(...auditRows.map(row => {
      const succeeded = row.success === true || row.success === 1;
      const failed = row.success === false || row.success === 0;
      return {
        id: `audit-${row.id}`,
        source: 'Audit',
        name: row.action || 'Audit event',
        target: row.detail || 'Fleet console',
        initiator: row.user || 'System',
        status: failed ? 'failed' : succeeded ? 'successful' : 'recorded',
        statusTone: failed ? 'danger' : succeeded ? 'success' : 'muted',
        time: row.created_at,
      };
    }));
  }
  return rows;
}

router.get('/', (req, res) => {
  const rows = permittedRows(req);
  const permissions = getPermissions(req.user);
  if (!permissions || ![
    'canViewDeployments', 'canManageDeployments', 'canViewSchedules', 'canViewAudit', 'canViewMaintenance',
  ].some(capability => can(permissions, capability))) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const source = SOURCE_NAMES.has(String(req.query.source || ''))
    ? String(req.query.source)
    : '';
  const query = String(req.query.q || '').trim().toLowerCase().slice(0, 200);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : null;
  const toTime = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
  const commonFiltered = rows.filter(row => {
    if (source && row.source !== source) return false;
    if (query && !`${row.target} ${row.name} ${row.initiator}`.toLowerCase().includes(query)) return false;
    const time = numericTime(row.time);
    if (fromTime !== null && (!Number.isFinite(time) || time < fromTime)) return false;
    if (toTime !== null && (!Number.isFinite(time) || time > toTime)) return false;
    return true;
  });
  const counts = {
    all: commonFiltered.length,
    active: commonFiltered.filter(row => ['running', 'queued'].includes(String(row.status).toLowerCase())).length,
    failed: commonFiltered.filter(row => row.statusTone === 'danger').length,
  };
  const scope = ['active', 'failed'].includes(String(req.query.scope || ''))
    ? String(req.query.scope)
    : 'all';
  const filtered = commonFiltered.filter(row =>
    scope === 'active'
      ? ['running', 'queued'].includes(String(row.status).toLowerCase())
      : scope === 'failed'
        ? row.statusTone === 'danger'
        : true,
  ).sort((left, right) => {
    const leftActive = ['running', 'queued'].includes(String(left.status).toLowerCase());
    const rightActive = ['running', 'queued'].includes(String(right.status).toLowerCase());
    return Number(rightActive) - Number(leftActive) || numericTime(right.time) - numericTime(left.time);
  });
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 10));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const offset = (page - 1) * pageSize;
  res.json({
    items: filtered.slice(offset, offset + pageSize),
    page,
    page_size: pageSize,
    total: filtered.length,
    total_pages: totalPages,
    counts,
  });
});

module.exports = router;
