import { create } from 'zustand';
import { ws } from './ws';

type Theme = 'light' | 'dark' | 'system';
export type ThemePreset =
  | 'cloud-light' | 'paper-light' | 'slate-light'
  | 'amber-light' | 'mint-light' | 'orchid-light' | 'glacier-light' | 'ink-light'
  | 'midnight-dark' | 'graphite-dark' | 'navy-dark'
  | 'forest-dark' | 'plum-dark' | 'copper-dark' | 'obsidian-dark' | 'cobalt-dark'
  | 'tokyo-night-dark' | 'catppuccin-dark' | 'dracula-dark' | 'gruvbox-dark'
  | 'nord-dark' | 'one-dark' | 'kanagawa-dark' | 'rose-pine-dark'
  | 'everforest-light' | 'solarized-light' | 'ayu-dark' | 'nightfox-dark'
  | 'oxocarbon-dark' | 'material-dark' | 'papercolor-light' | 'papercolor-dark'
  | 'palenight-dark';
type TimeFormat = '24h' | '12h';
export type UiDensity = 'comfortable' | 'compact';
export type NavigationWorkspace = 'operations' | 'infrastructure';

export interface ThemePresetDefinition {
  id: ThemePreset;
  name: string;
  description: string;
  mode: Exclude<Theme, 'system'>;
  style?: string;
  recommended?: boolean;
  counterpart?: ThemePreset;
  preview: { canvas: string; surface: string; card: string; accent: string };
}

