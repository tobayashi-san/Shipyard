import '@fortawesome/fontawesome-free/css/all.min.css';
import { renderSidebar } from './components/sidebar.js';
import { renderDashboard, refreshDashboardData } from './components/dashboard.js';
import { renderServerDetail, loadUpdates, loadHistory } from './components/server-detail.js';
import { renderSettings, applyWhiteLabel } from './components/settings.js';
import { renderPlaybooks } from './components/playbooks.js';
import { renderServers, refreshServersInPlace } from './components/servers.js';
import { initWebSocket, closeWebSocket, onWsMessage, onWsUnauthorized } from './websocket.js';
import { setupComposeModal } from './components/compose-modal.js';
import { renderLogin } from './components/login.js';
import { renderOnboarding } from './components/onboarding.js';
import { renderPlugin, cleanupPlugin } from './plugins.js';
import { api } from './api.js';
import { t } from './i18n.js';

// Track active WS message listener so it can be removed on re-boot
let _wsUnsub = null;
let _serversRefreshPromise = null;

// State
export function hasCap(key) {
  const p = state.user?.permissions;
  if (!p) return false;     // not loaded yet → deny until profile is known
  if (p.full) return true;  // admin
  return !!p[key];          // strict truthy check (fail-closed)
}

export const state = {
  currentView: 'dashboard',
  selectedServerId: null,
  currentPluginId: null,
  servers: [],
  plugins: [],
  ws: null,
  whiteLabel: {},
  user: null, // { id, username, email, role, permissions }
};

function normalizeServer(server) {
  return {
    ...server,
    services: typeof server.services === 'string' ? JSON.parse(server.services) : server.services || [],
    tags: typeof server.tags === 'string' ? JSON.parse(server.tags) : server.tags || [],
  };
}

export async function refreshServersState({ renderCurrentView = false, reason = 'manual' } = {}) {
  if (_serversRefreshPromise) return _serversRefreshPromise;
  _serversRefreshPromise = (async () => {
    const servers = await api.getServers();
    state.servers = servers.map(normalizeServer);
    document.dispatchEvent(new CustomEvent('shipyard:servers-refreshed', {
      detail: { reason, servers: state.servers },
    }));

    if (renderCurrentView) {
      if (state.currentView === 'dashboard') {
        refreshDashboardData();
      } else if (state.currentView === 'servers') {
        await refreshServersInPlace();
      } else if (state.currentView === 'plugin') {
        renderSidebar();
      }
    } else if (state.currentView === 'plugin') {
      renderSidebar();
    }

    return state.servers;
  })();
  try {
    return await _serversRefreshPromise;
  } finally {
    _serversRefreshPromise = null;
  }
}

// Router
export function navigate(view, params = {}) {
  // Cleanup plugin when leaving a plugin view
  if (state.currentView === 'plugin' && view !== 'plugin') {
    cleanupPlugin();
  }
  state.currentView = view;
  if (params.serverId)  state.selectedServerId  = params.serverId;
  if (params.pluginId)  state.currentPluginId   = params.pluginId;
  render();

  // Close mobile sidebar on navigation
  const sb = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  if (sb) sb.classList.remove('mobile-open');
  if (overlay) overlay.classList.remove('mobile-open');
}

// Render
function render() {
  renderSidebar();
  applyWhiteLabel();

  switch (state.currentView) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'servers':
      if (!hasCap('canViewServers')) { renderDashboard(); return; }
      renderServers();
      break;
    case 'server-detail':
      if (!hasCap('canViewServers')) { renderDashboard(); return; }
      renderServerDetail(state.selectedServerId);
      break;
    case 'playbooks':
      if (!hasCap('canViewPlaybooks')) { renderDashboard(); return; }
      renderPlaybooks();
      break;
    case 'settings':
      if (state.user?.role !== 'admin') {
        const c = document.getElementById('main-content');
        if (c) c.innerHTML = `<div class="page-content" style="display:flex;align-items:center;justify-content:center;height:60vh;flex-direction:column;gap:12px;color:var(--text-muted);">
          <i class="fas fa-lock" style="font-size:2rem;"></i>
          <span style="font-size:15px;">Admin access required</span>
        </div>`;
        return;
      }
      renderSettings();
      break;
    case 'plugin':
      renderPlugin(state.currentPluginId);
      break;
    default:
      renderDashboard();
  }
}

// ============================================================
// Global Floating Terminal
// ============================================================
export function openGlobalTerminal(title) {
  const el = document.getElementById('global-terminal');
  const body = document.getElementById('global-terminal-body');
  const titleEl = document.getElementById('global-terminal-title');
  if (!el) return;
  if (titleEl) titleEl.textContent = title || '';
  if (body) body.innerHTML = '';
  el.style.display = '';
  // Restore body height in case it was minimized
  if (body) body.style.height = body._savedHeight || '240px';
  const toggleBtn = document.getElementById('global-terminal-toggle');
  if (toggleBtn) toggleBtn.textContent = '▼';
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function appendGlobalTerminal(text, type = 'stdout') {
  const body = document.getElementById('global-terminal-body');
  if (!body) return;
  const clean = stripAnsi(text);
  if (!clean.trim()) return;
  const line = document.createElement('div');
  line.style.cssText = type === 'stderr'
    ? 'color:#f87171;padding:1px 0;'
    : type === 'success'
    ? 'color:#4ade80;padding:1px 0;'
    : 'color:#c9d1d9;padding:1px 0;';
  line.textContent = clean;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function setupGlobalTerminal() {
  document.getElementById('global-terminal-close')?.addEventListener('click', () => {
    const el = document.getElementById('global-terminal');
    if (el) el.style.display = 'none';
  });

  document.getElementById('global-terminal-toggle')?.addEventListener('click', () => {
    const body = document.getElementById('global-terminal-body');
    const btn = document.getElementById('global-terminal-toggle');
    if (!body) return;
    if (body.style.height === '0px') {
      body.style.height = (body._savedHeight || '240px');
      body.style.padding = '12px 16px';
      if (btn) btn.textContent = '▼';
    } else {
      body._savedHeight = body.style.height || '240px';
      body.style.height = '0px';
      body.style.padding = '0';
      if (btn) btn.textContent = '▲';
    }
  });

  // Drag-to-resize
  const handle = document.getElementById('global-terminal-resize');
  const body = document.getElementById('global-terminal-body');
  if (!handle || !body) return;
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = parseInt(body.style.height) || 240;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.85, startH + delta));
    body.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
  });
}

