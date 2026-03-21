const express      = require('express');
const router       = express.Router();
const pluginLoader = require('../services/plugin-loader');

// GET /api/plugins — list all plugins
router.get('/', (req, res) => {
  try {
    res.json(pluginLoader.list());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plugins/:id/enable  and  POST /api/plugins/:id/disable
router.post('/:id/:action(enable|disable)', (req, res) => {
  try {
    pluginLoader.setEnabled(req.params.id, req.params.action === 'enable');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/plugins/reload — rescan /app/plugins and hot-reload all plugins
router.post('/reload', (req, res) => {
  try {
    pluginLoader.reloadAll();
    res.json({ success: true, plugins: pluginLoader.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
