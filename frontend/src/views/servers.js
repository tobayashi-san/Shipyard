import { api } from '../api.js';
import { state, hasCap } from '../app/state.js';
import { navigate } from '../app/router.js';
import { openGlobalTerminal } from '../terminal/global-terminal.js';
import { showToast, showConfirm, showPrompt } from '../components/toast.js';
import { showAddServerModal } from '../modals/add-server-modal.js';
import { showRunPlaybookModal } from '../modals/run-playbook-modal.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';
import { activateDialog } from '../utils/dialog.js';

// Selection state – survives soft re-renders within the same page visit
let selectedIds = new Set();
let activeTag = null;
let serverGroups = [];
let collapsedGroups = new Set();

const STORAGE_KEY_COLLAPSED_SERVER_GROUPS = 'shipyard.ui.servers.collapsedGroups';
const STORAGE_KEY_SERVERS_EDIT_MODE = 'shipyard.ui.servers.editMode';
let serversEditMode = loadServersEditMode();

function loadServersEditMode() {
  try {
    return localStorage.getItem(STORAGE_KEY_SERVERS_EDIT_MODE) === '1';
  } catch {
    return false;
  }
}

function saveServersEditMode() {
  try {
    localStorage.setItem(STORAGE_KEY_SERVERS_EDIT_MODE, serversEditMode ? '1' : '0');
  } catch {
    // ignore
  }
}

function loadCollapsedGroups() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED_SERVER_GROUPS);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(v => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups() {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSED_SERVER_GROUPS, JSON.stringify([...collapsedGroups]));
  } catch {
    // ignore storage quota / privacy mode
  }
}

collapsedGroups = loadCollapsedGroups();

const PAGE_SIZE = 20;
let serverPage = 1;

function normalizeServer(server) {
  return {
    ...server,
    services: typeof server.services === 'string' ? JSON.parse(server.services) : server.services || [],
    tags: typeof server.tags === 'string' ? JSON.parse(server.tags) : server.tags || [],
    links: typeof server.links === 'string' ? JSON.parse(server.links) : server.links || [],
  };
}

async function reloadServersState() {
  const servers = await api.getServers();
  state.servers = servers.map(normalizeServer);
}

function isMobileServersLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

