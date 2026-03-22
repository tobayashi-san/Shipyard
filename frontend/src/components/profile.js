import { api } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { navigate } from '../main.js';
import { showToast } from './toast.js';

export async function renderProfile() {
  const content = document.getElementById('main-content');
  const currentLang = getLang();

  let profile = { username: 'admin', email: '' };
  try { profile = await api.getProfile(); } catch {}

  content.innerHTML = `
    <div class="page-content" style="max-width:520px;padding-top:32px;">

      <!-- Avatar header -->
      <div style="display:flex;align-items:center;gap:20px;margin-bottom:32px;">
        <div style="
          width:64px;height:64px;border-radius:50%;
          background:var(--accent);
          display:flex;align-items:center;justify-content:center;
          font-size:26px;color:#fff;flex-shrink:0;">
          <i class="fas fa-user"></i>
        </div>
        <div>
          <div style="font-size:20px;font-weight:600;" id="profile-display-name">${esc(profile.username)}</div>
          <div style="font-size:13px;color:var(--text-muted);" id="profile-display-email">${esc(profile.email) || '<span style="opacity:.5">No email set</span>'}</div>
        </div>
      </div>

      <!-- Account -->
      <div class="settings-group-title"><i class="fas fa-user"></i> Account</div>
      <div class="settings-block" style="margin-bottom:24px;">
        <div class="settings-row">
          <div class="settings-row-label"><span>Username</span></div>
          <div class="settings-row-control">
            <input class="form-input" id="profile-username" value="${esc(profile.username)}" style="max-width:240px;">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"><span>Email</span><small>Optional</small></div>
          <div class="settings-row-control">
            <input class="form-input" id="profile-email" type="email" value="${esc(profile.email)}" placeholder="you@example.com" style="max-width:240px;">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"></div>
          <div class="settings-row-control">
            <button class="btn btn-primary btn-sm" id="profile-save-account"><i class="fas fa-check"></i> Save</button>
          </div>
        </div>
      </div>

      <!-- Security -->
      <div class="settings-group-title"><i class="fas fa-lock"></i> Security</div>
      <div class="settings-block" style="margin-bottom:24px;">

        <!-- Change password -->
        <div class="settings-row">
          <div class="settings-row-label"><span>Password</span></div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" id="profile-pw-toggle"><i class="fas fa-key"></i> Change password</button>
          </div>
        </div>
        <div id="profile-pw-form" style="display:none;border-top:1px solid var(--border);padding:14px 0 6px;display:none;flex-direction:column;gap:8px;">
          <input class="form-input" type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password">
          <input class="form-input" type="password" id="profile-pw-new" placeholder="New password (min 12 chars)" autocomplete="new-password">
          <input class="form-input" type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password">
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" id="profile-pw-save"><i class="fas fa-check"></i> Save</button>
            <button class="btn btn-secondary btn-sm" id="profile-pw-cancel">Cancel</button>
          </div>
        </div>

        <!-- 2FA -->
        <div class="settings-row" id="profile-2fa-row">
          <div class="settings-row-label">
            <span>Two-factor authentication</span>
            <small id="profile-2fa-status">Checking…</small>
          </div>
          <div class="settings-row-control" id="profile-2fa-control"></div>
        </div>
        <div id="totp-setup-panel" style="display:none;border-top:1px solid var(--border);padding:14px 0 6px;flex-direction:column;gap:12px;">
          <p style="margin:0;color:var(--text-muted);font-size:13px;">${t('set.totpScanQR')}</p>
          <img id="totp-qr" style="width:180px;height:180px;border-radius:8px;background:#fff;padding:8px;" alt="QR Code">
          <p style="margin:0;color:var(--text-muted);font-size:12px;">${t('set.totpSecret')} <code id="totp-secret-text" style="font-family:var(--font-mono);word-break:break-all;"></code></p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input class="form-input" type="text" id="totp-confirm-code" inputmode="numeric"
              pattern="[0-9 ]*" maxlength="7" placeholder="______"
              style="font-size:1.2rem;letter-spacing:6px;text-align:center;max-width:130px;">
            <button class="btn btn-primary btn-sm" id="btn-totp-verify"><i class="fas fa-check"></i> ${t('set.totpVerify')}</button>
            <button class="btn btn-secondary btn-sm" id="btn-totp-cancel">Cancel</button>
          </div>
        </div>

      </div>

      <!-- Preferences -->
      <div class="settings-group-title"><i class="fas fa-globe"></i> Language</div>
      <div class="settings-block" style="margin-bottom:32px;">
        <div class="settings-row">
          <div class="settings-row-label"><span>Interface language</span></div>
          <div class="settings-row-control" style="display:flex;gap:6px;">
            <button class="btn btn-sm ${currentLang === 'de' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-de">DE</button>
            <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-en">EN</button>
          </div>
        </div>
      </div>

      <!-- Sign out -->
      <button class="btn btn-danger" id="profile-signout" style="width:100%;">
        <i class="fas fa-right-from-bracket"></i> Sign out
      </button>

    </div>
  `;

  // Save account
  document.getElementById('profile-save-account').addEventListener('click', async () => {
    const username = document.getElementById('profile-username').value.trim();
    const email    = document.getElementById('profile-email').value.trim();
    if (!username) { showToast('Username cannot be empty', 'error'); return; }
    try {
      await api.updateProfile({ username, email });
      document.getElementById('profile-display-name').textContent = username;
      document.getElementById('profile-display-email').innerHTML = email || '<span style="opacity:.5">No email set</span>';
      showToast('Profile saved', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });

  // Password toggle
  const pwForm = document.getElementById('profile-pw-form');
  document.getElementById('profile-pw-toggle').addEventListener('click', () => {
    const open = pwForm.style.display !== 'flex';
    pwForm.style.display = open ? 'flex' : 'none';
    if (open) document.getElementById('profile-pw-current').focus();
  });
  document.getElementById('profile-pw-cancel').addEventListener('click', () => {
    pwForm.style.display = 'none';
  });
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

  // 2FA
  _load2fa();

  // Language
  document.getElementById('profile-lang-de').addEventListener('click', () => { setLang('de'); navigate('profile'); });
  document.getElementById('profile-lang-en').addEventListener('click', () => { setLang('en'); navigate('profile'); });

  // Sign out
  document.getElementById('profile-signout').addEventListener('click', () => { api.setToken(null); location.reload(); });
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function _load2fa() {
  const statusEl  = document.getElementById('profile-2fa-status');
  const controlEl = document.getElementById('profile-2fa-control');
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
      controlEl.innerHTML  = `<button class="btn btn-secondary btn-sm" id="profile-2fa-enable"><i class="fas fa-shield-halved"></i> Enable 2FA</button>`;
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
