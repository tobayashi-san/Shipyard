import { renderSidebar } from '../components/sidebar.js';
import { renderDashboard } from '../views/dashboard.js';
import { renderServerDetail } from '../views/server-detail.js';
import { renderSettings, applyWhiteLabel } from '../views/settings.js';
import { renderPlaybooks } from '../views/playbooks.js';
import { renderServers } from '../views/servers.js';
import { renderPlugin, cleanupPlugin } from '../plugins.js';
import { state, hasCap } from './state.js';

export function navigate(view, params = {}) {
  if (view === 'server-detail' && state.currentView !== 'server-detail') {
    state.previousView = state.currentView;
  } else if (view !== 'server-detail' && state.currentView !== view) {
    state.previousView = null;
  }

  if (state.currentView === 'plugin' && view !== 'plugin') {
    cleanupPlugin();
  }
  state.currentView = view;
  if (params.serverId) state.selectedServerId = params.serverId;
  if (params.pluginId) state.currentPluginId = params.pluginId;
  render();

  const sb = document.getElementById('sidebar');
  const overlay = document.getElementById('mobile-overlay');
  const menuBtn = document.getElementById('mobile-menu-btn');
  if (sb) sb.classList.remove('mobile-open');
  if (overlay) {
    overlay.classList.remove('mobile-open');
    overlay.classList.add('hidden');
  }
  if (menuBtn) {
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', 'Open navigation');
  }
}

export function render() {
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
        const c = document.querySelector('.main-content');
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