export async function renderServers() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  try { serverGroups = await api.getServerGroups(); } catch { serverGroups = []; }
  // prune collapsed ids that no longer exist
  if (collapsedGroups.size > 0 && serverGroups.length > 0) {
    const valid = new Set(serverGroups.map(g => g.id));
    const before = collapsedGroups.size;
    collapsedGroups.forEach(id => { if (!valid.has(id)) collapsedGroups.delete(id); });
    if (collapsedGroups.size !== before) saveCollapsedGroups();
  }

  const allTags = [...new Set(state.servers.flatMap(s => s.tags || []))].sort();
  const filtered = activeTag ? state.servers.filter(s => (s.tags || []).includes(activeTag)) : state.servers;
  const mobileLayout = isMobileServersLayout();

  const onlineCount = state.servers.filter(s => s.status === 'online').length;
  const offlineCount = state.servers.filter(s => s.status === 'offline').length;
  const tagBar = allTags.length > 0 ? `
    <div class="tag-filter-bar">
      <button class="tag-filter-btn${activeTag === null ? ' active' : ''}" data-tag="">${t('srv.filterAll')}</button>
      ${allTags.map(tag => `<button class="tag-filter-btn${activeTag === tag ? ' active' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}
    </div>` : '';

  // With groups: no pagination (render all in grouped sections)
  // Without groups: paginate as before
  const useGroups = serverGroups.length > 0;
  let bodyMarkup = '';
  let paginationHtml = '';
  let visibleServers = filtered;

  if (useGroups) {
    bodyMarkup = mobileLayout ? renderGroupedCards(filtered, serverGroups) : renderGroupedBody(filtered, serverGroups);
  } else {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (serverPage > totalPages) serverPage = totalPages;
    const pageServers = filtered.slice((serverPage - 1) * PAGE_SIZE, serverPage * PAGE_SIZE);
    visibleServers = pageServers;
    bodyMarkup = mobileLayout ? pageServers.map(s => renderServerCard(s)).join('') : pageServers.map(s => renderRow(s)).join('');
    paginationHtml = renderPagination(serverPage, totalPages, filtered.length);
  }

  const allSelected = visibleServers.length > 0 && visibleServers.every(s => selectedIds.has(s.id));

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2>${t('srv.title')}</h2>
        <p>${t('srv.count', { total: state.servers.length, online: onlineCount, offline: offlineCount })}${activeTag ? ` · ${t('srv.filtered', { tag: activeTag })}` : ''}</p>
      </div>
      <div class="page-header-actions">
        ${hasCap('canAddServers') ? `<button class="btn btn-primary btn-sm" id="btn-add-server">
          <i class="fas fa-plus"></i> ${t('srv.add')}
        </button>` : ''}
        <button class="btn btn-icon" id="btn-refresh-all" title="${t('common.refresh')}">
          <i class="fas fa-sync-alt"></i>
        </button>
        <div class="action-overflow-wrap">
          <button class="action-overflow-trigger" id="btn-servers-overflow" title="${t('common.actions')}"><i class="fas fa-ellipsis-vertical"></i></button>
          <div class="action-overflow-menu" id="servers-overflow-menu">
            ${hasCap('canAddServers') ? `<button class="action-overflow-item" id="btn-create-group"><i class="fas fa-folder-plus"></i> ${t('srv.folder')}</button>` : ''}
            ${hasCap('canEditServers') ? `<button class="action-overflow-item" id="btn-auto-group-tags"><i class="fas fa-tags"></i> ${t('srv.autoGroupFromTags')}</button>` : ''}
            ${serverGroups.length > 0 && hasCap('canEditServers') ? `<button class="action-overflow-item" id="btn-toggle-edit"><i class="fas ${serversEditMode ? 'fa-lock-open' : 'fa-lock'}"></i> ${serversEditMode ? 'Done' : 'Edit'}</button>` : ''}
            ${hasCap('canExportImportServers') ? `<div class="action-overflow-sep"></div>
            <button class="action-overflow-item" id="btn-export-json"><i class="fas fa-file-export"></i> ${t('srv.export')} JSON</button>
            <button class="action-overflow-item" id="btn-export-csv"><i class="fas fa-file-csv"></i> ${t('srv.export')} CSV</button>
            <label class="action-overflow-item" style="cursor:pointer;margin:0;">
              <i class="fas fa-file-import"></i> ${t('srv.import')}
              <input type="file" id="btn-import-file" accept=".json,.csv" style="display:none;">
            </label>` : ''}
          </div>
        </div>
      </div>
    </div>

    <!-- Bulk action bar -->
    <div id="bulk-bar" class="bulk-bar ${selectedIds.size === 0 ? 'hidden' : ''}">
      <span id="bulk-count" class="bulk-count">${t('srv.selected', { count: selectedIds.size })}</span>
      <div class="bulk-actions">
        ${hasCap('canRunUpdates') ? `<button class="btn btn-secondary btn-sm" id="btn-bulk-update">
          <i class="fas fa-download"></i> ${t('srv.startUpdates')}
        </button>` : ''}
        ${hasCap('canRunPlaybooks') ? `<button class="btn btn-secondary btn-sm" id="btn-bulk-playbook">
          <i class="fas fa-play"></i> ${t('srv.runPlaybook')}
        </button>` : ''}
      </div>
      <button class="btn-link bulk-deselect" id="btn-deselect-all">
        <i class="fas fa-times"></i> ${t('srv.deselect')}
      </button>
    </div>

    <div class="page-content ${serversEditMode ? 'servers-edit-on' : ''}">
      <div class="panel dash-panel server-table-wrapper">
        <div class="dash-panel-header">
          <div class="dash-panel-header-left">
            <div class="dash-panel-icon"><i class="fas fa-server"></i></div>
            <span class="dash-panel-title">${t('srv.title')}</span>
            <span class="badge badge-muted" style="font-size:10px;">${state.servers.length}</span>
          </div>
        </div>
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
          ${mobileLayout ? `
            <div class="servers-mobile-toolbar">
              <label class="servers-mobile-select-all" for="select-all">
                <input type="checkbox" class="row-checkbox" id="select-all"
                  ${allSelected ? 'checked' : ''}
                  title="${t('common.all')}">
                <span>${t('common.all')}</span>
              </label>
            </div>
            <div class="servers-mobile-list">
              ${bodyMarkup}
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
                ${bodyMarkup}
              </tbody>
            </table>
          `}
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
  // Overflow menu toggle
  const srvOverflowBtn = document.getElementById('btn-servers-overflow');
  const srvOverflowMenu = document.getElementById('servers-overflow-menu');
  if (srvOverflowBtn && srvOverflowMenu) {
    srvOverflowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      srvOverflowMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => srvOverflowMenu.classList.remove('open'));
    srvOverflowMenu.addEventListener('click', () => srvOverflowMenu.classList.remove('open'));
  }

  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTag = btn.dataset.tag || null;
      serverPage = 1;
      renderServers();
    });
  });

  ['btn-add-server', 'btn-empty-add'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () =>
      showAddServerModal(async () => {
        await reloadServersState();
        await renderServers();
      })
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

  document.getElementById('btn-auto-group-tags')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-auto-group-tags');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.loading')}`;
    try {
      const result = await api.autoGroupServersByTags();
      await reloadServersState();
      await renderServers();
      if (result.moved > 0) showToast(t('srv.autoGroupDone', { moved: result.moved, matched: result.matched }), 'success');
      else showToast(t('srv.autoGroupNone'), 'info');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-tags"></i> ${t('srv.autoGroupFromTags')}`;
    }
  });

  document.getElementById('btn-toggle-edit')?.addEventListener('click', () => {
    serversEditMode = !serversEditMode;
    saveServersEditMode();
    renderServers();
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
      if (!groupId) return;
      collapsedGroups.has(groupId) ? collapsedGroups.delete(groupId) : collapsedGroups.add(groupId);
      saveCollapsedGroups();
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
      if (!await showConfirm(`${esc(t('srv.confirmDeleteFolder', { name: groupName }))}<br><small style="color:var(--text-muted)">${esc(t('srv.folderNote'))}</small>`, { title: t('srv.deleteFolder'), confirmText: t('common.delete'), danger: true, html: true })) return;
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

      let posX = btnRect.right - 180;
      if (posX < 8) posX = 8;
      if (posX + 180 > window.innerWidth - 8) posX = window.innerWidth - 180 - 8;
      dropdown.style.left = posX + 'px';

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

  if (serversEditMode) {
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
            const addChildren = (pid) => serverGroups.filter(g => g.parent_id === pid).forEach(g => {
              if (!ids.has(g.id)) { ids.add(g.id); addChildren(g.id); }
            });
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
  }

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
        await reloadServersState();
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
      await reloadServersState();
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
    showRunPlaybookModal(() => { }, names);
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
      if (server) {
        showAddServerModal(async () => {
          await reloadServersState();
          await renderServers();
        }, server);
      }
    });
  });

  document.querySelectorAll('.btn-delete-server').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const { serverId, serverName } = btn.dataset;
      if (!await showConfirm(`${esc(t('srv.confirmDelete', { name: serverName }))}<br><small style="color:var(--text-muted)">${esc(t('srv.cantUndone'))}</small>`, { title: t('srv.delete'), confirmText: t('common.delete'), danger: true, html: true })) return;
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
    try { obj.tags = JSON.parse(obj.tags || '[]'); } catch { obj.tags = []; }
    try { obj.services = JSON.parse(obj.services || '[]'); } catch { obj.services = []; }
    try { obj.links = JSON.parse(obj.links || '[]'); } catch { obj.links = []; }
    try { obj.storage_mounts = JSON.parse(obj.storage_mounts || '[]'); } catch { obj.storage_mounts = []; }
    obj.ssh_port = parseInt(obj.ssh_port) || 22;
    return obj;
  }).filter(o => o.name && o.ip_address);
}

