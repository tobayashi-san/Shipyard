import { renderSidebar } from '../components/sidebar.js';
import { renderDashboard, refreshDashboardData } from '../views/dashboard.js';
import { loadUpdates, loadHistory } from '../views/server-detail.js';
import { setupComposeModal } from '../modals/compose-modal.js';
import { renderLogin } from '../views/login.js';
import { renderOnboarding } from '../views/onboarding.js';
import { refreshServersInPlace } from '../views/servers.js';
import { initWebSocket, closeWebSocket, onWsMessage, onWsUnauthorized } from '../websocket.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { appendGlobalTerminal, setupGlobalTerminal } from '../terminal/global-terminal.js';
import { state, normalizeServer, setStateDependencies } from './state.js';
import { render } from './router.js';

let wsUnsub = null;
let unauthorizedHandlerBound = false;
let mobileSidebarBound = false;

function setMobileSidebarOpen(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  const button = document.getElementById('mobile-menu-btn');
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  if (!sidebar || !overlay || !button) return;

  const shouldOpen = isMobile && open;
  sidebar.classList.toggle('mobile-open', shouldOpen);
  overlay.classList.toggle('mobile-open', shouldOpen);
  overlay.classList.toggle('hidden', !shouldOpen);
  button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  button.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
}

function bindMobileSidebar() {
  if (mobileSidebarBound) return;

  const button = document.getElementById('mobile-menu-btn');
  const overlay = document.getElementById('mobile-overlay');
  if (!button || !overlay) return;

  mobileSidebarBound = true;

  button.addEventListener('click', () => {
    const isOpen = document.getElementById('sidebar')?.classList.contains('mobile-open');
    setMobileSidebarOpen(!isOpen);
  });

  overlay.addEventListener('click', () => setMobileSidebarOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMobileSidebarOpen(false);
  });

  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 768px)').matches) {
      setMobileSidebarOpen(false);
    }
  });
}

setStateDependencies({
  refreshServers: () => api.getServers(),
  renderSidebar,
  refreshDashboardData,
  refreshServersInPlace,
});

function renderBootError(error) {
  document.body.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Shipyard</h1>
        <p style="margin-top:10px;color:var(--offline);">Failed to reach backend API.</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:6px;">${String(error?.message ?? error)}</p>
        <button id="retry-boot" class="btn-primary" style="margin-top:14px;">Retry</button>
      </div>
    </div>`;
  document.getElementById('retry-boot')?.addEventListener('click', () => location.reload());
}

function ensureHttpWarningBanner() {
  if (location.protocol !== 'http:' || ['localhost', '127.0.0.1'].includes(location.hostname)) return;
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

function handleUnauthorized() {
  closeWebSocket();
  renderLogin(boot);
}

function bindUnauthorizedHandlers() {
  if (unauthorizedHandlerBound) return;
  api.onUnauthorized(handleUnauthorized);
  onWsUnauthorized(handleUnauthorized);
  unauthorizedHandlerBound = true;
}

function bindWebSocketTerminal() {
  if (wsUnsub) {
    wsUnsub();
    wsUnsub = null;
  }
  wsUnsub = onWsMessage((msg) => {
    if (msg.type === 'update_output' || msg.type === 'compose_output' ||
        msg.type === 'ansible_output' || msg.type === 'bulk_update_output') {
      appendGlobalTerminal(msg.data, msg.stream === 'stderr' ? 'stderr' : 'stdout');
    } else if (msg.type === 'update_complete' || msg.type === 'ansible_complete' ||
               msg.type === 'bulk_update_complete') {
      appendGlobalTerminal(msg.success ? t('ws.completed') : t('ws.failed'), msg.success ? 'success' : 'stderr');
      if (state.currentView === 'server-detail' && state.selectedServerId) {
        loadUpdates(state.selectedServerId);
        loadHistory(state.selectedServerId);
      }
    } else if (msg.type === 'update_error' || msg.type === 'compose_error' ||
               msg.type === 'ansible_error' || msg.type === 'bulk_update_error') {
      appendGlobalTerminal(t('ws.error', { msg: msg.error || msg.message }), 'stderr');
    } else if (msg.type === 'cache_updated') {
      if (msg.scope !== 'info') return;
      if (state.currentView === 'server-detail') return;
      if (state.currentView === 'dashboard') {
        refreshDashboardData();
      } else if (state.currentView === 'servers') {
        refreshServersInPlace();
      }
    }
  });
}

export async function boot() {
  setupComposeModal();
  bindMobileSidebar();
  document.documentElement.dataset.density = localStorage.getItem('shipyard_density') || 'cozy';
  setupGlobalTerminal();
  ensureHttpWarningBanner();

  let authStatus;
  try {
    authStatus = await api.getAuthStatus();
  } catch (e) {
    console.error('Failed to load auth status:', e);
    renderBootError(e);
    return;
  }

  if (!authStatus.configured && !authStatus.onboardingDone) {
    await renderOnboarding();
    return;
  }

  if (!authStatus.configured || !api.getToken()) {
    await renderLogin(boot);
    return;
  }

  bindUnauthorizedHandlers();

  try {
    const [servers, plugins, profile] = await Promise.all([
      api.getServers(),
      api.getPlugins().catch(() => []),
      api.getProfile().catch(() => null),
    ]);
    state.user = profile;
    if (profile?.role === 'admin') {
      try { state.whiteLabel = await api.getSettings(); } catch {}
    }
    state.servers = servers.map(normalizeServer);
    state.plugins = plugins;
  } catch (e) {
    console.error('Failed to load initial data:', e);
  }

  initWebSocket();
  bindWebSocketTerminal();
  render();
}
