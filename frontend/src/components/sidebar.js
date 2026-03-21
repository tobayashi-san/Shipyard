import { state, navigate } from '../main.js';
import { showRunPlaybookModal } from './run-playbook-modal.js';
import { t, setLang, getLang } from '../i18n.js';

export function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const onlineCount = state.servers.filter(s => s.status === 'online').length;
  const currentLang = getLang();

  // Plugins that are enabled and have a sidebar entry
  const sidebarPlugins = (state.plugins || []).filter(p => p.enabled && p.sidebar);

  const pluginsSection = sidebarPlugins.length > 0 ? `
    <div class="nav-section">
      <div class="nav-section-title">${t('nav.plugins')}</div>
      ${sidebarPlugins.map(p => `
        <div class="nav-item ${state.currentView === 'plugin' && state.currentPluginId === p.id ? 'active' : ''}"
             data-view="plugin" data-plugin-id="${p.id}">
          <span class="nav-item-icon"><i class="${p.sidebar.icon || 'fas fa-puzzle-piece'}"></i></span>
          <span>${p.sidebar.label || p.name}</span>
        </div>
      `).join('')}
    </div>` : '';

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo-icon"><i class="fas fa-ship"></i></div>
      <div class="sidebar-logo-text">
        <h1>${state.whiteLabel?.appName || 'Shipyard'}</h1>
        <span>${state.whiteLabel?.appTagline || 'Infrastructure'}</span>
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
        <div class="nav-item ${state.currentView === 'settings' ? 'active' : ''}" data-view="settings">
          <span class="nav-item-icon"><i class="fas fa-cog"></i></span>
          <span>${t('nav.settings')}</span>
        </div>
      </div>
      ${pluginsSection}
    </nav>

    <div class="sidebar-footer">
      <div class="sidebar-footer-info">
        <div class="sidebar-footer-dot"></div>
        <span>${t('nav.serverCount', { online: onlineCount })}</span>
      </div>
      <div class="sidebar-lang-toggle" style="display:flex;gap:4px;margin-top:8px;">
        <button class="btn btn-sm ${currentLang === 'de' ? 'btn-primary' : 'btn-secondary'}" id="lang-de" style="min-width:36px;padding:2px 6px;font-size:11px;">DE</button>
        <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-secondary'}" id="lang-en" style="min-width:36px;padding:2px 6px;font-size:11px;">EN</button>
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

  document.getElementById('lang-de')?.addEventListener('click', () => {
    setLang('de');
    navigate(state.currentView, state.selectedServerId ? { serverId: state.selectedServerId } : {});
  });

  document.getElementById('lang-en')?.addEventListener('click', () => {
    setLang('en');
    navigate(state.currentView, state.selectedServerId ? { serverId: state.selectedServerId } : {});
  });
}
