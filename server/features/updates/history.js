const db = require('../../db');
const { can, filterServers, getPermissions } = require('../../utils/permissions');
const { canAccessWorkflowHistory, workflowHostIds } = require('../../utils/workflow-history-scope');

const LIMIT = 30;

// Recent patching activity: single-host updates and reboots plus bulk and
// scheduled update.yml runs, limited to what the caller may already see.
function updateHistory(req, res) {
  const permissions = getPermissions(req.user);
  if (!can(permissions, 'canViewServers') || !can(permissions, 'canViewUpdates')) {
    return res.status(403).json({ error: 'Permission denied' });
  }
  const environmentId = req.environmentId || 'default';
  const servers = db.servers.getAll(environmentId);
  const visible = new Map(filterServers(servers, permissions).map(server => [server.id, server]));
  const customRuns = can(permissions, 'canViewCustomUpdates') ? " OR action LIKE 'custom\\_update:%' ESCAPE '\\'" : '';
  const hostRows = db.db.prepare(`SELECT id, server_id, server_name_snapshot, action, status, started_at, completed_at, triggered_by
    FROM update_history WHERE environment_id = ? AND (action IN ('system_update', 'reboot')${customRuns}) ORDER BY started_at DESC LIMIT ?`).all(environmentId, LIMIT * 2)
    .filter(row => visible.has(row.server_id))
    .map(row => ({
      id: `host-${row.id}`,
      kind: row.action === 'reboot' ? 'reboot' : 'update',
      name: row.action === 'reboot' ? 'Reboot' : row.action.startsWith('custom_update:') ? `App update: ${row.action.slice('custom_update:'.length)}` : 'System update',
      hosts: [visible.get(row.server_id)?.name || row.server_name_snapshot || 'Unknown host'],
      status: row.status, started_at: row.started_at, completed_at: row.completed_at, triggered_by: row.triggered_by,
    }));
  const workflowRows = db.db.prepare(`SELECT id, schedule_id, schedule_name, playbook, targets, target_server_ids, status, started_at, completed_at, triggered_by
    FROM schedule_history WHERE environment_id = ? AND playbook = 'update.yml' ORDER BY started_at DESC LIMIT ?`).all(environmentId, LIMIT * 2)
    .filter(row => canAccessWorkflowHistory(permissions, row, servers))
    .map(row => {
      const ids = workflowHostIds(row);
      return {
        id: `workflow-${row.id}`,
        kind: 'update',
        name: row.schedule_name || 'System update',
        // Older runs only stored their target expression; show it as a list of names.
        hosts: ids ? ids.map(id => visible.get(id)?.name).filter(Boolean) : String(row.targets || 'all').split(',').map(name => name.trim()).filter(Boolean),
        status: row.status, started_at: row.started_at, completed_at: row.completed_at, triggered_by: row.triggered_by || (row.schedule_id ? 'Schedule' : null),
      };
    });
  res.json([...hostRows, ...workflowRows].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, LIMIT));
};

module.exports = updateHistory;
