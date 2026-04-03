const { Client: SshClient } = require('ssh2');
const db = require('../db');
const sshManager = require('../services/ssh-manager');
const { getPermissions, filterServers, can } = require('../utils/permissions');
const log = require('../utils/logger');
const { verifyWsAuth, getWsUser } = require('./auth');

function attachSshTerminal(wssSsh) {
  wssSsh.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (!verifyWsAuth(ws, url)) return;

    const wsUser = getWsUser(url);
    if (!can(getPermissions(wsUser), 'canUseTerminal')) {
      ws.close(4003, 'Permission denied');
      return;
    }

    const serverId = url.searchParams.get('serverId');
    const server = db.servers.getById(serverId);
    if (!server) { ws.close(4004, 'Server not found'); return; }

    const perms = getPermissions(wsUser);
    if (perms && !perms.full) {
      const allowed = filterServers([server], perms);
      if (allowed.length === 0) { ws.close(4003, 'Server access denied'); return; }
    }

    let privateKey;
    try { privateKey = sshManager.getPrivateKey(); }
    catch {
      ws.send(JSON.stringify({ type: 'error', message: 'SSH key not found' }));
      ws.close();
      return;
    }

    const conn = new SshClient();
    let stream = null;

    conn.on('ready', () => {
      const cols = Math.min(Math.max(parseInt(url.searchParams.get('cols')) || 80, 10), 500);
      const rows = Math.min(Math.max(parseInt(url.searchParams.get('rows')) || 24, 2), 200);

      conn.shell({ term: 'xterm-256color', cols, rows }, (err, sh) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
          ws.close();
          return;
        }
        stream = sh;
        ws.send(JSON.stringify({ type: 'ready' }));

        sh.on('data', d => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
        sh.stderr.on('data', d => { if (ws.readyState === 1) ws.send(d.toString('utf8')); });
        sh.on('close', () => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'closed' }));
          ws.close();
          conn.end();
        });
      });
    });

    conn.on('error', err => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
      conn.end();
    });

    ws.on('message', raw => {
      if (!stream) return;
      if (raw.length > 65536) return;
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'input' && typeof msg.data === 'string') stream.write(msg.data);
        if (msg.type === 'resize') {
          const rows = Math.min(Math.max(parseInt(msg.rows) || 24, 2), 200);
          const cols = Math.min(Math.max(parseInt(msg.cols) || 80, 10), 500);
          stream.setWindow(rows, cols, 0, 0);
        }
      } catch (e) {
        log.debug({ err: e }, 'SSH terminal message error');
      }
    });

    ws.on('close', () => {
      try { stream?.close(); } catch {}
      conn.end();
    });

    conn.connect({
      host: server.ip_address,
      port: server.ssh_port || 22,
      username: server.ssh_user || 'root',
      privateKey,
      readyTimeout: 10000,
    });
  });
}

module.exports = { attachSshTerminal };
