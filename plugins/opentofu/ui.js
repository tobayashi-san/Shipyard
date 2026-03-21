// ── State ─────────────────────────────────────────────────────────────────
let _container   = null;
let _wsUnsub     = null;
let _workspaces  = [];
let _selected    = null;   // workspace id
let _runId       = null;   // active run id
let _pluginApi   = null;
let _showToast   = null;
let _showConfirm = null;
let _activeTab   = 'terminal';  // 'terminal' | 'files'
let _openFile    = null;        // { path, content, dirty }
let _fileTree    = null;

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
  _container = _selected = _runId = _fileTree = _openFile = null;
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
  if (!status.installed) {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
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
        ${setupGuide()}
      </div>`;
    document.getElementById('tofu-btn-new')?.addEventListener('click', () => openWorkspaceModal(null));
    return;
  }

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
    <span class="badge badge-offline">
      <i class="fas fa-times"></i> Binary not found in PATH
    </span>`;
  return `<span class="badge badge-online"><i class="fas fa-check"></i> ${esc(status.binary)} ${esc(status.version || '')}</span>`;
}

function setupGuide() {
  return `
    <div style="flex:1;overflow-y:auto;padding:32px 40px;">
      <div style="max-width:640px;">
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:24px 28px;margin-bottom:24px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <i class="fas fa-info-circle" style="color:var(--accent);font-size:1.1rem;"></i>
            <strong style="font-size:14px;">Setup required — OpenTofu/Terraform binary not found</strong>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin:0 0 20px 0;line-height:1.6;">
            Shipyard runs in Docker and cannot access binaries installed on your host directly.
            Create a <code style="font-family:var(--font-mono);background:var(--bg-tertiary,var(--bg));padding:1px 5px;border-radius:3px;">docker-compose.override.yml</code>
            next to your <code style="font-family:var(--font-mono);background:var(--bg-tertiary,var(--bg));padding:1px 5px;border-radius:3px;">docker-compose.yml</code>
            and add the following:
          </p>

          <div style="font-family:var(--font-mono);font-size:12.5px;background:var(--bg-tertiary,#111);
                      border:1px solid var(--border);border-radius:6px;padding:14px 16px;line-height:1.8;">
            <span style="color:var(--text-muted);">services:</span><br>
            <span style="color:var(--text-muted);">&nbsp;&nbsp;shipyard:</span><br>
            <span style="color:var(--text-muted);">&nbsp;&nbsp;&nbsp;&nbsp;volumes:</span><br>
            <span style="color:#4ade80;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- /usr/bin/tofu:/usr/bin/tofu:ro&nbsp;&nbsp;&nbsp;<span style="color:var(--text-muted);"># or /usr/bin/terraform</span></span><br>
            <span style="color:var(--text-muted);">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:var(--text-muted);"># also mount your .tf directories:</span></span><br>
            <span style="color:#60a5fa;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- /path/to/your/infra:/infra:rw</span>
          </div>

          <p style="font-size:12px;color:var(--text-muted);margin:14px 0 0 0;">
            Docker Compose merges override files automatically. After saving, restart:
            <code style="font-family:var(--font-mono);background:var(--bg-tertiary,var(--bg));padding:1px 5px;border-radius:3px;">docker compose up -d</code>
          </p>
        </div>

        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:24px 28px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
            <i class="fas fa-folder-open" style="color:var(--accent);font-size:1.1rem;"></i>
            <strong style="font-size:14px;">How workspaces work</strong>
          </div>
          <ul style="font-size:13px;color:var(--text-secondary);margin:0;padding-left:20px;line-height:2;">
            <li>Each workspace points to a <strong>path inside the container</strong> — not a path on your host.</li>
            <li>Mount your <code>.tf</code> directory via <code>docker-compose.override.yml</code>, e.g.<br>
                <code style="font-family:var(--font-mono);font-size:12px;">- /home/user/infra:/infra:rw</code> → then set the workspace path to <code>/infra</code>.</li>
            <li>Add cloud credentials (e.g. <code>AWS_ACCESS_KEY_ID</code>, <code>TF_VAR_*</code>) as environment variables inside the workspace settings.</li>
            <li>You can create workspaces now — they will work once the binary is mounted.</li>
          </ul>
        </div>
      </div>
    </div>`;
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
    _fileTree = null;
    _openFile = null;
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
async function renderDetail() {
  const detail = document.getElementById('tofu-detail');
  if (!detail) return;
  const ws = _workspaces.find(w => w.id === _selected);
  if (!ws) { detail.innerHTML = emptyDetail(); return; }

  let pathExists = true;
  try {
    const check = await _pluginApi.request(`/workspaces/${ws.id}/check`);
    pathExists = check.pathExists;
  } catch {}

  const pathWarning = pathExists ? '' : `
    <div style="background:#7f1d1d22;border:1px solid #ef444466;border-radius:6px;
                padding:10px 14px;margin:12px 24px 0;font-size:12.5px;line-height:1.7;flex-shrink:0;">
      <i class="fas fa-exclamation-triangle" style="color:#ef4444;margin-right:6px;"></i>
      <strong style="color:#ef4444;">Path not found inside container:</strong>
      <code style="font-family:var(--font-mono);margin:0 4px;">${esc(ws.path)}</code><br>
      Add to <code>docker-compose.override.yml</code>:
      <code style="font-family:var(--font-mono);display:block;margin-top:4px;padding:4px 8px;
                   background:var(--bg-secondary);border-radius:4px;">
        - /your/host/path:${esc(ws.path)}:rw
      </code>
      Then restart: <code>docker compose up -d</code>
    </div>`;

  const tabStyle = (t) => `cursor:pointer;padding:8px 16px;font-size:13px;border:none;background:none;
    border-bottom:2px solid ${_activeTab === t ? 'var(--accent)' : 'transparent'};
    color:${_activeTab === t ? 'var(--text-primary)' : 'var(--text-muted)'};`;

  detail.innerHTML = `
    <!-- Workspace header -->
    <div style="padding:16px 24px;border-bottom:1px solid var(--border);flex-shrink:0;
                display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
      <div>
        <div style="font-size:15px;font-weight:600;">${esc(ws.name)}</div>
        <div style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);margin-top:3px;">${esc(ws.path)}</div>
        ${ws.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${esc(ws.description)}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-secondary btn-sm" id="tofu-btn-edit"><i class="fas fa-pen"></i></button>
        <button class="btn btn-danger btn-sm" id="tofu-btn-delete"><i class="fas fa-trash"></i></button>
      </div>
    </div>

    ${pathWarning}

    <!-- Tabs -->
    <div style="display:flex;border-bottom:1px solid var(--border);flex-shrink:0;padding:0 16px;">
      <button id="tofu-tab-terminal" style="${tabStyle('terminal')}">
        <i class="fas fa-terminal" style="margin-right:6px;"></i>Terminal
      </button>
      <button id="tofu-tab-files" style="${tabStyle('files')}">
        <i class="fas fa-folder-open" style="margin-right:6px;"></i>Files
      </button>
    </div>

    <!-- Terminal tab -->
    <div id="tofu-tab-terminal-body" style="flex:1;overflow:hidden;display:${_activeTab==='terminal'?'flex':'none'};flex-direction:column;">
      <!-- Action buttons -->
      <div style="padding:10px 20px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn-secondary btn-sm tofu-action" data-action="init"><i class="fas fa-download"></i> init</button>
        <button class="btn btn-secondary btn-sm tofu-action" data-action="validate"><i class="fas fa-check-circle"></i> validate</button>
        <button class="btn btn-secondary btn-sm tofu-action" data-action="plan"><i class="fas fa-file-alt"></i> plan</button>
        <button class="btn btn-primary btn-sm tofu-action" data-action="apply"><i class="fas fa-play"></i> apply</button>
        <button class="btn btn-danger btn-sm tofu-action" data-action="destroy"><i class="fas fa-fire"></i> destroy</button>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
          <button class="btn btn-secondary btn-sm" id="tofu-btn-state" title="State list">
            <i class="fas fa-list"></i> State
          </button>
          <button class="btn btn-secondary btn-sm hidden" id="tofu-btn-cancel"><i class="fas fa-stop"></i> Cancel</button>
          <button class="btn btn-secondary btn-sm" id="tofu-btn-clear"><i class="fas fa-eraser"></i></button>
        </div>
      </div>
      <div style="flex:1;overflow:hidden;background:var(--bg-secondary);">
        <pre id="tofu-terminal"
          style="height:100%;overflow-y:auto;margin:0;padding:16px 20px;
                 font-family:var(--font-mono);font-size:12.5px;line-height:1.6;
                 white-space:pre-wrap;word-break:break-all;
                 color:var(--text-primary);background:transparent;border:none;"></pre>
      </div>
    </div>

    <!-- Files tab -->
    <div id="tofu-tab-files-body" style="flex:1;overflow:hidden;display:${_activeTab==='files'?'flex':'none'};">
      <div style="width:200px;flex-shrink:0;border-right:1px solid var(--border);
                  display:flex;flex-direction:column;background:var(--bg-secondary);">
        <div style="padding:6px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;
                    justify-content:space-between;flex-shrink:0;">
          <span style="font-size:11px;color:var(--text-muted);font-weight:500;text-transform:uppercase;
                       letter-spacing:.05em;">Files</span>
          <button class="btn btn-secondary btn-sm" id="tofu-btn-newfile" title="New file"
            style="padding:2px 7px;font-size:11px;">
            <i class="fas fa-plus"></i>
          </button>
        </div>
        <div id="tofu-file-tree" style="flex:1;overflow-y:auto;padding:4px 0;">
          <div style="padding:8px 12px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i></div>
        </div>
      </div>
      <div id="tofu-file-editor" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
        <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">
          <span>Select a file to edit</span>
        </div>
      </div>
    </div>`;

  bindDetailEvents(ws);
  if (_activeTab === 'files' && pathExists) loadFileTree(ws);
}

function bindDetailEvents(ws) {
  document.getElementById('tofu-btn-edit')?.addEventListener('click', () => openWorkspaceModal(ws));
  document.getElementById('tofu-btn-delete')?.addEventListener('click', () => deleteWorkspace(ws));
  document.getElementById('tofu-btn-clear')?.addEventListener('click', clearTerminal);
  document.getElementById('tofu-btn-cancel')?.addEventListener('click', () => cancelRun(ws));

  document.getElementById('tofu-tab-terminal')?.addEventListener('click', () => {
    _activeTab = 'terminal';
    document.getElementById('tofu-tab-terminal-body').style.display = 'flex';
    document.getElementById('tofu-tab-files-body').style.display = 'none';
    document.getElementById('tofu-tab-terminal').style.cssText +=
      ';border-bottom:2px solid var(--accent);color:var(--text-primary)';
    document.getElementById('tofu-tab-files').style.cssText +=
      ';border-bottom:2px solid transparent;color:var(--text-muted)';
  });

  document.getElementById('tofu-tab-files')?.addEventListener('click', () => {
    _activeTab = 'files';
    document.getElementById('tofu-tab-terminal-body').style.display = 'none';
    document.getElementById('tofu-tab-files-body').style.display = 'flex';
    document.getElementById('tofu-tab-terminal').style.cssText +=
      ';border-bottom:2px solid transparent;color:var(--text-muted)';
    document.getElementById('tofu-tab-files').style.cssText +=
      ';border-bottom:2px solid var(--accent);color:var(--text-primary)';
    if (!_fileTree) loadFileTree(ws);
  });

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

// ── File browser ───────────────────────────────────────────────────────────
async function loadFileTree(ws) {
  _fileTree = null;
  const treeEl = document.getElementById('tofu-file-tree');
  if (!treeEl) return;
  try {
    const data = await _pluginApi.request(`/workspaces/${ws.id}/files`);
    _fileTree = data.tree;
    treeEl.innerHTML = renderTree(_fileTree, ws);
    bindTreeEvents(ws);
  } catch (e) {
    treeEl.innerHTML = `<div style="padding:8px 12px;color:var(--offline);font-size:12px;">${esc(e.message)}</div>`;
  }
}

function renderTree(nodes, ws, depth = 0) {
  if (!nodes || nodes.length === 0) return `<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">Empty directory</div>`;
  return nodes.map(node => {
    const indent = depth * 12;
    if (node.type === 'dir') {
      const children = node.children?.length
        ? `<div id="tofu-dir-${CSS.escape(node.path)}">${renderTree(node.children, ws, depth + 1)}</div>`
        : '';
      return `
        <div class="tofu-tree-dir" data-path="${esc(node.path)}"
          style="padding:4px 8px 4px ${10 + indent}px;cursor:pointer;display:flex;align-items:center;gap:5px;
                 color:var(--text-secondary);user-select:none;">
          <i class="fas fa-folder" style="font-size:11px;color:#60a5fa;width:12px;flex-shrink:0;"></i>
          <span style="font-size:12px;">${esc(node.name)}</span>
        </div>
        ${children}`;
    }
    const icon = fileIcon(node.name);
    const isOpen = _openFile?.path === node.path;
    return `
      <div class="tofu-tree-file" data-path="${esc(node.path)}"
        style="padding:3px 6px 3px ${10 + indent}px;cursor:pointer;display:flex;align-items:center;gap:5px;
               border-radius:4px;margin:1px 4px;
               ${isOpen ? 'background:var(--accent-light);' : ''}">
        <i class="${icon}" style="font-size:11px;color:var(--text-muted);width:12px;flex-shrink:0;"></i>
        <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${esc(node.name)}</span>
        <button class="tofu-file-delete" data-path="${esc(node.path)}"
          title="Delete file"
          style="opacity:0;border:none;background:none;color:var(--offline);cursor:pointer;
                 padding:1px 3px;font-size:10px;flex-shrink:0;border-radius:3px;"
          onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=0">
          <i class="fas fa-trash"></i>
        </button>
      </div>`;
  }).join('');
}

function fileIcon(name) {
  if (name.endsWith('.tf'))       return 'fas fa-cube';
  if (name.endsWith('.tfvars'))   return 'fas fa-sliders-h';
  if (name.endsWith('.json'))     return 'fas fa-brackets-curly';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'fas fa-file-code';
  if (name.endsWith('.md'))       return 'fas fa-file-alt';
  if (name.endsWith('.sh'))       return 'fas fa-terminal';
  return 'fas fa-file';
}

function bindTreeEvents(ws) {
  document.getElementById('tofu-btn-newfile')?.addEventListener('click', () => promptNewFile(ws));

  document.getElementById('tofu-file-tree')?.addEventListener('click', async e => {
    const delBtn = e.target.closest('.tofu-file-delete');
    if (delBtn) {
      e.stopPropagation();
      deleteFile(ws, delBtn.dataset.path);
      return;
    }
    const fileEl = e.target.closest('.tofu-tree-file');
    if (fileEl) { openFileEditor(ws, fileEl.dataset.path); return; }
    const dirEl = e.target.closest('.tofu-tree-dir');
    if (dirEl) {
      const children = document.getElementById(`tofu-dir-${CSS.escape(dirEl.dataset.path)}`);
      if (children) children.style.display = children.style.display === 'none' ? '' : 'none';
    }
  });

  // Show delete button on row hover
  document.getElementById('tofu-file-tree')?.addEventListener('mouseover', e => {
    const row = e.target.closest('.tofu-tree-file');
    if (row) row.querySelector('.tofu-file-delete')?.style && (row.querySelector('.tofu-file-delete').style.opacity = '1');
  });
  document.getElementById('tofu-file-tree')?.addEventListener('mouseout', e => {
    const row = e.target.closest('.tofu-tree-file');
    if (row) row.querySelector('.tofu-file-delete')?.style && (row.querySelector('.tofu-file-delete').style.opacity = '0');
  });
}

function promptNewFile(ws) {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal" style="max-width:380px;width:95%;">
      <h2><i class="fas fa-file-plus"></i> New File</h2>
      <div class="form-body">
        <form id="tofu-newfile-form">
          <div class="form-group">
            <label class="form-label">Filename</label>
            <input class="form-input" id="tofu-newfile-name" type="text"
              placeholder="main.tf" autofocus style="font-family:var(--font-mono);">
            <div class="form-hint">Relative to workspace root. Use slashes for subdirectories: <code>modules/vpc/main.tf</code></div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="tofu-newfile-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => { overlay.classList.add('hidden'); overlay.innerHTML = ''; };
  document.getElementById('tofu-newfile-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('tofu-newfile-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('tofu-newfile-name').value.trim();
    if (!name) return;
    try {
      await _pluginApi.request(`/workspaces/${ws.id}/file`, { method: 'POST', body: { path: name } });
      close();
      _fileTree = null;
      await loadFileTree(ws);
      openFileEditor(ws, name);
      _showToast('File created', 'success');
    } catch (err) {
      _showToast('Error: ' + err.message, 'error');
    }
  });
  setTimeout(() => document.getElementById('tofu-newfile-name')?.focus(), 50);
}

async function deleteFile(ws, filePath) {
  const ok = await _showConfirm(`Delete <code>${esc(filePath)}</code>? This cannot be undone.`,
    { title: 'Delete File', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    if (_openFile?.path === filePath) {
      _openFile = null;
      const editorEl = document.getElementById('tofu-file-editor');
      if (editorEl) editorEl.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;"><span>Select a file to edit</span></div>`;
    }
    _fileTree = null;
    await loadFileTree(ws);
    _showToast('File deleted', 'success');
  } catch (err) {
    _showToast('Error: ' + err.message, 'error');
  }
}

async function openFileEditor(ws, filePath) {
  const editorEl = document.getElementById('tofu-file-editor');
  if (!editorEl) return;

  editorEl.innerHTML = `<div style="padding:12px 16px;flex-shrink:0;border-bottom:1px solid var(--border);
    display:flex;align-items:center;gap:8px;">
    <i class="fas fa-spinner fa-spin" style="color:var(--text-muted);"></i>
    <span style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);">${esc(filePath)}</span>
  </div>`;

  let content;
  try {
    const data = await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(filePath)}`);
    content = data.content;
  } catch (e) {
    editorEl.innerHTML = `<div style="padding:16px;color:var(--offline);">Error: ${esc(e.message)}</div>`;
    return;
  }

  _openFile = { path: filePath, content, dirty: false };

  // Highlight active file in tree
  document.querySelectorAll('.tofu-tree-file').forEach(el => {
    el.style.background = el.dataset.path === filePath ? 'var(--accent-light)' : '';
  });

  editorEl.innerHTML = `
    <div style="padding:8px 16px;flex-shrink:0;border-bottom:1px solid var(--border);
                display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div style="font-size:12px;font-family:var(--font-mono);color:var(--text-muted);
                  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="tofu-editor-path">
        ${esc(filePath)}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-secondary btn-sm" id="tofu-editor-reload" title="Reload from disk">
          <i class="fas fa-sync-alt"></i>
        </button>
        <button class="btn btn-primary btn-sm" id="tofu-editor-save" disabled>
          <i class="fas fa-save"></i> Save
        </button>
      </div>
    </div>
    <textarea id="tofu-editor-ta"
      style="flex:1;width:100%;box-sizing:border-box;resize:none;border:none;outline:none;
             font-family:var(--font-mono);font-size:12.5px;line-height:1.6;
             padding:16px 20px;background:var(--bg-secondary);color:var(--text-primary);
             tab-size:2;"
      spellcheck="false">${esc(content)}</textarea>`;

  const ta   = document.getElementById('tofu-editor-ta');
  const save = document.getElementById('tofu-editor-save');

  ta.addEventListener('input', () => {
    _openFile.dirty = true;
    save.disabled = false;
    save.innerHTML = '<i class="fas fa-save"></i> Save*';
  });

  // Tab key inserts spaces instead of leaving the field
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s + 2;
      _openFile.dirty = true;
      save.disabled = false;
    }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    save.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      await _pluginApi.request(`/workspaces/${ws.id}/file?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT', body: { content: ta.value },
      });
      _openFile.content = ta.value;
      _openFile.dirty = false;
      save.innerHTML = '<i class="fas fa-save"></i> Save';
      _showToast('File saved', 'success');
    } catch (err) {
      const msg = err.message.includes('Permission denied') || err.message.includes('EACCES')
        ? 'Permission denied — run on host: chown -R 1001:1001 ' + ws.path
        : 'Save failed: ' + err.message;
      _showToast(msg, 'error');
      save.disabled = false;
      save.innerHTML = '<i class="fas fa-save"></i> Save*';
    }
  });

  document.getElementById('tofu-editor-reload')?.addEventListener('click', () => {
    openFileEditor(ws, filePath);
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
              placeholder="/infra/production" value="${esc(existing?.path || '')}" required
              style="font-family:var(--font-mono);">
            <div class="form-hint">
              Path <strong>inside the container</strong> to the directory containing your <code>.tf</code> files.
              Mount your host directory first via <code>docker-compose.override.yml</code>, e.g.
              <code>- /home/user/infra:/infra:rw</code> → use <code>/infra</code> here.
              On a bare-metal install any host path works directly.
            </div>
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
