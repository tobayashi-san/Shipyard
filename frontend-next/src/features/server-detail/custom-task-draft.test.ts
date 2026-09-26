import { describe, expect, it } from 'vitest';
import { COMMUNITY_SCRIPT_SLUG, communityScriptTask } from './custom-task-draft';

describe('community script preset', () => {
  it('checks the recorded version against the script release and keeps a given name', () => {
    const task = communityScriptTask('Immich', 'Photos');
    expect(task).toMatchObject({ name: 'Photos', type: 'script', update_command: 'update </dev/null' });
    expect(task.check_command).toContain('~/.immich /opt/immich_version.txt');
    expect(task.latest_command).toContain('ProxmoxVE/main/ct/immich.sh');
    expect(communityScriptTask('opencloud').name).toBe('Opencloud');
  });
  it('accepts only script slugs', () => {
    expect(COMMUNITY_SCRIPT_SLUG.test('paperless-ngx')).toBe(true);
    expect(COMMUNITY_SCRIPT_SLUG.test('x; rm -rf /')).toBe(false);
  });
});
