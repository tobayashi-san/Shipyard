import { api } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { showToast } from './toast.js';
import { state } from '../main.js';

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Small context menu above the profile button ───────────────

let _menu = null;
let _menuBackdrop = null;

function closeMenu() {
  _menu?.remove();
  _menuBackdrop?.remove();
  _menu = null;
  _menuBackdrop = null;
}

export function showProfileMenu() {
  if (_menu) { closeMenu(); return; }

  const trigger = document.getElementById('sidebar-profile-btn');
  const rect = trigger?.getBoundingClientRect();
  const currentLang = getLang();

  _menuBackdrop = document.createElement('div');
  _menuBackdrop.style.cssText = 'position:fixed;inset:0;z-index:1099;';
  _menuBackdrop.addEventListener('click', closeMenu);
  document.body.appendChild(_menuBackdrop);

  _menu = document.createElement('div');
  _menu.style.cssText = `
    position:fixed;
    bottom:${rect ? (window.innerHeight - rect.bottom) : 60}px;
    left:${rect ? rect.right + 8 : 232}px;
    z-index:1100;
    width:220px;
    background:var(--bg-panel);
    border:1px solid var(--border);
    border-radius:var(--radius);
    box-shadow:0 8px 24px rgba(0,0,0,.25);
    overflow:hidden;
  `;

  _menu.innerHTML = `
    <div style="padding:10px 14px 8px;border-bottom:1px solid var(--border);">
      <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${esc(state.user?.username || 'Profile')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${esc(state.user?.email || '')}
        ${state.user?.role === 'admin' ? '<span style="margin-left:4px;font-size:10px;background:var(--accent);color:#fff;padding:1px 5px;border-radius:3px;">admin</span>' : ''}
      </div>
    </div>

    <div style="padding:4px 0;">
      <div class="profile-menu-item" id="pmenu-settings">
        <i class="fas fa-user-pen" style="width:16px;"></i>
        <span>Profile settings</span>
      </div>

      <div class="profile-menu-item" id="pmenu-lang-toggle" style="justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <i class="fas fa-globe" style="width:16px;"></i>
          <span>Language</span>
        </div>
        <div style="display:flex;gap:3px;">
          <button class="btn btn-sm ${currentLang === 'de' ? 'btn-primary' : 'btn-secondary'}" id="pmenu-lang-de"
            style="padding:2px 7px;font-size:11px;" onclick="event.stopPropagation()">DE</button>
          <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-secondary'}" id="pmenu-lang-en"
            style="padding:2px 7px;font-size:11px;" onclick="event.stopPropagation()">EN</button>
        </div>
      </div>
    </div>

    <div style="padding:4px 0;border-top:1px solid var(--border);">
      <div class="profile-menu-item profile-menu-item--danger" id="pmenu-signout">
        <i class="fas fa-right-from-bracket" style="width:16px;"></i>
        <span>Sign out</span>
      </div>
    </div>
  `;

  document.body.appendChild(_menu);
  _menu.addEventListener('click', e => e.stopPropagation());

  document.getElementById('pmenu-settings').addEventListener('click', () => {
    closeMenu();
    showProfileModal();
  });

  document.getElementById('pmenu-lang-de').addEventListener('click', () => {
    setLang('de'); closeMenu(); showProfileMenu();
  });
  document.getElementById('pmenu-lang-en').addEventListener('click', () => {
    setLang('en'); closeMenu(); showProfileMenu();
  });

  document.getElementById('pmenu-signout').addEventListener('click', () => {
    api.setToken(null); location.reload();
  });
}

// ── Full profile settings modal ───────────────────────────────

let _modal = null;
let _modalBackdrop = null;

function closeModal() {
  _modal?.remove();
  _modalBackdrop?.remove();
  _modal = null;
  _modalBackdrop = null;
}

