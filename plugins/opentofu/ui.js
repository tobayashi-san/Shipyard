// ── Plugin Styles ─────────────────────────────────────────────────────────
const PLUGIN_STYLES = `
.tofu-plugin {
  /* Semantic aliases: work in old frontend (literal fallbacks) AND new frontend (hsl vars) */
  --tp-bg:          var(--card,          hsl(var(--background, 0 0% 100%)));
  --tp-bg2:         var(--muted,         hsl(var(--muted, 220 15% 95.5%)));
  --tp-fg:          var(--foreground,    hsl(var(--foreground, 224 15% 12%)));
  --tp-fg-muted:    var(--muted-foreground, #64748b);
  --tp-border:      hsl(var(--border, 220 13% 89%));
  --tp-radius:      var(--radius,        8px);
  --tp-mono:        'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  --tp-primary:     hsl(var(--brand,     217 91% 56%));
  --tp-primary-fg:  hsl(var(--primary-foreground, 0 0% 100%));
  --tp-primary-h:   hsl(var(--brand-hover, 217 91% 48%));
  --tp-danger:      hsl(var(--destructive, 0 72% 51%));
  --tp-danger-h:    hsl(var(--destructive, 0 72% 45%));
  --tp-success:     hsl(var(--success,   152 65% 38%));
  --tp-warning:     hsl(var(--warning,   35 92% 50%));
  --tp-accent-bg:   hsl(var(--brand-light, 217 91% 96%));
  --tp-accent-fg:   hsl(var(--brand,     217 91% 56%));
  --tp-secondary-bg: hsl(var(--secondary, 220 15% 95%));
  --tp-secondary-fg: hsl(var(--secondary-foreground, 224 15% 16%));
  --tp-card:        hsl(var(--card,      0 0% 100%));

  color: var(--tp-fg);
  font-family: 'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

/* ── Buttons ─── */
.tofu-plugin .tp-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 14px; font-size: 13px; font-weight: 500; line-height: 1;
  border-radius: var(--tp-radius); border: 1px solid transparent;
  cursor: pointer; white-space: nowrap; transition: background 120ms, opacity 120ms;
  font-family: inherit;
}
.tofu-plugin .tp-btn:disabled { opacity: .45; cursor: not-allowed; }
.tofu-plugin .tp-btn-primary {
  background: var(--tp-primary); color: var(--tp-primary-fg); border-color: var(--tp-primary);
}
.tofu-plugin .tp-btn-primary:not(:disabled):hover { background: var(--tp-primary-h); border-color: var(--tp-primary-h); }
.tofu-plugin .tp-btn-secondary {
  background: var(--tp-secondary-bg); color: var(--tp-secondary-fg); border-color: var(--tp-border);
}
.tofu-plugin .tp-btn-secondary:not(:disabled):hover { background: var(--tp-border); }
.tofu-plugin .tp-btn-danger {
  background: var(--tp-danger); color: #fff; border-color: var(--tp-danger);
}
.tofu-plugin .tp-btn-danger:not(:disabled):hover { background: var(--tp-danger-h); }
.tofu-plugin .tp-btn-sm { padding: 4px 10px; font-size: 12px; }
.tofu-plugin .tp-btn-icon { padding: 4px 6px; }
.tofu-plugin .tp-btn svg { flex-shrink: 0; }

/* ── Card / Panel ─── */
.tofu-plugin .tp-card {
  background: var(--tp-card); border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius); overflow: hidden;
}
.tofu-plugin .tp-card-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--tp-border);
  gap: 8px;
}
.tofu-plugin .tp-card-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600;
}
.tofu-plugin .tp-card-icon {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; background: var(--tp-bg2);
  color: var(--tp-fg-muted); border-radius: calc(var(--tp-radius) - 2px);
  flex-shrink: 0;
}
.tofu-plugin .tp-card-actions {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.tofu-plugin .tp-card-body { padding: 14px 16px; }

/* ── Tabs ─── */
.tofu-plugin .tp-tabs {
  display: flex; gap: 2px; padding: 4px;
  background: var(--tp-bg2); border-radius: var(--tp-radius);
  width: fit-content;
}
.tofu-plugin .tp-tab {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 14px; font-size: 13px; font-weight: 500;
  border-radius: calc(var(--tp-radius) - 2px); border: none; cursor: pointer;
  background: transparent; color: var(--tp-fg-muted); transition: background 120ms, color 120ms;
  font-family: inherit;
}
.tofu-plugin .tp-tab.active {
  background: var(--tp-card); color: var(--tp-fg);
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
}
.tofu-plugin .tp-tab:not(.active):hover { background: var(--tp-border); color: var(--tp-fg); }

.tofu-plugin .tp-tab-bar {
  display: flex; gap: 0; border-bottom: 1px solid var(--tp-border);
}
.tofu-plugin .tp-tab-bar-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 8px 14px; font-size: 13px; font-weight: 500;
  border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--tp-fg-muted); cursor: pointer;
  margin-bottom: -1px; transition: color 120ms, border-color 120ms;
  font-family: inherit;
}
.tofu-plugin .tp-tab-bar-btn.active {
  color: var(--tp-primary); border-bottom-color: var(--tp-primary);
}
.tofu-plugin .tp-tab-bar-btn:hover { color: var(--tp-fg); }

/* ── Badge ─── */
.tofu-plugin .tp-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500;
}
.tofu-plugin .tp-badge-success { background: color-mix(in srgb, var(--tp-success) 15%, transparent); color: var(--tp-success); }
.tofu-plugin .tp-badge-danger  { background: color-mix(in srgb, var(--tp-danger)  15%, transparent); color: var(--tp-danger); }
.tofu-plugin .tp-badge-warning { background: color-mix(in srgb, var(--tp-warning) 15%, transparent); color: var(--tp-warning); }
.tofu-plugin .tp-badge-muted   { background: var(--tp-bg2); color: var(--tp-fg-muted); }
.tofu-plugin .tp-badge-primary { background: color-mix(in srgb, var(--tp-primary) 15%, transparent); color: var(--tp-primary); }

/* ── Terminal ─── */
.tofu-plugin .tp-terminal {
  background: #0d1117; color: #e6edf3;
  font-family: var(--tp-mono); font-size: 12px; line-height: 1.6;
  border-radius: 0 0 var(--tp-radius) var(--tp-radius);
}
.tofu-plugin .tp-terminal-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; background: rgba(255,255,255,.05);
  border-bottom: 1px solid rgba(255,255,255,.08); font-size: 11px; color: #8b949e;
}
.tofu-plugin .tp-terminal-body {
  padding: 10px 14px; min-height: 120px; overflow-y: auto; white-space: pre-wrap;
  word-break: break-word;
}

/* ── Table ─── */
.tofu-plugin .tp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.tofu-plugin .tp-table thead tr { border-bottom: 1px solid var(--tp-border); }
.tofu-plugin .tp-table th {
  padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em; color: var(--tp-fg-muted);
}
.tofu-plugin .tp-table td { padding: 8px 12px; border-bottom: 1px solid var(--tp-border); }
.tofu-plugin .tp-table tbody tr:last-child td { border-bottom: none; }
.tofu-plugin .tp-table tbody tr:hover { background: var(--tp-bg2); }

/* ── Form ─── */
.tofu-plugin .tp-input {
  display: block; width: 100%; padding: 7px 10px; font-size: 13px;
  background: var(--tp-card); color: var(--tp-fg);
  border: 1px solid var(--tp-border); border-radius: calc(var(--tp-radius) - 2px);
  outline: none; transition: border-color 120ms; font-family: inherit;
  box-sizing: border-box;
}
.tofu-plugin .tp-input:focus { border-color: var(--tp-primary); }
.tofu-plugin .tp-input::placeholder { color: var(--tp-fg-muted); opacity: .7; }
.tofu-plugin .tp-input-mono { font-family: var(--tp-mono); }
.tofu-plugin .tp-select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; padding-right: 28px; }
.tofu-plugin .tp-label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 5px; }
.tofu-plugin .tp-form-hint { font-size: 12px; color: var(--tp-fg-muted); margin-top: 4px; }
.tofu-plugin .tp-form-group { margin-bottom: 14px; }
.tofu-plugin .tp-form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; margin-top: 8px; border-top: 1px solid var(--tp-border); }

/* ── Modal ─── */
.tofu-plugin .tp-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999; padding: 16px;
}
.tofu-plugin .tp-modal {
  background: var(--tp-card); border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius); padding: 24px 28px;
  width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,.18);
  max-height: 90vh; overflow-y: auto;
}
.tofu-plugin .tp-modal h2 {
  margin: 0 0 18px; font-size: 16px; font-weight: 700;
  display: flex; align-items: center; gap: 8px;
}

/* ── Sidebar list item ─── */
.tofu-plugin .tp-ws-item {
  padding: 9px 12px; cursor: pointer; border-radius: calc(var(--tp-radius) - 2px);
  margin: 2px 6px; transition: background 100ms;
}
.tofu-plugin .tp-ws-item:hover { background: var(--tp-bg2); }
.tofu-plugin .tp-ws-item.active { background: var(--tp-bg2); color: var(--tp-fg); border-color: var(--tp-border); }
.tofu-plugin .tp-ws-item.active .tp-ws-path { color: var(--tp-fg-muted); opacity: .7; }
.tofu-plugin .tp-ws-name { font-size: 13px; font-weight: 500; }
.tofu-plugin .tp-ws-path { font-size: 11px; font-family: var(--tp-mono); color: var(--tp-fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Misc ─── */
.tofu-plugin .tp-page-header {
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 8px; margin-bottom: 16px;
}
.tofu-plugin .tp-page-title { display: flex; align-items: center; gap: 10px; font-size: 24px; font-weight: 600; letter-spacing: -0.025em; }
.tofu-plugin .tp-muted { color: var(--tp-fg-muted); }
.tofu-plugin .tp-mono { font-family: var(--tp-mono); }
.tofu-plugin .tp-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 48px 24px; text-align: center; gap: 10px; color: var(--tp-fg-muted);
}
.tofu-plugin .tp-empty svg { opacity: .35; margin-bottom: 4px; }
.tofu-plugin .tp-empty h3 { margin: 0; font-size: 15px; color: var(--tp-fg); }
.tofu-plugin .tp-empty p { margin: 0; font-size: 13px; }
.tofu-plugin .tp-loading { display: flex; align-items: center; justify-content: center; padding: 32px; }
.tofu-plugin .tp-spinner {
  width: 22px; height: 22px; border: 2px solid var(--tp-border);
  border-top-color: var(--tp-primary); border-radius: 50%;
  animation: tp-spin .7s linear infinite;
}
@keyframes tp-spin { to { transform: rotate(360deg); } }
.tofu-plugin .tp-hidden { display: none !important; }
.tofu-plugin .tp-tree-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px; cursor: pointer; font-size: 12px;
  justify-content: space-between; border-radius: 4px; transition: background 80ms;
}
.tofu-plugin .tp-tree-item:hover { background: var(--tp-bg2); }
.tofu-plugin .tp-tree-item.active { background: var(--tp-bg2); color: var(--tp-fg); }
.tofu-plugin .tp-var-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.tofu-plugin .tp-git-widget {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius); font-size: 12px; color: var(--tp-fg-muted);
  background: var(--tp-bg2);
}

/* pre block */
.tofu-plugin .tp-pre {
  background: var(--tp-bg2); border: 1px solid var(--tp-border);
  border-radius: var(--tp-radius); padding: 10px 14px;
  font-family: var(--tp-mono); font-size: 12px; line-height: 1.5;
  overflow-x: auto; white-space: pre; margin: 0;
}
`;

