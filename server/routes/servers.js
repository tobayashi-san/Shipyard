const express = require('express');
const router = express.Router();
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const systemInfo = require('../services/system-info');
const ansibleRunner = require('../services/ansible-runner');

// GET /api/servers - List all servers
router.get('/', (req, res) => {
  try {
    const servers = db.servers.getAll().map(s => ({
      ...s,
      tags: JSON.parse(s.tags || '[]'),
      services: JSON.parse(s.services || '[]'),
    }));
    res.json(servers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/export?format=json|csv
router.get('/export', (req, res) => {
  try {
    const servers = db.servers.getAll().map(s => ({
      name:        s.name,
      hostname:    s.hostname,
      ip_address:  s.ip_address,
      ssh_port:    s.ssh_port,
      ssh_user:    s.ssh_user,
      tags:        JSON.parse(s.tags     || '[]'),
      services:    JSON.parse(s.services || '[]'),
    }));

    const format = (req.query.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) return res.status(400).json({ error: 'Invalid format. Use json or csv.' });

    if (format === 'csv') {
      const escape = v => {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = 'name,hostname,ip_address,ssh_port,ssh_user,tags,services';
      const rows = servers.map(s =>
        [s.name, s.hostname, s.ip_address, s.ssh_port, s.ssh_user,
         JSON.stringify(s.tags), JSON.stringify(s.services)].map(escape).join(',')
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="servers.csv"');
      return res.send([header, ...rows].join('\r\n'));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="servers.json"');
    res.json(servers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/import
router.post('/import', (req, res) => {
  try {
    const { servers } = req.body;
    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: 'No server data found' });
    }

    const existingAll = db.servers.getAll();
    const existing    = new Set(existingAll.map(s => s.name));
    const existingIPs = new Set(existingAll.map(s => s.ip_address));
    const results  = { created: 0, skipped: 0, errors: [] };

    for (const s of servers) {
      if (!s.name || !s.ip_address) {
        results.errors.push(`Skipped: missing required fields (name/ip_address)`);
        results.skipped++;
        continue;
      }
      if (existing.has(s.name) || existingIPs.has(s.ip_address)) {
        results.skipped++;
        continue;
      }
      try {
        db.servers.create({
          name:      String(s.name).slice(0, 100),
          hostname:  String(s.hostname  || s.ip_address).slice(0, 255),
          ip_address: String(s.ip_address).slice(0, 45),
          ssh_port:  parseInt(s.ssh_port) || 22,
          ssh_user:  String(s.ssh_user || 'root').slice(0, 100),
          tags:      Array.isArray(s.tags)     ? s.tags     : [],
          services:  Array.isArray(s.services) ? s.services : [],
        });
        existing.add(s.name);
        existingIPs.add(s.ip_address);
        results.created++;
      } catch (e) {
        results.errors.push(`"${s.name}": ${e.message}`);
        results.skipped++;
      }
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Server Groups ─────────────────────────────────────────────
// GET /api/servers/groups
router.get('/groups', (req, res) => {
  res.json(db.serverGroups.getAll());
});

// POST /api/servers/groups
router.post('/groups', (req, res) => {
  const { name, color, parent_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  res.json(db.serverGroups.create(name.trim(), color, parent_id || null));
});

// PUT /api/servers/groups/:groupId
router.put('/groups/:groupId', (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  db.serverGroups.update(req.params.groupId, name.trim(), color);
  res.json({ success: true });
});

// DELETE /api/servers/groups/:groupId
router.delete('/groups/:groupId', (req, res) => {
  db.serverGroups.delete(req.params.groupId);
  res.json({ success: true });
});

// PUT /api/servers/groups/:groupId/parent
router.put('/groups/:groupId/parent', (req, res) => {
  db.serverGroups.setGroupParent(req.params.groupId, req.body.parent_id || null);
  res.json({ success: true });
});

// PUT /api/servers/:id/group
router.put('/:id/group', (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  db.serverGroups.setServerGroup(req.params.id, req.body.group_id || null);
  res.json({ success: true });
});

// GET /api/servers/:id - Get single server
router.get('/:id', (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({
      ...server,
      tags: JSON.parse(server.tags || '[]'),
      services: JSON.parse(server.services || '[]'),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers - Add a new server
router.post('/', (req, res) => {
  try {
    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services } = req.body;
    if (!name || !ip_address) {
      return res.status(400).json({ error: 'Name and IP address are required' });
    }
    const server = db.servers.create({
      name,
      hostname: hostname || ip_address,
      ip_address,
      ssh_port: ssh_port || 22,
      ssh_user: ssh_user || 'root',
      tags: tags || [],
      services: services || [],
    });
    db.auditLog.write('server.create', `Server "${name}" (${ip_address}) created`, req.ip);
    res.status(201).json({
      ...server,
      tags: JSON.parse(server.tags || '[]'),
      services: JSON.parse(server.services || '[]'),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/servers/:id - Update server
router.put('/:id', (req, res) => {
  try {
    const existing = db.servers.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Server not found' });

    const { name, hostname, ip_address, ssh_port, ssh_user, tags, services } = req.body;
    const server = db.servers.update(req.params.id, {
      name: name || existing.name,
      hostname: hostname || existing.hostname,
      ip_address: ip_address || existing.ip_address,
      ssh_port: ssh_port || existing.ssh_port,
      ssh_user: ssh_user || existing.ssh_user,
      tags: tags || JSON.parse(existing.tags || '[]'),
      services: services || JSON.parse(existing.services || '[]'),
    });
    res.json({
      ...server,
      tags: JSON.parse(server.tags || '[]'),
      services: JSON.parse(server.services || '[]'),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/servers/:id - Delete server
router.delete('/:id', (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    db.servers.delete(req.params.id);
    db.auditLog.write('server.delete', `Server "${server.name}" (${server.ip_address}) deleted`, req.ip);
    res.json({ message: 'Server deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/servers/:id/test - Test SSH connection
router.post('/:id/test', async (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const connected = await sshManager.testConnection(server);
    db.servers.updateStatus(server.id, connected ? 'online' : 'offline');

    res.json({ connected, status: connected ? 'online' : 'offline' });
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'error');
    res.json({ connected: false, status: 'error', error: error.message });
  }
});

// GET /api/servers/:id/notes
router.get('/:id/notes', (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({ notes: server.notes || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/servers/:id/notes
router.put('/:id/notes', (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 50000) : '';
    db.servers.setNotes(req.params.id, notes);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/info - Get system info (stale-while-revalidate)
router.get('/:id/info', async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const cached = db.serverInfo.get(req.params.id);
  const force = req.query.force === '1';

  // Serve cache immediately, refresh in background
  if (cached && !force) {
    res.json({ ...cached, _cached: true });
    systemInfo.getSystemInfo(server)
      .then(info => {
        db.serverInfo.upsert(server.id, info);
        db.servers.updateStatus(server.id, 'online');
      })
      .catch(() => db.servers.updateStatus(server.id, 'offline'));
    return;
  }

  // No cache yet (first visit) or forced refresh – wait for real data
  try {
    const info = await systemInfo.getSystemInfo(server);
    db.serverInfo.upsert(server.id, info);
    db.servers.updateStatus(server.id, 'online');
    res.json(info);
  } catch (error) {
    db.servers.updateStatus(req.params.id, 'offline');
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/services - Get running services
router.get('/:id/services', async (req, res) => {
  try {
    const server = db.servers.getById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const services = await systemInfo.getServices(server);
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/updates - Get available updates (stale-while-revalidate)
router.get('/:id/updates', async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const cached = db.updatesCache.get(req.params.id);
  const force = req.query.force === '1';

  if (cached && !force) {
    res.json(cached.map(u => ({ ...u, _cached: true })));
    systemInfo.getAvailableUpdates(server)
      .then(updates => db.updatesCache.set(server.id, updates))
      .catch(() => {});
    return;
  }

  try {
    const updates = await systemInfo.getAvailableUpdates(server);
    db.updatesCache.set(server.id, updates);
    res.json(updates);
  } catch (error) {
    if (cached) return res.json(cached);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/history - Get update history
router.get('/:id/history', (req, res) => {
  try {
    const history = db.updateHistory.getByServer(req.params.id);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

async function refreshDockerCache(server) {
  const result = await ansibleRunner.runPlaybook('gather-docker.yml', server.name);
  if (!result.success) return;
  const jsonStart = result.stdout.indexOf('"msg": [');
  if (jsonStart === -1) return;
  const jsonEnd = result.stdout.indexOf(']', jsonStart);
  if (jsonEnd === -1) return;
  const jsonStr = result.stdout.substring(jsonStart + 7, jsonEnd + 1);
  try {
    const containers = JSON.parse(jsonStr).filter(line => line.trim()).map(line => {
      const parts = line.split('|');
      return {
        name: parts[0] || 'Unknown',
        image: parts[1] || 'Unknown',
        state: parts[2] || 'unknown',
        status: parts[3] || '',
        createdAt: parts[4] || '',
        composeProject: parts[5] || null,
        composeWorkingDir: parts[6] || null,
      };
    });
    db.dockerContainers.syncForServer(server.id, containers);
  } catch (e) {
    console.error('Failed to parse docker output:', e);
  }
}

// GET /api/servers/:id/docker - Get docker containers (stale-while-revalidate)
router.get('/:id/docker', async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const cached = buildDockerResponse(req.params.id);
  const force = req.query.force === '1';

  if (cached.length > 0 && !force) {
    res.json(cached.map(c => ({ ...c, _cached: true })));
    refreshDockerCache(server).catch(() => {});
    return;
  }

  try {
    await refreshDockerCache(server);
    res.json(buildDockerResponse(req.params.id));
  } catch (error) {
    if (cached.length > 0) return res.json(cached);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/servers/:id/docker/:container/logs
router.get('/:id/docker/:container/logs', async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const container = req.params.container;
  if (container.length > 128 || !/^[a-zA-Z0-9_.\-]+$/.test(container)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }

  const tailRaw = parseInt(req.query.tail);
  const tail = Math.max(1, Math.min(Number.isFinite(tailRaw) ? tailRaw : 200, 2000));

  try {
    const result = await sshManager.execCommand(
      server,
      `$(command -v docker 2>/dev/null || command -v podman 2>/dev/null) logs --tail ${tail} --timestamps ${container} 2>&1`
    );
    res.json({ logs: result.stdout || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseImageUpdateOutput(stdout) {
  const jsonStart = stdout.indexOf('"msg": [');
  if (jsonStart === -1) return [];
  const jsonEnd = stdout.indexOf(']', jsonStart);
  if (jsonEnd === -1) return [];
  const jsonStr = stdout.substring(jsonStart + 7, jsonEnd + 1);
  try {
    return JSON.parse(jsonStr)
      .filter(line => line && line.includes('|'))
      .map(line => {
        const [image, status] = line.split('|');
        return { image: image.trim(), status: (status || 'unknown').trim() };
      });
  } catch { return []; }
}

// GET /api/servers/:id/docker/image-updates - Check for image updates
router.get('/:id/docker/image-updates', async (req, res) => {
  const server = db.servers.getById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  try {
    const result = await ansibleRunner.runPlaybook('check-image-updates.yml', server.name);
    const updates = parseImageUpdateOutput(result.stdout);
    db.dockerImageUpdatesCache.set(server.id, updates);
    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// GET /api/servers/:id/docker/compose - Read docker-compose.yml
router.get('/:id/docker/compose', async (req, res) => {
  try {
    const { id } = req.params;
    const { path } = req.query;

    if (!path) return res.status(400).json({ error: 'path query parameter is required' });
    if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..')) {
      return res.status(400).json({ error: 'Invalid path format' });
    }

    const server = db.servers.getById(id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const ansibleRunner = require('../services/ansible-runner');
    const result = await ansibleRunner.runAdHoc(
      server.name,
      'command',
      `cat ${path}/docker-compose.yml`,
      () => {} // silence output
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
      res.status(500).json({ error: 'Failed to read docker-compose.yml. It might not exist in this directory.', details: result.stderr || result.stdout });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
