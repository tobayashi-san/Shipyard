import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

let toastContainer = null;

function ensureContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

export function showToast(message, type = 'info', duration = 4000) {
  ensureContainer();

  const icons = {
    success: '<i class="fas fa-check"></i>',
    error:   '<i class="fas fa-times"></i>',
    warning: '<i class="fas fa-exclamation-triangle"></i>',
    info:    '<i class="fas fa-info-circle"></i>',
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconSpan = document.createElement('span');
  iconSpan.innerHTML = icons[type] || icons.info;
  iconSpan.style.flexShrink = '0';

  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  msgSpan.style.color = 'var(--text-primary)';
  msgSpan.style.fontWeight = '400';

  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 250ms cubic-bezier(0.16, 1, 0.3, 1)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

/**
 * Shows a styled confirmation dialog. Returns a Promise<boolean>.
 * Usage: if (!await showConfirm('Wirklich löschen?', { danger: true })) return;
 */
export function showConfirm(message, { title = '', confirmText = '', danger = false, html = false } = {}) {
  const resolvedTitle = title || t('common.confirmation');
  const resolvedConfirm = confirmText || t('common.confirm');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h3 class="modal-title">${esc(resolvedTitle)}</h3>
        </div>
        <div class="modal-body">
          <p style="margin:0;font-size:14px;line-height:1.6;" id="sc-msg"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="sc-cancel">${t('common.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="sc-ok">${resolvedConfirm}</button>
        </div>
      </div>
    `;
    const msgEl = overlay.querySelector('#sc-msg');
    if (html) { msgEl.innerHTML = message; } else { msgEl.textContent = message; }
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };

    overlay.querySelector('#sc-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#sc-ok').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

    const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); } };
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Shows a styled input dialog. Returns a Promise<string|null>.
 * Usage: const name = await showPrompt('Name:', { placeholder: 'Mein Ordner' });
 */
export function showPrompt(label, { title = '', confirmText = '', defaultValue = '', placeholder = '' } = {}) {
  const resolvedTitle = title || t('common.input');
  const resolvedConfirm = confirmText || t('common.ok');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-header">
          <h3 class="modal-title">${esc(resolvedTitle)}</h3>
        </div>
        <div class="modal-body">
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.02em;margin-bottom:6px;">${esc(label)}</label>
          <input class="form-input" id="sp-input" type="text" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" style="width:100%;">
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="sp-cancel">${t('common.cancel')}</button>
          <button class="btn btn-primary" id="sp-ok">${resolvedConfirm}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#sp-input');
    const cleanup = (value) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(value); };

    input.focus();
    input.select();

    overlay.querySelector('#sp-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#sp-ok').addEventListener('click', () => cleanup(input.value.trim() || null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') cleanup(input.value.trim() || null); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });

    const onKey = (e) => { if (e.key === 'Escape') cleanup(null); };
    document.addEventListener('keydown', onKey);
  });
}
