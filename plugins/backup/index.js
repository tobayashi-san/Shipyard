const https = require('https');
const http  = require('http');
const { randomUUID } = require('crypto');

// ── HTTP helper ────────────────────────────────────────────────────────────

function request(opts, body, rejectUnauthorized = true) {
  return new Promise((resolve, reject) => {
    const isHttps = opts.protocol === 'https:' || (!opts.protocol && opts.port !== 80);
    const client  = isHttps ? https : http;
    const options = {
      ...opts,
      rejectUnauthorized,
      timeout: 15000,
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function parseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return { hostname: u.hostname, port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol, path: u.pathname };
  } catch {
    return null;
  }
}

// ── PBS adapter ───────────────────────────────────────────────────────────

async function pbsAuth(instance) {
  const u = parseUrl(instance.url);
  if (!u) throw new Error('Invalid URL');

  const body = `username=${encodeURIComponent(instance.username)}&password=${encodeURIComponent(instance.password)}`;
  const res = await request({
    hostname: u.hostname,
    port:     u.port,
    path:     '/api2/json/access/ticket',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body, !instance.skip_tls);

  const ticket = res.body?.data?.ticket;
  const csrf   = res.body?.data?.CSRFPreventionToken;
  if (!ticket) throw new Error('PBS auth failed: no ticket in response');
  return { ticket, csrf };
}

async function pbsFetch(instance, path) {
  const { ticket, csrf } = await pbsAuth(instance);
  const u = parseUrl(instance.url);
  const res = await request({
    hostname: u.hostname,
    port:     u.port,
    path:     `/api2/json${path}`,
    method:   'GET',
    headers:  {
      'Cookie':               `PBSAuthCookie=${encodeURIComponent(ticket)}`,
      'CSRFPreventionToken':  csrf,
    },
  }, null, !instance.skip_tls);
  return res.body?.data;
}

async function getPbsStatus(instance) {
  // Fetch node status, datastores, and recent tasks in parallel
  const [nodes, tasks] = await Promise.all([
    pbsFetch(instance, '/nodes').catch(() => null),
    pbsFetch(instance, '/status/tasks?limit=50').catch(() => null),
  ]);

  // Map task log_data / status to unified job entries
  const jobs = (tasks || []).map(t => {
    let status = 'unknown';
    if (t.status === 'OK') status = 'success';
    else if (t.status !== undefined && t.status !== null && t.status !== '') status = 'failed';
    else if (!t.endtime) status = 'running';

    return {
      id:         t.upid || t.id || randomUUID(),
      name:       `${t.worker_type || t.type || 'task'}: ${t.worker_id || ''}`.trim(),
      type:       t.worker_type || t.type || '',
      status,
      start_time: t.starttime ? new Date(t.starttime * 1000).toISOString() : null,
      end_time:   t.endtime   ? new Date(t.endtime   * 1000).toISOString() : null,
      node:       t.node || '',
    };
  });

  // Simple summary
  const ok     = jobs.filter(j => j.status === 'success').length;
  const failed = jobs.filter(j => j.status === 'failed').length;
  const running= jobs.filter(j => j.status === 'running').length;

  let overallStatus = 'ok';
  if (running > 0) overallStatus = 'running';
  if (failed > 0)  overallStatus = 'warning';
  if (failed > 0 && ok === 0 && running === 0) overallStatus = 'error';

  return {
    type:   'pbs',
    status: overallStatus,
    summary: { ok, failed, running, total: jobs.length },
    jobs,
    nodes: nodes || [],
  };
}

// ── Veeam adapter ──────────────────────────────────────────────────────────

async function veeamAuth(instance) {
  const u = parseUrl(instance.url);
  if (!u) throw new Error('Invalid URL');

  const body = `grant_type=password&username=${encodeURIComponent(instance.username)}&password=${encodeURIComponent(instance.password)}`;
  const res = await request({
    hostname: u.hostname,
    port:     u.port,
    path:     '/api/oauth2/token',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'x-api-version': '1.2-rev0', 'Content-Length': Buffer.byteLength(body) },
  }, body, !instance.skip_tls);

  const token = res.body?.access_token;
  if (!token) throw new Error('Veeam auth failed: no access_token in response');
  return token;
}

async function veeamFetch(instance, path) {
  const token = await veeamAuth(instance);
  const u = parseUrl(instance.url);
  const res = await request({
    hostname: u.hostname,
    port:     u.port,
    path:     `/api/v1${path}`,
    method:   'GET',
    headers:  { 'Authorization': `Bearer ${token}`, 'x-api-version': '1.2-rev0', 'Accept': 'application/json' },
  }, null, !instance.skip_tls);
  return res.body;
}

async function getVeeamStatus(instance) {
  const [jobsRes, sessionsRes] = await Promise.all([
    veeamFetch(instance, '/jobs').catch(() => null),
    veeamFetch(instance, '/sessions?limit=50').catch(() => null),
  ]);

  const sessions = sessionsRes?.data || sessionsRes || [];

  const jobs = sessions.map(s => {
    let status = 'unknown';
    const st = (s.state || s.status || '').toLowerCase();
    if (st === 'succeeded' || st === 'success') status = 'success';
    else if (st === 'warning') status = 'warning';
    else if (st === 'failed' || st === 'error') status = 'failed';
    else if (st === 'running' || st === 'starting') status = 'running';

    return {
      id:         s.id || randomUUID(),
      name:       s.name || s.jobName || s.jobId || 'Job',
      type:       s.jobType || 'backup',
      status,
      start_time: s.creationTime || s.startTime || null,
      end_time:   s.endTime || null,
      node:       s.backupServerName || '',
    };
  });

  const ok     = jobs.filter(j => j.status === 'success').length;
  const warn   = jobs.filter(j => j.status === 'warning').length;
  const failed = jobs.filter(j => j.status === 'failed').length;
  const running= jobs.filter(j => j.status === 'running').length;

  let overallStatus = 'ok';
  if (running > 0) overallStatus = 'running';
  if (warn > 0)    overallStatus = 'warning';
  if (failed > 0)  overallStatus = 'warning';
  if (failed > 0 && ok === 0 && warn === 0 && running === 0) overallStatus = 'error';

  return {
    type:   'veeam',
    status: overallStatus,
    summary: { ok, warning: warn, failed, running, total: jobs.length },
    jobs,
  };
}

// ── Plugin registration ────────────────────────────────────────────────────

function register({ router, db }) {

  db.db.prepare(`
    CREATE TABLE IF NOT EXISTS backup_instances (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      type      TEXT NOT NULL DEFAULT 'pbs',
      url       TEXT NOT NULL,
      username  TEXT NOT NULL DEFAULT '',
      password  TEXT NOT NULL DEFAULT '',
      skip_tls  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // ── CRUD ──────────────────────────────────────────────────────────────────

  router.get('/instances', (req, res) => {
    const rows = db.db.prepare('SELECT id, name, type, url, username, skip_tls, created_at FROM backup_instances ORDER BY name ASC').all();
    res.json(rows.map(r => ({ ...r, skip_tls: !!r.skip_tls })));
  });

  router.post('/instances', (req, res) => {
    const { name, type, url, username, password, skip_tls } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    const validTypes = ['pbs', 'veeam'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'type must be pbs or veeam' });
    if (!parseUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
    const id = randomUUID();
    db.db.prepare('INSERT INTO backup_instances (id, name, type, url, username, password, skip_tls) VALUES (?,?,?,?,?,?,?)')
      .run(id, name.trim(), type, url.trim(), (username || '').trim(), password || '', skip_tls ? 1 : 0);
    res.json({ success: true, id });
  });

  router.put('/instances/:id', (req, res) => {
    const { name, type, url, username, password, skip_tls } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    if (!parseUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

    // Only update password if a new one is provided (empty string = keep existing)
    const existing = db.db.prepare('SELECT password FROM backup_instances WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instance not found' });

    const newPassword = password || existing.password;
    const result = db.db.prepare('UPDATE backup_instances SET name=?, type=?, url=?, username=?, password=?, skip_tls=? WHERE id=?')
      .run(name.trim(), type || 'pbs', url.trim(), (username || '').trim(), newPassword, skip_tls ? 1 : 0, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Instance not found' });
    res.json({ success: true });
  });

  router.delete('/instances/:id', (req, res) => {
    db.db.prepare('DELETE FROM backup_instances WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // ── Status fetch ──────────────────────────────────────────────────────────

  router.get('/instances/:id/status', async (req, res) => {
    const instance = db.db.prepare('SELECT * FROM backup_instances WHERE id = ?').get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    instance.skip_tls = !!instance.skip_tls;

    try {
      let data;
      if (instance.type === 'pbs') {
        data = await getPbsStatus(instance);
      } else if (instance.type === 'veeam') {
        data = await getVeeamStatus(instance);
      } else {
        return res.status(400).json({ error: 'Unknown instance type' });
      }
      res.json(data);
    } catch (e) {
      res.json({ type: instance.type, status: 'error', error: e.message, summary: { ok: 0, failed: 0, running: 0, total: 0 }, jobs: [] });
    }
  });

  // Batch fetch all instances
  router.get('/status', async (req, res) => {
    const instances = db.db.prepare('SELECT * FROM backup_instances ORDER BY name ASC').all();
    const results = await Promise.all(instances.map(async (inst) => {
      inst.skip_tls = !!inst.skip_tls;
      try {
        let data;
        if (inst.type === 'pbs')   data = await getPbsStatus(inst);
        else if (inst.type === 'veeam') data = await getVeeamStatus(inst);
        else data = { status: 'error', error: 'Unknown type' };
        return { id: inst.id, name: inst.name, type: inst.type, ...data };
      } catch (e) {
        return { id: inst.id, name: inst.name, type: inst.type, status: 'error', error: e.message,
          summary: { ok: 0, failed: 0, running: 0, total: 0 }, jobs: [] };
      }
    }));
    res.json(results);
  });

  // Test connection without saving
  router.post('/test', async (req, res) => {
    const { type, url, username, password, skip_tls } = req.body;
    if (!url || !type) return res.status(400).json({ error: 'type and url are required' });
    const instance = { type, url, username: username || '', password: password || '', skip_tls: !!skip_tls };
    try {
      let data;
      if (type === 'pbs')   data = await getPbsStatus(instance);
      else if (type === 'veeam') data = await getVeeamStatus(instance);
      else return res.status(400).json({ error: 'Unknown type' });
      res.json({ success: true, summary: data.summary });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });
}

module.exports = { register };