// ── SVG Icons ─────────────────────────────────────────────────────────────
function icon(name, size = 14) {
  const paths = {
    cube:      'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    layers:    'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    play:      'M5 3l14 9-14 9V3z',
    history:   'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
    sliders:   'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    folder:    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
    sitemap:   'M3 3h4v4H3zM17 3h4v4h-4zM10 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM5 7v4h14V7M12 11v6',
    download:  'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    upload:    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    check:     'M20 6 9 17l-5-5',
    checkDbl:  'M17 1l-8 8-4-4M21 5l-8 8',
    bomb:      'M5.5 5.5A7.5 7.5 0 1 0 13 13M15 1l4 4M18.5 1.5l1 1M13.5 6.5l4 4',
    spell:     'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
    eye:       'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeSlash:  'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22',
    trash:     'M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M8 6V4h8v2',
    pen:       'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
    plus:      'M12 5v14M5 12h14',
    stop:      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    eraser:    'M20 20H7L3 16l11-11 6 6-3.5 3.5M6 17l5-5',
    rotate:    'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    wand:      'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19.2 13.2M17.8 6.2l1.4-1.4M12.2 6.2 10.8 4.8M5 19l10-10',
    gear:      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    arrowUp:   'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M19 12l-7 7-7-7',
    arrowUpBox:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    git:       'M15 22V11M9 11V2M9 11a4 4 0 0 0 6 0M3 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0M17 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
    fileTf:    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    fileCode:  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 13l-2 2 2 2M14 13l2 2-2 2',
    file:      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    fileAlt:   'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    lock:      'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
    times:     'M18 6 6 18M6 6l12 12',
    save:      'M19 21H5a2 2 0 0 0-2-2V5a2 2 0 0 0 2-2h11l5 5v11a2 2 0 0 0-2 2zM17 21v-8H7v8M7 3v5h8',
    gauge:     'M12 22c5.52 0 10-4.48 10-10S17.52 2 12 2 2 6.48 2 12s4.48 10 10 10zM12 6v2M12 16v2M6 12H4M20 12h-2',
  };
  const d = paths[name];
  if (!d) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;display:inline-block;vertical-align:middle;"><path d="${d}"/></svg>`;
}

// ── State ─────────────────────────────────────────────────────────────────
let _container   = null;
let _wsUnsub     = null;
let _workspaces  = [];
let _selected    = null;
let _wsTab       = 'runs';
let _mainTab     = 'dashboard';
let _runId       = null;
let _pluginApi   = null;
let _api         = null;
let _navigate    = null;
let _refreshServersState = null;
let _showToast   = null;
let _showConfirm = null;
let _openFile    = null;
let _fileTree    = null;
let _status      = null;
let _runsPage    = 1;
let _runsPageSize = 5;

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'').replace(/\r/g,'');
}
function fmt(dt) {
  if (!dt) return '—';
  const d = new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  return d.toLocaleString();
}
function preBlock(code) {
  return `<pre class="tp-pre">${esc(code)}</pre>`;
}
function statusBadge(run) {
  if (!run) return `<span class="tp-badge tp-badge-muted">No runs</span>`;
  const cls = { success:'tp-badge-success', failed:'tp-badge-danger', running:'tp-badge-warning' };
  return `<span class="tp-badge ${cls[run.status] || 'tp-badge-warning'}">${esc(run.status)}</span>`;
}
function actionBadge(action) {
  const icons = { plan:'eye', apply:'checkDbl', destroy:'bomb', init:'download', validate:'spell' };
  return `${icon(icons[action] || 'play', 12)} ${esc(action)}`;
}
function fileIcon(name) {
  if (name.endsWith('.tf'))   return icon('fileTf', 13);
  if (name.endsWith('.tfvars') || name.endsWith('.tfvars.json')) return icon('sliders', 13);
  if (name.endsWith('.json')) return icon('fileCode', 13);
  if (name.endsWith('.md'))   return icon('fileAlt', 13);
  return icon('file', 13);
}

