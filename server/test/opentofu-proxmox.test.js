const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../../plugins/opentofu');

test('Proxmox VM blueprint normalizes the console form and renders safe HCL', () => {
  const vm = _test.normalizeProxmoxVm({
    name: 'hr01-app-erpnext', node_name: 'pve001', vm_id: '101', clone_vm_id: '9000', clone_retries: '3',
    disk_datastore: 'NVME_VM_Store', disk_interface: 'scsi0', disk_size_gb: '40',
    cpu_cores: '2', memory_mb: '4048', bridge: 'vmbr0', vlan_id: '2010',
    ipv4_address: 'dhcp', username: 'ubuntu', ssh_public_key_variable: 'ssh_public_key',
  });
  assert.equal(vm.vlan_id, 2010);
  assert.equal(vm.memory_mb, 4048);
  const hcl = _test.renderProxmoxVmHcl(vm);
  assert.match(hcl, /resource "proxmox_virtual_environment_vm" "hr01-app-erpnext"/);
  assert.match(hcl, /vm_id\s+= 101/);
  assert.match(hcl, /vlan_id = 2010/);
  assert.match(hcl, /keys     = \[var\.ssh_public_key\]/);
});

test('Proxmox VM blueprint rejects unsafe identifiers and invalid VLAN values', () => {
  assert.throws(() => _test.normalizeProxmoxVm({
    name: 'bad name', node_name: 'pve001', disk_datastore: 'store', bridge: 'vmbr0',
  }), /Invalid VM name/);
  assert.throws(() => _test.normalizeProxmoxVm({
    name: 'valid', node_name: 'pve001', disk_datastore: 'store', bridge: 'vmbr0', vlan_id: 5000,
  }), /VLAN ID/);
});

test('Proxmox VM blueprint does not require an SSH public key unless explicitly configured', () => {
  const vm = _test.normalizeProxmoxVm({
    name: 'app-without-key', node_name: 'pve001', disk_datastore: 'fast', bridge: 'vmbr0',
  });
  assert.equal(vm.ssh_public_key_variable, '');
  assert.doesNotMatch(_test.renderProxmoxVmHcl(vm), /keys\s+=/);
  assert.doesNotMatch(_test.buildProxmoxProviderFiles([vm]).variables, /ssh_public_key/);
});

test('Proxmox VM blueprint adds a subnet prefix to a bare static IPv4 address', () => {
  const vm = _test.normalizeProxmoxVm({
    name: 'static-ip-vm', node_name: 'pve001', disk_datastore: 'fast', bridge: 'vmbr0',
    ipv4_address: '10.10.1.111', ipv4_prefix: '24', ipv4_gateway: '10.10.1.1',
  });
  assert.equal(vm.ipv4_address, '10.10.1.111/24');
  assert.equal(vm.ipv4_prefix, 24);
  assert.match(_test.renderProxmoxVmHcl(vm), /address = "10\.10\.1\.111\/24"/);
  assert.throws(() => _test.normalizeProxmoxVm({
    name: 'bad-static-vm', node_name: 'pve001', disk_datastore: 'fast', bridge: 'vmbr0', ipv4_address: '10.10.1.111', ipv4_prefix: '33',
  }), /IPv4 prefix/);
});

test('Proxmox catalog connection keeps API credentials server-side and preserves query parameters', () => {
  const connection = _test.readProxmoxConnection({
    TF_VAR_proxmox_endpoint: 'https://pve.example.test:8006/',
    TF_VAR_proxmox_api_token: 'root@pam!fleet=secret',
    TF_VAR_proxmox_insecure: 'true',
  });
  const url = _test.proxmoxApiUrl(connection, '/nodes/pve001/qemu?full=1');
  assert.equal(url.toString(), 'https://pve.example.test:8006/api2/json/nodes/pve001/qemu?full=1');
  assert.equal(connection.insecure, true);
  assert.throws(() => _test.readProxmoxConnection({ TF_VAR_proxmox_endpoint: 'http://pve.example.test' }), /nicht konfiguriert/);
});

test('Proxmox resource overview totals desired capacity and reads state resources', () => {
  const vm = _test.normalizeProxmoxVm({
    name: 'app-1', node_name: 'pve001', disk_datastore: 'fast', bridge: 'vmbr0', cpu_cores: 4, memory_mb: 8192, disk_size_gb: 80,
  });
  const overview = _test.buildProxmoxResourceOverview([vm], {
    values: { root_module: { resources: [{
      address: 'proxmox_virtual_environment_vm.app-1', type: 'proxmox_virtual_environment_vm', name: 'app-1',
      values: { name: 'app-1', node_name: 'pve001', vm_id: 101, started: true, ipv4_addresses: [['127.0.0.1', '10.20.0.10']] },
    }] } },
  });
  assert.deepEqual(overview.desired, { vm_count: 1, cpu_cores: 4, memory_mb: 8192, disk_gb: 80, nodes: [{ name: 'pve001', vm_count: 1, cpu_cores: 4, memory_mb: 8192, disk_gb: 80 }] });
  assert.equal(overview.actual.resources[0].vm_id, 101);
  assert.deepEqual(overview.actual.resources[0].ip_addresses, ['10.20.0.10']);
});
