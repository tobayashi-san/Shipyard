import { api } from '../api.js';
import { state, navigate, openGlobalTerminal, hasCap } from '../main.js';
import { showToast, showConfirm, showPrompt } from './toast.js';
import { showAddServerModal } from './add-server-modal.js';
import { showRunPlaybookModal } from './run-playbook-modal.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

// Selection state – survives soft re-renders within the same page visit
let selectedIds = new Set();
let activeTag = null;
let serverGroups = [];
let collapsedGroups = new Set();

const PAGE_SIZE = 20;
let serverPage = 1;

export async function renderServers() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  try { serverGroups = await api.getServerGroups(); } catch { serverGroups = []; }

  const allTags = [...new Set(state.servers.flatMap(s => s.tags || []))].sort();
  const filtered = activeTag ? state.servers.filter(s => (s.tags || []).includes(activeTag)) : state.servers;

  const onlineCount  = state.servers.filter(s => s.status === 'online').length;
  const offlineCount = state.servers.filter(s => s.status === 'offline').length;
  const tagBar = allTags.length > 0 ? `
    <div class="tag-filter-bar">
      <button class="tag-filter-btn${activeTag === null ? ' active' : ''}" data-tag="">${t('srv.filterAll')}</button>
      ${allTags.map(tag => `<button class="tag-filter-btn${activeTag === tag ? ' active' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}
    </div>` : '';

  // With groups: no pagination (render all in grouped sections)
  // Without groups: paginate as before
  const useGroups = serverGroups.length > 0;
  let tableBody = '';
  let paginationHtml = '';
  const allSelected = filtered.length > 0 && filtered.every(s => selectedIds.has(s.id));

  if (useGroups) {
    tableBody = renderGroupedBody(filtered, serverGroups);
  } else {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (serverPage > totalPages) serverPage = totalPages;
    const pageServers = filtered.slice((serverPage - 1) * PAGE_SIZE, serverPage * PAGE_SIZE);
    tableBody = pageServers.map(s => renderRow(s)).join('');
    paginationHtml = renderPagination(serverPage, totalPages, filtered.length);
  }

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2>${t('srv.title')}</h2>
        <p>${t('srv.count', { total: state.servers.length, online: onlineCount, offline: offlineCount })}${activeTag ? ` · ${t('srv.filtered', { tag: activeTag })}` : ''}</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-secondary btn-sm" id="btn-refresh-all">
          <i class="fas fa-sync-alt"></i> ${t('common.refresh')}
        </button>
        <div class="btn-group" id="btn-export-wrap">
          <button class="btn btn-secondary btn-sm" id="btn-export-json" title="${t('srv.export')} JSON">
            <i class="fas fa-file-export"></i> JSON
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-export-csv" title="${t('srv.export')} CSV">
            <i class="fas fa-file-csv"></i> CSV
          </button>
        </div>
        <label class="btn btn-secondary btn-sm" title="${t('srv.import')}" style="cursor:pointer;margin:0;">
          <i class="fas fa-file-import"></i> ${t('srv.import')}
          <input type="file" id="btn-import-file" accept=".json,.csv" style="display:none;">
        </label>
        ${hasCap('canAddServers') ? `<button class="btn btn-secondary btn-sm" id="btn-create-group">
          <i class="fas fa-folder-plus"></i> ${t('srv.folder')}
        </button>
        <button class="btn btn-primary btn-sm" id="btn-add-server">
          <i class="fas fa-plus"></i> ${t('srv.add')}
        </button>` : ''}
      </div>
    </div>

    <!-- Bulk action bar -->
    <div id="bulk-bar" class="bulk-bar ${selectedIds.size === 0 ? 'hidden' : ''}">
      <span id="bulk-count" class="bulk-count">${t('srv.selected', { count: selectedIds.size })}</span>
      <div class="bulk-actions">
        <button class="btn btn-secondary btn-sm" id="btn-bulk-update">
          <i class="fas fa-download"></i> ${t('srv.startUpdates')}
        </button>
        <button class="btn btn-secondary btn-sm" id="btn-bulk-playbook">
          <i class="fas fa-play"></i> ${t('srv.runPlaybook')}
        </button>
      </div>
      <button class="btn-link bulk-deselect" id="btn-deselect-all">
        <i class="fas fa-times"></i> ${t('srv.deselect')}
      </button>
    </div>

    <div class="page-content">
      <div class="panel server-table-wrapper">
        ${tagBar}
        ${state.servers.length === 0 ? `
          <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-server"></i></div>
            <h3>${t('srv.noServers')}</h3>
            <p>${t('srv.noServersHint')}</p>
            ${hasCap('canAddServers') ? `<button class="btn btn-primary" id="btn-empty-add">
              <i class="fas fa-plus"></i> ${t('srv.add')}
            </button>` : ''}
          </div>
        ` : `
          <table class="data-table" id="server-table">
            <thead>
              <tr>
                <th style="width:36px;padding-right:0;">
                  <input type="checkbox" class="row-checkbox" id="select-all"
                    ${allSelected ? 'checked' : ''}
                    title="${t('common.all')}">
                </th>
                <th style="width:12px;padding-left:0;"></th>
                <th>${t('srv.colName')}</th>
                <th>${t('srv.colIp')}</th>
                <th>${t('srv.colOs')}</th>
                <th style="width:120px;">${t('srv.colCpu')}</th>
                <th style="width:120px;">${t('srv.colRam')}</th>
                <th style="width:120px;">${t('srv.colDisk')}</th>
                <th>${t('srv.colLastSeen')}</th>
                <th>${t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              ${tableBody}
            </tbody>
          </table>
          ${paginationHtml}
        `}
      </div>
    </div>
  `;

  attachEvents();
  // Load info for all visible server rows
  document.querySelectorAll('.server-row[data-server-id]').forEach(row => {
    loadServerInfo(row.dataset.serverId);
  });
}

