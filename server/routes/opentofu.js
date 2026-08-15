const express = require('express');
const db = require('../db');
const openTofu = require('../features/opentofu');

/**
 * OpenTofu is an integrated Shipyard feature. It is registered directly under
 * /api/opentofu and is deliberately independent from the optional plugin
 * loader and its enable/disable lifecycle.
 */
function createOpenTofuRouter({ broadcast = () => {} } = {}) {
  const router = express.Router();
  openTofu.register({ router, db, broadcast });
  return router;
}

module.exports = { createOpenTofuRouter };
