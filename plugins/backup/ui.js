// ── State ──────────────────────────────────────────────────────────────────
let _container   = null;
let _pluginApi   = null;
let _showToast   = null;
let _showConfirm = null;
let _mainTab     = 'overview'; // 'overview' | 'settings'
let _instances   = [];
let _statuses    = {};   // id -> status data
let _loading     = true;
let _refreshTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(dt) {
  if (!dt) return '—';
  try {
    const d = new Date(dt);
    if (isNaN(d)) return dt;
    return d.toLocaleString();
  } catch { return dt; }
}
function fmtDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end) - new Date(start);
  if (isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function statusColor(s) {
  switch (s) {
    case 'ok':      return 'online';
    case 'success': return 'online';
    case 'warning': return 'warning';
    case 'running': return 'warning';
    case 'failed':  return 'offline';
    case 'error':   return 'offline';
    default:        return '';
  }
}
function statusIcon(s) {
  switch (s) {
    case 'ok':      return 'fa-circle-check';
    case 'success': return 'fa-circle-check';
    case 'warning': return 'fa-triangle-exclamation';
    case 'running': return 'fa-rotate fa-spin';
    case 'failed':  return 'fa-circle-xmark';
    case 'error':   return 'fa-circle-xmark';
    default:        return 'fa-circle-question';
  }
}
function typeLabel(t) {
  return t === 'veeam' ? 'Veeam B&R' : 'Proxmox BS';
}
function typeIcon(t) {
  return t === 'veeam' ? 'fas fa-v' : 'fas fa-server';
}

// ── Mount / Unmount ───────────────────────────────────────────────────────
export async function mount(container, { pluginApi, showToast, showConfirm }) {
  _container   = container;
  _pluginApi   = pluginApi;
  _showToast   = showToast;
  _showConfirm = showConfirm;
  _mainTab     = 'overview';
  _statuses    = {};
  _loading     = true;

  render();
  await loadAll();

  // Auto-refresh every 60s
  _refreshTimer = setInterval(() => { if (_mainTab === 'overview') refreshStatuses(); }, 60000);
}

export function unmount() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  _container = null;
}

// ── Data loading ──────────────────────────────────────────────────────────
async function loadAll() {
  try {
    _instances = await _pluginApi.request('/instances');
  } catch {
    _instances = [];
  }
  _loading = false;
  render();
  await refreshStatuses();
}

async function refreshStatuses() {
  if (!_container) return;
  if (_instances.length === 0) return;
  try {
    const results = await _pluginApi.request('/status');
    _statuses = {};
    for (const r of results) _statuses[r.id] = r;
    renderOverview();
  } catch {}
}

// ── Rendering ─────────────────────────────────────────────────────────────
function render() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="plugin-backup" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div class="backup-header">
        <div style="display:flex;align-items:center;gap:16px;">
          <h2 style="margin:0;font-size:18px;font-weight:600;">
            <i class="fas fa-shield-halved" style="margin-right:8px;color:var(--accent);"></i>Backup Status
          </h2>
          <div class="tab-bar" style="margin:0;">
            <button class="tab-btn ${_mainTab==='overview'?'active':''}" data-tab="overview">
              <i class="fas fa-gauge-high"></i> Overview
            </button>
            <button class="tab-btn ${_mainTab==='settings'?'active':''}" data-tab="settings">
              <i class="fas fa-gear"></i> Instances
            </button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-secondary btn-sm" id="backup-refresh">
            <i class="fas fa-rotate"></i> Refresh
          </button>
        </div>
      </div>
      <div id="backup-body" style="flex:1;overflow-y:auto;padding:20px;"></div>
    </div>`;

  _container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { _mainTab = btn.dataset.tab; render(); if (_mainTab === 'overview') refreshStatuses(); });
  });
  _container.querySelector('#backup-refresh')?.addEventListener('click', () => refreshStatuses());

  if (_mainTab === 'overview') renderOverview();
  else renderSettings();
}

function renderOverview() {
  const body = _container?.querySelector('#backup-body');
  if (!body) return;

  if (_loading) {
    body.innerHTML = `<div class="loading-state" style="padding:48px;"><div class="loader"></div></div>`;
    return;
  }

  if (_instances.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-shield-halved" style="font-size:32px;margin-bottom:12px;color:var(--text-muted);display:block;"></i>
        <p>No backup instances configured.</p>
        <button class="btn btn-primary" id="go-settings" style="margin-top:8px;">
          <i class="fas fa-plus"></i> Add Instance
        </button>
      </div>`;
    body.querySelector('#go-settings')?.addEventListener('click', () => { _mainTab = 'settings'; render(); });
    return;
  }

  const cards = _instances.map(inst => {
    const st = _statuses[inst.id];
    return renderInstanceCard(inst, st);
  }).join('');

  body.innerHTML = `<div class="backup-cards">${cards}</div>`;

  _instances.forEach(inst => {
    const jobsEl = body.querySelector(`#jobs-${inst.id}`);
    if (!jobsEl) return;
    jobsEl.addEventListener('click', () => {
      const panel = body.querySelector(`#job-list-${inst.id}`);
      if (!panel) return;
      const hidden = panel.style.display === 'none';
      panel.style.display = hidden ? 'block' : 'none';
      jobsEl.querySelector('i')?.classList.toggle('fa-chevron-down', !hidden);
      jobsEl.querySelector('i')?.classList.toggle('fa-chevron-up', hidden);
    });
  });
}

