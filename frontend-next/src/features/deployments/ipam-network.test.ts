import { describe, expect, it } from 'vitest';
import { resolveIpamNetwork } from './ipam-network';

const sdn = [
  { name: 'vmbr0', source: 'node' as const },
  { name: 'vlan30', source: 'sdn' as const, vlan_id: 30 },
  { name: 'vlan40', source: 'sdn' as const, vlan_id: 40 },
];

describe('IPAM network selection', () => {
  it('uses the named VNet without a second tag, also when the prefix has no platform', () => {
    expect(resolveIpamNetwork({ bridge: 'vlan30', connectionId: '', vlan: '30' }, sdn, 'pve')).toMatchObject({ bridge: 'vlan30', vlan: '' });
  });
  it('finds the SDN VNet by VLAN when the prefix names no bridge', () => {
    expect(resolveIpamNetwork({ bridge: '', connectionId: '', vlan: '40' }, sdn, 'pve')).toMatchObject({ bridge: 'vlan40', vlan: '' });
  });
  it('tags the NIC on a VLAN-aware bridge when there is no SDN', () => {
    expect(resolveIpamNetwork({ bridge: '', connectionId: '', vlan: '30' }, [{ name: 'vmbr0', source: 'node' }], 'pve')).toMatchObject({ bridge: 'vmbr0', vlan: '30' });
    expect(resolveIpamNetwork({ bridge: 'vmbr1', connectionId: 'pve', vlan: '30' }, [{ name: 'vmbr0' }, { name: 'vmbr1' }], 'pve')).toMatchObject({ bridge: 'vmbr1', vlan: '30' });
  });
  it('refuses ambiguous or foreign networks', () => {
    expect(resolveIpamNetwork({ bridge: '', connectionId: '', vlan: '30' }, [{ name: 'vmbr0' }, { name: 'vmbr1' }], 'pve').bridge).toBe('');
    expect(resolveIpamNetwork({ bridge: 'vlan30', connectionId: 'other', vlan: '30' }, sdn, 'pve').bridge).toBe('');
    expect(resolveIpamNetwork({ bridge: 'vlan30', connectionId: '', vlan: '30' }, [{ name: 'vlan30', source: 'sdn', vlan_id: 30, available_on_node: false }], 'pve').bridge).toBe('');
  });
});
