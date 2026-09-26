export interface NetworkOption {
  name?: string;
  source?: 'node' | 'sdn';
  vlan_id?: number | null;
  available_on_node?: boolean;
}
export interface IpamNetwork { bridge: string; connectionId: string; vlan: string }
export interface ResolvedNetwork { bridge: string; vlan: string; message: string }

/**
 * Pick the bridge or SDN VNet for an IPAM prefix on the chosen node. Works for
 * SDN setups (the VNet carries the VLAN, the NIC gets no tag) and for
 * VLAN-aware node bridges (the NIC carries the prefix's tag).
 */
export function resolveIpamNetwork(network: IpamNetwork, options: NetworkOption[], targetConnection: string): ResolvedNetwork {
  const vlan = network.vlan && Number(network.vlan) > 0 ? String(Number(network.vlan)) : '';
  const usable = options.filter(item => item.name && item.available_on_node !== false);
  const pick = (item: NetworkOption, message: string): ResolvedNetwork => ({
    bridge: String(item.name),
    // An SDN VNet with its own tag must not be tagged again on the NIC.
    vlan: item.source === 'sdn' && item.vlan_id ? '' : vlan,
    message,
  });
  if (network.connectionId && network.connectionId !== targetConnection) {
    return { bridge: '', vlan, message: 'This IPAM network belongs to another platform. Select a bridge or VNet explicitly.' };
  }
  const named = usable.filter(item => item.name === network.bridge);
  if (network.bridge && named.length === 1) return pick(named[0], 'Bridge selected from the IPAM network mapping.');
  if (vlan) {
    const vnets = usable.filter(item => item.source === 'sdn' && Number(item.vlan_id) === Number(vlan));
    if (vnets.length === 1) return pick(vnets[0], `SDN VNet ${vnets[0].name} selected by VLAN ${vlan}.`);
    const bridges = usable.filter(item => (item.source || 'node') === 'node');
    if (!vnets.length && bridges.length === 1) return pick(bridges[0], `Bridge ${bridges[0].name} selected with VLAN tag ${vlan}.`);
  }
  return { bridge: '', vlan, message: 'No unique bridge or VNet matches this IPAM network on the node. Select one explicitly.' };
}
