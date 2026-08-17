'use strict';

const net = require('net');
const { randomUUID } = require('crypto');
const log = require('../../../utils/logger').child('features:opentofu:platforms');
const cryptoUtil = require('../../../utils/crypto');
const { can, getPermissions } = require('../../../utils/permissions');
const { PROXMOX_IDENTIFIER_RE, extractProxmoxGuestNetworkRecords, extractProxmoxLxcNetworkRecords } = require('../proxmox-blueprints');
const { createProxmoxConnection, requestProxmoxApi } = require('../proxmox-client');
const { syncProxmoxIpam } = require('../proxmox-ipam-sync');

function syncInterval(value, fallback = 15) {
  return Math.min(1440, Math.max(5, Number.parseInt(value, 10) || fallback));
}

/** Register platform sources, inventory actions, updates and guest adoption. */
function registerPlatformRoutes({ db, router, listProxmoxConnectionRows, publicProxmoxConnection, readSavedProxmoxConnection, getProxmoxVms, getLastRun }) {
  router.get('/proxmox-connections', (req, res) => {
    const environmentId = String(req.query.environment_id || '').trim();
    if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    res.json(listProxmoxConnectionRows(environmentId).map(publicProxmoxConnection));
  });
  
  router.post('/proxmox-connections', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const environmentId = String(body.environment_id || '').trim();
    const name = String(body.name || '').trim().slice(0, 80);
    const endpoint = String(body.endpoint || '').trim();
    const token = String(body.api_token || '').trim();
    const sshPublicKey = String(body.ssh_public_key || '').trim();
    if ((token || sshPublicKey) && !cryptoUtil.isEncryptionAvailable()) return res.status(503).json({ error: 'SHIPYARD_KEY_SECRET is required before platform secrets can be stored.' });
    if (!environmentId) return res.status(400).json({ error: 'environment_id is required' });
    if (!name) return res.status(400).json({ error: 'Connection name is required' });
    if (!db.db.prepare('SELECT 1 FROM environments WHERE id = ?').get(environmentId)) return res.status(400).json({ error: 'Environment not found' });
    try { createProxmoxConnection(endpoint, token, body.insecure === true); } catch (error) { return res.status(400).json({ error: error.message }); }
    const id = randomUUID();
    try {
      db.db.prepare('INSERT INTO tofu_proxmox_connections (id, environment_id, name, endpoint, api_token, insecure, ssh_public_key, auto_sync_ipam, sync_interval_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, environmentId, name, endpoint, cryptoUtil.encrypt(token), body.insecure === true ? 1 : 0, sshPublicKey ? cryptoUtil.encrypt(sshPublicKey) : '', body.auto_sync_ipam === false ? 0 : 1, syncInterval(body.sync_interval_min));
      res.status(201).json(publicProxmoxConnection(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(id)));
    } catch (error) { res.status(409).json({ error: error.message || 'Connection already exists' }); }
  });
  
  router.put('/proxmox-connections/:id', (req, res) => {
    const existing = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Connection not found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = body.name === undefined ? existing.name : String(body.name || '').trim().slice(0, 80);
    const endpoint = body.endpoint === undefined ? existing.endpoint : String(body.endpoint || '').trim();
    const token = typeof body.api_token === 'string' && body.api_token.trim() ? body.api_token.trim() : null;
    if ((token || (typeof body.ssh_public_key === 'string' && body.ssh_public_key.trim())) && !cryptoUtil.isEncryptionAvailable()) return res.status(503).json({ error: 'SHIPYARD_KEY_SECRET is required before platform secrets can be stored.' });
    const insecure = body.insecure === undefined ? Boolean(existing.insecure) : body.insecure === true;
    const autoSyncIpam = body.auto_sync_ipam === undefined ? Boolean(existing.auto_sync_ipam) : body.auto_sync_ipam === true;
    const syncIntervalMin = syncInterval(body.sync_interval_min, existing.sync_interval_min);
    if (!name) return res.status(400).json({ error: 'Connection name is required' });
    try { createProxmoxConnection(endpoint, token || readSavedProxmoxConnection(existing).apiToken, insecure); } catch (error) { return res.status(400).json({ error: error.message }); }
    const sshKey = typeof body.ssh_public_key === 'string' && body.ssh_public_key.trim() ? cryptoUtil.encrypt(body.ssh_public_key.trim()) : existing.ssh_public_key;
    db.db.prepare("UPDATE tofu_proxmox_connections SET name = ?, endpoint = ?, api_token = ?, insecure = ?, ssh_public_key = ?, auto_sync_ipam = ?, sync_interval_min = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, endpoint, token ? cryptoUtil.encrypt(token) : existing.api_token, insecure ? 1 : 0, sshKey, autoSyncIpam ? 1 : 0, syncIntervalMin, existing.id);
    res.json(publicProxmoxConnection(db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(existing.id)));
  });
  
  router.delete('/proxmox-connections/:id', (req, res) => {
    const inUse = db.db.prepare('SELECT COUNT(*) AS count FROM tofu_workspaces WHERE proxmox_connection_id = ?').get(req.params.id);
    if (Number(inUse?.count || 0) > 0) return res.status(409).json({ error: `This platform connection is still used by ${inUse.count} deployment(s). Reassign or detach them first.` });
    const adopted = db.db.prepare('SELECT COUNT(*) AS count FROM proxmox_inventory_servers WHERE connection_id = ?').get(req.params.id);
    if (Number(adopted?.count || 0) > 0) return res.status(409).json({ error: `This platform connection is still used by ${adopted.count} adopted Fleet host(s). Remove their Proxmox mapping first.` });
    const result = db.db.prepare('DELETE FROM tofu_proxmox_connections WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Connection not found' });
    res.json({ success: true });
  });
  
  function getProxmoxConnectionSource(id) {
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ?').get(id);
    if (!source) {
      const error = new Error('Proxmox platform not found.'); error.status = 404; throw error;
    }
    return { source, connection: readSavedProxmoxConnection(source) };
  }
  
  async function getInventoryNodeTarget(connectionId, nodeName, req, { requireUpdate = false } = {}) {
    const permissions = getPermissions(req.user);
    if (!can(permissions, 'canViewServers') || (requireUpdate && !can(permissions, 'canRunUpdates'))) {
      const error = new Error('Permission denied'); error.status = 403; throw error;
    }
    const safeNodeName = String(nodeName || '').trim();
    if (!safeNodeName || !PROXMOX_IDENTIFIER_RE.test(safeNodeName)) {
      const error = new Error('A valid Proxmox node is required.'); error.status = 400; throw error;
    }
    const { source, connection } = getProxmoxConnectionSource(connectionId);
    const nodes = await requestProxmoxApi(connection, '/nodes');
    if (!(Array.isArray(nodes) ? nodes : []).some(node => String(node?.node || '') === safeNodeName)) {
      const error = new Error('Proxmox node not found on this platform.'); error.status = 404; throw error;
    }
    return { source, connection, node_name: safeNodeName };
  }
  
  router.get('/proxmox-connections/:connectionId/nodes/:nodeName/updates', async (req, res) => {
    try {
      const target = await getInventoryNodeTarget(req.params.connectionId, req.params.nodeName, req);
      const updates = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.node_name)}/apt/update`);
      res.json({ node_name: target.node_name, updates: Array.isArray(updates) ? updates : [] });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'Could not load Proxmox updates.' }); }
  });
  
  router.post('/proxmox-connections/:connectionId/nodes/:nodeName/updates/refresh', async (req, res) => {
    try {
      const target = await getInventoryNodeTarget(req.params.connectionId, req.params.nodeName, req, { requireUpdate: true });
      const taskId = await requestProxmoxApi(target.connection, `/nodes/${encodeURIComponent(target.node_name)}/apt/update`, {
        method: 'POST', payload: { notify: 0, quiet: 1 },
      });
      db.auditLog.write('infrastructure.proxmox_update_catalog', `source=${target.source.name} node=${target.node_name} task=${taskId || 'started'}`, req.ip, true, req.user?.username);
      res.status(202).json({ status: 'started', task_id: taskId || null });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'Could not refresh the Proxmox update catalog.' }); }
  });
  
  const guestApiPath = (guest, suffix = '') => `/nodes/${encodeURIComponent(guest.node_name)}/${guest.guest_type}/${guest.vm_id}${suffix}`;

  async function getGuestNetworkRecords(connection, guest) {
    if (guest.guest_type === 'lxc') {
      try {
        const payload = await requestProxmoxApi(connection, guestApiPath(guest, '/interfaces'));
        const records = extractProxmoxLxcNetworkRecords(payload);
        if (records.length) return records;
      } catch {
        // A stopped CT has no live interfaces. Its static netX configuration
        // can still provide a usable address without starting the guest.
      }
      const config = await requestProxmoxApi(connection, guestApiPath(guest, '/config'));
      const interfaces = Object.entries(config && typeof config === 'object' ? config : {})
        .filter(([key, value]) => /^net\d+$/.test(key) && typeof value === 'string')
        .map(([name, value]) => {
          const options = String(value).split(',').reduce((result, item) => {
            const separator = item.indexOf('=');
            if (separator > 0) result[item.slice(0, separator)] = item.slice(separator + 1);
            return result;
          }, {});
          return { name: options.name || name, inet: options.ip || '', hwaddr: options.hwaddr || '' };
        });
      return extractProxmoxLxcNetworkRecords(interfaces);
    }
    const payload = await requestProxmoxApi(connection, guestApiPath(guest, '/agent/network-get-interfaces'));
    return extractProxmoxGuestNetworkRecords(payload);
  }

  // Resolve a guest from the live Proxmox inventory before running an operation.
  // The browser never supplies a URL or credentials; it may only reference a
  // configured connection, node and guest ID. Looking up the guest again prevents a
  // stale UI or handcrafted request from targeting a different object.
  async function getInventoryVmTarget(connectionId, nodeName, vmId, req, { requireEdit = false, requirePower = false } = {}) {
    const permissions = getPermissions(req.user);
    if (!can(permissions, requireEdit ? 'canEditServers' : 'canViewServers')) {
      const error = new Error('Permission denied'); error.status = 403; throw error;
    }
    if (requirePower && !can(permissions, 'canRebootServers')) {
      const error = new Error('Permission denied'); error.status = 403; throw error;
    }
    const safeConnectionId = String(connectionId || '').trim();
    const safeNodeName = String(nodeName || '').trim();
    const safeVmId = Number.parseInt(String(vmId || ''), 10);
    if (!safeConnectionId || !safeNodeName || !PROXMOX_IDENTIFIER_RE.test(safeNodeName) || !Number.isInteger(safeVmId) || safeVmId <= 0) {
      const error = new Error('Connection, node and guest ID are required.'); error.status = 400; throw error;
    }
    const { source, connection } = getProxmoxConnectionSource(safeConnectionId);
    const resources = await requestProxmoxApi(connection, '/cluster/resources?type=vm');
    const resource = (Array.isArray(resources) ? resources : []).find(item =>
      ['qemu', 'lxc'].includes(String(item?.type || '').toLowerCase()) && String(item?.node || '') === safeNodeName && Number(item?.vmid) === safeVmId);
    if (!resource) {
      const error = new Error('The guest was not found on this Proxmox platform.'); error.status = 404; throw error;
    }
    const guestType = String(resource.type).toLowerCase();
    return { source, connection, vm: { name: String(resource.name || `${guestType === 'lxc' ? 'CT' : 'VM'} ${safeVmId}`), node_name: safeNodeName, vm_id: safeVmId, guest_type: guestType } };
  }
  
  function snapshotNameOrError(value) {
    const name = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
      const error = new Error('Der Snapshot-Name darf 1–40 Zeichen (Buchstaben, Zahlen, Punkt, Unterstrich, Bindestrich) enthalten.'); error.status = 400; throw error;
    }
    return name;
  }
  
  router.get('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/snapshots', async (req, res) => {
    try {
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req);
      const snapshots = await requestProxmoxApi(target.connection, guestApiPath(target.vm, '/snapshot'));
      res.json({ connection_id: target.source.id, node_name: target.vm.node_name, vm_id: target.vm.vm_id, guest_type: target.vm.guest_type, snapshots: Array.isArray(snapshots) ? snapshots.filter(snapshot => snapshot?.name !== 'current') : [] });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'Snapshots could not be loaded.' }); }
  });
  
  // An inventory VM can be entirely unmanaged, adopted as a Fleet host, or
  // declared by one or more OpenTofu workspaces.  Keep that relationship
  // explicit instead of guessing it in the browser from names or IPs.
  router.get('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/context', async (req, res) => {
    try {
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req);
      const adopted = db.db.prepare(`
        SELECT server.id, server.name
        FROM proxmox_inventory_servers inventory
        JOIN servers server ON server.id = inventory.server_id
        WHERE inventory.connection_id = ? AND inventory.node_name = ? AND inventory.vm_id = ?
        LIMIT 1
      `).get(target.source.id, target.vm.node_name, target.vm.vm_id) || null;
      const workspaces = db.db.prepare(`
        SELECT id, name FROM tofu_workspaces
        WHERE proxmox_connection_id = ?
        ORDER BY name COLLATE NOCASE
      `).all(target.source.id);
      const deployments = target.vm.guest_type === 'lxc' ? [] : workspaces.flatMap(workspace => getProxmoxVms(workspace.id)
        .filter(vm => vm.node_name === target.vm.node_name && Number(vm.vm_id) === target.vm.vm_id)
        .map(vm => {
          const resourceKey = `resource:proxmox_virtual_environment_vm.${vm.name}`;
          const mapping = db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ? AND resource_key = ?').get(workspace.id, resourceKey);
          const lastRun = getLastRun(workspace.id);
          return {
            workspace_id: workspace.id,
            workspace_name: workspace.name,
            vm_name: vm.name,
            fleet_server_id: mapping?.server_id || null,
            last_run: lastRun ? {
              id: lastRun.id,
              action: lastRun.action,
              status: lastRun.status,
              started_at: lastRun.started_at,
              completed_at: lastRun.completed_at,
            } : null,
          };
        }));
      res.json({
        connection_id: target.source.id,
        node_name: target.vm.node_name,
        vm_id: target.vm.vm_id,
        guest_type: target.vm.guest_type,
        adopted_server: adopted,
        deployments,
      });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'VM context could not be loaded.' }); }
  });
  
  // Return a deliberately small, display-oriented projection of the Proxmox
  // VM configuration.  The console needs hardware and network facts for the
  // object view, but must never turn this endpoint into a credential/config
  // dump (for example cloud-init passwords or arbitrary custom arguments).
  router.get('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/configuration', async (req, res) => {
    try {
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req);
      const config = await requestProxmoxApi(target.connection, guestApiPath(target.vm, '/config'));
      const source = config && typeof config === 'object' ? config : {};
      const parseOptions = (value) => String(value || '').split(',').reduce((result, item) => {
        const separator = item.indexOf('=');
        if (separator > 0) result[item.slice(0, separator)] = item.slice(separator + 1);
        return result;
      }, {});
      const disks = Object.entries(source)
        .filter(([key, value]) => (target.vm.guest_type === 'lxc' ? /^(rootfs|mp\d+)$/.test(key) : /^(scsi|virtio|sata|ide)\d+$/.test(key)) && typeof value === 'string')
        .map(([bus, value]) => {
          const options = parseOptions(value);
          const storage = String(value).split(',')[0] || '—';
          return { bus, storage, size: options.size || null, format: options.format || null, discard: options.discard === 'on' };
        });
      const networks = Object.entries(source)
        .filter(([key, value]) => /^net\d+$/.test(key) && typeof value === 'string')
        .map(([interfaceName, value]) => {
          const options = parseOptions(value);
          return {
            interface: interfaceName,
            model: target.vm.guest_type === 'lxc' ? (options.type || 'veth') : (String(value).split(',')[0] || 'virtio'),
            bridge: options.bridge || null,
            vlan_id: options.tag || null,
            mac_address: options.virtio || options.e1000 || options.hwaddr || null,
            firewall: options.firewall === '1',
          };
        });
      const ipConfig = Object.entries(source)
        .filter(([key, value]) => (target.vm.guest_type === 'lxc' ? /^net\d+$/.test(key) : /^ipconfig\d+$/.test(key)) && typeof value === 'string')
        .map(([interfaceName, value]) => {
          const options = parseOptions(value);
          return { interface: interfaceName.replace('ipconfig', 'net'), ipv4: options.ip || null, gateway: options.gw || null };
        });
      res.json({
        connection_id: target.source.id,
        node_name: target.vm.node_name,
        vm_id: target.vm.vm_id,
        guest_type: target.vm.guest_type,
        hardware: {
          sockets: Number(source.sockets || 1),
          cores: Number(source.cores || 0),
          memory_mb: Number(source.memory || 0),
          os_type: source.ostype || null,
          bios: source.bios || null,
          machine: source.machine || null,
          scsi_controller: source.scsihw || null,
          agent_enabled: target.vm.guest_type === 'lxc' ? null : (String(source.agent || '').includes('enabled=1') || String(source.agent || '') === '1'),
          boot_order: source.boot || null,
        },
        disks,
        networks,
        guest: { username: target.vm.guest_type === 'lxc' ? null : (source.ciuser || null), ip_config: ipConfig },
      });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'VM configuration could not be loaded.' }); }
  });
  
  router.post('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/snapshots', async (req, res) => {
    try {
      const name = snapshotNameOrError(req.body?.name);
      const description = String(req.body?.description || '').trim().slice(0, 512);
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req, { requireEdit: true });
      const payload = { snapname: name, description };
      if (target.vm.guest_type === 'qemu') payload.vmstate = 1;
      const task = await requestProxmoxApi(target.connection, guestApiPath(target.vm, '/snapshot'), { method: 'POST', payload });
      db.auditLog.write('infrastructure.snapshot_create', `source=${target.source.name} vm=${target.vm.name} vm_id=${target.vm.vm_id} snapshot=${name}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, task, name });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'The snapshot could not be created.' }); }
  });
  
  router.delete('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/snapshots/:snapshotName', async (req, res) => {
    try {
      const name = snapshotNameOrError(req.params.snapshotName);
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req, { requireEdit: true });
      const task = await requestProxmoxApi(target.connection, guestApiPath(target.vm, `/snapshot/${encodeURIComponent(name)}`), { method: 'DELETE' });
      db.auditLog.write('infrastructure.snapshot_delete', `source=${target.source.name} vm=${target.vm.name} vm_id=${target.vm.vm_id} snapshot=${name}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, task, name });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'The snapshot could not be deleted.' }); }
  });
  
  router.post('/proxmox-connections/:connectionId/vms/:nodeName/:vmId/power', async (req, res) => {
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (!['start', 'shutdown', 'reboot', 'stop'].includes(action)) return res.status(400).json({ error: 'Invalid Proxmox action.' });
    try {
      const target = await getInventoryVmTarget(req.params.connectionId, req.params.nodeName, req.params.vmId, req, { requireEdit: true, requirePower: true });
      const task = await requestProxmoxApi(target.connection, guestApiPath(target.vm, `/status/${action}`), { method: 'POST' });
      db.auditLog.write('infrastructure.vm_power', `action=${action} source=${target.source.name} vm=${target.vm.name} vm_id=${target.vm.vm_id}`, req.ip, true, req.user?.username || null);
      res.status(202).json({ success: true, action, task });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'The Proxmox action could not be started.' }); }
  });
  
  router.get('/proxmox-connections/:id/guest-ip', async (req, res) => {
    if (!can(getPermissions(req.user), 'canViewServers')) return res.status(403).json({ error: 'Permission denied' });
    try {
      const nodeName = String(req.query.node || '').trim();
      const vmId = Number.parseInt(String(req.query.vm_id || ''), 10);
      const target = await getInventoryVmTarget(req.params.id, nodeName, vmId, req);
      const records = await getGuestNetworkRecords(target.connection, target.vm);
      res.json({ ip_address: records[0]?.address || null, guest_type: target.vm.guest_type });
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'The guest IP could not be read.' }); }
  });
  
  // Synchronise guest addresses without making Proxmox the source of truth for
  // manual IPAM metadata. Existing manual addresses are deliberately left
  // untouched; only Fleet's own Proxmox-sourced rows are refreshed.
  router.post('/proxmox-connections/:id/sync-ipam', async (req, res) => {
    if (!can(getPermissions(req.user), 'canEditServers')) return res.status(403).json({ error: 'Permission denied' });
    try {
      const subnetId = String(req.body?.subnet_id || '').trim();
      res.json(await syncProxmoxIpam(req.params.id, { subnetId: subnetId || null, ip: req.ip, actor: req.user?.username }));
    } catch (error) { res.status(error.status || 502).json({ error: error.message || 'Proxmox IPAM reconciliation failed.' }); }
  });
  
  router.post('/proxmox-connections/:id/import-vm', async (req, res) => {
    const permissions = getPermissions(req.user);
    if (!can(permissions, 'canEditServers')) return res.status(403).json({ error: 'Permission denied' });
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const nodeName = String(body.node_name || '').trim();
      const vmId = Number.parseInt(String(body.vm_id || ''), 10);
      const name = String(body.name || '').trim().slice(0, 100);
      const sshUser = String(body.ssh_user || 'root').trim().slice(0, 100) || 'root';
      const sshPort = Number.parseInt(String(body.ssh_port || 22), 10);
      const groupId = String(body.group_id || '').trim() || null;
      if (!nodeName || !PROXMOX_IDENTIFIER_RE.test(nodeName) || !Number.isInteger(vmId) || vmId <= 0 || !name) return res.status(400).json({ error: 'Name, node and guest ID are required.' });
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return res.status(400).json({ error: 'Invalid SSH port.' });
      const target = await getInventoryVmTarget(req.params.id, nodeName, vmId, req, { requireEdit: true });
      const { source, connection } = target;
      let ipAddress = String(body.ip_address || '').trim();
      if (!ipAddress) {
        const records = await getGuestNetworkRecords(connection, target.vm);
        ipAddress = records[0]?.address || '';
      }
      if (!ipAddress || net.isIP(ipAddress) !== 4) return res.status(400).json({ error: `No usable IPv4 address was found. Enter one manually${target.vm.guest_type === 'qemu' ? ' or enable the QEMU Guest Agent' : ''}.` });
      if (groupId) {
        const group = db.db.prepare('SELECT environment_id FROM server_groups WHERE id = ?').get(groupId);
        if (!group) return res.status(400).json({ error: 'The selected folder does not exist.' });
        if (String(group.environment_id || 'default') !== String(source.environment_id || 'default')) return res.status(400).json({ error: 'The selected folder belongs to another environment.' });
      }
      const existing = db.db.prepare('SELECT * FROM servers WHERE environment_id = ? AND (ip_address = ? OR name = ?)').get(source.environment_id, ipAddress, name);
      if (existing) return res.status(409).json({ error: `A Fleet host with this name or IP already exists (${existing.name}).` });
      const server = db.servers.create({ name, hostname: name, ip_address: ipAddress, ssh_port: sshPort, ssh_user: sshUser, environment_id: source.environment_id, tags: ['proxmox', target.vm.guest_type, `proxmox:${source.name}`] });
      if (groupId) db.serverGroups.setServerGroup(server.id, groupId);
      db.db.prepare('INSERT INTO proxmox_inventory_servers (server_id, connection_id, node_name, vm_id, guest_type) VALUES (?, ?, ?, ?, ?)').run(server.id, source.id, nodeName, vmId, target.vm.guest_type);
      db.auditLog.write('infrastructure.vm_import', `source=${source.name} node=${nodeName} type=${target.vm.guest_type} vm=${vmId} server=${server.name}`, req.ip, true, req.user?.username);
      res.status(201).json({ success: true, server: db.servers.getById(server.id) });
    } catch (error) { res.status(error.status || 400).json({ error: error.message || 'The VM could not be adopted into Fleet.' }); }
  });
  
  
}

module.exports = { registerPlatformRoutes };
