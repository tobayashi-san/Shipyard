const { executionHostResults } = require('../utils/execution-host-results');
const { validHistoryRange, matchesHistoryRange, historyDay } = require('../utils/history-date-range');
const { executionSummary } = require('../utils/execution-summary');
const { workflowHostIds, canAccessWorkflowHistory } = require('../utils/workflow-history-scope');
const express = require('express');
const db = require('../db');
const { operationName, timestamp } = require('../utils/operation-display');
const {
  can,
  getPermissions,
  filterServers,
} = require('../utils/permissions');

const router = express.Router();
const SOURCE_NAMES = new Set(['Host', 'Deployment', 'Workflow']);
const OPERATION_CAPABILITIES = [
  'canViewDeployments', 'canManageDeployments', 'canViewSchedules',
  'canViewAudit', 'canViewMaintenance', 'canViewServerHistory', 'canViewUpdates',
];

function numericTime(value) {
  if (!value) return Number.NaN;
  const parsed = timestamp(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (['success', 'completed', 'successful'].includes(value)) return 'success';
  if (['failed', 'error'].includes(value)) return 'danger';
  if (['running', 'queued', 'pending', 'cancelling'].includes(value)) return 'info';
  return 'muted';
}

function workflowTargetSummary(value) {
  const raw = String(value || 'all').trim() || 'all';
  if (raw === 'all') return { label: 'All hosts', detail: null };
  const scoped = raw.split(':').map(target => target.trim()).filter(Boolean);
  if (
    scoped[0] === 'all'
    && scoped.length > 1
    && scoped.slice(1).every(target => target.startsWith('!') && target.length > 1)
  ) {
    const excluded = scoped.slice(1).map(target => target.slice(1));
    return {
      label: `All hosts except ${excluded.length <= 2 ? excluded.join(', ') : `${excluded.length} hosts`}`,
      detail: raw,
    };
  }
  const included = raw.split(',').map(target => target.trim()).filter(Boolean);
  if (included.length > 1) {
    return { label: `${included.length} hosts`, detail: raw };
  }
  return { label: included[0] || 'Defined hosts', detail: null };
}

function groupSuccessfulSyncRows(rows) {
  const grouped = new Map();
  const visible = [];
  for (const row of rows) {
    const isSuccessful = row.statusTone === 'success';
    const isPeriodicSync = /\b(sync|synchroni[sz]e|refresh|inventory|gather)\b/i.test(String(row.name || ''));
    if (!isSuccessful || !isPeriodicSync) {
      visible.push(row);
      continue;
    }
    const day = historyDay(row.time) || 'unknown';
    const key = [row.source, row.name, row.target, day].join('\u0000');
    const entries = grouped.get(key) || [];
    entries.push(row);
    grouped.set(key, entries);
  }
  for (const entries of grouped.values()) {
    entries.sort((left, right) => numericTime(right.time) - numericTime(left.time));
    const latest = entries[0];
    visible.push(entries.length === 1 ? latest : {
      ...latest,
      id: `grouped-${latest.id}`,
      name: `${latest.name} · ${entries.length} successful syncs`,
      grouped_count: entries.length,
      executions: entries.map(entry => ({ id: entry.id, time: entry.time })),
    });
  }
  return visible;
}

function canViewOperations(req) {
  const permissions = getPermissions(req.user);
  return Boolean(permissions && OPERATION_CAPABILITIES.some(capability => can(permissions, capability)));
}

function attachAcknowledgements(rows, environmentId) {
  const acknowledgements = new Map(db.db.prepare(`
    SELECT operation_id, acknowledged_at, acknowledged_by
    FROM operation_acknowledgements
    WHERE environment_id = ?
  `).all(environmentId).map(row => [row.operation_id, row]));
  return rows.map(row => {
    const acknowledgement = acknowledgements.get(row.id);
    return {
      ...row,
      acknowledged: Boolean(acknowledgement),
      acknowledged_at: acknowledgement?.acknowledged_at || null,
      acknowledged_by: acknowledgement?.acknowledged_by || null,
    };
  });
}

function isOpenFailure(row) {
  return row.statusTone === 'danger' && !row.acknowledged;
}

function acknowledgeRows(environmentId, rows, username) {
  const insert = db.db.prepare(`
    INSERT INTO operation_acknowledgements
      (environment_id, operation_id, acknowledged_by)
    VALUES (?, ?, ?)
    ON CONFLICT(environment_id, operation_id) DO NOTHING
  `);
  return db.db.transaction((operationRows) => operationRows.reduce(
    (count, row) => count + insert.run(environmentId, row.id, username || null).changes,
    0,
  ))(rows);
}

function permittedRows(req) {
  const permissions = getPermissions(req.user);
  const environmentId = req.environmentId || 'default';
  const rows = [];

  if (can(permissions, 'canViewServerHistory') || can(permissions, 'canViewUpdates')) {
    const visibleIds = new Set(filterServers(db.servers.getAll(environmentId), permissions).map(server => server.id));
    const hostRows = db.db.prepare(`
      SELECT history.*, COALESCE(history.server_name_snapshot, server.name) AS server_name, server.id AS existing_server_id
      FROM update_history history
      LEFT JOIN servers server ON server.id = history.server_id
      WHERE history.environment_id = ?
    `).all(environmentId).filter(row => visibleIds.has(row.server_id) || (!row.existing_server_id && (permissions.full || permissions.servers === 'all')));
    rows.push(...hostRows.map(row => ({
      id: `host-${row.id}`,
      source: 'Host',
      name: operationName(row.action, 'Host'),
      action: row.action,
      target: row.server_name || row.server_id,
      initiator: row.triggered_by || 'Shipyard',
      status: row.status || 'unknown',
      statusTone: statusTone(row.status),
      started_at: row.started_at,
      completed_at: row.completed_at,
      time: row.completed_at || row.started_at,
      target_deleted: !row.existing_server_id,
      href: row.existing_server_id ? '/servers/$id' : null,
      params: row.existing_server_id ? { id: row.server_id } : undefined,
    })));
  }

  if (can(permissions, 'canViewDeployments') || can(permissions, 'canManageDeployments')) {
    const deploymentRows = db.db.prepare(`
      SELECT run.id, run.action, run.status, run.started_by, run.started_at,
             run.completed_at, workspace.id AS workspace_id, workspace.name AS workspace_name,
             vm.id AS vm_id, vm.name AS vm_name
      FROM tofu_runs run
      JOIN tofu_workspaces workspace ON workspace.id = run.workspace_id
      LEFT JOIN tofu_proxmox_vms vm
        ON vm.workspace_id = workspace.id AND vm.is_isolated = 1
      WHERE workspace.environment_id = ?
    `).all(environmentId);
    rows.push(...deploymentRows.map(row => ({
      id: `deployment-${row.id}`,
      source: 'Deployment',
      name: operationName(row.action, 'Deployment'),
      action: row.action,
      target: row.vm_name || row.workspace_name,
      target_detail: row.vm_name && row.vm_name !== row.workspace_name
        ? row.workspace_name
        : undefined,
      initiator: row.started_by || 'OpenTofu',
      status: row.status || 'unknown',
      statusTone: statusTone(row.status),
      started_at: row.started_at,
      completed_at: row.completed_at,
      time: row.completed_at || row.started_at,
      href: '/deployments/$id',
      params: { id: row.vm_id || row.workspace_id },
    })));
  }

  if (can(permissions, 'canViewSchedules')) {
    const servers = db.servers.getAll(environmentId);
    const workflowRows = db.db.prepare(
      `SELECT history.*, schedule.id AS existing_schedule_id FROM schedule_history history LEFT JOIN schedules schedule ON schedule.id = history.schedule_id WHERE history.environment_id = ?`,
    ).all(environmentId).filter(row => canAccessWorkflowHistory(permissions, row, servers));
    rows.push(...workflowRows.map(row => {
      const target = workflowTargetSummary(row.targets);
      return {
        id: `workflow-${row.id}`,
        source: 'Workflow',
        name: row.schedule_name || row.playbook || 'Scheduled task',
        playbook: row.playbook,
        check_mode: Boolean(row.check_mode),
        schedule_deleted: Boolean(row.schedule_id && !row.existing_schedule_id),
        target: target.label,
        target_detail: target.detail || undefined,
        initiator: row.triggered_by || 'Scheduler',
        status: row.status || 'unknown',
        statusTone: statusTone(row.status),
        started_at: row.started_at,
      completed_at: row.completed_at,
      time: row.completed_at || row.started_at,
        href: '/playbooks',
      };
    }));
  }

  return rows;
}

// Resolve an exact execution only after applying the same environment/resource scope as the list.
router.get('/:id/details', (req, res) => {
  if (!canViewOperations(req)) return res.status(403).json({ error: 'Permission denied' });
  const id = String(req.params.id).replace(/^grouped-/, '');
  const row = permittedRows(req).find(item => item.id === id);
  if (!row) return res.status(404).json({ error: 'Execution not found' });
  if (row.source === 'Host' && !can(getPermissions(req.user), 'canViewServerHistory')) {
    return res.status(403).json({ error: 'Host history permission is required to read execution logs.' });
  }
  const table = { Host: 'update_history', Workflow: 'schedule_history', Deployment: 'tofu_runs' }[row.source];
  const executionId = id.slice(id.indexOf('-') + 1);
  const execution = db.db.prepare(`SELECT output, started_at, completed_at FROM ${table} WHERE id = ?`).get(executionId);
  if (!execution) return res.status(404).json({ error: 'Execution not found' });
  const elapsed = timestamp(execution.completed_at) - timestamp(execution.started_at);
  const output = String(execution.output || '');
  const limit = 200000;
  const visibleHosts = can(getPermissions(req.user), 'canViewServers') ? filterServers(db.servers.getAll(req.environmentId || 'default'), getPermissions(req.user)) : [];
  const workflowSnapshot = row.source === 'Workflow' ? db.db.prepare('SELECT targets,target_server_ids FROM schedule_history WHERE id=?').get(executionId) : null;
  const capturedIds = workflowSnapshot ? workflowHostIds(workflowSnapshot) : null;
  const hostResults = row.source === 'Workflow' ? executionHostResults(output).map(result => ({...result, server_id: visibleHosts.find(host => host.name === result.name && (!capturedIds || capturedIds.includes(host.id)))?.id || null})) : [];
  if (workflowSnapshot) {
    const parsed = require('../utils/validate').parseTargetExpression(workflowSnapshot.targets);
    if (parsed.kind === 'list') for (const name of parsed.included) {
      if (!hostResults.some(host => host.name === name)) hostResults.push({name, server_id: visibleHosts.find(host => host.name === name && (!capturedIds || capturedIds.includes(host.id)))?.id || null, status: 'unknown', ok: null, changed: null, failed: null, unreachable: null, duration_seconds: null});
    }
  }
  res.json({
    ...row,
    host_results: hostResults,
    execution_id: executionId,
    duration_seconds: Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 1000) : null,
    summary: executionSummary(row.status, output),
    output: output.slice(-limit),
    output_truncated: output.length > limit,
  });
});

