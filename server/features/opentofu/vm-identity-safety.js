'use strict';

const { getProxmoxStateResources } = require('./proxmox-blueprints');
const { readProxmoxConnection, requestProxmoxApi } = require('./proxmox-client');

/** Validate live identity before mutation or completion. Never repairs drift. */
async function verifyVmIdentity({ workspace, vms, state, plan, checkConfiguration = true, request = requestProxmoxApi }) {
  if (workspace.workspace_kind === 'isolated_vm' && vms.length !== 1) throw new Error('This deployment must own exactly one VM definition.');
  const plannedVms = (plan?.resource_changes || []).filter(item => item.type === 'proxmox_virtual_environment_vm' || String(item.address).includes('proxmox_virtual_environment_vm.'));
  if (plannedVms.some(item => !vms.some(vm => item.address === `proxmox_virtual_environment_vm.${vm.name}`))) throw new Error('The plan contains a VM with no deployment ownership.');
  if (!vms.length) return;
  const connection = readProxmoxConnection(workspace.env_vars);
  const inventory = await request(connection, '/cluster/resources?type=vm');
  if (!Array.isArray(inventory)) throw new Error('Proxmox VM inventory could not be verified. Retry when the connection is available.');
  const resources = getProxmoxStateResources(state);
  if (resources.some(resource => !vms.some(vm => resource.address === `proxmox_virtual_environment_vm.${vm.name}`))) {
    throw new Error('The state contains a VM outside this deployment. Correct the state before continuing.');
  }
  for (const vm of vms) {
    const address = `proxmox_virtual_environment_vm.${vm.name}`;
    if (resources.filter(item => item.address === address).length > 1) throw new Error('VM ownership is ambiguous in the state.');
    const resource = resources.find(item => item.address === address);
    const change = plan?.resource_changes?.find(item => item.address === address);
    if (change && !change.change?.actions?.every(action => ['no-op', 'read'].includes(action))) {
      if (Number(change.change.after?.vm_id) !== Number(vm.vm_id) || change.change.after?.node_name !== vm.node_name || change.change.after?.description !== `Shipyard VM ${vm.id}`) throw new Error('The plan VM identity or ownership marker differs from this deployment. Create a new plan.');
    }
    const creating = change?.change?.actions?.includes('create');
    if (change?.change?.before && (Number(change.change.before.vm_id) !== Number(vm.vm_id) || change.change.before.node_name !== vm.node_name || change.change.before.description !== `Shipyard VM ${vm.id}`)) throw new Error('The saved plan references a different existing VM. Create a new plan.');
    const id = Number(vm.vm_id || resource?.values?.vm_id);
    if (!Number.isInteger(id) || id < 100) throw new Error('Choose an explicit, available VM ID before deployment.');
    const live = inventory.filter(item => Number(item.vmid) === id);
    if (creating) {
      if (resource || live.length) throw new Error(`VM ID ${id} already exists or is present in state. Choose a free ID; existing VMs cannot be adopted.`);
      if (Number(change.change.after?.vm_id) !== id || change.change.after?.node_name !== vm.node_name) throw new Error('The plan VM identity differs from this deployment. Create a new plan.');
      continue;
    }
    if (!resource || Number(resource.values?.vm_id) !== id || resource.values?.node_name !== vm.node_name || live.length !== 1 || live[0].node !== vm.node_name || live[0].type !== 'qemu' || live[0].name !== vm.name) {
      throw new Error(`VM ${id} is missing or its identity differs from this deployment. Check Proxmox and the deployment state; no VM will be recreated.`);
    }
    const config = await request(connection, `/nodes/${encodeURIComponent(vm.node_name)}/qemu/${id}/config`);
    const marker = `Shipyard VM ${vm.id}`;
    if (!vm.id || config?.description !== marker || resource.values?.description !== marker) {
      throw new Error(`Ownership of VM ${id} cannot be verified. Check its Shipyard ownership marker and state manually.`);
    }
    if (!plan && checkConfiguration) {
      const net = String(config.net0 || '');
      const bridge = net.match(/(?:^|,)bridge=([^,]+)/)?.[1];
      const vlan = Number(net.match(/(?:^|,)tag=(\d+)/)?.[1] || 0);
      const disk = String(config[vm.disk_interface] || '');
      const diskSize = disk.match(/(?:^|,)size=([0-9.]+)([KMGT])(?:,|$)/);
      const sizeGb = diskSize ? Number(diskSize[1]) * ({ K: 1 / 1048576, M: 1 / 1024, G: 1, T: 1024 }[diskSize[2]]) : NaN;
      if (vm.disk_interface && (sizeGb !== vm.disk_size_gb || !disk.startsWith(`${vm.disk_datastore}:`))) throw new Error(`VM ${id} disk differs from the deployment. Review storage and disk size before retrying.`);
      if (vm.ipv4_address && vm.ipv4_address !== 'dhcp' && !String(config.ipconfig0 || '').split(',').includes(`ip=${vm.ipv4_address}`)) throw new Error(`VM ${id} IPv4 configuration differs from the deployment.`);
      if (vm.username && config.ciuser !== vm.username) throw new Error(`VM ${id} SSH user configuration differs from the deployment.`);
      if (vm.started && live[0].status !== 'running') throw new Error(`VM ${id} is not running. Start it in Proxmox, then retry.`);
      if (Number(config.cores) !== vm.cpu_cores || Number(config.memory) !== vm.memory_mb || bridge !== vm.bridge || vlan !== Number(vm.vlan_id || 0)) {
        throw new Error(`VM ${id} configuration differs from the deployment (CPU, memory or network). Review the configuration before retrying.`);
      }
    }
  }
}
module.exports = { verifyVmIdentity };
