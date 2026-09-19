'use strict';
function collectStorageResults(nodes, storageResults) {
  const datastores = [];
  storageResults.forEach((result, index) => {
    const node = nodes[index];
    node.datastores_checked_at = new Date().toISOString();
    node.datastores_status = result.status === 'fulfilled' && Array.isArray(result.value) ? 'available' : 'unavailable';
    if (node.datastores_status !== 'available') return;
    const pools = result.value
      .filter(item => item && item.storage)
      .map(item => ({
        id: String(item.storage),
        node_name: node.name,
        type: String(item.type || ''),
        content: typeof item.content === 'string' ? [...new Set(item.content.split(',').map(value => value.trim()).filter(Boolean))] : null,
        shared: [1, '1', true].includes(item.shared) ? true : [0, '0', false].includes(item.shared) ? false : null,
        active: [1, '1', true].includes(item.active) ? true : [0, '0', false].includes(item.active) ? false : null,
        enabled: [1, '1', true].includes(item.enabled) ? true : [0, '0', false].includes(item.enabled) ? false : null,
        capacity_reported: item.used !== null && item.used !== undefined && item.used !== '' && Number.isFinite(Number(item.used)) && Number(item.used) >= 0 && Number(item.total) > 0 && Number.isFinite(Number(item.total)) && Number(item.used) <= Number(item.total),
        used: Number(item.used) || 0,
        total: Number(item.total) || 0,
        available: Number(item.avail) || 0,
      }));
    node.datastores = pools;
    datastores.push(...pools);
  });
  return datastores;
}
module.exports = { collectStorageResults };
