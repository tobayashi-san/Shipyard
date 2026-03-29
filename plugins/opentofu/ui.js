// ── State ─────────────────────────────────────────────────────────────────
let _container   = null;
let _wsUnsub     = null;
let _workspaces  = [];
let _selected    = null;   // workspace id
let _wsTab       = 'runs'; // sub-tab within workspace
let _mainTab     = 'dashboard'; // 'dashboard' | 'workspaces'
let _runId       = null;   // active WebSocket run id
let _pluginApi   = null;
let _api         = null;
let _navigate    = null;
let _refreshServersState = null;
let _showToast   = null;
let _showConfirm = null;
let _openFile    = null;   // { path, content, dirty }
let _fileTree    = null;
let _status      = null;
let _runsPage    = 1;
let _runsPageSize = 5;

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'').replace(/\r/g,'');
}
function fmt(dt) {
  if (!dt) return '—';
  const d = new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  return d.toLocaleString();
}
function preBlock(code) {
  return `<pre style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);
    padding:10px 14px;font-family:var(--font-mono);font-size:12px;line-height:1.5;overflow-x:auto;
    white-space:pre;margin:0;color:var(--text-primary);">${esc(code)}</pre>`;
}
function statusBadge(run) {
  if (!run) return `<span class="badge" style="background:var(--bg-secondary);color:var(--text-muted);">No runs</span>`;
  const colors = { success:'online', failed:'offline', running:'warning' };
  return `<span class="badge badge-${colors[run.status] || 'warning'}">${esc(run.status)}</span>`;
}
function actionBadge(action) {
  const icons = { plan:'fa-eye', apply:'fa-check-double', destroy:'fa-bomb', init:'fa-download', validate:'fa-spell-check' };
  return `<i class="fas ${icons[action] || 'fa-play'}" style="margin-right:4px;"></i>${esc(action)}`;
}
function fileIcon(name) {
  if (name.endsWith('.tf'))           return 'fas fa-cube';
  if (name.endsWith('.tfvars') || name.endsWith('.tfvars.json')) return 'fas fa-sliders-h';
  if (name.endsWith('.json'))         return 'fas fa-file-code';
  if (name.endsWith('.md'))           return 'fas fa-file-alt';
  return 'fas fa-file';
}