export const THEME_PRESETS: ThemePresetDefinition[] = [
  { id: 'cloud-light', name: 'Cloud', description: 'Light, cool console design', mode: 'light', preview: { canvas: '#f7faff', surface: '#ffffff', card: '#ffffff', accent: '#0f6cbd' } },
  { id: 'paper-light', name: 'Paper', description: 'Neutral white with clear contrast', mode: 'light', preview: { canvas: '#faf9f6', surface: '#ffffff', card: '#ffffff', accent: '#26364b' } },
  { id: 'slate-light', name: 'Slate', description: 'Blue-gray management interface', mode: 'light', preview: { canvas: '#f4f7fb', surface: '#ffffff', card: '#ffffff', accent: '#1d4fa3' } },
  { id: 'amber-light', name: 'Amber', description: 'Warm canvas with restrained blue actions', mode: 'light', preview: { canvas: '#fdfbf5', surface: '#ffffff', card: '#ffffff', accent: '#1b4fc1' } },
  { id: 'mint-light', name: 'Mint', description: 'Low-noise teal for long operations', mode: 'light', preview: { canvas: '#f7fcfa', surface: '#ffffff', card: '#ffffff', accent: '#08786d' } },
  { id: 'orchid-light', name: 'Orchid', description: 'Cool violet without a decorative cast', mode: 'light', preview: { canvas: '#faf9fd', surface: '#ffffff', card: '#ffffff', accent: '#7041b3' } },
  { id: 'glacier-light', name: 'Glacier', description: 'High surface contrast for dense inventories', mode: 'light', preview: { canvas: '#e9f1f6', surface: '#ffffff', card: '#ffffff', accent: '#067795' } },
  { id: 'ink-light', name: 'Ink', description: 'Utilitarian monochrome for office displays', mode: 'light', preview: { canvas: '#e9ebef', surface: '#ffffff', card: '#ffffff', accent: '#0f1c43' } },
  { id: 'midnight-dark', name: 'Midnight', description: 'Calm, neutral dark console', mode: 'dark', preview: { canvas: '#0a0a0a', surface: '#0a0a0a', card: '#171717', accent: '#3b9df4' } },
  { id: 'graphite-dark', name: 'Graphite', description: 'High-contrast graphite for long sessions', mode: 'dark', preview: { canvas: '#0d0e10', surface: '#121315', card: '#18191b', accent: '#d7e0ec' } },
  { id: 'navy-dark', name: 'Navy', description: 'Deep blue for infrastructure views', mode: 'dark', preview: { canvas: '#07101e', surface: '#0c1727', card: '#101b2d', accent: '#38bdf8' } },
  { id: 'forest-dark', name: 'Forest', description: 'Low-glare green for monitoring sessions', mode: 'dark', preview: { canvas: '#09100d', surface: '#0e1612', card: '#131c18', accent: '#22c98a' } },
  { id: 'plum-dark', name: 'Plum', description: 'Muted violet with calm data surfaces', mode: 'dark', preview: { canvas: '#0d0a10', surface: '#121016', card: '#18131d', accent: '#b9a0f8' } },
  { id: 'copper-dark', name: 'Copper', description: 'Warm dark console with amber actions', mode: 'dark', preview: { canvas: '#0f0c0a', surface: '#15110f', card: '#1b1613', accent: '#f3a233' } },
  { id: 'obsidian-dark', name: 'Obsidian', description: 'Near-black with precise cyan hierarchy', mode: 'dark', preview: { canvas: '#06070a', surface: '#0c0e12', card: '#11151a', accent: '#31d7ed' } },
  { id: 'cobalt-dark', name: 'Cobalt', description: 'Deep cloud blue with crisp separation', mode: 'dark', preview: { canvas: '#060812', surface: '#0c1020', card: '#11182b', accent: '#6a9cff' } },
  { id: 'tokyo-night-dark', name: 'Tokyo Night', style: 'Dark', description: 'Clean blue and violet for a modern night console', mode: 'dark', recommended: true, preview: { canvas: '#1a1b26', surface: '#16161e', card: '#24283b', accent: '#7aa2f7' } },
  { id: 'catppuccin-dark', name: 'Catppuccin', style: 'Pastel', description: 'Soft Mocha pastels with broad editor-inspired familiarity', mode: 'dark', recommended: true, preview: { canvas: '#1e1e2e', surface: '#181825', card: '#313244', accent: '#cba6f7' } },
  { id: 'dracula-dark', name: 'Dracula', style: 'Dark', description: 'High-contrast violet and pink on a deep charcoal canvas', mode: 'dark', preview: { canvas: '#282a36', surface: '#21222c', card: '#343746', accent: '#bd93f9' } },
  { id: 'gruvbox-dark', name: 'Gruvbox', style: 'Retro', description: 'Warm brown surfaces with earthy orange highlights', mode: 'dark', preview: { canvas: '#282828', surface: '#1d2021', card: '#3c3836', accent: '#fe8019' } },
  { id: 'nord-dark', name: 'Nord', style: 'Arctic', description: 'Minimal arctic blue and gray with quiet contrast', mode: 'dark', preview: { canvas: '#2e3440', surface: '#272c36', card: '#3b4252', accent: '#88c0d0' } },
  { id: 'one-dark', name: 'One Dark', style: 'Dark', description: 'Neutral Atom-inspired surfaces with crisp blue actions', mode: 'dark', preview: { canvas: '#282c34', surface: '#21252b', card: '#303640', accent: '#61afef' } },
  { id: 'kanagawa-dark', name: 'Kanagawa', style: 'Japanese', description: 'Warm, muted ink tones inspired by traditional prints', mode: 'dark', preview: { canvas: '#1f1f28', surface: '#16161d', card: '#2a2a37', accent: '#7e9cd8' } },
  { id: 'rose-pine-dark', name: 'Rose Pine', style: 'Elegant', description: 'Soft rose, iris, and gold on an elegant dark base', mode: 'dark', preview: { canvas: '#191724', surface: '#14121f', card: '#1f1d2e', accent: '#c4a7e7' } },
  { id: 'everforest-light', name: 'Everforest', style: 'Nature', description: 'Eye-friendly green and brown on a warm natural canvas', mode: 'light', recommended: true, preview: { canvas: '#fdf6e3', surface: '#f4f0d9', card: '#fffbef', accent: '#4f6f52' } },
  { id: 'solarized-light', name: 'Solarized', style: 'Classic', description: 'Carefully balanced classic colors with restrained contrast', mode: 'light', recommended: true, preview: { canvas: '#fdf6e3', surface: '#eee8d5', card: '#fffaf0', accent: '#006f8a' } },
  { id: 'ayu-dark', name: 'Ayu', style: 'Modern', description: 'Clean modern charcoal with precise orange accents', mode: 'dark', preview: { canvas: '#0f1419', surface: '#0b1014', card: '#172029', accent: '#ffb454' } },
  { id: 'nightfox-dark', name: 'Nightfox', style: 'Dark', description: 'Layered night blues with a calm Tokyo-like character', mode: 'dark', preview: { canvas: '#192330', surface: '#131a24', card: '#212e3f', accent: '#719cd6' } },
  { id: 'oxocarbon-dark', name: 'Oxocarbon', style: 'Minimal', description: 'IBM Carbon-inspired black with electric blue and pink', mode: 'dark', preview: { canvas: '#161616', surface: '#0f0f0f', card: '#262626', accent: '#78a9ff' } },
  { id: 'material-dark', name: 'Material Theme', style: 'Modern', description: 'Material-inspired slate with cyan and blue accents', mode: 'dark', preview: { canvas: '#263238', surface: '#1e272c', card: '#314047', accent: '#80cbc4' } },
  { id: 'papercolor-light', name: 'PaperColor Light', style: 'Light', description: 'Vim-inspired paper surfaces with a restrained retro blue', mode: 'light', counterpart: 'papercolor-dark', preview: { canvas: '#eeeeee', surface: '#e4e4e4', card: '#ffffff', accent: '#005faf' } },
  { id: 'papercolor-dark', name: 'PaperColor Dark', style: 'Dark', description: 'Vim-inspired charcoal surfaces with a cool retro blue', mode: 'dark', counterpart: 'papercolor-light', preview: { canvas: '#1c1c1c', surface: '#121212', card: '#262626', accent: '#5fafd7' } },
  { id: 'palenight-dark', name: 'Palenight', style: 'Dark', description: 'Deep violet-blue with soft lavender and blue accents', mode: 'dark', preview: { canvas: '#292d3e', surface: '#222633', card: '#32374d', accent: '#c792ea' } },
];

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebar: (collapsed: boolean) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  infrastructureTreeCollapsed: boolean;
  toggleInfrastructureTree: () => void;
  navigationWorkspace: NavigationWorkspace;
  setNavigationWorkspace: (workspace: NavigationWorkspace) => void;
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
const NAVIGATION_WORKSPACE_KEY = 'shipyard_navigation_workspace';
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

export function resolveThemePreset(theme: Theme, current: ThemePreset): ThemePreset {
  if (theme === 'system') return current;
  const preset = THEME_PRESETS.find(item => item.id === current);
  if (preset?.mode === theme) return current;
  const counterpart = preset?.counterpart
    ? THEME_PRESETS.find(item => item.id === preset.counterpart)
    : undefined;
  if (counterpart?.mode === theme) return counterpart.id;
  return theme === 'dark' ? 'midnight-dark' : 'cloud-light';
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

function readNavigationWorkspace(): NavigationWorkspace {
  try {
    return localStorage.getItem(NAVIGATION_WORKSPACE_KEY) === 'infrastructure'
      ? 'infrastructure'
      : 'operations';
  } catch {
    return 'operations';
  }
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
  navigationWorkspace: readNavigationWorkspace(),
  setNavigationWorkspace: (navigationWorkspace) => set(() => {
    try { localStorage.setItem(NAVIGATION_WORKSPACE_KEY, navigationWorkspace); } catch { /* ignore */ }
    return { navigationWorkspace };
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
      const themePreset = resolveThemePreset(t, state.themePreset);
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
  const activePreset = resolveThemePreset(dark ? 'dark' : 'light', preset);
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
