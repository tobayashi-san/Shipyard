import { api } from '../api.js';
import { state, hasCap } from '../app/state.js';
import { navigate } from '../app/router.js';
import { openGlobalTerminal } from '../terminal/global-terminal.js';
import { showToast, showConfirm } from '../components/toast.js';
import { showAddServerModal } from '../modals/add-server-modal.js';
import { openSshTerminal } from '../components/ssh-terminal.js';
import { t } from '../i18n.js';
import { formatDateTimeFull, esc } from '../utils/format.js';
import { activateDialog } from '../utils/dialog.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Docker returns CreatedAt as "2025-01-15 10:23:45 +0000 UTC" which new Date() can't parse
function parseContainerDate(d) {
  if (!d) return null;
  // Normalize: "2025-01-15 10:23:45 +0000 UTC" → "2025-01-15T10:23:45+0000"
  const cleaned = d.replace(' UTC', '').replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2');
  const date = new Date(cleaned);
  return isNaN(date.getTime()) ? null : date;
}

// Persists image update check results per server across container list refreshes
const imageUpdateMaps = {};
let _composeChangedListener = null;

function isMobileServerDetailLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function renderServerLinksMarkup(links = [], { compact = false } = {}) {
  if (!Array.isArray(links) || links.length === 0) {
    return compact ? '' : `<span class="empty-value">${t('common.none')}</span>`;
  }

  const cls = compact ? 'server-links server-links--compact' : 'server-links';
  return `
    <div class="${cls}">
      ${links.map(link => `
        <a class="server-link-chip" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">
          <span>${esc(link.name)}</span>
          <i class="fas fa-up-right-from-square"></i>
        </a>
      `).join('')}
    </div>
  `;
}

function renderQuickLinksPanel(links = []) {
  if (!Array.isArray(links) || links.length === 0) return '';
  return `
    <div class="panel dash-panel quick-links-panel">
      <div class="dash-panel-header">
        <div class="dash-panel-header-left">
          <div class="dash-panel-icon"><i class="fas fa-grid-2"></i></div>
          <span class="dash-panel-title">${t('det.quickLinks')}</span>
        </div>
      </div>
      <div class="quick-links-panel-body">
        ${renderServerLinksMarkup(links)}
      </div>
    </div>
  `;
}

function truncateMiddle(value, maxLength = 28) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

function loadAverageState(loadAvgText, cpuCores) {
  const firstLoad = parseFloat(String(loadAvgText || '').split(/[\s,]+/)[0]);
  if (!Number.isFinite(firstLoad) || !Number.isFinite(cpuCores) || cpuCores <= 0) {
    return { ratio: null, cls: '', label: loadAvgText || '—' };
  }

  const ratio = firstLoad / cpuCores;
  const cls = ratio >= 0.95 ? 'res-critical' : ratio >= 0.85 ? 'res-warn' : ratio >= 0.7 ? 'res-caution' : 'res-ok';
  return {
    ratio,
    cls,
    label: `${loadAvgText} (${Math.round(ratio * 100)}% of ${cpuCores}c)`,
  };
}

function renderThresholdBar(pct) {
  if (!Number.isFinite(pct)) return '<div class="progress-bar-thick progress-bar-empty"></div>';
  const safePct = Math.max(0, Math.min(100, pct));
  const cls = safePct >= 95 ? 'critical' : safePct >= 85 ? 'high' : safePct >= 70 ? 'caution' : '';
  return `
    <div class="progress-bar-thick">
      <div class="progress-threshold progress-threshold--70"></div>
      <div class="progress-threshold progress-threshold--85"></div>
      <div class="progress-threshold progress-threshold--95"></div>
      <div class="progress-bar-fill ${cls}" style="width:${safePct}%"></div>
    </div>
  `;
}

function formatUsageValue(used, total, pct) {
  const base = Number.isFinite(used) && Number.isFinite(total)
    ? `${used.toFixed(1)} / ${total.toFixed(1)} GB`
    : t('det.storageUnavailable');
  return Number.isFinite(pct) ? `${base} · ${pct}%` : base;
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message || t('common.copied'), 'success');
  } catch (error) {
    showToast(t('common.errorPrefix', { msg: error.message || 'Copy failed' }), 'error');
  }
}

// ============================================================
// Server Detail – Tab-based flat admin panel layout
// ============================================================