// ── Mount / Unmount ───────────────────────────────────────────────────────
export async function mount(container, { api, pluginApi, navigate, refreshServersState, showToast, showConfirm, onWsMessage }) {
  _container   = container;
  _pluginApi   = pluginApi;
  _api         = api;
  _navigate    = navigate || (() => {});
  _refreshServersState = refreshServersState || null;
  _showToast   = showToast;
  _showConfirm = showConfirm;
  _wsUnsub = onWsMessage(handleWsMessage);

  container.innerHTML = `<div class="loading-state" style="padding:48px;"><div class="loader"></div></div>`;

  try {
    const [status, workspaces] = await Promise.all([
      pluginApi.request('/status'),
      pluginApi.request('/workspaces'),
    ]);
    _status     = status;
    _workspaces = workspaces;
    renderApp();
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${esc(e.message)}</p></div>`;
  }
}

export function unmount() {
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
  _refreshServersState = null;
  _container = _selected = _runId = _fileTree = _openFile = null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────
async function handleWsMessage(msg) {
  if (msg.type === 'tofu_start') {
    _runId = msg.runId;
    updateRunButtons(true);
  } else if (msg.type === 'tofu_output') {
    appendTerminal(msg.data, msg.stream);
  } else if (msg.type === 'tofu_done') {
    _runId = null;
    updateRunButtons(false);
    const line = msg.success
      ? `\n✓  Finished successfully (exit 0)\n`
      : `\n✗  Failed (exit ${msg.exitCode ?? '?'}${msg.error ? ': '+msg.error : ''})\n`;
    appendTerminal(line, msg.success ? 'success' : 'error');
    // Refresh run list in background
    refreshRunList();
    // Update dashboard cards
    refreshDashboardCard(msg.workspaceId);
    if (msg.success && _refreshServersState) {
      try { await _refreshServersState({ renderCurrentView: false, reason: 'opentofu-run' }); } catch {}
    }
  }
}

function updateRunButtons(running) {
  document.querySelectorAll('.tofu-action').forEach(b => { b.disabled = running; });
  const cancel = document.getElementById('tofu-btn-cancel');
  if (cancel) cancel.classList.toggle('hidden', !running);
  const clear  = document.getElementById('tofu-btn-clear');
  if (clear)  clear.classList.toggle('hidden',  running);
}

function appendTerminal(data, stream) {
  const body = document.getElementById('tofu-terminal-body');
  if (!body) return;
  const span = document.createElement('span');
  const colors = { stderr: 'var(--offline)', success: 'var(--online)', error: 'var(--offline)', meta: 'var(--text-muted)' };
  span.style.color = colors[stream] || 'inherit';
  span.style.whiteSpace = 'pre-wrap';
  span.textContent = stripAnsi(data);
  body.appendChild(span);
  body.scrollTop = body.scrollHeight;
}

function normalizeRunsResponse(response) {
  if (Array.isArray(response)) {
    return {
      items: response,
      pagination: {
        page: 1,
        page_size: response.length || _runsPageSize,
        total: response.length,
        total_pages: 1,
        has_prev: false,
        has_next: false,
      },
    };
  }
  return {
    items: Array.isArray(response?.items) ? response.items : [],
    pagination: response?.pagination || {
      page: 1,
      page_size: _runsPageSize,
      total: 0,
      total_pages: 1,
      has_prev: false,
      has_next: false,
    },
  };
}

async function refreshRunList() {
  if (!_selected) return;
  const el = document.getElementById('tofu-runs-list');
  if (!el) return;
  try {
    const response = await _pluginApi.request(`/workspaces/${_selected}/runs?page=${_runsPage}&page_size=${_runsPageSize}`);
    const { items: runs, pagination } = normalizeRunsResponse(response);
    _runsPage = pagination.page;
    _runsPageSize = pagination.page_size;
    _workspaces = _workspaces.map(w => {
      if (w.id !== _selected) return w;
      return { ...w, last_run: runs[0] || null };
    });
    el.innerHTML = renderRunsTable(runs, pagination);
    bindRunsEvents(runs, pagination);
  } catch {}
}

async function refreshDashboardCard(workspaceId) {
  const card = document.querySelector(`.tofu-dash-card[data-id="${workspaceId}"]`);
  if (!card) return;
  try {
    const ws = await _pluginApi.request('/workspaces');
    _workspaces = ws;
    const found = ws.find(w => w.id === workspaceId);
    if (found) card.querySelector('.tofu-card-status').innerHTML = statusBadge(found.last_run);
  } catch {}
}

// ── App Shell ─────────────────────────────────────────────────────────────
function renderApp() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="page-header">
      <div style="display:flex;align-items:baseline;gap:8px;">
        <h2 style="margin:0;font-size:1.1rem;font-weight:700;"><i class="fas fa-cube"></i> OpenTofu</h2>
        ${_status.installed
          ? `<span style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${esc(_status.version||_status.binary||'')}</span>
             <button id="tofu-btn-update" class="btn btn-secondary btn-sm" style="font-size:11px;padding:2px 8px;" title="Install a different version">
               <i class="fas fa-arrow-up-from-bracket"></i> Update
             </button>`
          : `<span style="font-size:12px;color:var(--offline);"><i class="fas fa-times"></i> not found</span>`
        }
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary);font-size:12px;color:var(--text-muted);">
          <i class="fab fa-git-alt"></i>
          <span id="tofu-git-branch">–</span>
        </div>
        <button id="tofu-git-pull-btn" class="btn btn-secondary btn-sm" title="Pull from remote">
          <i class="fas fa-arrow-down"></i>
        </button>
        <button id="tofu-git-push-btn" class="btn btn-secondary btn-sm" title="Push to remote">
          <i class="fas fa-arrow-up"></i>
        </button>
        <button id="tofu-git-settings-link" class="btn btn-secondary btn-sm" title="Git Settings">
          <i class="fas fa-gear"></i>
        </button>
        <button class="btn btn-primary btn-sm" id="tofu-btn-new">
          <i class="fas fa-plus"></i> Workspace
        </button>
      </div>
    </div>

    <div class="tab-bar" id="tofu-main-tabs">
      <button class="tab-btn${_mainTab==='dashboard'?' active':''}" data-tab="dashboard">
        <i class="fas fa-tachometer-alt"></i> Dashboard
      </button>
      <button class="tab-btn${_mainTab==='workspaces'?' active':''}" data-tab="workspaces">
        <i class="fas fa-layer-group"></i> Workspaces
      </button>
    </div>

    <div id="tofu-tab-content" class="page-content"></div>
  `;

  document.getElementById('tofu-btn-new').addEventListener('click', () => openWorkspaceModal(null));

  if (_status.installed) {
    document.getElementById('tofu-btn-update')?.addEventListener('click', () => {
      const existing = document.getElementById('tofu-update-panel');
      if (existing) { existing.remove(); return; }
      const tabContent = document.getElementById('tofu-tab-content');
      if (!tabContent) return;
      const panel = document.createElement('div');
      panel.id = 'tofu-update-panel';
      panel.className = 'panel';
      panel.style.cssText = 'margin-bottom:16px;padding:16px 20px;';
      panel.innerHTML = `
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;"><i class="fas fa-arrow-up-from-bracket"></i> Update OpenTofu</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="tofu-update-select" class="form-input" style="max-width:200px;" disabled>
            <option>Loading versions…</option>
          </select>
          <button id="tofu-btn-do-update" class="btn btn-primary btn-sm" disabled>
            <i class="fas fa-download"></i> Install
          </button>
          <span id="tofu-update-msg" style="font-size:12px;color:var(--text-muted);"></span>
        </div>`;
      tabContent.insertAdjacentElement('beforebegin', panel);
      initUpdatePanel();
    });
  }

  document.getElementById('tofu-main-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === _mainTab) return;
    _mainTab = tab;
    document.querySelectorAll('#tofu-main-tabs .tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    initMainTab(tab);
  });

  initMainTab(_mainTab);
  initTofuGitWidget();
}

async function initTofuGitWidget() {
  try {
    const cfg = await _api.request('/playbooks-git/config');
    const b = document.getElementById('tofu-git-branch');
    if (b) b.textContent = cfg.repoUrl ? (cfg.branch || 'main') : 'not configured';
  } catch {}

  document.getElementById('tofu-git-pull-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('tofu-git-pull-btn');
    btn.disabled = true;
    try {
      await _api.request('/playbooks-git/pull', { method: 'POST' });
      _showToast('Pulled from git.', 'success');
      // Reload workspaces from server so new/changed files appear immediately
      const ws = await _pluginApi.request('/workspaces');
      _workspaces = Array.isArray(ws) ? ws : (ws.workspaces || []);
      const content = document.getElementById('tofu-tab-content');
      if (content) initMainTab(_mainTab);
    } catch (e) { _showToast('Pull failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('tofu-git-push-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('tofu-git-push-btn');
    btn.disabled = true;
    try {
      await _api.request('/playbooks-git/push', { method: 'POST' });
      _showToast('Pushed to git.', 'success');
    } catch (e) { _showToast('Push failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('tofu-git-settings-link')?.addEventListener('click', () => {
    _navigate('settings');
  });
}

async function initMainTab(tab) {
  const content = document.getElementById('tofu-tab-content');
  if (!content) return;
  if (tab === 'dashboard')   renderDashboard(content);
  if (tab === 'workspaces')  renderWorkspacesTab(content);
}

// ── Tab: Dashboard ────────────────────────────────────────────────────────
function renderDashboard(content) {
  if (_workspaces.length === 0) {
    content.innerHTML = `
      <div class="panel">
        <div class="empty-state" style="padding:48px;">
          <div class="empty-state-icon"><i class="fas fa-cube"></i></div>
          <h3>No workspaces yet</h3>
          <p>Create a workspace to manage your OpenTofu infrastructure.</p>
          <button class="btn btn-primary" id="dash-btn-new">
            <i class="fas fa-plus"></i> Create Workspace
          </button>
        </div>
      </div>
      ${!_status.installed ? `<div style="margin-top:16px;">${setupGuidePanel()}</div>` : ''}
    `;
    document.getElementById('dash-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));
    initInstallPanel();
    return;
  }

  content.innerHTML = `
    ${!_status.installed ? setupGuidePanel() : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">
      ${_workspaces.map(ws => `
        <div class="panel tofu-dash-card" data-id="${esc(ws.id)}" style="cursor:pointer;transition:box-shadow 150ms;">
          <div class="section-header">
            <h3><i class="fas fa-layer-group"></i> ${esc(ws.name)}</h3>
            <div class="tofu-card-status">${statusBadge(ws.last_run)}</div>
          </div>
          <div style="padding:12px 16px;">
            <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-bottom:8px;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(ws.path)}</div>
            ${ws.description ? `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px;">${esc(ws.description)}</p>` : ''}
            ${ws.last_run ? `
              <div style="font-size:12px;color:var(--text-muted);">
                Last: ${actionBadge(ws.last_run.action)} &nbsp;·&nbsp; ${esc(fmt(ws.last_run.started_at))}
              </div>` : '<div style="font-size:12px;color:var(--text-muted);">No runs yet</div>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  content.querySelectorAll('.tofu-dash-card').forEach(card => {
    card.addEventListener('click', () => {
      _selected = card.dataset.id;
      _mainTab  = 'workspaces';
      _wsTab    = 'runs';
      renderApp();
    });
  });

  if (!_status.installed) initInstallPanel();
}

function setupGuidePanel() {
  return `
    <div class="panel" id="tofu-install-panel" style="margin-bottom:16px;">
      <div class="section-header">
        <h3><i class="fas fa-download"></i> Install OpenTofu</h3>
      </div>
      <div style="padding:16px;">
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px;">
          OpenTofu is not installed. Select a version to install it directly into this container —
          no host setup or Docker restart needed.
        </p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="tofu-version-select" class="form-input" style="max-width:200px;" disabled>
            <option>Loading versions…</option>
          </select>
          <button id="tofu-btn-install" class="btn btn-primary btn-sm" disabled>
            <i class="fas fa-download"></i> Install
          </button>
          <span id="tofu-install-msg" style="font-size:12px;color:var(--text-muted);"></span>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:12px 0 0;">
          Your workspace directories still need to be mounted in
          <code>docker-compose.yml</code>:
          ${preBlock('services:\n  shipyard:\n    volumes:\n      - /host/path/to/workspaces:/workspaces:rw')}
        </p>
      </div>
    </div>`;
}

async function initUpdatePanel() {
  const sel = document.getElementById('tofu-update-select');
  const btn = document.getElementById('tofu-btn-do-update');
  const msg = document.getElementById('tofu-update-msg');
  if (!sel || !btn) return;

  try {
    const { releases } = await _pluginApi.request('/releases');
    if (!releases || releases.length === 0) {
      sel.innerHTML = '<option value="">No releases found</option>';
      return;
    }
    sel.innerHTML = releases.map((v, i) =>
      `<option value="${esc(v)}"${i === 0 ? ' selected' : ''}>${esc(v)}${i === 0 ? ' (latest)' : ''}${v === _status.version ? ' ← current' : ''}</option>`
    ).join('');
    sel.disabled = false;
    btn.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load versions</option>';
    if (msg) msg.textContent = e.message;
    return;
  }

  btn.addEventListener('click', async () => {
    const version = sel.value;
    if (!version) return;
    btn.disabled = true;
    sel.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Installing…';
    if (msg) msg.textContent = `Downloading OpenTofu v${version}…`;
    try {
      const result = await _pluginApi.request('/install', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      _status = { installed: true, binary: result.binary, version: result.version };
      _showToast(`OpenTofu updated to v${result.version || version}`, 'success');
      setTimeout(() => renderApp(), 600);
    } catch (e) {
      if (msg) msg.textContent = `✗ ${e.message}`;
      btn.disabled = false;
      sel.disabled = false;
      btn.innerHTML = '<i class="fas fa-download"></i> Install';
      _showToast('Update failed: ' + e.message, 'error');
    }
  });
}

async function initInstallPanel() {
  const sel = document.getElementById('tofu-version-select');
  const btn = document.getElementById('tofu-btn-install');
  const msg = document.getElementById('tofu-install-msg');
  if (!sel || !btn) return;

  try {
    const { releases } = await _pluginApi.request('/releases');
    if (!releases || releases.length === 0) {
      sel.innerHTML = '<option value="">No releases found</option>';
      return;
    }
    sel.innerHTML = releases.map((v, i) =>
      `<option value="${esc(v)}"${i === 0 ? ' selected' : ''}>${esc(v)}${i === 0 ? ' (latest)' : ''}</option>`
    ).join('');
    sel.disabled = false;
    btn.disabled = false;
  } catch (e) {
    sel.innerHTML = `<option value="">Could not load versions</option>`;
    if (msg) msg.textContent = e.message;
    return;
  }

  btn.addEventListener('click', async () => {
    const version = sel.value;
    if (!version) return;
    btn.disabled = true;
    sel.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Installing…';
    if (msg) msg.textContent = `Downloading OpenTofu v${version}, this may take a minute…`;

    try {
      const result = await _pluginApi.request('/install', {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      if (msg) msg.textContent = `✓ Installed v${result.version || version}`;
      _status = { installed: true, binary: result.binary, version: result.version };
      _showToast(`OpenTofu v${result.version || version} installed`, 'success');
      setTimeout(() => renderApp(), 800);
    } catch (e) {
      if (msg) msg.textContent = `✗ ${e.message}`;
      btn.disabled = false;
      sel.disabled = false;
      btn.innerHTML = '<i class="fas fa-download"></i> Install';
      _showToast('Install failed: ' + e.message, 'error');
    }
  });
}

// ── Tab: Workspaces ───────────────────────────────────────────────────────
function renderWorkspacesTab(content) {
  if (_workspaces.length === 0) {
    content.innerHTML = `<div class="panel"><div class="empty-state" style="padding:48px;">
      <div class="empty-state-icon"><i class="fas fa-layer-group"></i></div>
      <h3>No workspaces</h3>
      <p>Create a workspace to start managing your OpenTofu infrastructure.</p>
      <button class="btn btn-primary" id="ws-btn-new"><i class="fas fa-plus"></i> Create Workspace</button>
    </div></div>`;
    document.getElementById('ws-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));
    return;
  }

  const ws = _workspaces.find(w => w.id === _selected) || _workspaces[0];
  if (!_selected) _selected = ws.id;

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start;">
      <!-- Sidebar -->
      <div class="panel" style="padding:8px 0;">
        ${_workspaces.map(w => `
          <div class="tofu-ws-item" data-id="${esc(w.id)}" style="
            padding:10px 14px;cursor:pointer;border-radius:6px;margin:2px 6px;
            ${_selected === w.id ? 'background:var(--accent-light);' : ''}">
            <div style="font-size:13px;font-weight:500;">${esc(w.name)}</div>
            <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(w.path)}</div>
          </div>`).join('')}
      </div>

      <!-- Detail -->
      <div id="tofu-ws-detail"></div>
    </div>
  `;

  content.querySelectorAll('.tofu-ws-item').forEach(item => {
    item.addEventListener('click', () => {
      _selected = item.dataset.id;
      _runsPage = 1;
      _fileTree = null; _openFile = null;
      renderWorkspacesTab(content);
    });
  });

  renderWorkspaceDetail(ws);
}

async function renderWorkspaceDetail(ws) {
  const detail = document.getElementById('tofu-ws-detail');
  if (!detail || !ws) return;

  const subTabs = ['runs','variables','files','resources'];
  const subIcons = { runs:'fa-history', variables:'fa-sliders-h', files:'fa-folder-open', resources:'fa-sitemap' };

  detail.innerHTML = `
    <div class="panel" style="margin-bottom:12px;">
      <div class="section-header">
        <h3><i class="fas fa-layer-group"></i> ${esc(ws.name)}</h3>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-sm" id="tofu-btn-edit"><i class="fas fa-pen"></i></button>
          <button class="btn btn-danger btn-sm" id="tofu-btn-delete"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div style="padding:8px 16px;font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${esc(ws.path)}</div>
    </div>

    <div class="panel" style="overflow:hidden;">
      <div class="tab-bar" id="tofu-ws-tabs" style="padding:0 16px;">
        ${subTabs.map(t => `
          <button class="tab-btn${_wsTab===t?' active':''}" data-tab="${t}">
            <i class="fas ${subIcons[t]}"></i> ${t.charAt(0).toUpperCase()+t.slice(1)}
          </button>`).join('')}
      </div>
      <div id="tofu-ws-tab-content" style="padding:16px;"></div>
    </div>
  `;

  document.getElementById('tofu-btn-edit').addEventListener('click', () => openWorkspaceModal(ws));
  document.getElementById('tofu-btn-delete').addEventListener('click', async () => {
    if (!await _showConfirm(`Delete workspace "${ws.name}"?`, { title:'Delete', confirmText:'Delete', danger:true })) return;
    await _pluginApi.request(`/workspaces/${ws.id}`, { method:'DELETE' });
    _workspaces = _workspaces.filter(w => w.id !== ws.id);
    _selected   = _workspaces[0]?.id || null;
    const content = document.getElementById('tofu-tab-content');
    if (content) renderWorkspacesTab(content);
  });

  document.getElementById('tofu-ws-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    _wsTab = btn.dataset.tab;
    _fileTree = null; _openFile = null;
    document.querySelectorAll('#tofu-ws-tabs .tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === _wsTab));
    loadWsTab(ws);
  });

  loadWsTab(ws);
}

async function loadWsTab(ws) {
  const el = document.getElementById('tofu-ws-tab-content');
  if (!el) return;
  if (_wsTab === 'runs')      await loadRunsTab(el, ws);
  if (_wsTab === 'variables') loadVariablesTab(el, ws);
  if (_wsTab === 'files')     await loadFilesTab(el, ws);
  if (_wsTab === 'resources') await loadResourcesTab(el, ws);
}

// ── Sub-tab: Runs ─────────────────────────────────────────────────────────
async function loadRunsTab(el, ws) {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
      <!-- Actions + Terminal -->
      <div class="panel">
        <div class="section-header">
          <h3><i class="fas fa-play"></i> Run</h3>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-secondary btn-sm hidden" id="tofu-btn-cancel">
              <i class="fas fa-stop"></i> Cancel
            </button>
            <button class="btn btn-secondary btn-sm" id="tofu-btn-clear" title="Clear terminal">
              <i class="fas fa-eraser"></i>
            </button>
          </div>
        </div>
        <div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--border);">
          <button class="btn btn-secondary btn-sm tofu-action" data-action="init">
            <i class="fas fa-download"></i> init
          </button>
          <button class="btn btn-secondary btn-sm tofu-action" data-action="validate">
            <i class="fas fa-spell-check"></i> validate
          </button>
          <button class="btn btn-secondary btn-sm tofu-action" data-action="plan">
            <i class="fas fa-eye"></i> plan
          </button>
          <button class="btn btn-primary btn-sm tofu-action" data-action="apply">
            <i class="fas fa-check-double"></i> apply
          </button>
          <button class="btn btn-danger btn-sm tofu-action" data-action="destroy">
            <i class="fas fa-bomb"></i> destroy
          </button>
        </div>
        <div class="terminal" style="border:none;border-radius:0 0 var(--radius) var(--radius);">
          <div class="terminal-header">
            <span class="terminal-title">${esc(ws.name)}</span>
          </div>
          <div class="terminal-body" id="tofu-terminal-body" style="min-height:360px;"></div>
        </div>
      </div>

      <!-- Run history -->
      <div class="panel">
        <div class="section-header">
          <h3><i class="fas fa-history"></i> History</h3>
          <button class="btn btn-secondary btn-sm" id="tofu-btn-refresh-runs">
            <i class="fas fa-rotate"></i>
          </button>
        </div>
        <div id="tofu-runs-list">
          <div class="loading-state" style="padding:20px;"><div class="loader"></div></div>
        </div>
      </div>
    </div>
  `;

  if (_runId) updateRunButtons(true);
  _runsPage = 1;

  document.querySelectorAll('.tofu-action').forEach(btn => {
    btn.addEventListener('click', () => executeAction(ws, btn.dataset.action));
  });
  document.getElementById('tofu-btn-cancel')?.addEventListener('click', () => {
    if (_runId) _pluginApi.request(`/workspaces/${ws.id}/cancel/${_runId}`, { method:'POST' }).catch(() => {});
  });
  document.getElementById('tofu-btn-clear')?.addEventListener('click', () => {
    const body = document.getElementById('tofu-terminal-body');
    if (body) body.innerHTML = '';
  });
  document.getElementById('tofu-btn-refresh-runs')?.addEventListener('click', () => refreshRunList());

  try {
    const response = await _pluginApi.request(`/workspaces/${ws.id}/runs?page=${_runsPage}&page_size=${_runsPageSize}`);
    const { items: runs, pagination } = normalizeRunsResponse(response);
    _runsPage = pagination.page;
    _runsPageSize = pagination.page_size;
    const listEl = document.getElementById('tofu-runs-list');
    if (listEl) { listEl.innerHTML = renderRunsTable(runs, pagination); bindRunsEvents(runs, pagination); }
  } catch {}
}

function renderRunsTable(runs, pagination) {
  if (!runs || runs.length === 0) {
    return `<div class="empty-state" style="padding:20px;"><p style="color:var(--text-muted);">No runs yet</p></div>`;
  }
  return `
    <div>
    <table class="data-table">
      <thead><tr>
        <th>Action</th><th>Status</th><th>Started</th><th style="width:40px;"></th>
      </tr></thead>
      <tbody>
        ${runs.map(r => `
          <tr>
            <td>${actionBadge(r.action)}</td>
            <td>${statusBadge(r)}</td>
            <td style="font-size:11px;color:var(--text-muted);">${esc(fmt(r.started_at))}</td>
            <td>
              <button class="btn btn-secondary btn-icon btn-sm tofu-run-log" data-id="${esc(r.id)}" title="Show output">
                <i class="fas fa-eye"></i>
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:10px;font-size:12px;color:var(--text-muted);">
      <div>Showing ${runs.length} of ${pagination.total} entries · Page ${pagination.page} / ${pagination.total_pages}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="display:flex;align-items:center;gap:6px;">
          <span>Per page</span>
          <select id="tofu-runs-page-size" class="form-input" style="width:auto;min-width:72px;padding:4px 24px 4px 8px;font-size:12px;">
            ${[5, 10, 20, 50, 100].map(size => `<option value="${size}"${pagination.page_size === size ? ' selected' : ''}>${size}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-secondary btn-sm" id="tofu-runs-prev"${pagination.has_prev ? '' : ' disabled'}>Prev</button>
        <button class="btn btn-secondary btn-sm" id="tofu-runs-next"${pagination.has_next ? '' : ' disabled'}>Next</button>
      </div>
    </div>
    </div>`;
}

function bindRunsEvents(runs, pagination) {
  document.querySelectorAll('.tofu-run-log').forEach(btn => {
    btn.addEventListener('click', async () => {
      const run = runs.find(r => r.id === btn.dataset.id);
      if (!run) return;
      try {
        const full = await _pluginApi.request(`/workspaces/${_selected}/runs/${run.id}`);
        showRunOutputModal(full);
      } catch (e) { _showToast(e.message, 'error'); }
    });
  });
  document.getElementById('tofu-runs-prev')?.addEventListener('click', () => {
    if (!pagination.has_prev) return;
    _runsPage = Math.max(1, pagination.page - 1);
    refreshRunList();
  });
  document.getElementById('tofu-runs-next')?.addEventListener('click', () => {
    if (!pagination.has_next) return;
    _runsPage = pagination.page + 1;
    refreshRunList();
  });
  document.getElementById('tofu-runs-page-size')?.addEventListener('change', e => {
    _runsPageSize = Math.max(1, parseInt(e.target.value, 10) || 10);
    _runsPage = 1;
    refreshRunList();
  });
}

function showRunOutputModal(run) {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal" style="max-width:700px;width:95%;">
      <h2>${actionBadge(run.action)} — ${esc(run.status)}</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">${esc(fmt(run.started_at))}</div>
      <div class="terminal" style="max-height:60vh;">
        <div class="terminal-header">
          <span class="terminal-title">${esc(run.action || 'Run output')}</span>
        </div>
        <div class="terminal-body" style="white-space:pre-wrap;">${esc(run.output || '(no output)')}</div>
      </div>
      <div class="form-actions" style="padding-top:8px;">
        <button class="btn btn-secondary" id="run-modal-close">Close</button>
      </div>
    </div>`;
  document.getElementById('run-modal-close').addEventListener('click', () => {
    overlay.classList.add('hidden'); overlay.innerHTML = '';
  });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
  });
}

async function executeAction(ws, action) {
  if (_runId) return;
  if (action === 'destroy') {
    if (!await _showConfirm(`Destroy all resources in "${ws.name}"? This cannot be undone.`,
      { title:'Destroy', confirmText:'Destroy', danger:true })) return;
  }
  if (action === 'apply') {
    if (!await _showConfirm(`Apply changes in "${ws.name}"?`,
      { title:'Apply', confirmText:'Apply', danger:false })) return;
  }
  const body = document.getElementById('tofu-terminal-body');
  if (body) body.innerHTML = '';
  try {
    await _pluginApi.request(`/workspaces/${ws.id}/run`, { method:'POST', body: JSON.stringify({ action }) });
  } catch (e) {
    appendTerminal(`Error: ${e.message}`, 'error');
  }
}

// ── Sub-tab: Variables ────────────────────────────────────────────────────
const SECRET_KEY_RE = /secret|token|password|passwd|pass|pwd|key|private|credential|auth|api_?key/i;

function isSecretKey(k) { return SECRET_KEY_RE.test(k); }

function renderVarRows(vars) {
  const entries = Object.entries(vars);
  const rows = entries.map(([k, v]) => {
    const secret = isSecretKey(k);
    return `
      <div class="tofu-var-row" data-draft="false" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <input class="form-input text-mono var-key" value="${esc(k)}" placeholder="KEY"
          style="flex:0 0 220px;font-size:12px;" spellcheck="false">
        <div style="position:relative;flex:1;display:flex;align-items:center;">
          <input class="form-input text-mono var-val" value="${esc(v)}"
            type="${secret ? 'password' : 'text'}"
            style="width:100%;font-size:12px;padding-right:${secret ? '32px' : '8px'};" spellcheck="false">
          ${secret ? `<button class="var-toggle-vis" tabindex="-1" title="Show/hide"
            style="position:absolute;right:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);padding:0;line-height:1;">
            <i class="fas fa-eye"></i></button>` : ''}
        </div>
        <button class="btn btn-danger btn-sm var-delete" title="Remove" style="flex-shrink:0;">
          <i class="fas fa-trash"></i>
        </button>
      </div>`;
  }).join('');

  return `
    ${entries.length ? '' : '<p style="color:var(--text-muted);font-size:13px;margin:0 0 10px;">No variables yet. Start typing below.</p>'}
    ${rows}
    <div class="tofu-var-row tofu-var-draft" data-draft="true" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <input class="form-input text-mono" id="tofu-new-key" placeholder="NEW_VARIABLE"
        style="flex:0 0 220px;font-size:12px;" spellcheck="false">
      <input class="form-input text-mono" id="tofu-new-val" placeholder="value"
        style="flex:1;font-size:12px;" spellcheck="false">
      <div style="flex-shrink:0;width:38px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);">
        <i class="fas fa-plus"></i>
      </div>
    </div>`;
}

function loadVariablesTab(el, ws) {
  let vars = { ...(ws.env_vars || {}) };
  let draft = { key: '', value: '' };
  let saveTimer = null;
  let isSaving = false;
  let queuedVars = null;
  let lastSavedJson = JSON.stringify(vars);

  function setStatus(message, tone = 'muted') {
    const status = document.getElementById('tofu-vars-status');
    if (!status) return;
    const colors = {
      muted: 'var(--text-muted)',
      success: 'var(--online)',
      error: 'var(--offline)',
    };
    status.textContent = message;
    status.style.color = colors[tone] || colors.muted;
  }

  function getDraftState() {
    return {
      key: document.getElementById('tofu-new-key')?.value ?? draft.key,
      value: document.getElementById('tofu-new-val')?.value ?? draft.value,
    };
  }

  function collectExistingVars() {
    const nextVars = {};
    const duplicates = new Set();
    el.querySelectorAll('.tofu-var-row[data-draft="false"]').forEach(row => {
      const key = row.querySelector('.var-key')?.value.trim() || '';
      const value = row.querySelector('.var-val')?.value || '';
      if (!key) return;
      if (Object.prototype.hasOwnProperty.call(nextVars, key)) duplicates.add(key);
      nextVars[key] = value;
    });
    if (duplicates.size) {
      setStatus(`Duplicate key: ${[...duplicates][0]}`, 'error');
      return null;
    }
    return nextVars;
  }

  async function persistVars(nextVars) {
    const serialized = JSON.stringify(nextVars);
    if (serialized === lastSavedJson) {
      setStatus('All changes saved.', 'success');
      return;
    }

    if (isSaving) {
      queuedVars = nextVars;
      setStatus('Saving...', 'muted');
      return;
    }

    isSaving = true;
    setStatus('Saving...', 'muted');
    try {
      await _pluginApi.request(`/workspaces/${ws.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: ws.name, path: ws.path, description: ws.description, env_vars: nextVars }),
      });
      vars = { ...nextVars };
      ws.env_vars = vars;
      _workspaces = _workspaces.map(w => w.id === ws.id ? { ...w, env_vars: vars } : w);
      lastSavedJson = serialized;
      setStatus('All changes saved.', 'success');
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, 'error');
    } finally {
      isSaving = false;
      if (queuedVars) {
        const pending = queuedVars;
        queuedVars = null;
        persistVars(pending);
      }
    }
  }

  function scheduleSave(nextVars, delay = 700) {
    if (saveTimer) clearTimeout(saveTimer);
    setStatus('Saving...', 'muted');
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistVars(nextVars);
    }, delay);
  }

  function flushSave(nextVars) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistVars(nextVars);
  }

  function commitDraftAndSave(immediate = false) {
    draft = getDraftState();
    const key = draft.key.trim();
    if (!key) return false;
    const nextVars = collectExistingVars();
    if (!nextVars) return false;
    if (Object.prototype.hasOwnProperty.call(nextVars, key)) {
      setStatus(`Duplicate key: ${key}`, 'error');
      return false;
    }
    nextVars[key] = draft.value;
    vars = nextVars;
    draft = { key: '', value: '' };
    render();
    if (immediate) flushSave(nextVars);
    else scheduleSave(nextVars, 0);
    return true;
  }

  function render() {
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <p style="font-size:13px;color:var(--text-muted);margin:0;">
          Injected as env vars for every run.
          Use <code>AWS_*</code> / <code>TF_VAR_*</code> for credentials and tofu variables.
          <span style="color:var(--warning);"><i class="fas fa-lock" style="font-size:11px;"></i> Secret values are masked.</span>
        </p>
        <div id="tofu-vars-status" style="flex-shrink:0;margin-left:16px;font-size:12px;color:var(--text-muted);">
          Changes save automatically.
        </div>
      </div>
      <div id="tofu-var-list">${renderVarRows(vars)}</div>
    `;

    document.getElementById('tofu-new-key').value = draft.key;
    document.getElementById('tofu-new-val').value = draft.value;

    // Show/hide toggles
    el.querySelectorAll('.var-toggle-vis').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.previousElementSibling;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        btn.querySelector('i').className = isHidden ? 'fas fa-eye-slash' : 'fas fa-eye';
      });
    });

    // Delete row
    el.querySelectorAll('.var-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        draft = getDraftState();
        const nextVars = collectExistingVars();
        if (!nextVars) return;
        const row = btn.closest('.tofu-var-row');
        const key = row.querySelector('.var-key').value.trim();
        delete nextVars[key];
        vars = nextVars;
        render();
        flushSave(nextVars);
      });
    });

    // Auto-save existing rows
    el.querySelectorAll('.tofu-var-row[data-draft="false"]').forEach(row => {
      const onInput = () => {
        draft = getDraftState();
        const nextVars = collectExistingVars();
        if (!nextVars) return;
        scheduleSave(nextVars);
      };
      row.querySelector('.var-key')?.addEventListener('input', onInput);
      row.querySelector('.var-val')?.addEventListener('input', onInput);
      row.addEventListener('focusout', () => {
        window.setTimeout(() => {
          if (row.contains(document.activeElement)) return;
          draft = getDraftState();
          const nextVars = collectExistingVars();
          if (!nextVars) return;
          if (!row.querySelector('.var-key')?.value.trim()) {
            vars = nextVars;
            render();
            flushSave(nextVars);
            return;
          }
          flushSave(nextVars);
        }, 0);
      });
    });

    const draftKey = document.getElementById('tofu-new-key');
    const draftVal = document.getElementById('tofu-new-val');
    const draftRow = el.querySelector('.tofu-var-draft');
    [draftKey, draftVal].forEach(input => {
      input?.addEventListener('input', () => {
        draft = getDraftState();
        setStatus(draft.key.trim() ? 'Press Enter or leave the row to create this variable.' : 'Changes save automatically.', 'muted');
      });
      input?.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commitDraftAndSave(true);
      });
    });
    draftRow?.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (draftRow.contains(document.activeElement)) return;
        commitDraftAndSave(true);
      }, 0);
    });
  }

  render();
}

function parseEnvBlock(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// ── Sub-tab: Files ────────────────────────────────────────────────────────
async function loadFilesTab(el, ws) {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start;">
      <div class="panel" id="tofu-file-tree-panel">
        <div class="section-header">
          <h3><i class="fas fa-folder-open"></i> Files</h3>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-secondary btn-sm" id="tofu-btn-generate-output" title="Generate shipyard_servers output"><i class="fas fa-wand-magic"></i></button>
            <button class="btn btn-secondary btn-sm" id="tofu-btn-new-file" title="New file"><i class="fas fa-plus"></i></button>
            <button class="btn btn-secondary btn-sm" id="tofu-btn-reload-tree" title="Reload"><i class="fas fa-rotate"></i></button>
          </div>
        </div>
        <div id="tofu-tree-content" style="padding:6px 0;">
          <div class="loading-state" style="padding:16px;"><div class="loader"></div></div>
        </div>
      </div>
      <div class="panel" id="tofu-file-editor-panel">
        <div class="empty-state" style="padding:48px;">
          <i class="fas fa-file-code" style="font-size:2rem;opacity:.3;margin-bottom:12px;display:block;"></i>
          <p>Select a file to edit</p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('tofu-btn-reload-tree').addEventListener('click', () => loadFileTree(ws));
  document.getElementById('tofu-btn-new-file').addEventListener('click', () => newFileDialog(ws));
  document.getElementById('tofu-btn-generate-output').addEventListener('click', async () => {
    const btn = document.getElementById('tofu-btn-generate-output');
    if (!btn) return;
    if (_openFile?.path === 'outputs.tf' && _openFile?.dirty) {
      const discard = await _showConfirm('Discard unsaved changes in outputs.tf and regenerate the Shipyard output block?', {
        title: 'Regenerate outputs.tf',
        confirmText: 'Regenerate',
        danger: true,
      });
      if (!discard) return;
    }

    btn.disabled = true;
    try {
      const result = await _pluginApi.request(`/workspaces/${ws.id}/generate-shipyard-output`, { method: 'POST' });
      await loadFileTree(ws);
      await openFileEditor(ws, 'outputs.tf');
      _showToast(`Generated shipyard_servers output for ${result.resources.length} resource(s).`, 'success');
    } catch (e) {
      _showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  await loadFileTree(ws);
}

async function loadFileTree(ws) {
  const el = document.getElementById('tofu-tree-content');
  if (!el) return;
  try {
    const { tree } = await _pluginApi.request(`/workspaces/${ws.id}/files`);
    _fileTree = tree;
    el.innerHTML = renderTree(tree, ws);
    bindTreeEvents(ws);
  } catch (e) {
    el.innerHTML = `<p style="padding:12px;color:var(--offline);font-size:12px;">${esc(e.message)}</p>`;
  }
}

function renderTree(nodes, ws, depth = 0) {
  if (!nodes || nodes.length === 0) return `<div style="padding:8px 14px;font-size:12px;color:var(--text-muted);">Empty directory</div>`;
  return nodes.map(node => {
    const indent = depth * 14;
    if (node.type === 'dir') {
      return `
        <div class="tofu-tree-dir" data-path="${esc(node.path)}"
          style="padding:5px 14px 5px ${14+indent}px;cursor:pointer;font-size:12px;
                 display:flex;align-items:center;gap:6px;color:var(--text-muted);">
          <i class="fas fa-folder" style="color:var(--accent);"></i> ${esc(node.name)}
        </div>
        <div class="tofu-dir-children" data-dir="${esc(node.path)}">
          ${renderTree(node.children, ws, depth + 1)}
        </div>`;
    }
    const isActive = _openFile?.path === node.path;
    return `
      <div class="tofu-tree-file" data-path="${esc(node.path)}"
        style="padding:5px 14px 5px ${14+indent}px;cursor:pointer;font-size:12px;
               display:flex;align-items:center;justify-content:space-between;gap:6px;
               ${isActive ? 'background:var(--accent-light);color:var(--accent);border-radius:4px;' : ''}">
        <span style="display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;">
          <i class="${fileIcon(node.name)}" style="flex-shrink:0;"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(node.name)}</span>
        </span>
        <button class="btn btn-danger btn-icon" style="width:20px;height:20px;font-size:10px;flex-shrink:0;"
          data-delete="${esc(node.path)}" title="Delete">
          <i class="fas fa-times"></i>
        </button>
      </div>`;
  }).join('');
}

function bindTreeEvents(ws) {
  document.querySelectorAll('.tofu-tree-file').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('[data-delete]')) return;
      openFileEditor(ws, item.dataset.path);
    });
  });
  document.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!await _showConfirm(`Delete "${btn.dataset.delete}"?`, { title:'Delete', confirmText:'Delete', danger:true })) return;
      try {
        await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(btn.dataset.delete)}`, { method:'DELETE' });
        if (_openFile?.path === btn.dataset.delete) { _openFile = null; }
        await loadFileTree(ws);
      } catch (e2) { _showToast(e2.message, 'error'); }
    });
  });
}

