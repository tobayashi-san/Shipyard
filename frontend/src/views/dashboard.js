import { api } from '../api.js';
import { state } from '../app/state.js';
import { navigate } from '../app/router.js';
import { t } from '../i18n.js';
import { formatCurrentTime, formatDateTimeShort, esc, sanitizeHTML } from '../utils/format.js';

let dashboardAttentionOnly = false;

function renderCompactLinks(links = []) {
  if (!Array.isArray(links) || links.length === 0) return '';
  return `
    <div class="server-links server-links--compact" style="margin-top:6px;">
      ${links.slice(0, 3).map(link => `
        <a class="server-link-chip" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
          <span>${esc(link.name)}</span>
          <i class="fas fa-up-right-from-square"></i>
        </a>
      `).join('')}
      ${links.length > 3 ? `<span class="server-link-chip server-link-chip--muted">+${links.length - 3}</span>` : ''}
    </div>
  `;
}

function isMobileDashboardLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

// Called by background poller — only refreshes data, never rebuilds page shell
export async function refreshDashboardData() {
  if (!document.getElementById('dash-content')) return; // not on dashboard
  try {
    const data = await api.getDashboard();
    renderDashboardData(data);
  } catch { /* silently ignore — keep current view intact */ }
}

export async function renderDashboard() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  main.innerHTML = sanitizeHTML(`
    <div class="page-header">
      <div>
        <h2>${t('dash.title')}</h2>
        <p id="dash-timestamp">${t('common.loading')}</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-secondary btn-sm" id="btn-dash-refresh">
          <i class="fas fa-sync-alt"></i> ${t('common.refresh')}
        </button>
      </div>
    </div>
    <div class="page-content" id="dash-content">
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;margin-bottom:24px;">
        <div class="panel" style="height:140px;"><div class="skeleton" style="width:100%;height:100%;"></div></div>
        <div class="panel" style="height:140px;"><div class="skeleton" style="width:100%;height:100%;"></div></div>
        <div class="panel" style="height:140px;"><div class="skeleton" style="width:100%;height:100%;"></div></div>
        <div class="panel" style="height:140px;"><div class="skeleton" style="width:100%;height:100%;"></div></div>
      </div>
      <div class="panel" style="padding:24px;">
        <div class="skeleton-text" style="width:180px;height:20px;margin-bottom:24px;"></div>
        <div class="skeleton-text" style="margin-bottom:12px;"></div>
        <div class="skeleton-text" style="width:85%;margin-bottom:12px;"></div>
        <div class="skeleton-text" style="width:90%;margin-bottom:12px;"></div>
        <div class="skeleton-text" style="width:70%;"></div>
      </div>
    </div>
  `);

  document.getElementById('btn-dash-refresh')?.addEventListener('click', () => renderDashboard());

  try {
    const data = await api.getDashboard();
    renderDashboardData(data);
  } catch (e) {
    document.getElementById('dash-content').innerHTML = sanitizeHTML(
      `<div class="empty-state"><p class="inline-error-text">${t('common.errorPrefix', { msg: esc(e.message) })}</p></div>`
    );
  }
}

