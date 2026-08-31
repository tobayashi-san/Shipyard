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
  canViewServerHistory: true,
  // Product areas are independent from the managed-host inventory. A role
  // that can see one host must not implicitly see Proxmox or IPAM metadata.
  canViewInfrastructure: true,
  canViewNetworks:       true,
  canEditNetworks:       true,
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
  canViewFiles:            true,
  canManageFiles:          true,
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
  // Notes
  canViewNotes:  true,
  canEditNotes:  true,
  // Operations
  canViewMaintenance: true,
  canEditMaintenance: true,
  // Deployments / OpenTofu
  // `canManageDeployments` is retained as a migration-only umbrella for
  // roles created before the deployment permissions were split. Runtime
  // routes enforce the granular capabilities below.
  canManageDeployments:          true,
  canViewDeployments:            true,
  canEditDeployments:            true,
  canPlanDeployments:            true,
  canApplyDeployments:           true,
  canDestroyDeployments:         true,
  canManageDeploymentPlatforms:  true,
  // Misc
  canViewAudit: true,
};

const DENY_DEFAULTS = Object.fromEntries(
  Object.entries(USER_DEFAULTS).map(([key, value]) => {
    if (Array.isArray(value)) return [key, []];
    if (key === 'servers' || key === 'playbooks' || key === 'plugins') return [key, []];
    return [key, false];
  })
);

// Set of valid boolean permission keys (used by roles.js to reject unknown keys like 'full')
const ALLOWED_PERMISSION_KEYS = new Set(Object.keys(USER_DEFAULTS).filter(k => k !== 'servers' && k !== 'playbooks' && k !== 'plugins'));

function getPermissions(user) {
  if (!user) return null;
  if (user.role === 'admin') return FULL;
  const role = db.roles.getById(user.role);
  if (!role) return { ...DENY_DEFAULTS }; // Fail Closed!
  try {
    const p = JSON.parse(role.permissions || '{}');
    const { full, ...clean } = p;
    if (role.is_system && full) return FULL;
    const defaults = role.is_system ? USER_DEFAULTS : DENY_DEFAULTS;
    // Migrate legacy roles in memory without silently widening newer roles.
    // Saving the role in Settings persists the explicit capability set.
    if (clean.canManageDeployments === true) {
      for (const capability of [
        'canViewDeployments',
        'canEditDeployments',
        'canPlanDeployments',
        'canApplyDeployments',
        'canDestroyDeployments',
        'canManageDeploymentPlatforms',
      ]) {
        if (clean[capability] === undefined) clean[capability] = true;
      }
    }
    return { ...defaults, ...clean };
  } catch {
    return { ...DENY_DEFAULTS }; // Fail Closed!
  }
}

function filterServers(servers, permissions) {
  if (!permissions) return [];
  if (permissions.full) return servers;
  if (permissions.servers === 'all') return servers;
  if (!permissions.servers || typeof permissions.servers !== 'object') return [];
  const { groups = [], servers: ids = [] } = permissions.servers;
  return servers.filter(s => ids.includes(s.id) || (s.group_id && groups.includes(s.group_id)));
}

function filterPlaybooks(playbooks, permissions) {
  if (!permissions) return [];
  if (permissions.full) return playbooks;
  if (permissions.playbooks === 'all') return playbooks;
  if (!Array.isArray(permissions.playbooks)) return [];
  return playbooks.filter(p => permissions.playbooks.includes(p.filename));
}

function filterPlugins(plugins, permissions) {
  if (!permissions) return [];
  if (permissions.full) return plugins;
  if (permissions.plugins === 'all') return plugins;
  if (!Array.isArray(permissions.plugins)) return [];
  return plugins.filter(p => permissions.plugins.includes(p.id));
}

function canAccessPlaybook(permissions, filename) {
  if (!permissions) return false;
  if (permissions.full) return true;
  if (permissions.playbooks === 'all') return true;
  return Array.isArray(permissions.playbooks) && permissions.playbooks.includes(filename);
}

function canAccessPlugin(permissions, pluginId) {
  if (!permissions) return false;
  if (permissions.full) return true;
  if (permissions.plugins === 'all') return true;
  return Array.isArray(permissions.plugins) && permissions.plugins.includes(pluginId);
}

