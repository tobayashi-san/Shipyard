import { create } from 'zustand';
import { ws } from './ws';

type Theme = 'light' | 'dark' | 'system';
export type ThemePreset =
  | 'cloud-light' | 'paper-light' | 'slate-light'
  | 'amber-light' | 'mint-light' | 'orchid-light' | 'glacier-light' | 'ink-light'
  | 'midnight-dark' | 'graphite-dark' | 'navy-dark'
  | 'forest-dark' | 'plum-dark' | 'copper-dark' | 'obsidian-dark' | 'cobalt-dark';
type TimeFormat = '24h' | '12h';
export type UiDensity = 'comfortable' | 'compact';

export const THEME_PRESETS: Array<{ id: ThemePreset; name: string; description: string; mode: Exclude<Theme, 'system'>; preview: { canvas: string; surface: string; card: string; accent: string } }> = [
  { id: 'cloud-light', name: 'Cloud', description: 'Light, cool console design', mode: 'light', preview: { canvas: '#f7faff', surface: '#ffffff', card: '#ffffff', accent: '#0f6cbd' } },
  { id: 'paper-light', name: 'Paper', description: 'Neutral white with clear contrast', mode: 'light', preview: { canvas: '#faf9f6', surface: '#ffffff', card: '#ffffff', accent: '#26364b' } },
  { id: 'slate-light', name: 'Slate', description: 'Blue-gray management interface', mode: 'light', preview: { canvas: '#f4f7fb', surface: '#ffffff', card: '#ffffff', accent: '#1d4fa3' } },
  { id: 'amber-light', name: 'Amber', description: 'Warm surfaces with a cool blue work accent', mode: 'light', preview: { canvas: '#fdfaf0', surface: '#ffffff', card: '#ffffff', accent: '#1d4ed8' } },
  { id: 'mint-light', name: 'Mint', description: 'Calm teal for focused work', mode: 'light', preview: { canvas: '#f5fcfa', surface: '#ffffff', card: '#ffffff', accent: '#08766c' } },
  { id: 'orchid-light', name: 'Orchid', description: 'Clear violet with neutral surfaces', mode: 'light', preview: { canvas: '#faf9fd', surface: '#ffffff', card: '#ffffff', accent: '#6941c6' } },
  { id: 'glacier-light', name: 'Glacier Contrast', description: 'Cool surfaces with clearly separated cards and tables', mode: 'light', preview: { canvas: '#e9f2fb', surface: '#ffffff', card: '#ffffff', accent: '#075985' } },
  { id: 'ink-light', name: 'Ink Contrast', description: 'Neutral light theme with strong ink and clear lines', mode: 'light', preview: { canvas: '#e9eaec', surface: '#ffffff', card: '#ffffff', accent: '#172554' } },
  { id: 'midnight-dark', name: 'Midnight', description: 'Calm, neutral dark console', mode: 'dark', preview: { canvas: '#0a0a0a', surface: '#0a0a0a', card: '#171717', accent: '#3b9df4' } },
  { id: 'graphite-dark', name: 'Graphite', description: 'High-contrast graphite for long sessions', mode: 'dark', preview: { canvas: '#0d0e10', surface: '#121315', card: '#18191b', accent: '#d7e0ec' } },
  { id: 'navy-dark', name: 'Navy', description: 'Deep blue for infrastructure views', mode: 'dark', preview: { canvas: '#07101e', surface: '#0c1727', card: '#101b2d', accent: '#38bdf8' } },
  { id: 'forest-dark', name: 'Forest', description: 'Muted forest green with high readability', mode: 'dark', preview: { canvas: '#09110d', surface: '#101c17', card: '#17251f', accent: '#34d399' } },
  { id: 'plum-dark', name: 'Plum', description: 'Violet accent on relaxed charcoal', mode: 'dark', preview: { canvas: '#100b10', surface: '#171117', card: '#221922', accent: '#b59cff' } },
  { id: 'copper-dark', name: 'Copper', description: 'Warm copper accent for clear priorities', mode: 'dark', preview: { canvas: '#110d0a', surface: '#18110d', card: '#241a14', accent: '#f5a524' } },
  { id: 'obsidian-dark', name: 'Obsidian Contrast', description: 'Black console with clearly separated work surfaces', mode: 'dark', preview: { canvas: '#06080d', surface: '#0f1420', card: '#151c29', accent: '#67e8f9' } },
  { id: 'cobalt-dark', name: 'Cobalt Contrast', description: 'Deep blue with highly visible levels and borders', mode: 'dark', preview: { canvas: '#06102e', surface: '#0b1638', card: '#13224a', accent: '#60a5fa' } },
];

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebar: (collapsed: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  infrastructureTreeCollapsed: boolean;
  toggleInfrastructureTree: () => void;
  showInfrastructureVmIds: boolean;
  setShowInfrastructureVmIds: (show: boolean) => void;
  density: UiDensity;
  setDensity: (density: UiDensity) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  themePreset: ThemePreset;
  setThemePreset: (preset: ThemePreset) => void;
  timeFormat: TimeFormat;
  setTimeFormat: (f: TimeFormat) => void;
  dashAttentionOnly: boolean;
  setDashAttentionOnly: (v: boolean) => void;
  environmentId: string;
  setEnvironmentId: (id: string) => void;
}

