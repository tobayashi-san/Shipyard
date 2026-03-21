/**
 * Shipyard Plugin — Backend Entry Point
 *
 * This function is called once when the plugin is loaded.
 *
 * @param {object} ctx
 * @param {import('express').Router} ctx.router       - Express Router, pre-mounted at /api/plugin/<id>/ and auth-protected.
 * @param {object}                   ctx.db           - Shipyard DB instance (better-sqlite3 wrappers).
 * @param {function}                 ctx.broadcast    - Send a WebSocket message to all connected clients.
 * @param {object}                   ctx.sshManager   - SSH helper (execStream, getPrivateKey, …).
 * @param {object}                   ctx.ansibleRunner - Ansible runner (runPlaybook, runAdHoc, …).
 * @param {object}                   ctx.scheduler    - Background polling scheduler.
 * @param {string}                   ctx.pluginId     - The plugin's id (matches the directory name).
 * @param {string}                   ctx.pluginDir    - Absolute path to the plugin directory.
 */
function register({ router, db, broadcast, sshManager, pluginId, pluginDir }) {
  // Example: GET /api/plugin/my-plugin/hello
  router.get('/hello', (req, res) => {
    res.json({ message: `Hello from ${pluginId}!` });
  });

  // Example: GET /api/plugin/my-plugin/servers
  // The auth middleware is already applied — req.user is available if needed.
  router.get('/servers', (req, res) => {
    const servers = db.servers.getAll();
    res.json(servers);
  });

  // Example: broadcast a WebSocket event to all connected clients
  // broadcast({ type: 'plugin_event', pluginId, data: { … } });
}

module.exports = { register };
