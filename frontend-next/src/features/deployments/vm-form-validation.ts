export const VM_STEPS = ['Template & identity', 'Resources', 'Network & access', 'Automation', 'Review'] as const;

type Values = Record<string, string | boolean>;
export function validateVmForm(form: Values, preDeploy: string[], target: string) {
  const errors: Record<string, string> = {};
  const integer = (key: string, label: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(form[key]);
    if (String(form[key]).trim() === '' || !Number.isInteger(value) || value < min || value > max) {
      errors[label] = `Enter a whole number between ${min} and ${max === Number.MAX_SAFE_INTEGER ? 'the supported capacity' : max}.`;
    }
  };
  const ipv4 = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(form.name).trim())) errors['VM name'] = 'Use 1–63 letters, digits, dots, underscores or hyphens; start with a letter or digit.';
  if (!form.node_name) errors['Proxmox node'] = 'Select a node.';
  integer('vm_id', 'Target VM ID', 100, 999999999);
  integer('clone_vm_id', 'Template', 100, 999999999);
  integer('clone_retries', 'Clone attempts', 0, 10);
  if (!form.disk_datastore) errors.Datastore = 'Select a datastore.';
  integer('disk_size_gb', 'Disk size (GiB)', 1);
  integer('cpu_cores', 'CPU cores', 1);
  integer('memory_mb', 'Memory (MiB)', 256);
  if (!String(form.disk_interface).trim()) errors['Disk interface'] = 'Enter a disk interface.';
  if (!String(form.cpu_type).trim()) errors['CPU type'] = 'Select a CPU type.';
  if (!String(form.bridge).trim()) errors['Bridge / SDN VNet'] = 'Select a network.';
  if (String(form.vlan_id).trim()) integer('vlan_id', 'VM VLAN-ID (optional)', 1, 4094);
  if (form.ipv4_mode === 'static') {
    if (!ipv4(String(form.ipv4_address).trim())) errors['IPv4 address'] = 'Enter a valid IPv4 address.';
    integer('ipv4_prefix', 'Prefix', 0, 32);
    if (String(form.ipv4_gateway).trim() && !ipv4(String(form.ipv4_gateway).trim())) errors['Gateway (optional)'] = 'Enter a valid IPv4 gateway or leave it empty.';
  }
  if (!String(form.username).trim()) errors['VM user'] = 'Enter the login account to configure in this VM.';
  if (form.ssh_port !== undefined) integer('ssh_port', 'SSH port', 1, 65535);
  if (form.started === false) errors['Start VM'] = 'Start the VM so Shipyard can connect and run post-deploy playbooks.';
  if (form.ipv4_mode === 'dhcp' && form.agent_enabled === false) errors['Guest agent'] = 'Enable the guest agent to discover the DHCP address.';
  if (preDeploy.length && !target) errors['Execution host'] = 'Select the host that runs the pre-deploy workflows.';
  const groups = [
    ['VM name', 'Proxmox node', 'Target VM ID', 'Template'],
    ['Datastore', 'Disk size (GiB)', 'CPU cores', 'Memory (MiB)', 'Disk interface', 'CPU type', 'Clone attempts'],
    ['Bridge / SDN VNet', 'VM VLAN-ID (optional)', 'IPv4 address', 'Prefix', 'Gateway (optional)', 'VM user', 'SSH port', 'Start VM', 'Guest agent'],
    ['Execution host'],
  ];
  return { errors, steps: groups.map(labels => labels.filter(label => errors[label])) };
}
