import { state, hasCap } from '../app/state.js';
import { navigate } from '../app/router.js';
import { showRunPlaybookModal } from '../modals/run-playbook-modal.js';
import { showProfileMenu } from './profile.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const perms = state.user?.permissions;
  const onlineCount = state.servers.filter(s => s.status === 'online').length;
  const username = state.user?.username || 'profile';
  const profileName = state.user?.displayName || username;
  const profileSub = state.user?.displayName ? `@${username}` : (state.user?.role === 'admin' ? 'Admin' : 'User');
  const initials = String(profileName)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('') || 'U';
  // Plugins that are enabled, have a sidebar entry, and user has permission
  const allSidebarPlugins = (state.plugins || []).filter(p => p.enabled && p.sidebar);
  const sidebarPlugins = (!perms || perms.full || perms.plugins === 'all')
    ? allSidebarPlugins
    : allSidebarPlugins.filter(p => Array.isArray(perms.plugins) && perms.plugins.includes(p.id));
  const pluginsSection = sidebarPlugins.length > 0 ? `
    <div class="nav-section">
      <div class="nav-section-title">${t('nav.plugins')}</div>
      ${sidebarPlugins.map(p => `
        <button type="button" class="nav-item ${state.currentView === 'plugin' && state.currentPluginId === p.id ? 'active' : ''}"
             data-view="plugin" data-plugin-id="${p.id}" ${state.currentView === 'plugin' && state.currentPluginId === p.id ? 'aria-current="page"' : ''}>
          <span class="nav-item-icon"><i class="${esc(p.sidebar.icon || 'fas fa-puzzle-piece')}"></i></span>
          <span>${esc(p.sidebar.label || p.name)}</span>
        </button>
      `).join('')}
    </div>` : '';

  sidebar.innerHTML = `
    <div class="sidebar-header">
      ${state.whiteLabel?.showIcon !== false ? '<div class="sidebar-logo-icon"><i class="fas fa-ship"></i></div>' : ''}
      <div class="sidebar-logo-text">
        <h1>${esc(state.whiteLabel?.appName || 'Shipyard')}</h1>
        <span>${esc(state.whiteLabel?.appTagline || 'Infrastructure')}</span>
      </div>
    </div>

    <nav class="sidebar-nav">
      <div class="nav-section">
        <div class="nav-section-title">${t('nav.main')}</div>
        <button type="button" class="nav-item ${state.currentView === 'dashboard' ? 'active' : ''}" data-view="dashboard" ${state.currentView === 'dashboard' ? 'aria-current="page"' : ''}>
          <span class="nav-item-icon"><i class="fas fa-th-large"></i></span>
          <span>${t('nav.dashboard')}</span>
        </button>
        ${hasCap('canViewServers') ? `
        <button type="button" class="nav-item ${state.currentView === 'servers' || state.currentView === 'server-detail' ? 'active' : ''}" data-view="servers" ${state.currentView === 'servers' || state.currentView === 'server-detail' ? 'aria-current="page"' : ''}>
          <span class="nav-item-icon"><i class="fas fa-server"></i></span>
          <span>${t('nav.servers')}</span>
          ${onlineCount > 0 ? `<span class="nav-item-badge">${onlineCount}</span>` : ''}
        </button>` : ''}
        ${hasCap('canViewPlaybooks') ? `
        <button type="button" class="nav-item ${state.currentView === 'playbooks' ? 'active' : ''}" data-view="playbooks" ${state.currentView === 'playbooks' ? 'aria-current="page"' : ''}>
          <span class="nav-item-icon"><i class="fas fa-terminal"></i></span>
          <span>${t('nav.playbooks')}</span>
        </button>` : ''}
      </div>
      ${pluginsSection}
    </nav>

    <div class="sidebar-bottom-nav">
      ${state.user?.role === 'admin' ? `
      <button type="button" class="nav-item ${state.currentView === 'settings' ? 'active' : ''}" data-view="settings" ${state.currentView === 'settings' ? 'aria-current="page"' : ''}>
        <span class="nav-item-icon"><i class="fas fa-cog"></i></span>
        <span>${t('nav.settings')}</span>
      </button>` : ''}
      <button type="button" class="nav-item nav-item-profile" id="sidebar-profile-btn" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded="false">
        <span class="nav-profile-avatar">${esc(initials)}</span>
        <span class="nav-profile-meta">
          <span class="nav-profile-name">${esc(profileName)}</span>
          <span class="nav-profile-sub">${esc(profileSub)}</span>
        </span>
        <span class="nav-profile-chevron"><i class="fas fa-chevron-up"></i></span>
      </button>
    </div>

  `;

  sidebar.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      const pluginId = item.dataset.pluginId;
      if (view) navigate(view, { serverId: item.dataset.serverId, pluginId });
    });
  });

  document.getElementById('sidebar-profile-btn')?.addEventListener('click', () => showProfileMenu());

}
