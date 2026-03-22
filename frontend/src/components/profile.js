import { api } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { showToast } from './toast.js';

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

let _popover = null;
let _backdrop = null;

function closePopover() {
  _popover?.remove();
  _backdrop?.remove();
  _popover = null;
  _backdrop = null;
}

export async function showProfileModal() {
  if (_popover) { closePopover(); return; }

  const trigger = document.getElementById('sidebar-profile-btn');
  const rect = trigger?.getBoundingClientRect();

  const currentLang = getLang();
  let profile = { username: 'admin', email: '' };
  try { profile = await api.getProfile(); } catch {}

  // Backdrop
  _backdrop = document.createElement('div');
  _backdrop.style.cssText = 'position:fixed;inset:0;z-index:1099;';
  _backdrop.addEventListener('click', closePopover);
  document.body.appendChild(_backdrop);

  // Popover
  _popover = document.createElement('div');
  _popover.style.cssText = `
    position:fixed;
    bottom:${rect ? (window.innerHeight - rect.top + 8) : 60}px;
    left:${rect ? rect.right + 8 : 232}px;
    z-index:1100;
    width:320px;
    background:var(--bg-panel);
    border:1px solid var(--border);
    border-radius:var(--radius);
    box-shadow:0 8px 32px rgba(0,0,0,.35);
    overflow:hidden;
  `;

  _popover.innerHTML = `
    <div style="padding:16px 16px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;">
        <i class="fas fa-user"></i>
      </div>
      <div style="min-width:0;">
        <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="profile-display-name">${esc(profile.username)}</div>
        <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="profile-display-email">${esc(profile.email) || '<span style="opacity:.5">No email set</span>'}</div>
      </div>
    </div>

    <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Account</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input class="form-input" id="profile-username" value="${esc(profile.username)}" placeholder="Username" style="flex:1;font-size:13px;">
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input class="form-input" id="profile-email" type="email" value="${esc(profile.email)}" placeholder="Email (optional)" style="flex:1;font-size:13px;">
      </div>
      <button class="btn btn-primary btn-sm" id="profile-save-account" style="align-self:flex-start;"><i class="fas fa-check"></i> Save</button>
    </div>

    <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:6px;">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Security</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span style="font-size:13px;">Password</span>
        <button class="btn btn-secondary btn-sm" id="profile-pw-toggle"><i class="fas fa-key"></i> Change</button>
      </div>
      <div id="profile-pw-form" style="display:none;flex-direction:column;gap:6px;padding-top:6px;">
        <input class="form-input" type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password" style="font-size:13px;">
        <input class="form-input" type="password" id="profile-pw-new" placeholder="New password (min 12 chars)" autocomplete="new-password" style="font-size:13px;">
        <input class="form-input" type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password" style="font-size:13px;">
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary btn-sm" id="profile-pw-save"><i class="fas fa-check"></i> Save</button>
          <button class="btn btn-secondary btn-sm" id="profile-pw-cancel">Cancel</button>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <span style="font-size:13px;">Two-factor auth</span>
          <span style="font-size:11px;color:var(--text-muted);margin-left:6px;" id="profile-2fa-status">Checking…</span>
        </div>
        <div id="profile-2fa-control"></div>
      </div>
      <div id="totp-setup-panel" style="display:none;flex-direction:column;gap:8px;padding-top:6px;">
        <p style="margin:0;color:var(--text-muted);font-size:12px;">${t('set.totpScanQR')}</p>
        <img id="totp-qr" style="width:140px;height:140px;border-radius:6px;background:#fff;padding:6px;" alt="QR Code">
        <p style="margin:0;color:var(--text-muted);font-size:11px;">${t('set.totpSecret')} <code id="totp-secret-text" style="font-family:var(--font-mono);word-break:break-all;"></code></p>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <input class="form-input" type="text" id="totp-confirm-code" inputmode="numeric"
            pattern="[0-9 ]*" maxlength="7" placeholder="______"
            style="font-size:1.1rem;letter-spacing:5px;text-align:center;max-width:110px;">
          <button class="btn btn-primary btn-sm" id="btn-totp-verify"><i class="fas fa-check"></i> ${t('set.totpVerify')}</button>
          <button class="btn btn-secondary btn-sm" id="btn-totp-cancel">Cancel</button>
        </div>
      </div>
    </div>

    <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <span style="font-size:13px;">Language</span>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-sm ${currentLang === 'de' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-de">DE</button>
        <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-secondary'}" id="profile-lang-en">EN</button>
      </div>
    </div>

    <div style="padding:10px 16px;">
      <button class="btn btn-danger btn-sm" id="profile-signout" style="width:100%;">
        <i class="fas fa-right-from-bracket"></i> Sign out
      </button>
    </div>
  `;

  document.body.appendChild(_popover);

  // Prevent popover clicks from hitting the backdrop
  _popover.addEventListener('click', e => e.stopPropagation());

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

  // Language
  document.getElementById('profile-lang-de').addEventListener('click', () => { setLang('de'); closePopover(); showProfileModal(); });
  document.getElementById('profile-lang-en').addEventListener('click', () => { setLang('en'); closePopover(); showProfileModal(); });

  // Sign out
  document.getElementById('profile-signout').addEventListener('click', () => { api.setToken(null); location.reload(); });

  // 2FA
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
