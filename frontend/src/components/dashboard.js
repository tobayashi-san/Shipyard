import { api } from '../api.js';
import { state, navigate } from '../main.js';
import { t } from '../i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function renderDashboard() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  main.innerHTML = `
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
      <div class="loading-state"><div class="loader"></div> ${t('dash.loading')}</div>
    </div>
  `;

  document.getElementById('btn-dash-refresh')?.addEventListener('click', () => renderDashboard());

  try {
    const data = await api.getDashboard();
    renderDashboardData(data);
  } catch (e) {
    document.getElementById('dash-content').innerHTML =
      `<div class="empty-state"><p style="color:var(--offline);">${t('common.errorPrefix', { msg: esc(e.message) })}</p></div>`;
  }
}

function renderDashboardData(data) {
  const { summary, servers, recentHistory } = data;
  const ts = document.getElementById('dash-timestamp');
  if (ts) ts.textContent = t('dash.updatedAt', { time: new Date().toLocaleTimeString() });

  const alerts = [];
  servers.forEach(s => {
    if (s.status === 'offline') alerts.push({ level: 'error', icon: 'fa-times-circle', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertOffline', { name: '' }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.reboot_required)     alerts.push({ level: 'warning', icon: 'fa-redo', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertReboot', { name: '' }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.disk_pct >= 85)      alerts.push({ level: 'warning', icon: 'fa-hdd', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertDisk', { name: '', pct: s.disk_pct }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.ram_pct >= 90)       alerts.push({ level: 'warning', icon: 'fa-memory', text: `<strong>${esc(s.name)}</strong> ${t('dash.alertRam', { name: '', pct: s.ram_pct }).replace(esc(s.name) + ' ', '')}`, serverId: s.id, name: s.name });
    if (s.updates_count > 0)        alerts.push({ level: 'info', icon: 'fa-arrow-up', text: `<strong>${esc(s.name)}</strong> – ${t('dash.alertUpdates', { name: '', count: s.updates_count }).replace(' – ', '')}`, serverId: s.id, name: s.name });
    if (s.image_updates_count > 0) alerts.push({ level: 'info', icon: 'fa-cube', text: `<strong>${esc(s.name)}</strong> – ${t('dash.alertImageUpdates', { name: '', count: s.image_updates_count }).replace(' – ', '')}`, serverId: s.id, name: s.name });
  });

  const content = document.getElementById('dash-content');
  if (!content) return;

  content.innerHTML = `
    <!-- Stat Cards -->
    <div class="dash-stat-row">
      ${statCard('fa-server', summary.total, t('dash.totalServers'), '')}
      ${statCard('fa-check-circle', summary.online, t('dash.online'), 'var(--online)')}
      ${statCard('fa-times-circle', summary.offline, t('dash.offline'), summary.offline > 0 ? 'var(--offline)' : '')}
      ${statCard('fa-redo', summary.rebootRequired, t('dash.needsReboot'), summary.rebootRequired > 0 ? 'var(--warning)' : '')}
      ${statCard('fa-arrow-up', summary.totalUpdates, t('dash.updatesAvailable'), summary.totalUpdates > 0 ? 'var(--warning)' : '')}
      ${statCard('fa-exclamation-triangle', summary.criticalDisk + summary.criticalRam, t('dash.resourcesCritical'), (summary.criticalDisk + summary.criticalRam) > 0 ? 'var(--offline)' : '')}
    </div>

    <div class="dash-grid">

      <!-- Server Health -->
      <div class="dash-col-main">
        <div class="dash-section-title">${t('dash.serverHealth')}</div>
        <div class="panel">
          ${servers.length === 0 ? `
            <div class="empty-state" style="padding:32px;">
              <div class="empty-state-icon"><i class="fas fa-server"></i></div>
              <h3>${t('dash.noServers')}</h3>
              <p>${t('dash.noServersHint').replace('Server', `<a href="#" id="link-to-servers">${t('nav.servers')}</a>`)}</p>
            </div>
          ` : `
            <table class="data-table">
              <thead><tr>
                <th style="width:10px;"></th>
                <th>${t('common.name')}</th>
                <th>${t('dash.colOs')}</th>
                <th style="width:100px;">${t('dash.colRam')}</th>
                <th style="width:100px;">${t('dash.colDisk')}</th>
                <th>${t('dash.colLoad')}</th>
                <th>${t('dash.colUptime')}</th>
                <th>${t('dash.colContainers')}</th>
                <th>${t('dash.colUpdates')}</th>
                <th>${t('dash.colImageUpdates')}</th>
              </tr></thead>
              <tbody>
                ${servers.map(s => serverHealthRow(s)).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <!-- Right column -->
      <div class="dash-col-side">

        <!-- Alerts -->
        <div class="dash-section-title">
          ${t('dash.alerts')}
          ${alerts.length > 0 ? `<span class="nav-item-badge" style="margin-left:6px;">${alerts.length}</span>` : ''}
        </div>
        <div class="panel" style="margin-bottom:20px;">
          ${alerts.length === 0 ? `
            <div style="padding:16px;display:flex;align-items:center;gap:8px;color:var(--online);font-size:13px;">
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
        <div class="dash-section-title">${t('dash.recentActivity')}</div>
        <div class="panel">
          ${recentHistory.length === 0 ? `
            <div style="padding:16px;font-size:13px;color:var(--text-muted);">${t('dash.noActivity')}</div>
          ` : recentHistory.map(h => `
            <div class="dash-history-item">
              <span class="status-dot ${h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'unknown'}" style="flex-shrink:0;margin-top:3px;"></span>
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:500;">${esc(h.server_name || '–')}</div>
                <div style="font-size:11px;color:var(--text-muted);">${esc(h.action)} · ${formatRelativeTime(h.started_at)}</div>
              </div>
              <span class="badge badge-${h.status === 'success' ? 'online' : h.status === 'failed' ? 'offline' : 'unknown'}" style="font-size:10px;">${esc(h.status)}</span>
            </div>
          `).join('')}
        </div>

      </div>
    </div>
  `;

  // Server-Row click
  content.querySelectorAll('.server-health-row').forEach(row => {
    row.addEventListener('click', () => navigate('server-detail', { serverId: row.dataset.serverId }));
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
}

function statCard(icon, value, label, color) {
  return `
    <div class="dash-stat-card">
      <div class="dash-stat-icon"><i class="fas ${icon}"></i></div>
      <div class="dash-stat-value" style="${color ? `color:${color}` : ''}">${value}</div>
      <div class="dash-stat-label">${label}</div>
    </div>
  `;
}

function serverHealthRow(s) {
  const dotCls = s.status === 'online' ? 'online' : s.status === 'offline' ? 'offline' : 'unknown';
  const ramBar = miniBar(s.ram_pct);
  const diskBar = miniBar(s.disk_pct);
  const osShort = s.os ? s.os.replace(/[0-9]+\.[0-9]+(\.[0-9]+)?/g, '').replace('Linux', '').replace('GNU/', '').trim().split(' ').slice(0, 2).join(' ') : '—';
  const uptime = s.uptime_seconds ? formatUptime(s.uptime_seconds) : '—';
  const load = s.load_avg ? s.load_avg.split(' ')[0] : '—';

  return `
    <tr class="server-health-row" data-server-id="${s.id}" style="cursor:pointer;">
      <td><span class="status-dot ${dotCls}"></span></td>
      <td>
        <strong>${esc(s.name)}</strong>
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${esc(s.ip_address)}</div>
      </td>
      <td style="font-size:12px;color:var(--text-muted);">${esc(osShort)}</td>
      <td>${ramBar}</td>
      <td>${diskBar}</td>
      <td style="font-family:var(--font-mono);font-size:12px;">${load}</td>
      <td style="font-size:12px;color:var(--text-muted);">${uptime}</td>
      <td style="font-size:12px;">${s.containers_running > 0 ? `<span style="color:var(--online);">${s.containers_running}</span><span style="color:var(--text-muted);">/${s.containers_total}</span>` : '<span style="color:var(--text-muted);">—</span>'}</td>
      <td>${s.updates_count > 0 ? `<span class="badge badge-warning" style="font-size:10px;">${s.updates_count}</span>` : '<span style="color:var(--text-muted);font-size:12px;">—</span>'}</td>
      <td>${s.image_updates_count > 0 ? `<span class="badge badge-warning" style="font-size:10px;"><i class="fas fa-cube"></i> ${s.image_updates_count}</span>` : '<span style="color:var(--text-muted);font-size:12px;">—</span>'}</td>
    </tr>
  `;
}

function miniBar(pct) {
  if (pct === null || pct === undefined) return '<span style="color:var(--text-muted);font-size:12px;">—</span>';
  const cls = pct > 90 ? ' critical' : pct > 70 ? ' high' : '';
  return `
    <div style="display:flex;align-items:center;gap:5px;">
      <div class="progress-track" style="height:5px;width:60px;flex-shrink:0;">
        <div class="progress-fill${cls}" style="width:${pct}%;"></div>
      </div>
      <span style="font-family:var(--font-mono);font-size:11px;width:30px;">${pct}%</span>
    </div>
  `;
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

function formatRelativeTime(dateStr) {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('dash.justNow');
    if (mins < 60) return t('dash.minutesAgo', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('dash.hoursAgo', { n: hrs });
    return t('dash.daysAgo', { n: Math.floor(hrs / 24) });
  } catch { return '—'; }
}
