import { api } from '../api.js';
import { state } from '../main.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {Function} onClose
 * @param {string[]} [preselectedNames] – server names to preselect (bulk action)
 */
export async function showRunPlaybookModal(onClose, preselectedNames = []) {
  let playbooks = [];
  try {
    playbooks = await api.getPlaybooks();
  } catch (err) {
    showToast(t('run.loadError', { msg: err.message }), 'error');
    return;
  }

  const userPlaybooks = playbooks.filter(p => !p.isInternal);
  if (userPlaybooks.length === 0) {
    showToast(t('run.noCustom'), 'error');
    return;
  }

  const isBulk = preselectedNames.length > 0;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay animate-fade-in';

  overlay.innerHTML = `
    <div class="modal" style="max-width:500px;">
      <h2>
        <i class="fas fa-tools"></i> ${t('run.title')}
        <button id="btn-rp-close" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:18px;color:var(--text-muted);line-height:1;">×</button>
      </h2>
      <div class="form-body">
        <form id="run-playbook-form">

          ${isBulk ? `
            <div class="form-group">
              <label class="form-label">${t('run.target')} <span class="badge badge-accent" style="font-size:11px;">${t('run.selected', { count: preselectedNames.length })}</span></label>
              <div class="bulk-target-list">
                ${preselectedNames.map(n => `
                  <span class="bulk-target-chip" data-name="${esc(n)}">
                    <span class="status-dot online" style="display:inline-block;"></span>
                    ${esc(n)}
                    <button type="button" class="chip-remove" data-name="${esc(n)}" title="Entfernen">×</button>
                  </span>
                `).join('')}
              </div>
              <input type="hidden" id="rp-target" value="${preselectedNames.join(',')}">
              <div class="form-hint" id="bulk-hint">
                ${preselectedNames.length} Server · <button type="button" class="btn-link" id="rp-target-all">${t('run.addAll')}</button>
              </div>
            </div>
          ` : `
            <div class="form-group">
              <label class="form-label">${t('run.targetGroup')}</label>
              <select class="form-input" id="rp-target" required>
                <option value="all">${t('pb.allServers')}</option>
                <optgroup label="Server">
                  ${state.servers.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}
                </optgroup>
                <option value="localhost">localhost</option>
              </select>
            </div>
          `}

          <div class="form-group">
            <label class="form-label">${t('run.playbook')}</label>
            <select class="form-input" id="rp-file" required>
              ${userPlaybooks.map(p => `<option value="${esc(p.filename)}">${esc(p.description)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('run.extraVars')}</label>
            <textarea class="form-input textarea-code" id="rp-vars" rows="3" placeholder='{"user": "admin", "port": 8080}'></textarea>
            <div class="form-hint">${t('run.extraVarsHint')}</div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="btn-rp-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn-primary" id="btn-rp-submit">
              <i class="fas fa-play"></i> ${t('common.run')}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeModal = () => {
    overlay.remove();
    if (onClose) onClose();
  };

  overlay.querySelector('#btn-rp-close').addEventListener('click', closeModal);
  overlay.querySelector('#btn-rp-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  // ── Bulk mode: chip removal & "add all" ──────────────────
  if (isBulk) {
    let activeNames = [...preselectedNames];

    function refreshChips() {
      const hidden = overlay.querySelector('#rp-target');
      const hint   = overlay.querySelector('#bulk-hint');
      hidden.value = activeNames.join(',');
      if (hint) hint.innerHTML = `${activeNames.length} Server · <button type="button" class="btn-link" id="rp-target-all">${t('run.addAll')}</button>`;
      overlay.querySelector('#rp-target-all')?.addEventListener('click', addAll);
    }

    function addAll() {
      state.servers.forEach(s => {
        if (!activeNames.includes(s.name)) activeNames.push(s.name);
      });
      rebuildChips();
    }

    function rebuildChips() {
      const list = overlay.querySelector('.bulk-target-list');
      if (!list) return;
      list.innerHTML = activeNames.map(n => `
        <span class="bulk-target-chip" data-name="${esc(n)}">
          <span class="status-dot online" style="display:inline-block;"></span>
          ${esc(n)}
          <button type="button" class="chip-remove" data-name="${esc(n)}" title="Entfernen">×</button>
        </span>
      `).join('');
      list.querySelectorAll('.chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          activeNames = activeNames.filter(n => n !== btn.dataset.name);
          rebuildChips();
          refreshChips();
        });
      });
      refreshChips();
    }

    // Initial chip remove listeners
    overlay.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        activeNames = activeNames.filter(n => n !== btn.dataset.name);
        rebuildChips();
      });
    });

    overlay.querySelector('#rp-target-all')?.addEventListener('click', addAll);
  }

  // ── Submit ───────────────────────────────────────────────
  overlay.querySelector('#run-playbook-form').addEventListener('submit', async e => {
    e.preventDefault();
    const target   = overlay.querySelector('#rp-target').value;
    const playbook = overlay.querySelector('#rp-file').value;
    const varsStr  = overlay.querySelector('#rp-vars').value.trim();

    if (!target) {
      showToast(t('run.needTarget'), 'error');
      return;
    }

    let extraVars = {};
    if (varsStr) {
      try { extraVars = JSON.parse(varsStr); }
      catch {
        showToast(t('run.invalidJson'), 'error');
        return;
      }
    }

    const submitBtn = overlay.querySelector('#btn-rp-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner-sm"></span> ${t('run.starting')}`;

    try {
      await api.runPlaybook(playbook, target, extraVars);
      const targetLabel = isBulk ? `${target.split(',').length} Server` : `"${target}"`;
      showToast(t('run.started', { pb: playbook, target: targetLabel }), 'success');
      closeModal();
    } catch (error) {
      showToast(t('common.errorPrefix', { msg: error.message }), 'error');
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i class="fas fa-play"></i> ${t('common.run')}`;
    }
  });
}