function renderDashboardData(data) {
  const { summary, servers, recentHistory } = data;
  const ts = document.getElementById('dash-timestamp');
  if (ts) ts.textContent = t('dash.updatedAt', { time: formatCurrentTime() });

  const mobileLayout = isMobileDashboardLayout();
  const attentionCount = servers.filter(needsAttention).length;
  if (dashboardAttentionOnly && attentionCount === 0) dashboardAttentionOnly = false;
  const visibleServers = dashboardAttentionOnly ? servers.filter(needsAttention) : servers;

  const alerts = [];
  servers.forEach(s => {
    if (s.status === 'offline') alerts.push({ level: 'error', icon: 'fa-times-circle', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertOffline', { name: '' }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.reboot_required) alerts.push({ level: 'warning', icon: 'fa-redo', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertReboot', { name: '' }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.disk_pct >= 85) alerts.push({ level: 'warning', icon: 'fa-hdd', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertDisk', { name: '', pct: s.disk_pct }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.ram_pct >= 90) alerts.push({ level: 'warning', icon: 'fa-memory', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertRam', { name: '', pct: s.ram_pct }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.updates_count > 0) alerts.push({ level: 'info', icon: 'fa-arrow-up', text: `<strong>${esc(s.name)}</strong> – ${t('dash.alertUpdates', { name: '', count: s.updates_count }).replace(' – ', '')}`, serverId: s.id, name: s.name });
    if (s.image_updates_count > 0) alerts.push({ level: 'info', icon: 'fa-cube', text: `<strong>${esc(s.name)}</strong> – ${t('dash.alertImageUpdates', { name: '', count: s.image_updates_count }).replace(' – ', '')}`, serverId: s.id, name: s.name });
    if (s.custom_updates_count > 0) alerts.push({ level: 'info', icon: 'fa-cog', text: `<strong>${esc(s.name)}</strong> – ${t('dash.alertCustomUpdates', { name: '', count: s.custom_updates_count }).replace(' – ', '')}`, serverId: s.id, name: s.name });
  });

  const content = document.getElementById('dash-content');
  if (!content) return;

  content.innerHTML = sanitizeHTML(`
    <!-- Stat Cards -->
    <div class="dash-stat-row">
      ${statCard({ icon: 'fa-server', value: summary.total, label: t('dash.totalServers'), color: '', footer: t('dash.statFooterReachable', { n: summary.online }) })}
      ${statCard({ icon: 'fa-check-circle', value: summary.online, label: t('dash.online'), color: 'success', footer: t('dash.statFooterOfTotal', { n: summary.total }) })}
      ${statCard({ icon: 'fa-times-circle', value: summary.offline, label: t('dash.offline'), color: summary.offline > 0 ? 'error' : '', footer: summary.offline > 0 ? t('dash.statFooterOfTotal', { n: summary.total }) : t('dash.statFooterAllClear') })}
      ${statCard({ icon: 'fa-redo', value: summary.rebootRequired, label: t('dash.needsReboot'), color: summary.rebootRequired > 0 ? 'warning' : '', footer: summary.rebootRequired > 0 ? t('dash.statFooterServers', { n: summary.rebootRequired }) : t('dash.statFooterAllClear') })}
      ${statCard({ icon: 'fa-arrow-up', value: summary.totalUpdates, label: t('dash.updatesAvailable'), color: summary.totalUpdates > 0 ? 'warning' : '', footer: summary.totalUpdates > 0 ? t('dash.statFooterOnServers', { n: servers.filter(s => s.updates_count > 0 || s.image_updates_count > 0 || s.custom_updates_count > 0).length }) : t('dash.statFooterAllClear') })}
      ${statCard({ icon: 'fa-exclamation-triangle', value: summary.criticalDisk + summary.criticalRam, label: t('dash.resourcesCritical'), color: (summary.criticalDisk + summary.criticalRam) > 0 ? 'error' : '', footer: (summary.criticalDisk + summary.criticalRam) > 0 ? t('dash.statFooterDiskRam', { disk: summary.criticalDisk, ram: summary.criticalRam }) : t('dash.statFooterAllClear') })}
    </div>

    <div class="dash-grid">

      <!-- Server Health -->
      <div class="dash-col-main">
        <div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-heartbeat"></i></div>
              <span class="dash-panel-title">${t('dash.serverHealth')}</span>
            </div>
            <div class="dash-panel-header-right">
              ${attentionCount > 0 ? `
                <button class="btn btn-secondary btn-sm ${dashboardAttentionOnly ? 'active' : ''}" id="btn-todo-filter">
                  <i class="fas fa-filter" style="margin-right:4px;"></i>${t('dash.needsAttention')}
                  <span class="nav-item-badge" style="margin-left:5px;">${attentionCount}</span>
                </button>` : ''}
            </div>
          </div>
          ${servers.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon"><i class="fas fa-server"></i></div>
              <h3>${t('dash.noServers')}</h3>
              <p>${t('dash.noServersHint')}</p>
              <button class="btn btn-primary" id="btn-empty-add-server" style="margin-top:8px;">
                <i class="fas fa-plus"></i> ${t('srv.add')}
              </button>
            </div>
          ` : mobileLayout ? `
            <div class="dash-server-list">
              ${visibleServers.map(s => serverHealthCard(s)).join('')}
            </div>
          ` : `
            <table class="data-table" style="table-layout:fixed;">
              <thead><tr>
                <th style="width:28px;"></th>
                <th>${t('common.name')}</th>
                <th style="width:175px;">${t('dash.colRam')}</th>
                <th style="width:175px;">${t('dash.colDisk')}</th>
                <th style="width:160px;">${t('dash.colCpu')}</th>
                <th style="width:90px;">${t('dash.colUptime')}</th>
                <th style="width:130px;">${t('dash.colUpdates')}</th>
              </tr></thead>
              <tbody>
                ${visibleServers.map(s => serverHealthRow(s)).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <!-- Right column -->
      <div class="dash-col-side">

        <!-- Alerts -->
        <div class="panel dash-panel" style="margin-bottom:20px;">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon dash-panel-icon--warning"><i class="fas fa-bell"></i></div>
              <span class="dash-panel-title">${t('dash.alerts')}</span>
              ${alerts.length > 0 ? `<span class="nav-item-badge" style="margin-left:2px;">${alerts.length}</span>` : ''}
            </div>
          </div>
          ${alerts.length === 0 ? `
            <div class="dash-empty-inline">
              <i class="fas fa-check-circle"></i> ${t('dash.allClear')}
            </div>
          ` : alerts.map(a => `
            <div class="dash-alert dash-alert-${a.level}" data-server-id="${a.serverId || ''}">
              <i class="fas ${a.icon}"></i>
              <span>${a.text}</span>
            </div>
          `).join('')}
        </div>

        <!-- Recent Activity -->
        <div class="panel dash-panel">
          <div class="dash-panel-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-clock"></i></div>
              <span class="dash-panel-title">${t('dash.recentActivity')}</span>
            </div>
          </div>
          ${recentHistory.length === 0 ? `
            <div class="dash-empty-muted">${t('dash.noActivity')}</div>
          ` : recentHistory.map(h => `
            <div class="dash-history-item">
              <span class="status-dot ${h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'unknown'}"></span>
              <div class="dash-history-body">
                <div class="dash-history-name">${esc(h.server_name || '–')}</div>
                <div class="dash-history-meta">${esc(h.action)} · ${formatRelativeTime(h.started_at)}</div>
              </div>
              <span class="badge badge-${h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'unknown'} dash-history-badge">${esc(h.status)}</span>
            </div>
          `).join('')}
        </div>

      </div>
    </div>
  `);

  // TODO filter toggle
  const filterBtn = document.getElementById('btn-todo-filter');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      dashboardAttentionOnly = !dashboardAttentionOnly;
      renderDashboardData(data);
    });
  }

  // Staggered entry animations (only on fresh data load)
  requestAnimationFrame(() => {
    content.querySelector('.dash-stat-row')?.classList.add('is-animated');
    content.querySelector('.dash-grid')?.classList.add('is-animated');
  });

  // Server-Row click
  content.querySelectorAll('.dashboard-server-link').forEach(row => {
    row.addEventListener('click', () => navigate('server-detail', { serverId: row.dataset.serverId }));
  });

  content.querySelectorAll('.server-link-chip[href]').forEach(link => {
    link.addEventListener('click', (event) => event.stopPropagation());
  });

  // Alert click → Server Detail
  content.querySelectorAll('.dash-alert[data-server-id]').forEach(el => {
    if (el.dataset.serverId) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => navigate('server-detail', { serverId: el.dataset.serverId }));
    }
  });

  document.getElementById('link-to-servers')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('servers');
  });

  document.getElementById('btn-empty-add-server')?.addEventListener('click', () => {
    navigate('servers');
  });
}

