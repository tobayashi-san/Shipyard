import { api } from '../api.js';
import { state, hasCap } from '../app/state.js';
import { navigate } from '../app/router.js';
import { showToast, showConfirm } from '../components/toast.js';
import { t } from '../i18n.js';
import { formatDateTimeShort, esc } from '../utils/format.js';
import { buildAllExceptTargets, parsePlaybookTargets, describePlaybookTargets } from '../utils/playbook-targets.js';
import { onWsMessage } from '../websocket.js';
import { activateDialog } from '../utils/dialog.js';
import { EditorView, basicSetup } from 'codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

// ── CodeMirror ────────────────────────────────────────────────
let cmEditor = null;
let mobileTemplateView = 'list';

const cmTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, "JetBrains Mono", "Fira Code", monospace)',
    background: 'var(--bg-panel-alt)',
    color: 'var(--text-primary)',
    borderRadius: '0 0 var(--radius) var(--radius)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', minHeight: '380px' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': {
    background: 'var(--bg-panel)',
    borderRight: '1px solid var(--border)',
    color: 'var(--text-muted)',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': { background: 'var(--bg-row-hover)' },
  '.cm-activeLine': { background: 'rgba(128,128,128,0.06)' },
  '.cm-selectionBackground': { background: 'rgba(99,102,241,0.25) !important' },
  '&.cm-focused .cm-selectionBackground': { background: 'rgba(99,102,241,0.40) !important' },
  '&.cm-focused .cm-activeLine .cm-selectionBackground': { background: 'rgba(99,102,241,0.45) !important' },
  '.cm-matchingBracket': { background: 'var(--accent-light)', color: 'var(--accent) !important', fontWeight: 'bold' },
  '.cm-foldPlaceholder': { background: 'var(--accent-light)', border: 'none', color: 'var(--accent)' },
});

function initEditor() {
  const container = document.getElementById('cm-editor-container');
  if (!container) return;
  if (cmEditor) { cmEditor.destroy(); cmEditor = null; }
  cmEditor = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [basicSetup, yaml(), syntaxHighlighting(classHighlighter), cmTheme],
    }),
    parent: container,
  });
}

function ensureEditor() {
  const container = document.getElementById('cm-editor-container');
  if (!container) return false;
  if (cmEditor && container.contains(cmEditor.dom)) return true;
  initEditor();
  return !!cmEditor;
}

function getEditorContent() {
  return cmEditor ? cmEditor.state.doc.toString() : '';
}

function setEditorContent(content) {
  if (!cmEditor) return;
  cmEditor.dispatch({ changes: { from: 0, to: cmEditor.state.doc.length, insert: content } });
  cmEditor.scrollDOM.scrollTop = 0;
}

// ── Tab state ─────────────────────────────────────────────────
let activeTab = 'templates';

const STORAGE_KEY_COLLAPSED_PLAYBOOK_CATEGORIES = 'shipyard.ui.playbooks.collapsedCategories';
let collapsedCategories = loadCollapsedPlaybookCategories();

function loadCollapsedPlaybookCategories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSED_PLAYBOOK_CATEGORIES);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(v => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveCollapsedPlaybookCategories() {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSED_PLAYBOOK_CATEGORIES, JSON.stringify([...collapsedCategories]));
  } catch {
    // ignore storage quota / privacy mode
  }
}

function isMobilePlaybooksLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function currentTemplateMobileView() {
  return isMobilePlaybooksLayout() ? mobileTemplateView : 'split';
}

function allowedTabs() {
  const tabs = ['templates'];
  if (hasCap('canRunPlaybooks')) tabs.push('run');
  if (hasCap('canViewVars')) tabs.push('vars');
  if (hasCap('canViewSchedules')) tabs.push('schedules');
  if (hasCap('canViewAudit')) tabs.push('history');
  return tabs;
}

// ============================================================
// Page Entry
// ============================================================
export async function renderPlaybooks() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  // Reset activeTab if user no longer has access to it
  if (!allowedTabs().includes(activeTab)) activeTab = allowedTabs()[0];

  main.innerHTML = `
    <div class="playbooks-shell">
      <div class="page-header">
        <div>
          <h2>${t('pb.title')}</h2>
          <p>${t('pb.subtitle')}</p>
        </div>
        <div id="pb-git-widget" class="pb-git-widget">
          <div class="pb-git-branch-pill">
            <i class="fab fa-git-alt"></i>
            <span id="pb-git-branch">–</span>
          </div>
          <button id="pb-git-pull-btn" class="btn btn-secondary btn-sm" title="Pull from remote">
            <i class="fas fa-arrow-down"></i>
          </button>
          <button id="pb-git-push-btn" class="btn btn-secondary btn-sm" title="Push to remote">
            <i class="fas fa-arrow-up"></i>
          </button>
          <button id="pb-git-settings-link" class="btn btn-secondary btn-sm" title="Git Settings">
            <i class="fas fa-gear"></i>
          </button>
        </div>
      </div>

      <div class="pb-tab-shell">
        <div class="tab-bar" id="pb-tab-bar">
      <button class="tab-btn${activeTab === 'templates' ? ' active' : ''}" data-tab="templates">
        <i class="fas fa-file-code"></i> ${t('pb.tabTemplates')}
      </button>
      ${hasCap('canRunPlaybooks') ? `<button class="tab-btn${activeTab === 'run' ? ' active' : ''}" data-tab="run">
        <i class="fas fa-play"></i> ${t('pb.tabRun')}
      </button>` : ''}
      ${hasCap('canViewVars') ? `<button class="tab-btn${activeTab === 'vars' ? ' active' : ''}" data-tab="vars">
        <i class="fas fa-sliders-h"></i> ${t('pb.tabVars')}
      </button>` : ''}
      ${hasCap('canViewSchedules') ? `<button class="tab-btn${activeTab === 'schedules' ? ' active' : ''}" data-tab="schedules">
        <i class="fas fa-clock"></i> ${t('pb.tabSchedules')}
      </button>` : ''}
      ${hasCap('canViewAudit') ? `<button class="tab-btn${activeTab === 'history' ? ' active' : ''}" data-tab="history">
        <i class="fas fa-history"></i> ${t('pb.tabHistory')}
      </button>` : ''}
        </div>

        <div id="pb-tab-content" class="page-content">
          ${renderTabContent(activeTab)}
        </div>
      </div>
    </div>
  `;

  document.getElementById('pb-tab-bar').addEventListener('click', async (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    activeTab = tab;
    document.querySelectorAll('#pb-tab-bar .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const content = document.getElementById('pb-tab-content');
    content.innerHTML = renderTabContent(tab);
    await initTab(tab);
  });

  await initTab(activeTab);
  initGitWidget();
}

async function initGitWidget() {
  try {
    const cfg = await api.request('/playbooks-git/config');
    const branch = document.getElementById('pb-git-branch');
    if (branch) branch.textContent = cfg.repoUrl ? (cfg.branch || 'main') : 'not configured';
  } catch { }

  document.getElementById('pb-git-pull-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.request('/playbooks-git/pull', { method: 'POST' });
      showToast(t('git.pulled'), 'success');
      // Reload the current tab so new/changed playbooks appear immediately
      const content = document.getElementById('pb-tab-content');
      if (content) {
        content.innerHTML = renderTabContent(activeTab);
        await initTab(activeTab);
      }
    } catch (e) { showToast(t('git.pullFailed', { msg: e.message }), 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('pb-git-push-btn')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.request('/playbooks-git/push', { method: 'POST' });
      showToast(t('git.pushed'), 'success');
    } catch (e) { showToast(t('git.pushFailed', { msg: e.message }), 'error'); }
    finally { document.getElementById('pb-git-push-btn') && (document.getElementById('pb-git-push-btn').disabled = false); }
  });

  document.getElementById('pb-git-settings-link')?.addEventListener('click', () => {
    navigate('settings');
  });
}

function renderTabContent(tab) {
  switch (tab) {
    case 'templates': return renderTemplatesHTML();
    case 'run': return renderQuickRunHTML();
    case 'vars': return renderVarsHTML();
    case 'schedules': return renderSchedulesHTML();
    case 'history': return renderHistoryHTML();
    default: return '';
  }
}

async function initTab(tab) {
  switch (tab) {
    case 'templates':
      if (isMobilePlaybooksLayout() && activeTemplatePanel === 'none') mobileTemplateView = 'list';
      await loadPlaybookList();
      setupPlaybookEvents();
      break;
    case 'run': await loadQuickRunPlaybooks(); setupQuickRunEvents(); break;
    case 'vars': await loadVarsList(); setupVarsEvents(); break;
    case 'schedules': await loadScheduleList(); setupScheduleEvents(); break;
    case 'history': await loadHistoryList(); break;
  }
}