function attachEvents() {
  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTag = btn.dataset.tag || null;
      serverPage = 1;
      renderServers();
    });
  });

  ['btn-add-server', 'btn-empty-add'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () =>
      showAddServerModal(() => navigate('servers'))
    );
  });

  // ── Ordner erstellen ──────────────────────────────────────
  document.getElementById('btn-create-group')?.addEventListener('click', async () => {
    const result = await showGroupDialog({ title: t('srv.createFolder'), confirmText: t('common.create'), groups: serverGroups });
    if (!result) return;
    try {
      await api.createServerGroup(result.name, result.color, result.parentId);
      showToast(t('srv.folderCreated'), 'success');
      renderServers();
    } catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
  });

  // ── Unterordner erstellen ─────────────────────────────────
  document.querySelectorAll('.create-subgroup-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const parentId = btn.dataset.parentId;
      const parent = serverGroups.find(g => g.id === parentId);
      const result = await showGroupDialog({ title: t('srv.newSubfolderIn', { parent: parent?.name || '' }), confirmText: t('common.create'), groups: serverGroups, defaultParentId: parentId });
      if (!result) return;
      try {
        await api.createServerGroup(result.name, result.color, result.parentId);
        showToast(t('srv.folderCreated'), 'success');
        renderServers();
      } catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
    });
  });

  // ── Gruppen: collapse, rename, delete ────────────────────
  document.querySelectorAll('.group-row').forEach(row => {
    const groupId = row.dataset.groupId;
    row.addEventListener('click', e => {
      if (e.target.closest('.group-header-actions')) return;
      collapsedGroups.has(groupId) ? collapsedGroups.delete(groupId) : collapsedGroups.add(groupId);
      renderServers();
    });
  });

  document.querySelectorAll('.rename-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      const group = serverGroups.find(g => g.id === groupId);
      const result = await showGroupDialog({ title: t('srv.editFolderTitle'), confirmText: t('common.save'), groups: serverGroups, defaultName: group?.name, defaultColor: group?.color, defaultParentId: group?.parent_id, editId: groupId });
      if (!result) return;
      try {
        await api.updateServerGroup(groupId, result.name, result.color);
        if (result.parentId !== (group?.parent_id || null)) {
          await api.setGroupParent(groupId, result.parentId);
        }
        showToast(t('srv.folderUpdated'), 'success');
        renderServers();
      } catch (err) { showToast(t('common.errorPrefix', { msg: err.message }), 'error'); }
    });
  });

  document.querySelectorAll('.delete-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const { groupId, groupName } = btn.dataset;
      if (!await showConfirm(`${t('srv.confirmDeleteFolder', { name: groupName })}<br><small style="color:var(--text-muted)">${t('srv.folderNote')}</small>`, { title: t('srv.deleteFolder'), confirmText: t('common.delete'), danger: true })) return;
      try {
        await api.deleteServerGroup(groupId);
        showToast(t('srv.folderDeleted'), 'success');
        renderServers();
      } catch (err) { showToast(t('common.errorPrefix', { msg: err.message }), 'error'); }
    });
  });

  // ── Server in Gruppe verschieben ──────────────────────────
  document.querySelectorAll('.btn-move-server').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeMoveDropdowns();
      const serverId = btn.dataset.serverId;
      const dropdown = document.createElement('div');
      dropdown.className = 'move-dropdown';
      dropdown.innerHTML = `
        <div class="move-dropdown-item" data-group-id="">
          <i class="fas fa-times-circle" style="color:var(--text-muted)"></i> ${t('srv.moveToRoot')}
        </div>
        ${serverGroups.map(g => `
          <div class="move-dropdown-item" data-group-id="${g.id}">
            <i class="fas fa-folder" style="color:var(--accent)"></i> ${esc(g.name)}
          </div>
        `).join('')}
      `;
      // Position relative to viewport so it never pushes the card
      const btnRect = btn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.right = 'auto';
      dropdown.style.top = 'auto';
      dropdown.style.left = (btnRect.right - 180) + 'px';
      document.body.appendChild(dropdown);
      // After render, decide: open up or down
      const ddH = dropdown.offsetHeight;
      const spaceBelow = window.innerHeight - btnRect.bottom;
      if (spaceBelow < ddH + 8) {
        dropdown.style.top = (btnRect.top - ddH - 4) + 'px';
      } else {
        dropdown.style.top = (btnRect.bottom + 4) + 'px';
      }
      dropdown.querySelectorAll('.move-dropdown-item').forEach(item => {
        item.addEventListener('click', async ev => {
          ev.stopPropagation();
          closeMoveDropdowns();
          const groupId = item.dataset.groupId || null;
          try {
            await api.setServerGroup(serverId, groupId);
            const srv = state.servers.find(s => s.id === serverId);
            if (srv) srv.group_id = groupId;
            if (groupId) {
              const grp = serverGroups.find(g => g.id === groupId);
              showToast(t('srv.movedTo', { group: grp?.name || groupId }), 'success');
            } else {
              showToast(t('srv.movedOut'), 'success');
            }
            renderServers();
          } catch (err) { showToast(t('common.errorPrefix', { msg: err.message }), 'error'); }
        });
      });
      setTimeout(() => document.addEventListener('click', closeMoveDropdowns, { once: true }), 0);
    });
  });

  // ── Drag & Drop ───────────────────────────────────────────
  document.querySelectorAll('.server-row[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', 'server:' + row.dataset.serverId);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });

  document.querySelectorAll('.group-row[draggable]').forEach(row => {
    row.addEventListener('dragstart', e => {
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', 'group:' + row.dataset.groupId);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });

  document.querySelectorAll('.group-row').forEach(row => {
    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
    });
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      const targetGroupId = row.dataset.groupId || null;

      if (raw.startsWith('server:')) {
        const serverId = raw.slice(7);
        try {
          await api.setServerGroup(serverId, targetGroupId);
          const srv = state.servers.find(s => s.id === serverId);
          if (srv) srv.group_id = targetGroupId;
          renderServers();
        } catch (err) { showToast(t('common.errorPrefix', { msg: err.message }), 'error'); }
      } else if (raw.startsWith('group:')) {
        const groupId = raw.slice(6);
        if (groupId === targetGroupId) return;
        // Prevent circular: don't drop onto self or descendants
        const getDescIds = (id) => {
          const ids = new Set([id]);
          const addChildren = (pid) => serverGroups.filter(g => g.parent_id === pid).forEach(g => { ids.add(g.id); addChildren(g.id); });
          addChildren(id);
          return ids;
        };
        if (targetGroupId && getDescIds(groupId).has(targetGroupId)) {
          showToast(t('srv.cantMoveToChild'), 'warning');
          return;
        }
        try {
          await api.setGroupParent(groupId, targetGroupId);
          const grp = serverGroups.find(g => g.id === groupId);
          if (grp) grp.parent_id = targetGroupId;
          renderServers();
        } catch (err) { showToast(t('common.errorPrefix', { msg: err.message }), 'error'); }
      }
    });
  });

  // ── Export ────────────────────────────────────────────────
  document.getElementById('btn-export-json')?.addEventListener('click', async () => {
    try { await api.exportServers('json'); }
    catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
  });
  document.getElementById('btn-export-csv')?.addEventListener('click', async () => {
    try { await api.exportServers('csv'); }
    catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
  });

  // ── Import ────────────────────────────────────────────────
  document.getElementById('btn-import-file')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const text = await file.text();
    let servers = [];

    try {
      if (file.name.endsWith('.csv')) {
        servers = parseCsvServers(text);
      } else {
        const parsed = JSON.parse(text);
        servers = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      showToast(t('srv.fileReadError'), 'error');
      return;
    }

    if (servers.length === 0) {
      showToast(t('srv.noValidServers'), 'error');
      return;
    }

    try {
      const result = await api.importServers(servers);
      showToast(
        t('srv.importDone', { created: result.created, skipped: result.skipped }),
        result.created > 0 ? 'success' : 'info'
      );
      if (result.created > 0) {
        const updated = await api.getServers();
        state.servers = updated.map(s => ({
          ...s,
          services: typeof s.services === 'string' ? JSON.parse(s.services) : s.services || [],
          tags:     typeof s.tags     === 'string' ? JSON.parse(s.tags)     : s.tags     || [],
        }));
        serverPage = 1;
        renderServers();
      }
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    }
  });

  document.getElementById('btn-refresh-all')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-all');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.loading')}`;
    try {
      const servers = await api.getServers();
      state.servers = servers.map(s => ({
        ...s,
        services: typeof s.services === 'string' ? JSON.parse(s.services) : s.services || [],
        tags:     typeof s.tags     === 'string' ? JSON.parse(s.tags)     : s.tags     || [],
      }));
      renderServers();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    }
  });

  // ── Visible servers helper (respects groups/pagination) ──
  function getVisibleServers() {
    const filtered = activeTag ? state.servers.filter(s => (s.tags || []).includes(activeTag)) : state.servers;
    if (serverGroups.length > 0) return filtered;
    return filtered.slice((serverPage - 1) * PAGE_SIZE, serverPage * PAGE_SIZE);
  }

  // ── Select all (current page) ─────────────────────────────
  document.getElementById('select-all')?.addEventListener('change', e => {
    const visible = getVisibleServers();
    if (e.target.checked) {
      visible.forEach(s => selectedIds.add(s.id));
    } else {
      visible.forEach(s => selectedIds.delete(s.id));
    }
    updateBulkBar();
    document.querySelectorAll('.server-checkbox').forEach(cb => {
      cb.checked = e.target.checked;
    });
  });

  // ── Per-row checkboxes ────────────────────────────────────
  document.querySelectorAll('.server-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = cb.dataset.serverId;
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBulkBar();
      const visible = getVisibleServers();
      const selectAll = document.getElementById('select-all');
      if (selectAll) {
        const pageSelected = visible.filter(s => selectedIds.has(s.id)).length;
        selectAll.checked = pageSelected === visible.length;
        selectAll.indeterminate = pageSelected > 0 && pageSelected < visible.length;
      }
    });
  });

  // ── Deselect all ──────────────────────────────────────────
  document.getElementById('btn-deselect-all')?.addEventListener('click', () => {
    selectedIds.clear();
    updateBulkBar();
    document.querySelectorAll('.server-checkbox, #select-all').forEach(cb => {
      cb.checked = false;
      cb.indeterminate = false;
    });
  });

  // ── Bulk: Updates ─────────────────────────────────────────
  document.getElementById('btn-bulk-update')?.addEventListener('click', async () => {
    const names = getSelectedNames();
    if (!names.length) return;

    const btn = document.getElementById('btn-bulk-update');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.loading')}`;

    try {
      openGlobalTerminal(`Updates: ${names.join(', ')}`);
      await api.runPlaybook('update.yml', names.join(','), {});
      showToast(t('srv.updatesStarted', { count: names.length }), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-download"></i> ${t('srv.startUpdates')}`;
    }
  });

  // ── Bulk: Playbook ────────────────────────────────────────
  document.getElementById('btn-bulk-playbook')?.addEventListener('click', () => {
    const names = getSelectedNames();
    if (!names.length) return;
    showRunPlaybookModal(() => {}, names);
  });

  // ── Pagination ────────────────────────────────────────────
  document.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      serverPage = parseInt(btn.dataset.page);
      renderServers();
    });
  });

  // ── Row navigation (click anywhere except checkbox/actions) ──
  document.querySelectorAll('.server-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.row-actions') || e.target.closest('.checkbox-cell')) return;
      navigate('server-detail', { serverId: row.dataset.serverId });
    });
  });

  document.querySelectorAll('.btn-edit-server').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const server = state.servers.find(s => s.id === btn.dataset.serverId);
      if (server) showAddServerModal(() => navigate('servers'), server);
    });
  });

  document.querySelectorAll('.btn-delete-server').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const { serverId, serverName } = btn.dataset;
      if (!await showConfirm(`${t('srv.confirmDelete', { name: serverName })}<br><small style="color:var(--text-muted)">${t('srv.cantUndone')}</small>`, { title: t('srv.delete'), confirmText: t('common.delete'), danger: true })) return;
      btn.disabled = true;
      try {
        await api.deleteServer(serverId);
        state.servers = state.servers.filter(s => s.id !== serverId);
        selectedIds.delete(serverId);
        showToast(t('srv.deleted'), 'success');
        renderServers();
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
        btn.disabled = false;
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────

function parseCsvServers(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // CSV split: respects quoted fields, handles "" escaped quotes inside quotes
    const fields = [];
    let cur = '', inQ = false, i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; } // escaped ""
        if (ch === '"') { inQ = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') { inQ = true; }
        else if (ch === ',') { fields.push(cur); cur = ''; }
        else { cur += ch; }
      }
      i++;
    }
    fields.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (fields[i] ?? ''); });
    // Parse JSON arrays back
    try { obj.tags     = JSON.parse(obj.tags     || '[]'); } catch { obj.tags     = []; }
    try { obj.services = JSON.parse(obj.services || '[]'); } catch { obj.services = []; }
    obj.ssh_port = parseInt(obj.ssh_port) || 22;
    return obj;
  }).filter(o => o.name && o.ip_address);
}