const THEME_KEY = 'shipyard_theme_next';
const THEME_PRESET_KEY = 'shipyard_theme_preset_next';
const SIDEBAR_KEY = 'shipyard_sidebar_collapsed_next';
const SIDEBAR_WIDTH_KEY = 'shipyard_sidebar_width_next';
const TREE_COLLAPSED_KEY = 'shipyard_tree_collapsed_next';
const TREE_VM_IDS_KEY = 'shipyard_tree_show_vm_ids';
const DENSITY_KEY = 'shipyard_ui_density_next';
const TIME_FORMAT_KEY = 'timeFormat';
const DASH_ATTENTION_KEY = 'shipyard_dash_attention';
const ENVIRONMENT_KEY = 'shipyard_environment';

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

function readThemePreset(): ThemePreset {
  try {
    const value = localStorage.getItem(THEME_PRESET_KEY);
    if (THEME_PRESETS.some(preset => preset.id === value)) return value as ThemePreset;
  } catch { /* ignore */ }
  return 'midnight-dark';
}

function matchingPreset(theme: Theme, current: ThemePreset): ThemePreset {
  if (theme === 'system') return current;
  const preset = THEME_PRESETS.find(item => item.id === current);
  return preset?.mode === theme ? current : (theme === 'dark' ? 'midnight-dark' : 'cloud-light');
}

function readSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
}

function readSidebarWidth(): number {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(value)) return Math.min(384, Math.max(224, value));
  } catch { /* ignore */ }
  return 272;
}

function readDensity(): UiDensity {
  try { if (localStorage.getItem(DENSITY_KEY) === 'compact') return 'compact'; } catch { /* ignore */ }
  return 'comfortable';
}

function applyDensity(density: UiDensity): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.uiDensity = density;
}

function readTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    if (v === '12h' || v === '24h') return v;
  } catch { /* ignore */ }
  return '24h';
}

function readDashAttention(): boolean {
  try { return localStorage.getItem(DASH_ATTENTION_KEY) === '1'; } catch { return false; }
}
function readEnvironment(): string { try { return localStorage.getItem(ENVIRONMENT_KEY) || 'default'; } catch { return 'default'; } }

export function resolveVisibleEnvironmentId(
  currentId: string,
  environments: Array<{ id?: unknown }>,
): string | null {
  if (environments.length === 0) return null;
  if (environments.some(environment => String(environment.id) === currentId)) return currentId;
  return String(environments[0].id);
}