// ============================================================
// Tab: Templates
// ============================================================
let currentFilename = null;
let activeTemplatePanel = 'none';

function renderTemplatesHTML() {
  const mobileLayout = isMobilePlaybooksLayout();
  const templateMobileView = currentTemplateMobileView();
  return `
    <div class="page-content-grid playbooks-layout ${mobileLayout ? `playbooks-mobile-view-${templateMobileView}` : ''}">
      <div class="panel playbook-list-panel" id="playbook-list-panel" style="padding:0;overflow:hidden;">
        <div class="pb-panel-toolbar">
          <span class="pb-panel-title">Playbooks</span>
          ${hasCap('canEditPlaybooks') ? `<button class="btn btn-secondary btn-sm" id="btn-new-playbook" title="${t('pb.new')}" style="padding:3px 8px;">
            <i class="fas fa-plus"></i>
          </button>` : ''}
        </div>
        <div class="pb-search-wrap">
          <i class="fas fa-search pb-search-icon"></i>
          <input class="pb-search-input" id="pb-search" type="text" placeholder="Search…" autocomplete="off">
        </div>
        <div id="playbook-list">
          <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
        </div>
      </div>

      <div id="playbook-editor-panel" class="playbooks-workspace hidden">
        <div class="panel dash-panel">
          <div class="dash-panel-header playbooks-workspace-header" id="editor-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-edit"></i></div>
              <span class="dash-panel-title" id="editor-title">${t('pb.editTitle')}</span>
            </div>
            <div class="dash-panel-header-right playbooks-workspace-actions">
              ${mobileLayout ? `<button class="btn btn-secondary btn-sm" id="btn-template-back"><i class="fas fa-arrow-left"></i> ${t('common.back')}</button>` : ''}
              ${hasCap('canDeletePlaybooks') ? `<button class="btn btn-danger btn-sm hidden" id="btn-delete-playbook"><i class="fas fa-trash"></i></button>` : ''}
              <button class="btn btn-secondary btn-sm hidden" id="btn-playbook-history" title="${t('pb.history')}">
                <i class="fas fa-history"></i> ${t('pb.history')}
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-cancel-edit">${t('common.cancel')}</button>
              ${hasCap('canEditPlaybooks') ? `<button class="btn btn-primary btn-sm" id="btn-save-playbook">
                <i class="fas fa-save"></i> ${t('common.save')}
              </button>` : ''}
            </div>
          </div>
          <div class="form-body">
            <div class="form-group" id="filename-group">
              <label class="form-label">${t('pb.filename')}</label>
              <input class="form-input text-mono" type="text" id="playbook-filename" placeholder="${t('pb.filenamePlaceholder')}">
            </div>
            <div class="form-group">
              <label class="form-label">${t('pb.yaml')}</label>
              <div id="cm-editor-container" class="cm-editor-wrap"></div>
            </div>
          </div>
        </div>
      </div>

      <div id="playbook-run-panel" class="playbooks-workspace hidden">
        <div class="panel dash-panel">
          <div class="dash-panel-header playbooks-workspace-header">
            <div class="dash-panel-header-left">
              <div class="dash-panel-icon"><i class="fas fa-play"></i></div>
              <span class="dash-panel-title" id="run-playbook-name">${t('common.run')}</span>
            </div>
            <div class="dash-panel-header-right playbooks-workspace-actions">
              ${mobileLayout ? `<button class="btn btn-secondary btn-sm" id="btn-template-back-run"><i class="fas fa-arrow-left"></i> ${t('common.back')}</button>` : ''}
              <button class="btn btn-secondary btn-sm" id="btn-cancel-run">${t('common.close')}</button>
            </div>
          </div>
          <div class="form-body">
            <div class="form-group">
              <label class="form-label">${t('pb.target')}</label>
              <select class="form-input" id="run-target">
                <option value="">${t('run.selectTarget')}</option>
                <option value="all">${t('pb.allServers')}</option>
                ${state.servers.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}
                <option value="localhost">localhost</option>
              </select>
            </div>
            <div class="form-group" id="run-exclude-group">
              <label class="form-label">${t('run.excludeServers')}</label>
              <div class="form-hint">${t('run.excludeHint')}</div>
              <div style="border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-panel-alt);max-height:180px;overflow-y:auto;">
                ${state.servers.map(s => `
                  <label style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);cursor:pointer;">
                    <input type="checkbox" class="run-exclude-cb" value="${esc(s.name)}" style="accent-color:var(--accent);">
                    <span style="flex:1;">${esc(s.name)}</span>
                    <span class="badge badge-${s.status === 'online' ? 'online' : 'offline'}" style="font-size:10px;">${s.status === 'online' ? t('common.online') : t('common.offline')}</span>
                  </label>
                `).join('')}
              </div>
            </div>
            <div style="padding-top:4px;">
              <button class="btn btn-primary" id="btn-run-confirm">
                <i class="fas fa-play"></i> ${t('common.run')}
              </button>
            </div>
          </div>
          <div id="run-output" class="hidden" style="border-top:1px solid var(--border);">
            <div class="terminal" style="border:none;border-radius:0;">
              <div class="terminal-header">
                <div class="terminal-title" id="run-terminal-title">${t('pb.output')}</div>
              </div>
              <div class="terminal-body" id="run-terminal-body"></div>
            </div>
          </div>
        </div>
      </div>

      <div id="playbook-welcome" class="playbooks-workspace">
        <div class="panel">
          <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-terminal"></i></div>
            <h3>${t('pb.noPlaybooks')}</h3>
            <p>${t('pb.selectHint')}</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function loadPlaybookList() {
  const listEl = document.getElementById('playbook-list');
  if (!listEl) return;
  let allPlaybooks = [];
  try {
    allPlaybooks = await api.getPlaybooks();
    if (!allPlaybooks || allPlaybooks.length === 0) {
      listEl.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('pb.noPlaybooks')}.</p></div>`;
      return;
    }
  } catch (e) {
    listEl.innerHTML = `<p style="padding:12px;color:var(--offline);">${t('pb.loadError', { msg: esc(e.message) })}</p>`;
    return;
  }

  function renderList(query) {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? allPlaybooks.filter(p =>
        p.description.toLowerCase().includes(q) ||
        p.filename.toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q))
      : allPlaybooks;

    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('pb.noResults')}</p></div>`;
      return;
    }

    const user = filtered.filter(p => !p.isInternal);
    const internal = filtered.filter(p => !!p.isInternal);

    // Group user playbooks by category
    const categoryMap = {};
    user.forEach(p => {
      const cat = p.category || 'Custom';
      if (!categoryMap[cat]) categoryMap[cat] = [];
      categoryMap[cat].push(p);
    });

    let html = '';
    if (user.length === 0 && internal.length === 0) {
      html = `<div class="empty-state empty-state-sm"><p>${t('pb.noPlaybooks')}.</p></div>`;
    } else {
      Object.keys(categoryMap).sort().forEach(cat => {
        html += renderPlaybookGroup(cat, categoryMap[cat], false);
      });
      if (internal.length > 0) {
        html += renderPlaybookGroup(t('pb.internal'), internal, true);
      }
    }
    listEl.innerHTML = html;
    wirePlaybookItems();
  }

  renderList('');
  await restoreTemplateState(allPlaybooks);

  const searchEl = document.getElementById('pb-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => renderList(searchEl.value));
  }
}

function markSelectedPlaybook() {
  document.querySelectorAll('.playbook-item').forEach(item => {
    item.classList.toggle('active', item.dataset.filename === currentFilename);
  });
}

async function restoreTemplateState(allPlaybooks) {
  if (!currentFilename) {
    showTemplatePanel('none');
    return;
  }

  const selected = allPlaybooks.find(playbook => playbook.filename === currentFilename);
  if (!selected) {
    currentFilename = null;
    showTemplatePanel('none');
    return;
  }

  if (activeTemplatePanel === 'editor') {
    await selectPlaybook(selected.filename, !!selected.isInternal);
    return;
  }

  if (activeTemplatePanel === 'run') {
    openRunPanel(selected.filename, selected.description);
    markSelectedPlaybook();
    return;
  }

  markSelectedPlaybook();
}

function wirePlaybookItems() {
  const listEl = document.getElementById('playbook-list');
  if (!listEl) return;
  listEl.querySelectorAll('.pb-category-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      const key = header.dataset.categoryKey;
      if (!key) return;
      if (header.classList.contains('collapsed')) collapsedCategories.add(key);
      else collapsedCategories.delete(key);
      saveCollapsedPlaybookCategories();
    });
  });
  listEl.querySelectorAll('.playbook-item').forEach(item => {
    if (!hasCap('canEditPlaybooks') && !hasCap('canDeletePlaybooks')) return;
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => selectPlaybook(item.dataset.filename, item.dataset.internal === 'true'));
  });
  listEl.querySelectorAll('.btn-run-playbook').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRunPanel(btn.dataset.filename, btn.dataset.description);
    });
  });
}

function renderPlaybookGroup(label, playbooks, isInternal) {
  const key = `${isInternal ? 'internal' : 'user'}:${label}`;
  const collapsed = collapsedCategories.has(key);
  return `
    <div class="pb-category">
      <div class="pb-category-header ${collapsed ? 'collapsed' : ''}" data-category-key="${esc(key)}">
        <i class="fas fa-chevron-down pb-chevron"></i>
        <i class="fas ${isInternal ? 'fa-folder-gear' : 'fa-folder'} pb-folder-icon"></i>
        <span>${esc(label)}</span>
        <span class="pb-category-count">${playbooks.length}</span>
      </div>
      <div class="pb-items">
        ${playbooks.map(p => `
          <div class="playbook-item" data-filename="${esc(p.filename)}" data-internal="${isInternal}">
            <i class="fas fa-file-code pb-file-icon"></i>
            <span class="playbook-item-name" title="${esc(p.filename)}">${esc(p.description)}</span>
            ${hasCap('canRunPlaybooks') && !isInternal ? `<button class="btn btn-secondary btn-sm btn-run-playbook pb-run-btn" data-filename="${esc(p.filename)}"
              data-description="${esc(p.description)}" title="${t('common.run')}">
              <i class="fas fa-play"></i>
            </button>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function selectPlaybook(filename, isInternal) {
  currentFilename = filename;
  mobileTemplateView = 'editor';
  showTemplatePanel('editor');
  document.getElementById('editor-title').textContent = filename;
  document.getElementById('filename-group').classList.toggle('hidden', isInternal);
  document.getElementById('btn-delete-playbook')?.classList.toggle('hidden', isInternal);
  document.getElementById('btn-playbook-history')?.classList.toggle('hidden', isInternal);
  const nameInput = document.getElementById('playbook-filename');
  if (nameInput) nameInput.value = filename.replace(/\.ya?ml$/, '');
  setEditorContent(t('pb.editorLoading'));
  try {
    const data = await api.getPlaybook(filename);
    setEditorContent(data.content);
  } catch (e) {
    setEditorContent(t('pb.editorLoadError', { msg: e.message }));
  }
  markSelectedPlaybook();
}

function openRunPanel(filename, description) {
  currentFilename = filename;
  activeTemplatePanel = 'run';
  mobileTemplateView = 'run';
  showTemplatePanel('run');
  document.getElementById('run-playbook-name').textContent = description || filename;
  document.getElementById('run-output').classList.add('hidden');
  document.getElementById('run-terminal-body').innerHTML = '';
  const targetSel = document.getElementById('run-target');
  if (targetSel) targetSel.value = '';
  const excludeGroup = document.getElementById('run-exclude-group');
  const syncExcludeVisibility = () => {
    if (!targetSel || !excludeGroup) return;
    const show = targetSel.value === 'all';
    excludeGroup.classList.toggle('hidden', !show);
    if (!show) {
      document.querySelectorAll('.run-exclude-cb').forEach(cb => { cb.checked = false; });
    }
  };
  if (targetSel) targetSel.onchange = syncExcludeVisibility;
  syncExcludeVisibility();
}

function showTemplatePanel(which) {
  activeTemplatePanel = which;
  if (which === 'none') mobileTemplateView = 'list';
  document.getElementById('playbook-editor-panel').classList.toggle('hidden', which !== 'editor');
  document.getElementById('playbook-run-panel').classList.toggle('hidden', which !== 'run');
  document.getElementById('playbook-welcome').classList.toggle('hidden', which !== 'none');
  const layout = document.querySelector('.playbooks-layout');
  if (layout) {
    layout.classList.remove('playbooks-mobile-view-list', 'playbooks-mobile-view-editor', 'playbooks-mobile-view-run');
    if (isMobilePlaybooksLayout()) layout.classList.add(`playbooks-mobile-view-${mobileTemplateView}`);
  }
  if (which === 'editor') ensureEditor();
}

function setupPlaybookEvents() {
  document.getElementById('btn-new-playbook')?.addEventListener('click', () => {
    currentFilename = null;
    mobileTemplateView = 'editor';
    showTemplatePanel('editor');
    document.getElementById('editor-title').textContent = t('pb.new');
    document.getElementById('filename-group').classList.remove('hidden');
    document.getElementById('btn-delete-playbook').classList.add('hidden');
    document.getElementById('btn-playbook-history')?.classList.add('hidden');
    document.getElementById('playbook-filename').value = '';
    setEditorContent(`---\n- name: My New Playbook\n  hosts: all\n  become: yes\n  tasks:\n    - name: Ping all hosts\n      ping:\n`);
    markSelectedPlaybook();
  });

  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    showTemplatePanel('none');
    currentFilename = null;
    markSelectedPlaybook();
  });

  document.getElementById('btn-template-back')?.addEventListener('click', () => {
    showTemplatePanel('none');
    currentFilename = null;
    markSelectedPlaybook();
  });

  document.getElementById('btn-cancel-run')?.addEventListener('click', () => {
    showTemplatePanel('none');
    currentFilename = null;
    markSelectedPlaybook();
  });

  document.getElementById('btn-template-back-run')?.addEventListener('click', () => {
    showTemplatePanel('none');
    currentFilename = null;
    markSelectedPlaybook();
  });

  document.getElementById('btn-playbook-history')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    try {
      const versions = await api.getPlaybookHistory(currentFilename);
      showHistoryModal(currentFilename, versions, (content) => setEditorContent(content));
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    }
  });

  document.getElementById('btn-save-playbook')?.addEventListener('click', async () => {
    const filenameInput = document.getElementById('playbook-filename');
    const content = getEditorContent().trim();
    const filename = currentFilename || (filenameInput.value.trim() + '.yml');
    if (!filename) { showToast(t('pb.needFilename'), 'error'); return; }
    if (!content) { showToast(t('pb.needContent'), 'error'); return; }

    const btn = document.getElementById('btn-save-playbook');
    btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.save')}…`;
    try {
      const result = await api.savePlaybook(filename, content);
      showToast(t('pb.saved', { name: result.filename }), 'success');
      currentFilename = result.filename;
      activeTemplatePanel = 'editor';
      await loadPlaybookList();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-save"></i> ${t('common.save')}`;
    }
  });

  document.getElementById('btn-delete-playbook')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    if (!await showConfirm(`${esc(t('pb.confirmDelete', { name: currentFilename }))}<br><small style="color:var(--text-muted)">${esc(t('pb.confirmDeleteHint'))}</small>`, { title: t('common.delete'), confirmText: t('common.delete'), danger: true, html: true })) return;
    try {
      await api.deletePlaybook(currentFilename);
      showToast(t('pb.deleted', { name: currentFilename }), 'success');
      showTemplatePanel('none');
      currentFilename = null;
      await loadPlaybookList();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    }
  });

  document.getElementById('btn-run-confirm')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    const baseTarget = document.getElementById('run-target').value.trim();
    if (!baseTarget) {
      showToast(t('run.needTarget'), 'warning');
      return;
    }
    if (baseTarget === 'all') {
      const confirmed = await showConfirm(t('run.confirmAllServersMessage'), {
        title: t('run.confirmAllServersTitle'),
        confirmText: t('common.run'),
        danger: true,
      });
      if (!confirmed) return;
    }
    const target = baseTarget === 'all'
      ? buildAllExceptTargets([...document.querySelectorAll('.run-exclude-cb:checked')].map(cb => cb.value))
      : baseTarget;
    const btn = document.getElementById('btn-run-confirm');
    btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span> ${t('run.starting')}`;

    const outputEl = document.getElementById('run-output');
    const bodyEl = document.getElementById('run-terminal-body');
    outputEl.classList.remove('hidden');
    bodyEl.innerHTML = '';
    document.getElementById('run-terminal-title').textContent = `ansible-playbook ${currentFilename} → ${describePlaybookTargets(target, t)}`;

    const addLine = (text, cls = 'line-stdout') => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      bodyEl.appendChild(span);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    };

    try {
      await api.runPlaybook(currentFilename, target, {});
      addLine(t('pb.started'), 'line-success');
    } catch (e) {
      addLine(t('common.errorPrefix', { msg: e.message }), 'line-stderr');
    } finally {
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-play"></i> ${t('common.run')}`;
    }
  });
}