export async function showProfileModal() {
  if (_modal) { closeModal(); return; }

  let profile = { username: state.user?.username || 'admin', email: state.user?.email || '' };
  try { profile = await api.getProfile(); } catch {}

  _modalBackdrop = document.createElement('div');
  _modalBackdrop.style.cssText = 'position:fixed;inset:0;z-index:1199;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;';
  _modalBackdrop.addEventListener('click', closeModal);
  document.body.appendChild(_modalBackdrop);

  _modal = document.createElement('div');
  _modal.style.cssText = 'width:100%;max-width:440px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 8px 32px rgba(0,0,0,.35);overflow:hidden;';
  _modal.addEventListener('click', e => e.stopPropagation());

  _modal.innerHTML = `
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;">
          <i class="fas fa-user"></i>
        </div>
        <div>
          <div style="font-size:14px;font-weight:600;" id="profile-display-name">${esc(profile.username)}</div>
          <div style="font-size:12px;color:var(--text-muted);" id="profile-display-email">${esc(profile.email) || '<span style="opacity:.5">No email set</span>'}</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" id="profile-modal-close" style="padding:4px 10px;"><i class="fas fa-times"></i></button>
    </div>

    <div style="padding:16px 20px;border-bottom:1px solid var(--border);">
      <div class="settings-group-title" style="margin-top:0;"><i class="fas fa-user"></i> Account</div>
      <div class="settings-block" style="margin-bottom:0;">
        <div class="settings-row">
          <div class="settings-row-label"><span>Username</span></div>
          <div class="settings-row-control">
            <input class="form-input" id="profile-username" value="${esc(profile.username)}" style="max-width:200px;">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><span>Email</span><small>Optional</small></div>
          <div class="settings-row-control">
            <input class="form-input" id="profile-email" type="email" value="${esc(profile.email)}" placeholder="you@example.com" style="max-width:200px;">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"></div>
          <div class="settings-row-control">
            <button class="btn btn-primary btn-sm" id="profile-save-account"><i class="fas fa-check"></i> Save</button>
          </div>
        </div>
      </div>
    </div>

    <div style="padding:16px 20px;">
      <div class="settings-group-title" style="margin-top:0;"><i class="fas fa-lock"></i> Security</div>
      <div class="settings-block" style="margin-bottom:0;">
        <div class="settings-row">
          <div class="settings-row-label"><span>Password</span></div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" id="profile-pw-toggle"><i class="fas fa-key"></i> Change</button>
          </div>
        </div>
        <div id="profile-pw-form" style="display:none;flex-direction:column;gap:6px;padding:8px 0 4px;">
          <input class="form-input" type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password">
          <input class="form-input" type="password" id="profile-pw-new" placeholder="New password (min 12 chars)" autocomplete="new-password">
          <input class="form-input" type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password">
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" id="profile-pw-save"><i class="fas fa-check"></i> Save</button>
            <button class="btn btn-secondary btn-sm" id="profile-pw-cancel">Cancel</button>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-row-label">
            <span>Two-factor auth</span>
            <small id="profile-2fa-status">Checking…</small>
          </div>
          <div class="settings-row-control" id="profile-2fa-control"></div>
        </div>
        <div id="totp-setup-panel" style="display:none;flex-direction:column;gap:8px;padding:8px 0 4px;">
          <p style="margin:0;color:var(--text-muted);font-size:13px;">${t('set.totpScanQR')}</p>
          <img id="totp-qr" style="width:150px;height:150px;border-radius:6px;background:#fff;padding:6px;" alt="QR Code">
          <p style="margin:0;color:var(--text-muted);font-size:12px;">${t('set.totpSecret')} <code id="totp-secret-text" style="font-family:var(--font-mono);word-break:break-all;"></code></p>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input class="form-input" type="text" id="totp-confirm-code" inputmode="numeric"
              pattern="[0-9 ]*" maxlength="7" placeholder="______"
              style="font-size:1.1rem;letter-spacing:5px;text-align:center;max-width:120px;">
            <button class="btn btn-primary btn-sm" id="btn-totp-verify"><i class="fas fa-check"></i> ${t('set.totpVerify')}</button>
            <button class="btn btn-secondary btn-sm" id="btn-totp-cancel">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  _modalBackdrop.appendChild(_modal);

  document.getElementById('profile-modal-close').addEventListener('click', closeModal);

  document.getElementById('profile-save-account').addEventListener('click', async () => {
    const username = document.getElementById('profile-username').value.trim();
    const email    = document.getElementById('profile-email').value.trim();
    if (!username) { showToast('Username cannot be empty', 'error'); return; }
    try {
      await api.updateProfile({ username, email });
      document.getElementById('profile-display-name').textContent = username;
      document.getElementById('profile-display-email').innerHTML = email || '<span style="opacity:.5">No email set</span>';
      if (state.user) { state.user.username = username; state.user.email = email; }
      showToast('Profile saved', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });

  const pwForm = document.getElementById('profile-pw-form');
  document.getElementById('profile-pw-toggle').addEventListener('click', () => {
    const open = pwForm.style.display !== 'flex';
    pwForm.style.display = open ? 'flex' : 'none';
    if (open) document.getElementById('profile-pw-current').focus();
  });
  document.getElementById('profile-pw-cancel').addEventListener('click', () => { pwForm.style.display = 'none'; });
  document.getElementById('profile-pw-save').addEventListener('click', async () => {
    const current = document.getElementById('profile-pw-current').value;
    const next    = document.getElementById('profile-pw-new').value;
    const confirm = document.getElementById('profile-pw-confirm').value;
    if (next.length < 12) { showToast('Password must be at least 12 characters', 'error'); return; }
    if (next !== confirm)  { showToast('Passwords do not match', 'error'); return; }
    try {
      await api.authChangePassword(current, next);
      showToast('Password changed — signing out…', 'success');
      setTimeout(() => { api.setToken(null); location.reload(); }, 1500);
    } catch (e) { showToast(e.message, 'error'); }
  });

  _load2fa();
}

async function _load2fa() {
  const statusEl   = document.getElementById('profile-2fa-status');
  const controlEl  = document.getElementById('profile-2fa-control');
  const setupPanel = document.getElementById('totp-setup-panel');
  if (!statusEl) return;
  try {
    const { enabled } = await api.totpStatus();
    if (enabled) {
      statusEl.textContent = 'Enabled';
      statusEl.style.color = 'var(--online)';
      controlEl.innerHTML  = `<button class="btn btn-danger btn-sm" id="profile-2fa-disable"><i class="fas fa-shield-xmark"></i> Disable</button>`;
      document.getElementById('profile-2fa-disable').addEventListener('click', async () => {
        if (!confirm('Disable two-factor authentication?')) return;
        await api.totpDisable();
        showToast('2FA disabled', 'success');
        _load2fa();
      });
    } else {
      statusEl.textContent = 'Disabled';
      statusEl.style.color = 'var(--text-muted)';
      controlEl.innerHTML  = `<button class="btn btn-secondary btn-sm" id="profile-2fa-enable"><i class="fas fa-shield-halved"></i> Enable</button>`;
      document.getElementById('profile-2fa-enable').addEventListener('click', async () => {
        try {
          const { qrDataUrl, secret } = await api.totpSetup();
          document.getElementById('totp-qr').src = qrDataUrl;
          document.getElementById('totp-secret-text').textContent = secret;
          setupPanel.style.display = 'flex';
          document.getElementById('totp-confirm-code').focus();
        } catch (e) { showToast(e.message, 'error'); }
      });
    }
  } catch { if (statusEl) statusEl.textContent = ''; }

  document.getElementById('btn-totp-verify')?.addEventListener('click', async () => {
    const code = document.getElementById('totp-confirm-code').value.replace(/\s/g, '');
    try {
      await api.totpConfirm(code);
      showToast('2FA enabled', 'success');
      setupPanel.style.display = 'none';
      _load2fa();
    } catch (e) { showToast(e.message || 'Invalid code', 'error'); }
  });
  document.getElementById('btn-totp-cancel')?.addEventListener('click', () => {
    setupPanel.style.display = 'none';
  });
}
