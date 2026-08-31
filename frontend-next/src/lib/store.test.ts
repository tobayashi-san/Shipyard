import { describe, expect, it } from 'vitest';
import { resolveVisibleEnvironmentId, THEME_PRESETS } from './store';

describe('console theme presets', () => {
  it('provides one unique, complete preview contract for every selectable theme', () => {
    expect(THEME_PRESETS).toHaveLength(6);
    expect(new Set(THEME_PRESETS.map(theme => theme.id)).size).toBe(THEME_PRESETS.length);

    for (const theme of THEME_PRESETS) {
      expect(theme.id).toMatch(theme.mode === 'dark' ? /-dark$/ : /-light$/);
      expect(theme.name).not.toHaveLength(0);
      expect(theme.description).not.toHaveLength(0);
      for (const color of Object.values(theme.preview)) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.preview.canvas).not.toBe(theme.preview.accent);
      expect(theme.preview.card).not.toBe(theme.preview.accent);
    }
  });
});

describe('environment selection', () => {
  it('keeps a visible selection and replaces a stale one', () => {
    const environments = [{ id: 'production' }, { id: 'staging' }];
    expect(resolveVisibleEnvironmentId('staging', environments)).toBe('staging');
    expect(resolveVisibleEnvironmentId('deleted', environments)).toBe('production');
    expect(resolveVisibleEnvironmentId('deleted', [])).toBeNull();
  });
});
