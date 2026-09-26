'use strict';

// Containers, logs, image update checks and Compose files of one host. Mounted
// by the servers router after its other /:id routes, so route order is unchanged.
const express = require('express');
const router = express.Router();
const log = require('../utils/logger').child('routes:servers');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const ansibleRunner = require('../services/ansible-runner');
const { refreshDockerCache } = require('../services/docker-inventory');
const resourceAlerts = require('../services/resource-alerts');
const { collectionQueue } = require('../services/collection-queue');
const { parseImageUpdateReport } = require('../utils/parse-image-updates');
const { updateCatalogAge } = require('../utils/update-catalog-age');
const { serverError } = require('../utils/http-error');
const { getPermissions, can, guardServerAccess } = require('../utils/permissions');

function guard(cap) {
  return (req, res, next) => {
    if (!can(getPermissions(req.user), cap)) return res.status(403).json({ error: 'Permission denied' });
    next();
  };
}

function buildDockerResponse(serverId) {
  const containers = db.dockerContainers.getByServer(serverId);
  const composeProjects = db.composeProjects.getByServer(serverId);
  const activeProjects = new Set(containers.map(c => c.compose_project).filter(Boolean));
  for (const cp of composeProjects) {
    if (!activeProjects.has(cp.project_name)) {
      containers.push({
        id: `compose-${cp.id}`,
        server_id: serverId,
        container_name: '[Stack Offline]',
        image: '-',
        state: 'exited',
        status: 'Down',
        created_at_container: cp.created_at,
        compose_project: cp.project_name,
        compose_working_dir: cp.working_dir,
      });
    }
  }
  return containers;
}

// refreshDockerCache moved to ../services/docker-inventory.js

// GET /api/servers/:id/docker - Get docker containers (stale-while-revalidate)
router.get('/:id/docker', guardServerAccess, guard('canViewDocker'), async (req, res) => {
  const server = req.server;

  const cached = buildDockerResponse(req.params.id);
  const force = req.query.force === '1';

  if (cached.length > 0 && !force) {
    res.json(cached.map(c => ({ ...c, _cached: true })));
    refreshDockerCache(server).catch(err => { log.debug({ err, server: server.name }, 'Background docker cache refresh failed'); });
    return;
  }

  try {
    const refreshed = await refreshDockerCache(server);
    if (!refreshed) {
      if (cached.length > 0) return res.json(cached.map(c => ({ ...c, _cached: true })));
      return res.status(502).json({ error: 'Docker inventory could not be loaded from this host. Check its SSH connection and Docker permissions.' });
    }
    res.json(buildDockerResponse(req.params.id));
  } catch (error) {
    if (cached.length > 0) return res.json(cached);
    serverError(res, error, 'get docker containers');
  }
});

// GET /api/servers/:id/docker/:container/logs
router.get('/:id/docker/:container/logs', guardServerAccess, guard('canViewDocker'), async (req, res) => {
  const server = req.server;

  const container = req.params.container;
  if (container.length > 128 || !/^[a-zA-Z0-9_.-]+$/.test(container) || container.startsWith('-')) {
    return res.status(400).json({ error: 'Invalid container name' });
  }

  const tailRaw = parseInt(req.query.tail, 10);
  const tail = Math.max(1, Math.min(Number.isFinite(tailRaw) ? tailRaw : 200, 2000));

  try {
    // A single-host read should not depend on a locally installed Ansible
    // binary. Use the same trusted SSH connection as Files and Terminal, then
    // elevate non-interactively only when the SSH user cannot access Docker.
    const command = [
      'runtime="$(command -v docker 2>/dev/null || command -v podman 2>/dev/null)"',
      'if [ -z "$runtime" ]; then echo "Docker or Podman is not installed" >&2; exit 127; fi',
      `if [ "$(id -u)" -eq 0 ] || "$runtime" info >/dev/null 2>&1; then "$runtime" logs --tail ${tail} --timestamps -- '${container}' 2>&1`,
      `elif command -v sudo >/dev/null 2>&1; then sudo -n "$runtime" logs --tail ${tail} --timestamps -- '${container}' 2>&1`,
      'else echo "Docker access denied and sudo is unavailable" >&2; exit 126; fi',
    ].join('; ');
    const result = await sshManager.execCommand(server, command);
    if (result.code !== 0) {
      const detail = String(result.stdout || result.stderr || 'Failed to get container logs').trim().slice(-2000);
      return res.status(502).json({ error: detail || 'Failed to get container logs' });
    }
    res.json({ logs: result.stdout || '' });
  } catch (error) {
    serverError(res, error, 'get container logs');
  }
});