function btn(cls, id, label, attrs = '') {
  const base = 'tp-btn';
  const map = { primary:'tp-btn-primary', secondary:'tp-btn-secondary', danger:'tp-btn-danger', sm:'tp-btn-sm', icon:'tp-btn-icon' };
  const classes = [base, ...cls.split(' ').map(c => map[c] || c)].join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<button class="${classes}"${idAttr} ${attrs}>${label}</button>`;
}

// ── Style injection ───────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('tofu-plugin-css')) return;
  const style = document.createElement('style');
  style.id = 'tofu-plugin-css';
  style.textContent = PLUGIN_STYLES;
  document.head.appendChild(style);
}

// ── Mount / Unmount ───────────────────────────────────────────────────────
export async function mount(container, { api, pluginApi, navigate, refreshServersState, showToast, showConfirm, onWsMessage }) {
  ensureStyles();
  _container   = container;
  _pluginApi   = pluginApi;
  _api         = api;
  _navigate    = navigate || (() => {});
  _refreshServersState = refreshServersState || null;
  _showToast   = showToast;
  _showConfirm = showConfirm;
  _wsUnsub = onWsMessage(handleWsMessage);

  container.classList.add('tofu-plugin');
  container.innerHTML = `<div class="tp-loading"><div class="tp-spinner"></div></div>`;

  try {
    const [status, workspaces] = await Promise.all([
      pluginApi.request('/status'),
      pluginApi.request('/workspaces'),
    ]);
    _status     = status;
    _workspaces = workspaces;
    renderApp();
  } catch (e) {
    container.innerHTML = `<div class="tp-empty"><p style="color:var(--tp-danger)">Error: ${esc(e.message)}</p></div>`;
  }
}

export function unmount() {
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
  _refreshServersState = null;
  if (_container) _container.classList.remove('tofu-plugin');
  if (_modalOverlay) { _modalOverlay.remove(); _modalOverlay = null; }
  _container = _selected = _runId = _fileTree = _openFile = null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────
async function handleWsMessage(msg) {
  if (msg.type === 'tofu_start') {
    _runId = msg.runId;
    updateRunButtons(true);
  } else if (msg.type === 'tofu_output') {
    appendTerminal(msg.data, msg.stream);
  } else if (msg.type === 'tofu_done') {
    _runId = null;
    updateRunButtons(false);
    const line = msg.success
      ? `\n✓  Finished successfully (exit 0)\n`
      : `\n✗  Failed (exit ${msg.exitCode ?? '?'}${msg.error ? ': '+msg.error : ''})\n`;
    appendTerminal(line, msg.success ? 'success' : 'error');
    refreshRunList();
    refreshDashboardCard(msg.workspaceId);
    if (msg.success && _refreshServersState) {
      try { await _refreshServersState({ renderCurrentView: false, reason: 'opentofu-run' }); } catch {}
    }
  }
}

function updateRunButtons(running) {
  document.querySelectorAll('.tofu-action').forEach(b => { b.disabled = running; });
  const cancel = document.getElementById('tofu-btn-cancel');
  if (cancel) cancel.classList.toggle('tp-hidden', !running);
  const clear  = document.getElementById('tofu-btn-clear');
  if (clear)  clear.classList.toggle('tp-hidden',  running);
}

function appendTerminal(data, stream) {
  const body = document.getElementById('tofu-terminal-body');
  if (!body) return;
  const span = document.createElement('span');
  const colors = {
    stderr:  '#f85149',
    success: '#3fb950',
    error:   '#f85149',
    meta:    '#8b949e',
  };
  span.style.color = colors[stream] || 'inherit';
  span.style.whiteSpace = 'pre-wrap';
  span.textContent = stripAnsi(data);
  body.appendChild(span);
  body.scrollTop = body.scrollHeight;
}

function normalizeRunsResponse(response) {
  if (Array.isArray(response)) {
    return {
      items: response,
      pagination: {
        page: 1,
        page_size: response.length || _runsPageSize,
        total: response.length,
        total_pages: 1,
        has_prev: false,
        has_next: false,
      },
    };
  }
  return {
    items: Array.isArray(response?.items) ? response.items : [],
    pagination: response?.pagination || {
      page: 1,
      page_size: _runsPageSize,
      total: 0,
      total_pages: 1,
      has_prev: false,
      has_next: false,
    },
  };
}

async function refreshRunList() {
  if (!_selected) return;
  const el = document.getElementById('tofu-runs-list');
  if (!el) return;
  try {
    const response = await _pluginApi.request(`/workspaces/${_selected}/runs?page=${_runsPage}&page_size=${_runsPageSize}`);
    const { items: runs, pagination } = normalizeRunsResponse(response);
    _runsPage = pagination.page;
    _runsPageSize = pagination.page_size;
    _workspaces = _workspaces.map(w => {
      if (w.id !== _selected) return w;
      return { ...w, last_run: runs[0] || null };
    });
    el.innerHTML = renderRunsTable(runs, pagination);
    bindRunsEvents(runs, pagination);
  } catch {}
}

async function refreshDashboardCard(workspaceId) {
  const card = document.querySelector(`.tofu-dash-card[data-id="${workspaceId}"]`);
  if (!card) return;
  try {
    const ws = await _pluginApi.request('/workspaces');
    _workspaces = ws;
    const found = ws.find(w => w.id === workspaceId);
    if (found) card.querySelector('.tofu-card-status').innerHTML = statusBadge(found.last_run);
  } catch {}
}

// ── App Shell ─────────────────────────────────────────────────────────────
function renderApp() {
  if (!_container) return;
  _container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <div class="tp-tabs" id="tofu-main-tabs">
        <button class="tp-tab${_mainTab==='dashboard'?' active':''}" data-tab="dashboard">
          ${icon('gauge',13)} Dashboard
        </button>
        <button class="tp-tab${_mainTab==='workspaces'?' active':''}" data-tab="workspaces">
          ${icon('layers',13)} Workspaces
        </button>
        <button class="tp-tab${_mainTab==='installation'?' active':''}${!_status.installed?' style="color:var(--tp-danger);"':''}${!_status.installed?' data-attention="1"':''}" data-tab="installation">
          ${icon('download',13)} Installation
        </button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="tp-git-widget" style="margin-right:2px;">
          ${icon('git', 13)}
          <span id="tofu-git-branch">–</span>
        </div>
        ${btn('secondary sm icon', 'tofu-git-pull-btn', icon('arrowDown',13), 'title="Pull from remote"')}
        ${btn('secondary sm icon', 'tofu-git-push-btn', icon('arrowUp',13), 'title="Push to remote"')}
        <div style="width:1px;height:16px;background:var(--tp-border);margin:0 2px;"></div>
        ${btn('secondary sm icon', 'tofu-git-settings-link', icon('gear',13), 'title="Git Settings"')}
        ${btn('primary sm', 'tofu-btn-new', icon('plus',13)+' Workspace')}
      </div>
    </div>

    <div id="tofu-tab-content"></div>
  `;

  document.getElementById('tofu-btn-new').addEventListener('click', () => openWorkspaceModal(null));

  document.getElementById('tofu-main-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tp-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === _mainTab) return;
    _mainTab = tab;
    document.querySelectorAll('#tofu-main-tabs .tp-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    initMainTab(tab);
  });

  initMainTab(_mainTab);
  initTofuGitWidget();
}

async function initTofuGitWidget() {
  try {
    const cfg = await _api.request('/playbooks-git/config');
    const b = document.getElementById('tofu-git-branch');
    if (b) b.textContent = cfg.repoUrl ? (cfg.branch || 'main') : 'not configured';
  } catch {}

  document.getElementById('tofu-git-pull-btn')?.addEventListener('click', async () => {
    const pullBtn = document.getElementById('tofu-git-pull-btn');
    pullBtn.disabled = true;
    try {
      await _api.request('/playbooks-git/pull', { method: 'POST' });
      _showToast('Pulled from git.', 'success');
      const ws = await _pluginApi.request('/workspaces');
      _workspaces = Array.isArray(ws) ? ws : (ws.workspaces || []);
      const content = document.getElementById('tofu-tab-content');
      if (content) initMainTab(_mainTab);
    } catch (e) { _showToast('Pull failed: ' + e.message, 'error'); }
    finally { pullBtn.disabled = false; }
  });

  document.getElementById('tofu-git-push-btn')?.addEventListener('click', async () => {
    const pushBtn = document.getElementById('tofu-git-push-btn');
    pushBtn.disabled = true;
    try {
      await _api.request('/playbooks-git/push', { method: 'POST' });
      _showToast('Pushed to git.', 'success');
    } catch (e) { _showToast('Push failed: ' + e.message, 'error'); }
    finally { pushBtn.disabled = false; }
  });

  document.getElementById('tofu-git-settings-link')?.addEventListener('click', () => {
    _navigate('/settings/git');
  });
}

async function initMainTab(tab) {
  const content = document.getElementById('tofu-tab-content');
  if (!content) return;
  if (tab === 'dashboard')    renderDashboard(content);
  if (tab === 'workspaces')   renderWorkspacesTab(content);
  if (tab === 'installation') renderInstallationTab(content);
}

// ── Tab: Installation ─────────────────────────────────────────────────────
function renderInstallationTab(content) {
  if (_status.installed) {
    // Show version info + update selector
    content.innerHTML = `
      <div class="tp-card">
        <div class="tp-card-header">
          <div class="tp-card-title">
            <div class="tp-card-icon">${icon('arrowUpBox', 14)}</div>
            OpenTofu Installation
          </div>
        </div>
        <div class="tp-card-body">
          <p style="font-size:13px;color:var(--tp-fg-muted);margin:0 0 16px;">
            Currently installed: <strong style="color:var(--tp-fg);font-family:var(--tp-mono);">${esc(_status.version || 'unknown')}</strong>
            &nbsp;·&nbsp; <span style="font-size:12px;color:var(--tp-fg-muted);">${esc(_status.binary || '')}</span>
          </p>
          <p style="font-size:13px;font-weight:500;margin:0 0 8px;">Switch version</p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select id="tofu-update-select" class="tp-input tp-select" style="max-width:200px;" disabled>
              <option>Loading versions…</option>
            </select>
            ${btn('primary sm', 'tofu-btn-do-update', icon('download',12)+' Install', 'disabled')}
            <span id="tofu-update-msg" style="font-size:12px;color:var(--tp-fg-muted);"></span>
          </div>
        </div>
      </div>`;
    initUpdatePanel();
  } else {
    content.innerHTML = setupGuidePanel();
    initInstallPanel();
  }
}