/**
 * Folder access follows the same explicit assignment model as servers.  A
 * group assignment intentionally does not imply access to unrelated sibling
 * folders.  This keeps restricted operators from moving a host into a folder
 * which they are not allowed to administer.
 */
function canAccessServerGroup(permissions, group) {
  if (!permissions || !group) return false;
  if (permissions.full || permissions.servers === 'all') return true;
  const groups = permissions.servers?.groups;
  return Array.isArray(groups) && groups.includes(group.id);
}

/**
 * Environment-scoped resources (IPAM, maintenance, deployments) must not
 * become a side door around a restricted operator's server/folder scope.
 * An administrator and a role with the complete server inventory may access
 * every environment. A restricted role may only access environments which
 * contain at least one explicitly assigned server or server group.
 */
function canAccessEnvironment(permissions, environmentId) {
  if (!permissions || !environmentId) return false;
  if (permissions.full || permissions.servers === 'all') return true;
  const scope = permissions.servers;
  if (!scope || typeof scope !== 'object') return false;
  const serverIds = Array.isArray(scope.servers) ? scope.servers : [];
  const groupIds = Array.isArray(scope.groups) ? scope.groups : [];
  if (!serverIds.length && !groupIds.length) return false;

  if (serverIds.length) {
    const placeholders = serverIds.map(() => '?').join(',');
    const match = db.db.prepare(`SELECT 1 FROM servers WHERE environment_id = ? AND id IN (${placeholders}) LIMIT 1`).get(environmentId, ...serverIds);
    if (match) return true;
  }
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',');
    return Boolean(db.db.prepare(`SELECT 1 FROM server_groups WHERE environment_id = ? AND id IN (${placeholders}) LIMIT 1`).get(environmentId, ...groupIds));
  }
  return false;
}

function guardServerGroupAccess(req, res, next) {
  const group = db.db.prepare('SELECT * FROM server_groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Folder not found.' });
  if (req.environmentId && String(group.environment_id || 'default') !== req.environmentId) {
    return res.status(404).json({ error: 'Folder not found.' });
  }
  const permissions = getPermissions(req.user);
  if (!canAccessServerGroup(permissions, group)) return res.status(403).json({ error: 'Folder access denied.' });
  req.serverGroup = group;
  next();
}

function canAccessTargets(permissions, targets, servers) {
  if (!permissions) return false;
  const { parseTargetExpression, validateKnownInventoryTargets } = require('./validate');
  if (permissions.full || permissions.servers === 'all') {
    return !validateKnownInventoryTargets(targets, servers);
  }

  const parsedTargets = parseTargetExpression(targets);
  if (parsedTargets.kind !== 'list' || parsedTargets.included.length === 0) return false;

  const accessibleNames = new Set(filterServers(servers, permissions).map(s => s.name));
  return parsedTargets.included.every(target => accessibleNames.has(target));
}

function can(permissions, capability) {
  if (!permissions) return false;
  if (permissions.full) return true;
  // Fail-closed enforcement: Capability MUST be explicitly truthy in the permissions object.
  return !!permissions[capability];
}

/**
 * Express middleware: verify the user has access to the server in req.params.id.
 * On success, attaches req.server so downstream handlers don't need to re-fetch.
 */
function guardServerAccess(req, res, next) {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (req.environmentId && String(server.environment_id || 'default') !== req.environmentId) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const perms = getPermissions(req.user);
  if (!perms) return res.status(403).json({ error: 'Permission denied' });
  if (!perms.full) {
    const allowed = filterServers([server], perms);
    if (allowed.length === 0) return res.status(403).json({ error: 'Server access denied' });
  }
  req.server = server;
  next();
}

module.exports = {
  getPermissions,
  filterServers,
  filterPlaybooks,
  filterPlugins,
  canAccessPlaybook,
  canAccessPlugin,
  canAccessServerGroup,
  canAccessEnvironment,
  canAccessTargets,
  can,
  guardServerAccess,
  guardServerGroupAccess,
  ALLOWED_PERMISSION_KEYS,
};
