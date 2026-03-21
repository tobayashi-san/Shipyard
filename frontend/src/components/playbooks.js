import { api } from '../api.js';
import { state, navigate } from '../main.js';
import { showToast, showConfirm } from './toast.js';
import { t } from '../i18n.js';
import { formatDateTimeShort } from '../utils/format.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
import { EditorView, basicSetup } from 'codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

// ── CodeMirror instance ───────────────────────────────────────
let cmEditor = null;

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
  '.cm-activeLine': { background: 'var(--bg-row-hover)' },
  '.cm-selectionBackground': { background: 'rgba(99,102,241,0.25) !important' },
  '&.cm-focused .cm-selectionBackground': { background: 'rgba(99,102,241,0.35) !important' },
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
      extensions: [
        basicSetup,
        yaml(),
        syntaxHighlighting(classHighlighter),
        cmTheme,
      ],
    }),
    parent: container,
  });
}

function getEditorContent() {
  return cmEditor ? cmEditor.state.doc.toString() : '';
}

function setEditorContent(content) {
  if (!cmEditor) return;
  cmEditor.dispatch({
    changes: { from: 0, to: cmEditor.state.doc.length, insert: content },
  });
  cmEditor.scrollDOM.scrollTop = 0;
}

// ============================================================
// Playbooks Page – list, create, edit, run
// ============================================================

export async function renderPlaybooks() {
  const main = document.querySelector('.main-content');
  if (!main) return;

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h2>${t('pb.title')}</h2>
        <p>${t('pb.subtitle')}</p>
      </div>
      <div class="page-header-actions">
        <button class="btn btn-primary btn-sm" id="btn-new-playbook">
          <i class="fas fa-plus"></i> ${t('pb.new')}
        </button>
      </div>
    </div>

    <div class="page-content">
      <div class="page-content-grid" style="margin-bottom:20px;">
        <!-- Left: Playbook list -->
        <div class="panel" id="playbook-list-panel">
          <div class="section-header">
            <h3><i class="fas fa-list"></i> ${t('pb.title')}</h3>
          </div>
          <div id="playbook-list">
            <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
          </div>
        </div>

        <!-- Right: Editor / Run panel -->
        <div id="playbook-editor-panel" class="hidden">
          <div class="panel">
            <div class="section-header" id="editor-header">
              <h3><i class="fas fa-edit"></i> <span id="editor-title">${t('pb.editTitle')}</span></h3>
              <div class="flex-gap">
                <button class="btn btn-danger btn-sm hidden" id="btn-delete-playbook">
                  <i class="fas fa-trash"></i>
                </button>
                <button class="btn btn-secondary btn-sm hidden" id="btn-playbook-history" title="${t('pb.history')}">
                  <i class="fas fa-history"></i> ${t('pb.history')}
                </button>
                <button class="btn btn-secondary btn-sm" id="btn-cancel-edit">${t('common.cancel')}</button>
                <button class="btn btn-primary btn-sm" id="btn-save-playbook">
                  <i class="fas fa-save"></i> ${t('common.save')}
                </button>
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

        <!-- Right: Run panel -->
        <div id="playbook-run-panel" class="hidden">
          <div class="panel">
            <div class="section-header">
              <h3><i class="fas fa-play"></i> <span id="run-playbook-name">${t('common.run')}</span></h3>
              <button class="btn btn-secondary btn-sm" id="btn-cancel-run">${t('common.close')}</button>
            </div>
            <div class="form-body">
              <div class="form-group">
                <label class="form-label">${t('pb.target')}</label>
                <select class="form-input" id="run-target">
                  <option value="all">${t('pb.allServers')}</option>
                  ${state.servers.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}
                  <option value="localhost">localhost</option>
                </select>
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
                  <div class="terminal-dots">
                    <div class="terminal-dot red"></div>
                    <div class="terminal-dot yellow"></div>
                    <div class="terminal-dot green"></div>
                  </div>
                  <div class="terminal-title" id="run-terminal-title">${t('pb.output')}</div>
                </div>
                <div class="terminal-body" id="run-terminal-body"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- Welcome placeholder -->
        <div id="playbook-welcome">
          <div class="panel">
            <div class="empty-state">
              <div class="empty-state-icon"><i class="fas fa-terminal"></i></div>
              <h3>${t('pb.noPlaybooks')}</h3>
              <p>${t('pb.selectHint')}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Schedules Section -->
      <div class="panel">
        <div class="section-header">
          <h3><i class="fas fa-clock"></i> ${t('pb.schedules')}</h3>
          <button class="btn btn-primary btn-sm" id="btn-new-schedule">
            <i class="fas fa-plus"></i> ${t('pb.newSchedule')}
          </button>
        </div>
        <div id="schedule-list">
          <div class="loading-state"><div class="loader"></div> ${t('pb.loading')}</div>
        </div>
      </div>
    </div>
  `;

  await loadPlaybookList();
  await loadScheduleList();
  setupPlaybookEvents();
  setupScheduleEvents();
}

// ============================================================
// List
// ============================================================
let currentFilename = null;

async function loadPlaybookList() {
  const listEl = document.getElementById('playbook-list');
  if (!listEl) return;
  try {
    const playbooks = await api.getPlaybooks();
    if (!playbooks || playbooks.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:20px;"><p>${t('pb.noPlaybooks')}.</p></div>`;
      return;
    }

    const user = playbooks.filter(p => !p.isInternal);
    const internal = playbooks.filter(p => p.isInternal);

    let html = '';
    if (user.length > 0) {
      html += renderPlaybookGroup(t('pb.custom'), user, false);
    }
    if (internal.length > 0) {
      html += renderPlaybookGroup(t('pb.internal'), internal, true);
    }
    listEl.innerHTML = html;

    // Click handlers
    listEl.querySelectorAll('.playbook-item').forEach(item => {
      item.addEventListener('click', () => selectPlaybook(item.dataset.filename, item.dataset.internal === 'true'));
    });
    listEl.querySelectorAll('.btn-run-playbook').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRunPanel(btn.dataset.filename, btn.dataset.description);
      });
    });
  } catch (e) {
    listEl.innerHTML = `<p style="padding:12px;color:var(--offline);">${t('pb.loadError', { msg: esc(e.message) })}</p>`;
  }
}

