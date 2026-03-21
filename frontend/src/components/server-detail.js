import { api } from '../api.js';
import { state, navigate, openGlobalTerminal } from '../main.js';
import { showToast, showConfirm } from './toast.js';
import { showAddServerModal } from './add-server-modal.js';
import { openSshTerminal } from './ssh-terminal.js';
import { t } from '../i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

// ============================================================
// Server Detail – Tab-based flat admin panel layout
// ============================================================

export async function renderServerDetail(serverId) {
  const main = document.querySelector('.main-content');
  if (!main) return;

  const server = state.servers.find(s => s.id === serverId) || await api.getServer(serverId);
  if (!server) { navigate('dashboard'); return; }

  const dotCls = server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown';
  const statusLabel = server.status === 'online' ? t('common.online') : server.status === 'offline' ? t('common.offline') : t('common.unknown');

  main.innerHTML = `
    <!-- Top strip -->
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px;">
        <button class="btn btn-secondary btn-sm" id="btn-back" title="${t('common.back')}">
          <i class="fas fa-arrow-left"></i>
        </button>
        <div>
          <h2 style="display:flex;align-items:center;gap:10px;">
            ${esc(server.name)}
            <span class="badge badge-${server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown'}">
              <span class="status-dot ${dotCls}"></span>${statusLabel}
            </span>
          </h2>
          <p class="text-mono">${esc(server.ip_address)}${server.hostname ? ' · ' + esc(server.hostname) : ''}</p>
        </div>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-secondary btn-sm" id="btn-edit-server"><i class="fas fa-edit"></i> ${t('common.edit')}</button>
        <button class="btn btn-secondary btn-sm" id="btn-terminal"><i class="fas fa-terminal"></i> ${t('common.terminal')}</button>
        <button class="btn btn-secondary btn-sm" id="btn-update-server"><i class="fas fa-arrow-up"></i> ${t('det.updates')}</button>
        <button class="btn btn-danger btn-sm" id="btn-reboot-server"><i class="fas fa-power-off"></i> ${t('det.reboot')}</button>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="overview">${t('det.tabOverview')}</button>
      <button class="tab-btn" data-tab="docker">${t('det.tabDocker')}</button>
      <button class="tab-btn" data-tab="updates">${t('det.tabUpdates')}</button>
      <button class="tab-btn" data-tab="history">${t('det.tabHistory')}</button>
      <button class="tab-btn" data-tab="notes">
        <i class="fas fa-sticky-note" style="margin-right:5px;"></i>${t('det.tabNotes')}
        ${server.notes?.trim() ? '<span class="nav-item-badge" style="margin-left:6px;" aria-label="has notes">●</span>' : ''}
      </button>
    </div>

    <!-- Tab panels -->
    <div class="page-content">
      <!-- Overview tab -->
      <div class="tab-panel active" id="tab-overview">
        <div class="overview-grid">
          <!-- System Info -->
          <div class="panel">
            <div class="section-header">
              <h3><i class="fas fa-info-circle"></i> ${t('det.sysinfo')}</h3>
            </div>
            <table class="info-table" id="info-table">
              <tr><td>${t('common.status')}</td><td id="inf-status">${t('det.loading')}</td></tr>
              <tr><td>${t('det.os')}</td><td id="inf-os">—</td></tr>
              <tr><td>${t('det.kernel')}</td><td id="inf-kernel">—</td></tr>
              <tr><td>${t('det.cpu')}</td><td id="inf-cpu">—</td></tr>
              <tr><td>${t('det.cores')}</td><td id="inf-cores">—</td></tr>
              <tr><td>${t('det.uptime')}</td><td id="inf-uptime">—</td></tr>
              <tr><td>${t('det.loadAvg')}</td><td id="inf-load">—</td></tr>
            </table>
          </div>

          <!-- Resources -->
          <div class="panel">
            <div class="section-header">
              <h3><i class="fas fa-chart-bar"></i> ${t('det.resources')}</h3>
            </div>
            <div id="res-content">
              <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
            </div>
          </div>
        </div>

        <!-- Terminal output -->
        <div id="terminal-container" style="margin-top:16px;display:none;">
          <div class="terminal">
            <div class="terminal-header">
              <div class="terminal-dots">
                <div class="terminal-dot red"></div>
                <div class="terminal-dot yellow"></div>
                <div class="terminal-dot green"></div>
              </div>
              <div class="terminal-title" id="terminal-title">Output</div>
            </div>
            <div class="terminal-body" id="terminal-body"></div>
          </div>
        </div>
      </div>

      <!-- Docker tab -->
      <div class="tab-panel" id="tab-docker">
        <div class="panel">
          <div class="section-header">
            <h3><i class="fas fa-cubes"></i> ${t('det.docker')}</h3>
            <div class="flex-gap">
              <button class="btn btn-secondary btn-sm" id="btn-refresh-docker" title="${t('common.refresh')}">
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-check-image-updates">
                <i class="fas fa-cloud-download-alt"></i> ${t('det.checkUpdates')}
              </button>
              <button class="btn btn-primary btn-sm" id="btn-add-compose-stack">
                <i class="fas fa-plus"></i> ${t('det.newStack')}
              </button>
            </div>
          </div>
          <div id="docker-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>

      <!-- Updates tab -->
      <div class="tab-panel" id="tab-updates">
        <div class="panel">
          <div class="section-header">
            <h3><i class="fas fa-box-open"></i> ${t('det.tabUpdates')}</h3>
            <button class="btn btn-secondary btn-sm" id="btn-refresh-updates" title="${t('common.refresh')}"><i class="fas fa-sync-alt"></i></button>
          </div>
          <div id="updates-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
        <div class="panel" style="margin-top:16px;">
          <div class="section-header">
            <h3><i class="fas fa-cog"></i> ${t('det.customUpdates')}</h3>
            <button class="btn btn-primary btn-sm" id="btn-add-custom-task"><i class="fas fa-plus"></i> ${t('det.addTask')}</button>
          </div>
          <div id="custom-updates-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>

      <!-- History tab -->
      <div class="tab-panel" id="tab-history">
        <div class="panel">
          <div class="section-header">
            <h3><i class="fas fa-history"></i> ${t('det.history')}</h3>
          </div>
          <div id="history-content">
            <div class="loading-state"><div class="loader"></div> ${t('det.loading')}</div>
          </div>
        </div>
      </div>

      <!-- Notes tab -->
      <div class="tab-panel" id="tab-notes">
        <div class="notes-layout">
          <div class="panel" style="flex:1;display:flex;flex-direction:column;min-height:0;">
            <div class="section-header">
              <h3><i class="fas fa-sticky-note"></i> ${t('det.tabNotes')}</h3>
              <span class="notes-saved-indicator" id="notes-status"></span>
            </div>
            <textarea
              class="notes-editor"
              id="notes-textarea"
              placeholder="${t('det.notesPlaceholder')}"
            ></textarea>
          </div>
        </div>
      </div>
    </div>
  `;

  // ---- Tab switching ----
  const tabBtns = main.querySelectorAll('.tab-btn');
  const tabPanels = main.querySelectorAll('.tab-panel');

  let dockerLoaded = false;
  let updatesLoaded = false;
  let historyLoaded = false;
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
      if (btn.dataset.tab === 'notes' && !notesLoaded) { setupNotesTab(serverId); notesLoaded = true; }
    });
  });

  // ---- Header actions ----
  document.getElementById('btn-back')?.addEventListener('click', () => navigate('dashboard'));

  document.getElementById('btn-edit-server')?.addEventListener('click', () => {
    showAddServerModal(() => { navigate('dashboard'); }, server);
  });

  document.getElementById('btn-terminal')?.addEventListener('click', () => {
    openSshTerminal(server);
  });

  document.getElementById('btn-update-server')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-update-server');
    if (!await showConfirm(t('det.confirmUpdate', { name: server.name }), { title: t('det.updates'), confirmText: t('det.updates') })) return;
    btn.disabled = true;
    openGlobalTerminal(`apt upgrade – ${server.name}`);
    try {
      await api.runUpdate(serverId);
      showToast(t('det.updateStarted'), 'success');
      loadHistory(serverId);
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
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('det.rebooting')}`;
    try {
      await api.runReboot(serverId);
      showToast(t('det.rebootStarted'), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-power-off"></i> ${t('det.reboot')}`;
    }
  });

  // ---- Load Overview eagerly ----
  loadServerInfo(serverId);
}

