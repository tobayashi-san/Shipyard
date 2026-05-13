const express      = require('express');
const router       = express.Router();
const pluginLoader = require('../services/plugin-loader');
const { adminOnly } = require('../middleware/auth');
const { getPermissions, filterPlugins } = require('../utils/permissions');
const db = require('../db');
const { serverError } = require('../utils/http-error');

// GET /api/plugins — list plugins visible to this user
router.get('/', (req, res) => {
  try {
    const perms = getPermissions(req.user);
    res.json(filterPlugins(pluginLoader.list(), perms));
  } catch (e) {
    serverError(res, e, 'list plugins');
  }
});

// POST /api/plugins/:id/enable  and  POST /api/plugins/:id/disable
router.post('/:id/:action', adminOnly, (req, res) => {
  const { id, action } = req.params;
  if (action !== 'enable' && action !== 'disable') {
    return res.status(404).json({ error: 'Plugin action not found' });
  }

  try {
    pluginLoader.setEnabled(id, action === 'enable');
    db.auditLog.write(`plugin.${action}`, `Plugin ${id} ${action}d`, req.ip, true, req.user?.username);
    res.json({ success: true });
  } catch (e) {
    if (e.message?.includes('not loaded')) return res.status(404).json({ error: e.message });
    serverError(res, e, 'enable/disable plugin');
  }
});

// POST /api/plugins/reload — rescan /app/plugins and hot-reload all plugins
router.post('/reload', adminOnly, (req, res) => {
  try {
    pluginLoader.reloadAll();
    db.auditLog.write('plugin.reload', 'All plugins reloaded', req.ip, true, req.user?.username);
    res.json({ success: true, plugins: pluginLoader.list() });
  } catch (e) {
    serverError(res, e, 'reload plugins');
  }
});

module.exports = router;