export async function renderServerDetail(serverId) {
  const main = document.querySelector('.main-content');
  if (!main) return;

  const server = state.servers.find(s => s.id === serverId) || await api.getServer(serverId);
  if (!server) { navigate('dashboard'); return; }

  if (_composeChangedListener) {
    document.removeEventListener('shipyard:compose-changed', _composeChangedListener);
    _composeChangedListener = null;
  }

  const dotCls = server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown';
  const statusLabel = server.status === 'online' ? t('common.online') : server.status === 'offline' ? t('common.offline') : t('common.unknown');

  main.innerHTML = `
    <div class="server-detail-page">
    <!-- Top strip -->
    <div class="page-header server-detail-header">
      <div class="server-detail-heading">
        <div class="server-detail-title-wrap">
          <nav class="breadcrumb">
            <a href="#" id="breadcrumb-back">${t('srv.title')}</a>
            <i class="fas fa-chevron-right breadcrumb-sep"></i>
            <span class="breadcrumb-current">${esc(server.name)}</span>
          </nav>
          <h2 class="server-detail-title">
            ${esc(server.name)}
            <span class="badge badge-${server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown'}">
              <span class="status-dot ${dotCls}"></span>${statusLabel}
            </span>
          </h2>
          <p class="text-mono server-detail-subline">${esc(server.ip_address)}${server.hostname && server.hostname !== server.ip_address ? ' · ' + esc(server.hostname) : ''}</p>
        </div>
      </div>
      <div class="page-header-actions server-detail-actions">
        ${hasCap('canUseTerminal') ? `<button class="btn btn-primary btn-sm" id="btn-terminal"><i class="fas fa-terminal"></i> ${t('common.terminal')}</button>` : ''}
        ${hasCap('canEditServers') ? `<button class="btn btn-secondary btn-sm" id="btn-edit-server"><i class="fas fa-edit"></i> ${t('common.edit')}</button>` : ''}
        ${(hasCap('canUseTerminal') || hasCap('canRunUpdates') || hasCap('canRebootServers')) ? `
        <div class="action-overflow-wrap">
          <button class="action-overflow-trigger" id="btn-detail-overflow" title="${t('common.actions')}"><i class="fas fa-ellipsis-vertical"></i></button>
          <div class="action-overflow-menu" id="detail-overflow-menu">
            ${hasCap('canRunUpdates') ? `<button class="action-overflow-item" id="btn-update-server"><i class="fas fa-arrow-up"></i> ${t('det.updates')}</button>` : ''}
            ${hasCap('canUseTerminal') ? `<button class="action-overflow-item" id="btn-reset-host-key"><i class="fas fa-key"></i> ${t('srv.resetHostKey')}</button>` : ''}
            ${hasCap('canRebootServers') ? `<div class="action-overflow-sep"></div><button class="action-overflow-item action-overflow-item--danger" id="btn-reboot-server"><i class="fas fa-power-off"></i> ${t('det.reboot')}</button>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar server-detail-tab-bar">
      <button class="tab-btn active" data-tab="overview">${t('det.tabOverview')}</button>
      ${hasCap('canViewDocker') ? `<button class="tab-btn" data-tab="docker">${t('det.tabDocker')}</button>` : ''}
      ${(hasCap('canViewUpdates') || hasCap('canRunUpdates') || hasCap('canRebootServers') || hasCap('canViewCustomUpdates') || hasCap('canRunCustomUpdates') || hasCap('canEditCustomUpdates') || hasCap('canDeleteCustomUpdates')) ? `<button class="tab-btn" data-tab="updates">${t('det.tabUpdates')}</button>` : ''}
      <button class="tab-btn" data-tab="history">${t('det.tabHistory')}</button>
      ${state.user?.role === 'admin' && state.whiteLabel?.agentEnabled ? `<button class="tab-btn" data-tab="agent">${t('det.tabAgent')}</button>` : ''}
      ${hasCap('canViewNotes') ? `<button class="tab-btn" data-tab="notes">
        <i class="fas fa-sticky-note" style="margin-right:5px;"></i>${t('det.tabNotes')}
        ${server.notes?.trim() ? `<span class="nav-item-badge" style="margin-left:6px;" aria-label="${t('srv.hasNotes')}">●</span>` : ''}
      </button>` : ''}
    </div>

    <!-- Tab panels -->
    <div class="page-content server-detail-content">
      <!-- Overview tab -->
      <div class="tab-panel active" id="tab-overview">

        <!-- Stat Cards -->
        <div class="stat-cards-row">
          <div class="stat-card">
            <div class="stat-card-icon"><i class="fas fa-clock"></i></div>
            <div>
              <div class="stat-card-value" id="stat-uptime">—</div>
              <div class="stat-card-label">${t('det.uptime')}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon"><i class="fas fa-cubes"></i></div>
            <div>
              <div class="stat-card-value" id="stat-docker">—</div>
              <div class="stat-card-label">${t('det.tabDocker')}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" id="stat-updates-icon"><i class="fas fa-box-open"></i></div>
            <div>
              <div class="stat-card-value" id="stat-updates">—</div>
              <div class="stat-card-label">${t('det.tabUpdates')}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" id="stat-ping-icon"><i class="fas fa-satellite-dish"></i></div>
            <div>
              <div class="stat-card-value" id="stat-ping">—</div>
              <div class="stat-card-label">${t('det.latency')}</div>
            </div>
          </div>
        </div>

        ${renderQuickLinksPanel(server.links)}

        <!-- Main 2-col grid -->
        <div class="overview-grid">
          <!-- System Info -->
          <div class="server-detail-stack">
            <div class="panel dash-panel">
              <div class="dash-panel-header">
                <div class="dash-panel-header-left">
                  <div class="dash-panel-icon"><i class="fas fa-info-circle"></i></div>
                  <span class="dash-panel-title">${t('det.sysinfo')}</span>
                </div>
              </div>
              <table class="info-table" id="info-table">
                <tr><td>${t('det.os')}</td><td id="inf-os">—</td></tr>
                <tr><td>${t('det.kernel')}</td><td id="inf-kernel">—</td></tr>
                <tr><td>${t('det.cpu')}</td><td id="inf-cpu">—</td></tr>
                <tr><td>${t('det.cores')}</td><td id="inf-cores">—</td></tr>
                <tr><td>${t('det.loadAvg')}</td><td id="inf-load">—</td></tr>
              </table>
            </div>

          </div>

          <!-- Resources + Network -->
          <div class="server-detail-stack">
            <div class="panel dash-panel">
              <div class="dash-panel-header">
                <div class="dash-panel-header-left">
                  <div class="dash-panel-icon"><i class="fas fa-chart-bar"></i></div>
                  <span class="dash-panel-title">${t('det.resources')}</span>
                </div>
                <div class="dash-panel-header-right">
                  <button class="btn btn-icon" id="btn-refresh-info" title="${t('common.refresh')}">
                    <i class="fas fa-sync-alt"></i>
                  </button>
                </div>
              </div>
              <div id="res-content">
                <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
              </div>
            </div>

            <!-- Network Panel -->
            <div class="panel dash-panel">
              <div class="dash-panel-header">
                <div class="dash-panel-header-left">
                  <div class="dash-panel-icon"><i class="fas fa-network-wired"></i></div>
                  <span class="dash-panel-title">${t('det.network')}</span>
                </div>
              </div>
              <table class="info-table" id="network-table">
                <tr>
                  <td>${t('det.ipAddress')}</td>
                  <td>
                    <div class="network-value-row">
                      <span class="mono">${esc(server.ip_address)}</span>
                      <button type="button" class="btn btn-icon network-copy-btn" data-copy-value="${esc(server.ip_address)}" data-copy-label="${t('det.ipAddress')}" title="${t('common.copy')}">
                        <i class="fas fa-copy"></i>
                      </button>
                    </div>
                  </td>
                </tr>
                ${server.hostname ? `<tr>
                  <td>${t('det.hostname')}</td>
                  <td>
                    <div class="network-value-row">
                      <span class="mono">${esc(server.hostname)}</span>
                      <button type="button" class="btn btn-icon network-copy-btn" data-copy-value="${esc(server.hostname)}" data-copy-label="${t('det.hostname')}" title="${t('common.copy')}">
                        <i class="fas fa-copy"></i>
                      </button>
                    </div>
                  </td>
                </tr>` : ''}
                <tr><td>${t('det.sshPort')}</td><td id="net-port" class="mono">${server.ssh_port || 22}</td></tr>
                <tr><td>${t('det.sshUser')}</td><td class="mono">${esc(server.ssh_user || 'root')}</td></tr>
              </table>
            </div>
          </div>
        </div>

        <!-- Terminal output -->
        <div id="terminal-container" style="margin-top:16px;display:none;">
          <div class="terminal">
            <div class="terminal-header">
              <div class="terminal-title" id="terminal-title">${t('det.output')}</div>
            </div>
            <div class="terminal-body" id="terminal-body"></div>
          </div>
        </div>
      </div>

      <!-- Docker tab -->
      <div class="tab-panel" id="tab-docker">
        <div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-cubes"></i></div>
              <span class="dash-panel-title">${t('det.docker')}</span>
            </div>
            <div class="dash-panel-header-right">
              <button class="btn btn-icon" id="btn-refresh-docker" title="${t('common.refresh')}">
                <i class="fas fa-sync-alt"></i>
              </button>
              ${hasCap('canPullDocker') ? `<button class="btn btn-secondary btn-sm" id="btn-check-image-updates">
                <i class="fas fa-cloud-download-alt"></i> ${t('det.checkUpdates')}
              </button>` : ''}
              ${hasCap('canManageDockerCompose') ? `<button class="btn btn-primary btn-sm" id="btn-add-compose-stack">
                <i class="fas fa-plus"></i> ${t('det.newStack')}
              </button>` : ''}
            </div>
          </div>
          <div id="docker-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>

      <!-- Updates tab -->
      <div class="tab-panel" id="tab-updates">
        ${(hasCap('canViewUpdates') || hasCap('canRunUpdates')) ? `<div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-box-open"></i></div>
              <span class="dash-panel-title">${t('det.tabUpdates')}</span>
            </div>
            <div class="dash-panel-header-right">
              <button class="btn btn-icon" id="btn-refresh-updates" title="${t('common.refresh')}"><i class="fas fa-sync-alt"></i></button>
            </div>
          </div>
          <div id="updates-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>` : ''}
        ${(hasCap('canViewCustomUpdates') || hasCap('canRunCustomUpdates') || hasCap('canEditCustomUpdates') || hasCap('canDeleteCustomUpdates')) ? `<div class="panel dash-panel" style="margin-top:16px;">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-cog"></i></div>
              <span class="dash-panel-title">${t('det.customUpdates')}</span>
            </div>
            <div class="dash-panel-header-right">
              ${hasCap('canEditCustomUpdates') ? `<button class="btn btn-primary btn-sm" id="btn-add-custom-task"><i class="fas fa-plus"></i> ${t('det.addTask')}</button>` : ''}
            </div>
          </div>
          <div id="custom-updates-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>` : ''}
      </div>

      <!-- History tab -->
      <div class="tab-panel" id="tab-history">
        <div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-history"></i></div>
              <span class="dash-panel-title">${t('det.tabHistory')}</span>
            </div>
          </div>
          <div id="history-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>

      <!-- Agent tab -->
      ${state.user?.role === 'admin' && state.whiteLabel?.agentEnabled ? `<div class="tab-panel" id="tab-agent">
        <div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-robot"></i></div>
              <span class="dash-panel-title">${t('det.tabAgent')}</span>
            </div>
          </div>
          <div id="agent-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>` : ''}

      <!-- Notes tab -->
      ${hasCap('canViewNotes') ? `<div class="tab-panel" id="tab-notes">
        <div class="notes-layout">
          <div class="panel dash-panel" style="flex:1;display:flex;flex-direction:column;min-height:0;">
              <div class="dash-panel-header">
                <div class="dash-panel-header-left">
                  <div class="dash-panel-icon"><i class="fas fa-sticky-note"></i></div>
                  <span class="dash-panel-title">${t('det.tabNotes')}</span>
                </div>
                <div class="dash-panel-header-right">
                  <span class="notes-saved-indicator" id="notes-status"></span>
                  ${hasCap('canEditNotes') ? `<button class="btn btn-secondary btn-sm" id="notes-toggle-edit">
                    <i class="fas fa-edit"></i> ${t('det.notesEdit')}
                  </button>` : ''}
                </div>
              </div>
            <div class="notes-view markdown-body" id="notes-view"></div>
            <textarea
              class="notes-editor"
              id="notes-textarea"
              placeholder="${t('det.notesPlaceholder')}"
              style="display:none;"
            ></textarea>
          </div>
        </div>
      </div>` : ''}
    </div>
    </div>
  `;

  // ---- Tab switching ----
  const tabBtns = main.querySelectorAll('.tab-btn');
  const tabPanels = main.querySelectorAll('.tab-panel');

  let dockerLoaded = false;
  let updatesLoaded = false;
  let historyLoaded = false;
  let agentLoaded = false;
  let notesLoaded = false;

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');

      // Lazy load on first switch
      if (btn.dataset.tab === 'docker' && !dockerLoaded) { loadDockerContainers(serverId); dockerLoaded = true; }
      if (btn.dataset.tab === 'updates' && !updatesLoaded) { loadUpdates(serverId); updatesLoaded = true; }
      if (btn.dataset.tab === 'history' && !historyLoaded) { loadHistory(serverId); historyLoaded = true; }
      if (btn.dataset.tab === 'agent' && !agentLoaded) { loadAgentTab(serverId); agentLoaded = true; }
      if (btn.dataset.tab === 'notes' && !notesLoaded) { setupNotesTab(serverId); notesLoaded = true; }
    });
  });

  // ---- Header actions ----
  document.getElementById('breadcrumb-back')?.addEventListener('click', (e) => {
    e.preventDefault();
    const fallbackView = hasCap('canViewServers') ? 'servers' : 'dashboard';
    navigate(state.previousView || fallbackView);
  });

  main.querySelectorAll('.network-copy-btn').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copyValue || '', `${button.dataset.copyLabel || t('common.copy')} ${t('common.copied').toLowerCase()}`));
  });

  // Overflow menu toggle
  const overflowBtn = document.getElementById('btn-detail-overflow');
  const overflowMenu = document.getElementById('detail-overflow-menu');
  if (overflowBtn && overflowMenu) {
    overflowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      overflowMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => overflowMenu.classList.remove('open'));
    overflowMenu.addEventListener('click', () => overflowMenu.classList.remove('open'));
  }

  document.getElementById('btn-edit-server')?.addEventListener('click', () => {
    showAddServerModal(async (savedServer) => {
      const normalized = {
        ...(savedServer || {}),
        services: typeof savedServer?.services === 'string' ? JSON.parse(savedServer.services) : (savedServer?.services || []),
        tags: typeof savedServer?.tags === 'string' ? JSON.parse(savedServer.tags) : (savedServer?.tags || []),
      };
      const idx = state.servers.findIndex(s => s.id === serverId);
      if (idx >= 0) state.servers[idx] = { ...state.servers[idx], ...normalized };
      else if (savedServer?.id) state.servers.push(normalized);
      await renderServerDetail(serverId);
    }, server);
  });

  document.getElementById('btn-terminal')?.addEventListener('click', () => {
    openSshTerminal(server);
  });

  document.getElementById('btn-reset-host-key')?.addEventListener('click', async () => {
    if (!await showConfirm(t('srv.resetHostKeyConfirmBody'), {
      title: t('srv.resetHostKeyConfirmTitle'),
      confirmText: t('srv.resetHostKeyConfirmText'),
      danger: true,
    })) return;

    const btn = document.getElementById('btn-reset-host-key');
    btn.disabled = true;
    try {
      const result = await api.resetServerHostKey(serverId);
      const removed = Array.isArray(result.removed) && result.removed.length > 0
        ? result.removed.join(', ')
        : t('srv.resetHostKeyNoEntries');
      showToast(t('srv.resetHostKeyDone', { entries: removed }), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-update-server')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-update-server');
    if (!await showConfirm(t('det.confirmUpdate', { name: server.name }), { title: t('det.updates'), confirmText: t('det.updates') })) return;
    btn.disabled = true;
    openGlobalTerminal(`apt upgrade – ${server.name}`);
    try {
      await api.runUpdate(serverId);
      showToast(t('det.updateStarted'), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-reboot-server')?.addEventListener('click', async () => {
    if (!await showConfirm(t('det.confirmReboot', { name: server.name }), { title: t('det.reboot'), confirmText: t('det.reboot'), danger: true })) return;
    const btn = document.getElementById('btn-reboot-server');
    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('det.rebooting')}`;
    try {
      await api.runReboot(serverId);
      showToast(t('det.rebootStarted'), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  });

  // ---- Updates refresh button ----
  document.getElementById('btn-refresh-updates')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-updates');
    btn.disabled = true;
    btn.querySelector('i').classList.add('fa-spin');
    const updatesEl = document.getElementById('updates-content');
    if (updatesEl) updatesEl.innerHTML = `<div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>`;
    try {
      const [updates, customTasks] = await Promise.all([
        api.getServerUpdates(serverId, true),
        hasCap('canViewCustomUpdates') ? api.getCustomUpdateTasks(serverId) : Promise.resolve([]),
      ]);
      renderUpdatesData(updates, customTasks, serverId);
    } catch (e) {
      if (updatesEl) updatesEl.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(e.message)}</div>`;
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('i').classList.remove('fa-spin');
    }
  });

  // ---- Load Overview eagerly ----
  loadServerInfo(serverId);

  _composeChangedListener = (event) => {
    if (state.currentView !== 'server-detail' || state.selectedServerId !== serverId) return;
    if (event.detail?.serverId !== serverId) return;
    const delayMs = Math.max(0, parseInt(event.detail?.delayMs, 10) || 0);
    window.setTimeout(() => {
      if (state.currentView !== 'server-detail' || state.selectedServerId !== serverId) return;
      loadDockerContainers(serverId);
      loadServerInfo(serverId);
    }, delayMs);
  };
  document.addEventListener('shipyard:compose-changed', _composeChangedListener);
}

// ============================================================
// Overview – system info
// ============================================================
function renderServerInfo(info) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  const formatStorageGb = (value) => Number.isFinite(value) ? Number(value).toFixed(1) : null;

  set('inf-os', info.os);
  set('inf-kernel', info.kernel);
  set('inf-cpu', info.cpu);
  set('inf-cores', info.cpu_cores ? info.cpu_cores + ' ' + t('det.cores') : '—');
  const loadState = loadAverageState(info.load_avg, info.cpu_cores);
  const loadEl = document.getElementById('inf-load');
  if (loadEl) {
    loadEl.textContent = loadState.label;
    loadEl.className = loadState.cls ? `mono ${loadState.cls}` : 'mono';
  }

  // ── Stat cards ──────────────────────────────────────────────
  const uptimeStatEl = document.getElementById('stat-uptime');
  if (uptimeStatEl && info.uptime_seconds) {
    uptimeStatEl.textContent = formatUptime(info.uptime_seconds);
  }

  const resEl = document.getElementById('res-content');
  if (!resEl) return;

  const ramPct = info.ram_total_mb ? Math.round((info.ram_used_mb / info.ram_total_mb) * 100) : 0;
  const diskPct = info.disk_total_gb ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : 0;
  const cpuPct = info.cpu_usage_pct ?? null;
  const storageMountMetrics = (Array.isArray(info.storage_mount_metrics) ? info.storage_mount_metrics : []).slice()
    .sort((a, b) => (b.usage_pct ?? -1) - (a.usage_pct ?? -1));

  // RAM labels
  const ramUsedLabel = info.ram_total_mb ? (info.ram_used_mb >= 1024 ? (info.ram_used_mb / 1024).toFixed(1) + ' GB' : Math.round(info.ram_used_mb) + ' MB') : null;
  const ramTotalLabel = info.ram_total_mb ? (info.ram_total_mb >= 1024 ? (info.ram_total_mb / 1024).toFixed(1) + ' GB' : Math.round(info.ram_total_mb) + ' MB') : null;
  const ramAbsolute = ramUsedLabel ? `${ramUsedLabel} / ${ramTotalLabel} · ${ramPct}%` : '—';

  // Disk labels
  const diskAbsolute = formatUsageValue(info.disk_used_gb, info.disk_total_gb, diskPct);
  const storageMountsHtml = storageMountMetrics.length > 0 ? `
      <div class="res-subsection">${t('det.storageMounts')}</div>
      ${storageMountMetrics.map((mount) => {
        const pct = Number.isFinite(mount.usage_pct) ? mount.usage_pct : null;
        const valueClass = pct >= 95 ? 'res-critical' : pct >= 85 ? 'res-warn' : pct >= 70 ? 'res-caution' : '';
        const absolute = formatUsageValue(mount.used_gb, mount.total_gb, pct);
        const meta = mount.filesystem ? ` · ${esc(mount.filesystem)}` : '';
        return `
        <div class="res-row" style="margin-bottom:0;">
          <div class="res-header">
            <div class="res-title-block">
              <span class="res-label res-label--strong">${esc(mount.name || mount.path)}</span>
              <span class="res-path" title="${esc(mount.path)}${meta}">${esc(truncateMiddle(mount.path || '', 34))}${meta}</span>
            </div>
            <span class="res-value ${valueClass}">${absolute}</span>
          </div>
          ${renderThresholdBar(pct)}
        </div>`;
      }).join('')}
  ` : '';

  // ── ZFS pools (pool-level only, no individual datasets) ────
  const zfsPools = Array.isArray(info.zfs_pools) ? info.zfs_pools : [];
  const zfsHtml = zfsPools.length > 0 ? `
      <div class="res-subsection"><i class="fas fa-database" style="margin-right:6px;opacity:.6;"></i>${t('det.zfsPools')}</div>
      ${zfsPools.map(pool => {
        const poolPct = pool.size_gb ? Math.round((pool.alloc_gb / pool.size_gb) * 100) : 0;
        const poolValueClass = poolPct >= 95 ? 'res-critical' : poolPct >= 85 ? 'res-warn' : poolPct >= 70 ? 'res-caution' : '';
        const healthClass = pool.health === 'ONLINE' ? 'badge-online' : pool.health === 'DEGRADED' ? 'badge-warning' : pool.health === 'FAULTED' ? 'badge-error' : 'badge-unknown';
        const poolAbsolute = formatUsageValue(pool.alloc_gb, pool.size_gb, poolPct);
        const scrubInfo = pool.scrub ? `<span class="res-path" style="margin-left:8px;">scrub: ${esc(pool.scrub.length > 60 ? pool.scrub.slice(0, 60) + '…' : pool.scrub)}</span>` : '';
        return `
        <div class="res-row" style="margin-bottom:0;">
          <div class="res-header">
            <span class="res-label">
              <span class="badge ${healthClass}" style="font-size:10px;padding:1px 6px;margin-right:6px;">${esc(pool.health)}</span>
              ${esc(pool.name)}${scrubInfo}
            </span>
            <span class="res-value ${poolValueClass}">${poolAbsolute}</span>
          </div>
          ${renderThresholdBar(poolPct)}
        </div>`;
      }).join('')}
  ` : '';

  const isOffline = cpuPct === null && info.ram_used_mb === null;
  if (isOffline) {
    resEl.innerHTML = `<div class="empty-state empty-state-sm" style="padding:24px 16px;"><i class="fas fa-times-circle" style="font-size:24px;color:var(--offline);margin-bottom:8px;display:block;"></i><p style="color:var(--text-muted);font-size:13px;margin:0;">${t('det.offline')}</p></div>`;
    return;
  }

  resEl.innerHTML = `
    <div class="res-block">
      ${cpuPct !== null ? `
      <div class="res-row">
        <div class="res-header">
          <span class="res-label">${t('det.cpu')}</span>
          <span class="res-value ${cpuPct > 90 ? 'res-critical' : cpuPct > 70 ? 'res-warn' : 'res-ok'}">${cpuPct}%</span>
        </div>
        ${renderThresholdBar(cpuPct)}
      </div>` : ''}
      <div class="res-row">
        <div class="res-header">
          <span class="res-label">RAM</span>
          <span class="res-value ${ramPct >= 95 ? 'res-critical' : ramPct >= 85 ? 'res-warn' : ramPct >= 70 ? 'res-caution' : ''}">${ramAbsolute}</span>
        </div>
        ${renderThresholdBar(ramPct)}
      </div>
      <div class="res-row" style="margin-bottom:0;">
        <div class="res-header">
          <span class="res-label">${t('det.disk')}</span>
          <span class="res-value ${diskPct >= 95 ? 'res-critical' : diskPct >= 85 ? 'res-warn' : diskPct >= 70 ? 'res-caution' : ''}">${diskAbsolute}</span>
        </div>
        ${renderThresholdBar(diskPct)}
      </div>
      ${storageMountsHtml}
      ${zfsHtml}
    </div>
  `;
}

async function loadServerInfo(serverId) {
  try {
    // Load server info (may be cached — not used for latency)
    const info = await api.getServerInfo(serverId);
    if (!info) return;
    renderServerInfo(info);

    // Accurate latency: 3 rapid pings to /api/ping, average the results
    (async () => {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        try { await api.ping(); } catch { break; }
        samples.push(Date.now() - t0);
        if (i < 2) await new Promise(r => setTimeout(r, 80)); // tiny gap between samples
      }
      if (samples.length === 0) return;
      const pingMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
      const pingEl = document.getElementById('stat-ping');
      const pingIconEl = document.getElementById('stat-ping-icon');
      if (pingEl) {
        pingEl.textContent = pingMs + ' ms';
        const col = pingMs < 80 ? 'var(--online)' : pingMs < 250 ? 'var(--warning)' : 'var(--offline)';
        pingEl.style.color = col;
        if (pingIconEl) pingIconEl.style.color = col;
      }
    })();

    // Docker stat card
    if (hasCap('canViewDocker')) {
      api.getServerDocker(serverId).then(containers => {
        const el = document.getElementById('stat-docker');
        if (el) {
          const list = Array.isArray(containers) ? containers : [];
          el.textContent = list.length;
        }
      }).catch(() => {
        const el = document.getElementById('stat-docker');
        if (el) el.textContent = 'N/A';
      });
    } else {
      const el = document.getElementById('stat-docker');
      if (el) el.textContent = 'N/A';
    }

    // Updates stat card
    if (hasCap('canViewUpdates')) {
      api.getServerUpdates(serverId).then(updates => {
        const el = document.getElementById('stat-updates');
        const iconEl = document.getElementById('stat-updates-icon');
        if (el) {
          // API may return array directly or { updates: [] }
          const list = Array.isArray(updates) ? updates : (updates?.updates ?? []);
          const actionable = list.filter(u => !u.phased);
          el.textContent = actionable.length;
          if (actionable.length > 0) {
            el.style.color = 'var(--warning)';
            if (iconEl) iconEl.style.color = 'var(--warning)';
          } else {
            el.style.color = 'var(--online)';
          }
        }
      }).catch(() => {
        const el = document.getElementById('stat-updates');
        if (el) el.textContent = 'N/A';
      });
    } else {
      const el = document.getElementById('stat-updates');
      if (el) el.textContent = 'N/A';
    }

    // If cached, silently fetch fresh data in background
    if (info._cached) {
      api.getServerInfo(serverId, true)
        .then(fresh => { if (fresh) renderServerInfo(fresh); })
        .catch(() => { });
    }

    // Reload button for Resources
    document.getElementById('btn-refresh-info')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-refresh-info');
      if (btn) { btn.disabled = true; btn.querySelector('i').classList.add('fa-spin'); }
      const resEl = document.getElementById('res-content');
      if (resEl) resEl.innerHTML = `<div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>`;
      try {
        const fresh = await api.getServerInfo(serverId, true);
        if (fresh) renderServerInfo(fresh);
      } catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
      finally {
        if (btn) { btn.disabled = false; btn.querySelector('i').classList.remove('fa-spin'); }
      }
    });
  } catch (e) {
    showToast(t('common.errorPrefix', { msg: e.message }), 'error');
  }
}

async function loadRecentActivity(serverId) {
  const el = document.getElementById('recent-activity-content');
  if (!el) return;
  try {
    const history = await api.getServerHistory(serverId);
    if (!history || history.length === 0) {
      el.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('det.noHistory') || 'No activity yet.'}</p></div>`;
      return;
    }
    const items = history.slice(0, 6);
    el.innerHTML = items.map(item => {
      const rawDate = String(item.started_at || '');
      const d = new Date(!rawDate.endsWith('Z') ? rawDate.replace(' ', 'T') + 'Z' : rawDate);
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
      const ok = item.status === 'success';
      const fail = item.status === 'failed';
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);">
          <i class="fas fa-${ok ? 'check-circle' : fail ? 'times-circle' : 'spinner'}"
            style="font-size:14px;color:var(--${ok ? 'online' : fail ? 'offline' : 'warning'});flex-shrink:0;"></i>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.action || item.playbook_name || '—')}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:1px;">${esc(item.triggered_by || 'system')}</div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-align:right;flex-shrink:0;">
            <div>${time}</div>
            <div>${date}</div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    if (el) el.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px;">${t('det.activityLoadFailed')}</div>`;
  }
}