function statCard({ icon, value, label, color, footer }) {
  const colorAttr = color ? ` data-color="${color}"` : '';
  const iconCls = color === 'error' ? ' dash-stat-icon--error' :
                  color === 'warning' ? ' dash-stat-icon--warning' :
                  color === 'success' ? ' dash-stat-icon--success' : '';
  const valueCls = color === 'error' ? ' dash-stat-value--error' :
                   color === 'warning' ? ' dash-stat-value--warning' :
                   color === 'success' ? ' dash-stat-value--success' : '';
  const footerCls = color === 'error' ? ' dash-stat-footer-text--error' :
                    color === 'warning' ? ' dash-stat-footer-text--warning' :
                    color === 'success' ? ' dash-stat-footer-text--success' : '';
  return `
    <div class="dash-stat-card"${colorAttr}>
      <div class="dash-stat-header">
        <div class="dash-stat-icon${iconCls}"><i class="fas ${icon}"></i></div>
        <span class="dash-stat-label">${label}</span>
      </div>
      <div class="dash-stat-value${valueCls}">${value}</div>
      <div class="dash-stat-divider"></div>
      <div class="dash-stat-footer">
        <span class="dash-stat-footer-text${footerCls}">${footer}</span>
      </div>
    </div>
  `;
}

function serverHealthRow(s) {
  const dotCls = s.status === 'online' ? 'online' : s.status === 'offline' ? 'offline' : 'unknown';
  const ramBar = miniBar(s.ram_pct);
  const diskBar = miniBar(s.disk_pct);
  const cpuBar = miniBar(s.cpu_pct);
  const uptime = formatUptime(s.uptime_seconds);
  const tags = Array.isArray(s.tags) ? s.tags : [];
  const visibleTags = tags.slice(0, 3);

  return `
    <tr class="dashboard-server-link server-health-row" data-server-id="${s.id}" data-needs-attention="${needsAttention(s) ? '1' : '0'}">
      <td><span class="status-dot ${dotCls}"></span></td>
      <td>
        <div class="dash-server-name-line">
          <span class="dash-server-name">${esc(s.name)}</span>
          ${agentBadge(s)}
          <span class="dash-server-ip">${esc(s.ip_address)}</span>
        </div>
        ${visibleTags.length > 0 ? `
          <div class="server-tags-inline" style="margin-top:4px;">
            ${visibleTags.map(tag => `<span class="server-tag">${esc(tag)}</span>`).join('')}
            ${tags.length > visibleTags.length ? `<span class="server-tag">+${tags.length - visibleTags.length}</span>` : ''}
          </div>
        ` : ''}
        ${renderCompactLinks(s.links)}
      </td>
      <td>${ramBar}</td>
      <td>${diskBar}</td>
      <td>${cpuBar}</td>
      <td><span class="dash-uptime ${uptime === '—' ? 'empty-value' : ''}">${esc(uptime)}</span></td>
      <td>${updatesCell(s)}</td>
    </tr>
  `;
}