// ── Tab: Dashboard ────────────────────────────────────────────────────────
function renderDashboard(content) {
  if (_workspaces.length === 0) {
    content.innerHTML = `
      <div class="tp-card">
        <div class="tp-empty">
          ${icon('cube', 40)}
          <h3>No workspaces yet</h3>
          <p>Create a workspace to manage your OpenTofu infrastructure.</p>
          ${btn('primary', 'dash-btn-new', icon('plus',14)+' Create Workspace')}
        </div>
      </div>
      ${!_status.installed ? `<div style="margin-top:16px;"><div class="tp-card"><div class="tp-card-body" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--tp-danger);">${icon('times',13)} OpenTofu not installed — <button class="tp-btn tp-btn-secondary tp-btn-sm" id="dash-goto-install">Go to Installation tab</button></div></div></div>` : ''}
    `;
    document.getElementById('dash-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));
    document.getElementById('dash-goto-install')?.addEventListener('click', () => { _mainTab = 'installation'; renderApp(); });
    return;
  }

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">
      ${_workspaces.map(ws => `
        <div class="tp-card tofu-dash-card" data-id="${esc(ws.id)}" style="cursor:pointer;transition:box-shadow 150ms;">
          <div class="tp-card-header">
            <div class="tp-card-title">
              <div class="tp-card-icon">${icon('layers', 14)}</div>
              <span>${esc(ws.name)}</span>
            </div>
            <div class="tofu-card-status">${statusBadge(ws.last_run)}</div>
          </div>
          <div class="tp-card-body">
            <div style="font-family:var(--tp-mono);font-size:11px;color:var(--tp-fg-muted);margin-bottom:6px;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(ws.path)}</div>
            ${ws.description ? `<p style="font-size:13px;color:var(--tp-fg-muted);margin:0 0 6px;">${esc(ws.description)}</p>` : ''}
            ${ws.last_run ? `
              <div style="font-size:12px;color:var(--tp-fg-muted);display:flex;align-items:center;gap:4px;">
                Last: ${actionBadge(ws.last_run.action)} &nbsp;·&nbsp; ${esc(fmt(ws.last_run.started_at))}
              </div>` : '<div style="font-size:12px;color:var(--tp-fg-muted);">No runs yet</div>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  content.querySelectorAll('.tofu-dash-card').forEach(card => {
    card.addEventListener('click', () => {
      _selected = card.dataset.id;
      _mainTab  = 'workspaces';
      _wsTab    = 'runs';
      renderApp();
    });
  });

}

function setupGuidePanel() {
  return `
    <div class="tp-card" id="tofu-install-panel" style="margin-bottom:16px;">
      <div class="tp-card-header">
        <div class="tp-card-title">
          <div class="tp-card-icon">${icon('download', 14)}</div>
          Install OpenTofu
        </div>
      </div>
      <div class="tp-card-body">
        <p style="font-size:13px;color:var(--tp-fg-muted);margin:0 0 14px;">
          OpenTofu is not installed. Select a version to install it directly into this container —
          no host setup or Docker restart needed.
        </p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="tofu-version-select" class="tp-input tp-select" style="max-width:200px;" disabled>
            <option>Loading versions…</option>
          </select>
          ${btn('primary sm', 'tofu-btn-install', icon('download',12)+' Install', 'disabled')}
          <span id="tofu-install-msg" style="font-size:12px;color:var(--tp-fg-muted);"></span>
        </div>
        <p style="font-size:12px;color:var(--tp-fg-muted);margin:12px 0 0;">
          Your workspace directories still need to be mounted in <code>docker-compose.yml</code>:
          ${preBlock('services:\n  shipyard:\n    volumes:\n      - /host/path/to/workspaces:/workspaces:rw')}
        </p>
      </div>
    </div>`;
}

