'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyVmIdentity } = require('../features/opentofu/vm-identity-safety');
const vm = { id: 'owned-uuid', name: 'app', vm_id: 123, node_name: 'pve', cpu_cores: 2, memory_mb: 2048, bridge: 'vmbr0', vlan_id: null };
const address = 'proxmox_virtual_environment_vm.app';
const workspace = { env_vars: { TF_VAR_proxmox_endpoint: 'https://pve:8006', TF_VAR_proxmox_api_token: 'user@pve!token=secret' } };
const state = { values: { root_module: { resources: [{ type: 'proxmox_virtual_environment_vm', address, values: { vm_id: 123, node_name: 'pve', description: 'Shipyard VM owned-uuid' } }] } } };
const guest = { vmid: 123, node: 'pve', name: 'app', type: 'qemu' };
const config = { description: 'Shipyard VM owned-uuid', cores: 2, memory: 2048, net0: 'virtio=AA:BB,bridge=vmbr0' };
const plan = { resource_changes: [{ address, change: { actions: ['create'], after: { vm_id: 123, node_name: 'pve', description: 'Shipyard VM owned-uuid' } } }] };
const check = (options = {}, guests = [guest], liveConfig = config) => verifyVmIdentity({ workspace, vms: [vm], state, request: async (_connection, path) => path.startsWith('/cluster') ? guests : liveConfig, ...options });
test('new deployment requires an unused ID and empty state', async () => {
  await check({ state: {}, plan }, []);
  await assert.rejects(check({ state: {}, plan }), /already exists/);
  await assert.rejects(check({ plan }, []), /already exists/);
});
test('retry validates VM existence, node, name and ownership', async () => {
  await check();
  await assert.rejects(check({}, []), /missing/);
  await assert.rejects(check({}, [{ ...guest, node: 'other' }]), /identity/);
  await assert.rejects(check({}, [{ ...guest, name: 'other' }]), /identity/);
  await assert.rejects(check({}, [guest], { ...config, description: 'someone else' }), /Ownership/);
});
test('retry blocks configuration drift', async () => {
  for (const patch of [{ cores: 4 }, { memory: 4096 }, { net0: 'bridge=other' }, { net0: 'bridge=vmbr0,tag=10' }]) {
    await assert.rejects(check({}, [guest], { ...config, ...patch }), /configuration differs/);
  }
});
test('foreign state and a mismatched plan fail closed', async () => {
  await assert.rejects(check({ vms: [{ ...vm, name: 'different' }] }), /outside/);
  await assert.rejects(check({ state: {}, plan: { resource_changes: [{ address, change: { actions: ['create'], after: { vm_id: 999, node_name: 'pve' } } }] } }, []), /plan VM identity/);
});

test('retry checks disk, static IP, SSH user and running state', async () => {
  const definition = {...vm,disk_interface:'scsi0',disk_datastore:'local-lvm',disk_size_gb:40,username:'ubuntu',ipv4_address:'10.0.0.2/24',started:true};
  const running = {...guest,status:'running'};
  const actual = {...config,scsi0:'local-lvm:vm-123-disk-0,size=40G',ciuser:'ubuntu',ipconfig0:'ip=10.0.0.2/24'};
  await check({vms:[definition]},[running],actual);
  for (const patch of [{scsi0:'local-lvm:disk,size=80G'},{scsi0:'other:disk,size=40G'},{ciuser:'root'},{ipconfig0:'ip=10.0.0.3/24'}]) {
    await assert.rejects(check({vms:[definition]},[running],{...actual,...patch}),/differs/);
  }
  await assert.rejects(check({vms:[definition]},[guest],actual),/not running/);
});

test('existing updates cannot change the VM identity through the saved plan', async () => {
  const update = {resource_changes:[{address,change:{actions:['update'],before:{vm_id:999,node_name:'pve',description:'Shipyard VM owned-uuid'},after:{vm_id:123,node_name:'pve',description:'Shipyard VM owned-uuid'}}}]};
  await assert.rejects(check({plan:update}),/different existing VM/);
});