function serverHealthCard(s) {
  const dotCls = s.status === 'online' ? 'online' : s.status === 'offline' ? 'offline' : 'unknown';
  const statusLabel = s.status === 'online' ? t('common.online') : s.status === 'offline' ? t('common.offline') : t('common.unknown');
  const uptime = formatUptime(s.uptime_seconds);
  const tags = Array.isArray(s.tags) ? s.tags : [];
  const visibleTags = tags.slice(0, 4);

  return `
    <article class="dashboard-server-link dash-server-card" data-server-id="${s.id}" data-needs-attention="${needsAttention(s) ? '1' : '0'}">
      <div class="dash-server-card-header">
        <div class="dash-server-card-main">
          <div class="dash-server-card-title-line">
            <span class="status-dot ${dotCls}"></span>
            <span class="dash-server-card-title">${esc(s.name)}</span>
            <span class="badge badge-${dotCls}">${statusLabel}</span>
          </div>
          <div class="dash-server-card-meta">
            ${agentBadge(s)}
            <span class="mono dash-server-card-ip">${esc(s.ip_address)}</span>
            <span class="mono dash-server-card-uptime ${uptime === '—' ? 'empty-value' : ''}">${esc(uptime)}</span>
          </div>
          ${visibleTags.length > 0 ? `
            <div class="server-tags-inline">
              ${visibleTags.map(tag => `<span class="server-tag">${esc(tag)}</span>`).join('')}
              ${tags.length > visibleTags.length ? `<span class="server-tag">+${tags.length - visibleTags.length}</span>` : ''}
            </div>
          ` : ''}
          ${renderCompactLinks(s.links)}
        </div>
      </div>
      <div class="dash-server-card-metrics">
        ${mobileMetric(t('dash.colRam'), s.ram_pct)}
        ${mobileMetric(t('dash.colDisk'), s.disk_pct)}
        ${mobileMetric(t('dash.colCpu'), s.cpu_pct)}
      </div>
      <div class="dash-server-card-updates">
        ${updatesSummaryChips(s)}
      </div>
    </article>
  `;
}

function agentBadge(s) {
  const mode = s.agent_mode || 'legacy';
  const agentState = s.agent_state || 'legacy';
  if (mode === 'legacy') return '';
  const stateCls = agentState === 'ok' ? 'agent-mode-badge--ok' : agentState === 'warning' ? 'agent-mode-badge--warning' : 'agent-mode-badge--stale';
  const label = agentState === 'ok' ? t('dash.agentOk') : agentState === 'warning' ? t('dash.agentDelayed') : t('dash.agentStale');
  const title = `${t('dash.agentMode')}: ${mode} · ${label}`;
  return `<span class="badge agent-mode-badge ${stateCls}" title="${esc(title)}"><i class="fas fa-robot"></i>${esc(mode)}</span>`;
}

