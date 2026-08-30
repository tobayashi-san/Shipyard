'use strict';

const { createHash } = require('crypto');
const { PROXMOX_IDENTIFIER_RE } = require('./proxmox-blueprints');

function createInfrastructureSummary({
  db,
  log,
  collectProxmoxInfrastructureGroups,
  removeOrphanedServerMappings,
  requestProxmoxApi,
}) {
  const refreshes = new Map();
  const refreshAttempts = new Map();
  const maxAgeMs = Math.max(
    5_000,
    Number.parseInt(process.env.PROXMOX_SUMMARY_MAX_AGE_MS || '30000', 10) || 30_000
  );

  function cacheKey(environmentId) {
    return `tofu.infrastructure.summary.${encodeURIComponent(environmentId)}`;
  }

  function sourceVersion(environmentId) {
    const sources = db.db.prepare(`
      SELECT id, name, endpoint, updated_at
      FROM tofu_proxmox_connections
      WHERE environment_id = ?
      ORDER BY id
    `).all(environmentId);
    const mappings = db.db.prepare(`
      SELECT inventory.connection_id, inventory.node_name, inventory.vm_id, inventory.guest_type, inventory.server_id
      FROM proxmox_inventory_servers inventory
      JOIN tofu_proxmox_connections connection ON connection.id = inventory.connection_id
      WHERE connection.environment_id = ?
      ORDER BY inventory.connection_id, inventory.node_name, inventory.vm_id
    `).all(environmentId);
    const hosts = db.db.prepare(`
      SELECT id, name, hostname
      FROM servers
      WHERE environment_id = ?
      ORDER BY id
    `).all(environmentId);
    const workspaces = db.db.prepare(`
      SELECT id, env_vars
      FROM tofu_workspaces
      WHERE environment_id = ?
      ORDER BY id
    `).all(environmentId);
    return createHash('sha256')
      .update(JSON.stringify({ sources, mappings, hosts, workspaces }))
      .digest('hex');
  }

  async function load(environmentId) {
    removeOrphanedServerMappings(db);
    const { grouped, warnings } = collectProxmoxInfrastructureGroups(environmentId);
    const groups = [...grouped.values()];
    const settled = await Promise.allSettled(groups.map(async group => {
      const [nodesResponse, resourcesResponse] = await Promise.all([
        requestProxmoxApi(group.connection, '/nodes'),
        requestProxmoxApi(group.connection, '/cluster/resources?type=vm'),
      ]);
      const fleetServers = db.servers.getAll().filter(server =>
        String(server.environment_id || 'default') === String(group.environmentId || 'default'));
      const normalizeHost = value => String(value || '').trim().toLowerCase().replace(/\.$/, '');
      const nodes = (Array.isArray(nodesResponse) ? nodesResponse : [])
        .map(node => {
          const name = String(node?.node || '').trim();
          const normalizedName = normalizeHost(name);
          const fleetServer = fleetServers.find(server => [server.hostname, server.name]
            .map(normalizeHost)
            .some(candidate => candidate === normalizedName || candidate.split('.')[0] === normalizedName.split('.')[0]));
          return {
            name,
            status: String(node?.status || '').toLowerCase() || 'unknown',
            fleet_server_id: fleetServer?.id || null,
          };
        })
        .filter(node => node.name && PROXMOX_IDENTIFIER_RE.test(node.name));
      const sourceIds = group.connections.map(connection => connection.id).filter(Boolean);
      const adoptedByVm = new Map();
      if (sourceIds.length) {
        const placeholders = sourceIds.map(() => '?').join(', ');
        const adopted = db.db.prepare(`
          SELECT inventory.server_id, inventory.connection_id, inventory.node_name, inventory.vm_id, inventory.guest_type
          FROM proxmox_inventory_servers inventory
          JOIN servers ON servers.id = inventory.server_id
          WHERE inventory.connection_id IN (${placeholders})
        `).all(...sourceIds);
        adopted.forEach(item => adoptedByVm.set(
          `${item.connection_id}:${item.node_name}:${item.vm_id}:${item.guest_type || 'qemu'}`,
          item.server_id
        ));
      }
      const vms = (Array.isArray(resourcesResponse) ? resourcesResponse : [])
        .filter(resource => ['qemu', 'lxc'].includes(String(resource?.type || '').toLowerCase()))
        .map(resource => {
          const nodeName = String(resource?.node || '').trim();
          const vmId = Number(resource?.vmid) || null;
          const guestType = String(resource?.type || '').toLowerCase();
          const fleetServerId = sourceIds
            .map(sourceId => adoptedByVm.get(`${sourceId}:${nodeName}:${vmId}:${guestType}`))
            .find(Boolean) || null;
          return {
            name: String(resource?.name || `${guestType === 'lxc' ? 'CT' : 'VM'} ${resource?.vmid || '?'}`),
            guest_type: guestType,
            node_name: nodeName,
            vm_id: vmId,
            status: String(resource?.status || '').toLowerCase() || 'unknown',
            fleet_server_id: fleetServerId,
          };
        })
        .filter(vm => vm.node_name && Number.isInteger(vm.vm_id));
      return {
        id: group.key,
        endpoint: group.connection.base.host,
        status: nodes.some(node => node.status === 'online') ? 'online' : 'offline',
        connections: group.connections,
        nodes,
        vms,
      };
    }));
    const clusters = [];
    const failedClusterIds = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') clusters.push(result.value);
      else {
        failedClusterIds.push(groups[index].key);
        warnings.push(result.reason?.message || 'A Proxmox connection could not be queried.');
      }
    }
    return { clusters, warnings, failedClusterIds };
  }

  function summarize(infrastructure, environmentId) {
    return {
      environment_id: environmentId,
      updated_at: new Date().toISOString(),
      source_version: sourceVersion(environmentId),
      clusters: (Array.isArray(infrastructure?.clusters) ? infrastructure.clusters : []).map(cluster => ({
        id: cluster.id,
        endpoint: cluster.endpoint,
        status: cluster.status,
        connections: (Array.isArray(cluster.connections) ? cluster.connections : []).map(connection => ({
          id: connection.id,
          name: connection.name,
        })),
        nodes: (Array.isArray(cluster.nodes) ? cluster.nodes : []).map(node => ({
          name: node.name,
          status: node.status,
          fleet_server_id: node.fleet_server_id || null,
        })),
        vms: (Array.isArray(cluster.vms) ? cluster.vms : []).map(vm => ({
          name: vm.name,
          guest_type: vm.guest_type,
          node_name: vm.node_name,
          vm_id: vm.vm_id,
          status: vm.status,
          fleet_server_id: vm.fleet_server_id || null,
        })),
      })),
    };
  }

  function read(environmentId) {
    try {
      const parsed = JSON.parse(db.settings.get(cacheKey(environmentId)) || 'null');
      return parsed && Array.isArray(parsed.clusters) && typeof parsed.updated_at === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function refresh(environmentId) {
    const running = refreshes.get(environmentId);
    if (running) return running;
    refreshAttempts.set(environmentId, Date.now());
    const pending = load(environmentId)
      .then(infrastructure => {
        // Keep each source's last successful snapshot when it is temporarily
        // unavailable, but do not let one failed platform hide fresh results
        // from other platforms in the same environment.
        if ((infrastructure.warnings || []).length > 0) {
          const cached = read(environmentId);
          if (!cached) throw new Error(infrastructure.warnings[0] || 'Proxmox inventory could not be loaded.');
          const liveIds = new Set(infrastructure.clusters.map(cluster => cluster.id));
          const failedIds = new Set(infrastructure.failedClusterIds || []);
          const retained = cached.clusters.filter(cluster =>
            failedIds.has(cluster.id) && !liveIds.has(cluster.id));
          const summary = summarize({ clusters: [...infrastructure.clusters, ...retained] }, environmentId);
          db.settings.set(cacheKey(environmentId), JSON.stringify(summary));
          return summary;
        }
        const summary = summarize(infrastructure, environmentId);
        db.settings.set(cacheKey(environmentId), JSON.stringify(summary));
        return summary;
      })
      .finally(() => refreshes.delete(environmentId));
    refreshes.set(environmentId, pending);
    return pending;
  }

  return async function getInfrastructureSummary(environmentId) {
    const cached = read(environmentId);
    if (!cached) {
      const summary = await refresh(environmentId);
      return { ...summary, cached: false, refreshing: false };
    }
    const age = Date.now() - Date.parse(cached.updated_at);
    const sourceChanged = cached.source_version !== sourceVersion(environmentId);
    // Configuration and host-mapping changes must be visible on the response
    // that discovers them. Returning the old tree here leaves clients with no
    // reliable signal that they need to poll again.
    if (sourceChanged) {
      const summary = await refresh(environmentId);
      return { ...summary, cached: false, refreshing: false };
    }
    const stale = !Number.isFinite(age) || age >= maxAgeMs;
    const lastAttempt = refreshAttempts.get(environmentId) || 0;
    if (stale && Date.now() - lastAttempt >= maxAgeMs) {
      void refresh(environmentId).catch(error => {
        log.warn({ err: error, environmentId }, 'Could not refresh cached Proxmox infrastructure summary');
      });
    }
    return { ...cached, cached: true, refreshing: refreshes.has(environmentId) };
  };
}

module.exports = { createInfrastructureSummary };