async function initUpdatePanel() {
  const sel = document.getElementById('tofu-update-select');
  const doBtn = document.getElementById('tofu-btn-do-update');
  const msg = document.getElementById('tofu-update-msg');
  if (!sel || !doBtn) return;

  try {
    const { releases } = await _pluginApi.request('/releases');
    if (!releases || releases.length === 0) {
      sel.innerHTML = '<option value="">No releases found</option>';
      return;
    }
    sel.innerHTML = releases.map((v, i) =>
      `<option value="${esc(v)}"${i === 0 ? ' selected' : ''}>${esc(v)}${i === 0 ? ' (latest)' : ''}${v === _status.version ? ' ← current' : ''}</option>`
    ).join('');
    sel.disabled = false;
    doBtn.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load versions</option>';
    if (msg) msg.textContent = e.message;
    return;
  }

  doBtn.addEventListener('click', async () => {
    const version = sel.value;
    if (!version) return;
    doBtn.disabled = true;
    sel.disabled = true;
    doBtn.innerHTML = '<div class="tp-spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></div> Installing…';
    if (msg) msg.textContent = `Downloading OpenTofu v${version}…`;
    try {
      const result = await _pluginApi.request('/install', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      _status = { installed: true, binary: result.binary, version: result.version };
      _showToast(`OpenTofu updated to v${result.version || version}`, 'success');
      setTimeout(() => renderApp(), 600);
    } catch (e) {
      if (msg) msg.textContent = `✗ ${e.message}`;
      doBtn.disabled = false;
      sel.disabled = false;
      doBtn.innerHTML = icon('download',12)+' Install';
      _showToast('Update failed: ' + e.message, 'error');
    }
  });
}

async function initInstallPanel() {
  const sel = document.getElementById('tofu-version-select');
  const installBtn = document.getElementById('tofu-btn-install');
  const msg = document.getElementById('tofu-install-msg');
  if (!sel || !installBtn) return;

  try {
    const { releases } = await _pluginApi.request('/releases');
    if (!releases || releases.length === 0) {
      sel.innerHTML = '<option value="">No releases found</option>';
      return;
    }
    sel.innerHTML = releases.map((v, i) =>
      `<option value="${esc(v)}"${i === 0 ? ' selected' : ''}>${esc(v)}${i === 0 ? ' (latest)' : ''}</option>`
    ).join('');
    sel.disabled = false;
    installBtn.disabled = false;
  } catch (e) {
    sel.innerHTML = `<option value="">Could not load versions</option>`;
    if (msg) msg.textContent = e.message;
    return;
  }

  installBtn.addEventListener('click', async () => {
    const version = sel.value;
    if (!version) return;
    installBtn.disabled = true;
    sel.disabled = true;
    installBtn.innerHTML = '<div class="tp-spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></div> Installing…';
    if (msg) msg.textContent = `Downloading OpenTofu v${version}, this may take a minute…`;

    try {
      const result = await _pluginApi.request('/install', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      if (msg) msg.textContent = `✓ Installed v${result.version || version}`;
      _status = { installed: true, binary: result.binary, version: result.version };
      _showToast(`OpenTofu v${result.version || version} installed`, 'success');
      setTimeout(() => renderApp(), 800);
    } catch (e) {
      if (msg) msg.textContent = `✗ ${e.message}`;
      installBtn.disabled = false;
      sel.disabled = false;
      installBtn.innerHTML = icon('download',12)+' Install';
      _showToast('Install failed: ' + e.message, 'error');
    }
  });
}

// ── Tab: Workspaces ───────────────────────────────────────────────────────
function renderWorkspacesTab(content) {
  if (_workspaces.length === 0) {
    content.innerHTML = `
      <div class="tp-card">
        <div class="tp-empty">
          ${icon('layers', 40)}
          <h3>No workspaces</h3>
          <p>Create a workspace to start managing your OpenTofu infrastructure.</p>
          ${btn('primary', 'ws-btn-new', icon('plus',14)+' Create Workspace')}
        </div>
      </div>`;
    document.getElementById('ws-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));
    return;
  }

  const ws = _workspaces.find(w => w.id === _selected) || _workspaces[0];
  if (!_selected) _selected = ws.id;

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start;">
      <!-- Sidebar -->
      <div class="tp-card" style="padding:6px 0;">
        ${_workspaces.map(w => `
          <div class="tp-ws-item${_selected === w.id ? ' active' : ''}" data-id="${esc(w.id)}">
            <div class="tp-ws-name">${esc(w.name)}</div>
            <div class="tp-ws-path">${esc(w.path)}</div>
          </div>`).join('')}
      </div>
      <!-- Detail -->
      <div id="tofu-ws-detail"></div>
    </div>
  `;

  content.querySelectorAll('.tp-ws-item').forEach(item => {
    item.addEventListener('click', () => {
      _selected = item.dataset.id;
      _runsPage = 1;
      _fileTree = null; _openFile = null;
      renderWorkspacesTab(content);
    });
  });

  renderWorkspaceDetail(ws);
}

async function renderWorkspaceDetail(ws) {
  const detail = document.getElementById('tofu-ws-detail');
  if (!detail || !ws) return;

  const subTabs = ['runs','variables','files','resources'];
  const subIcons = { runs:'history', variables:'sliders', files:'folder', resources:'sitemap' };

  detail.innerHTML = `
    <div class="tp-card" style="margin-bottom:12px;">
      <div class="tp-card-header">
        <div class="tp-card-title">
          <div class="tp-card-icon">${icon('layers', 14)}</div>
          ${esc(ws.name)}
        </div>
        <div class="tp-card-actions">
          ${btn('secondary sm icon', 'tofu-btn-edit', icon('pen',13), 'title="Edit"')}
          ${btn('danger sm icon', 'tofu-btn-delete', icon('trash',13), 'title="Delete"')}
        </div>
      </div>
      <div style="padding:8px 16px;font-size:12px;font-family:var(--tp-mono);color:var(--tp-fg-muted);">${esc(ws.path)}</div>
    </div>

    <div class="tp-card" style="overflow:hidden;">
      <div class="tp-tab-bar" id="tofu-ws-tabs">
        ${subTabs.map(t => `
          <button class="tp-tab-bar-btn${_wsTab===t?' active':''}" data-tab="${t}">
            ${icon(subIcons[t], 13)} ${t.charAt(0).toUpperCase()+t.slice(1)}
          </button>`).join('')}
      </div>
      <div id="tofu-ws-tab-content" style="padding:16px;"></div>
    </div>
  `;

  document.getElementById('tofu-btn-edit').addEventListener('click', () => openWorkspaceModal(ws));
  document.getElementById('tofu-btn-delete').addEventListener('click', async () => {
    if (!await _showConfirm(`Delete workspace "${ws.name}"?`, { title:'Delete', confirmText:'Delete', danger:true })) return;
    await _pluginApi.request(`/workspaces/${ws.id}`, { method:'DELETE' });
    _workspaces = _workspaces.filter(w => w.id !== ws.id);
    _selected   = _workspaces[0]?.id || null;
    const content = document.getElementById('tofu-tab-content');
    if (content) renderWorkspacesTab(content);
  });

  document.getElementById('tofu-ws-tabs').addEventListener('click', e => {
    const tabBtn = e.target.closest('.tp-tab-bar-btn');
    if (!tabBtn) return;
    _wsTab = tabBtn.dataset.tab;
    _fileTree = null; _openFile = null;
    document.querySelectorAll('#tofu-ws-tabs .tp-tab-bar-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === _wsTab));
    loadWsTab(ws);
  });

  loadWsTab(ws);
}

async function loadWsTab(ws) {
  const el = document.getElementById('tofu-ws-tab-content');
  if (!el) return;
  if (_wsTab === 'runs')      await loadRunsTab(el, ws);
  if (_wsTab === 'variables') loadVariablesTab(el, ws);
  if (_wsTab === 'files')     await loadFilesTab(el, ws);
  if (_wsTab === 'resources') await loadResourcesTab(el, ws);
}

// ── Sub-tab: Runs ─────────────────────────────────────────────────────────
async function loadRunsTab(el, ws) {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
      <!-- Actions + Terminal -->
      <div class="tp-card">
        <div class="tp-card-header">
          <div class="tp-card-title">${icon('play',14)} Run</div>
          <div class="tp-card-actions">
            ${btn('secondary sm tp-hidden', 'tofu-btn-cancel', icon('stop',12)+' Cancel')}
            ${btn('secondary sm icon', 'tofu-btn-clear', icon('eraser',13), 'title="Clear terminal"')}
          </div>
        </div>
        <div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--tp-border);">
          ${btn('secondary sm tofu-action', '', icon('download',12)+' init', 'data-action="init"')}
          ${btn('secondary sm tofu-action', '', icon('spell',12)+' validate', 'data-action="validate"')}
          ${btn('secondary sm tofu-action', '', icon('eye',12)+' plan', 'data-action="plan"')}
          ${btn('primary sm tofu-action', '', icon('checkDbl',12)+' apply', 'data-action="apply"')}
          ${btn('danger sm tofu-action', '', icon('bomb',12)+' destroy', 'data-action="destroy"')}
        </div>
        <div class="tp-terminal">
          <div class="tp-terminal-header">
            ${icon('play',11)} <span>${esc(ws.name)}</span>
          </div>
          <div class="tp-terminal-body" id="tofu-terminal-body" style="min-height:360px;"></div>
        </div>
      </div>

      <!-- Run history -->
      <div class="tp-card">
        <div class="tp-card-header">
          <div class="tp-card-title">${icon('history',14)} History</div>
          <div class="tp-card-actions">
            ${btn('secondary sm icon', 'tofu-btn-refresh-runs', icon('rotate',13), 'title="Refresh"')}
          </div>
        </div>
        <div id="tofu-runs-list">
          <div class="tp-loading"><div class="tp-spinner"></div></div>
        </div>
      </div>
    </div>
  `;

  if (_runId) updateRunButtons(true);
  _runsPage = 1;

  document.querySelectorAll('.tofu-action').forEach(actionBtn => {
    actionBtn.addEventListener('click', () => executeAction(ws, actionBtn.dataset.action));
  });
  document.getElementById('tofu-btn-cancel')?.addEventListener('click', () => {
    if (_runId) _pluginApi.request(`/workspaces/${ws.id}/cancel/${_runId}`, { method:'POST' }).catch(() => {});
  });
  document.getElementById('tofu-btn-clear')?.addEventListener('click', () => {
    const body = document.getElementById('tofu-terminal-body');
    if (body) body.innerHTML = '';
  });
  document.getElementById('tofu-btn-refresh-runs')?.addEventListener('click', () => refreshRunList());

  try {
    const response = await _pluginApi.request(`/workspaces/${ws.id}/runs?page=${_runsPage}&page_size=${_runsPageSize}`);
    const { items: runs, pagination } = normalizeRunsResponse(response);
    _runsPage = pagination.page;
    _runsPageSize = pagination.page_size;
    const listEl = document.getElementById('tofu-runs-list');
    if (listEl) { listEl.innerHTML = renderRunsTable(runs, pagination); bindRunsEvents(runs, pagination); }
  } catch {}
}

function renderRunsTable(runs, pagination) {
  if (!runs || runs.length === 0) {
    return `<div class="tp-empty" style="padding:20px;"><p>No runs yet</p></div>`;
  }
  return `
    <table class="tp-table">
      <thead><tr>
        <th>Action</th><th>Status</th><th>Started</th><th style="width:40px;"></th>
      </tr></thead>
      <tbody>
        ${runs.map(r => `
          <tr>
            <td style="display:flex;align-items:center;gap:4px;">${actionBadge(r.action)}</td>
            <td>${statusBadge(r)}</td>
            <td style="font-size:11px;color:var(--tp-fg-muted);">${esc(fmt(r.started_at))}</td>
            <td>
              ${btn('secondary sm icon tofu-run-log', '', icon('eye',12), `data-id="${esc(r.id)}" title="Show output"`)}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 12px 12px;font-size:12px;color:var(--tp-fg-muted);">
      <div>Showing ${runs.length} of ${pagination.total} · Page ${pagination.page} / ${pagination.total_pages}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="display:flex;align-items:center;margin:0;gap:6px;">
          Per page
          <select id="tofu-runs-page-size" class="tp-input tp-select" style="width:auto;min-width:64px;padding:4px 24px 4px 8px;font-size:12px;height:auto;">
            ${[5, 10, 20, 50, 100].map(size => `<option value="${size}"${pagination.page_size === size ? ' selected' : ''}>${size}</option>`).join('')}
          </select>
        </label>
        ${btn('secondary sm', 'tofu-runs-prev', 'Prev', pagination.has_prev ? '' : 'disabled')}
        ${btn('secondary sm', 'tofu-runs-next', 'Next', pagination.has_next ? '' : 'disabled')}
      </div>
    </div>`;
}

function bindRunsEvents(runs, pagination) {
  document.querySelectorAll('.tofu-run-log').forEach(logBtn => {
    logBtn.addEventListener('click', async () => {
      const run = runs.find(r => r.id === logBtn.dataset.id);
      if (!run) return;
      try {
        const full = await _pluginApi.request(`/workspaces/${_selected}/runs/${run.id}`);
        showRunOutputModal(full);
      } catch (e) { _showToast(e.message, 'error'); }
    });
  });
  document.getElementById('tofu-runs-prev')?.addEventListener('click', () => {
    if (!pagination.has_prev) return;
    _runsPage = Math.max(1, pagination.page - 1);
    refreshRunList();
  });
  document.getElementById('tofu-runs-next')?.addEventListener('click', () => {
    if (!pagination.has_next) return;
    _runsPage = pagination.page + 1;
    refreshRunList();
  });
  document.getElementById('tofu-runs-page-size')?.addEventListener('change', e => {
    _runsPageSize = Math.max(1, parseInt(e.target.value, 10) || 10);
    _runsPage = 1;
    refreshRunList();
  });
}

function showRunOutputModal(run) {
  showModal(`
    <h2 style="display:flex;align-items:center;gap:6px;">${actionBadge(run.action)} — ${esc(run.status)}</h2>
    <div style="font-size:12px;color:var(--tp-fg-muted);margin-bottom:12px;">${esc(fmt(run.started_at))}</div>
    <div class="tp-terminal" style="max-height:55vh;overflow:auto;border-radius:var(--tp-radius);">
      <div class="tp-terminal-header">${icon('play',11)} ${esc(run.action || 'Run output')}</div>
      <div class="tp-terminal-body" style="white-space:pre-wrap;">${esc(run.output || '(no output)')}</div>
    </div>
    <div class="tp-form-actions">
      ${btn('secondary', 'run-modal-close', 'Close')}
    </div>
  `, { maxWidth: '700px' });
}

async function executeAction(ws, action) {
  if (_runId) return;
  if (action === 'destroy') {
    if (!await _showConfirm(`Destroy all resources in "${ws.name}"? This cannot be undone.`,
      { title:'Destroy', confirmText:'Destroy', danger:true })) return;
  }
  if (action === 'apply') {
    if (!await _showConfirm(`Apply changes in "${ws.name}"?`,
      { title:'Apply', confirmText:'Apply', danger:false })) return;
  }
  const body = document.getElementById('tofu-terminal-body');
  if (body) body.innerHTML = '';
  try {
    await _pluginApi.request(`/workspaces/${ws.id}/run`, { method:'POST', body: JSON.stringify({ action }) });
  } catch (e) {
    appendTerminal(`Error: ${e.message}`, 'error');
  }
}

// ── Sub-tab: Variables ────────────────────────────────────────────────────
const SECRET_KEY_RE = /secret|token|password|passwd|pass|pwd|key|private|credential|auth|api_?key/i;

function isSecretKey(k) { return SECRET_KEY_RE.test(k); }

function renderVarRows(vars) {
  const entries = Object.entries(vars);
  const rows = entries.map(([k, v]) => {
    const secret = isSecretKey(k);
    return `
      <div class="tp-var-row tofu-var-row" data-draft="false">
        <input class="tp-input tp-input-mono var-key" value="${esc(k)}" placeholder="KEY"
          style="flex:0 0 220px;font-size:12px;" spellcheck="false">
        <div style="position:relative;flex:1;display:flex;align-items:center;">
          <input class="tp-input tp-input-mono var-val" value="${esc(v)}"
            type="${secret ? 'password' : 'text'}"
            style="width:100%;font-size:12px;padding-right:${secret ? '32px' : '8px'};" spellcheck="false">
          ${secret ? `<button class="var-toggle-vis" tabindex="-1" title="Show/hide"
            style="position:absolute;right:6px;background:none;border:none;cursor:pointer;color:var(--tp-fg-muted);padding:0;line-height:1;">
            <span class="vis-icon">${icon('eye',13)}</span></button>` : ''}
        </div>
        ${btn('danger sm icon var-delete', '', icon('trash',12), 'title="Remove"')}
      </div>`;
  }).join('');

  return `
    ${entries.length ? '' : '<p style="color:var(--tp-fg-muted);font-size:13px;margin:0 0 10px;">No variables yet.</p>'}
    ${rows}
    <div class="tp-var-row tofu-var-row tofu-var-draft" data-draft="true">
      <input class="tp-input tp-input-mono" id="tofu-new-key" placeholder="NEW_VARIABLE"
        style="flex:0 0 220px;font-size:12px;" spellcheck="false">
      <input class="tp-input tp-input-mono" id="tofu-new-val" placeholder="value"
        style="flex:1;font-size:12px;" spellcheck="false">
      <div style="flex-shrink:0;width:38px;display:flex;align-items:center;justify-content:center;color:var(--tp-fg-muted);">
        ${icon('plus',13)}
      </div>
    </div>`;
}

function loadVariablesTab(el, ws) {
  let vars = { ...(ws.env_vars || {}) };
  let draft = { key: '', value: '' };
  let saveTimer = null;
  let isSaving = false;
  let queuedVars = null;
  let lastSavedJson = JSON.stringify(vars);

  function setStatus(message, tone = 'muted') {
    const status = document.getElementById('tofu-vars-status');
    if (!status) return;
    const colors = {
      muted: 'var(--tp-fg-muted)',
      success: 'var(--tp-success)',
      error: 'var(--tp-danger)',
    };
    status.textContent = message;
    status.style.color = colors[tone] || colors.muted;
  }

  function getDraftState() {
    return {
      key: document.getElementById('tofu-new-key')?.value ?? draft.key,
      value: document.getElementById('tofu-new-val')?.value ?? draft.value,
    };
  }

  function collectExistingVars() {
    const nextVars = {};
    const duplicates = new Set();
    el.querySelectorAll('.tofu-var-row[data-draft="false"]').forEach(row => {
      const k = row.querySelector('.var-key')?.value.trim() || '';
      const v = row.querySelector('.var-val')?.value || '';
      if (!k) return;
      if (Object.prototype.hasOwnProperty.call(nextVars, k)) duplicates.add(k);
      nextVars[k] = v;
    });
    if (duplicates.size) {
      setStatus(`Duplicate key: ${[...duplicates][0]}`, 'error');
      return null;
    }
    return nextVars;
  }

  async function persistVars(nextVars) {
    const serialized = JSON.stringify(nextVars);
    if (serialized === lastSavedJson) {
      setStatus('All changes saved.', 'success');
      return;
    }
    if (isSaving) {
      queuedVars = nextVars;
      setStatus('Saving...', 'muted');
      return;
    }
    isSaving = true;
    setStatus('Saving...', 'muted');
    try {
      await _pluginApi.request(`/workspaces/${ws.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: ws.name, path: ws.path, description: ws.description, env_vars: nextVars }),
      });
      vars = { ...nextVars };
      ws.env_vars = vars;
      _workspaces = _workspaces.map(w => w.id === ws.id ? { ...w, env_vars: vars } : w);
      lastSavedJson = serialized;
      setStatus('All changes saved.', 'success');
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, 'error');
    } finally {
      isSaving = false;
      if (queuedVars) {
        const pending = queuedVars;
        queuedVars = null;
        persistVars(pending);
      }
    }
  }

  function scheduleSave(nextVars, delay = 700) {
    if (saveTimer) clearTimeout(saveTimer);
    setStatus('Saving...', 'muted');
    saveTimer = setTimeout(() => { saveTimer = null; persistVars(nextVars); }, delay);
  }

  function flushSave(nextVars) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persistVars(nextVars);
  }

  function commitDraftAndSave(immediate = false) {
    draft = getDraftState();
    const k = draft.key.trim();
    if (!k) return false;
    const nextVars = collectExistingVars();
    if (!nextVars) return false;
    if (Object.prototype.hasOwnProperty.call(nextVars, k)) {
      setStatus(`Duplicate key: ${k}`, 'error');
      return false;
    }
    nextVars[k] = draft.value;
    vars = nextVars;
    draft = { key: '', value: '' };
    render();
    if (immediate) flushSave(nextVars);
    else scheduleSave(nextVars, 0);
    return true;
  }

  function render() {
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;">
        <p style="font-size:13px;color:var(--tp-fg-muted);margin:0;">
          Injected as env vars for every run.
          Use <code>AWS_*</code> / <code>TF_VAR_*</code> for credentials.
          <span style="color:var(--tp-warning);display:inline-flex;align-items:center;gap:3px;">${icon('lock',11)} Secret values are masked.</span>
        </p>
        <div id="tofu-vars-status" style="flex-shrink:0;font-size:12px;color:var(--tp-fg-muted);">
          Changes save automatically.
        </div>
      </div>
      <div id="tofu-var-list">${renderVarRows(vars)}</div>
    `;

    document.getElementById('tofu-new-key').value = draft.key;
    document.getElementById('tofu-new-val').value = draft.value;

    el.querySelectorAll('.var-toggle-vis').forEach(toggleBtn => {
      toggleBtn.addEventListener('click', () => {
        const input = toggleBtn.previousElementSibling;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        toggleBtn.querySelector('.vis-icon').innerHTML = isHidden ? icon('eyeSlash',13) : icon('eye',13);
      });
    });

    el.querySelectorAll('.var-delete').forEach(deleteBtn => {
      deleteBtn.addEventListener('click', () => {
        draft = getDraftState();
        const nextVars = collectExistingVars();
        if (!nextVars) return;
        const row = deleteBtn.closest('.tofu-var-row');
        const k = row.querySelector('.var-key').value.trim();
        delete nextVars[k];
        vars = nextVars;
        render();
        flushSave(nextVars);
      });
    });

    el.querySelectorAll('.tofu-var-row[data-draft="false"]').forEach(row => {
      const onInput = () => {
        draft = getDraftState();
        const nextVars = collectExistingVars();
        if (!nextVars) return;
        scheduleSave(nextVars);
      };
      row.querySelector('.var-key')?.addEventListener('input', onInput);
      row.querySelector('.var-val')?.addEventListener('input', onInput);
      row.addEventListener('focusout', () => {
        window.setTimeout(() => {
          if (row.contains(document.activeElement)) return;
          draft = getDraftState();
          const nextVars = collectExistingVars();
          if (!nextVars) return;
          if (!row.querySelector('.var-key')?.value.trim()) {
            vars = nextVars;
            render();
            flushSave(nextVars);
            return;
          }
          flushSave(nextVars);
        }, 0);
      });
    });

    const draftKey = document.getElementById('tofu-new-key');
    const draftVal = document.getElementById('tofu-new-val');
    const draftRow = el.querySelector('.tofu-var-draft');
    [draftKey, draftVal].forEach(input => {
      input?.addEventListener('input', () => {
        draft = getDraftState();
        setStatus(draft.key.trim() ? 'Press Enter or leave to create.' : 'Changes save automatically.', 'muted');
      });
      input?.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commitDraftAndSave(true);
      });
    });
    draftRow?.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (draftRow.contains(document.activeElement)) return;
        commitDraftAndSave(true);
      }, 0);
    });
  }

  render();
}

function parseEnvBlock(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

// ── Sub-tab: Files ────────────────────────────────────────────────────────
async function loadFilesTab(el, ws) {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start;">
      <div class="tp-card" id="tofu-file-tree-panel">
        <div class="tp-card-header">
          <div class="tp-card-title">${icon('folder',14)} Files</div>
          <div class="tp-card-actions">
            ${btn('secondary sm icon', 'tofu-btn-generate-output', icon('wand',12), 'title="Generate shipyard_servers output"')}
            ${btn('secondary sm icon', 'tofu-btn-new-file', icon('plus',12), 'title="New file"')}
            ${btn('secondary sm icon', 'tofu-btn-reload-tree', icon('rotate',12), 'title="Reload"')}
          </div>
        </div>
        <div id="tofu-tree-content" style="padding:4px 0;">
          <div class="tp-loading"><div class="tp-spinner"></div></div>
        </div>
      </div>
      <div class="tp-card" id="tofu-file-editor-panel">
        <div class="tp-empty">
          ${icon('fileCode', 40)}
          <p>Select a file to edit</p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('tofu-btn-reload-tree').addEventListener('click', () => loadFileTree(ws));
  document.getElementById('tofu-btn-new-file').addEventListener('click', () => newFileDialog(ws));
  document.getElementById('tofu-btn-generate-output').addEventListener('click', async () => {
    const genBtn = document.getElementById('tofu-btn-generate-output');
    if (!genBtn) return;
    if (_openFile?.path === 'outputs.tf' && _openFile?.dirty) {
      const discard = await _showConfirm('Discard unsaved changes in outputs.tf and regenerate the Shipyard output block?', {
        title: 'Regenerate outputs.tf',
        confirmText: 'Regenerate',
        danger: true,
      });
      if (!discard) return;
    }
    genBtn.disabled = true;
    try {
      const result = await _pluginApi.request(`/workspaces/${ws.id}/generate-shipyard-output`, { method: 'POST' });
      await loadFileTree(ws);
      await openFileEditor(ws, 'outputs.tf');
      _showToast(`Generated shipyard_servers output for ${result.resources.length} resource(s).`, 'success');
    } catch (e) {
      _showToast(e.message, 'error');
    } finally {
      genBtn.disabled = false;
    }
  });

  await loadFileTree(ws);
}

async function loadFileTree(ws) {
  const el = document.getElementById('tofu-tree-content');
  if (!el) return;
  try {
    const { tree } = await _pluginApi.request(`/workspaces/${ws.id}/files`);
    _fileTree = tree;
    el.innerHTML = renderTree(tree, ws);
    bindTreeEvents(ws);
  } catch (e) {
    el.innerHTML = `<p style="padding:12px;color:var(--tp-danger);font-size:12px;">${esc(e.message)}</p>`;
  }
}

function renderTree(nodes, ws, depth = 0) {
  if (!nodes || nodes.length === 0) return `<div style="padding:8px 12px;font-size:12px;color:var(--tp-fg-muted);">Empty directory</div>`;
  return nodes.map(node => {
    const indent = depth * 14;
    if (node.type === 'dir') {
      return `
        <div class="tp-tree-item" data-path="${esc(node.path)}"
          style="padding-left:${12+indent}px;color:var(--tp-fg-muted);">
          <span style="display:flex;align-items:center;gap:5px;">${icon('folder',13)} ${esc(node.name)}</span>
        </div>
        <div class="tofu-dir-children" data-dir="${esc(node.path)}">
          ${renderTree(node.children, ws, depth + 1)}
        </div>`;
    }
    const isActive = _openFile?.path === node.path;
    return `
      <div class="tp-tree-item tofu-tree-file${isActive?' active':''}" data-path="${esc(node.path)}"
        style="padding-left:${12+indent}px;">
        <span style="display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;">
          ${fileIcon(node.name)}
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(node.name)}</span>
        </span>
        ${btn('danger sm icon', '', icon('times',11), `data-delete="${esc(node.path)}" title="Delete" style="width:20px;height:20px;font-size:10px;flex-shrink:0;padding:2px;"`)}
      </div>`;
  }).join('');
}

function bindTreeEvents(ws) {
  document.querySelectorAll('.tofu-tree-file').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('[data-delete]')) return;
      openFileEditor(ws, item.dataset.path);
    });
  });
  document.querySelectorAll('[data-delete]').forEach(delBtn => {
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!await _showConfirm(`Delete "${delBtn.dataset.delete}"?`, { title:'Delete', confirmText:'Delete', danger:true })) return;
      try {
        await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(delBtn.dataset.delete)}`, { method:'DELETE' });
        if (_openFile?.path === delBtn.dataset.delete) { _openFile = null; }
        await loadFileTree(ws);
      } catch (e2) { _showToast(e2.message, 'error'); }
    });
  });
}