async function openFileEditor(ws, relPath) {
  if (_openFile?.dirty) {
    if (!await _showConfirm('Discard unsaved changes?', { title:'Discard', confirmText:'Discard', danger:true })) return;
  }
  const editorPanel = document.getElementById('tofu-file-editor-panel');
  if (!editorPanel) return;
  editorPanel.innerHTML = `<div class="loading-state" style="padding:24px;"><div class="loader"></div></div>`;
  try {
    const { content } = await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(relPath)}`);
    _openFile = { path: relPath, content, dirty: false };
    editorPanel.innerHTML = `
      <div class="section-header">
        <h3><i class="${fileIcon(relPath)}"></i> ${esc(relPath.split('/').pop())}</h3>
        <button class="btn btn-primary btn-sm" id="tofu-btn-save-file" disabled>
          <i class="fas fa-save"></i> Save
        </button>
      </div>
      <textarea id="tofu-file-content" class="form-input text-mono"
        style="min-height:420px;resize:vertical;border:none;border-top:1px solid var(--border);
               border-radius:0 0 var(--radius) var(--radius);font-size:12px;line-height:1.6;
               display:block;width:100%;box-sizing:border-box;"
      >${esc(content)}</textarea>
    `;
    const textarea = document.getElementById('tofu-file-content');
    const saveBtn  = document.getElementById('tofu-btn-save-file');
    textarea.addEventListener('input', () => {
      _openFile.dirty = textarea.value !== _openFile.content;
      saveBtn.disabled = !_openFile.dirty;
    });
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); const s=textarea.selectionStart; textarea.value=textarea.value.slice(0,s)+'  '+textarea.value.slice(textarea.selectionEnd); textarea.selectionStart=textarea.selectionEnd=s+2; textarea.dispatchEvent(new Event('input')); }
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(relPath)}`, {
          method: 'PUT', body: JSON.stringify({ content: textarea.value }),
        });
        _openFile.content = textarea.value;
        _openFile.dirty = false;
        _showToast('Saved', 'success');
      } catch (e3) { _showToast(e3.message, 'error'); saveBtn.disabled = false; }
    });
    // Highlight active file
    document.querySelectorAll('.tofu-tree-file').forEach(item => {
      item.style.background = item.dataset.path === relPath ? 'var(--accent-light)' : '';
      item.style.color      = item.dataset.path === relPath ? 'var(--accent)' : '';
    });
  } catch (e) {
    editorPanel.innerHTML = `<p style="padding:16px;color:var(--offline);">${esc(e.message)}</p>`;
  }
}

