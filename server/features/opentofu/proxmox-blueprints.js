'use strict';

const net = require('net');
const {
  collectUsableIps,
  flattenStateResources,
  isPlainObject,
  normalizeIp,
  normalizePostDeployPlaybooks,
} = require('./core-utils');

// ── Shipyard-managed Proxmox VM blueprints ───────────────────────────────────
// These helpers deliberately generate a separate .tf file.  A workspace may
// still contain hand-written Terraform, but VM definitions created in Shipyard do
// not require its users to edit HCL.
const PROXMOX_VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PROXMOX_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROXMOX_TF_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PROXMOX_INTERFACE_RE = /^(?:scsi|virtio|sata|ide)\d+$/;

function proxmoxInt(value, fallback, { min, max, field }) {
  const raw = String(value ?? '').trim();
  const number = raw === '' ? fallback : (/^\d+$/.test(raw) ? Number(raw) : NaN);
  const result = Number.isFinite(number) ? number : fallback;
  if (raw && !Number.isFinite(number)) throw new Error(`Invalid ${field}`);
  if (result < min || result > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return result;
}

function proxmoxString(value, fallback, { field, pattern = PROXMOX_IDENTIFIER_RE, max = 100 } = {}) {
  const result = String(value ?? fallback ?? '').trim();
  if (!result || result.length > max || !pattern.test(result)) throw new Error(`Invalid ${field}`);
  return result;
}

function normalizeProxmoxVm(input = {}) {
  const diskDiscard = String(input.disk_discard ?? 'on');
  if (!['on', 'ignore'].includes(diskDiscard)) throw new Error('Invalid disk discard setting');
  const ipv4Input = String(input.ipv4_address ?? 'dhcp').trim().toLowerCase();
  const ipv4Prefix = proxmoxInt(input.ipv4_prefix, 24, { min: 0, max: 32, field: 'IPv4 prefix' });
  const ipv4Address = normalizeStaticIpv4Address(ipv4Input, ipv4Prefix);
  const gateway = String(input.ipv4_gateway ?? '').trim();
  if (gateway && !isValidIpv4(gateway)) throw new Error('Invalid IPv4 gateway');
  const dnsInput = Array.isArray(input.dns_servers)
    ? input.dns_servers
    : String(input.dns_servers ?? '').split(/[\s,]+/);
  const dnsServers = [...new Set(dnsInput.map(value => String(value).trim()).filter(Boolean))];
  if (dnsServers.length > 8) throw new Error('At most 8 DNS servers may be configured');
  if (dnsServers.some(server => net.isIP(server) === 0)) throw new Error('DNS servers must be valid IP addresses');
  const vlanRaw = String(input.vlan_id ?? '').trim();
  const vlanId = vlanRaw === '' ? null : proxmoxInt(vlanRaw, null, { min: 1, max: 4094, field: 'VLAN ID' });
  const vmIdRaw = String(input.vm_id ?? '').trim();
  const vmId = vmIdRaw === '' ? null : proxmoxInt(vmIdRaw, null, { min: 100, max: 999999999, field: 'VM ID' });
  const sshPublicKeyVariable = String(input.ssh_public_key_variable ?? '').trim();
  if (sshPublicKeyVariable && !PROXMOX_TF_IDENTIFIER_RE.test(sshPublicKeyVariable)) {
    throw new Error('Invalid SSH public key variable');
  }
  const preDeployPlaybooks = normalizePostDeployPlaybooks(input.pre_deploy_playbooks);
  const preDeployTargetServerId = String(input.pre_deploy_target_server_id || '').trim();
  if (preDeployPlaybooks.length && !preDeployTargetServerId) {
    throw new Error('A target host is required for pre-deploy playbooks');
  }

  return {
    name: proxmoxString(input.name, '', { field: 'VM name', pattern: PROXMOX_VM_NAME_RE, max: 63 }),
    node_name: proxmoxString(input.node_name, '', { field: 'Proxmox node' }),
    vm_id: vmId,
    started: input.started !== false && input.started !== 'false',
    clone_vm_id: proxmoxInt(input.clone_vm_id, 9000, { min: 1, max: 999999999, field: 'Template VM ID' }),
    clone_retries: proxmoxInt(input.clone_retries, 3, { min: 0, max: 10, field: 'Clone retries' }),
    disk_datastore: proxmoxString(input.disk_datastore, '', { field: 'Disk datastore' }),
    disk_interface: proxmoxString(input.disk_interface, 'scsi0', { field: 'Disk interface', pattern: PROXMOX_INTERFACE_RE, max: 10 }),
    disk_size_gb: proxmoxInt(input.disk_size_gb, 40, { min: 1, max: 65536, field: 'Disk size' }),
    disk_discard: diskDiscard,
    cpu_cores: proxmoxInt(input.cpu_cores, 2, { min: 1, max: 128, field: 'CPU cores' }),
    cpu_type: proxmoxString(input.cpu_type, 'host', { field: 'CPU type', pattern: /^[A-Za-z0-9._-]{1,60}$/, max: 60 }),
    memory_mb: proxmoxInt(input.memory_mb, 4096, { min: 256, max: 1048576, field: 'Memory' }),
    agent_enabled: input.agent_enabled !== false && input.agent_enabled !== 'false',
    bridge: proxmoxString(input.bridge, 'vmbr0', { field: 'Network bridge' }),
    vlan_id: vlanId,
    ipv4_address: ipv4Address,
    ipv4_prefix: ipv4Address === 'dhcp' ? null : Number(ipv4Address.split('/')[1]),
    ipv4_gateway: ipv4Address === 'dhcp' ? '' : gateway,
    dns_servers: dnsServers,
    username: proxmoxString(input.username, 'ubuntu', { field: 'VM username', pattern: /^[a-z_][a-z0-9_-]{0,31}$/, max: 32 }),
    ssh_public_key_variable: sshPublicKeyVariable,
    pre_deploy_target_server_id: preDeployTargetServerId,
    pre_deploy_playbooks: preDeployPlaybooks,
    post_deploy_playbooks: normalizePostDeployPlaybooks(input.post_deploy_playbooks),
  };
}

function normalizeProxmoxVmTemplate(input = {}) {
  if (!isPlainObject(input.config)) throw new Error('The VM template does not contain a valid configuration');
  return {
    name: proxmoxString(input.name, '', {
      field: 'VM template name', pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/, max: 63,
    }),
    config: normalizeProxmoxVm(input.config),
  };
}

function normalizeStaticIpv4Address(value, fallbackPrefix) {
  if (value === 'dhcp') return 'dhcp';
  const [address, inlinePrefix] = String(value || '').split('/', 2);
  const prefix = inlinePrefix === undefined || inlinePrefix === ''
    ? fallbackPrefix
    : proxmoxInt(inlinePrefix, fallbackPrefix, { min: 0, max: 32, field: 'IPv4 prefix' });
  if (!isValidIpv4(address)) throw new Error('IPv4 address must be DHCP or a valid IPv4 address');
  return `${address}/${prefix}`;
}

function isValidIpv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
}