// ============================================================
// Tab: Quick Run
// ============================================================
function renderQuickRunHTML() {
  return `
    <div class="playbooks-run-grid">
      <!-- Left: form -->
      <div class="panel dash-panel">
        <div class="dash-panel-header">
          <div class="dash-panel-header-left">
            <div class="dash-panel-icon"><i class="fas fa-play"></i></div>
            <span class="dash-panel-title">${t('qr.title')}</span>
          </div>
        </div>
        <div class="form-body">
          <div class="form-group">
            <label class="form-label">Playbook</label>
            <select class="form-input" id="qr-playbook">
              <option value="">${t('qr.selectPlaybook')}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('qr.targets')}</label>
            <div class="form-hint" id="qr-target-hint">${t('run.includeHint')}</div>
            <div id="qr-server-list" style="
              border:1px solid var(--border);border-radius:var(--radius);
              background:var(--bg-panel-alt);max-height:220px;overflow-y:auto;
            ">
              <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;">
                <input type="checkbox" id="qr-all" value="all" style="accent-color:var(--accent);">
                <span style="font-weight:500;">${t('pb.allServers')}</span>
              </label>
              ${state.servers.map(s => `
                <label style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border);cursor:pointer;" class="qr-server-row">
                  <input type="checkbox" class="qr-server-cb" value="${esc(s.name)}" style="accent-color:var(--accent);">
                  <span style="flex:1;">${esc(s.name)}</span>
                  <span class="badge badge-${s.status === 'online' ? 'online' : 'offline'}" style="font-size:10px;">${s.status === 'online' ? t('common.online') : t('common.offline')}</span>
                </label>
              `).join('')}
              <label style="display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;" class="qr-server-row">
                <input type="checkbox" class="qr-server-cb" value="localhost" style="accent-color:var(--accent);">
                <span>localhost</span>
              </label>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">${t('qr.extraVars')} <span style="color:var(--text-muted);font-weight:400;">(optional)</span></label>
            <input class="form-input text-mono" type="text" id="qr-extra-vars" placeholder='{"key": "value"}'>
          </div>
          <button class="btn btn-primary" id="btn-qr-run" style="width:100%;">
            <i class="fas fa-play"></i> ${t('qr.run')}
          </button>
        </div>
      </div>

      <!-- Right: output terminal -->
      <div class="panel dash-panel" id="qr-output-panel">
        <div class="dash-panel-header">
          <div class="dash-panel-header-left">
            <div class="dash-panel-icon"><i class="fas fa-terminal"></i></div>
            <span class="dash-panel-title" id="qr-terminal-title">${t('pb.output')}</span>
          </div>
        </div>
        <div id="qr-output-empty" style="padding:40px 24px;text-align:center;color:var(--text-muted);">
          <i class="fas fa-play-circle" style="font-size:32px;margin-bottom:12px;opacity:.3;display:block;"></i>
          ${t('pb.quickRunPlaceholder')}
        </div>
        <div class="terminal-body" id="qr-terminal-body" style="display:none;min-height:300px;border-top:1px solid var(--border);"></div>
      </div>
    </div>
  `;
}

