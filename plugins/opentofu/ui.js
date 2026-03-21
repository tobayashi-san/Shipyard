// ── State ─────────────────────────────────────────────────────────────────
let _container   = null;
let _wsUnsub     = null;
let _workspaces  = [];
let _selected    = null;   // workspace id
let _runId       = null;   // active run id
let _pluginApi   = null;
let _showToast   = null;
let _showConfirm = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'').replace(/\r/g,'');
}

// ── Mount / Unmount ───────────────────────────────────────────────────────
export async function mount(container, { pluginApi, showToast, showConfirm, onWsMessage }) {
  _container   = container;
  _pluginApi   = pluginApi;
  _showToast   = showToast;
  _showConfirm = showConfirm;

  _wsUnsub = onWsMessage(handleWsMessage);

  container.innerHTML = `<div class="loading-state" style="padding:48px;"><div class="loader"></div></div>`;

  try {
    const [status, workspaces] = await Promise.all([
      pluginApi.request('/status'),
      pluginApi.request('/workspaces'),
    ]);
    _workspaces = workspaces;
    renderApp(container, status);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><p>Error: ${esc(e.message)}</p></div>`;
  }
}

export function unmount() {
  if (_wsUnsub) { _wsUnsub(); _wsUnsub = null; }
  _container = _selected = _runId = null;
}

// ── WebSocket handler ─────────────────────────────────────────────────────
function handleWsMessage(msg) {
  if (msg.type === 'tofu_start') {
    _runId = msg.runId;
    setRunning(true);
    return;
  }
  if (msg.type === 'tofu_output') {
    appendTerminal(msg.data, msg.stream);
    return;
  }
  if (msg.type === 'tofu_done') {
    _runId = null;
    setRunning(false);
    const line = msg.success
      ? `\n✓  Finished successfully (exit 0)\n`
      : `\n✗  Failed (exit ${msg.exitCode ?? '?'}${msg.error ? ': ' + msg.error : ''})\n`;
    appendTerminal(line, msg.success ? 'success' : 'error');
  }
}

// ── App shell ─────────────────────────────────────────────────────────────
function renderApp(container, status) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- Header -->
      <div class="page-header" style="flex-shrink:0;">
        <div>
          <h2 style="display:flex;align-items:center;gap:10px;">
            <i class="fas fa-cube"></i> OpenTofu
          </h2>
          <p>${statusBadge(status)}</p>
        </div>
        <div>
          <button class="btn btn-primary btn-sm" id="tofu-btn-new">
            <i class="fas fa-plus"></i> Workspace
          </button>
        </div>
      </div>

      <!-- Body: sidebar + detail -->
      <div style="display:flex;flex:1;min-height:0;gap:0;overflow:hidden;">

        <!-- Workspace list -->
        <div style="width:220px;flex-shrink:0;border-right:1px solid var(--border);overflow-y:auto;padding:8px 0;" id="tofu-ws-list">
          ${renderWorkspaceList()}
        </div>

        <!-- Detail panel -->
        <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;" id="tofu-detail">
          ${_selected ? '' : emptyDetail()}
        </div>

      </div>
    </div>`;

  bindAppEvents();

  if (_selected) renderDetail();
}

function statusBadge(status) {
  if (!status.installed) return `
    <span class="badge badge-offline" style="margin-right:8px;">
      <i class="fas fa-times"></i> OpenTofu/Terraform not found in PATH
    </span>
    <span style="font-size:12px;color:var(--text-muted);">
      Mount the binary into the container:
      <code style="font-family:var(--font-mono);background:var(--bg-secondary);padding:1px 5px;border-radius:3px;">
        - /usr/bin/tofu:/usr/bin/tofu:ro
      </code>
      in your <code style="font-family:var(--font-mono);">docker-compose.yml</code>
    </span>`;
  return `<span class="badge badge-online"><i class="fas fa-check"></i> ${esc(status.binary)} ${esc(status.version || '')}</span>`;
}

function renderWorkspaceList() {
  if (_workspaces.length === 0) {
    return `<div style="padding:16px 12px;font-size:12px;color:var(--text-muted);">No workspaces yet.</div>`;
  }
  return _workspaces.map(w => `
    <div class="tofu-ws-item ${_selected === w.id ? 'active' : ''}"
         data-id="${w.id}"
         style="padding:10px 14px;cursor:pointer;border-radius:6px;margin:1px 6px;
                ${_selected === w.id ? 'background:var(--accent-light);' : ''}">
      <div style="font-size:13px;font-weight:500;color:var(--text-primary);">${esc(w.name)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;
                  font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${esc(w.path)}
      </div>
    </div>`).join('');
}

function emptyDetail() {
  return `<div class="empty-state" style="margin:auto;">
    <i class="fas fa-cube" style="font-size:2rem;opacity:.3;margin-bottom:12px;"></i>
    <p>Select a workspace</p>
  </div>`;
}

function bindAppEvents() {
  document.getElementById('tofu-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));

  document.getElementById('tofu-ws-list')?.addEventListener('click', e => {
    const item = e.target.closest('.tofu-ws-item');
    if (!item) return;
    _selected = item.dataset.id;
    refreshList();
    renderDetail();
  });
}

function refreshList() {
  const el = document.getElementById('tofu-ws-list');
  if (el) el.innerHTML = renderWorkspaceList();
  // Re-attach click (delegation keeps working since el is replaced by innerHTML)
}

// ── Detail panel ──────────────────────────────────────────────────────────
function renderDetail() {
  const detail = document.getElementById('tofu-detail');
  if (!detail) return;
  const ws = _workspaces.find(w => w.id === _selected);
  if (!ws) { detail.innerHTML = emptyDetail(); return; }

  detail.innerHTML = `
    <div style="padding:20px 24px;border-bottom:1px solid var(--border);flex-shrink:0;
                display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
      <div>
        <div style="font-size:15px;font-weight:600;">${esc(ws.name)}</div>
        <div style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);margin-top:3px;">${esc(ws.path)}</div>
        ${ws.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${esc(ws.description)}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-secondary btn-sm" id="tofu-btn-state" title="State list">
          <i class="fas fa-list"></i> State
        </button>
        <button class="btn btn-secondary btn-sm" id="tofu-btn-edit">
          <i class="fas fa-pen"></i>
        </button>
        <button class="btn btn-danger btn-sm" id="tofu-btn-delete">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>

    <!-- Action buttons -->
    <div style="padding:12px 24px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-secondary btn-sm tofu-action" data-action="init">
        <i class="fas fa-download"></i> init
      </button>
      <button class="btn btn-secondary btn-sm tofu-action" data-action="validate">
        <i class="fas fa-check-circle"></i> validate
      </button>
      <button class="btn btn-secondary btn-sm tofu-action" data-action="plan">
        <i class="fas fa-file-alt"></i> plan
      </button>
      <button class="btn btn-primary btn-sm tofu-action" data-action="apply">
        <i class="fas fa-play"></i> apply
      </button>
      <button class="btn btn-danger btn-sm tofu-action" data-action="destroy">
        <i class="fas fa-fire"></i> destroy
      </button>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <button class="btn btn-secondary btn-sm hidden" id="tofu-btn-cancel">
          <i class="fas fa-stop"></i> Cancel
        </button>
        <button class="btn btn-secondary btn-sm" id="tofu-btn-clear">
          <i class="fas fa-eraser"></i>
        </button>
      </div>
    </div>

    <!-- Terminal output -->
    <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;background:var(--bg-secondary);">
      <pre id="tofu-terminal"
        style="flex:1;overflow-y:auto;margin:0;padding:16px 20px;
               font-family:var(--font-mono);font-size:12.5px;line-height:1.6;
               white-space:pre-wrap;word-break:break-all;
               color:var(--text-primary);background:transparent;border:none;"></pre>
    </div>`;

  bindDetailEvents(ws);
}

function bindDetailEvents(ws) {
  document.getElementById('tofu-btn-edit')?.addEventListener('click', () => openWorkspaceModal(ws));
  document.getElementById('tofu-btn-delete')?.addEventListener('click', () => deleteWorkspace(ws));
  document.getElementById('tofu-btn-clear')?.addEventListener('click', clearTerminal);
  document.getElementById('tofu-btn-cancel')?.addEventListener('click', () => cancelRun(ws));

  document.getElementById('tofu-btn-state')?.addEventListener('click', async () => {
    const btn = document.getElementById('tofu-btn-state');
    btn.disabled = true;
    clearTerminal();
    appendTerminal('▶  tofu state list\n\n', 'meta');
    try {
      const data = await _pluginApi.request(`/workspaces/${ws.id}/state`);
      appendTerminal(data.output || '(no resources in state)', 'stdout');
    } catch (e) {
      appendTerminal(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('.tofu-action').forEach(btn => {
    btn.addEventListener('click', () => runAction(ws, btn.dataset.action));
  });
}

async function runAction(ws, action) {
  if (_runId) { _showToast('A command is already running', 'warning'); return; }

  if (action === 'destroy') {
    const ok = await _showConfirm(
      `<strong>Destroy all infrastructure in workspace <em>${esc(ws.name)}</em>?</strong><br><br>
       This runs <code>tofu destroy -auto-approve</code> and <strong>cannot be undone</strong>.`,
      { title: 'Confirm Destroy', confirmText: 'Destroy', danger: true }
    );
    if (!ok) return;
  }
  if (action === 'apply') {
    const ok = await _showConfirm(
      `Apply changes in workspace <strong>${esc(ws.name)}</strong>? This runs <code>tofu apply -auto-approve</code>.`,
      { title: 'Confirm Apply', confirmText: 'Apply', danger: false }
    );
    if (!ok) return;
  }

  clearTerminal();
  setRunning(true);

  try {
    await _pluginApi.request(`/workspaces/${ws.id}/run`, { method: 'POST', body: { action } });
  } catch (e) {
    appendTerminal(`Error: ${e.message}`, 'error');
    setRunning(false);
  }
}

async function cancelRun(ws) {
  if (!_runId) return;
  try {
    await _pluginApi.request(`/workspaces/${ws.id}/cancel/${_runId}`, { method: 'POST', body: {} });
  } catch {}
}

async function deleteWorkspace(ws) {
  const ok = await _showConfirm(`Delete workspace <strong>${esc(ws.name)}</strong>? The files on disk are not affected.`,
    { title: 'Delete Workspace', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await _pluginApi.request(`/workspaces/${ws.id}`, { method: 'DELETE' });
    _workspaces = _workspaces.filter(w => w.id !== ws.id);
    _selected   = _workspaces[0]?.id || null;
    refreshList();
    renderDetail();
    _showToast('Workspace deleted', 'success');
  } catch (e) {
    _showToast('Error: ' + e.message, 'error');
  }
}

// ── Terminal helpers ──────────────────────────────────────────────────────
function clearTerminal() {
  const el = document.getElementById('tofu-terminal');
  if (el) el.textContent = '';
}

function appendTerminal(text, stream) {
  const el = document.getElementById('tofu-terminal');
  if (!el) return;
  const clean = stripAnsi(text);
  const span  = document.createElement('span');
  span.style.color =
    stream === 'stderr'  ? 'var(--offline)'  :
    stream === 'error'   ? 'var(--offline)'  :
    stream === 'success' ? '#4ade80'         :
    stream === 'meta'    ? 'var(--text-muted)' :
    'inherit';
  span.textContent = clean;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function setRunning(running) {
  document.querySelectorAll('.tofu-action').forEach(b => { b.disabled = running; });
  document.getElementById('tofu-btn-cancel')?.classList.toggle('hidden', !running);
}

// ── Workspace modal ───────────────────────────────────────────────────────
function openWorkspaceModal(existing) {
  const envText = existing
    ? Object.entries(existing.env_vars || {}).map(([k, v]) => `${k}=${v}`).join('\n')
    : '';

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;width:95%;">
      <h2>
        <i class="fas fa-cube"></i>
        ${existing ? 'Edit Workspace' : 'New Workspace'}
      </h2>
      <div class="form-body">
        <form id="tofu-ws-form">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" id="tofu-ws-name" type="text"
              placeholder="e.g. Production" value="${esc(existing?.name || '')}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Path on server</label>
            <input class="form-input" id="tofu-ws-path" type="text"
              placeholder="/opt/infra/production" value="${esc(existing?.path || '')}" required
              style="font-family:var(--font-mono);">
            <div class="form-hint">Absolute path to the directory containing your .tf files.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Description <span style="color:var(--text-muted);font-weight:400;">(optional)</span></label>
            <input class="form-input" id="tofu-ws-desc" type="text"
              placeholder="Short description" value="${esc(existing?.description || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">
              Environment variables
              <span style="color:var(--text-muted);font-weight:400;">(optional)</span>
            </label>
            <textarea class="form-input" id="tofu-ws-env" rows="5"
              placeholder="AWS_ACCESS_KEY_ID=AKIA…&#10;AWS_SECRET_ACCESS_KEY=…&#10;TF_VAR_region=eu-central-1"
              style="font-family:var(--font-mono);font-size:12px;resize:vertical;">${esc(envText)}</textarea>
            <div class="form-hint">One KEY=VALUE per line. Used for cloud credentials and TF_VAR_* variables.</div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="tofu-ws-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="tofu-ws-save">
              ${existing ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>`;

  const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
  document.getElementById('tofu-ws-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  document.getElementById('tofu-ws-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name        = document.getElementById('tofu-ws-name').value.trim();
    const path        = document.getElementById('tofu-ws-path').value.trim();
    const description = document.getElementById('tofu-ws-desc').value.trim();
    const envRaw      = document.getElementById('tofu-ws-env').value.trim();
    const env_vars    = parseEnvBlock(envRaw);

    const btn = document.getElementById('tofu-ws-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span>';

    try {
      if (existing) {
        await _pluginApi.request(`/workspaces/${existing.id}`, {
          method: 'PUT', body: { name, path, description, env_vars },
        });
        const idx = _workspaces.findIndex(w => w.id === existing.id);
        if (idx >= 0) _workspaces[idx] = { ..._workspaces[idx], name, path, description, env_vars };
        _showToast('Workspace saved', 'success');
      } else {
        const res = await _pluginApi.request('/workspaces', {
          method: 'POST', body: { name, path, description, env_vars },
        });
        _workspaces.push({ id: res.id, name, path, description, env_vars, created_at: new Date().toISOString() });
        _selected = res.id;
        _showToast('Workspace created', 'success');
      }
      close();
      refreshList();
      renderDetail();
    } catch (err) {
      _showToast('Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = existing ? 'Save' : 'Create';
    }
  });
}

// ── Env var parser ────────────────────────────────────────────────────────
function parseEnvBlock(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1);
    if (key) result[key] = val;
  }
  return result;
}