router.get('/', (req, res) => {
  if (!canViewOperations(req)) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const environmentId = req.environmentId || 'default';
  const rows = attachAcknowledgements(
    permittedRows(req),
    environmentId,
  );

  const source = SOURCE_NAMES.has(String(req.query.source || ''))
    ? String(req.query.source)
    : '';
  const query = String(req.query.q || '').trim().toLowerCase().slice(0, 200);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!validHistoryRange(from, to)) return res.status(400).json({ error: 'Invalid history date range' });
  const commonFiltered = groupSuccessfulSyncRows(rows.filter(row => {
    if (source && row.source !== source) return false;
    if (query && !`${row.target} ${row.target_detail || ''} ${row.name} ${row.action || ''} ${row.initiator}`.toLowerCase().includes(query)) return false;
    if (!matchesHistoryRange(row.time, from, to)) return false;
    return true;
  }));
  const counts = {
    all: commonFiltered.length,
    active: commonFiltered.filter(row => ['running', 'queued', 'pending', 'cancelling'].includes(String(row.status).toLowerCase())).length,
    failed: commonFiltered.filter(isOpenFailure).length,
  };
  const scope = ['active', 'failed', 'completed'].includes(String(req.query.scope || ''))
    ? String(req.query.scope)
    : 'all';
  const filtered = commonFiltered.filter(row =>
    scope === 'active'
      ? ['running', 'queued', 'pending', 'cancelling'].includes(String(row.status).toLowerCase())
      : scope === 'completed'
        ? !['running', 'queued', 'pending', 'cancelling'].includes(String(row.status).toLowerCase())
      : scope === 'failed'
        ? isOpenFailure(row)
        : true,
  ).sort((left, right) => {
    const leftActive = ['running', 'queued', 'pending', 'cancelling'].includes(String(left.status).toLowerCase());
    const rightActive = ['running', 'queued', 'pending', 'cancelling'].includes(String(right.status).toLowerCase());
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

router.post('/acknowledge-all', (req, res) => {
  if (!canViewOperations(req)) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const environmentId = req.environmentId || 'default';
  const rows = attachAcknowledgements(permittedRows(req), environmentId).filter(isOpenFailure);
  const acknowledged = acknowledgeRows(environmentId, rows, req.user?.username);
  if (acknowledged > 0) {
    db.auditLog.write(
      'operations.acknowledge_all',
      `Acknowledged ${acknowledged} failed operations`,
      req.ip,
      true,
      req.user?.username,
      environmentId,
    );
  }
  res.json({ acknowledged });
});

router.post('/:id/acknowledge', (req, res) => {
  if (!canViewOperations(req)) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const operationId = String(req.params.id || '').slice(0, 200);
  const environmentId = req.environmentId || 'default';
  const row = permittedRows(req).find(operation => operation.id === operationId);
  if (!row) return res.status(404).json({ error: 'Activity entry not found' });
  if (row.statusTone !== 'danger') {
    return res.status(409).json({ error: 'Only failed activity entries can be acknowledged' });
  }
  const acknowledged = acknowledgeRows(environmentId, [row], req.user?.username);
  const acknowledgement = db.db.prepare(`
    SELECT operation_id, acknowledged_at, acknowledged_by
    FROM operation_acknowledgements
    WHERE environment_id = ? AND operation_id = ?
  `).get(environmentId, operationId);
  if (acknowledged > 0) {
    db.auditLog.write(
      'operations.acknowledge',
      `Acknowledged failed operation ${operationId}`,
      req.ip,
      true,
      req.user?.username,
      environmentId,
    );
  }
  res.json({
    acknowledged: true,
    acknowledged_at: acknowledgement.acknowledged_at,
    acknowledged_by: acknowledgement.acknowledged_by,
  });
});

module.exports = router;