// ============================================================
// Docker Tab
// ============================================================
function renderDockerData(serverId, containers, imageUpdateMap = {}) {
  const content = document.getElementById('docker-content');
  if (!content) return;
  content.dataset.serverId = serverId;
  const mobileLayout = isMobileServerDetailLayout();
  if (!containers || containers.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-cubes"></i></div><h3>${t('det.noContainers')}</h3><p>${t('det.noContainersHint')}</p></div>`;
    setupComposeBtn(serverId);
    return;
  }

  const stacks = {};
  const standalone = [];
  containers.forEach(c => {
    const proj = c.compose_project;
    const dir = c.compose_working_dir;
    if (proj && dir) {
      if (!stacks[proj]) stacks[proj] = { dir, containers: [] };
      stacks[proj].containers.push(c);
    } else {
      standalone.push(c);
    }
  });

  let html = mobileLayout ? '<div class="docker-mobile-list">' : `<table class="data-table"><thead><tr>
    <th style="width:8px;"></th><th>${t('common.name')}</th><th>${t('common.image')}</th><th>${t('common.status')}</th><th>${t('det.checkUpdates')}</th><th>${t('common.actions')}</th>
  </tr></thead><tbody>`;

  for (const [proj, data] of Object.entries(stacks)) {
    const allDown = data.containers.every(c => !c.status?.startsWith('Up'));
    html += mobileLayout
      ? renderDockerStackCard(proj, data, allDown)
      : `
      <tr class="group-header no-hover">
        <td colspan="5">
          <span style="display:inline-flex;align-items:center;gap:8px;">
            <i class="fas fa-layer-group" style="color:var(--accent);"></i>
            <strong>${esc(proj)}</strong>
            <span class="mono" style="font-weight:400;color:var(--text-muted);font-size:11px;">${esc(data.dir)}</span>
            ${allDown ? `<span class="badge badge-offline" style="font-size:10px;">${t('common.offline')}</span>` : ''}
          </span>
        </td>
        <td style="white-space:nowrap;">
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="edit" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>` : ''}
          ${hasCap('canPullDocker') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="pull" title="pull"><i class="fas fa-cloud-download-alt"></i></button>` : ''}
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="up" title="up -d"><i class="fas fa-play"></i></button>` : ''}
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon btn-icon--danger compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="down" title="down"><i class="fas fa-stop"></i></button>` : ''}
        </td>
      </tr>`;
    data.containers.forEach(c => {
      if (c.container_name !== '[Stack Offline]') html += mobileLayout ? renderContainerCard(c, imageUpdateMap) : renderContainerRow(c, imageUpdateMap);
    });
  }

  if (standalone.length > 0) {
    html += mobileLayout
      ? `<div class="docker-mobile-section-title"><i class="fas fa-cube"></i><strong>${t('det.standalone')}</strong></div>`
      : `<tr class="group-header no-hover"><td colspan="6"><span style="display:inline-flex;align-items:center;gap:8px;"><i class="fas fa-cube" style="color:var(--text-muted);"></i><strong>${t('det.standalone')}</strong></span></td></tr>`;
    standalone.forEach(c => { html += mobileLayout ? renderContainerCard(c, imageUpdateMap) : renderContainerRow(c, imageUpdateMap); });
  }

  html += `${mobileLayout ? '</div>' : '</tbody></table>'}
  <div id="docker-logs-panel" class="hidden">
    <div class="dash-panel-header" style="border-top:1px solid var(--border);">
      <div class="dash-panel-header-left">
        <div class="dash-panel-icon"><i class="fas fa-file-alt"></i></div>
        <span class="dash-panel-title">${t('det.logs')}: <span id="logs-container-name"></span></span>
      </div>
      <div class="dash-panel-header-right">
        <select id="logs-tail-select" class="form-input" style="padding:3px 8px;font-size:12px;width:110px;">
          <option value="100">${t('pb.lines100')}</option>
          <option value="200" selected>${t('pb.lines200')}</option>
          <option value="500">${t('pb.lines500')}</option>
          <option value="1000">${t('pb.lines1000')}</option>
        </select>
        <button class="btn btn-icon" id="btn-logs-refresh" title="${t('common.refresh')}"><i class="fas fa-sync-alt"></i></button>
        <button class="btn btn-icon" id="btn-logs-close" title="${t('common.close')}"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div class="terminal" style="border-radius:0;border-left:none;border-right:none;border-bottom:none;">
      <div class="terminal-body" id="logs-terminal-body" style="max-height:460px;"></div>
    </div>
  </div>`;
  content.innerHTML = html;

  content.querySelectorAll('.logs-docker-btn').forEach(btn => {
    btn.addEventListener('click', () => loadContainerLogs(serverId, btn.dataset.container));
  });

  content.querySelectorAll('.restart-docker-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.container;
      if (!await showConfirm(t('det.confirmRestartContainer', { name }), { title: t('det.docker'), confirmText: t('det.reboot') })) return;
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span>';
      openGlobalTerminal(`Restart: ${name}`);
      try {
        await api.restartServerDocker(serverId, name);
        showToast(t('det.containerRestarted'), 'success');
        setTimeout(() => loadDockerContainers(serverId), 3000);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      } finally { btn.disabled = false; btn.innerHTML = orig; }
    });
  });

  content.querySelectorAll('.compose-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { project, dir, action } = btn.dataset;
      if (action === 'edit') {
        document.dispatchEvent(new CustomEvent('open-compose-modal', { detail: { serverId, project, dir } }));
        return;
      }
      const labels = { up: t('det.composeActionUp'), down: t('det.composeActionDown'), pull: t('det.composeActionPull') };
      if (!await showConfirm(t('det.confirmStackMsg', { name: esc(project), action: labels[action] || action }), { title: t('det.confirmStackTitle'), confirmText: t('common.run'), danger: action === 'down', html: true })) return;
      openGlobalTerminal(`compose ${action.toUpperCase()}: ${project}`);
      try {
        await api.runDockerComposeAction(serverId, dir, action);
        setTimeout(async () => {
          await loadDockerContainers(serverId);
          // Re-check image updates after pull/up to reflect new state
          if (action === 'pull' || action === 'up') {
            api.checkImageUpdates(serverId)
              .then(results => {
                const map = {};
                results.forEach(r => { map[r.image] = r.status; });
                imageUpdateMaps[serverId] = map;
                loadDockerContainers(serverId);
              })
              .catch(() => {});
          }
        }, 4000);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  });

  setupComposeBtn(serverId);

  const refreshBtn = document.getElementById('btn-refresh-docker');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.querySelector('i').classList.add('fa-spin');
      await api.getServerDocker(serverId, true)
        .then(fresh => {
          const el = document.getElementById('docker-content');
          if (el && el.dataset.serverId === serverId) renderDockerData(serverId, fresh, imageUpdateMaps[serverId] || {});
        })
        .catch(() => { })
        .finally(() => { refreshBtn.disabled = false; refreshBtn.querySelector('i').classList.remove('fa-spin'); });
    });
  }
  setupCheckUpdatesBtn(
    serverId,
    () => imageUpdateMaps[serverId] || {},
    (map) => { imageUpdateMaps[serverId] = map; },
    () => {
      const containers = Array.from(document.querySelectorAll('#docker-content tr[class]')); // trigger re-render
      loadDockerContainers(serverId);
    }
  );
}

