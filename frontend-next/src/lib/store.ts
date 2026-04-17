import { create } from 'zustand';

type Theme = 'light' | 'dark' | 'system';

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebar: (collapsed: boolean) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  language: 'de' | 'en';
  setLanguage: (l: 'de' | 'en') => void;
}

const THEME_KEY = 'shipyard_theme_next';
const SIDEBAR_KEY = 'shipyard_sidebar_collapsed_next';

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

function readSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
}

function readLang(): 'de' | 'en' {
  try {
    const v = localStorage.getItem('shipyard_lang');
    if (v === 'de' || v === 'en') return v;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'de').toLowerCase();
  return nav.startsWith('en') ? 'en' : 'de';
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
  theme: readTheme(),
  setTheme: (t) =>
    set(() => {
      try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
      applyTheme(t);
      return { theme: t };
    }),
  language: readLang(),
  setLanguage: (l) =>
    set(() => {
      try { localStorage.setItem('shipyard_lang', l); } catch { /* ignore */ }
      return { language: l };
    }),
}));

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);
}

// Apply current theme on import so first paint matches.
if (typeof window !== 'undefined') applyTheme(readTheme());