// GET /api/servers/:id/docker/image-updates/cached - Return cached image update results (no SSH)
router.get('/:id/docker/image-updates/cached', guardServerAccess, guard('canViewDocker'), guard('canViewUpdates'), (req, res) => {
  const cached = db.dockerImageUpdatesCache.getWithMeta(req.params.id);
  res.json({ results: cached?.results || [], updated_at: cached?.updated_at || null, source: 'Container registry digest comparison over SSH', ...updateCatalogAge(cached?.updated_at, db.settings.get('poll_image_updates_interval_min') || 360) });
});

// Images excluded from update checks, e.g. locally built images without a registry.
router.get('/:id/docker/image-check-exclusions', guardServerAccess, guard('canViewDocker'), (req, res) => {
  res.json(db.dockerImageCheckExclusions.list(req.params.id));
});

router.put('/:id/docker/image-check-exclusions', guardServerAccess, guard('canEditServers'), (req, res) => {
  const image = typeof req.body?.image === 'string' ? req.body.image.trim() : '';
  if (!image || image.length > 512 || /[\u0000-\u001f]/.test(image)) return res.status(400).json({ error: 'A valid image reference is required.' });
  if (typeof req.body?.excluded !== 'boolean') return res.status(400).json({ error: 'excluded must be true or false.' });
  const server = req.server;
  const changed = req.body.excluded
    ? db.dockerImageCheckExclusions.add(server.id, image, req.user?.username)
    : db.dockerImageCheckExclusions.remove(server.id, image);
  if (changed) {
    db.auditLog.write(req.body.excluded ? 'docker.image_check_excluded' : 'docker.image_check_included', `Image ${JSON.stringify(image)} on ${JSON.stringify(server.name)} ${req.body.excluded ? 'excluded from' : 'included in'} update checks; server_id=${JSON.stringify(server.id)}`, req.ip, true, req.user?.username, server.environment_id || 'default');
    resourceAlerts.evaluateServer(server.id);
  }
  res.json(db.dockerImageCheckExclusions.list(server.id));
});

// GET /api/servers/:id/docker/image-updates - Check for image updates
router.get('/:id/docker/image-updates', guardServerAccess, guard('canPullDocker'), async (req, res) => {
  const server = req.server;
  try {
    const report = await collectionQueue.run('imageUpdates', server, async () => {
      const result = await ansibleRunner.runPlaybook(
        'check-image-updates.yml', server.name, {}, null,
        { environmentId: server.environment_id || 'default' },
      );
      const report = parseImageUpdateReport(result.stdout);
      if (!result.success || !report.complete) throw Object.assign(new Error('Image update check did not complete. Existing results were kept.'), {code:'IMAGE_CHECK_INCOMPLETE'});
      return report;
    }, {priority:2,baseMs:require('../services/scheduler').getPollingConfig().imageUpdates.intervalMs});
    db.dockerImageUpdatesCache.set(server.id, report.results);
    resourceAlerts.evaluateServer(server.id);
    res.json(db.dockerImageCheckExclusions.apply(server.id, report.results));
  } catch (error) {
    db.checkAttempts.failed(server.id, 'images', 'Image check failed. Check host connectivity, container runtime and registry access.');
    if (error.code === 'IMAGE_CHECK_INCOMPLETE') return res.status(502).json({error:error.message});
    serverError(res, error, 'get docker image updates');
  }
});


// GET /api/servers/:id/docker/compose - Read docker-compose.yml
router.get('/:id/docker/compose', guardServerAccess, guard('canManageDockerCompose'), async (req, res) => {
  try {
    const { path } = req.query;

    if (typeof path !== 'string' || path.length === 0) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
    if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) {
      return res.status(400).json({ error: 'Invalid path format' });
    }

    const server = req.server;

    const safePath = path.replace(/'/g, "'\\''");
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'command',
      `cat '${safePath}/docker-compose.yml'`,
      () => {}, // silence output
      { become: true, environmentId: server.environment_id || 'default' }
    );

    if (result.success) {
      // Strip ansible "host | CHANGED | rc=0 >>" preamble
      let content = result.stdout;
      const match = content.match(/rc=\d+\s*>>\n([\s\S]*)/);
      if (match) {
        content = match[1];
      }
      res.json({ content });
    } else {
      res.status(500).json({ error: 'Failed to read docker-compose.yml. It might not exist in this directory.' });
    }
  } catch (error) {
    serverError(res, error, 'get docker compose');
  }
});

module.exports = router;