async function loadDockerContainers(serverId) {
  const content = document.getElementById('docker-content');
  if (!content) return;
  content.dataset.serverId = serverId;

  // Load cached image update status if not already in memory
  if (!imageUpdateMaps[serverId]) {
    try {
      const cached = await api.getCachedImageUpdates(serverId);
      if (cached?.results?.length) {
        const map = {};
        cached.results.forEach(r => { map[r.image] = r.status; });
        imageUpdateMaps[serverId] = map;
      }
    } catch { /* ignore – proceed without cached status */ }
  }

  try {
    const containers = await api.getServerDocker(serverId);
    const el = document.getElementById('docker-content');
    if (!el || el.dataset.serverId !== serverId) return;
    renderDockerData(serverId, containers, imageUpdateMaps[serverId] || {});
    if (containers?.length > 0 && containers[0]?._cached) {
      api.getServerDocker(serverId, true)
        .then(fresh => {
          const el = document.getElementById('docker-content');
          if (el && el.dataset.serverId === serverId) renderDockerData(serverId, fresh, imageUpdateMaps[serverId] || {});
        })
        .catch(() => { });
    }
  } catch (error) {
    const el = document.getElementById('docker-content');
    if (el && el.dataset.serverId === serverId) {
      el.innerHTML = `<div class="empty-state"><p style="color:var(--offline);">${t('common.errorPrefix', { msg: esc(error.message) })}</p></div>`;
    }
  }
}