async function openFileEditor(ws, relPath) {
  if (_openFile?.dirty) {
    if (!await _showConfirm('Discard unsaved changes?', { title:'Discard', confirmText:'Discard', danger:true })) return;
  }
  const editorPanel = document.getElementById('tofu-file-editor-panel');
  if (!editorPanel) return;
  editorPanel.innerHTML = `<div class="tp-loading"><div class="tp-spinner"></div></div>`;
  try {
    const { content } = await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(relPath)}`);
    _openFile = { path: relPath, content, dirty: false };
    editorPanel.innerHTML = `
      <div class="tp-card-header">
        <div class="tp-card-title">
          ${fileIcon(relPath)}
          <span>${esc(relPath.split('/').pop())}</span>
        </div>
        <div class="tp-card-actions">
          ${btn('primary sm', 'tofu-btn-save-file', icon('save',12)+' Save', 'disabled')}
        </div>
      </div>
      <textarea id="tofu-file-content" class="tp-input tp-input-mono"
        style="min-height:420px;resize:vertical;border:none;border-top:1px solid var(--tp-border);
               border-radius:0 0 var(--tp-radius) var(--tp-radius);font-size:12px;line-height:1.6;
               display:block;width:100%;box-sizing:border-box;padding:12px 14px;"
      >${esc(content)}</textarea>
    `;
    const textarea = document.getElementById('tofu-file-content');
    const saveBtn  = document.getElementById('tofu-btn-save-file');
    textarea.addEventListener('input', () => {
      _openFile.dirty = textarea.value !== _openFile.content;
      saveBtn.disabled = !_openFile.dirty;
    });
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = textarea.selectionStart;
        textarea.value = textarea.value.slice(0,s)+'  '+textarea.value.slice(textarea.selectionEnd);
        textarea.selectionStart = textarea.selectionEnd = s+2;
        textarea.dispatchEvent(new Event('input'));
      }
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(relPath)}`, {
          method: 'PUT', body: JSON.stringify({ content: textarea.value }),
        });
        _openFile.content = textarea.value;
        _openFile.dirty = false;
        _showToast('Saved', 'success');
      } catch (e3) { _showToast(e3.message, 'error'); saveBtn.disabled = false; }
    });
    document.querySelectorAll('.tofu-tree-file').forEach(item => {
      item.classList.toggle('active', item.dataset.path === relPath);
    });
  } catch (e) {
    editorPanel.innerHTML = `<p style="padding:16px;color:var(--tp-danger);">${esc(e.message)}</p>`;
  }
}

