import { api } from '../api.js';
import { state, navigate, openGlobalTerminal } from '../main.js';
import { showToast, showConfirm } from './toast.js';
import { showAddServerModal } from './add-server-modal.js';
import { openSshTerminal } from './ssh-terminal.js';
import { t } from '../i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
        ${server.notes?.trim() ? '<span class="nav-item-badge" style="margin-left:6px;" aria-label="hat Notizen">●</span>' : ''}
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
            <h3><i class="fab fa-docker"></i> ${t('det.docker')}</h3>
            <button class="btn btn-primary btn-sm" id="btn-add-compose-stack">
              <i class="fas fa-plus"></i> ${t('det.newStack')}
            </button>
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
          </div>
          <div id="updates-content">
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
function renderDockerData(serverId, containers) {
  const content = document.getElementById('docker-content');
  if (!content) return;
  if (!containers || containers.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fab fa-docker"></i></div><h3>${t('det.noContainers')}</h3><p>Docker ist nicht installiert oder hat keine Container.</p></div>`;
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
    <th style="width:8px;"></th><th>${t('common.name')}</th><th>Image</th><th>${t('common.status')}</th><th>Details</th><th>Aktionen</th>
  </tr></thead><tbody>`;

  for (const [proj, data] of Object.entries(stacks)) {
    const allDown = data.containers.every(c => !c.status?.startsWith('Up'));
    html += `
      <tr class="group-header no-hover">
        <td colspan="4">
          <span style="display:inline-flex;align-items:center;gap:8px;">
            <i class="fas fa-layer-group" style="color:var(--accent);"></i>
            <strong>${esc(proj)}</strong>
            <span class="mono" style="font-weight:400;color:var(--text-muted);font-size:11px;">${esc(data.dir)}</span>
            ${allDown ? `<span class="badge badge-offline" style="font-size:10px;">${t('common.offline')}</span>` : ''}
          </span>
        </td>
        <td></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="edit" title="${t('common.edit')}"><i class="fas fa-edit"></i></button>
          <button class="btn btn-secondary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="pull" title="pull"><i class="fas fa-cloud-download-alt"></i></button>
          <button class="btn btn-primary btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="up" title="up -d"><i class="fas fa-play"></i></button>
          <button class="btn btn-danger btn-sm compose-action-btn" data-project="${esc(proj)}" data-dir="${esc(data.dir)}" data-action="down" title="down"><i class="fas fa-stop"></i></button>
        </td>
      </tr>`;
    data.containers.forEach(c => {
      if (c.container_name !== '[Stack Offline]') html += renderContainerRow(c);
    });
  }

  if (standalone.length > 0) {
    html += `<tr class="group-header no-hover"><td colspan="6"><span style="display:inline-flex;align-items:center;gap:8px;"><i class="fas fa-cube" style="color:var(--text-muted);"></i><strong>Standalone</strong></span></td></tr>`;
    standalone.forEach(c => { html += renderContainerRow(c); });
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
}

async function loadDockerContainers(serverId) {
  const content = document.getElementById('docker-content');
  if (!content) return;
  try {
    const containers = await api.getServerDocker(serverId);
    renderDockerData(serverId, containers);
    if (containers?.length > 0 && containers[0]?._cached) {
      api.getServerDocker(serverId, true)
        .then(fresh => { if (document.getElementById('docker-content')) renderDockerData(serverId, fresh); })
        .catch(() => {});
    }
  } catch (error) {
    content.innerHTML = `<div class="empty-state"><p style="color:var(--offline);">${t('common.errorPrefix', { msg: esc(error.message) })}</p></div>`;
  }
}

function renderContainerRow(c) {
  const isUp = c.status?.startsWith('Up');
  const dotCls = isUp ? 'online' : 'offline';
  return `
    <tr class="no-hover" style="padding-left:20px;">
      <td style="padding-left:24px;"><span class="status-dot ${dotCls}"></span></td>
      <td><span class="mono">${esc(c.container_name)}</span></td>
      <td class="mono" style="color:var(--text-muted);font-size:11px;">${esc(c.image)}</td>
      <td><span style="font-size:12px;color:${isUp ? 'var(--online)' : 'var(--offline)'};">${esc(c.status || c.state)}</span></td>
      <td style="font-size:11px;color:var(--text-muted);">${c.created_at_container ? new Date(c.created_at_container).toLocaleDateString() : ''}</td>
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

// ============================================================
// Updates Tab
// ============================================================
function renderUpdatesData(updates) {
  const el = document.getElementById('updates-content');
  if (!el) return;
  const cached = updates?.length > 0 && updates[0]?._cached;
  const clean = (updates || []).map(({ _cached, ...u }) => u);
  if (clean.length === 0) {
    el.innerHTML = `<div style="padding:16px;display:flex;align-items:center;gap:8px;color:var(--online);font-size:13px;"><i class="fas fa-check-circle"></i> ${t('det.allUpToDate')}${cached ? ` <span style="color:var(--text-muted);font-size:11px;">(${t('det.cached')})</span>` : ''}</div>`;
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
}

async function loadUpdates(serverId) {
  const el = document.getElementById('updates-content');
  if (!el) return;
  try {
    const updates = await api.getServerUpdates(serverId);
    renderUpdatesData(updates);
    if (updates?.length > 0 && updates[0]?._cached) {
      api.getServerUpdates(serverId, true)
        .then(fresh => { if (document.getElementById('updates-content')) renderUpdatesData(fresh); })
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