function renderContainerRow(c, imageUpdateMap = {}) {
  const isUp = c.status?.startsWith('Up');
  const dotCls = isUp ? 'online' : 'offline';
  const updateStatus = imageUpdateMap[c.image] || imageUpdateMap[c.image + ':latest'];
  const updateCell = updateStatus === 'update_available'
    ? `<span class="badge badge-warning" style="font-size:10px;"><i class="fas fa-arrow-up"></i> ${t('det.imageUpdateAvail')}</span>`
    : updateStatus === 'updated'
      ? `<span class="badge badge-online" style="font-size:10px;"><i class="fas fa-check"></i> ${t('det.imageUpdated')}</span>`
      : updateStatus === 'up_to_date'
        ? `<span style="font-size:11px;color:var(--text-muted);"><i class="fas fa-check"></i> ${t('det.imageUpToDate')}</span>`
        : `<span style="font-size:11px;color:var(--text-muted);">—</span>`;
  return `
    <tr class="no-hover" style="padding-left:20px;">
      <td style="padding-left:24px;"><span class="status-dot ${dotCls}"></span></td>
      <td><span class="mono">${esc(c.container_name)}</span></td>
      <td class="mono" style="color:var(--text-muted);font-size:11px;">${esc(c.image)}</td>
      <td><span style="font-size:12px;color:${isUp ? 'var(--online)' : 'var(--offline)'};">${esc(c.status || c.state)}</span></td>
      <td>${updateCell}</td>
      <td style="white-space:nowrap;">
        ${hasCap('canViewDocker') ? `<button class="btn btn-icon logs-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.showLogs')}"><i class="fas fa-file-alt"></i></button>` : ''}
        ${hasCap('canRestartDocker') ? `<button class="btn btn-icon restart-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.containerRestarted')}"><i class="fas fa-sync-alt"></i></button>` : ''}
      </td>
    </tr>
  `;
}

function renderDockerStackCard(project, data, allDown) {
  return `
    <section class="docker-mobile-stack">
      <div class="docker-mobile-stack-header">
        <div class="docker-mobile-stack-meta">
          <div class="docker-mobile-stack-title-line">
            <i class="fas fa-layer-group" style="color:var(--accent);"></i>
            <strong>${esc(project)}</strong>
            ${allDown ? `<span class="badge badge-offline" style="font-size:10px;">${t('common.offline')}</span>` : ''}
          </div>
          <div class="mono docker-mobile-stack-path">${esc(data.dir)}</div>
        </div>
        <div class="docker-mobile-stack-actions">
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(project)}" data-dir="${esc(data.dir)}" data-action="edit" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>` : ''}
          ${hasCap('canPullDocker') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(project)}" data-dir="${esc(data.dir)}" data-action="pull" title="pull"><i class="fas fa-cloud-download-alt"></i></button>` : ''}
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon compose-action-btn" data-project="${esc(project)}" data-dir="${esc(data.dir)}" data-action="up" title="up -d"><i class="fas fa-play"></i></button>` : ''}
          ${hasCap('canManageDockerCompose') ? `<button class="btn btn-icon btn-icon--danger compose-action-btn" data-project="${esc(project)}" data-dir="${esc(data.dir)}" data-action="down" title="down"><i class="fas fa-stop"></i></button>` : ''}
        </div>
      </div>
    </section>
  `;
}

function renderContainerCard(c, imageUpdateMap = {}) {
  const isUp = c.status?.startsWith('Up');
  const dotCls = isUp ? 'online' : 'offline';
  const updateStatus = imageUpdateMap[c.image] || imageUpdateMap[c.image + ':latest'];
  const updateCell = updateStatus === 'update_available'
    ? `<span class="badge badge-warning" style="font-size:10px;"><i class="fas fa-arrow-up"></i> ${t('det.imageUpdateAvail')}</span>`
    : updateStatus === 'updated'
      ? `<span class="badge badge-online" style="font-size:10px;"><i class="fas fa-check"></i> ${t('det.imageUpdated')}</span>`
      : updateStatus === 'up_to_date'
        ? `<span class="docker-mobile-muted"><i class="fas fa-check"></i> ${t('det.imageUpToDate')}</span>`
        : `<span class="docker-mobile-muted">—</span>`;

  return `
    <article class="docker-mobile-card">
      <div class="docker-mobile-card-header">
        <div class="docker-mobile-card-title-wrap">
          <div class="docker-mobile-card-title-line">
            <span class="status-dot ${dotCls}"></span>
            <span class="mono docker-mobile-card-title">${esc(c.container_name)}</span>
          </div>
          <div class="mono docker-mobile-card-image">${esc(c.image)}</div>
        </div>
        <div class="docker-mobile-card-actions">
          ${hasCap('canViewDocker') ? `<button class="btn btn-icon logs-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.showLogs')}"><i class="fas fa-file-alt"></i></button>` : ''}
          ${hasCap('canRestartDocker') ? `<button class="btn btn-icon restart-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.containerRestarted')}"><i class="fas fa-sync-alt"></i></button>` : ''}
        </div>
      </div>
      <div class="docker-mobile-card-meta">
        <div>
          <span class="docker-mobile-meta-label">${t('common.status')}</span>
          <span class="docker-mobile-meta-value" style="color:${isUp ? 'var(--online)' : 'var(--offline)'};">${esc(c.status || c.state)}</span>
        </div>
        <div>
          <span class="docker-mobile-meta-label">${t('det.checkUpdates')}</span>
          <span class="docker-mobile-meta-value">${updateCell}</span>
        </div>
      </div>
    </article>
  `;
}

async function loadContainerLogs(serverId, containerName) {
  const panel = document.getElementById('docker-logs-panel');
  const nameEl = document.getElementById('logs-container-name');
  const body = document.getElementById('logs-terminal-body');
  const tailSel = document.getElementById('logs-tail-select');
  const refreshBtn = document.getElementById('btn-logs-refresh');
  const closeBtn = document.getElementById('btn-logs-close');
  if (!panel || !body) return;

  // Show panel + update header
  panel.classList.remove('hidden');
  if (nameEl) nameEl.textContent = containerName;
  body.innerHTML = `<span class="line-stdout" style="opacity:0.5;">${t('common.loading')}</span>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Highlight active row
  document.querySelectorAll('.logs-docker-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.logs-docker-btn[data-container="${containerName}"]`)?.classList.add('active');

  const fetch = async () => {
    const tail = tailSel ? parseInt(tailSel.value) : 200;
    body.innerHTML = `<span class="line-stdout" style="opacity:0.5;">${t('common.loading')}</span>`;
    try {
      const { logs } = await api.getContainerLogs(serverId, containerName, tail);
      body.innerHTML = '';
      if (!logs.trim()) {
        const empty = document.createElement('span');
        empty.className = 'line-stdout';
        empty.style.opacity = '0.5';
        empty.textContent = t('det.noOutput');
        body.appendChild(empty);
      } else {
        logs.split('\n').forEach(line => {
          if (!line) return;
          const span = document.createElement('span');
          span.className = line.includes(' E ') || line.toLowerCase().includes('error') || line.toLowerCase().includes('fatal') ? 'line-stderr' : 'line-stdout';
          span.textContent = line;
          body.appendChild(span);
        });
        body.scrollTop = body.scrollHeight;
      }
    } catch (err) {
      body.innerHTML = '';
      const span = document.createElement('span');
      span.className = 'line-stderr';
      span.textContent = t('common.errorPrefix', { msg: err.message });
      body.appendChild(span);
    }
  };

  await fetch();

  // Wire up controls (replace old listeners by cloning)
  if (refreshBtn) {
    const fresh = refreshBtn.cloneNode(true);
    refreshBtn.replaceWith(fresh);
    fresh.addEventListener('click', fetch);
  }
  if (tailSel) {
    const savedValue = tailSel.value;
    const fresh = tailSel.cloneNode(true);
    tailSel.replaceWith(fresh);
    fresh.value = savedValue;
    fresh.addEventListener('change', fetch);
  }
  if (closeBtn) {
    const fresh = closeBtn.cloneNode(true);
    closeBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      panel.classList.add('hidden');
      document.querySelectorAll('.logs-docker-btn').forEach(b => b.classList.remove('active'));
    });
  }
}

