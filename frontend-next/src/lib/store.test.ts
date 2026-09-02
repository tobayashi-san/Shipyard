import { describe, expect, it } from 'vitest';
import { resolveThemePreset, resolveVisibleEnvironmentId, THEME_PRESETS } from './store';

const communityThemeIds = [
  'tokyo-night-dark',
  'catppuccin-dark',
  'dracula-dark',
  'gruvbox-dark',
  'nord-dark',
  'one-dark',
  'kanagawa-dark',
  'rose-pine-dark',
  'everforest-light',
  'solarized-light',
  'ayu-dark',
  'nightfox-dark',
  'oxocarbon-dark',
  'material-dark',
  'papercolor-light',
  'papercolor-dark',
  'palenight-dark',
] as const;

describe('console theme presets', () => {
  it('provides one unique, complete preview contract for every selectable theme', () => {
    expect(THEME_PRESETS).toHaveLength(33);
    expect(THEME_PRESETS.filter(theme => theme.mode === 'light')).toHaveLength(11);
    expect(THEME_PRESETS.filter(theme => theme.mode === 'dark')).toHaveLength(22);
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

  it('includes every requested community theme with descriptive metadata', () => {
    expect(THEME_PRESETS.filter(theme => communityThemeIds.includes(theme.id as typeof communityThemeIds[number])))
      .toHaveLength(communityThemeIds.length);

    for (const id of communityThemeIds) {
      const theme = THEME_PRESETS.find(candidate => candidate.id === id);
      expect(theme, id).toBeDefined();
      expect(theme?.style, id).toBeTruthy();
    }
  });

  it('keeps PaperColor variants paired when the color mode changes', () => {
    expect(resolveThemePreset('dark', 'papercolor-light')).toBe('papercolor-dark');
    expect(resolveThemePreset('light', 'papercolor-dark')).toBe('papercolor-light');
    expect(resolveThemePreset('system', 'papercolor-dark')).toBe('papercolor-dark');
    expect(resolveThemePreset('light', 'tokyo-night-dark')).toBe('cloud-light');
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