export const useUi = create<UiState>((set) => ({
  sidebarCollapsed: readSidebar(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return { sidebarCollapsed: next };
    }),
  setSidebar: (collapsed) =>
    set(() => {
      try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
      return { sidebarCollapsed: collapsed };
    }),
  sidebarWidth: readSidebarWidth(),
  setSidebarWidth: (width) => set(() => {
    const next = Math.min(384, Math.max(224, Math.round(width)));
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch { /* ignore */ }
    return { sidebarWidth: next };
  }),
  infrastructureTreeCollapsed: (() => { try { return localStorage.getItem(TREE_COLLAPSED_KEY) === '1'; } catch { return false; } })(),
  toggleInfrastructureTree: () => set((state) => {
    const next = !state.infrastructureTreeCollapsed;
    try { localStorage.setItem(TREE_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return { infrastructureTreeCollapsed: next };
  }),
  showInfrastructureVmIds: (() => { try { return localStorage.getItem(TREE_VM_IDS_KEY) !== '0'; } catch { return true; } })(),
  setShowInfrastructureVmIds: (show) => set(() => {
    try { localStorage.setItem(TREE_VM_IDS_KEY, show ? '1' : '0'); } catch { /* ignore */ }
    return { showInfrastructureVmIds: show };
  }),
  density: readDensity(),
  setDensity: (density) => set(() => {
    try { localStorage.setItem(DENSITY_KEY, density); } catch { /* ignore */ }
    applyDensity(density);
    return { density };
  }),
  theme: readTheme(),
  setTheme: (t) =>
    set((state) => {
      const themePreset = matchingPreset(t, state.themePreset);
      try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
      try { localStorage.setItem(THEME_PRESET_KEY, themePreset); } catch { /* ignore */ }
      applyTheme(t, themePreset);
      return { theme: t, themePreset };
    }),
  themePreset: readThemePreset(),
  setThemePreset: (themePreset) =>
    set(() => {
      const preset = THEME_PRESETS.find(item => item.id === themePreset)!;
      try { localStorage.setItem(THEME_PRESET_KEY, themePreset); localStorage.setItem(THEME_KEY, preset.mode); } catch { /* ignore */ }
      applyTheme(preset.mode, themePreset);
      return { theme: preset.mode, themePreset };
    }),
  timeFormat: readTimeFormat(),
  setTimeFormat: (f) =>
    set(() => {
      try { localStorage.setItem(TIME_FORMAT_KEY, f); } catch { /* ignore */ }
      return { timeFormat: f };
    }),
  dashAttentionOnly: readDashAttention(),
  setDashAttentionOnly: (v) =>
    set(() => {
      try { localStorage.setItem(DASH_ATTENTION_KEY, v ? '1' : '0'); } catch { /* ignore */ }
      return { dashAttentionOnly: v };
    }),
  environmentId: readEnvironment(),
  setEnvironmentId: (id) => set(() => {
    try { localStorage.setItem(ENVIRONMENT_KEY, id); } catch {}
    ws.setEnvironment(id);
    return { environmentId: id };
  }),
}));

export function applyTheme(theme: Theme, preset = readThemePreset()): void {
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const activePreset = matchingPreset(dark ? 'dark' : 'light', preset);
  root.classList.toggle('dark', dark);
  root.dataset.consoleTheme = activePreset;
  // Legacy screens still use the former white-label `brand` utility. Keep it
  // tied to the active semantic palette so a saved arbitrary accent cannot
  // visually clash with the selected console design.
  root.style.setProperty('--brand', 'var(--primary)');
  root.style.setProperty('--brand-hover', 'var(--primary)');
  root.style.setProperty('--brand-light', 'var(--accent)');
}

// Apply current theme on import so first paint matches.
if (typeof window !== 'undefined') {
  applyTheme(readTheme(), readThemePreset());
  applyDensity(readDensity());
}