function setupComposeBtn(serverId) {
  document.getElementById('btn-add-compose-stack')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-compose-modal', {
      detail: { serverId, project: 'neuer-stack', dir: '/opt/stacks/neuer-stack', isNew: true }
    }));
  });
}

function setupCheckUpdatesBtn(serverId, getImageUpdateMap, setImageUpdateMap, rerenderFn) {
  const btn = document.getElementById('btn-check-image-updates');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('det.checkingUpdates')}`;
    try {
      const results = await api.checkImageUpdates(serverId);
      const map = {};
      results.forEach(r => { map[r.image] = r.status; });
      setImageUpdateMap(map);
      rerenderFn();
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: err.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });
}

// ============================================================
// Updates Tab
// ============================================================
function renderUpdatesData(updates, customTasks = [], serverId = null) {
  const el = document.getElementById('updates-content');
  if (!el) return;
  const cached = updates?.length > 0 && updates[0]?._cached;
  const clean = (updates || []).map(({ _cached, ...u }) => u);
  if (clean.length === 0) {
    el.innerHTML = `<div style="padding:16px;display:flex;align-items:center;gap:8px;color:var(--online);font-size:13px;"><i class="fas fa-check-circle"></i> ${t('det.allUpToDate')}${cached ? ` <span style="color:var(--text-muted);font-size:11px;">(${t('det.cached')})</span>` : ''}</div>`;
    renderCustomTasksPanel(customTasks, serverId);
    return;
  }
  const real = clean.filter(u => !u.phased);
  const phased = clean.filter(u => u.phased);
  el.innerHTML = `
    ${real.length > 0 ? `
    <div style="padding:10px 14px;background:var(--warning-bg);color:var(--warning);font-size:12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <span><i class="fas fa-exclamation-triangle"></i> ${t('det.updatesAvail', { count: real.length })}</span>
      ${cached ? `<span style="font-size:11px;opacity:0.7;"><i class="fas fa-clock"></i> ${t('det.cached')}</span>` : ''}
    </div>
    <div class="updates-list">
      ${real.map(u => `
        <div class="update-item">
          <span class="update-package">${esc(u.package)}</span>
          <span class="update-version">${esc(u.version || '')}</span>
        </div>
      `).join('')}
    </div>` : `<div style="padding:16px;display:flex;align-items:center;gap:8px;color:var(--online);font-size:13px;"><i class="fas fa-check-circle"></i> ${t('det.allUpToDate')}${cached ? ` <span style="color:var(--text-muted);font-size:11px;">(${t('det.cached')})</span>` : ''}</div>`}
    ${phased.length > 0 ? `
    <div style="padding:10px 14px;background:var(--bg-hover);color:var(--text-muted);font-size:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:6px;">
      <i class="fas fa-pause-circle"></i> ${t('det.phasedCount', { count: phased.length })}
    </div>
    <div class="updates-list" style="opacity:0.5;">
      ${phased.map(u => `
        <div class="update-item">
          <span class="update-package">${esc(u.package)}</span>
          <span class="update-version">${esc(u.version || '')}</span>
        </div>
      `).join('')}
    </div>` : ''}
  `;

  renderCustomTasksPanel(customTasks, serverId);
}

function renderCustomTasksPanel(customTasks, serverId) {
  const el = document.getElementById('custom-updates-content');
  if (!el) return;
  const mobileLayout = isMobileServerDetailLayout();
  const rows = (customTasks || []).map(task => {
    const statusCell = task.has_update
      ? `<span class="badge badge-warning" style="font-size:10px;"><i class="fas fa-arrow-up"></i> ${t('det.imageUpdateAvail')}</span>`
      : task.last_checked_at
        ? `<span style="font-size:11px;color:var(--online);"><i class="fas fa-check"></i> ${t('det.imageUpToDate')}</span>`
        : `<span style="font-size:11px;color:var(--text-muted);">—</span>`;
    const typeLabel = task.type === 'github'
      ? `<span style="font-size:11px;color:var(--text-muted);"><i class="fab fa-github"></i> GitHub</span>`
      : task.type === 'trigger'
        ? `<span style="font-size:11px;color:var(--text-muted);"><i class="fas fa-wave-square"></i> ${t('det.taskTypeTriggerShort')}</span>`
        : `<span style="font-size:11px;color:var(--text-muted);">Script</span>`;
    const latestValue = task.type === 'trigger' ? (task.trigger_output || task.last_version || '—') : (task.last_version || '—');
    return mobileLayout
      ? `
      <article class="custom-task-card">
        <div class="custom-task-card-header">
          <div>
            <div class="custom-task-card-title">${esc(task.name)}</div>
            <div class="custom-task-card-subtitle">${typeLabel}</div>
          </div>
          <div class="custom-task-card-status">${statusCell}</div>
        </div>
        <div class="custom-task-card-grid">
          <div>
            <span class="custom-task-card-label">${t('det.currentVersion')}</span>
            <span class="mono custom-task-card-value">${esc(task.current_version || '—')}</span>
          </div>
          <div>
            <span class="custom-task-card-label">${t('det.latestVersion')}</span>
            <span class="mono custom-task-card-value">${esc(latestValue)}</span>
          </div>
        </div>
        <div class="custom-task-card-actions">
          ${hasCap('canRunCustomUpdates') ? `<button class="btn btn-icon custom-task-check" data-id="${esc(task.id)}" title="${t('det.checkNow')}"><i class="fas fa-sync-alt"></i></button>` : ''}
          ${hasCap('canRunCustomUpdates') && task.update_command ? `<button class="btn btn-icon custom-task-run" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('det.runUpdate')}"><i class="fas fa-play"></i></button>` : ''}
          ${hasCap('canEditCustomUpdates') ? `<button class="btn btn-icon custom-task-edit" data-id="${esc(task.id)}" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>` : ''}
          ${hasCap('canDeleteCustomUpdates') ? `<button class="btn btn-icon btn-icon--danger custom-task-delete" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </article>`
      : `
      <tr class="no-hover">
        <td><strong>${esc(task.name)}</strong></td>
        <td>${typeLabel}</td>
        <td class="mono" style="font-size:11px;">${esc(task.current_version || '—')}</td>
        <td class="mono" style="font-size:11px;">${esc(latestValue)}</td>
        <td>${statusCell}</td>
        <td style="white-space:nowrap;">
          ${hasCap('canRunCustomUpdates') ? `<button class="btn btn-icon custom-task-check" data-id="${esc(task.id)}" title="${t('det.checkNow')}"><i class="fas fa-sync-alt"></i></button>` : ''}
          ${hasCap('canRunCustomUpdates') && task.update_command ? `<button class="btn btn-icon custom-task-run" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('det.runUpdate')}"><i class="fas fa-play"></i></button>` : ''}
          ${hasCap('canEditCustomUpdates') ? `<button class="btn btn-icon custom-task-edit" data-id="${esc(task.id)}" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>` : ''}
          ${hasCap('canDeleteCustomUpdates') ? `<button class="btn btn-icon btn-icon--danger custom-task-delete" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
        </td>
      </tr>`;
  }).join('');

  const emptyRow = `<tr class="no-hover"><td colspan="6" style="color:var(--text-muted);font-size:13px;padding:12px 16px;">${t('det.noCustomTasks')}</td></tr>`;

  el.innerHTML = mobileLayout
    ? (rows || `<div class="custom-task-empty">${t('det.noCustomTasks')}</div>`)
    : `
    <table class="data-table">
      <thead><tr>
        <th>${t('common.name')}</th><th>${t('det.taskType')}</th>
        <th>${t('det.currentVersion')}</th><th>${t('det.latestVersion')}</th>
        <th>${t('common.status')}</th><th>${t('common.actions')}</th>
      </tr></thead>
      <tbody>${rows || emptyRow}</tbody>
    </table>`;

  if (serverId) setupCustomTaskListeners(serverId);
}

function setupCustomTaskListeners(serverId) {
  const addBtn = document.getElementById('btn-add-custom-task');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => showCustomTaskModal(serverId, null));
  }

  document.querySelectorAll('.custom-task-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span>';
      try {
        await api.checkCustomUpdateTask(serverId, btn.dataset.id);
        await loadUpdates(serverId);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      } finally { btn.disabled = false; btn.innerHTML = orig; }
    });
  });

  document.querySelectorAll('.custom-task-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      openGlobalTerminal(t('det.runUpdateStarted', { name }));
      try {
        await api.runCustomUpdateTask(serverId, btn.dataset.id);
        showToast(t('det.runUpdateStarted', { name }), 'success');
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  });

  document.querySelectorAll('.custom-task-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const tasks = await api.getCustomUpdateTasks(serverId);
        const task = tasks.find(t => t.id === btn.dataset.id);
        if (task) showCustomTaskModal(serverId, task);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  });

  document.querySelectorAll('.custom-task-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirm(t('det.confirmDeleteTask', { name: btn.dataset.name }), { danger: true })) return;
      try {
        await api.deleteCustomUpdateTask(serverId, btn.dataset.id);
        showToast(t('det.taskDeleted'), 'success');
        loadUpdates(serverId);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  });
}

