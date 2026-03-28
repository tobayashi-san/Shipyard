export function buildAllExceptTargets(excludedNames = []) {
  const excluded = [...new Set(excludedNames.map(n => String(n || '').trim()).filter(Boolean))];
  if (excluded.length === 0) return 'all';
  return `all:${excluded.map(name => `!${name}`).join(':')}`;
}

export function parsePlaybookTargets(targets) {
  const raw = String(targets || '').trim();
  if (!raw || raw === 'all') return { mode: 'all', excluded: [], included: [] };

  const parts = raw.split(':').map(t => t.trim()).filter(Boolean);
  if (parts[0] === 'all' && parts.slice(1).every(t => t.startsWith('!') && t.length > 1)) {
    return {
      mode: 'all',
      excluded: parts.slice(1).map(t => t.slice(1)),
      included: [],
    };
  }

  return {
    mode: 'list',
    excluded: [],
    included: raw.split(',').map(t => t.trim()).filter(Boolean),
  };
}

export function describePlaybookTargets(targets, t) {
  const parsed = parsePlaybookTargets(targets);
  if (parsed.mode === 'all') {
    return parsed.excluded.length > 0
      ? t('run.allExceptCount', { count: parsed.excluded.length })
      : t('pb.allServers');
  }
  if (parsed.included.length === 1) return parsed.included[0];
  return t('run.selected', { count: parsed.included.length });
}