// ============================================================
// Overview – system info
// ============================================================
function renderServerInfo(info) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };

  const statusEl = document.getElementById('inf-status');
  if (statusEl) statusEl.innerHTML = info._cached
    ? `<span class="badge badge-unknown" title="${t('det.cached')}"><i class="fas fa-clock"></i> ${t('det.cached')}</span>`
    : `<span class="badge badge-online">${t('det.reachable')}</span>`;

  set('inf-os', info.os);
  set('inf-kernel', info.kernel);
  set('inf-cpu', info.cpu);
  set('inf-cores', info.cpu_cores ? info.cpu_cores + ' ' + t('det.cores') : '—');
  set('inf-uptime', info.uptime_seconds ? formatUptime(info.uptime_seconds) : '—');
  set('inf-load', info.load_avg || '—');

  const resEl = document.getElementById('res-content');
  if (!resEl) return;

  const ramPct  = info.ram_total_mb  ? Math.round((info.ram_used_mb  / info.ram_total_mb)  * 100) : 0;
  const diskPct = info.disk_total_gb ? Math.round((info.disk_used_gb / info.disk_total_gb) * 100) : 0;
  const cpuPct  = info.cpu_usage_pct ?? null;

  const bar = (pct) => `<div class="progress-fill${pct > 90 ? ' critical' : pct > 70 ? ' high' : ''}" style="width:${pct}%"></div>`;

  resEl.innerHTML = `
    ${cpuPct !== null ? `
    <div class="progress-row">
      <div class="progress-label">${t('det.cpu')}</div>
      <div class="progress-track">${bar(cpuPct)}</div>
      <div class="progress-value">${cpuPct}%</div>
    </div>` : ''}
    <div class="progress-row">
      <div class="progress-label">RAM</div>
      <div class="progress-track">${bar(ramPct)}</div>
      <div class="progress-value">${ramPct}%</div>
    </div>
    <div class="progress-row">
      <div class="progress-label">Disk</div>
      <div class="progress-track">${bar(diskPct)}</div>
      <div class="progress-value">${diskPct}%</div>
    </div>
    <div class="progress-row" style="border-bottom:none;">
      <div class="progress-label">RAM total</div>
      <div class="progress-track" style="border:none;background:none;"></div>
      <div class="progress-value" style="width:auto;font-size:11px;color:var(--text-muted);">${info.ram_total_mb ? Math.round(info.ram_total_mb / 1024) + ' GB' : '—'}</div>
    </div>
  `;
}

