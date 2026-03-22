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
  canManageDocker:         true,
  canExportImportServers:  true,
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

module.exports = { getPermissions, filterServers, filterPlaybooks, filterPlugins, can };