function showCustomTaskModal(serverId, task) {
  const existing = document.getElementById('custom-task-modal');
  if (existing) existing.remove();

  const isEdit = !!task;
  const overlay = document.createElement('div');
  overlay.id = 'custom-task-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-md">
      <div class="modal-header">
        <h3 id="ctm-title">${isEdit ? t('det.editTask') : t('det.addTask')}</h3>
        <button class="btn btn-secondary btn-sm" id="ctm-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="form-group">
          <label class="form-label">${t('det.taskName')}</label>
          <input class="form-input" id="ctm-name" value="${esc(task?.name || '')}" placeholder="UniFi OS, Immich, …">
        </div>
        <div class="form-group">
          <label class="form-label">${t('det.taskType')}</label>
          <select class="form-input" id="ctm-type">
            <option value="script" ${(!task || task.type === 'script') ? 'selected' : ''}>${t('det.taskTypeScript')}</option>
            <option value="github" ${task?.type === 'github' ? 'selected' : ''}>${t('det.taskTypeGithub')}</option>
            <option value="trigger" ${task?.type === 'trigger' ? 'selected' : ''}>${t('det.taskTypeTrigger')}</option>
          </select>
          <div id="ctm-type-desc" style="margin-top:6px;font-size:12px;color:var(--text-muted);line-height:1.4;">
            ${task?.type === 'github' ? t('det.taskTypeGithubDesc') : task?.type === 'trigger' ? t('det.taskTypeTriggerDesc') : t('det.taskTypeScriptDesc')}
          </div>
        </div>
        <div class="form-group" id="ctm-github-row" style="${task?.type === 'github' ? '' : 'display:none;'}">
          <label class="form-label">${t('det.taskGithubRepo')}</label>
          <input class="form-input mono" id="ctm-github-repo" value="${esc(task?.github_repo || '')}" placeholder="immich-app/immich">
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${t('det.taskGithubRepoHint')}</div>
        </div>
        <div class="form-group" id="ctm-trigger-row" style="${task?.type === 'trigger' ? '' : 'display:none;'}">
          <label class="form-label">${t('det.taskTriggerOutput')}</label>
          <input class="form-input mono" id="ctm-trigger-output" value="${esc(task?.trigger_output || '')}" placeholder="AVAILABLE">
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${t('det.taskTriggerOutputHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('det.taskCheckCommand')}</label>
          <input class="form-input mono" id="ctm-check-cmd" value="${esc(task?.check_command || '')}" placeholder="immich --version">
          <div id="ctm-check-hint" style="margin-top:4px;font-size:11px;color:var(--text-muted);">${task?.type === 'trigger' ? t('det.taskCheckCommandHintTrigger') : t('det.taskCheckCommandHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('det.taskUpdateCommand')} <span id="ctm-update-required" style="color:var(--danger);font-size:11px;${task?.type === 'trigger' ? 'display:none;' : ''}">*</span></label>
          <input class="form-input mono" id="ctm-update-cmd" value="${esc(task?.update_command || '')}" placeholder="https://get.glennr.nl/unifi/update/unifi-update.sh">
          <div id="ctm-update-hint" style="margin-top:4px;font-size:11px;color:var(--text-muted);">${task?.type === 'trigger' ? t('det.taskUpdateCommandOptionalHint') : t('det.taskUpdateCommandHint')}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="ctm-cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="ctm-save"><i class="fas fa-save"></i> ${t('common.save')}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  let releaseDialog = null;

  function close() {
    releaseDialog?.();
    releaseDialog = null;
    overlay.remove();
  }

  releaseDialog = activateDialog({
    dialog: overlay.querySelector('.modal'),
    initialFocus: '#ctm-name',
    onClose: close,
    labelledBy: 'ctm-title',
  });

  function syncCustomTaskTypeUi(type) {
    const isGithub = type === 'github';
    const isTrigger = type === 'trigger';
    document.getElementById('ctm-github-row').style.display = isGithub ? '' : 'none';
    document.getElementById('ctm-trigger-row').style.display = isTrigger ? '' : 'none';
    document.getElementById('ctm-type-desc').textContent = isGithub
      ? t('det.taskTypeGithubDesc')
      : isTrigger
        ? t('det.taskTypeTriggerDesc')
        : t('det.taskTypeScriptDesc');
    document.getElementById('ctm-check-hint').textContent = isTrigger ? t('det.taskCheckCommandHintTrigger') : t('det.taskCheckCommandHint');
    document.getElementById('ctm-update-hint').textContent = isTrigger ? t('det.taskUpdateCommandOptionalHint') : t('det.taskUpdateCommandHint');
    document.getElementById('ctm-update-required').style.display = isTrigger ? 'none' : '';
  }

  document.getElementById('ctm-type').addEventListener('change', e => syncCustomTaskTypeUi(e.target.value));
  syncCustomTaskTypeUi(task?.type || 'script');

  document.getElementById('ctm-close').addEventListener('click', close);
  document.getElementById('ctm-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('ctm-save').addEventListener('click', async () => {
    const data = {
      name: document.getElementById('ctm-name').value.trim(),
      type: document.getElementById('ctm-type').value,
      github_repo: document.getElementById('ctm-github-repo').value.trim() || null,
      check_command: document.getElementById('ctm-check-cmd').value.trim() || null,
      update_command: document.getElementById('ctm-update-cmd').value.trim(),
      trigger_output: document.getElementById('ctm-trigger-output').value.trim() || null,
    };
    if (!data.name) {
      showToast(t('common.errorPrefix', { msg: t('det.taskNameRequired') }), 'error');
      return;
    }
    if ((data.type === 'script' || data.type === 'github') && !data.update_command) {
      showToast(t('common.errorPrefix', { msg: t('common.nameAndCmdRequired') }), 'error');
      return;
    }
    if (data.type === 'trigger' && (!data.check_command || !data.trigger_output)) {
      showToast(t('common.errorPrefix', { msg: t('det.taskTriggerRequired') }), 'error');
      return;
    }
    try {
      if (isEdit) await api.updateCustomUpdateTask(serverId, task.id, data);
      else await api.createCustomUpdateTask(serverId, data);
      showToast(t('det.taskSaved'), 'success');
      close();
      loadUpdates(serverId);
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: err.message }), 'error');
    }
  });
}

async function loadUpdates(serverId) {
  const el = document.getElementById('updates-content');
  if (!el) return;
  try {
    const [updates, customTasks] = await Promise.all([
      api.getServerUpdates(serverId),
      hasCap('canViewCustomUpdates') ? api.getCustomUpdateTasks(serverId) : Promise.resolve([]),
    ]);
    renderUpdatesData(updates, customTasks, serverId);
    if (updates?.length > 0 && updates[0]?._cached) {
      api.getServerUpdates(serverId, true)
        .then(fresh => { if (document.getElementById('updates-content')) renderUpdatesData(fresh, customTasks, serverId); })
        .catch(() => { });
    }
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--offline);">${esc(e.message)}</p></div>`;
  }
}

// ============================================================
// History Tab
// ============================================================
async function loadHistory(serverId) {
  const el = document.getElementById('history-content');
  if (!el) return;

  const HIST_PAGE_SIZE = 25;
  let histPage = 1;
  let history = [];

  function renderHistoryPage() {
    const total = Math.max(1, Math.ceil(history.length / HIST_PAGE_SIZE));
    if (histPage > total) histPage = total;
    const from = (histPage - 1) * HIST_PAGE_SIZE;
    const items = history.slice(from, from + HIST_PAGE_SIZE);

    let pages = '';
    for (let i = 1; i <= total; i++) {
      if (total > 7 && Math.abs(i - histPage) > 2 && i !== 1 && i !== total) {
        if (i === histPage - 3 || i === histPage + 3) pages += `<button disabled>…</button>`;
        continue;
      }
      pages += `<button class="hist-page-btn${i === histPage ? ' active' : ''}" data-page="${i}">${i}</button>`;
    }

    const pagination = total <= 1 ? '' : `
      <div class="pagination">
        <span class="pagination-info">${t('det.histPageInfo', { from: from + 1, to: Math.min(from + HIST_PAGE_SIZE, history.length), total: history.length })}</span>
        <div class="pagination-controls">
          <button class="hist-page-btn" data-page="${histPage - 1}" ${histPage === 1 ? 'disabled' : ''}>‹</button>
          ${pages}
          <button class="hist-page-btn" data-page="${histPage + 1}" ${histPage === total ? 'disabled' : ''}>›</button>
        </div>
      </div>
    `;

    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th>${t('det.colAction')}</th><th>${t('det.colTrigger')}</th><th>${t('common.status')}</th><th>${t('det.colStarted')}</th><th>${t('det.colDone')}</th></tr>
        </thead>
        <tbody>
          ${items.map(h => {
      const statusCls = h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'warning';
      const isSchedule = h._type === 'schedule';
      const trigger = isSchedule
        ? `<span style="display:inline-flex;align-items:center;gap:5px;"><i class="fas fa-calendar-alt" style="color:var(--accent);font-size:11px;"></i> ${esc(h.triggered_by || 'schedule')}</span>`
        : `<span style="color:var(--text-muted);font-size:11px;">${esc(h.triggered_by || 'system')}</span>`;
      return `
              <tr class="no-hover">
                <td class="mono">
                  <div style="display:flex;align-items:center;gap:6px;">
                    ${isSchedule ? `<span class="badge" style="font-size:10px;padding:1px 6px;background:var(--accent-light);color:var(--accent);border:1px solid var(--accent);flex-shrink:0;">${t('det.playbookBadge')}</span>` : ''}
                    ${esc(h.action)}
                  </div>
                </td>
                <td>${trigger}</td>
                <td><span class="badge badge-${statusCls}">${h.status}</span></td>
                <td class="mono" style="font-size:11px;color:var(--text-muted);">${formatDate(h.started_at)}</td>
                <td class="mono" style="font-size:11px;color:var(--text-muted);">${formatDate(h.completed_at)}</td>
              </tr>
            `;
    }).join('')}
        </tbody>
      </table>
      ${pagination}
    `;

    el.querySelectorAll('.hist-page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        histPage = parseInt(btn.dataset.page);
        renderHistoryPage();
      });
    });
  }

  try {
    history = await api.getServerHistory(serverId);
    if (history.length === 0) {
      el.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px;">${t('det.noHistory')}</div>`;
      return;
    }
    renderHistoryPage();
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--offline);">${esc(e.message)}</p></div>`;
  }
}

