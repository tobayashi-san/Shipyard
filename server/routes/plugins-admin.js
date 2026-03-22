const express      = require('express');
const router       = express.Router();
const pluginLoader = require('../services/plugin-loader');
const { adminOnly } = require('../middleware/auth');
const { getPermissions, filterPlugins } = require('../utils/permissions');

// GET /api/plugins — list plugins visible to this user
router.get('/', (req, res) => {
  try {
    const perms = getPermissions(req.user);
    res.json(filterPlugins(pluginLoader.list(), perms));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plugins/:id/enable  and  POST /api/plugins/:id/disable
router.post('/:id/:action(enable|disable)', adminOnly, (req, res) => {
  try {
    pluginLoader.setEnabled(req.params.id, req.params.action === 'enable');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/plugins/reload — rescan /app/plugins and hot-reload all plugins
router.post('/reload', adminOnly, (req, res) => {
  try {
    pluginLoader.reloadAll();
    res.json({ success: true, plugins: pluginLoader.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