function renderPagination(current, total, totalItems) {
  if (total <= 1) return '';
  const from = (current - 1) * PAGE_SIZE + 1;
  const to   = Math.min(current * PAGE_SIZE, totalItems);
  let pages = '';
  for (let i = 1; i <= total; i++) {
    if (total > 7 && Math.abs(i - current) > 2 && i !== 1 && i !== total) {
      if (i === current - 3 || i === current + 3) pages += `<button disabled>…</button>`;
      continue;
    }
    pages += `<button class="page-btn${i === current ? ' active' : ''}" data-page="${i}">${i}</button>`;
  }
  return `
    <div class="pagination">
      <span class="pagination-info">${t('srv.pageInfo', { from, to, total: totalItems })}</span>
      <div class="pagination-controls">
        <button class="page-btn" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''}>‹</button>
        ${pages}
        <button class="page-btn" data-page="${current + 1}" ${current === total ? 'disabled' : ''}>›</button>
      </div>
    </div>
  `;
}

function getSelectedNames() {
  return state.servers
    .filter(s => selectedIds.has(s.id))
    .map(s => s.name);
}

function closeMoveDropdowns() {
  document.querySelectorAll('.move-dropdown').forEach(d => d.remove());
}

const PRESET_COLORS = ['#6366f1','#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];

function showGroupDialog({ title = '', confirmText = '', groups = [], defaultName = '', defaultColor = '#6366f1', defaultParentId = null, editId = null } = {}) {
  return new Promise((resolve) => {
    let selectedColor = defaultColor || '#6366f1';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Build parent options excluding self and own descendants
    const getDescendantIds = (id) => {
      const ids = new Set([id]);
      const addChildren = (pid) => groups.filter(g => g.parent_id === pid).forEach(g => { ids.add(g.id); addChildren(g.id); });
      addChildren(id);
      return ids;
    };
    const excludeIds = editId ? getDescendantIds(editId) : new Set();
    const parentOptions = groups.filter(g => !excludeIds.has(g.id));

    overlay.innerHTML = `
      <div class="modal" style="max-width:400px;">
        <div class="modal-header"><h3 class="modal-title">${esc(title)}</h3></div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <label class="form-label">${t('common.name')}</label>
            <input class="form-input" id="gd-name" type="text" value="${esc(defaultName)}" placeholder="${t('srv.groupNamePlaceholder')}" style="width:100%;">
          </div>
          <div>
            <label class="form-label">${t('srv.groupColor')}</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              ${PRESET_COLORS.map(c => `
                <button class="color-swatch${c === selectedColor ? ' active' : ''}" data-color="${c}" style="background:${c};width:24px;height:24px;border-radius:50%;border:2px solid ${c === selectedColor ? '#fff' : 'transparent'};outline:2px solid ${c === selectedColor ? c : 'transparent'};cursor:pointer;"></button>
              `).join('')}
              <input type="color" id="gd-custom-color" value="${selectedColor}" title="${t('common.customColor')}" style="width:24px;height:24px;padding:0;border:none;border-radius:50%;cursor:pointer;background:none;">
            </div>
          </div>
          <div>
            <label class="form-label">${t('srv.parentFolder')}</label>
            <select class="form-input" id="gd-parent">
              <option value="">${t('srv.noneTopLevel')}</option>
              ${parentOptions.map(g => `<option value="${g.id}"${g.id === defaultParentId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="gd-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" id="gd-ok">${confirmText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#gd-name');
    const customColor = overlay.querySelector('#gd-custom-color');
    nameInput.focus(); nameInput.select();

    const setColor = (color) => {
      selectedColor = color;
      customColor.value = color;
      overlay.querySelectorAll('.color-swatch').forEach(s => {
        const active = s.dataset.color === color;
        s.style.border = `2px solid ${active ? '#fff' : 'transparent'}`;
        s.style.outline = `2px solid ${active ? color : 'transparent'}`;
      });
    };

    overlay.querySelectorAll('.color-swatch').forEach(s => {
      s.addEventListener('click', () => setColor(s.dataset.color));
    });
    customColor.addEventListener('input', () => {
      selectedColor = customColor.value;
      overlay.querySelectorAll('.color-swatch').forEach(s => {
        s.style.border = '2px solid transparent';
        s.style.outline = '2px solid transparent';
      });
    });

    const cleanup = (result) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); };
    const submit = () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      cleanup({ name, color: selectedColor, parentId: overlay.querySelector('#gd-parent').value || null });
    };

    overlay.querySelector('#gd-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#gd-ok').addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });

    const onKey = (e) => { if (e.key === 'Escape') cleanup(null); };
    document.addEventListener('keydown', onKey);
  });
}

