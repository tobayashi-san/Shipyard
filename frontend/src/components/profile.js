import { api } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { navigate } from '../main.js';
import { showToast } from './toast.js';

export function renderProfile() {
  const content = document.getElementById('main-content');
  const currentLang = getLang();

  content.innerHTML = `
    <div class="page-header">
      <h2><i class="fas fa-user-circle"></i> Profile</h2>
    </div>
    <div class="page-content" style="max-width:560px;">

      <div class="settings-group-title"><i class="fas fa-user"></i> Account</div>
      <div class="settings-block">
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Username</span>
            <small>Single-user mode</small>
          </div>
          <div class="settings-row-control" style="color:var(--text-muted);font-size:13px;">admin</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Sign out</span>
            <small>Clear session token</small>
          </div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" id="profile-signout">
              <i class="fas fa-right-from-bracket"></i> Sign out
            </button>
          </div>
        </div>
      </div>

      <div class="settings-group-title" style="margin-top:24px;"><i class="fas fa-lock"></i> Security</div>
      <div class="settings-block">
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Password</span>
            <small>Change your login password</small>
          </div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" id="profile-change-pw-btn">
              <i class="fas fa-key"></i> Change password
            </button>
          </div>
        </div>
        <div id="profile-pw-form" style="display:none;padding:12px 0 4px;">
          <div class="form-group" style="margin-bottom:8px;">
            <input class="form-input" type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password">
          </div>
          <div class="form-group" style="margin-bottom:8px;">
            <input class="form-input" type="password" id="profile-pw-new" placeholder="New password (min 12 chars)" autocomplete="new-password">
          </div>
          <div class="form-group" style="margin-bottom:10px;">
            <input class="form-input" type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password">
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" id="profile-pw-save">Save</button>
            <button class="btn btn-secondary btn-sm" id="profile-pw-cancel">Cancel</button>
          </div>
        </div>
        <div class="settings-row" id="profile-2fa-row">
          <div class="settings-row-label">
            <span>Two-factor authentication</span>
            <small id="profile-2fa-status">Checking…</small>
          </div>
          <div class="settings-row-control" id="profile-2fa-control"></div>
        </div>
      </div>

      <div class="settings-group-title" style="margin-top:24px;"><i class="fas fa-globe"></i> Language</div>
      <div class="settings-block">
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Interface language</span>
          </div>
          <div class="settings-row-control" style="display:flex;gap:6px;">
            <button class="btn btn-sm ${currentLang === 'de' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-de">DE</button>
            <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-en">EN</button>
          </div>
        </div>
      </div>

    </div>
  `;

  // Sign out
  document.getElementById('profile-signout').addEventListener('click', () => {
    api.setToken(null);
    location.reload();
  });

  // Change password toggle
  document.getElementById('profile-change-pw-btn').addEventListener('click', () => {
    const form = document.getElementById('profile-pw-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('profile-pw-cancel').addEventListener('click', () => {
    document.getElementById('profile-pw-form').style.display = 'none';
  });
  document.getElementById('profile-pw-save').addEventListener('click', async () => {
    const current = document.getElementById('profile-pw-current').value;
    const next    = document.getElementById('profile-pw-new').value;
    const confirm = document.getElementById('profile-pw-confirm').value;
    if (next.length < 12) { showToast('Password must be at least 12 characters', 'error'); return; }
    if (next !== confirm)  { showToast('Passwords do not match', 'error'); return; }
    try {
      await api.authChangePassword(current, next);
      showToast('Password changed — please sign in again', 'success');
      setTimeout(() => { api.setToken(null); location.reload(); }, 1500);
    } catch (e) { showToast(e.message, 'error'); }
  });

  // 2FA
  _load2fa();

  // Language
  document.getElementById('profile-lang-de').addEventListener('click', () => {
    setLang('de'); navigate('profile');
  });
  document.getElementById('profile-lang-en').addEventListener('click', () => {
    setLang('en'); navigate('profile');
  });
}

async function _load2fa() {
  const statusEl  = document.getElementById('profile-2fa-status');
  const controlEl = document.getElementById('profile-2fa-control');
  try {
    const { enabled } = await api.totpStatus();
    if (enabled) {
      statusEl.textContent  = 'Enabled';
      statusEl.style.color  = 'var(--online)';
      controlEl.innerHTML   = `<button class="btn btn-danger btn-sm" id="profile-2fa-disable"><i class="fas fa-shield-xmark"></i> Disable</button>`;
      document.getElementById('profile-2fa-disable').addEventListener('click', async () => {
        if (!confirm('Disable two-factor authentication?')) return;
        await api.totpDisable();
        showToast('2FA disabled', 'success');
        _load2fa();
      });
    } else {
      statusEl.textContent  = 'Disabled';
      statusEl.style.color  = 'var(--text-muted)';
      controlEl.innerHTML   = `<button class="btn btn-secondary btn-sm" id="profile-2fa-enable"><i class="fas fa-shield-halved"></i> Enable</button>`;
      document.getElementById('profile-2fa-enable').addEventListener('click', () => {
        navigate('settings', { tab: 'security' });
      });
    }
  } catch { statusEl.textContent = ''; }
}