async function loadServerInfo(serverId) {
  try {
    const info = await api.getServerInfo(serverId);
    if (!info) return;
    renderServerInfo(info);

    // If cached, silently fetch fresh data in background
    if (info._cached) {
      api.getServerInfo(serverId, true)
        .then(fresh => { if (fresh && document.getElementById('inf-status')) renderServerInfo(fresh); })
        .catch(() => {});
    }
  } catch (e) {
    const el = document.getElementById('inf-status');
    if (el) el.innerHTML = `<span class="badge badge-offline">${t('common.errorPrefix', { msg: esc(e.message) })}</span>`;
  }
}

// ============================================================
// Docker Tab
// ============================================================
function renderDockerData(serverId, containers, imageUpdateMap = {}) {
  const content = document.getElementById('docker-content');
  if (!content) return;
  content.dataset.serverId = serverId;
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

  let html = `<table class="data-table"><thead><tr>
    <th style="width:8px;"></th><th>${t('common.name')}</th><th>${t('common.image')}</th><th>${t('common.status')}</th><th>${t('det.checkUpdates')}</th><th>${t('common.actions')}</th>
  </tr></thead><tbody>`;

  for (const [proj, data] of Object.entries(stacks)) {
    const allDown = data.containers.every(c => !c.status?.startsWith('Up'));
    html += `
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
          <button class="btn btn-secondary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="edit" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>
          <button class="btn btn-secondary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="pull" title="pull"><i class="fas fa-cloud-download-alt"></i></button>
          <button class="btn btn-primary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="up" title="up -d"><i class="fas fa-play"></i></button>
          <button class="btn btn-danger btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="down" title="down"><i class="fas fa-stop"></i></button>
        </td>
      </tr>`;
    data.containers.forEach(c => {
      if (c.container_name !== '[Stack Offline]') html += renderContainerRow(c, imageUpdateMap);
    });
  }

  if (standalone.length > 0) {
    html += `<tr class="group-header no-hover"><td colspan="6"><span style="display:inline-flex;align-items:center;gap:8px;"><i class="fas fa-cube" style="color:var(--text-muted);"></i><strong>Standalone</strong></span></td></tr>`;
    standalone.forEach(c => { html += renderContainerRow(c, imageUpdateMap); });
  }

  html += `</tbody></table>
  <div id="docker-logs-panel" class="hidden">
    <div class="section-header" style="border-top:1px solid var(--border);">
      <h3><i class="fas fa-file-alt"></i> Logs: <span id="logs-container-name"></span></h3>
      <div class="flex-gap">
        <select id="logs-tail-select" class="form-input" style="padding:3px 8px;font-size:12px;width:110px;">
          <option value="100">${t('pb.lines100')}</option>
          <option value="200" selected>${t('pb.lines200')}</option>
          <option value="500">${t('pb.lines500')}</option>
          <option value="1000">${t('pb.lines1000')}</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="btn-logs-refresh" title="${t('common.refresh')}"><i class="fas fa-sync-alt"></i></button>
        <button class="btn btn-secondary btn-sm" id="btn-logs-close" title="${t('common.close')}"><i class="fas fa-times"></i></button>
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
      if (!await showConfirm(t('det.confirmStackMsg', { name: esc(project), action: labels[action] || action }), { title: t('det.confirmStackTitle'), confirmText: t('common.run'), danger: action === 'down' })) return;
      openGlobalTerminal(`compose ${action.toUpperCase()}: ${project}`);
      try {
        await api.runDockerComposeAction(serverId, dir, action);
        setTimeout(() => loadDockerContainers(serverId), 4000);
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  });

  setupComposeBtn(serverId);

  const refreshUpdatesBtn = document.getElementById('btn-refresh-updates');
  if (refreshUpdatesBtn) {
    refreshUpdatesBtn.addEventListener('click', async () => {
      refreshUpdatesBtn.disabled = true;
      refreshUpdatesBtn.querySelector('i').classList.add('fa-spin');
      await loadUpdates(serverId)
        .catch(() => {})
        .finally(() => { refreshUpdatesBtn.disabled = false; refreshUpdatesBtn.querySelector('i').classList.remove('fa-spin'); });
    });
  }

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
        .catch(() => {})
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
        .catch(() => {});
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
        <button class="btn btn-secondary btn-sm logs-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.showLogs')}"><i class="fas fa-file-alt"></i></button>
        <button class="btn btn-secondary btn-sm restart-docker-btn" data-container="${esc(c.container_name)}" title="${t('det.containerRestarted')}"><i class="fas fa-sync-alt"></i></button>
      </td>
    </tr>
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
  const real   = clean.filter(u => !u.phased);
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
  const rows = (customTasks || []).map(task => {
    const statusCell = task.has_update
      ? `<span class="badge badge-warning" style="font-size:10px;"><i class="fas fa-arrow-up"></i> ${t('det.imageUpdateAvail')}</span>`
      : task.last_checked_at
      ? `<span style="font-size:11px;color:var(--online);"><i class="fas fa-check"></i> ${t('det.imageUpToDate')}</span>`
      : `<span style="font-size:11px;color:var(--text-muted);">—</span>`;
    const typeLabel = task.type === 'github'
      ? `<span style="font-size:11px;color:var(--text-muted);"><i class="fab fa-github"></i> GitHub</span>`
      : `<span style="font-size:11px;color:var(--text-muted);">Script</span>`;
    return `
      <tr class="no-hover">
        <td><strong>${esc(task.name)}</strong></td>
        <td>${typeLabel}</td>
        <td class="mono" style="font-size:11px;">${esc(task.current_version || '—')}</td>
        <td class="mono" style="font-size:11px;">${esc(task.last_version || '—')}</td>
        <td>${statusCell}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm custom-task-check" data-id="${esc(task.id)}" title="${t('det.checkNow')}"><i class="fas fa-sync-alt"></i></button>
          <button class="btn btn-primary btn-sm custom-task-run" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('det.runUpdate')}"><i class="fas fa-play"></i></button>
          <button class="btn btn-secondary btn-sm custom-task-edit" data-id="${esc(task.id)}" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm custom-task-delete" data-id="${esc(task.id)}" data-name="${esc(task.name)}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');

  const emptyRow = `<tr class="no-hover"><td colspan="6" style="color:var(--text-muted);font-size:13px;padding:12px 16px;">${t('det.noCustomTasks')}</td></tr>`;

  el.innerHTML = `
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
    <div class="modal" style="max-width:500px;width:100%;">
      <div class="modal-header">
        <h3>${isEdit ? t('det.editTask') : t('det.addTask')}</h3>
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
          </select>
          <div id="ctm-type-desc" style="margin-top:6px;font-size:12px;color:var(--text-muted);line-height:1.4;">
            ${task?.type === 'github' ? t('det.taskTypeGithubDesc') : t('det.taskTypeScriptDesc')}
          </div>
        </div>
        <div class="form-group" id="ctm-github-row" style="${task?.type === 'github' ? '' : 'display:none;'}">
          <label class="form-label">${t('det.taskGithubRepo')}</label>
          <input class="form-input mono" id="ctm-github-repo" value="${esc(task?.github_repo || '')}" placeholder="immich-app/immich">
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${t('det.taskGithubRepoHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('det.taskCheckCommand')}</label>
          <input class="form-input mono" id="ctm-check-cmd" value="${esc(task?.check_command || '')}" placeholder="immich --version">
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${t('det.taskCheckCommandHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('det.taskUpdateCommand')} <span style="color:var(--danger);font-size:11px;">*</span></label>
          <input class="form-input mono" id="ctm-update-cmd" value="${esc(task?.update_command || '')}" placeholder="https://get.glennr.nl/unifi/update/unifi-update.sh">
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">${t('det.taskUpdateCommandHint')}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="ctm-cancel">${t('common.cancel')}</button>
        <button class="btn btn-primary" id="ctm-save"><i class="fas fa-save"></i> ${t('common.save')}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('ctm-type').addEventListener('change', e => {
    const isGithub = e.target.value === 'github';
    document.getElementById('ctm-github-row').style.display = isGithub ? '' : 'none';
    document.getElementById('ctm-type-desc').textContent = isGithub ? t('det.taskTypeGithubDesc') : t('det.taskTypeScriptDesc');
  });

  const close = () => overlay.remove();
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
    };
    if (!data.name || !data.update_command) {
      showToast(t('common.errorPrefix', { msg: 'Name und Update-Befehl sind erforderlich' }), 'error');
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
      api.getCustomUpdateTasks(serverId),
    ]);
    renderUpdatesData(updates, customTasks, serverId);
    if (updates?.length > 0 && updates[0]?._cached) {
      api.getServerUpdates(serverId, true)
        .then(fresh => { if (document.getElementById('updates-content')) renderUpdatesData(fresh, customTasks, serverId); })
        .catch(() => {});
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
    const from  = (histPage - 1) * HIST_PAGE_SIZE;
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
          <tr><th>${t('det.colAction')}</th><th>${t('common.status')}</th><th>${t('det.colStarted')}</th><th>${t('det.colDone')}</th></tr>
        </thead>
        <tbody>
          ${items.map(h => {
            const statusCls = h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'warning';
            return `
              <tr class="no-hover">
                <td class="mono">${esc(h.action)}</td>
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
  if (!dateStr) return '—';
  try { return new Date(dateStr).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return dateStr; }
}

// ============================================================
// Notes Tab
// ============================================================
async function setupNotesTab(serverId) {
  const textarea = document.getElementById('notes-textarea');
  const status = document.getElementById('notes-status');
  if (!textarea) return;

  // Load from server
  try {
    const { notes } = await api.getServerNotes(serverId);
    textarea.value = notes;
  } catch {
    if (status) { status.textContent = 'Laden fehlgeschlagen'; status.className = 'notes-saved-indicator error'; }
  }
  textarea.focus();

  let debounceTimer = null;

  textarea.addEventListener('input', () => {
    if (status) { status.textContent = ''; status.className = 'notes-saved-indicator'; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await api.saveServerNotes(serverId, textarea.value);
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

// Kept for legacy compat
function showTerminal(title) { openGlobalTerminal(title); }
export { showTerminal };