async function loadQuickRunPlaybooks() {
  const sel = document.getElementById('qr-playbook');
  if (!sel) return;
  try {
    const playbooks = await api.getPlaybooks();
    const user = playbooks.filter(p => !p.isInternal);
    let opts = `<option value="">${t('qr.selectPlaybook')}</option>`;
    if (user.length) {
      opts += user.map(p => `<option value="${esc(p.filename)}">${esc(p.description)}</option>`).join('');
    }
    sel.innerHTML = opts;
  } catch { }
}

let _qrWsCleanup = null;

function setupQuickRunEvents() {
  const allCb = document.getElementById('qr-all');
  const hintEl = document.getElementById('qr-target-hint');

  function syncQuickRunTargetMode() {
    const excludeMode = !!allCb?.checked;
    const localhostCb = document.querySelector('.qr-server-cb[value="localhost"]');
    if (hintEl) {
      hintEl.textContent = excludeMode ? t('run.excludeHint') : t('run.includeHint');
    }
    if (localhostCb) {
      localhostCb.disabled = excludeMode;
      if (excludeMode) localhostCb.checked = false;
      const row = localhostCb.closest('.qr-server-row');
      if (row) row.style.opacity = excludeMode ? '0.55' : '1';
    }
  }

  allCb?.addEventListener('change', () => {
    document.querySelectorAll('.qr-server-cb').forEach(cb => { cb.checked = false; });
    syncQuickRunTargetMode();
  });
  syncQuickRunTargetMode();

  document.getElementById('btn-qr-run')?.addEventListener('click', async () => {
    const playbook = document.getElementById('qr-playbook').value;
    if (!playbook) { showToast(t('qr.selectPlaybook'), 'warning'); return; }

    const allChecked = document.getElementById('qr-all')?.checked;
    let targets;
    if (allChecked) {
      const confirmed = await showConfirm(t('run.confirmAllServersMessage'), {
        title: t('run.confirmAllServersTitle'),
        confirmText: t('common.run'),
        danger: true,
      });
      if (!confirmed) return;
      const excluded = [...document.querySelectorAll('.qr-server-cb:checked')]
        .map(c => c.value)
        .filter(v => v !== 'localhost');
      targets = buildAllExceptTargets(excluded);
    } else {
      const checked = [...document.querySelectorAll('.qr-server-cb:checked')].map(c => c.value);
      if (!checked.length) { showToast(t('run.needTarget'), 'warning'); return; }
      targets = checked.join(',');
    }

    const extraVarsRaw = document.getElementById('qr-extra-vars').value.trim();
    let extraVars = {};
    if (extraVarsRaw) {
      try { extraVars = JSON.parse(extraVarsRaw); }
      catch { showToast(t('run.invalidJson'), 'error'); return; }
    }

    const btn = document.getElementById('btn-qr-run');
    btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span> ${t('qr.running')}`;

    const emptyEl = document.getElementById('qr-output-empty');
    const bodyEl = document.getElementById('qr-terminal-body');
    emptyEl.style.display = 'none';
    bodyEl.style.display = 'block';
    bodyEl.innerHTML = '';
    document.getElementById('qr-terminal-title').textContent = `ansible-playbook ${playbook} → ${describePlaybookTargets(targets, t)}`;

    const addLine = (text, cls = 'line-stdout') => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      bodyEl.appendChild(span);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    };

    if (_qrWsCleanup) { _qrWsCleanup(); _qrWsCleanup = null; }

    try {
      const { historyId } = await api.runPlaybook(playbook, targets, extraVars);

      _qrWsCleanup = onWsMessage((msg) => {
        if (msg.historyId !== historyId) return;
        if (msg.type === 'ansible_output') {
          addLine(msg.data, msg.stream === 'stderr' ? 'line-stderr' : 'line-stdout');
        } else if (msg.type === 'ansible_complete') {
          addLine(msg.success ? '✓ Completed successfully' : '✗ Completed with errors',
            msg.success ? 'line-success' : 'line-stderr');
          btn.disabled = false; btn.innerHTML = `<i class="fas fa-play"></i> ${t('qr.run')}`;
          if (_qrWsCleanup) { _qrWsCleanup(); _qrWsCleanup = null; }
        } else if (msg.type === 'ansible_error') {
          addLine(`✗ ${msg.error}`, 'line-stderr');
          btn.disabled = false; btn.innerHTML = `<i class="fas fa-play"></i> ${t('qr.run')}`;
          if (_qrWsCleanup) { _qrWsCleanup(); _qrWsCleanup = null; }
        }
      });
    } catch (e) {
      addLine(t('common.errorPrefix', { msg: e.message }), 'line-stderr');
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-play"></i> ${t('qr.run')}`;
    }
  });
}