function renderProxmoxVmHcl(vm) {
  const lines = [
    `resource "proxmox_virtual_environment_vm" ${JSON.stringify(vm.name)} {`,
    `  name      = ${JSON.stringify(vm.name)}`,
    `  node_name = ${JSON.stringify(vm.node_name)}`,
  ];
  if (vm.vm_id !== null && vm.vm_id !== undefined) lines.push(`  vm_id     = ${vm.vm_id}`);
  lines.push(
    `  started   = ${vm.started}`,
    '', '  clone {', `    vm_id   = ${vm.clone_vm_id}`, `    retries = ${vm.clone_retries}`, '  }',
    '', '  disk {', `    datastore_id = ${JSON.stringify(vm.disk_datastore)}`,
    `    interface    = ${JSON.stringify(vm.disk_interface)}`, `    size         = ${vm.disk_size_gb}`,
    `    discard      = ${JSON.stringify(vm.disk_discard)}`, '  }',
    '', '  cpu {', `    cores = ${vm.cpu_cores}`, `    type  = ${JSON.stringify(vm.cpu_type)}`, '  }',
    '', '  memory {', `    dedicated = ${vm.memory_mb}`, '  }',
    '', '  agent {', `    enabled = ${vm.agent_enabled}`, '  }',
    '', '  network_device {', `    bridge = ${JSON.stringify(vm.bridge)}`,
  );
  if (vm.vlan_id !== null) lines.push(`    vlan_id = ${vm.vlan_id}`);
  lines.push('  }', '', '  initialization {');
  if (vm.dns_servers.length) {
    lines.push('    dns {', `      servers = ${JSON.stringify(vm.dns_servers)}`, '    }', '');
  }
  lines.push('    ip_config {', '      ipv4 {', `        address = ${JSON.stringify(vm.ipv4_address)}`);
  if (vm.ipv4_gateway) lines.push(`        gateway = ${JSON.stringify(vm.ipv4_gateway)}`);
  lines.push('      }', '    }', '', '    user_account {', `      username = ${JSON.stringify(vm.username)}`);
  if (vm.ssh_public_key_variable) lines.push(`      keys     = [var.${vm.ssh_public_key_variable}]`);
  lines.push('    }', '  }', '}');
  return lines.join('\n');
}

