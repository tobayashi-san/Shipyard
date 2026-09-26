import { describe, expect, it } from 'vitest';
import { normalizeSidebarWidth, resolveThemePreset, resolveVisibleEnvironmentId, THEME_PRESETS } from './store';

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
    expect(THEME_PRESETS).toHaveLength(41);
    expect(THEME_PRESETS.filter(theme => theme.mode === 'light')).toHaveLength(15);
    expect(THEME_PRESETS.filter(theme => theme.mode === 'dark')).toHaveLength(26);
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

  it('keeps shadcn variants paired and immediately discoverable', () => {
    expect(resolveThemePreset('dark', 'shadcn-light')).toBe('shadcn-dark');
    expect(resolveThemePreset('light', 'shadcn-dark')).toBe('shadcn-light');
    expect(THEME_PRESETS.filter(theme => theme.id.startsWith('shadcn-')).every(theme => theme.recommended)).toBe(true);
  });

  it('keeps PaperColor variants paired when the color mode changes', () => {
    expect(resolveThemePreset('dark', 'papercolor-light')).toBe('papercolor-dark');
    expect(resolveThemePreset('light', 'papercolor-dark')).toBe('papercolor-light');
    expect(resolveThemePreset('system', 'papercolor-dark')).toBe('papercolor-dark');
    expect(resolveThemePreset('light', 'tokyo-night-dark')).toBe('fleet-light');
    expect(resolveThemePreset('dark', 'fleet-light')).toBe('fleet-dark');
    expect(resolveThemePreset('dark', 'fleet-rounded-light')).toBe('fleet-rounded-dark');
    expect(resolveThemePreset('light', 'fleet-rounded-dark')).toBe('fleet-rounded-light');
    expect(resolveThemePreset('dark', 'enterprise-light')).toBe('enterprise-dark');
    expect(resolveThemePreset('light', 'enterprise-dark')).toBe('enterprise-light');
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

describe('sidebar width preferences', () => {
  it('uses the intended default for missing and malformed values', () => {
    for (const value of [null, undefined, '', ' ', 'invalid', NaN, Infinity, {}, false]) expect(normalizeSidebarWidth(value)).toBe(272);
  });
  it('preserves valid widths while rounding and enforcing layout bounds', () => {
    expect(normalizeSidebarWidth('300')).toBe(300);
    expect(normalizeSidebarWidth(300.7)).toBe(301);
    expect(normalizeSidebarWidth(100)).toBe(224);
    expect(normalizeSidebarWidth(1000)).toBe(384);
  });
});
