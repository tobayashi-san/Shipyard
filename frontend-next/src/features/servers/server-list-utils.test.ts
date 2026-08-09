import { describe, expect, it } from 'vitest';
import { buildGroupTree, getDescendantIds, normalizeServer, parseCsvServers } from './server-list-utils';

describe('server list helpers', () => {
  it('normalizes malformed serialized arrays safely', () => {
    expect(normalizeServer({ id: 1, name: 'app', tags: '{invalid' })).toMatchObject({
      id: '1', name: 'app', tags: [], services: [], links: [], storage_mounts: [],
    });
  });

  it('parses quoted CSV values and JSON columns', () => {
    const [server] = parseCsvServers('name,ip_address,tags\n"api, primary",10.0.0.2,"[""prod""]"');
    expect(server).toMatchObject({ name: 'api, primary', ip_address: '10.0.0.2', tags: ['prod'], ssh_port: 22 });
  });

  it('prevents cycles while building group trees', () => {
    const tree = buildGroupTree([
      { id: 'root', name: 'Root' },
      { id: 'child', name: 'Child', parent_id: 'root' },
      { id: 'cycle', name: 'Cycle', parent_id: 'cycle' },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].id).toBe('child');
  });

  it('includes descendants when a parent group is used as a filter', () => {
    const ids = getDescendantIds([
      { id: 'prod', name: 'Production' },
      { id: 'web', name: 'Web', parent_id: 'prod' },
      { id: 'db', name: 'Database', parent_id: 'web' },
    ], 'prod');
    expect([...ids]).toEqual(['prod', 'web', 'db']);
  });
});