function renderPagination(current, total, totalItems) {
  if (total <= 1) return '';
  const from = (current - 1) * PAGE_SIZE + 1;
  const to = Math.min(current * PAGE_SIZE, totalItems);
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

const PRESET_COLORS = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];

function showGroupDialog({ title = '', confirmText = '', groups = [], defaultName = '', defaultColor = PRESET_COLORS[0], defaultParentId = null, editId = null } = {}) {
  return new Promise((resolve) => {
    let selectedColor = defaultColor || PRESET_COLORS[0];
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Build parent options excluding self and own descendants
    const getDescendantIds = (id) => {
      const ids = new Set([id]);
      const addChildren = (pid) => groups.filter(g => g.parent_id === pid).forEach(g => {
        if (!ids.has(g.id)) { ids.add(g.id); addChildren(g.id); }
      });
      addChildren(id);
      return ids;
    };
    const excludeIds = editId ? getDescendantIds(editId) : new Set();
    const parentOptions = groups.filter(g => !excludeIds.has(g.id));

    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header"><h3 class="modal-title" id="gd-title">${esc(title)}</h3></div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:16px;">
          <div>
            <label class="form-label">${t('common.name')}</label>
            <input class="form-input" id="gd-name" type="text" value="${esc(defaultName)}" placeholder="${t('srv.groupNamePlaceholder')}" style="width:100%;">
          </div>
          <div>
            <label class="form-label">${t('srv.groupColor')}</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              ${PRESET_COLORS.map(c => `
                <button class="color-swatch${c === selectedColor ? ' active' : ''}" data-color="${c}" style="background:${c};width:24px;height:24px;border-radius:50%;border:2px solid ${c === selectedColor ? 'var(--text-inverse)' : 'transparent'};outline:2px solid ${c === selectedColor ? c : 'transparent'};cursor:pointer;"></button>
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
    let releaseDialog = null;

    const setColor = (color) => {
      selectedColor = color;
      customColor.value = color;
      overlay.querySelectorAll('.color-swatch').forEach(s => {
        const active = s.dataset.color === color;
        s.style.border = `2px solid ${active ? 'var(--text-inverse)' : 'transparent'}`;
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

    const cleanup = (result) => {
      releaseDialog?.();
      releaseDialog = null;
      overlay.remove();
      resolve(result);
    };
    const submit = () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      cleanup({ name, color: selectedColor, parentId: overlay.querySelector('#gd-parent').value || null });
    };

    releaseDialog = activateDialog({
      dialog: overlay.querySelector('.modal'),
      initialFocus: nameInput,
      onClose: () => cleanup(null),
      labelledBy: 'gd-title',
    });
    window.requestAnimationFrame(() => nameInput.select());

    overlay.querySelector('#gd-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#gd-ok').addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
  });
}

function buildGroupTree(groups, parentId = null, visited = new Set()) {
  if (parentId !== null && visited.has(parentId)) return [];
  if (parentId !== null) visited.add(parentId);
  return groups
    .filter(g => (g.parent_id || null) === parentId)
    .map(g => ({ ...g, children: buildGroupTree(groups, g.id, new Set(visited)) }));
}

function renderGroupNode(node, depth, serversByGroup) {
  const members = serversByGroup[node.id] || [];
  const collapsed = collapsedGroups.has(node.id);
  const indent = depth * 20;
  const color = node.color || PRESET_COLORS[0];

  let html = `<tr class="group-row" data-group-id="${node.id}" ${serversEditMode ? 'draggable="true"' : ''}>
    <td colspan="10" style="border-left:3px solid ${color};">
      <div class="group-header-inner" style="padding-left:${11 + indent}px;">
        <i class="fas fa-chevron-${collapsed ? 'right' : 'down'}" style="font-size:11px;color:var(--text-muted);width:14px;flex-shrink:0;"></i>
        <i class="fas fa-folder${collapsed ? '' : '-open'}" style="color:${color};flex-shrink:0;"></i>
        <span class="group-name">${esc(node.name)}</span>
        <div class="group-header-actions">
          ${hasCap('canAddServers') ? `<button class="btn btn-icon create-subgroup-btn" data-parent-id="${node.id}" title="${t('srv.createSubfolder')}"><i class="fas fa-folder-plus"></i></button>` : ''}
          ${hasCap('canEditServers') ? `<button class="btn btn-icon rename-group-btn" data-group-id="${node.id}" title="${t('srv.editFolder')}"><i class="fas fa-pen"></i></button>` : ''}
          ${hasCap('canDeleteServers') ? `<button class="btn btn-icon btn-icon--danger delete-group-btn" data-group-id="${node.id}" data-group-name="${esc(node.name)}" title="${t('srv.deleteFolder')}"><i class="fas fa-trash"></i></button>` : ''}
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

function countDescendantServers(node, serversByGroup, visited = new Set()) {
  if (visited.has(node.id)) return 0;
  visited.add(node.id);
  let count = 0;
  for (const child of node.children || []) {
    count += (serversByGroup[child.id] || []).length + countDescendantServers(child, serversByGroup, visited);
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

  // Ungrouped (only show when there are servers without a folder)
  if (ungrouped.length > 0) {
    html += `<tr class="group-row ungrouped-group-row">
      <td colspan="10">
        <div class="group-header-inner">
          <i class="fas fa-server" style="color:var(--text-muted);font-size:12px;"></i>
          <span style="color:var(--text-muted);">${t('srv.moveToRoot')}</span>
          <span class="group-badge">${ungrouped.length}</span>
        </div>
      </td>
    </tr>`;
    html += ungrouped.map(s => renderRow(s)).join('');
  }

  // Build tree and render
  const tree = buildGroupTree(groups);
  for (const node of tree) {
    html += renderGroupNode(node, 0, serversByGroup);
  }
  return html;
}

function renderGroupedCards(servers, groups) {
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

  if (ungrouped.length > 0) {
    html += `
      <div class="servers-mobile-group servers-mobile-group--ungrouped">
        <div class="servers-mobile-group-header">
          <div class="servers-mobile-group-title-wrap">
            <i class="fas fa-server" style="color:var(--text-muted);font-size:12px;"></i>
            <span class="servers-mobile-group-title" style="color:var(--text-muted);">${t('srv.moveToRoot')}</span>
          </div>
          <span class="group-badge">${ungrouped.length}</span>
        </div>
        <div class="servers-mobile-group-body">
          ${ungrouped.map(s => renderServerCard(s)).join('')}
        </div>
      </div>
    `;
  }

  const tree = buildGroupTree(groups);
  for (const node of tree) {
    html += renderMobileGroupNode(node, 0, serversByGroup);
  }
  return html;
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
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

function formatLastSeen(server) {
  if (server.status === 'online') return t('common.online');
  if (!server.last_seen) return '—';
  return `Seen ${formatRelativeTime(server.last_seen)} ago`;
}

function renderRow(server, depth = 0, folderColor = null) {
  const dotCls = server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown';
  const lastSeen = formatLastSeen(server);
  const checked = selectedIds.has(server.id) ? 'checked' : '';
  const borderStyle = folderColor ? `border-left:3px solid ${folderColor};` : '';
  const nameIndent = folderColor ? 14 + (depth - 1) * 14 : 14;
  return `
    <tr class="server-row${selectedIds.has(server.id) ? ' is-selected' : ''}" data-server-id="${server.id}" draggable="true">
      <td class="checkbox-cell" style="padding-right:6px;${borderStyle}">
        <input type="checkbox" class="server-checkbox row-checkbox" data-server-id="${server.id}" ${checked}>
      </td>
      <td style="padding-left:6px;padding-right:0;"><span class="status-dot ${dotCls}"></span></td>
      <td style="padding-left:${nameIndent}px;">
        <div class="server-name-cell">
          <span class="server-name-primary">${esc(server.name)}</span>
        </div>
        ${(server.tags || []).map(tag => `<span class="server-tag">${esc(tag)}</span>`).join('')}
      </td>
      <td class="mono ${server.ip_address ? '' : 'empty-value'}" style="color:var(--text-muted);font-size:12px;">${esc(server.ip_address || '—')}</td>
      <td id="os-${server.id}" class="mono empty-value" style="color:var(--text-muted);">—</td>
      <td id="cpu-${server.id}">
        <div class="table-metric-row">
          <div class="progress-track table-progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="cpu-bar-${server.id}"></div></div>
          <span class="text-mono empty-value" id="cpu-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td id="ram-${server.id}">
        <div class="table-metric-row">
          <div class="progress-track table-progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="ram-bar-${server.id}"></div></div>
          <span class="text-mono empty-value" id="ram-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td id="disk-${server.id}">
        <div class="table-metric-row">
          <div class="progress-track table-progress-track" style="height:6px;"><div class="progress-fill" style="width:0%" id="disk-bar-${server.id}"></div></div>
          <span class="text-mono empty-value" id="disk-val-${server.id}" style="width:32px;text-align:right;">—</span>
        </div>
      </td>
      <td class="text-mono ${lastSeen === '—' ? 'empty-value' : ''}" style="color:var(--text-muted);font-size:11px;">${lastSeen}</td>
      <td class="row-actions" style="white-space:nowrap;">
        ${serverGroups.length > 0 && hasCap('canEditServers') ? `<button class="btn btn-icon btn-move-server" data-server-id="${server.id}" title="${t('srv.moveTo')}"><i class="fas fa-folder-tree"></i></button>` : ''}
        ${hasCap('canEditServers') ? `<button class="btn btn-icon btn-edit-server" data-server-id="${server.id}" title="${t('srv.edit')}">
          <i class="fas fa-edit"></i>
        </button>` : ''}
        ${hasCap('canDeleteServers') ? `<button class="btn btn-icon btn-icon--danger btn-delete-server" data-server-id="${server.id}" data-server-name="${esc(server.name)}" title="${t('srv.delete')}">
          <i class="fas fa-trash"></i>
        </button>` : ''}
      </td>
    </tr>
  `;
}

function renderMobileGroupNode(node, depth, serversByGroup) {
  const members = serversByGroup[node.id] || [];
  const collapsed = collapsedGroups.has(node.id);
  const indent = depth * 14;
  const color = node.color || PRESET_COLORS[0];
  const total = members.length + countDescendantServers(node, serversByGroup);

  let html = `
    <section class="servers-mobile-group">
      <button type="button" class="servers-mobile-group-header group-row" data-group-id="${node.id}" style="border-left:3px solid ${color};padding-left:${14 + indent}px;">
        <div class="servers-mobile-group-title-wrap">
          <i class="fas fa-chevron-${collapsed ? 'right' : 'down'}" style="font-size:11px;color:var(--text-muted);width:14px;flex-shrink:0;"></i>
          <i class="fas fa-folder${collapsed ? '' : '-open'}" style="color:${color};flex-shrink:0;"></i>
          <span class="servers-mobile-group-title">${esc(node.name)}</span>
        </div>
        <span class="group-badge">${total}</span>
      </button>
  `;

  if (!collapsed) {
    if (members.length === 0 && node.children.length === 0) {
      html += `<div class="servers-mobile-empty-group"><i class="fas fa-info-circle"></i> ${t('srv.emptyGroup')}</div>`;
    } else {
      html += `<div class="servers-mobile-group-body">${members.map(s => renderServerCard(s, depth + 1, color)).join('')}</div>`;
    }

    for (const child of node.children) {
      html += renderMobileGroupNode(child, depth + 1, serversByGroup);
    }
  }

  html += '</section>';
  return html;
}

function renderMetric(label, idPrefix, serverId) {
  return `
    <div class="server-card-metric" id="${idPrefix}-${serverId}">
      <div class="server-card-metric-head">
        <span>${label}</span>
        <span class="text-mono empty-value" id="${idPrefix}-val-${serverId}">—</span>
      </div>
      <div class="progress-track server-card-progress"><div class="progress-fill" style="width:0%" id="${idPrefix}-bar-${serverId}"></div></div>
    </div>
  `;
}

function renderServerCard(server, depth = 0, folderColor = null) {
  const dotCls = server.status === 'online' ? 'online' : server.status === 'offline' ? 'offline' : 'unknown';
  const statusLabel = server.status === 'online' ? t('common.online') : server.status === 'offline' ? t('common.offline') : t('common.unknown');
  const lastSeen = formatLastSeen(server);
  const checked = selectedIds.has(server.id) ? 'checked' : '';
  const indent = depth > 0 ? `style="margin-left:${depth * 12}px;${folderColor ? `border-left:3px solid ${folderColor};` : ''}"` : (folderColor ? `style="border-left:3px solid ${folderColor};"` : '');

  return `
    <article class="server-card server-row${selectedIds.has(server.id) ? ' is-selected' : ''}" data-server-id="${server.id}" ${indent}>
      <div class="server-card-header">
        <label class="server-card-checkbox checkbox-cell">
          <input type="checkbox" class="server-checkbox row-checkbox" data-server-id="${server.id}" ${checked}>
        </label>
        <div class="server-card-title-wrap">
          <div class="server-card-title-line">
            <span class="status-dot ${dotCls}"></span>
            <span class="server-card-title">${esc(server.name)}</span>
            <span class="badge badge-${dotCls}">${statusLabel}</span>
          </div>
          ${(server.tags || []).length ? `<div class="server-tags-inline">${(server.tags || []).map(tag => `<span class="server-tag">${esc(tag)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="row-actions server-card-actions">
          ${serverGroups.length > 0 && hasCap('canEditServers') ? `<button class="btn btn-icon btn-move-server" data-server-id="${server.id}" title="${t('srv.moveTo')}"><i class="fas fa-folder-tree"></i></button>` : ''}
          ${hasCap('canEditServers') ? `<button class="btn btn-icon btn-edit-server" data-server-id="${server.id}" title="${t('srv.edit')}"><i class="fas fa-edit"></i></button>` : ''}
          ${hasCap('canDeleteServers') ? `<button class="btn btn-icon btn-icon--danger btn-delete-server" data-server-id="${server.id}" data-server-name="${esc(server.name)}" title="${t('srv.delete')}"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </div>

      <div class="server-card-meta">
        <div class="server-card-meta-item">
          <span class="server-card-meta-label">${t('srv.colIp')}</span>
          <span class="mono ${server.ip_address ? '' : 'empty-value'}">${esc(server.ip_address || '—')}</span>
        </div>
        <div class="server-card-meta-item">
          <span class="server-card-meta-label">${t('srv.colOs')}</span>
          <span id="os-${server.id}" class="mono empty-value">—</span>
        </div>
        <div class="server-card-meta-item">
          <span class="server-card-meta-label">${t('srv.colLastSeen')}</span>
          <span class="mono ${lastSeen === '—' ? 'empty-value' : ''}">${lastSeen}</span>
        </div>
      </div>

      <div class="server-card-metrics">
        ${renderMetric(t('srv.colCpu'), 'cpu', server.id)}
        ${renderMetric(t('srv.colRam'), 'ram', server.id)}
        ${renderMetric(t('srv.colDisk'), 'disk', server.id)}
      </div>
    </article>
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
    if (osEl) {
      const os = (info.os || '').split(' ')[0] || '—';
      osEl.textContent = os;
      osEl.classList.toggle('empty-value', os === '—');
    }
    if (info.cpu_usage_pct != null) {
      const pct = info.cpu_usage_pct;
      updateBar(`cpu-bar-${serverId}`, pct);
      const el = document.getElementById(`cpu-val-${serverId}`);
      if (el) {
        el.textContent = pct + '%';
        el.classList.remove('empty-value');
      }
    }
    if (info.ram_total_mb) {
      const pct = Math.round((info.ram_used_mb / info.ram_total_mb) * 100);
      updateBar(`ram-bar-${serverId}`, pct);
      const el = document.getElementById(`ram-val-${serverId}`);
      if (el) {
        el.textContent = pct + '%';
        el.classList.remove('empty-value');
      }
    }
    if (info.disk_total_gb) {
      const pct = Math.round((info.disk_used_gb / info.disk_total_gb) * 100);
      updateBar(`disk-bar-${serverId}`, pct);
      const el = document.getElementById(`disk-val-${serverId}`);
      if (el) {
        el.textContent = pct + '%';
        el.classList.remove('empty-value');
      }
    }
  } catch { }
}

function updateBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const visiblePct = pct > 0 ? Math.max(pct, 4) : 0;
  el.style.width = visiblePct + '%';
  el.className = 'progress-fill' + (pct > 90 ? ' critical' : pct > 70 ? ' high' : '');
}

function formatRelativeTime(dateStr) {
  // SQLite datetime('now') is UTC but has no 'Z' suffix — add it explicitly
  const utc = dateStr && !dateStr.endsWith('Z') ? dateStr.replace(' ', 'T') + 'Z' : dateStr;
  const diff = Math.floor((Date.now() - new Date(utc)) / 1000);
  if (diff < 60) return t('dash.justNow');
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}
