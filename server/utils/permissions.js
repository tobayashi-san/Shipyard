const db = require('../db');

const FULL = { full: true };

const USER_DEFAULTS = {
  servers: 'all',
  playbooks: 'all',
  plugins: 'all',
  // Servers
  canViewServers:    true,
  canAddServers:     true,
  canEditServers:    true,
  canDeleteServers:  true,
  // Playbooks
  canViewPlaybooks:   true,
  canEditPlaybooks:   true,
  canDeletePlaybooks: true,
  canRunPlaybooks:    true,
  // Schedules
  canViewSchedules:   true,
  canAddSchedules:    true,
  canEditSchedules:   true,
  canDeleteSchedules: true,
  canToggleSchedules: true,
  // Variables
  canViewVars:   true,
  canAddVars:    true,
  canEditVars:   true,
  canDeleteVars: true,
  // Server actions
  canUseTerminal:          true,
  canExportImportServers:  true,
  // Docker
  canViewDocker:           true,
  canPullDocker:           true,
  canRestartDocker:        true,
  canManageDockerCompose:  true,
  // Updates
  canViewUpdates:          true,
  canRunUpdates:           true,
  canRebootServers:        true,
  // Custom update tasks
  canViewCustomUpdates:    true,
  canRunCustomUpdates:     true,
  canEditCustomUpdates:    true,
  canDeleteCustomUpdates:  true,
  // Misc
  canViewAudit: true,
};

// Set of valid boolean permission keys (used by roles.js to reject unknown keys like 'full')
const ALLOWED_PERMISSION_KEYS = new Set(Object.keys(USER_DEFAULTS).filter(k => k !== 'servers' && k !== 'playbooks' && k !== 'plugins'));

function getPermissions(user) {
  if (!user) return null;
  if (user.role === 'admin') return FULL;
  const role = db.roles.getById(user.role);
  if (!role) return { ...USER_DEFAULTS };
  try {
    const p = JSON.parse(role.permissions || '{}');
    return p.full ? FULL : p;
  } catch {
    return { ...USER_DEFAULTS };
  }
}

function filterServers(servers, permissions) {
  if (!permissions || permissions.full) return servers;
  if (permissions.servers === 'all') return servers;
  if (!permissions.servers || typeof permissions.servers !== 'object') return [];
  const { groups = [], servers: ids = [] } = permissions.servers;
  return servers.filter(s => ids.includes(s.id) || (s.group_id && groups.includes(s.group_id)));
}

function filterPlaybooks(playbooks, permissions) {
  if (!permissions || permissions.full) return playbooks;
  if (permissions.playbooks === 'all') return playbooks;
  if (!Array.isArray(permissions.playbooks)) return [];
  return playbooks.filter(p => permissions.playbooks.includes(p.filename));
}

function filterPlugins(plugins, permissions) {
  if (!permissions || permissions.full) return plugins;
  if (permissions.plugins === 'all') return plugins;
  if (!Array.isArray(permissions.plugins)) return [];
  return plugins.filter(p => permissions.plugins.includes(p.id));
}

function can(permissions, capability) {
  if (!permissions || permissions.full) return true;
  // Only deny if explicitly set to false — mirrors frontend hasCap() behaviour
  return permissions[capability] !== false;
}

/**
 * Express middleware: verify the user has access to the server in req.params.id.
 * On success, attaches req.server so downstream handlers don't need to re-fetch.
 */
function guardServerAccess(req, res, next) {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const perms = getPermissions(req.user);
  if (perms && !perms.full) {
    const allowed = filterServers([server], perms);
    if (allowed.length === 0) return res.status(403).json({ error: 'Server access denied' });
  }
  req.server = server;
  next();
}

module.exports = { getPermissions, filterServers, filterPlaybooks, filterPlugins, can, guardServerAccess, ALLOWED_PERMISSION_KEYS };