function buildGroupTree(groups, parentId = null) {
  return groups
    .filter(g => (g.parent_id || null) === parentId)
    .map(g => ({ ...g, children: buildGroupTree(groups, g.id) }));
}

function renderGroupNode(node, depth, serversByGroup) {
  const members = serversByGroup[node.id] || [];
  const collapsed = collapsedGroups.has(node.id);
  const indent = depth * 20;
  const color = node.color || '#6366f1';

  let html = `<tr class="group-row" data-group-id="${node.id}" draggable="true">
    <td colspan="10" style="border-left:3px solid ${color};">
      <div class="group-header-inner" style="padding-left:${11 + indent}px;">
        <i class="fas fa-chevron-${collapsed ? 'right' : 'down'}" style="font-size:11px;color:var(--text-muted);width:14px;flex-shrink:0;"></i>
        <i class="fas fa-folder${collapsed ? '' : '-open'}" style="color:${color};flex-shrink:0;"></i>
        <span class="group-name">${esc(node.name)}</span>
        <div class="group-header-actions">
          ${hasCap('canAddServers') ? `<button class="btn btn-secondary btn-sm create-subgroup-btn" data-parent-id="${node.id}" title="${t('srv.createSubfolder')}"><i class="fas fa-folder-plus"></i></button>` : ''}
          ${hasCap('canEditServers') ? `<button class="btn btn-secondary btn-sm rename-group-btn" data-group-id="${node.id}" title="${t('srv.editFolder')}"><i class="fas fa-pen"></i></button>` : ''}
          ${hasCap('canDeleteServers') ? `<button class="btn btn-danger btn-sm delete-group-btn" data-group-id="${node.id}" data-group-name="${esc(node.name)}" title="${t('srv.deleteFolder')}"><i class="fas fa-trash"></i></button>` : ''}
        </div>
        <span class="group-badge">${members.length + countDescendantServers(node, serversByGroup)}</span>
      </div>
    </td>
  </tr>`;

  if (!collapsed) {
    if (members.length === 0 && node.children.length === 0) {
      html += `<tr class="empty-group-placeholder"><td colspan="10"><span style="padding-left:${14 + indent + 34}px;"><i class="fas fa-info-circle"></i> ${t('srv.emptyGroup')}</span></td></tr>`;
    } else {
      html += members.map(s => renderRow(s, depth + 1, color)).join('');
    }
    for (const child of node.children) {
      html += renderGroupNode(child, depth + 1, serversByGroup);
    }
  }
  return html;
}