function buildProxmoxProviderFiles(vms) {
  const sshVariables = [...new Set(vms.map(vm => vm.ssh_public_key_variable).filter(Boolean))];
  return {
    provider: `# Generated by Shipyard. Connection values are set under Variables in this workspace.\nterraform {\n  required_providers {\n    proxmox = {\n      source  = "bpg/proxmox"\n      version = "~> 0.66"\n    }\n  }\n}\n\nprovider "proxmox" {\n  endpoint  = var.proxmox_endpoint\n  api_token = var.proxmox_api_token\n  insecure  = var.proxmox_insecure\n}\n`,
    variables: `# Generated by Shipyard. Secret values are never written to this file.\nvariable "proxmox_endpoint" {\n  type = string\n}\n\nvariable "proxmox_api_token" {\n  type      = string\n  sensitive = true\n}\n\nvariable "proxmox_insecure" {\n  type    = bool\n  default = false\n}\n${sshVariables.map(name => `\nvariable "${name}" {\n  type      = string\n  sensitive = true\n}\n`).join('')}`,
    vms: `# Generated by Shipyard OpenTofu VM form. Edit VMs in the Shipyard console.\n\n${vms.map(renderProxmoxVmHcl).join('\n\n')}\n`,
  };
}

function getProxmoxStateResources(state) {
  const resources = flattenStateResources(state?.values?.root_module);
  return resources.filter(resource => resource.type === 'proxmox_virtual_environment_vm');
}

function normalizeResourceKey(resource) {
  if (!resource) return null;
  const address = String(resource.address || '').trim();
  return address ? `resource:${address}` : null;
}

