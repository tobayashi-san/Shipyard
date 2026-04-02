/**
 * Parse ZFS pool + dataset data from raw command output.
 * Shared by system-info (SSH) and agent-processor (collector).
 */

function bytesToGb(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) ? Math.round((n / (1024 ** 3)) * 10) / 10 : null;
}

function parseZfsData(zpoolListRaw, zpoolStatusRaw, zfsListRaw) {
  if (!zpoolListRaw || zpoolListRaw.trim() === '' || zpoolListRaw.includes('__NO_ZFS__')) return [];

  // Parse zpool list -Hp: name \t size \t alloc \t free \t health
  const pools = zpoolListRaw.trim().split('\n').filter(Boolean).map(line => {
    const [name, size, alloc, free, health] = line.split('\t');
    return {
      name: name || 'unknown',
      size_gb: bytesToGb(size),
      alloc_gb: bytesToGb(alloc),
      free_gb: bytesToGb(free),
      health: (health || 'UNKNOWN').trim(),
      scrub: null,
    };
  });

  // Parse zpool status for scrub info per pool
  if (zpoolStatusRaw && zpoolStatusRaw.trim() && !zpoolStatusRaw.includes('__NO_ZFS__')) {
    let currentPool = null;
    for (const line of zpoolStatusRaw.split('\n')) {
      const poolMatch = line.match(/^\s*pool:\s*(\S+)/);
      if (poolMatch) { currentPool = pools.find(p => p.name === poolMatch[1]); continue; }
      if (!currentPool) continue;
      const scrubMatch = line.match(/scan:\s*scrub\s+(\S+.*)/);
      if (scrubMatch) { currentPool.scrub = scrubMatch[1].trim(); }
      const noScrub = line.match(/scan:\s*(none requested|resilver)/i);
      if (noScrub) { currentPool.scrub = noScrub[1].trim(); }
    }
  }

  // Parse zfs list -Hp: name \t used \t avail \t refer \t mountpoint \t type
  const datasets = [];
  if (zfsListRaw && zfsListRaw.trim() && !zfsListRaw.includes('__NO_ZFS__')) {
    for (const line of zfsListRaw.trim().split('\n').filter(Boolean)) {
      const [name, used, avail, refer, mountpoint, type] = line.split('\t');
      datasets.push({
        name: name || '',
        used_gb: bytesToGb(used),
        avail_gb: bytesToGb(avail),
        refer_gb: bytesToGb(refer),
        mountpoint: mountpoint || '-',
        type: (type || 'filesystem').trim(),
      });
    }
  }

  // Attach datasets to their pools
  for (const pool of pools) {
    pool.datasets = datasets.filter(d => d.name === pool.name || d.name.startsWith(pool.name + '/'));
  }

  return pools;
}

module.exports = { parseZfsData };