function countDescendantServers(node, serversByGroup) {
  let count = 0;
  for (const child of node.children || []) {
    count += (serversByGroup[child.id] || []).length + countDescendantServers(child, serversByGroup);
  }
  return count;
}

function renderGroupedBody(servers, groups) {
  const serversByGroup = {};
  const ungrouped = [];
  for (const s of servers) {
    const gid = s.group_id;
    if (gid && groups.find(g => g.id === gid)) {
      (serversByGroup[gid] = serversByGroup[gid] || []).push(s);
    } else {
      ungrouped.push(s);
    }
  }

  let html = '';

  // Ungrouped / root drop zone — always shown so folders can be dragged to top level
  html += `<tr class="group-row ungrouped-group-row">
    <td colspan="10">
      <div class="group-header-inner">
        <i class="fas fa-server" style="color:var(--text-muted);font-size:12px;"></i>
        <span style="color:var(--text-muted);">${t('srv.moveToRoot')}</span>
        ${ungrouped.length > 0 ? `<span class="group-badge">${ungrouped.length}</span>` : ''}
      </div>
    </td>
  </tr>`;
  html += ungrouped.map(s => renderRow(s)).join('');

  // Build tree and render
  const tree = buildGroupTree(groups);
  for (const node of tree) {
    html += renderGroupNode(node, 0, serversByGroup);
  }
  return html;
}