function renderPlaybookGroup(label, playbooks, isInternal) {
  return `
    <div>
      <div class="pb-group-title">${label}</div>
      ${playbooks.map(p => `
        <div class="playbook-item" data-filename="${esc(p.filename)}" data-internal="${isInternal}">
          <div style="overflow:hidden;flex:1;min-width:0;">
            <div class="playbook-item-name">${esc(p.description)}</div>
            <div class="playbook-item-file">${esc(p.filename)}</div>
          </div>
          <button class="btn btn-secondary btn-sm btn-run-playbook" data-filename="${esc(p.filename)}" data-description="${esc(p.description)}" title="${t('common.run')}" style="flex-shrink:0;">
            <i class="fas fa-play"></i>
          </button>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================
// Editor
// ============================================================
async function selectPlaybook(filename, isInternal) {
  currentFilename = filename;
  showPanel('editor');
  document.getElementById('editor-title').textContent = filename;
  const filenameGroup = document.getElementById('filename-group');
  const deleteBtn = document.getElementById('btn-delete-playbook');

  // Hide filename input and delete for internal playbooks
  filenameGroup.classList.toggle('hidden', isInternal);
  if (deleteBtn) deleteBtn.classList.toggle('hidden', isInternal);
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

  // Highlight active item
  document.querySelectorAll('.playbook-item').forEach(i => {
    i.classList.toggle('active', i.dataset.filename === filename);
  });
}

function openRunPanel(filename, description) {
  currentFilename = filename;
  showPanel('run');
  document.getElementById('run-playbook-name').textContent = description || filename;
  document.getElementById('run-output').classList.add('hidden');
  document.getElementById('run-terminal-body').innerHTML = '';
}

function showPanel(which) {
  document.getElementById('playbook-editor-panel').classList.toggle('hidden', which !== 'editor');
  document.getElementById('playbook-run-panel').classList.toggle('hidden', which !== 'run');
  document.getElementById('playbook-welcome').classList.toggle('hidden', which !== 'none');
  if (which === 'editor' && !cmEditor) {
    initEditor();
  }
}

// ============================================================
// Events
// ============================================================
function setupPlaybookEvents() {
  document.getElementById('btn-new-playbook')?.addEventListener('click', () => {
    currentFilename = null;
    showPanel('editor');
    document.getElementById('editor-title').textContent = t('pb.new');
    document.getElementById('filename-group').classList.remove('hidden');
    document.getElementById('btn-delete-playbook').classList.add('hidden');
    document.getElementById('playbook-filename').value = '';
    setEditorContent(`---\n- name: My New Playbook\n  hosts: all\n  become: yes\n  tasks:\n    - name: Ping all hosts\n      ping:\n`);
    document.querySelectorAll('.playbook-item').forEach(i => i.classList.remove('active'));
  });

  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    showPanel('none');
    currentFilename = null;
    document.querySelectorAll('.playbook-item').forEach(i => i.classList.remove('active'));
  });

  document.getElementById('btn-playbook-history')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    let versions;
    try {
      versions = await api.getPlaybookHistory(currentFilename);
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      return;
    }

    const items = versions.length === 0
      ? `<p style="color:var(--text-muted);padding:8px 0;">${t('pb.noHistory')}</p>`
      : versions.map(v => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:13px;">
              <strong>${t('pb.historyVersion', { n: v.version })}</strong>
              <span style="color:var(--text-muted);margin-left:8px;">${formatDateTimeShort(v.modifiedAt)}</span>
            </span>
            <button class="btn btn-secondary btn-sm btn-restore-version" data-version="${v.version}" style="flex-shrink:0;">
              <i class="fas fa-undo"></i>
            </button>
          </div>
        `).join('');

    const confirmed = await showConfirm(
      `<strong>${t('pb.historyTitle')}</strong><div style="margin-top:12px;">${items}</div>`,
      { title: t('pb.historyTitle'), confirmText: null, cancelText: t('common.cancel') }
    );

    // Attach restore handlers after confirm dialog renders
    document.querySelectorAll('.btn-restore-version').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const version = parseInt(btn.dataset.version);
        if (!await showConfirm(t('pb.restoreConfirm'), { title: t('pb.history'), confirmText: t('common.save'), danger: false })) return;
        try {
          await api.restorePlaybook(currentFilename, version);
          showToast(t('pb.restored'), 'success');
          const data = await api.getPlaybook(currentFilename);
          setEditorContent(data.content);
        } catch (err) {
          showToast(t('common.errorPrefix', { msg: err.message }), 'error');
        }
      });
    });
  });

  document.getElementById('btn-cancel-run')?.addEventListener('click', () => {
    showPanel('none');
    document.querySelectorAll('.playbook-item').forEach(i => i.classList.remove('active'));
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
      await loadPlaybookList();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-save"></i> ${t('common.save')}`;
    }
  });

  document.getElementById('btn-delete-playbook')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    if (!await showConfirm(`${t('pb.confirmDelete', { name: currentFilename })}<br><small style="color:var(--text-muted)">${t('pb.confirmDeleteHint')}</small>`, { title: t('common.delete'), confirmText: t('common.delete'), danger: true })) return;
    try {
      await api.deletePlaybook(currentFilename);
      showToast(t('pb.deleted', { name: currentFilename }), 'success');
      showPanel('none');
      currentFilename = null;
      await loadPlaybookList();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    }
  });

  document.getElementById('btn-run-confirm')?.addEventListener('click', async () => {
    if (!currentFilename) return;
    const target = document.getElementById('run-target').value;
    const btn = document.getElementById('btn-run-confirm');
    btn.disabled = true; btn.innerHTML = `<span class="spinner-sm"></span> ${t('run.starting')}`;

    const outputEl = document.getElementById('run-output');
    const bodyEl = document.getElementById('run-terminal-body');
    outputEl.classList.remove('hidden');
    bodyEl.innerHTML = '';
    document.getElementById('run-terminal-title').textContent = `ansible-playbook ${currentFilename} → ${target}`;

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
// Schedules
// ============================================================
const INTERVALS = [
  { value: 'daily',    labelKey: 'sc.daily',    needsTime: true,  needsWeekday: false, needsMonthday: false },
  { value: 'weekly',   labelKey: 'sc.weekly',   needsTime: true,  needsWeekday: true,  needsMonthday: false },
  { value: 'monthly',  labelKey: 'sc.monthly',  needsTime: true,  needsWeekday: false, needsMonthday: true  },
  { value: 'every_6h', labelKey: 'sc.every6h',  needsTime: false, needsWeekday: false, needsMonthday: false },
  { value: 'every_12h',labelKey: 'sc.every12h', needsTime: false, needsWeekday: false, needsMonthday: false },
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
  if (cron === '0 */6 * * *')  return { interval: 'every_6h',  hour: 3,  minute: 0, weekday: 1, monthday: 1 };
  if (cron === '0 */12 * * *') return { interval: 'every_12h', hour: 3,  minute: 0, weekday: 1, monthday: 1 };
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
    case 'daily':     return `${m} ${hour} * * *`;
    case 'weekly':    return `${m} ${hour} * * ${weekday}`;
    case 'monthly':   return `${m} ${hour} ${monthday} * *`;
    case 'every_6h':  return `${m} */6 * * *`;
    case 'every_12h': return `${m} */12 * * *`;
    default:          return `${m} ${hour} * * *`;
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
    const wdLabel = wd ? t(wd.labelKey) : weekday;
    return `${ivLabel} (${wdLabel}), ${timeStr}`;
  }
  if (interval === 'monthly') return `${ivLabel} (${monthday}.), ${timeStr}`;
  return `${ivLabel}, ${timeStr}`;
}

async function loadScheduleList() {
  const el = document.getElementById('schedule-list');
  if (!el) return;
  try {
    const schedules = await api.getSchedules();
    if (!schedules || schedules.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:20px;"><p style="color:var(--text-muted);">${t('sc.noSchedules')}</p></div>`;
      return;
    }

    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:40px;">${t('sc.active')}</th>
            <th>${t('sc.name')}</th>
            <th>${t('sc.playbook')}</th>
            <th>${t('sc.target')}</th>
            <th>${t('sc.schedule')}</th>
            <th>${t('sc.lastRun')}</th>
            <th style="width:80px;"></th>
          </tr>
        </thead>
        <tbody>
          ${schedules.map(s => `
            <tr>
              <td>
                <label style="cursor:pointer;">
                  <input type="checkbox" class="schedule-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}
                    style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent);">
                </label>
              </td>
              <td style="font-weight:500;">${s.name}</td>
              <td class="text-mono" style="font-size:12px;">${s.playbook}</td>
              <td>${s.targets || 'all'}</td>
              <td style="font-size:12px;">${cronLabel(s.cron_expression)}</td>
              <td>
                ${s.last_run
                  ? `<span class="badge badge-${s.last_status === 'success' ? 'online' : 'offline'}">${s.last_status}</span>
                     <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">${formatScheduleDate(s.last_run)}</span>`
                  : '<span style="color:var(--text-muted);">—</span>'
                }
              </td>
              <td style="text-align:right;">
                <button class="btn btn-secondary btn-icon btn-sm schedule-edit" data-id="${s.id}" title="${t('common.edit')}">
                  <i class="fas fa-pen"></i>
                </button>
                <button class="btn btn-danger btn-icon btn-sm schedule-delete" data-id="${s.id}" title="${t('common.delete')}">
                  <i class="fas fa-trash"></i>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Toggle handlers
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

    // Edit handlers
    el.querySelectorAll('.schedule-edit').forEach(btn => {
      btn.addEventListener('click', () => openScheduleDialog(btn.dataset.id));
    });

    // Delete handlers
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

function formatScheduleDate(dateStr) {
  return formatDateTimeShort(dateStr);
}

function setupScheduleEvents() {
  document.getElementById('btn-new-schedule')?.addEventListener('click', () => openScheduleDialog(null));
}

async function openScheduleDialog(editId) {
  let existing = null;
  if (editId) {
    const schedules = await api.getSchedules();
    existing = schedules.find(s => s.id === editId);
  }

  let playbooks = [];
  try { playbooks = await api.getPlaybooks(); } catch {}

  const parsed = existing ? cronToSelectors(existing.cron_expression) : { interval: 'daily', hour: 3, minute: 0, weekday: 1, monthday: 1 };
  const parsedTimeVal = `${String(parsed.hour).padStart(2,'0')}:${String(parsed.minute ?? 0).padStart(2,'0')}`;

  const intervalOptions = INTERVALS.map(i =>
    `<option value="${i.value}" ${parsed.interval === i.value ? 'selected' : ''}>${t(i.labelKey)}</option>`
  ).join('');

  const weekdayOptions = WEEKDAYS.map(w =>
    `<option value="${w.value}" ${parsed.weekday === w.value ? 'selected' : ''}>${t(w.labelKey)}</option>`
  ).join('');

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px;">
      <h2>${existing ? `<i class="fas fa-edit"></i> ${t('sc.editTitle')}` : `<i class="fas fa-clock"></i> ${t('sc.newTitle')}`}</h2>
      <div class="form-body">
        <form id="schedule-form">
          <div class="form-group">
            <label class="form-label">${t('sc.name')}</label>
            <input class="form-input" type="text" id="sched-name" placeholder="${t('sc.namePlaceholder')}" value="${existing?.name || ''}" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('sc.playbook')}</label>
            <select class="form-input" id="sched-playbook" required>
              <option value="">${t('sc.selectPlaybook')}</option>
              ${playbooks.map(p => `<option value="${p.filename}" ${existing?.playbook === p.filename ? 'selected' : ''}>${p.description} (${p.filename})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('sc.target')}</label>
            <select class="form-input" id="sched-targets">
              <option value="all" ${!existing || existing.targets === 'all' ? 'selected' : ''}>${t('pb.allServers')}</option>
              ${state.servers.map(s => `<option value="${s.name}" ${existing?.targets === s.name ? 'selected' : ''}>${s.name}</option>`).join('')}
              <option value="localhost" ${existing?.targets === 'localhost' ? 'selected' : ''}>localhost</option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">${t('sc.interval')}</label>
              <select class="form-input" id="sched-interval">
                ${intervalOptions}
              </select>
            </div>
            <div class="form-group" id="sched-time-group" style="margin-bottom:0;">
              <label class="form-label">${t('sc.time')}</label>
              <input class="form-input" type="time" id="sched-time" value="${parsedTimeVal}">
            </div>
          </div>
          <div class="form-group hidden" id="sched-weekday-group">
            <label class="form-label">${t('sc.weekday')}</label>
            <select class="form-input" id="sched-weekday">
              ${weekdayOptions}
            </select>
          </div>
          <div class="form-group hidden" id="sched-monthday-group">
            <label class="form-label">${t('sc.dayOfMonth')}</label>
            <input class="form-input" type="number" id="sched-monthday" min="1" max="28"
              value="${parsed.monthday}" placeholder="1–28">
            <div class="form-hint">1–28 (Tag 29–31 existiert nicht in jedem Monat)</div>
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

  document.getElementById('sched-cancel').addEventListener('click', () => {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
  });

  document.getElementById('schedule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('sched-name').value.trim();
    const playbook = document.getElementById('sched-playbook').value;
    const targets = document.getElementById('sched-targets').value;
    const interval = intervalSel.value;
    const timeVal = (document.getElementById('sched-time').value || '03:00').split(':');
    const hour = parseInt(timeVal[0]) || 0;
    const minute = parseInt(timeVal[1]) || 0;
    const weekday = parseInt(document.getElementById('sched-weekday').value);
    const monthday = Math.min(28, Math.max(1, parseInt(document.getElementById('sched-monthday').value) || 1));
    const cronExpression = selectorsToCron(interval, hour, minute, weekday, monthday);

    if (!name || !playbook) {
      showToast(t('sc.required'), 'error');
      return;
    }

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
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
      await loadScheduleList();
    } catch (err) {
      showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      saveBtn.disabled = false;
      saveBtn.innerHTML = existing ? t('common.save') : t('common.create');
    }
  });
}
