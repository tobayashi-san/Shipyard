import { renderSidebar } from './components/sidebar.js';
import { renderDashboard } from './components/dashboard.js';
import { renderServerDetail } from './components/server-detail.js';
import { renderSettings, applyWhiteLabel } from './components/settings.js';
import { renderPlaybooks } from './components/playbooks.js';
import { renderServers } from './components/servers.js';
import { initWebSocket, onWsMessage } from './websocket.js';
import { setupComposeModal } from './components/compose-modal.js';
import { renderLogin } from './components/login.js';
import { renderOnboarding } from './components/onboarding.js';
import { api } from './api.js';
import { t } from './i18n.js';

// Track active WS message listener so it can be removed on re-boot
let _wsUnsub = null;

// State
export const state = {
  currentView: 'dashboard',
  selectedServerId: null,
  servers: [],
  ws: null,
  whiteLabel: {},
};

// Router
export function navigate(view, params = {}) {
  state.currentView = view;
  if (params.serverId) state.selectedServerId = params.serverId;
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
      renderSettings();
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
  if (body) body.style.height = '220px';
  const toggleBtn = document.getElementById('global-terminal-toggle');
  if (toggleBtn) toggleBtn.textContent = '▼';
}

export function appendGlobalTerminal(text, type = 'stdout') {
  const body = document.getElementById('global-terminal-body');
  if (!body) return;
  const line = document.createElement('div');
  line.style.cssText = type === 'stderr'
    ? 'color:#f87171;' // red
    : type === 'success'
    ? 'color:#4ade80;' // green
    : 'color:#c9d1d9;'; // default
  line.textContent = text;
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
      body.style.height = '220px';
      body.style.padding = '12px 16px';
      if (btn) btn.textContent = '▼';
    } else {
      body.style.height = '0px';
      body.style.padding = '0';
      if (btn) btn.textContent = '▲';
    }
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

  // Load settings + servers in parallel
  try {
    const [settings, servers] = await Promise.all([
      api.getSettings(),
      api.getServers(),
    ]);
    state.whiteLabel = settings;
    state.servers = servers.map(s => ({
      ...s,
      services: typeof s.services === 'string' ? JSON.parse(s.services) : s.services || [],
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags) : s.tags || [],
    }));
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
      // Background poller updated the cache – refresh current view silently
      if (state.currentView === 'dashboard') {
        renderDashboard();
      } else if (state.currentView === 'servers') {
        renderServers();
      }
    }
  });

  render();
}

document.addEventListener('DOMContentLoaded', boot);