function updateBulkBar() {
  const bar   = document.getElementById('bulk-bar');
  const count = document.getElementById('bulk-count');
  if (!bar) return;
  const n = selectedIds.size;
  if (n === 0) {
    bar.classList.add('hidden');
  } else {
    bar.classList.remove('hidden');
    if (count) count.textContent = t('srv.selected', { count: n });
  }
}

function renderRow(server, depth = 0, folderColor = null) {
  const dotCls  = server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown';
  const lastSeen = server.last_seen ? formatRelativeTime(server.last_seen) : '—';
  const checked  = selectedIds.has(server.id) ? 'checked' : '';
  const borderStyle = folderColor ? `border-left:3px solid ${folderColor};` : '';
  const nameIndent  = folderColor ? 14 + (depth - 1) * 14 : 14;
  return `
    <tr class="server-row" data-server-id="${server.id}" draggable="true">
      <td class="checkbox-cell" style="padding-right:6px;${borderStyle}">
        <input type="checkbox" class="server-checkbox row-checkbox" data-server-id="${server.id}" ${checked}>
      </td>
      <td style="padding-left:6px;padding-right:0;"><span class="status-dot ${dotCls}"></span></td>
      <td style="padding-left:${nameIndent}px;">
        <strong>${esc(server.name)}</strong>
        ${(server.tags || []).map(tag => `<span class="server-tag">${esc(tag)}</span>`).join('')}
      </td>
      <td class="mono">${esc(server.ip_address || '—')}</td>
      <td id="os-${server.id}" class="mono" style="color:var(--text-muted);">—</td>
      <td id="cpu-${server.id}">
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="cpu-bar-${server.id}"></div></div>
          <span class="text-mono" id="cpu-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td id="ram-${server.id}">
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="ram-bar-${server.id}"></div></div>
          <span class="text-mono" id="ram-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td id="disk-${server.id}">
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="disk-bar-${server.id}"></div></div>
          <span class="text-mono" id="disk-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td class="text-mono" style="color:var(--text-muted);font-size:11px;">${lastSeen}</td>
      <td class="row-actions" style="white-space:nowrap;">
        ${serverGroups.length > 0 && hasCap('canEditServers') ? `<button class="btn btn-secondary btn-sm btn-move-server" data-server-id="${server.id}" title="${t('srv.moveTo')}"><i class="fas fa-folder-open"></i></button>` : ''}
        ${hasCap('canEditServers') ? `<button class="btn btn-secondary btn-sm btn-edit-server" data-server-id="${server.id}" title="${t('srv.edit')}">
          <i class="fas fa-edit"></i>
        </button>` : ''}
        ${hasCap('canDeleteServers') ? `<button class="btn btn-danger btn-sm btn-delete-server" data-server-id="${server.id}" data-server-name="${esc(server.name)}" title="${t('srv.delete')}">
          <i class="fas fa-trash"></i>
        </button>` : ''}
      </td>
    </tr>
  `;
}