function extractProxmoxGuestNetworkRecords(payload) {
  const interfaces = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.result) ? payload.result : []);
  const result = [];
  for (const iface of interfaces) {
    if (!iface || String(iface.name || '').toLowerCase() === 'lo') continue;
    const compactMac = String(iface['hardware-address'] || iface.hardware_address || iface.mac_address || iface.mac || '')
      .toLowerCase().replace(/[^a-f0-9]/g, '');
    const macAddress = compactMac.length === 12 ? compactMac.match(/.{2}/g).join(':') : '';
    const addresses = Array.isArray(iface['ip-addresses'])
      ? iface['ip-addresses']
      : (Array.isArray(iface.ip_addresses) ? iface.ip_addresses : []);
    for (const address of addresses) {
      const type = String(address?.['ip-address-type'] || address?.ip_address_type || '').toLowerCase();
      const ip = normalizeIp(address?.['ip-address'] || address?.ip_address || address?.address);
      if (!ip || net.isIP(ip) !== 4 || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if ((!type || type === 'ipv4') && !result.some(record => record.address === ip))
        result.push({ address: ip, mac_address: macAddress });
    }
  }
  return result;
}
function extractProxmoxLxcNetworkRecords(payload) {
  const interfaces = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.result) ? payload.result : []);
  const result = [];
  for (const iface of interfaces) {
    if (!iface || String(iface.name || '').toLowerCase() === 'lo') continue;
    const compactMac = String(iface.hwaddr || iface['hardware-address'] || iface.mac_address || iface.mac || '')
      .toLowerCase().replace(/[^a-f0-9]/g, '');
    const macAddress = compactMac.length === 12 ? compactMac.match(/.{2}/g).join(':') : '';
    const candidates = [iface.inet, iface.address, ...(Array.isArray(iface.ip_addresses) ? iface.ip_addresses : [])];
    for (const candidate of candidates) {
      const ip = normalizeIp(typeof candidate === 'object' ? candidate?.address : candidate);
      if (!ip || net.isIP(ip) !== 4 || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!result.some(record => record.address === ip)) result.push({ address: ip, mac_address: macAddress });
    }
  }
  return result;
}
function extractProxmoxGuestIpv4s(payload) {
  return extractProxmoxGuestNetworkRecords(payload).map(record => record.address);
}
function extractProxmoxGuestIpv4(payload) { return extractProxmoxGuestIpv4s(payload)[0] || null; }
function ipv4Number(value) {
  const chunks = String(value || '').split('.');
  if (chunks.length !== 4 || chunks.some(chunk => !/^\d{1,3}$/.test(chunk) || Number(chunk) > 255)) return null;
  return chunks.reduce((total, chunk) => total * 256 + Number(chunk), 0) >>> 0;
}
function subnetContainsIpv4(cidr, address) {
  const [networkAddress, prefixText] = String(cidr || '').split('/');
  const prefix = Number(prefixText); const network = ipv4Number(networkAddress); const ip = ipv4Number(address);
  if (network === null || ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (network & mask) === (ip & mask);
}

function applyFleetProxmoxBlueprintMetadata({ servers, state, vms, guestIps = new Map() }) {
  const resourcesByKey = new Map(
    getProxmoxStateResources(state)
      .map(resource => [normalizeResourceKey(resource), resource])
      .filter(([key]) => key)
  );
  const vmByResourceKey = new Map((Array.isArray(vms) ? vms : []).map(vm => [
    `resource:proxmox_virtual_environment_vm.${vm.name}`,
    vm,
  ]));
  const pendingDhcpResourceKeys = [];

  const enriched = (Array.isArray(servers) ? servers : []).map(server => {
    const vm = vmByResourceKey.get(server.resource_key);
    if (!vm) return server;

    const resource = resourcesByKey.get(server.resource_key);
    const guestIp = guestIps.get(server.resource_key);
    const next = {
      ...server,
      // The Cloud-Init account is the account Shipyard must use afterwards. Never
      // fall back to the generic provider default for form-created VMs.
      ssh_user: vm.username || server.ssh_user,
      hostname: vm.name || server.hostname,
    };
    if (guestIp) next.ip_address = guestIp;

    // A successful agent query without a routable address means DHCP is still
    // in progress. Let the existing state retry loop wait for the real lease.
    if (vm.ipv4_address === 'dhcp' && resource && !guestIp) {
      pendingDhcpResourceKeys.push(server.resource_key);
    }
    return next;
  });

  return { servers: enriched, pendingDhcpResourceKeys };
}

function buildProxmoxResourceOverview(vms, state = null, managedServersByVm = new Map()) {
  const nodeMap = new Map();
  const addToNode = vm => {
    const entry = nodeMap.get(vm.node_name) || { name: vm.node_name, vm_count: 0, cpu_cores: 0, memory_mb: 0, disk_gb: 0 };
    entry.vm_count++; entry.cpu_cores += vm.cpu_cores; entry.memory_mb += vm.memory_mb; entry.disk_gb += vm.disk_size_gb;
    nodeMap.set(vm.node_name, entry);
  };
  vms.forEach(addToNode);
  const actual = getProxmoxStateResources(state).map(resource => {
    const nodeName = resource.values?.node_name || null;
    const vmId = resource.values?.vm_id || null;
    const managed = nodeName && vmId !== null ? managedServersByVm.get(`${nodeName}:${vmId}`) : null;
    return {
      address: resource.address,
      name: resource.values?.name || resource.name,
      node_name: nodeName,
      vm_id: vmId,
      status: resource.values?.started === false ? 'stopped' : 'managed',
      // A deployment may describe a VM which has already been adopted as a
      // host. Expose that relationship so the console can lead directly
      // from desired state to operational management.
      fleet_server_id: managed?.server_id || null,
      fleet_server_name: managed?.hostname || null,
      // Proxmox exposes loopback before the configured NIC in many states.
      // Present only routable guest addresses in the resource overview.
      ip_addresses: collectUsableIps(resource.values?.ipv4_addresses || []),
    };
  });
  return {
    desired: {
      vm_count: vms.length,
      cpu_cores: vms.reduce((sum, vm) => sum + vm.cpu_cores, 0),
      memory_mb: vms.reduce((sum, vm) => sum + vm.memory_mb, 0),
      disk_gb: vms.reduce((sum, vm) => sum + vm.disk_size_gb, 0),
      nodes: [...nodeMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    actual: { available: !!state, vm_count: actual.length, resources: actual },
  };
}

function buildProxmoxNetworkCatalog(networkResponse, zonesResponse, vnetsResponse, nodeName) {
  const nodeNetworks = Array.isArray(networkResponse) ? networkResponse : [];
  const activeByName = new Map(nodeNetworks
    .filter(item => item?.iface)
    .map(item => [String(item.iface), item.active === 1 || item.active === '1' || item.active === true]));
  const zones = (Array.isArray(zonesResponse) ? zonesResponse : [])
    .map(item => {
      const name = String(item?.zone || item?.id || '').trim();
      const nodes = Array.isArray(item?.nodes)
        ? item.nodes.map(String)
        : String(item?.nodes || '').split(',').map(value => value.trim()).filter(Boolean);
      return {
        id: name,
        name,
        type: String(item?.type || '').trim(),
        bridge: String(item?.bridge || '').trim(),
        nodes,
        available_on_node: nodes.length === 0 || nodes.includes(nodeName),
      };
    })
    .filter(item => item.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const zonesByName = new Map(zones.map(zone => [zone.name, zone]));
  const vnets = (Array.isArray(vnetsResponse) ? vnetsResponse : [])
    .map(item => {
      const name = String(item?.vnet || item?.id || '').trim();
      const zone = String(item?.zone || '').trim();
      const parsedTag = Number.parseInt(String(item?.tag ?? ''), 10);
      const zoneEntry = zonesByName.get(zone);
      return {
        id: name,
        name,
        zone,
        zone_type: zoneEntry?.type || '',
        alias: String(item?.alias || '').trim(),
        vlan_id: Number.isInteger(parsedTag) && parsedTag >= 1 && parsedTag <= 4094 ? parsedTag : null,
        active: activeByName.get(name) === true,
        available_on_node: zoneEntry ? zoneEntry.available_on_node : true,
      };
    })
    .filter(item => item.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const vnetsByName = new Map(vnets.map(vnet => [vnet.name, vnet]));
  const bridges = nodeNetworks
    .filter(item => item?.iface && (item.type === 'bridge' || String(item.iface).startsWith('vmbr')))
    .map(item => {
      const name = String(item.iface);
      const vnet = vnetsByName.get(name);
      return vnet
        ? { ...vnet, source: 'sdn' }
        : { name, id: name, source: 'node', active: activeByName.get(name) === true, available_on_node: true };
    });
  for (const vnet of vnets) {
    if (!bridges.some(bridge => bridge.name === vnet.name)) bridges.push({ ...vnet, source: 'sdn' });
  }
  const vlans = [...new Map(vnets
    .filter(vnet => vnet.vlan_id !== null)
    .map(vnet => [vnet.vlan_id, { id: String(vnet.vlan_id), vlan_id: vnet.vlan_id, vnet: vnet.name, zone: vnet.zone }])).values()]
    .sort((a, b) => a.vlan_id - b.vlan_id);

  return {
    bridges: bridges.sort((a, b) => a.name.localeCompare(b.name, 'de')),
    sdn_zones: zones,
    sdn_vnets: vnets,
    vlans,
  };
}


module.exports = {
  PROXMOX_IDENTIFIER_RE,
  applyFleetProxmoxBlueprintMetadata,
  buildProxmoxProviderFiles,
  buildProxmoxNetworkCatalog,
  buildProxmoxResourceOverview,
  extractProxmoxGuestIpv4,
  extractProxmoxGuestIpv4s,
  extractProxmoxGuestNetworkRecords,
  extractProxmoxLxcNetworkRecords,
  getProxmoxStateResources,
  ipv4Number,
  normalizeProxmoxVm,
  normalizeProxmoxVmTemplate,
  renderProxmoxVmHcl,
  subnetContainsIpv4,
};
