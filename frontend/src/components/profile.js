import { api } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { showToast } from './toast.js';
import { state } from '../main.js';

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Small context menu – appears directly above the profile button ─────────

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
  const currentTheme = localStorage.getItem('theme') || 'auto';
  const currentTimeFormat = localStorage.getItem('timeFormat') || '24h';
  
  const ctnStyle = 'width: 114px; background: var(--bg-row-alt); padding: 3px; border-radius: 6px; display: flex; gap: 2px; border: 1px solid var(--border);';
  const btnStyle = 'flex: 1; border: none; background: transparent; color: var(--text-muted); font-size: 11px; padding: 4px 0; border-radius: 4px; cursor: pointer; transition: all 150ms; font-weight: 500;';
  const actStyle = 'background: var(--bg-panel); color: var(--text-primary); box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);';

  _menuBackdrop = document.createElement('div');
  _menuBackdrop.style.cssText = 'position:fixed;inset:0;z-index:3099;';
  _menuBackdrop.addEventListener('click', closeMenu);
  document.body.appendChild(_menuBackdrop);

  _menu = document.createElement('div');
  _menu.style.cssText = `
    position: fixed;
    bottom: ${rect ? window.innerHeight - rect.top + 6 : 70}px;
    left: ${rect ? rect.left : 0}px;
    width: 280px;
    z-index: 3100;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 -4px 20px rgba(0,0,0,.18);
    overflow: hidden;
  `;

  const email = state.user?.email;
  const isAdmin = state.user?.role === 'admin';

  _menu.innerHTML = `
    <div style="padding:12px 16px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;">
      <div style="width:34px;height:34px;border-radius:50%;background:var(--accent);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;">
        <i class="fas fa-user"></i>
      </div>
      <div style="min-width:0;">
        <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(state.user?.username || 'Profile')}
        </div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${email ? esc(email) : isAdmin ? '<span style="opacity:.5">No email set</span>' : ''}
          ${isAdmin ? '<span style="margin-left:4px;font-size:9px;background:var(--accent);color:#fff;padding:1px 6px;border-radius:3px;vertical-align:middle;">admin</span>' : ''}
        </div>
      </div>
    </div>

    <div style="padding:4px 0;">
      <div class="profile-menu-item" id="pmenu-settings">
        <i class="fas fa-user-pen" style="width:16px;opacity:.7;"></i>
        <span>Profile settings</span>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);white-space:nowrap;">
          <i class="fas fa-globe" style="width:16px;opacity:.7;"></i>
          <span>Language</span>
        </div>
        <div style="${ctnStyle}">
          <button style="${btnStyle} ${currentLang === 'de' ? actStyle : ''}" id="pmenu-lang-de">DE</button>
          <button style="${btnStyle} ${currentLang === 'en' ? actStyle : ''}" id="pmenu-lang-en">EN</button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 16px 8px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);white-space:nowrap;">
          <i class="fas fa-moon" style="width:16px;opacity:.7;"></i>
          <span>Theme</span>
        </div>
        <div style="${ctnStyle}" id="pmenu-theme-toggles">
          <button style="${btnStyle} ${currentTheme === 'light' ? actStyle : ''}" data-theme="light" title="Light"><i class="fas fa-sun"></i></button>
          <button style="${btnStyle} ${currentTheme === 'dark' ? actStyle : ''}" data-theme="dark" title="Dark"><i class="fas fa-moon"></i></button>
          <button style="${btnStyle} ${currentTheme === 'auto' ? actStyle : ''}" data-theme="auto" title="Auto">Auto</button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 16px 8px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);white-space:nowrap;">
          <i class="fas fa-clock" style="width:16px;opacity:.7;"></i>
          <span>Time Format</span>
        </div>
        <div style="${ctnStyle}" id="pmenu-time-toggles">
          <button style="${btnStyle} ${currentTimeFormat === '24h' ? actStyle : ''}" data-time="24h">24h</button>
          <button style="${btnStyle} ${currentTimeFormat === '12h' ? actStyle : ''}" data-time="12h">12h</button>
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

  document.getElementById('pmenu-settings').addEventListener('click', () => { closeMenu(); showProfileModal(); });
  document.getElementById('pmenu-lang-de').addEventListener('click', e => { e.stopPropagation(); setLang('de'); closeMenu(); showProfileMenu(); });
  document.getElementById('pmenu-lang-en').addEventListener('click', e => { e.stopPropagation(); setLang('en'); closeMenu(); showProfileMenu(); });
  
  document.querySelectorAll('#pmenu-theme-toggles button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      localStorage.setItem('theme', btn.dataset.theme);
      document.documentElement.dataset.theme = btn.dataset.theme;
      closeMenu(); showProfileMenu();
    });
  });

  document.querySelectorAll('#pmenu-time-toggles button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      localStorage.setItem('timeFormat', btn.dataset.time);
      closeMenu(); location.reload();
    });
  });
  document.getElementById('pmenu-signout').addEventListener('click', () => { api.setToken(null); location.reload(); });
}

// ── Profile settings modal ─────────────────────────────────────────────────

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

  let profile = { username: state.user?.username || 'admin', email: state.user?.email || '', role: state.user?.role || 'user' };
  try { profile = await api.getProfile(); } catch {}

  _modalBackdrop = document.createElement('div');
  _modalBackdrop.style.cssText = 'position:fixed;inset:0;z-index:3199;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
  _modalBackdrop.addEventListener('click', closeModal);
  document.body.appendChild(_modalBackdrop);

  _modal = document.createElement('div');
  _modal.style.cssText = 'width:100%;max-width:460px;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 16px 48px rgba(0,0,0,.35);overflow:hidden;';
  _modal.addEventListener('click', e => e.stopPropagation());

  _modal.innerHTML = `
    <!-- Header -->
    <div style="padding:20px 24px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg-panel-alt);">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:48px;height:48px;border-radius:50%;background:var(--accent);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;">
          <i class="fas fa-user"></i>
        </div>
        <div>
          <div style="font-size:16px;font-weight:700;line-height:1.2;" id="profile-display-name">${esc(profile.username)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;" id="profile-display-email">${esc(profile.email) || '<span style="opacity:.5">No email set</span>'}</div>
          <div style="margin-top:4px;">
            <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:4px;
              ${profile.role === 'admin' ? 'background:var(--accent);color:#fff;' : 'background:var(--bg-row-alt);color:var(--text-muted);border:1px solid var(--border);'}">
              ${profile.role}
            </span>
          </div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" id="profile-modal-close" style="padding:6px 10px;">
        <i class="fas fa-times"></i>
      </button>
    </div>

    <!-- Body -->
    <div style="max-height:70vh;overflow-y:auto;">

      <!-- Account -->
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:14px;">
          Account
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <label style="font-size:13px;color:var(--text-secondary);width:80px;flex-shrink:0;">Username</label>
            <input class="form-input" id="profile-username" value="${esc(profile.username)}" style="flex:1;">
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <label style="font-size:13px;color:var(--text-secondary);width:80px;flex-shrink:0;">Email</label>
            <input class="form-input" id="profile-email" type="email" value="${esc(profile.email)}" placeholder="you@example.com" style="flex:1;">
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-primary btn-sm" id="profile-save-account">
              <i class="fas fa-check"></i> Save changes
            </button>
          </div>
        </div>
      </div>

      <!-- Password -->
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0;" id="pw-row">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:2px;">Password</div>
            <div style="font-size:12px;color:var(--text-muted);">••••••••••••</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="profile-pw-toggle">
            <i class="fas fa-key"></i> Change
          </button>
        </div>
        <div id="profile-pw-form" style="display:none;flex-direction:column;gap:10px;margin-top:14px;">
          <input class="form-input" type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password">
          <input class="form-input" type="password" id="profile-pw-new" placeholder="New password (min 12 characters)" autocomplete="new-password">
          <input class="form-input" type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password">
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" id="profile-pw-cancel">Cancel</button>
            <button class="btn btn-primary btn-sm" id="profile-pw-save"><i class="fas fa-check"></i> Update password</button>
          </div>
        </div>
      </div>

      <!-- 2FA -->
      <div style="padding:20px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:2px;">Two-factor authentication</div>
            <div style="font-size:12px;" id="profile-2fa-status">Checking…</div>
          </div>
          <div id="profile-2fa-control"></div>
        </div>
        <div id="totp-setup-panel" style="display:none;flex-direction:column;gap:10px;margin-top:16px;padding:16px;background:var(--bg-row-alt);border-radius:var(--radius-sm);border:1px solid var(--border);">
          <p style="margin:0;color:var(--text-muted);font-size:13px;">${t('set.totpScanQR')}</p>
          <img id="totp-qr" style="width:160px;height:160px;border-radius:8px;background:#fff;padding:8px;border:1px solid var(--border);" alt="QR Code">
          <p style="margin:0;color:var(--text-muted);font-size:12px;">${t('set.totpSecret')}<br><code id="totp-secret-text" style="font-family:var(--font-mono);word-break:break-all;font-size:11px;"></code></p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input class="form-input" type="text" id="totp-confirm-code" inputmode="numeric"
              pattern="[0-9 ]*" maxlength="7" placeholder="______"
              style="font-size:1.4rem;letter-spacing:8px;text-align:center;width:140px;">
            <button class="btn btn-primary btn-sm" id="btn-totp-verify"><i class="fas fa-check"></i> ${t('set.totpVerify')}</button>
            <button class="btn btn-secondary btn-sm" id="btn-totp-cancel">Cancel</button>
          </div>
        </div>
      </div>

    </div>
  `;

  _modalBackdrop.appendChild(_modal);

  document.getElementById('profile-modal-close').addEventListener('click', closeModal);

  // Save account
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

  // Password
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
      statusEl.innerHTML = '<span style="color:var(--online);"><i class="fas fa-shield-halved" style="margin-right:4px;"></i>Enabled</span>';
      controlEl.innerHTML = `<button class="btn btn-danger btn-sm" id="profile-2fa-disable"><i class="fas fa-shield-xmark"></i> Disable</button>`;
      document.getElementById('profile-2fa-disable').addEventListener('click', () => {
        const panel = document.getElementById('totp-setup-panel');
        panel.style.display = 'flex';
        panel.innerHTML = `
          <p style="margin:0;font-size:13px;color:var(--text-secondary);">Enter your current password to disable two-factor authentication.</p>
          <input class="form-input" type="password" id="totp-disable-pw" placeholder="Current password" autocomplete="current-password">
          <div style="display:flex;gap:8px;">
            <button class="btn btn-danger btn-sm" id="totp-disable-confirm"><i class="fas fa-shield-xmark"></i> Disable 2FA</button>
            <button class="btn btn-secondary btn-sm" id="totp-disable-cancel">Cancel</button>
          </div>
          <p class="login-error hidden" id="totp-disable-err" style="margin:0;"></p>`;
        document.getElementById('totp-disable-pw').focus();
        document.getElementById('totp-disable-cancel').addEventListener('click', () => {
          panel.style.display = 'none';
        });
        document.getElementById('totp-disable-confirm').addEventListener('click', async () => {
          const btn = document.getElementById('totp-disable-confirm');
          const errEl = document.getElementById('totp-disable-err');
          const pw = document.getElementById('totp-disable-pw').value;
          if (!pw) { errEl.textContent = 'Password required'; errEl.classList.remove('hidden'); return; }
          btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span>';
          try {
            await api.totpDisable(pw);
            showToast('2FA disabled', 'success');
            panel.style.display = 'none';
            _load2fa();
          } catch (e) {
            errEl.textContent = e.message || 'Incorrect password';
            errEl.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-shield-xmark"></i> Disable 2FA';
          }
        });
      });
    } else {
      statusEl.innerHTML = '<span style="color:var(--text-muted);">Not enabled</span>';
      controlEl.innerHTML = `<button class="btn btn-secondary btn-sm" id="profile-2fa-enable"><i class="fas fa-shield-halved"></i> Enable</button>`;
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
