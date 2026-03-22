import { state, navigate } from '../main.js';
import { showRunPlaybookModal } from './run-playbook-modal.js';
import { showProfileMenu } from './profile.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const perms = state.user?.permissions;
  const onlineCount = state.servers.filter(s => s.status === 'online').length;
  // Plugins that are enabled, have a sidebar entry, and user has permission
  const allSidebarPlugins = (state.plugins || []).filter(p => p.enabled && p.sidebar);
  const sidebarPlugins = (!perms || perms.full || perms.plugins === 'all')
    ? allSidebarPlugins
    : allSidebarPlugins.filter(p => Array.isArray(perms.plugins) && perms.plugins.includes(p.id));

  const pluginsSection = sidebarPlugins.length > 0 ? `
    <div class="nav-section">
      <div class="nav-section-title">${t('nav.plugins')}</div>
      ${sidebarPlugins.map(p => `
        <div class="nav-item ${state.currentView === 'plugin' && state.currentPluginId === p.id ? 'active' : ''}"
             data-view="plugin" data-plugin-id="${p.id}">
          <span class="nav-item-icon"><i class="${esc(p.sidebar.icon || 'fas fa-puzzle-piece')}"></i></span>
          <span>${esc(p.sidebar.label || p.name)}</span>
        </div>
      `).join('')}
    </div>` : '';

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo-icon"><i class="fas fa-ship"></i></div>
      <div class="sidebar-logo-text">
        <h1>${esc(state.whiteLabel?.appName || 'Shipyard')}</h1>
        <span>${esc(state.whiteLabel?.appTagline || 'Infrastructure')}</span>
      </div>
    </div>

    <nav class="sidebar-nav">
      <div class="nav-section">
        <div class="nav-section-title">${t('nav.main')}</div>
        <div class="nav-item ${state.currentView === 'dashboard' ? 'active' : ''}" data-view="dashboard">
          <span class="nav-item-icon"><i class="fas fa-th-large"></i></span>
          <span>${t('nav.dashboard')}</span>
        </div>
        <div class="nav-item ${state.currentView === 'servers' || state.currentView === 'server-detail' ? 'active' : ''}" data-view="servers">
          <span class="nav-item-icon"><i class="fas fa-server"></i></span>
          <span>${t('nav.servers')}</span>
          ${onlineCount > 0 ? `<span class="nav-item-badge">${onlineCount}</span>` : ''}
        </div>
        <div class="nav-item ${state.currentView === 'playbooks' ? 'active' : ''}" data-view="playbooks">
          <span class="nav-item-icon"><i class="fas fa-terminal"></i></span>
          <span>${t('nav.playbooks')}</span>
        </div>
      </div>
      ${pluginsSection}
    </nav>

    <div class="sidebar-bottom-nav">
      ${state.user?.role === 'admin' ? `
      <div class="nav-item ${state.currentView === 'settings' ? 'active' : ''}" data-view="settings">
        <span class="nav-item-icon"><i class="fas fa-cog"></i></span>
        <span>${t('nav.settings')}</span>
      </div>` : ''}
      <div class="nav-item" id="sidebar-profile-btn">
        <span class="nav-item-icon"><i class="fas fa-user-circle"></i></span>
        <span>${esc(state.user?.username || 'Profile')}</span>
      </div>
    </div>

    <div class="sidebar-footer">
      <div class="sidebar-footer-info">
        <div class="sidebar-footer-dot"></div>
        <span>${t('nav.serverCount', { online: onlineCount })}</span>
      </div>
    </div>
  `;

  sidebar.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view     = item.dataset.view;
      const pluginId = item.dataset.pluginId;
      if (view) navigate(view, { serverId: item.dataset.serverId, pluginId });
    });
  });

  document.getElementById('sidebar-profile-btn')?.addEventListener('click', () => showProfileMenu());

}
