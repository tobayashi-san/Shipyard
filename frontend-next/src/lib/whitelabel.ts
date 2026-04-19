/**
 * Runtime white-label application — mirrors the old frontend's applyWhiteLabel().
 * Call this whenever settings change to update document.title, favicon, accent CSS vars, and meta tags.
 */

const DEFAULT_NAME = 'Shipyard';
const DEFAULT_ACCENT = '#3b82f6';

export interface WhiteLabelSettings {
  appName?: string;
  appTagline?: string;
  accentColor?: string;
  showIcon?: boolean;
  logoIcon?: string;
  logoImage?: string;
}

function hexToRgb(hex: string): string | null {
  const value = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`;
}

/**
 * Convert a hex color to an HSL components string (e.g. "217 91% 56%")
 * suitable for use with Tailwind's hsl(var(--brand)) pattern.
 */
function hexToHslComponents(hex: string): string | null {
  const value = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const n = parseInt(value, 16);
  let r = ((n >> 16) & 0xff) / 255;
  let g = ((n >> 8) & 0xff) / 255;
  let b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * Darken/lighten an HSL components string by adjusting lightness.
 * pct is added directly to the lightness percentage value.
 */
function shadeHsl(hslComponents: string, pctDelta: number): string {
  const parts = hslComponents.match(/^(\d+)\s+(\d+)%\s+(\d+)%$/);
  if (!parts) return hslComponents;
  const newL = Math.max(0, Math.min(100, parseInt(parts[3]) + pctDelta));
  return `${parts[1]} ${parts[2]}% ${newL}%`;
}

function escSvg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildFaviconDataUrl(appName: string, accent: string): string {
  const letter = (String(appName || '').trim()[0] || 'S').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" rx="12" fill="${accent}"/><text x="32" y="42" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="26" fill="#ffffff">${escSvg(letter)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function applyWhiteLabel(wl: WhiteLabelSettings): void {
  const name = wl.appName || DEFAULT_NAME;
  const tagline = wl.appTagline || '';
  const accent = wl.accentColor || DEFAULT_ACCENT;

  // Document title
  document.title = name;

  // Meta description
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute('content', tagline ? `${name} - ${tagline}` : name);

  // Meta theme-color
  let themeColor = document.querySelector('meta[name="theme-color"]');
  if (!themeColor) {
    themeColor = document.createElement('meta');
    themeColor.setAttribute('name', 'theme-color');
    document.head.appendChild(themeColor);
  }
  themeColor.setAttribute('content', accent);

  // Brand accent CSS custom properties (use --brand-* to avoid conflict with shadcn --accent)
  // Values must be HSL components (e.g. "217 91% 56%") because Tailwind uses hsl(var(--brand))
  const root = document.documentElement;
  const hsl = hexToHslComponents(accent) || '217 91% 56%';
  root.style.setProperty('--brand', hsl);
  root.style.setProperty('--brand-hover', shadeHsl(hsl, -8));
  root.style.setProperty('--brand-light', shadeHsl(hsl, 38));
  const rgb = hexToRgb(accent);
  if (rgb) root.style.setProperty('--brand-rgb', rgb);

  // Dynamic favicon
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.setAttribute('rel', 'icon');
    favicon.setAttribute('type', 'image/svg+xml');
    document.head.appendChild(favicon);
  }
  favicon.setAttribute('href', buildFaviconDataUrl(name, accent));
}