function renderInstanceCard(inst, st) {
  const loading = !st;
  const status  = st?.status || 'unknown';
  const color   = statusColor(status);
  const icon    = statusIcon(status);
  const summary = st?.summary || {};
  const jobs    = st?.jobs || [];
  const error   = st?.error;

  const summaryHtml = error ? `
    <div style="font-size:12px;color:var(--offline);margin-top:6px;">
      <i class="fas fa-circle-xmark"></i> ${esc(error)}
    </div>` : `
    <div class="backup-summary">
      <span class="backup-pill backup-pill-ok"><i class="fas fa-check"></i> ${summary.ok ?? 0} OK</span>
      ${(summary.warning ?? 0) > 0 ? `<span class="backup-pill backup-pill-warn"><i class="fas fa-triangle-exclamation"></i> ${summary.warning} Warn</span>` : ''}
      ${(summary.failed  ?? 0) > 0 ? `<span class="backup-pill backup-pill-fail"><i class="fas fa-xmark"></i> ${summary.failed} Failed</span>` : ''}
      ${(summary.running ?? 0) > 0 ? `<span class="backup-pill backup-pill-run"><i class="fas fa-rotate fa-spin"></i> ${summary.running} Running</span>` : ''}
    </div>`;

  const jobRows = jobs.slice(0, 20).map(j => {
    const jc = statusColor(j.status);
    return `
      <tr>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(j.name)}">${esc(j.name)}</td>
        <td><span class="badge badge-${jc}" style="font-size:11px;">${esc(j.status)}</span></td>
        <td style="color:var(--text-muted);font-size:12px;">${esc(j.type || '')}</td>
        <td style="color:var(--text-muted);font-size:12px;white-space:nowrap;">${fmt(j.start_time)}</td>
        <td style="color:var(--text-muted);font-size:12px;">${fmtDuration(j.start_time, j.end_time)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="backup-card">
      <div class="backup-card-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="status-dot ${color}" style="width:10px;height:10px;border-radius:50%;flex-shrink:0;"></div>
          <div>
            <div style="font-weight:600;font-size:15px;">${esc(inst.name)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:1px;">
              <span class="badge" style="font-size:10px;background:var(--bg-secondary);color:var(--text-muted);">${esc(typeLabel(inst.type))}</span>
              <span style="margin-left:6px;">${esc(inst.url)}</span>
            </div>
          </div>
        </div>
        ${loading ? `<div class="loader" style="width:18px;height:18px;"></div>` : `
          <i class="fas ${icon}" style="font-size:20px;color:var(--${color || 'text-muted'});"></i>
        `}
      </div>

      ${summaryHtml}

      ${jobs.length > 0 ? `
        <button class="backup-jobs-toggle" id="jobs-${inst.id}" style="margin-top:10px;">
          <i class="fas fa-chevron-down"></i>
          Recent jobs (${jobs.length})
        </button>
        <div id="job-list-${inst.id}" style="display:none;margin-top:8px;overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;">
                <th style="text-align:left;padding:4px 8px 4px 0;">Job</th>
                <th style="text-align:left;padding:4px 8px;">Status</th>
                <th style="text-align:left;padding:4px 8px;">Type</th>
                <th style="text-align:left;padding:4px 8px;">Started</th>
                <th style="text-align:left;padding:4px 8px;">Duration</th>
              </tr>
            </thead>
            <tbody>${jobRows}</tbody>
          </table>
        </div>
      ` : ''}
    </div>`;
}

// ── Settings / Instance management ────────────────────────────────────────
function renderSettings() {
  const body = _container?.querySelector('#backup-body');
  if (!body) return;

  const rows = _instances.map(inst => `
    <tr>
      <td style="font-weight:500;">${esc(inst.name)}</td>
      <td><span class="badge" style="font-size:11px;background:var(--bg-secondary);color:var(--text-muted);">${esc(typeLabel(inst.type))}</span></td>
      <td style="color:var(--text-muted);font-size:13px;">${esc(inst.url)}</td>
      <td style="color:var(--text-muted);font-size:13px;">${esc(inst.username || '—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" data-edit="${esc(inst.id)}" style="margin-right:4px;">
          <i class="fas fa-pen"></i>
        </button>
        <button class="btn btn-secondary btn-sm" data-delete="${esc(inst.id)}" data-name="${esc(inst.name)}">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>`).join('');

  body.innerHTML = `
    <div style="max-width:860px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;font-size:15px;font-weight:600;">Backup Instances</h3>
        <button class="btn btn-primary btn-sm" id="add-instance">
          <i class="fas fa-plus"></i> Add Instance
        </button>
      </div>
      ${_instances.length === 0 ? `
        <div class="empty-state empty-state-sm">
          <p>No instances configured yet.</p>
        </div>` : `
        <div class="table-wrapper">
          <table class="data-table">
            <thead><tr>
              <th>Name</th><th>Type</th><th>URL</th><th>Username</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}
    </div>`;

  body.querySelector('#add-instance')?.addEventListener('click', () => showInstanceForm(null));
  body.querySelectorAll('[data-edit]').forEach(btn => {
    const id = btn.dataset.edit;
    btn.addEventListener('click', () => showInstanceForm(_instances.find(i => i.id === id)));
  });
  body.querySelectorAll('[data-delete]').forEach(btn => {
    const { delete: id, name } = btn.dataset;
    btn.addEventListener('click', () => deleteInstance(id, name));
  });
}

// ── Instance form ─────────────────────────────────────────────────────────
function showInstanceForm(inst) {
  const isEdit = !!inst;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `
    <div class="modal modal-md active">
      <div class="modal-header">
        <span class="modal-title">${isEdit ? 'Edit' : 'Add'} Backup Instance</span>
        <button class="modal-close" id="bk-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" id="bk-name" type="text" placeholder="My PBS Server" value="${esc(inst?.name||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="bk-type">
            <option value="pbs"   ${(!inst||inst.type==='pbs')  ?'selected':''}>Proxmox Backup Server (PBS)</option>
            <option value="veeam" ${inst?.type==='veeam'?'selected':''}>Veeam Backup &amp; Replication</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">URL</label>
          <input class="form-input" id="bk-url" type="url"
            placeholder="${(!inst||inst.type!=='veeam') ? 'https://pbs.example.com:8007' : 'https://veeam.example.com:9419'}"
            value="${esc(inst?.url||'')}">
          <p class="form-hint" id="bk-url-hint" style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">
            PBS default port: 8007
          </p>
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input class="form-input" id="bk-user" type="text"
            placeholder="${(!inst||inst.type!=='veeam') ? 'root@pam' : 'administrator'}"
            value="${esc(inst?.username||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Password ${isEdit ? '<span style="font-size:11px;color:var(--text-muted);font-weight:400;">(leave blank to keep existing)</span>' : ''}</label>
          <input class="form-input" id="bk-pw" type="password" autocomplete="new-password" placeholder="••••••••">
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
            <input type="checkbox" id="bk-tls" ${inst?.skip_tls?'checked':''} style="width:16px;height:16px;">
            Skip TLS certificate verification (self-signed certs)
          </label>
        </div>
        <p class="login-error hidden" id="bk-error"></p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="bk-test"><i class="fas fa-plug"></i> Test Connection</button>
        <div style="flex:1;"></div>
        <button class="btn btn-secondary" id="bk-cancel">Cancel</button>
        <button class="btn btn-primary" id="bk-save">
          <i class="fas fa-check"></i> ${isEdit ? 'Save' : 'Add'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const typeEl = overlay.querySelector('#bk-type');
  const urlHint = overlay.querySelector('#bk-url-hint');
  const urlEl  = overlay.querySelector('#bk-url');
  const userEl = overlay.querySelector('#bk-user');
  typeEl.addEventListener('change', () => {
    const isVeeam = typeEl.value === 'veeam';
    urlHint.textContent = isVeeam ? 'Veeam default port: 9419' : 'PBS default port: 8007';
    if (!urlEl.value) urlEl.placeholder = isVeeam ? 'https://veeam.example.com:9419' : 'https://pbs.example.com:8007';
    userEl.placeholder = isVeeam ? 'administrator' : 'root@pam';
  });

  function closeModal() { overlay.remove(); }
  overlay.querySelector('#bk-close')?.addEventListener('click', closeModal);
  overlay.querySelector('#bk-cancel')?.addEventListener('click', closeModal);

  overlay.querySelector('#bk-test')?.addEventListener('click', async () => {
    const testBtn = overlay.querySelector('#bk-test');
    const errEl   = overlay.querySelector('#bk-error');
    errEl.classList.add('hidden');
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="spinner-sm"></span> Testing…';
    try {
      const res = await _pluginApi.request('/test', {
        method: 'POST',
        body: {
          type:     typeEl.value,
          url:      overlay.querySelector('#bk-url').value.trim(),
          username: overlay.querySelector('#bk-user').value.trim(),
          password: overlay.querySelector('#bk-pw').value,
          skip_tls: overlay.querySelector('#bk-tls').checked,
        },
      });
      if (res.success) {
        _showToast(`Connection OK — ${(res.summary?.total ?? '?')} recent jobs found.`, 'success');
      } else {
        errEl.textContent = res.error || 'Connection failed';
        errEl.classList.remove('hidden');
      }
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
    testBtn.disabled = false;
    testBtn.innerHTML = '<i class="fas fa-plug"></i> Test Connection';
  });

  overlay.querySelector('#bk-save')?.addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bk-save');
    const errEl   = overlay.querySelector('#bk-error');
    const payload = {
      name:     overlay.querySelector('#bk-name').value.trim(),
      type:     typeEl.value,
      url:      overlay.querySelector('#bk-url').value.trim(),
      username: overlay.querySelector('#bk-user').value.trim(),
      password: overlay.querySelector('#bk-pw').value,
      skip_tls: overlay.querySelector('#bk-tls').checked,
    };
    if (!payload.name || !payload.url) {
      errEl.textContent = 'Name and URL are required.';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-sm"></span>';
    try {
      if (isEdit) {
        await _pluginApi.request(`/instances/${inst.id}`, { method: 'PUT', body: payload });
      } else {
        await _pluginApi.request('/instances', { method: 'POST', body: payload });
      }
      closeModal();
      _instances = await _pluginApi.request('/instances');
      renderSettings();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<i class="fas fa-check"></i> ${isEdit ? 'Save' : 'Add'}`;
    }
  });
}

async function deleteInstance(id, name) {
  const ok = await _showConfirm(`Delete "${name}"?`, 'This backup instance will be removed.');
  if (!ok) return;
  try {
    await _pluginApi.request(`/instances/${id}`, { method: 'DELETE', body: {} });
    _instances = _instances.filter(i => i.id !== id);
    delete _statuses[id];
    renderSettings();
  } catch (e) {
    _showToast(`Error: ${e.message}`, 'error');
  }
}
