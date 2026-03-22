import { renderSidebar } from './components/sidebar.js';
import { renderDashboard, refreshDashboardData } from './components/dashboard.js';
import { renderServerDetail } from './components/server-detail.js';
import { renderSettings, applyWhiteLabel } from './components/settings.js';
import { renderPlaybooks } from './components/playbooks.js';
import { renderServers, refreshServersInPlace } from './components/servers.js';
import { initWebSocket, onWsMessage } from './websocket.js';
import { setupComposeModal } from './components/compose-modal.js';
import { renderLogin } from './components/login.js';
import { renderOnboarding } from './components/onboarding.js';
import { renderPlugin, cleanupPlugin } from './plugins.js';
import { api } from './api.js';
import { t } from './i18n.js';

// Track active WS message listener so it can be removed on re-boot
let _wsUnsub = null;

// State
export const state = {
  currentView: 'dashboard',
  selectedServerId: null,
  currentPluginId: null,
  servers: [],
  plugins: [],
  ws: null,
  whiteLabel: {},
  user: null, // { id, username, email, role }
};

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
      renderServers();
      break;
    case 'server-detail':
      renderServerDetail(state.selectedServerId);
      break;
    case 'playbooks':
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
  applyWhiteLabel();
  setupGlobalTerminal();

  // Check auth
  const authStatus = await api.getAuthStatus();

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

  // Redirect to login on any 401
  api.onUnauthorized(() => renderLogin(boot));

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
    state.servers = servers.map(s => ({
      ...s,
      services: typeof s.services === 'string' ? JSON.parse(s.services) : s.services || [],
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags) : s.tags || [],
    }));
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
  banner.innerHTML = '<i class="fas fa-lock-open"></i> <strong>Insecure connection:</strong> Use HTTPS to protect passwords and tokens. &nbsp;<button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;">Dismiss</button>';
  document.body.prepend(banner);
}

// Wait for all external stylesheets (Font Awesome, Google Fonts) to load
// before booting to prevent flash of unstyled content.
if (document.readyState === 'complete') {
  boot();
} else {
  window.addEventListener('load', boot);
}