function newFileDialog(ws) {
  showModal(`
    <h2>${icon('plus',15)} New File</h2>
    <div class="tp-form-group">
      <label class="tp-label">Filename</label>
      <input class="tp-input tp-input-mono" id="new-file-name" placeholder="main.tf" autofocus>
    </div>
    <div class="tp-form-actions">
      ${btn('secondary', 'new-file-cancel', 'Cancel')}
      ${btn('primary', 'new-file-create', 'Create')}
    </div>
  `, { maxWidth: '400px', onReady: () => {
    document.getElementById('new-file-cancel').addEventListener('click', closeModal);
    document.getElementById('new-file-create').addEventListener('click', async () => {
      const name = document.getElementById('new-file-name').value.trim();
      if (!name) return;
      try {
        await _pluginApi.request(`/workspaces/${ws.id}/file`, { method:'POST', body: JSON.stringify({ path: name }) });
        closeModal();
        await loadFileTree(ws);
        await openFileEditor(ws, name);
      } catch (e) { _showToast(e.message, 'error'); }
    });
  }});
}

// ── Sub-tab: Resources ────────────────────────────────────────────────────
async function loadResourcesTab(el, ws) {
  el.innerHTML = `<div class="tp-loading"><div class="tp-spinner"></div></div>`;
  try {
    const { resources, error } = await _pluginApi.request(`/workspaces/${ws.id}/state`);
    if (error && (!resources || resources.length === 0)) {
      el.innerHTML = `
        <p style="color:var(--tp-fg-muted);font-size:13px;margin:0 0 8px;">No state found or state is empty.</p>
        ${error ? `<details><summary style="font-size:12px;cursor:pointer;color:var(--tp-fg-muted);">Details</summary>${preBlock(error)}</details>` : ''}`;
      return;
    }
    el.innerHTML = `
      <div style="font-size:12px;color:var(--tp-fg-muted);margin-bottom:10px;">
        ${resources.length} resource${resources.length !== 1 ? 's' : ''}
      </div>
      <table class="tp-table">
        <thead><tr><th>Type</th><th>Name</th><th>Address</th></tr></thead>
        <tbody>
          ${resources.map(r => `
            <tr>
              <td class="tp-mono" style="font-size:12px;color:var(--tp-fg-muted);">${esc(r.type)}</td>
              <td style="font-size:13px;">${esc(r.name)}</td>
              <td class="tp-mono" style="font-size:11px;color:var(--tp-fg-muted);">${esc(r.address)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--tp-danger);font-size:13px;">${esc(e.message)}</p>`;
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────
let _modalOverlay = null;

function showModal(innerHTML, { maxWidth = '520px', onReady } = {}) {
  // Try to use old frontend's modal-overlay if it exists
  const legacyOverlay = document.getElementById('modal-overlay');
  if (legacyOverlay) {
    legacyOverlay.classList.remove('hidden');
    legacyOverlay.innerHTML = `<div class="modal tp-modal-legacy" style="max-width:${maxWidth};width:95%;">${innerHTML}</div>`;
    legacyOverlay.addEventListener('click', e => {
      if (e.target === legacyOverlay) { legacyOverlay.classList.add('hidden'); legacyOverlay.innerHTML = ''; }
    }, { once: true });
    if (onReady) onReady();
    return;
  }

  // New frontend: create our own overlay inside the plugin container
  if (_modalOverlay) _modalOverlay.remove();
  _modalOverlay = document.createElement('div');
  _modalOverlay.className = 'tp-overlay';
  _modalOverlay.innerHTML = `<div class="tp-modal" style="max-width:${maxWidth};">${innerHTML}</div>`;
  _modalOverlay.addEventListener('click', e => { if (e.target === _modalOverlay) closeModal(); });
  (_container || document.body).appendChild(_modalOverlay);
  if (onReady) onReady();
}

function closeModal() {
  const legacyOverlay = document.getElementById('modal-overlay');
  if (legacyOverlay && !legacyOverlay.classList.contains('hidden')) {
    legacyOverlay.classList.add('hidden');
    legacyOverlay.innerHTML = '';
    return;
  }
  if (_modalOverlay) { _modalOverlay.remove(); _modalOverlay = null; }
}

// ── Workspace Modal ───────────────────────────────────────────────────────
function openWorkspaceModal(ws) {
  const vars = ws?.env_vars || {};
  const envLines = Object.entries(vars).map(([k,v]) => `${k}=${v}`).join('\n');
  const pathSection = ws ? `
    <div class="tp-form-group">
      <label class="tp-label">Path</label>
      <input class="tp-input tp-input-mono" id="ws-path" value="${esc(ws.path)}" required>
    </div>
    <div class="tp-form-group" id="ws-move-files-group" style="display:none;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;font-size:13px;">
        <input type="checkbox" id="ws-move-files" style="width:16px;height:16px;" checked>
        Move existing workspace files to the new path
      </label>
      <div class="tp-form-hint">Moves your current workspace files and state to the new location.</div>
    </div>` : `<input type="hidden" id="ws-path" value="">`;
  const scaffoldSection = !ws ? `
    <div class="tp-form-group" style="border-top:1px solid var(--tp-border);padding-top:14px;margin-top:4px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;font-size:13px;">
        <input type="checkbox" id="ws-scaffold" style="width:16px;height:16px;">
        Initialize with starter files
      </label>
      <div id="ws-scaffold-opts" style="display:none;margin-top:10px;">
        <label class="tp-label">Provider template</label>
        <select class="tp-input tp-select" id="ws-provider" style="max-width:240px;">
          <option value="">None (blank files)</option>
          <option value="aws">AWS</option>
          <option value="azurerm">Azure</option>
          <option value="google">Google Cloud</option>
          <option value="hcloud">Hetzner Cloud</option>
          <option value="digitalocean">DigitalOcean</option>
          <option value="kubernetes">Kubernetes</option>
          <option value="proxmox">Proxmox (bpg/proxmox)</option>
        </select>
        <div class="tp-form-hint">Creates main.tf, variables.tf, outputs.tf and (if selected) providers.tf</div>
      </div>
    </div>` : '';

  showModal(`
    <h2>${ws ? icon('pen',15)+' Edit Workspace' : icon('plus',15)+' New Workspace'}</h2>
    <div class="tp-form-group">
      <label class="tp-label">Name</label>
      <input class="tp-input" id="ws-name" value="${esc(ws?.name||'')}" placeholder="production" required>
    </div>
    ${pathSection}
    <div class="tp-form-group">
      <label class="tp-label">Description (optional)</label>
      <input class="tp-input" id="ws-desc" value="${esc(ws?.description||'')}" placeholder="Production infrastructure">
    </div>
    <div class="tp-form-group">
      <label class="tp-label">Environment Variables</label>
      <textarea class="tp-input tp-input-mono" id="ws-env"
        style="min-height:100px;resize:vertical;font-size:12px;"
        placeholder="AWS_ACCESS_KEY_ID=AKIA...\nTF_VAR_region=eu-central-1"
      >${esc(envLines)}</textarea>
    </div>
    ${scaffoldSection}
    <div class="tp-form-actions">
      ${btn('secondary', 'ws-cancel', 'Cancel')}
      ${btn('primary', 'ws-save', ws ? 'Save' : 'Create')}
    </div>
  `, { maxWidth: '520px', onReady: () => {
    document.getElementById('ws-cancel').addEventListener('click', closeModal);

    if (!ws) {
      const nameEl = document.getElementById('ws-name');
      const pathEl = document.getElementById('ws-path');
      let pathTouched = false;
      pathEl.addEventListener('input', () => { pathTouched = true; });
      nameEl.addEventListener('input', () => {
        if (pathTouched) return;
        const slug = nameEl.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        pathEl.value = slug ? `/workspaces/${slug}` : '';
      });
    }

    if (ws) {
      const pathEl = document.getElementById('ws-path');
      const moveGroupEl = document.getElementById('ws-move-files-group');
      const toggleMoveHint = () => {
        if (!pathEl || !moveGroupEl) return;
        moveGroupEl.style.display = pathEl.value.trim() !== ws.path ? 'block' : 'none';
      };
      pathEl?.addEventListener('input', toggleMoveHint);
      toggleMoveHint();
    }

    document.getElementById('ws-scaffold')?.addEventListener('change', e => {
      document.getElementById('ws-scaffold-opts').style.display = e.target.checked ? 'block' : 'none';
    });

    document.getElementById('ws-save').addEventListener('click', async () => {
      const name    = document.getElementById('ws-name').value.trim();
      const wPath   = document.getElementById('ws-path').value.trim();
      const desc    = document.getElementById('ws-desc').value.trim();
      const env_vars = parseEnvBlock(document.getElementById('ws-env').value);
      if (!name || !wPath) { _showToast('Name and path are required', 'error'); return; }
      const scaffoldEl = document.getElementById('ws-scaffold');
      const scaffold = scaffoldEl?.checked
        ? { provider: document.getElementById('ws-provider').value || null }
        : null;
      const saveBtn = document.getElementById('ws-save');
      saveBtn.disabled = true;
      try {
        if (ws) {
          const moveFiles = document.getElementById('ws-move-files-group')?.style.display !== 'none'
            ? !!document.getElementById('ws-move-files')?.checked
            : false;
          await _pluginApi.request(`/workspaces/${ws.id}`, {
            method: 'PUT', body: JSON.stringify({ name, path: wPath, description: desc, env_vars, move_files: moveFiles }),
          });
        } else {
          const { id } = await _pluginApi.request('/workspaces', {
            method: 'POST', body: JSON.stringify({ name, path: wPath, description: desc, env_vars, scaffold }),
          });
          _selected = id;
          _mainTab  = 'workspaces';
          _wsTab    = 'runs';
        }
        _workspaces = await _pluginApi.request('/workspaces');
        closeModal();
        renderApp();
      } catch (e) {
        _showToast(e.message, 'error');
        saveBtn.disabled = false;
      }
    });
  }});
}