function miniBar(pct) {
  if (pct === null || pct === undefined) return '<span class="empty-value">—</span>';
  const cls = pct > 90 ? ' critical' : pct > 70 ? ' high' : '';
  return `
    <div class="mini-bar">
      <div class="progress-track">
        <div class="progress-fill${cls}" style="width:${pct}%;"></div>
      </div>
      <span class="mono">${pct}%</span>
    </div>
  `;
}

function mobileMetric(label, pct) {
  const cls = pct > 90 ? ' critical' : pct > 70 ? ' high' : '';
  return `
    <div class="dash-server-metric">
      <div class="dash-server-metric-head">
        <span>${label}</span>
        <span class="mono ${pct === null || pct === undefined ? 'empty-value' : ''}">${pct === null || pct === undefined ? '—' : `${pct}%`}</span>
      </div>
      <div class="progress-track dash-server-metric-track">
        <div class="progress-fill${cls}" style="width:${pct || 0}%;"></div>
      </div>
    </div>
  `;
}

function needsAttention(s) {
  return s.status === 'offline' ||
    s.reboot_required ||
    s.updates_count > 0 ||
    s.image_updates_count > 0 ||
    s.custom_updates_count > 0 ||
    s.disk_pct >= 85 ||
    s.ram_pct >= 90;
}

function updatesCell(s) {
  const parts = [];
  if (s.reboot_required)
    parts.push(`<span title="${t('dash.needsReboot')}" style="white-space:nowrap;"><i class="fas fa-redo" style="font-size:10px;margin-right:3px;"></i></span>`);
  if (s.updates_count > 0)
    parts.push(`<span title="${t('dash.colUpdates')}" style="white-space:nowrap;"><i class="fas fa-box" style="font-size:10px;margin-right:3px;"></i>${s.updates_count}</span>`);
  if (s.image_updates_count > 0)
    parts.push(`<span title="${t('dash.colImageUpdates')}" style="white-space:nowrap;"><i class="fas fa-cube" style="font-size:10px;margin-right:3px;"></i>${s.image_updates_count}</span>`);
  if (s.custom_updates_count > 0)
    parts.push(`<span title="${t('dash.colCustomUpdates')}" style="white-space:nowrap;"><i class="fas fa-cog" style="font-size:10px;margin-right:3px;"></i>${s.custom_updates_count}</span>`);
  if (parts.length === 0)
    return `<span class="updates-badge--ok" title="${t('dash.allClear')}"><i class="fas fa-check-circle"></i></span>`;
  return `<span class="badge badge-warning updates-badge">${parts.join('')}</span>`;
}

function updatesSummaryChips(s) {
  const chips = [];
  if (s.reboot_required) chips.push(`<span class="badge badge-warning"><i class="fas fa-redo"></i>${t('dash.needsReboot')}</span>`);
  if (s.updates_count > 0) chips.push(`<span class="badge badge-warning"><i class="fas fa-box"></i>${s.updates_count} ${t('dash.colUpdates')}</span>`);
  if (s.image_updates_count > 0) chips.push(`<span class="badge badge-warning"><i class="fas fa-cube"></i>${s.image_updates_count} ${t('dash.colImageUpdates')}</span>`);
  if (s.custom_updates_count > 0) chips.push(`<span class="badge badge-warning"><i class="fas fa-cog"></i>${s.custom_updates_count} ${t('dash.colCustomUpdates')}</span>`);
  if (chips.length === 0) {
    return `<span class="badge badge-online"><i class="fas fa-check-circle"></i>${t('dash.allClear')}</span>`;
  }
  return chips.join('');
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toUtcDate(dateStr) {
  if (!dateStr) return new Date(NaN);
  return new Date(!dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr);
}

function formatRelativeTime(dateStr) {
  try {
    const diff = Date.now() - toUtcDate(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('dash.justNow');
    if (mins < 60) return t('dash.minutesAgo', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('dash.hoursAgo', { n: hrs });
    return t('dash.daysAgo', { n: Math.floor(hrs / 24) });
  } catch { return '—'; }
}