export async function refreshServersInPlace() {
  const rows = document.querySelectorAll('.server-row[data-server-id]');
  if (!rows.length) return;
  rows.forEach(row => loadServerInfo(row.dataset.serverId));
}

async function loadServerInfo(serverId) {
  try {
    const info = await api.getServerInfo(serverId);
    if (!info) return;
    const osEl = document.getElementById(`os-${serverId}`);
    if (osEl) osEl.textContent = (info.os || '').split(' ')[0] || '—';
    if (info.cpu_usage_pct != null) {
      const pct = info.cpu_usage_pct;
      updateBar(`cpu-bar-${serverId}`, pct);
      const el = document.getElementById(`cpu-val-${serverId}`);
      if (el) el.textContent = pct + '%';
    }
    if (info.ram_total_mb) {
      const pct = Math.round((info.ram_used_mb / info.ram_total_mb) * 100);
      updateBar(`ram-bar-${serverId}`, pct);
      const el = document.getElementById(`ram-val-${serverId}`);
      if (el) el.textContent = pct + '%';
    }
    if (info.disk_total_gb) {
      const pct = Math.round((info.disk_used_gb / info.disk_total_gb) * 100);
      updateBar(`disk-bar-${serverId}`, pct);
      const el = document.getElementById(`disk-val-${serverId}`);
      if (el) el.textContent = pct + '%';
    }
  } catch {}
}

function updateBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = pct + '%';
  el.className = 'progress-fill' + (pct > 90 ? ' critical' : pct > 70 ? ' high' : '');
}

function formatRelativeTime(dateStr) {
  // SQLite datetime('now') is UTC but has no 'Z' suffix — add it explicitly
  const utc = dateStr && !dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
  const diff = Math.floor((Date.now() - new Date(utc)) / 1000);
  if (diff < 60)    return t('dash.justNow');
  if (diff < 3600)  return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}