function newFileDialog(ws) {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px;">
      <h2><i class="fas fa-plus"></i> New File</h2>
      <div class="form-body">
        <div class="form-group">
          <label class="form-label">Filename</label>
          <input class="form-input text-mono" id="new-file-name" placeholder="main.tf" autofocus>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" id="new-file-cancel">Cancel</button>
          <button class="btn btn-primary" id="new-file-create">Create</button>
        </div>
      </div>
    </div>`;
  const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
  document.getElementById('new-file-cancel').addEventListener('click', close);
  document.getElementById('new-file-create').addEventListener('click', async () => {
    const name = document.getElementById('new-file-name').value.trim();
    if (!name) return;
    try {
      await _pluginApi.request(`/workspaces/${ws.id}/file`, { method:'POST', body: JSON.stringify({ path: name }) });
      close();
      await loadFileTree(ws);
      await openFileEditor(ws, name);
    } catch (e) { _showToast(e.message, 'error'); }
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ── Sub-tab: Resources ────────────────────────────────────────────────────
async function loadResourcesTab(el, ws) {
  el.innerHTML = `<div class="loading-state" style="padding:32px;"><div class="loader"></div></div>`;
  try {
    const { resources, error } = await _pluginApi.request(`/workspaces/${ws.id}/state`);
    if (error && (!resources || resources.length === 0)) {
      el.innerHTML = `
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 8px;">No state found or state is empty.</p>
        ${error ? `<details><summary style="font-size:12px;cursor:pointer;color:var(--text-muted);">Details</summary>${preBlock(error)}</details>` : ''}`;
      return;
    }
    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        ${resources.length} resource${resources.length !== 1 ? 's' : ''}
      </div>
      <table class="data-table">
        <thead><tr><th>Type</th><th>Name</th><th>Address</th></tr></thead>
        <tbody>
          ${resources.map(r => `
            <tr>
              <td class="text-mono" style="font-size:12px;color:var(--accent);">${esc(r.type)}</td>
              <td style="font-size:13px;">${esc(r.name)}</td>
              <td class="text-mono" style="font-size:11px;color:var(--text-muted);">${esc(r.address)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--offline);font-size:13px;">${esc(e.message)}</p>`;
  }
}