// ============================================================
// Tab: Variables
// ============================================================
function renderVarsHTML() {
  return `
    <div class="panel dash-panel">
      <div class="dash-panel-header">
        <div class="dash-panel-header-left">
          <div class="dash-panel-icon"><i class="fas fa-sliders-h"></i></div>
          <span class="dash-panel-title">${t('vars.title')}</span>
        </div>
        <div class="dash-panel-header-right">
          ${hasCap('canAddVars') ? `<button class="btn btn-primary btn-sm" id="btn-add-var">
            <i class="fas fa-plus"></i> ${t('vars.add')}
          </button>` : ''}
        </div>
      </div>
      <div id="vars-list">
        <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
      </div>
    </div>

    <div id="var-form-panel" class="panel dash-panel hidden" style="margin-top:16px;">
      <div class="dash-panel-header">
        <div class="dash-panel-header-left">
          <div class="dash-panel-icon" id="var-form-icon"><i class="fas fa-plus"></i></div>
          <span class="dash-panel-title" id="var-form-title">${t('vars.add')}</span>
        </div>
      </div>
      <div class="form-body">
        <div class="form-group">
          <label class="form-label">${t('vars.key')}</label>
          <input class="form-input text-mono" type="text" id="var-key" placeholder="my_variable">
          <div class="form-hint">${t('vars.keyHint')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('vars.value')}</label>
          <input class="form-input" type="text" id="var-value">
        </div>
        <div class="form-group">
          <label class="form-label">${t('vars.description')}</label>
          <input class="form-input" type="text" id="var-description">
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" id="btn-var-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" id="btn-var-save">
            <i class="fas fa-save"></i> ${t('common.save')}
          </button>
        </div>
      </div>
    </div>
  `;
}

let editingVarId = null;

async function loadVarsList() {
  const el = document.getElementById('vars-list');
  if (!el) return;
  try {
    const vars = await api.getAnsibleVars();
    if (!vars || vars.length === 0) {
      el.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('vars.noVars')}</p></div>`;
      return;
    }
    if (isMobilePlaybooksLayout()) {
      el.innerHTML = vars.map(v => `
        <article class="playbooks-mobile-card">
          <div class="playbooks-mobile-card-header">
            <div class="playbooks-mobile-card-title-wrap">
              <div class="playbooks-mobile-card-title text-mono">${esc(v.key)}</div>
              <div class="playbooks-mobile-card-subtitle">${esc(v.description || '') || '&nbsp;'}</div>
            </div>
            <div class="playbooks-mobile-card-actions">
              ${hasCap('canEditVars') ? `<button class="btn btn-secondary btn-icon btn-sm var-edit" data-id="${v.id}" title="${t('common.edit')}"><i class="fas fa-pen"></i></button>` : ''}
              ${hasCap('canDeleteVars') ? `<button class="btn btn-danger btn-icon btn-sm var-delete" data-id="${v.id}" data-key="${esc(v.key)}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
            </div>
          </div>
          <div class="playbooks-mobile-card-row">
            <span class="playbooks-mobile-card-label">${t('vars.value')}</span>
            <span class="text-mono playbooks-mobile-card-value">${esc(v.value)}</span>
          </div>
        </article>
      `).join('');
    } else {
      el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>${t('vars.key')}</th>
            <th>${t('vars.value')}</th>
            <th>${t('vars.description')}</th>
            <th style="width:80px;"></th>
          </tr>
        </thead>
        <tbody>
          ${vars.map(v => `
            <tr>
              <td class="text-mono" style="font-size:13px;font-weight:500;">${esc(v.key)}</td>
              <td class="text-mono" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(v.value)}</td>
              <td style="color:var(--text-muted);font-size:13px;">${esc(v.description || '')}</td>
              <td style="text-align:right;">
                ${hasCap('canEditVars') ? `<button class="btn btn-secondary btn-icon btn-sm var-edit" data-id="${v.id}" title="${t('common.edit')}"><i class="fas fa-pen"></i></button>` : ''}
                ${hasCap('canDeleteVars') ? `<button class="btn btn-danger btn-icon btn-sm var-delete" data-id="${v.id}" data-key="${esc(v.key)}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    }

    el.querySelectorAll('.var-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = vars.find(x => x.id === btn.dataset.id);
        if (!v) return;
        editingVarId = v.id;
        document.getElementById('var-form-title').textContent = t('vars.edit');
        document.getElementById('var-form-icon').innerHTML = '<i class="fas fa-edit"></i>';
        document.getElementById('var-key').value = v.key;
        document.getElementById('var-value').value = v.value;
        document.getElementById('var-description').value = v.description || '';
        document.getElementById('var-form-panel').classList.remove('hidden');
        document.getElementById('var-key').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

    el.querySelectorAll('.var-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm(t('vars.confirmDelete', { key: btn.dataset.key }), { title: t('common.delete'), confirmText: t('common.delete'), danger: true })) return;
        try {
          await api.deleteAnsibleVar(btn.dataset.id);
          showToast(t('vars.deleted'), 'success');
          await loadVarsList();
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
        }
      });
    });
  } catch (e) {
    el.innerHTML = `<p style="padding:12px;color:var(--offline);">${e.message}</p>`;
  }
}