async function loadAgentTab(serverId) {
  const el = document.getElementById('agent-content');
  if (!el) return;

  const setBusy = (busy, activeBtnId = null) => {
    ['btn-agent-install', 'btn-agent-update', 'btn-agent-configure', 'btn-agent-rotate-token', 'btn-agent-remove'].forEach(id => {
      const b = document.getElementById(id);
      if (!b) return;
      b.disabled = busy;
      if (busy && id === activeBtnId) {
        b.dataset.origHtml = b.dataset.origHtml || b.innerHTML;
        b.innerHTML = `<span class="spinner-sm"></span> ${t('det.agentWorking')}`;
      } else if (!busy && b.dataset.origHtml) {
        b.innerHTML = b.dataset.origHtml;
        delete b.dataset.origHtml;
      }
    });
  };

  async function renderStatus() {
    const status = await api.getAgentStatus(serverId);
    const installed = !!status.installed;

    el.innerHTML = `
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px 0;line-height:1.5;">${t('det.agentDescription')}</p>
      <div class="agent-kpi-grid">
        <div class="agent-kpi-card"><div class="agent-kpi-label">${t('det.agentMode')}</div><div class="agent-kpi-value">${esc(status.mode || 'legacy')}</div></div>
        <div class="agent-kpi-card"><div class="agent-kpi-label">${t('det.agentLastSeen')}</div><div class="agent-kpi-value">${esc(status.lastSeen || '—')}</div></div>
        <div class="agent-kpi-card"><div class="agent-kpi-label">${t('det.agentRunnerVersion')}</div><div class="agent-kpi-value">${esc(status.runnerVersion || '—')}</div></div>
        <div class="agent-kpi-card"><div class="agent-kpi-label">${t('det.agentManifestVersion')}</div><div class="agent-kpi-value">${esc(String(status.manifestVersion || status.latestManifestVersion || '—'))}</div></div>
      </div>
      <div class="agent-action-row">
        ${!installed ? `<button class="btn btn-primary btn-sm" id="btn-agent-install"><i class="fas fa-download"></i> ${t('det.agentInstall')}</button>` : ''}
        ${installed ? `<button class="btn btn-secondary btn-sm" id="btn-agent-update"><i class="fas fa-rotate"></i> ${t('det.agentUpdate')}</button>` : ''}
        ${installed ? `<button class="btn btn-secondary btn-sm" id="btn-agent-configure"><i class="fas fa-sliders"></i> ${t('det.agentConfigure')}</button>` : ''}
        ${installed ? `<button class="btn btn-secondary btn-sm" id="btn-agent-rotate-token"><i class="fas fa-key"></i> ${t('det.agentRotateToken')}</button>` : ''}
        ${installed ? `<button class="btn btn-danger btn-sm" id="btn-agent-remove"><i class="fas fa-trash"></i> ${t('det.agentRemove')}</button>` : ''}
      </div>
      ${installed ? `
      <div class="agent-action-notes">
        <div><strong>${t('det.agentUpdate')}:</strong> ${t('det.agentUpdateHint')}</div>
        <div><strong>${t('det.agentConfigure')}:</strong> ${t('det.agentConfigureHint')}</div>
      </div>` : ''}
      <div style="margin-top:12px;max-width:860px;">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px;">${t('det.agentShipyardUrl')}</label>
        <input id="agent-shipyard-url" class="form-input" type="text" value="${esc(status.shipyardUrl || window.location.origin)}" placeholder="https://shipyard.example.com" style="max-width:520px;width:100%;margin-bottom:10px;">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px;">${t('det.agentCaPem')}</label>
        <textarea id="agent-ca-pem" class="form-input" rows="5" placeholder="${t('det.agentCaPemPlaceholder')}" style="width:100%;font-family:var(--font-mono);font-size:11px;line-height:1.35;"></textarea>
      </div>
    `;

    document.getElementById('btn-agent-install')?.addEventListener('click', async () => {
      if (!await showConfirm(t('det.agentInstallConfirm'), { title: t('det.tabAgent'), confirmText: t('det.agentInstall') })) return;
      try {
        setBusy(true, 'btn-agent-install');
        const shipyard_url = document.getElementById('agent-shipyard-url')?.value?.trim() || '';
        const shipyard_ca_cert_pem = document.getElementById('agent-ca-pem')?.value?.trim() || '';
        await api.installAgent(serverId, { mode: 'push', interval: 30, shipyard_url, shipyard_ca_cert_pem });
        showToast(t('det.agentInstallStarted'), 'success');
        await renderStatus();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        setBusy(false);
      }
    });

    document.getElementById('btn-agent-update')?.addEventListener('click', async () => {
      try {
        setBusy(true, 'btn-agent-update');
        await api.updateAgent(serverId);
        showToast(t('det.agentUpdateStarted'), 'success');
        await renderStatus();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        setBusy(false);
      }
    });

    document.getElementById('btn-agent-configure')?.addEventListener('click', async () => {
      try {
        setBusy(true, 'btn-agent-configure');
        const nextMode = ['push', 'pull', 'legacy'].includes(status.mode) ? status.mode : 'push';
        const shipyard_url = document.getElementById('agent-shipyard-url')?.value?.trim() || '';
        const shipyard_ca_cert_pem = document.getElementById('agent-ca-pem')?.value?.trim() || '';
        await api.configureAgent(serverId, { mode: nextMode, interval: status.interval || 30, shipyard_url, shipyard_ca_cert_pem });
        showToast(t('det.agentConfigureStarted'), 'success');
        await renderStatus();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        setBusy(false);
      }
    });

    document.getElementById('btn-agent-rotate-token')?.addEventListener('click', async () => {
      try {
        setBusy(true, 'btn-agent-rotate-token');
        const shipyard_url = document.getElementById('agent-shipyard-url')?.value?.trim() || '';
        const shipyard_ca_cert_pem = document.getElementById('agent-ca-pem')?.value?.trim() || '';
        await api.rotateAgentToken(serverId, { shipyard_url, shipyard_ca_cert_pem });
        showToast(t('det.agentTokenRotated'), 'success');
        await renderStatus();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        setBusy(false);
      }
    });

    document.getElementById('btn-agent-remove')?.addEventListener('click', async () => {
      if (!await showConfirm(t('det.agentRemoveConfirm'), { title: t('det.tabAgent'), confirmText: t('det.agentRemove'), danger: true })) return;
      try {
        setBusy(true, 'btn-agent-remove');
        await api.removeAgent(serverId);
        showToast(t('det.agentRemoved'), 'success');
        await renderStatus();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        setBusy(false);
      }
    });
  }

  try {
    await renderStatus();
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--offline);">${esc(e.message)}</p></div>`;
  }
}

// ============================================================
// Helpers
// ============================================================
function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateStr) {
  return formatDateTimeFull(dateStr);
}

// ============================================================
// Notes Tab
// ============================================================
function renderMarkdown(raw) {
  return DOMPurify.sanitize(marked.parse(raw || '', { breaks: true }));
}

async function setupNotesTab(serverId) {
  const textarea = document.getElementById('notes-textarea');
  const viewEl = document.getElementById('notes-view');
  const toggleBtn = document.getElementById('notes-toggle-edit');
  const status = document.getElementById('notes-status');
  if (!viewEl) return;

  let notesText = '';
  let editing = false;

  const showView = () => {
    editing = false;
    if (viewEl) {
      viewEl.innerHTML = notesText.trim()
        ? renderMarkdown(notesText)
        : `<p class="notes-empty">${esc(t('det.notesEmpty'))}</p>`;
      viewEl.style.display = '';
    }
    if (textarea) textarea.style.display = 'none';
    if (toggleBtn) {
      toggleBtn.innerHTML = `<i class="fas fa-edit"></i> ${t('det.notesEdit')}`;
    }
  };

  const showEdit = () => {
    editing = true;
    if (textarea) { textarea.value = notesText; textarea.style.display = ''; textarea.focus(); }
    if (viewEl) viewEl.style.display = 'none';
    if (toggleBtn) {
      toggleBtn.innerHTML = `<i class="fas fa-eye"></i> ${t('det.notesView')}`;
    }
  };

  // Load from server
  try {
    const { notes } = await api.getServerNotes(serverId);
    notesText = notes || '';
  } catch {
    if (status) { status.textContent = t('common.loadFailed'); status.className = 'notes-saved-indicator error'; }
  }

  showView();

  // Toggle button
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (editing) {
        notesText = textarea?.value || '';
        showView();
      } else {
        showEdit();
      }
    });
  }

  // Auto-save on edit
  if (textarea) {
    let debounceTimer = null;
    textarea.addEventListener('input', () => {
      if (status) { status.textContent = ''; status.className = 'notes-saved-indicator'; }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        notesText = textarea.value;
        try {
          await api.saveServerNotes(serverId, notesText);
          if (status) {
            status.textContent = t('det.notesSaved');
            status.className = 'notes-saved-indicator saved';
            setTimeout(() => { if (status) status.textContent = ''; }, 2000);
          }
        } catch {
          if (status) { status.textContent = t('det.notesError'); status.className = 'notes-saved-indicator error'; }
        }
      }, 800);
    });
  }
}

// Kept for legacy compat
function showTerminal(title) { openGlobalTerminal(title); }
export { showTerminal, loadUpdates, loadHistory };