// ── Workspace Modal ───────────────────────────────────────────────────────
function openWorkspaceModal(ws) {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const vars = ws?.env_vars || {};
  const envLines = Object.entries(vars).map(([k,v]) => `${k}=${v}`).join('\n');
  const pathSection = ws ? `
        <div class="form-group">
          <label class="form-label">Path</label>
          <input class="form-input text-mono" id="ws-path" value="${esc(ws.path)}" required>
        </div>
        <div class="form-group" id="ws-move-files-group" style="display:none;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;">
            <input type="checkbox" id="ws-move-files" style="width:16px;height:16px;" checked>
            Move existing workspace files to the new path
          </label>
          <div class="form-hint">If enabled, Shipyard moves your current workspace files and state instead of only changing the saved path.</div>
        </div>` : `<input type="hidden" id="ws-path" value="">`;
  const scaffoldSection = !ws ? `
        <div class="form-group" style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;">
            <input type="checkbox" id="ws-scaffold" style="width:16px;height:16px;">
            Initialize with starter files
          </label>
          <div id="ws-scaffold-opts" style="display:none;margin-top:10px;">
            <label class="form-label">Provider template</label>
            <select class="form-input" id="ws-provider" style="max-width:240px;">
              <option value="">None (blank files)</option>
              <option value="aws">AWS</option>
              <option value="azurerm">Azure</option>
              <option value="google">Google Cloud</option>
              <option value="hcloud">Hetzner Cloud</option>
              <option value="digitalocean">DigitalOcean</option>
              <option value="kubernetes">Kubernetes</option>
              <option value="proxmox">Proxmox (bpg/proxmox)</option>
            </select>
            <div class="form-hint">Creates main.tf, variables.tf, outputs.tf and (if provider selected) providers.tf</div>
          </div>
        </div>` : '';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;width:95%;">
      <h2>${ws ? '<i class="fas fa-edit"></i> Edit Workspace' : '<i class="fas fa-plus"></i> New Workspace'}</h2>
      <div class="form-body">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" id="ws-name" value="${esc(ws?.name||'')}" placeholder="production" required>
        </div>
        ${pathSection}
        <div class="form-group">
          <label class="form-label">Description (optional)</label>
          <input class="form-input" id="ws-desc" value="${esc(ws?.description||'')}" placeholder="Production infrastructure">
        </div>
        <div class="form-group">
          <label class="form-label">Environment Variables</label>
          <textarea class="form-input text-mono" id="ws-env"
            style="min-height:100px;resize:vertical;font-size:12px;"
            placeholder="AWS_ACCESS_KEY_ID=AKIA...\nTF_VAR_region=eu-central-1"
          >${esc(envLines)}</textarea>
        </div>
        ${scaffoldSection}
        <div class="form-actions">
          <button class="btn btn-secondary" id="ws-cancel">Cancel</button>
          <button class="btn btn-primary" id="ws-save">${ws ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>`;

  const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };

  document.getElementById('ws-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Auto-fill path from name (only when creating, and only if user hasn't manually edited it)
  if (!ws) {
    const nameEl = document.getElementById('ws-name');
    const pathEl = document.getElementById('ws-path');
    let pathTouched = false;
    pathEl.addEventListener('input', () => { pathTouched = true; });
    nameEl.addEventListener('input', () => {
      if (pathTouched) return;
      const slug = nameEl.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      pathEl.value = slug ? `/workspaces/${slug}` : '';
    });
  }

  if (ws) {
    const pathEl = document.getElementById('ws-path');
    const moveGroupEl = document.getElementById('ws-move-files-group');
    const toggleMoveHint = () => {
      if (!pathEl || !moveGroupEl) return;
      moveGroupEl.style.display = pathEl.value.trim() !== ws.path ? 'block' : 'none';
    };
    pathEl?.addEventListener('input', toggleMoveHint);
    toggleMoveHint();
  }

  document.getElementById('ws-scaffold')?.addEventListener('change', e => {
    document.getElementById('ws-scaffold-opts').style.display = e.target.checked ? 'block' : 'none';
  });

  document.getElementById('ws-save').addEventListener('click', async () => {
    const name    = document.getElementById('ws-name').value.trim();
    const wPath   = document.getElementById('ws-path').value.trim();
    const desc    = document.getElementById('ws-desc').value.trim();
    const env_vars = parseEnvBlock(document.getElementById('ws-env').value);
    if (!name || !wPath) { _showToast('Name and path are required', 'error'); return; }
    const scaffoldEl = document.getElementById('ws-scaffold');
    const scaffold = scaffoldEl?.checked
      ? { provider: document.getElementById('ws-provider').value || null }
      : null;
    const btn = document.getElementById('ws-save');
    btn.disabled = true;
    try {
      if (ws) {
        const moveFiles = document.getElementById('ws-move-files-group')?.style.display !== 'none'
          ? !!document.getElementById('ws-move-files')?.checked
          : false;
        await _pluginApi.request(`/workspaces/${ws.id}`, {
          method: 'PUT', body: JSON.stringify({ name, path: wPath, description: desc, env_vars, move_files: moveFiles }),
        });
      } else {
        const { id } = await _pluginApi.request('/workspaces', {
          method: 'POST', body: JSON.stringify({ name, path: wPath, description: desc, env_vars, scaffold }),
        });
        _selected = id;
        _mainTab  = 'workspaces';
        _wsTab    = 'runs';
      }
      _workspaces = await _pluginApi.request('/workspaces');
      close();
      renderApp();
    } catch (e) {
      _showToast(e.message, 'error');
      btn.disabled = false;
    }
  });
}