function setupVarsEvents() {
  document.getElementById('btn-add-var')?.addEventListener('click', () => {
    editingVarId = null;
    document.getElementById('var-form-title').textContent = t('vars.add');
    document.getElementById('var-form-icon').innerHTML = '<i class="fas fa-plus"></i>';
    document.getElementById('var-key').value = '';
    document.getElementById('var-value').value = '';
    document.getElementById('var-description').value = '';
    document.getElementById('var-form-panel').classList.remove('hidden');
  });

  document.getElementById('btn-var-cancel')?.addEventListener('click', () => {
    document.getElementById('var-form-panel').classList.add('hidden');
    editingVarId = null;
  });

  document.getElementById('btn-var-save')?.addEventListener('click', async () => {
    const key = document.getElementById('var-key').value.trim();
    const value = document.getElementById('var-value').value;
    const description = document.getElementById('var-description').value.trim();
    if (!key || !value) { showToast(t('common.error'), 'error'); return; }

    const btn = document.getElementById('btn-var-save');
    btn.disabled = true;
    try {
      if (editingVarId) {
        await api.updateAnsibleVar(editingVarId, { key, value, description });
      } else {
        await api.createAnsibleVar({ key, value, description });
      }
      showToast(t('vars.saved'), 'success');
      document.getElementById('var-form-panel').classList.add('hidden');
      editingVarId = null;
      await loadVarsList();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ============================================================
// Tab: Schedules
// ============================================================
const INTERVALS = [
  { value: 'daily', labelKey: 'sc.daily', needsTime: true, needsWeekday: false, needsMonthday: false },
  { value: 'weekly', labelKey: 'sc.weekly', needsTime: true, needsWeekday: true, needsMonthday: false },
  { value: 'monthly', labelKey: 'sc.monthly', needsTime: true, needsWeekday: false, needsMonthday: true },
  { value: 'every_6h', labelKey: 'sc.every6h', needsTime: false, needsWeekday: false, needsMonthday: false },
  { value: 'every_12h', labelKey: 'sc.every12h', needsTime: false, needsWeekday: false, needsMonthday: false },
];

const WEEKDAYS = [
  { value: 1, labelKey: 'sc.mon' },
  { value: 2, labelKey: 'sc.tue' },
  { value: 3, labelKey: 'sc.wed' },
  { value: 4, labelKey: 'sc.thu' },
  { value: 5, labelKey: 'sc.fri' },
  { value: 6, labelKey: 'sc.sat' },
  { value: 0, labelKey: 'sc.sun' },
];

function cronToSelectors(cron) {
  if (cron === '0 */6 * * *') return { interval: 'every_6h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  if (cron === '0 */12 * * *') return { interval: 'every_12h', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const monthly = cron.match(/^(\d+) (\d+) (\d+) \* \*$/);
  if (monthly) return { interval: 'monthly', minute: parseInt(monthly[1]), hour: parseInt(monthly[2]), weekday: 1, monthday: parseInt(monthly[3]) };
  const daily = cron.match(/^(\d+) (\d+) \* \* \*$/);
  if (daily) return { interval: 'daily', minute: parseInt(daily[1]), hour: parseInt(daily[2]), weekday: 1, monthday: 1 };
  const weekly = cron.match(/^(\d+) (\d+) \* \* (\d+)$/);
  if (weekly) return { interval: 'weekly', minute: parseInt(weekly[1]), hour: parseInt(weekly[2]), weekday: parseInt(weekly[3]), monthday: 1 };
  return { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
}

function selectorsToCron(interval, hour, minute, weekday, monthday) {
  const m = minute ?? 0;
  switch (interval) {
    case 'daily': return `${m} ${hour} * * *`;
    case 'weekly': return `${m} ${hour} * * ${weekday}`;
    case 'monthly': return `${m} ${hour} ${monthday} * *`;
    case 'every_6h': return `${m} */6 * * *`;
    case 'every_12h': return `${m} */12 * * *`;
    default: return `${m} ${hour} * * *`;
  }
}

function cronLabel(cron) {
  const { interval, hour, minute, weekday, monthday } = cronToSelectors(cron);
  const iv = INTERVALS.find(i => i.value === interval);
  if (!iv) return cron;
  const ivLabel = t(iv.labelKey);
  if (!iv.needsTime) return ivLabel;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;
  if (interval === 'weekly') {
    const wd = WEEKDAYS.find(w => w.value === weekday);
    return `${ivLabel} (${wd ? t(wd.labelKey) : weekday}), ${timeStr}`;
  }
  if (interval === 'monthly') return `${ivLabel} (${monthday}.), ${timeStr}`;
  return `${ivLabel}, ${timeStr}`;
}

function renderSchedulesHTML() {
  return `
    <div class="panel dash-panel">
      <div class="dash-panel-header">
        <div class="dash-panel-header-left">
          <div class="dash-panel-icon"><i class="fas fa-clock"></i></div>
          <span class="dash-panel-title">${t('pb.schedules')}</span>
        </div>
        <div class="dash-panel-header-right">
          ${hasCap('canAddSchedules') ? `<button class="btn btn-primary btn-sm" id="btn-new-schedule">
            <i class="fas fa-plus"></i> ${t('pb.newSchedule')}
          </button>` : ''}
        </div>
      </div>
      <div id="schedule-list">
        <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
      </div>
    </div>
  `;
}

async function loadScheduleList() {
  const el = document.getElementById('schedule-list');
  if (!el) return;
  try {
    const schedules = await api.getSchedules();
    if (!schedules || schedules.length === 0) {
      el.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('sc.noSchedules')}</p></div>`;
      return;
    }
    if (isMobilePlaybooksLayout()) {
      el.innerHTML = schedules.map(s => `
        <article class="playbooks-mobile-card">
          <div class="playbooks-mobile-card-header">
            <div class="playbooks-mobile-card-title-wrap">
              <div class="playbooks-mobile-card-title">${esc(s.name)}</div>
              <div class="playbooks-mobile-card-subtitle">${esc(s.playbook)}</div>
            </div>
            <div class="playbooks-mobile-card-actions">
              ${hasCap('canEditSchedules') ? `<button class="btn btn-secondary btn-icon btn-sm schedule-edit" data-id="${s.id}" title="${t('common.edit')}"><i class="fas fa-pen"></i></button>` : ''}
              ${hasCap('canDeleteSchedules') ? `<button class="btn btn-danger btn-icon btn-sm schedule-delete" data-id="${s.id}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
            </div>
          </div>
          <div class="playbooks-mobile-card-grid">
            <div>
              <span class="playbooks-mobile-card-label">${t('hist.targets')}</span>
              <span class="playbooks-mobile-card-value">${esc(s.targets || 'all')}</span>
            </div>
            <div>
              <span class="playbooks-mobile-card-label">${t('sc.interval')}</span>
              <span class="playbooks-mobile-card-value">${esc(cronLabel(s.cron_expression))}</span>
            </div>
          </div>
          <div class="playbooks-mobile-card-row">
            <span class="playbooks-mobile-card-label">${t('common.status')}</span>
            <span class="playbooks-mobile-card-value">
              ${hasCap('canToggleSchedules') ? `<label class="toggle-switch" style="vertical-align:middle;margin-right:8px;">
                <input type="checkbox" class="schedule-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>` : ''}
              ${s.last_run
                ? `<span class="badge badge-${s.last_status === 'success' ? 'online' : 'offline'}">${s.last_status}</span> <span style="opacity:.7;">${formatDateTimeShort(s.last_run)}</span>`
                : `<span class="badge badge-${s.enabled ? 'online' : 'unknown'}">${s.enabled ? t('sc.enabled') : t('sc.disabled')}</span>`}
            </span>
          </div>
        </article>
      `).join('');
    } else {
      el.innerHTML = `
      <div class="settings-block" style="margin:0;">
        ${schedules.map(s => `
          <div class="settings-row" style="gap:12px;flex-wrap:nowrap;">
            ${hasCap('canToggleSchedules') ? `<label class="toggle-switch" style="flex-shrink:0;">
              <input type="checkbox" class="schedule-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>` : `<span class="status-dot ${s.enabled ? 'online' : 'unknown'}" style="flex-shrink:0;margin-top:2px;"></span>`}
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;gap:8px;flex-wrap:wrap;">
                <span><i class="fas fa-terminal" style="opacity:.6;margin-right:3px;"></i>${esc(s.playbook)}</span>
                <span><i class="fas fa-server" style="opacity:.6;margin-right:3px;"></i>${esc(s.targets || 'all')}</span>
                <span><i class="fas fa-clock" style="opacity:.6;margin-right:3px;"></i>${cronLabel(s.cron_expression)}</span>
                ${s.last_run
        ? `<span><span class="badge badge-${s.last_status === 'success' ? 'online' : 'offline'}" style="font-size:10px;">${s.last_status}</span> <span style="opacity:.7;">${formatDateTimeShort(s.last_run)}</span></span>`
        : ''}
              </div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              ${hasCap('canEditSchedules') ? `<button class="btn btn-secondary btn-icon btn-sm schedule-edit" data-id="${s.id}" title="${t('common.edit')}"><i class="fas fa-pen"></i></button>` : ''}
              ${hasCap('canDeleteSchedules') ? `<button class="btn btn-danger btn-icon btn-sm schedule-delete" data-id="${s.id}" title="${t('common.delete')}"><i class="fas fa-trash"></i></button>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    }

    el.querySelectorAll('.schedule-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        try {
          await api.toggleSchedule(cb.dataset.id);
          showToast(cb.checked ? t('sc.enabled') : t('sc.disabled'), 'success');
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
          cb.checked = !cb.checked;
        }
      });
    });
    el.querySelectorAll('.schedule-edit').forEach(btn => {
      btn.addEventListener('click', () => openScheduleDialog(btn.dataset.id));
    });
    el.querySelectorAll('.schedule-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm(t('sc.confirmDelete'), { title: t('common.delete'), confirmText: t('common.delete'), danger: true })) return;
        try {
          await api.deleteSchedule(btn.dataset.id);
          showToast(t('sc.deleted'), 'success');
          await loadScheduleList();
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
        }
      });
    });
  } catch (e) {
    el.innerHTML = `<p style="padding:12px;color:var(--offline);">${e.message}</p>`;
  }
}

function setupScheduleEvents() {
  document.getElementById('btn-new-schedule')?.addEventListener('click', () => openScheduleDialog(null));
}

// ============================================================
// Tab: History
// ============================================================
function renderHistoryHTML() {
  return `
    <div class="panel dash-panel">
      <div class="dash-panel-header">
        <div class="dash-panel-header-left">
          <div class="dash-panel-icon"><i class="fas fa-history"></i></div>
          <span class="dash-panel-title">${t('hist.title')}</span>
        </div>
        <div class="dash-panel-header-right">
          <select class="form-input" id="hist-filter" style="width:200px;">
            <option value="">${t('hist.filterAll')}</option>
          </select>
        </div>
      </div>
      <div id="history-list">
        <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
      </div>
    </div>
  `;
}

async function loadHistoryList(scheduleId = null) {
  const el = document.getElementById('history-list');
  if (!el) return;
  try {
    const [history, schedules] = await Promise.all([
      api.getScheduleHistory(100, scheduleId || undefined),
      api.getSchedules(),
    ]);

    // Populate filter
    const filterSel = document.getElementById('hist-filter');
    if (filterSel && schedules) {
      const current = filterSel.value;
      filterSel.innerHTML = `<option value="">${t('hist.filterAll')}</option>` +
        schedules.map(s => `<option value="${s.id}" ${current === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
      filterSel.onchange = () => loadHistoryList(filterSel.value || null);
    }

    if (!history || history.length === 0) {
      el.innerHTML = `<div class="empty-state empty-state-sm"><p>${t('hist.noHistory')}</p></div>`;
      return;
    }

    if (isMobilePlaybooksLayout()) {
      el.innerHTML = history.map(h => `
        <article class="playbooks-mobile-card">
          <div class="playbooks-mobile-card-header">
            <div class="playbooks-mobile-card-title-wrap">
              <div class="playbooks-mobile-card-title">
                ${h.schedule_id === null
                  ? `<span class="badge" style="background:var(--accent-light);color:var(--accent);font-size:11px;">${esc(h.schedule_name)}</span>`
                  : esc(h.schedule_name)}
              </div>
              <div class="playbooks-mobile-card-subtitle text-mono">${esc(h.playbook)}</div>
            </div>
            <div class="playbooks-mobile-card-actions">
              <button class="btn btn-secondary btn-sm hist-show-output" data-id="${h.id}" title="${t('hist.output')}">
                <i class="fas fa-eye"></i>
              </button>
            </div>
          </div>
          <div class="playbooks-mobile-card-grid">
            <div>
              <span class="playbooks-mobile-card-label">${t('hist.targets')}</span>
              <span class="playbooks-mobile-card-value">${esc(h.targets || 'all')}</span>
            </div>
            <div>
              <span class="playbooks-mobile-card-label">${t('hist.started')}</span>
              <span class="playbooks-mobile-card-value">${formatDateTimeShort(h.started_at)}</span>
            </div>
          </div>
          <div class="playbooks-mobile-card-row">
            <span class="playbooks-mobile-card-label">${t('hist.status')}</span>
            <span class="playbooks-mobile-card-value"><span class="badge badge-${h.status === 'success' ? 'online' : h.status === 'running' ? 'warning' : 'offline'}">
              ${h.status === 'success' ? t('hist.success') : h.status === 'running' ? t('hist.running') : t('hist.failed')}
            </span></span>
          </div>
        </article>
      `).join('');
    } else {
      el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>${t('hist.schedule')}</th>
            <th>${t('hist.playbook')}</th>
            <th>${t('hist.targets')}</th>
            <th>${t('hist.started')}</th>
            <th>${t('hist.status')}</th>
            <th style="width:80px;"></th>
          </tr>
        </thead>
        <tbody>
          ${history.map(h => `
            <tr>
              <td style="font-weight:500;">
                ${h.schedule_id === null
        ? `<span class="badge" style="background:var(--accent-light);color:var(--accent);font-size:11px;">${esc(h.schedule_name)}</span>`
        : esc(h.schedule_name)
      }
              </td>
              <td class="text-mono" style="font-size:12px;">${esc(h.playbook)}</td>
              <td>${esc(h.targets || 'all')}</td>
              <td style="font-size:12px;color:var(--text-muted);">${formatDateTimeShort(h.started_at)}</td>
              <td>
                <span class="badge badge-${h.status === 'success' ? 'online' : h.status === 'running' ? 'warning' : 'offline'}">
                  ${h.status === 'success' ? t('hist.success') : h.status === 'running' ? t('hist.running') : t('hist.failed')}
                </span>
              </td>
              <td style="text-align:right;">
                <button class="btn btn-secondary btn-sm hist-show-output" data-id="${h.id}" title="${t('hist.output')}">
                  <i class="fas fa-eye"></i>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    }

    el.querySelectorAll('.hist-show-output').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const entry = await api.getScheduleHistoryEntry(btn.dataset.id);
          showOutputModal(entry);
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
        }
      });
    });
  } catch (e) {
    el.innerHTML = `<p style="padding:12px;color:var(--offline);">${e.message}</p>`;
  }
}

function showOutputModal(entry) {
  const overlay = document.getElementById('modal-overlay');
  const onOverlayClick = (e) => {
    if (e.target === overlay) close();
  };
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <h2 id="hist-output-title"><i class="fas fa-file-alt"></i> ${esc(entry.schedule_name)} — ${esc(entry.playbook)}</h2>
      <div class="terminal" style="margin:8px 0;max-height:60vh;">
        <div class="terminal-header">
          <div class="terminal-title">${formatDateTimeShort(entry.started_at)}</div>
        </div>
        <div class="terminal-body" style="white-space:pre-wrap;">${esc(entry.output || t('adhoc.noOutput'))}</div>
      </div>
      <div class="form-actions" style="padding-top:8px;">
        <button class="btn btn-secondary" id="hist-modal-close">${t('common.close')}</button>
      </div>
    </div>
  `;
  let releaseDialog = null;
  const close = () => {
    overlay.removeEventListener('click', onOverlayClick);
    releaseDialog?.();
    releaseDialog = null;
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  };
  releaseDialog = activateDialog({
    dialog: overlay.querySelector('.modal'),
    initialFocus: '#hist-modal-close',
    onClose: close,
    labelledBy: 'hist-output-title',
  });
  document.getElementById('hist-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);
}

// ============================================================
// Playbook History Modal
// ============================================================
function showHistoryModal(filename, versions, onRestored) {
  const overlay = document.getElementById('modal-overlay');
  const onOverlayClick = (e) => {
    if (e.target === overlay) close();
  };
  overlay.classList.remove('hidden');
  let releaseDialog = null;

  function renderRows(openVersion = null) {
    if (versions.length === 0) {
      return `<p style="color:var(--text-muted);padding:8px 0;font-size:13px;">${t('pb.noHistory')}</p>`;
    }
    return versions.map(v => {
      const isOpen = openVersion === v.version;
      return `
        <div class="pb-hist-row" data-version="${v.version}">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:13px;">
              <strong>${t('pb.historyVersion', { n: v.version })}</strong>
              <span style="color:var(--text-muted);margin-left:8px;">${formatDateTimeShort(v.modifiedAt)}</span>
            </span>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button class="btn btn-secondary btn-sm btn-preview-version" data-version="${v.version}"
                title="${t('pb.historyPreview')}" style="${isOpen ? 'color:var(--accent);' : ''}">
                <i class="fas fa-eye"></i>
              </button>
              <button class="btn btn-secondary btn-sm btn-restore-version" data-version="${v.version}"
                title="${t('pb.history')}">
                <i class="fas fa-undo"></i>
              </button>
            </div>
          </div>
          ${isOpen ? `
          <div class="pb-hist-preview" style="margin-bottom:8px;">
            <div class="loading-state" style="padding:12px;" id="pb-hist-preview-${v.version}">
              <div class="loader"></div>
            </div>
          </div>` : ''}
        </div>`;
    }).join('');
  }

  function render(openVersion = null) {
    overlay.innerHTML = `
      <div class="modal modal-wide">
        <h2 id="pb-history-title"><i class="fas fa-history"></i> ${t('pb.historyTitle')}</h2>
        <div class="form-body" style="max-height:70vh;overflow-y:auto;" id="pb-hist-list">
          ${renderRows(openVersion)}
        </div>
        <div class="form-actions" style="padding-top:12px;">
          <button class="btn btn-secondary" id="pb-hist-close">${t('common.close')}</button>
        </div>
      </div>`;

    releaseDialog?.();
    releaseDialog = activateDialog({
      dialog: overlay.querySelector('.modal'),
      initialFocus: '#pb-hist-close',
      onClose: close,
      labelledBy: 'pb-history-title',
    });

    document.getElementById('pb-hist-close').addEventListener('click', close);

    overlay.querySelectorAll('.btn-preview-version').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = parseInt(btn.dataset.version);
        const currentOpen = overlay.querySelector('.pb-hist-preview')
          ? parseInt(overlay.querySelector('.btn-preview-version[style*="accent"]')?.dataset.version) || null
          : null;
        if (currentOpen === v) { render(null); return; }
        render(v);
        const previewEl = document.getElementById(`pb-hist-preview-${v}`);
        try {
          const data = await api.getPlaybookVersion(filename, v);
          if (previewEl) {
            previewEl.innerHTML = `<pre style="
              background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);
              padding:12px 14px;font-family:var(--font-mono);font-size:12px;line-height:1.5;
              overflow-x:auto;white-space:pre;margin:0;color:var(--text-primary);
            ">${esc(data.content)}</pre>`;
          }
        } catch (err) {
          if (previewEl) previewEl.innerHTML = `<p style="color:var(--offline);font-size:13px;padding:8px 0;">${esc(err.message)}</p>`;
        }
      });
    });

    overlay.querySelectorAll('.btn-restore-version').forEach(btn => {
      btn.addEventListener('click', async () => {
        const v = parseInt(btn.dataset.version);
        close();
        if (!await showConfirm(t('pb.restoreConfirm'), { title: t('pb.history'), confirmText: t('common.save'), danger: false })) return;
        try {
          await api.restorePlaybook(filename, v);
          showToast(t('pb.restored'), 'success');
          const data = await api.getPlaybook(filename);
          onRestored(data.content);
        } catch (err) {
          showToast(t('common.errorPrefix', { msg: err.message }), 'error');
        }
      });
    });
  }

  function close() {
    overlay.removeEventListener('click', onOverlayClick);
    releaseDialog?.();
    releaseDialog = null;
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  }

  overlay.addEventListener('click', onOverlayClick);
  render();
}

// ============================================================
// Schedule Dialog
// ============================================================
async function openScheduleDialog(editId) {
  let existing = null;
  if (editId) {
    const schedules = await api.getSchedules();
    existing = schedules.find(s => s.id === editId);
  }

  let playbooks = [];
  try { playbooks = (await api.getPlaybooks()).filter(p => !p.isInternal); } catch { }
  const parsedTargets = parsePlaybookTargets(existing?.targets || 'all');

  const parsed = existing ? cronToSelectors(existing.cron_expression) : { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const parsedHour = parsed.hour ?? 3;
  const parsedMinute = parsed.minute ?? 0;
  const hourOptions = Array.from({ length: 24 }, (_, i) => `<option value="${i}"${i === parsedHour ? ' selected' : ''}>${String(i).padStart(2, '0')}</option>`).join('');
  const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5).map(m => `<option value="${m}"${m === parsedMinute ? ' selected' : ''}>${String(m).padStart(2, '0')}</option>`).join('');

  const intervalOptions = INTERVALS.map(i =>
    `<option value="${i.value}" ${parsed.interval === i.value ? 'selected' : ''}>${t(i.labelKey)}</option>`
  ).join('');

  const weekdayOptions = WEEKDAYS.map(w =>
    `<option value="${w.value}" ${parsed.weekday === w.value ? 'selected' : ''}>${t(w.labelKey)}</option>`
  ).join('');

  const overlay = document.getElementById('modal-overlay');
  const onOverlayClick = (e) => {
    if (e.target === overlay) close();
  };
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal modal-md">
      <h2 id="sched-dialog-title">${existing ? `<i class="fas fa-edit"></i> ${t('sc.editTitle')}` : `<i class="fas fa-clock"></i> ${t('sc.newTitle')}`}</h2>
      <div class="form-body">
        <form id="schedule-form">
          <div class="form-group">
            <label class="form-label">${t('sc.name')}</label>
            <input class="form-input" type="text" id="sched-name" placeholder="${t('sc.namePlaceholder')}" value="${esc(existing?.name || '')}" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('sc.playbook')}</label>
            <select class="form-input" id="sched-playbook" required>
              <option value="">${t('sc.selectPlaybook')}</option>
              ${playbooks.map(p => `<option value="${esc(p.filename)}" ${existing?.playbook === p.filename ? 'selected' : ''}>${esc(p.description)} (${esc(p.filename)})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('sc.target')}</label>
            <div class="form-hint" id="sched-target-hint">${parsedTargets.mode === 'all' ? t('run.excludeHint') : t('run.includeHint')}</div>
            <div id="sched-targets-box" style="border:1px solid var(--border);border-radius:var(--radius-sm);max-height:150px;overflow-y:auto;background:var(--bg-panel);">
              ${[
      { value: 'all', label: t('pb.allServers'), special: true },
      ...state.servers.map(s => ({ value: s.name, label: s.name })),
      { value: 'localhost', label: 'localhost' },
    ].map(opt => {
      let sel = false;
      if (opt.value === 'all') {
        sel = parsedTargets.mode === 'all';
      } else if (parsedTargets.mode === 'all') {
        sel = parsedTargets.excluded.includes(opt.value);
      } else {
        sel = parsedTargets.included.includes(opt.value);
      }
      return `<label style="display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);">
                  <input type="checkbox" class="sched-target-cb" value="${esc(opt.value)}"${sel ? ' checked' : ''}${opt.special ? ' id="sched-target-all"' : ''}>
                  ${opt.special ? `<span style="color:var(--text-muted);"><i class="fas fa-layer-group" style="margin-right:4px;"></i>${esc(opt.label)}</span>` : `<span>${esc(opt.label)}</span>`}
                </label>`;
    }).join('')}
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t('sc.interval')}</label>
              <select class="form-input" id="sched-interval">${intervalOptions}</select>
            </div>
            <div class="form-group" id="sched-time-group">
              <label class="form-label">${t('sc.time')}</label>
              <div style="display:flex;align-items:center;gap:4px;">
                <select class="form-input" id="sched-hour" style="width:72px;">${hourOptions}</select>
                <span style="color:var(--text-muted);font-weight:600;">:</span>
                <select class="form-input" id="sched-minute" style="width:72px;">${minuteOptions}</select>
              </div>
            </div>
          </div>
          <div class="form-group hidden" id="sched-weekday-group">
            <label class="form-label">${t('sc.weekday')}</label>
            <select class="form-input" id="sched-weekday">${weekdayOptions}</select>
          </div>
          <div class="form-group hidden" id="sched-monthday-group">
            <label class="form-label">${t('sc.dayOfMonth')}</label>
            <input class="form-input" type="number" id="sched-monthday" min="1" max="28"
              value="${parsed.monthday}" placeholder="1–28">
            <div class="form-hint">${t('common.dayHint')}</div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="sched-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn-primary" id="sched-save">
              ${existing ? t('common.save') : t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  let releaseDialog = null;
  const close = () => {
    overlay.removeEventListener('click', onOverlayClick);
    releaseDialog?.();
    releaseDialog = null;
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  };
  releaseDialog = activateDialog({
    dialog: overlay.querySelector('.modal'),
    initialFocus: '#sched-name',
    onClose: close,
    labelledBy: 'sched-dialog-title',
  });

  const allCb = document.getElementById('sched-target-all');
  const schedHint = document.getElementById('sched-target-hint');
  function syncScheduleTargetMode() {
    const excludeMode = !!allCb?.checked;
    if (schedHint) schedHint.textContent = excludeMode ? t('run.excludeHint') : t('run.includeHint');
    const localhostCb = document.querySelector('.sched-target-cb[value="localhost"]');
    if (localhostCb) {
      localhostCb.disabled = excludeMode;
      if (excludeMode) localhostCb.checked = false;
      const row = localhostCb.closest('label');
      if (row) row.style.opacity = excludeMode ? '0.55' : '1';
    }
  }
  allCb?.addEventListener('change', syncScheduleTargetMode);
  syncScheduleTargetMode();

  const intervalSel = document.getElementById('sched-interval');
  const timeGroup = document.getElementById('sched-time-group');
  const weekdayGroup = document.getElementById('sched-weekday-group');
  const monthdayGroup = document.getElementById('sched-monthday-group');

  function updateVisibility() {
    const iv = INTERVALS.find(i => i.value === intervalSel.value);
    timeGroup.classList.toggle('hidden', !iv?.needsTime);
    weekdayGroup.classList.toggle('hidden', !iv?.needsWeekday);
    monthdayGroup.classList.toggle('hidden', !iv?.needsMonthday);
  }
  updateVisibility();
  intervalSel.addEventListener('change', updateVisibility);

  document.getElementById('sched-cancel').addEventListener('click', close);
  overlay.addEventListener('click', onOverlayClick);

  document.getElementById('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('sched-name').value.trim();
    const playbook = document.getElementById('sched-playbook').value;
    const allChecked = !!document.getElementById('sched-target-all')?.checked;
    const checkedCbs = [...document.querySelectorAll('.sched-target-cb:checked')];
    const targets = allChecked
      ? buildAllExceptTargets(checkedCbs.map(cb => cb.value).filter(v => v !== 'all' && v !== 'localhost'))
      : checkedCbs.map(cb => cb.value).filter(v => v !== 'all').join(',') || 'all';
    const interval = intervalSel.value;
    const hour = parseInt(document.getElementById('sched-hour').value) || 0;
    const minute = parseInt(document.getElementById('sched-minute').value) || 0;
    const weekday = parseInt(document.getElementById('sched-weekday').value);
    const monthday = Math.min(28, Math.max(1, parseInt(document.getElementById('sched-monthday').value) || 1));
    const cronExpression = selectorsToCron(interval, hour, minute, weekday, monthday);

    if (!name || !playbook) { showToast(t('sc.required'), 'error'); return; }

    const saveBtn = document.getElementById('sched-save');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-sm"></span>';

    try {
      if (existing) {
        await api.updateSchedule(existing.id, { name, playbook, targets, cronExpression });
        showToast(t('sc.updated'), 'success');
      } else {
        await api.createSchedule({ name, playbook, targets, cronExpression });
        showToast(t('sc.created'), 'success');
      }
      close();
      await loadScheduleList();
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      saveBtn.disabled = false;
      saveBtn.innerHTML = existing ? t('common.save') : t('common.create');
    }
  });
}