// ============================================================
// Initialize
// ============================================================
async function boot() {
  setupComposeModal();
  document.documentElement.dataset.density = localStorage.getItem('shipyard_density') || 'cozy';
  applyWhiteLabel();
  setupGlobalTerminal();

  // Check auth
  let authStatus;
  try {
    authStatus = await api.getAuthStatus();
  } catch (e) {
    console.error('Failed to load auth status:', e);
    document.body.innerHTML = `
      <div class="login-screen">
        <div class="login-card">
          <h1>Shipyard</h1>
          <p style="margin-top:10px;color:var(--offline);">Failed to reach backend API.</p>
          <p style="font-size:12px;color:var(--text-muted);margin-top:6px;">${String(e?.message ?? e)}</p>
          <button id="retry-boot" class="btn-primary" style="margin-top:14px;">Retry</button>
        </div>
      </div>`;
    document.getElementById('retry-boot')?.addEventListener('click', () => location.reload());
    return;
  }

  // Fresh install — show onboarding wizard (includes password setup)
  if (!authStatus.configured && !authStatus.onboardingDone) {
    await renderOnboarding();
    return; // onboarding calls location.reload() at the end
  }

  // Password configured but no valid token → login
  if (!authStatus.configured || !api.getToken()) {
    await renderLogin(boot);
    return;
  }

  // Redirect to login on any 401 (HTTP) or 4001 (WebSocket); stop reconnect loop
  const handleUnauthorized = () => { closeWebSocket(); renderLogin(boot); };
  api.onUnauthorized(handleUnauthorized);
  onWsUnauthorized(handleUnauthorized);

  // Load settings, servers, and plugins in parallel
  try {
    const [servers, plugins, profile] = await Promise.all([
      api.getServers(),
      api.getPlugins().catch(() => []),
      api.getProfile().catch(() => null),
    ]);
    state.user = profile;
    // Settings (white label) only available to admins
    if (profile?.role === 'admin') {
      try { state.whiteLabel = await api.getSettings(); } catch {}
    }
    state.servers = servers.map(normalizeServer);
    state.plugins = plugins;
  } catch (e) {
    console.error('Failed to load initial data:', e);
  }

  initWebSocket();

  // Route WebSocket output messages to global terminal (remove previous listener first)
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
  _wsUnsub = onWsMessage((msg) => {
    if (msg.type === 'update_output' || msg.type === 'compose_output' ||
        msg.type === 'ansible_output' || msg.type === 'bulk_update_output') {
      appendGlobalTerminal(msg.data, msg.stream === 'stderr' ? 'stderr' : 'stdout');
    } else if (msg.type === 'update_complete' || msg.type === 'ansible_complete' ||
               msg.type === 'bulk_update_complete') {
      appendGlobalTerminal(msg.success ? t('ws.completed') : t('ws.failed'), msg.success ? 'success' : 'stderr');
      // Reload updates & history on server-detail after a run finishes
      if (state.currentView === 'server-detail' && state.selectedServerId) {
        loadUpdates(state.selectedServerId);
        loadHistory(state.selectedServerId);
      }
    } else if (msg.type === 'update_error' || msg.type === 'compose_error' ||
               msg.type === 'ansible_error' || msg.type === 'bulk_update_error') {
      appendGlobalTerminal(t('ws.error', { msg: msg.error || msg.message }), 'stderr');
    } else if (msg.type === 'cache_updated') {
      // Only refresh on system info updates (scope === 'info'), and never
      // interrupt server-detail — user might be mid-interaction there.
      if (msg.scope !== 'info') return;
      if (state.currentView === 'server-detail') return;
      if (state.currentView === 'dashboard') {
        refreshDashboardData();
      } else if (state.currentView === 'servers') {
        refreshServersInPlace();
      }
    }
  });

  render();
}

// Warn if accessed over plain HTTP from a non-local host
if (location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b91c1c;color:#fff;font-size:13px;padding:8px 16px;display:flex;align-items:center;gap:10px;';
  banner.innerHTML = '<i class="fas fa-lock-open"></i> <strong>Insecure connection:</strong> Use HTTPS to protect passwords and tokens.';
  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.cssText = 'margin-left:auto;background:none;border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;';
  dismissBtn.addEventListener('click', () => banner.remove());
  banner.appendChild(dismissBtn);
  document.body.prepend(banner);
}

// Wait for all external stylesheets (Font Awesome, Google Fonts) to load
// before booting to prevent flash of unstyled content.
if (document.readyState === 'complete') {
  boot();
} else {
  window.addEventListener('load', boot);
}
