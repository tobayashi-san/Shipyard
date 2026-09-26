'use strict';

// Which Proxmox VM or container a Fleet host runs on: imported from the
// platform inventory, or deployed by Fleet through OpenTofu. Reads stored
// links only; callers confirm the guest live before acting on it.
const db = require('../../db');

function tableExists(name) {
  return !!db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** @returns {{ connection_id: string|null, node_name: string|null, vm_id: number, guest_type: 'qemu'|'lxc' } | null} */
function hostGuest(serverId) {
  if (tableExists('proxmox_inventory_servers')) {
    const imported = db.db.prepare('SELECT connection_id, node_name, vm_id, guest_type FROM proxmox_inventory_servers WHERE server_id = ?').get(serverId);
    if (imported) return { ...imported, vm_id: Number(imported.vm_id), guest_type: imported.guest_type === 'lxc' ? 'lxc' : 'qemu' };
  }
  if (tableExists('tofu_managed_servers') && tableExists('tofu_proxmox_vms')) {
    const managed = db.db.prepare(`SELECT vm.config, vm.vm_numeric_id, vm.connection_id, workspace.proxmox_connection_id
      FROM tofu_managed_servers mapping
      JOIN tofu_proxmox_vms vm ON vm.workspace_id = mapping.workspace_id
        AND mapping.resource_key = 'resource:proxmox_virtual_environment_vm.' || vm.name
      LEFT JOIN tofu_workspaces workspace ON workspace.id = mapping.workspace_id
      WHERE mapping.server_id = ? LIMIT 1`).get(serverId);
    if (managed) {
      let config = {};
      try { config = JSON.parse(managed.config || '{}'); } catch {}
      const vmId = Number(managed.vm_numeric_id || config.vm_id);
      if (Number.isInteger(vmId) && vmId > 0) {
        return { connection_id: managed.connection_id || managed.proxmox_connection_id || null, node_name: config.node_name || null, vm_id: vmId, guest_type: 'qemu' };
      }
    }
  }
  return null;
}

/** The guest of a host on a saved platform connection of the host's own environment. */
function linkedGuest(server) {
  const guest = hostGuest(server.id);
  if (!guest?.connection_id || !tableExists('tofu_proxmox_connections')) return null;
  const source = db.db.prepare('SELECT environment_id FROM tofu_proxmox_connections WHERE id = ?').get(guest.connection_id);
  return source && source.environment_id === (server.environment_id || 'default') ? guest : null;
}

module.exports = { hostGuest, linkedGuest };
