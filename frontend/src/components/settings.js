import { api } from '../api.js';
import { state } from '../main.js';
import { showToast } from './toast.js';
import { renderLogin } from './login.js';
import { t } from '../i18n.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// White-label config (stored in DB via API)
// ============================================================
export function getWhiteLabel() {
  return state.whiteLabel || {};
}

async function saveWhiteLabel(obj) {
  const updated = { ...state.whiteLabel, ...obj };
  // Remove empty strings so the DB stays clean
  for (const key of Object.keys(updated)) {
    if (updated[key] === '' || updated[key] === undefined) delete updated[key];
  }
  await api.saveSettings(updated);
  state.whiteLabel = updated;
  applyWhiteLabel();
}

export function applyWhiteLabel() {
  const wl = getWhiteLabel();
  if (wl.appName) {
    document.title = wl.appName;
    document.querySelectorAll('.sidebar-logo-text h1').forEach(el => el.textContent = wl.appName);
  }
  if (wl.appTagline) {
    document.querySelectorAll('.sidebar-logo-text span').forEach(el => el.textContent = wl.appTagline);
  }
  if (wl.accentColor) {
    document.documentElement.style.setProperty('--accent', wl.accentColor);
    document.documentElement.style.setProperty('--accent-hover', shadeColor(wl.accentColor, -15));
    document.documentElement.style.setProperty('--accent-light', hexToLight(wl.accentColor));
  }
  document.documentElement.dataset.theme = wl.theme || 'auto';
}

function shadeColor(hex, pct) {
  const n = parseInt(hex.replace('#', ''), 16);
  const amt = Math.round(2.55 * pct);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0x00FF) + amt));
  const b = Math.max(0, Math.min(255, (n & 0x0000FF) + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function hexToLight(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xFF;
  const g = (n >> 8) & 0xFF;
  const b = n & 0xFF;
  return `rgba(${r},${g},${b},0.12)`;
}

// ============================================================
// Render
// ============================================================
export async function renderSettings() {
  const container = document.querySelector('.main-content');
  if (!container) return;

  const wl = getWhiteLabel();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h2>${t('set.title')}</h2>
        <p>${t('set.subtitle')}</p>
      </div>
    </div>

    <div class="tab-bar">
      <button class="tab-btn active" data-tab="appearance">
        <i class="fas fa-paint-brush"></i> ${t('set.tabAppearance')}
      </button>
      <button class="tab-btn" data-tab="ssh">
        <i class="fas fa-key"></i> ${t('set.tabSsh')}
      </button>
      <button class="tab-btn" data-tab="system">
        <i class="fas fa-wrench"></i> ${t('set.tabSystem')}
      </button>
      <button class="tab-btn" data-tab="security">
        <i class="fas fa-shield-alt"></i> ${t('set.tabSecurity')}
      </button>
      <button class="tab-btn" data-tab="danger">
        <i class="fas fa-triangle-exclamation"></i> ${t('set.tabDanger')}
      </button>
    </div>

    <div class="page-content" style="overflow-y:auto;flex:1;">

      <!-- Tab: Appearance -->
      <div class="tab-panel active" id="tab-appearance">
        <div class="settings-group-title">${t('set.tabAppearance')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.theme')}</span>
              <small>${t('set.themeHint')}</small>
            </div>
            <div class="settings-row-control">
              <div class="theme-toggle" id="theme-toggle">
                <button class="theme-btn ${(wl.theme || 'auto') === 'light' ? 'active' : ''}" data-value="light">
                  <i class="fas fa-sun"></i> ${t('set.light')}
                </button>
                <button class="theme-btn ${(wl.theme || 'auto') === 'dark' ? 'active' : ''}" data-value="dark">
                  <i class="fas fa-moon"></i> ${t('set.dark')}
                </button>
                <button class="theme-btn ${(wl.theme || 'auto') === 'auto' ? 'active' : ''}" data-value="auto">
                  <i class="fas fa-circle-half-stroke"></i> ${t('set.auto')}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-group-title">${t('set.whiteLabel')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.appName')}</span>
              <small>${t('set.appNameHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="text" id="wl-name" placeholder="Shipyard" value="${wl.appName || ''}" style="max-width:320px;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.tagline')}</span>
              <small>${t('set.taglineHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="text" id="wl-tagline" placeholder="Infrastructure" value="${wl.appTagline || ''}" style="max-width:320px;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.accentColor')}</span>
              <small>${t('set.accentColorHint')}</small>
            </div>
            <div class="settings-row-control">
              <div style="display:flex;gap:8px;align-items:center;">
                <input class="form-input" type="color" id="wl-color" value="${wl.accentColor || '#3b82f6'}" style="width:48px;height:36px;flex-shrink:0;cursor:pointer;">
                <input class="form-input" type="text" id="wl-color-hex" value="${wl.accentColor || '#3b82f6'}" placeholder="#3b82f6" style="font-family:var(--font-mono);max-width:120px;">
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control" style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" id="btn-save-wl">
                <i class="fas fa-save"></i> ${t('set.saveApply')}
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-reset-wl">${t('common.reset')}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: SSH -->
      <div class="tab-panel" id="tab-ssh">
        <div class="settings-group-title">${t('set.sshTitle')}</div>
        <div class="settings-block" id="ssh-key-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>

        <div class="settings-group-title">${t('set.sshDistribute')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.sshTarget')}</span>
              <small>${t('set.sshTargetHint')}</small>
            </div>
            <div class="settings-row-control">
              <div style="display:grid;grid-template-columns:1fr 90px 70px;gap:8px;max-width:420px;width:100%;">
                <input class="form-input" type="text" id="deploy-ip" placeholder="192.168.1.100">
                <input class="form-input" type="text" id="deploy-user" placeholder="root" value="root">
                <input class="form-input" type="number" id="deploy-port" placeholder="22" value="22">
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.sshPassword')}</span>
              <small>${t('set.sshPasswordHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="deploy-password" placeholder="${t('set.serverPasswordPlaceholder')}" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control">
              <button class="btn btn-primary btn-sm" id="btn-deploy-key">
                <i class="fas fa-key"></i> ${t('set.sshDistributeBtn')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: System -->
      <div class="tab-panel" id="tab-system">
        <div class="settings-group-title">${t('set.ansible')}</div>
        <div class="settings-block" id="ansible-status-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>

        <div class="settings-group-title">${t('set.polling')}</div>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px 0;padding:0 4px;">${t('set.pollingHint')}</p>
        <div class="settings-block" id="polling-config-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

      <!-- Tab: Security -->
      <div class="tab-panel" id="tab-security">
        <div class="settings-group-title">${t('set.pwChange')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.pwCurrent')}</span>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="sec-current" placeholder="${t('set.pwCurrent')}" style="max-width:320px;" autocomplete="current-password">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.pwNew')}</span>
              <small>${t('set.pwMinChars')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="sec-new" placeholder="${t('set.pwNew')}" style="max-width:320px;" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.pwConfirm')}</span>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="sec-new2" placeholder="${t('login.repeatPassword')}" style="max-width:320px;" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control">
              <button class="btn btn-primary btn-sm" id="btn-change-password">
                <i class="fas fa-lock"></i> ${t('set.pwChangeBtn')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-group-title">${t('set.totp')}</div>
        <div class="settings-block" id="totp-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span id="totp-status-label">${t('set.totpDisabled')}</span>
              <small>${t('set.totpHint')}</small>
            </div>
            <div class="settings-row-control" id="totp-controls">
              <button class="btn btn-primary btn-sm" id="btn-totp-enable">
                <i class="fas fa-shield-alt"></i> ${t('set.totpEnable')}
              </button>
            </div>
          </div>
          <!-- QR setup panel (hidden until setup clicked) -->
          <div id="totp-setup-panel" style="display:none;padding:16px 20px 16px;flex-direction:column;gap:12px;border-top:1px solid var(--border);">
            <p style="margin:0;color:var(--text-muted);font-size:13px;">${t('set.totpScanQR')}</p>
            <img id="totp-qr" style="width:200px;height:200px;border-radius:8px;background:#fff;padding:8px;" alt="QR Code">
            <p style="margin:0;color:var(--text-muted);font-size:12px;">${t('set.totpSecret')} <code id="totp-secret-text" style="font-family:var(--font-mono);word-break:break-all;"></code></p>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <label style="font-size:13px;color:var(--text-muted);white-space:nowrap;">${t('set.totpEnterCode')}</label>
              <input class="form-input" type="text" id="totp-confirm-code" inputmode="numeric"
                pattern="[0-9 ]*" maxlength="7" placeholder="______"
                style="font-size:1.2rem;letter-spacing:6px;text-align:center;max-width:140px;">
              <button class="btn btn-primary btn-sm" id="btn-totp-verify">
                <i class="fas fa-check"></i> ${t('set.totpVerify')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-group-title">${t('set.session')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.logout')}</span>
              <small>${t('set.logoutHint')}</small>
            </div>
            <div class="settings-row-control">
              <button class="btn btn-danger btn-sm" id="btn-logout">
                <i class="fas fa-sign-out-alt"></i> ${t('set.logout')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Danger Zone -->
      <div class="tab-panel" id="tab-danger">
        <div class="settings-group-title" style="color:var(--offline);">
          <i class="fas fa-triangle-exclamation"></i> ${t('set.danger')}
        </div>
        <p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;">
          ${t('set.dangerHint')}
        </p>

        <div class="danger-zone-block">

          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.delServers')}</span>
              <small>${t('set.delServersHint')}</small>
            </div>
            <div class="settings-row-control" id="dz-ctrl-servers">
              <button class="btn btn-danger btn-sm" data-dz="servers">
                <i class="fas fa-trash"></i> ${t('common.delete')}
              </button>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.delSchedules')}</span>
              <small>${t('set.delSchedulesHint')}</small>
            </div>
            <div class="settings-row-control" id="dz-ctrl-schedules">
              <button class="btn btn-danger btn-sm" data-dz="schedules">
                <i class="fas fa-trash"></i> ${t('common.delete')}
              </button>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.delPlaybooks')}</span>
              <small>${t('set.delPlaybooksHint')}</small>
            </div>
            <div class="settings-row-control" id="dz-ctrl-playbooks">
              <button class="btn btn-danger btn-sm" data-dz="playbooks">
                <i class="fas fa-trash"></i> ${t('common.delete')}
              </button>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.resetAuth')}</span>
              <small>${t('set.resetAuthHint')}</small>
            </div>
            <div class="settings-row-control" id="dz-ctrl-auth">
              <button class="btn btn-danger btn-sm" data-dz="auth">
                <i class="fas fa-lock-open"></i> ${t('common.reset')}
              </button>
            </div>
          </div>

          <div class="settings-row" style="border-bottom:none;">
            <div class="settings-row-label">
              <span style="color:var(--offline);font-weight:600;">${t('set.resetAll')}</span>
              <small>${t('set.resetAllHint')}</small>
            </div>
            <div class="settings-row-control" id="dz-ctrl-all">
              <button class="btn btn-danger btn-sm" data-dz="all">
                <i class="fas fa-radiation"></i> ${t('common.delete')}
              </button>
            </div>
          </div>

        </div>
      </div>

    </div>
  `;

  setupTabSwitching();
  loadSSHKey();
  loadAnsibleStatus();
  loadPollingConfig();
  setupSettingsEvents(wl);
  setupSecurityEvents().catch(() => {});
  setupDangerZone();
}

function setupTabSwitching() {
  document.querySelectorAll('.tab-bar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
    });
  });
}

// ============================================================
// White Label Events
// ============================================================
function setupSettingsEvents(wl) {
  // Theme toggle
  document.querySelectorAll('#theme-toggle .theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.value;
      document.querySelectorAll('#theme-toggle .theme-btn').forEach(b => b.classList.toggle('active', b === btn));
      try {
        await saveWhiteLabel({ theme });
      } catch {
        showToast(t('set.toastErrorSave'), 'error');
      }
    });
  });

  // Sync color picker <-> hex input
  const picker = document.getElementById('wl-color');
  const hexInput = document.getElementById('wl-color-hex');
  picker?.addEventListener('input', () => { if (hexInput) hexInput.value = picker.value; });
  hexInput?.addEventListener('input', () => {
    const val = hexInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val) && picker) picker.value = val;
  });

  document.getElementById('btn-save-wl')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-wl');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.save')}…`;
    try {
      await saveWhiteLabel({
        appName:     document.getElementById('wl-name').value.trim() || undefined,
        appTagline:  document.getElementById('wl-tagline').value.trim() || undefined,
        accentColor: document.getElementById('wl-color').value,
      });
      showToast(t('set.toastSaved'), 'success');
    } catch {
      showToast(t('set.toastErrorSave'), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-save"></i> ${t('set.saveApply')}`;
    }
  });

  document.getElementById('btn-reset-wl')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-reset-wl');
    btn.disabled = true;
    try {
      await api.saveSettings({ appName: '', appTagline: '', accentColor: '', theme: 'auto' });
      state.whiteLabel = { theme: 'auto' };
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent-hover');
      document.documentElement.style.removeProperty('--accent-light');
      document.documentElement.dataset.theme = 'auto';
      document.title = 'Shipyard';
      document.querySelectorAll('.sidebar-logo-text h1').forEach(el => el.textContent = 'Shipyard');
      document.querySelectorAll('.sidebar-logo-text span').forEach(el => el.textContent = 'Infrastructure');
      document.getElementById('wl-name').value = '';
      document.getElementById('wl-tagline').value = '';
      document.getElementById('wl-color').value = '#3b82f6';
      document.getElementById('wl-color-hex').value = '#3b82f6';
      document.querySelectorAll('#theme-toggle .theme-btn').forEach(b => b.classList.toggle('active', b.dataset.value === 'auto'));
      showToast(t('set.toastReset'), 'success');
    } catch {
      showToast(t('set.toastErrorReset'), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-deploy-key')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-deploy-key');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('set.deploying')}`;
    try {
      await api.deploySSHKey({
        ip_address: document.getElementById('deploy-ip').value,
        ssh_user: document.getElementById('deploy-user').value || 'root',
        ssh_port: parseInt(document.getElementById('deploy-port').value) || 22,
        password: document.getElementById('deploy-password').value,
      });
      showToast(t('set.sshDistributed'), 'success');
      document.getElementById('deploy-password').value = '';
    } catch (error) {
      showToast(t('common.errorPrefix', { msg: error.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-key"></i> ${t('set.sshDistributeBtn')}`;
    }
  });
}

// ============================================================
// Security Tab
// ============================================================
async function setupSecurityEvents() {
  const status = await api.getAuthStatus();

  // If no password is set yet, hide the "current password" field
  const currentRow = document.getElementById('sec-current')?.closest('.settings-row');
  if (!status.configured && currentRow) {
    currentRow.style.display = 'none';
  }

  document.getElementById('btn-change-password')?.addEventListener('click', async () => {
    const current = document.getElementById('sec-current').value;
    const next    = document.getElementById('sec-new').value;
    const next2   = document.getElementById('sec-new2').value;

    if (status.configured && !current) { showToast(t('set.pwEnterCurrent'), 'error'); return; }
    if (!next) { showToast(t('set.pwEnterNew'), 'error'); return; }
    if (next.length < 8)   { showToast(t('set.pwTooShort'), 'error'); return; }
    if (next !== next2)    { showToast(t('set.pwMismatch'), 'error'); return; }

    const btn = document.getElementById('btn-change-password');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('set.saving')}`;
    try {
      if (status.configured) {
        await api.authChangePassword(current, next);
      } else {
        const result = await api.authSetup(next);
        api.setToken(result.token);
      }
      showToast(t('set.toastPwSaved'), 'success');
      setTimeout(() => {
        api.setToken(null);
        renderLogin(() => location.reload());
      }, 1500);
    } catch (err) {
      showToast(t('set.toastPwError', { msg: err.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-lock"></i> ${t('set.pwChangeBtn')}`;
      document.getElementById('sec-current').value = '';
      document.getElementById('sec-new').value = '';
      document.getElementById('sec-new2').value = '';
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    api.setToken(null);
    renderLogin(() => location.reload());
  });

  // ── TOTP ───────────────────────────────────────────────────
  async function loadTotpStatus() {
    try {
      const { enabled } = await api.totpStatus();
      const label    = document.getElementById('totp-status-label');
      const controls = document.getElementById('totp-controls');
      if (!label || !controls) return;
      if (enabled) {
        label.textContent = t('set.totpEnabled');
        label.style.color = 'var(--online)';
        controls.innerHTML = `<button class="btn btn-danger btn-sm" id="btn-totp-disable">
          <i class="fas fa-shield-alt"></i> ${t('set.totpDisable')}</button>`;
        document.getElementById('btn-totp-disable')?.addEventListener('click', async () => {
          await api.totpDisable();
          showToast(t('set.totpDeactivated'), 'success');
          loadTotpStatus();
        });
      } else {
        label.textContent = t('set.totpDisabled');
        label.style.color = '';
        controls.innerHTML = `<button class="btn btn-primary btn-sm" id="btn-totp-enable">
          <i class="fas fa-shield-alt"></i> ${t('set.totpEnable')}</button>`;
        document.getElementById('btn-totp-enable')?.addEventListener('click', async () => {
          const panel = document.getElementById('totp-setup-panel');
          panel.style.display = 'flex';
          try {
            const data = await api.totpSetup();
            document.getElementById('totp-qr').src = data.qrDataUrl;
            document.getElementById('totp-secret-text').textContent = data.secret;
          } catch (err) {
            panel.style.display = 'none';
            showToast(err.message || t('set.totpSetupError'), 'error');
          }
        });
      }
    } catch {}
  }
  loadTotpStatus();

  document.getElementById('btn-totp-verify')?.addEventListener('click', async () => {
    const code = document.getElementById('totp-confirm-code')?.value.replace(/\s/g, '');
    if (!code) return;
    try {
      await api.totpConfirm(code);
      showToast(t('set.totpConfirmed'), 'success');
      document.getElementById('totp-setup-panel').style.display = 'none';
      loadTotpStatus();
    } catch (err) {
      showToast(err.message || t('set.totpInvalid'), 'error');
    }
  });
}

// ============================================================
// SSH Key
// ============================================================
async function loadSSHKey() {
  const el = document.getElementById('ssh-key-content');
  if (!el) return;
  try {
    const key = await api.getSSHKey();
    const installCmd = `mkdir -p ~/.ssh && echo '${key.publicKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
    el.innerHTML = `
      <div class="settings-row">
        <div class="settings-row-label"><span>${t('set.sshName')}</span></div>
        <div class="settings-row-control" style="font-family:var(--font-mono);font-size:12.5px;">${key.name || 'shipyard'}</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span>${t('set.sshType')}</span></div>
        <div class="settings-row-control" style="font-family:var(--font-mono);font-size:12.5px;">ED25519</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span>${t('set.sshStatus')}</span></div>
        <div class="settings-row-control">
          <span class="badge badge-${key.exists ? 'online' : 'offline'}">
            ${key.exists ? `<i class="fas fa-check"></i> ${t('set.sshActive')}` : `<i class="fas fa-times"></i> ${t('set.sshNotFound')}`}
          </span>
        </div>
      </div>
      <div class="settings-row" style="align-items:flex-start;">
        <div class="settings-row-label">
          <span>${t('set.sshPublicKey')}</span>
        </div>
        <div class="settings-row-control" style="flex:1;min-width:0;">
          <div class="ssh-key-display" style="position:relative;">
            <span style="display:block;padding-right:90px;word-break:break-all;">${esc(key.publicKey) || t('set.notAvailable')}</span>
            <button class="copy-btn" id="btn-copy-key"><i class="fas fa-copy"></i> ${t('common.copy')}</button>
          </div>
        </div>
      </div>
      <div class="settings-row" style="align-items:flex-start;">
        <div class="settings-row-label">
          <span>${t('set.sshManualAdd')}</span>
          <small>${t('set.sshManualHint')}</small>
        </div>
        <div class="settings-row-control" style="flex:1;min-width:0;">
          <div class="ssh-key-display" style="position:relative;">
            <span style="display:block;padding-right:90px;word-break:break-all;color:var(--accent);">${esc(installCmd)}</span>
            <button class="copy-btn" id="btn-copy-cmd"><i class="fas fa-copy"></i> ${t('common.copy')}</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('btn-copy-key')?.addEventListener('click', () => {
      navigator.clipboard.writeText(key.publicKey).then(() => showToast(t('set.keyCopied'), 'success'));
    });
    document.getElementById('btn-copy-cmd')?.addEventListener('click', () => {
      navigator.clipboard.writeText(installCmd).then(() => showToast(t('set.cmdCopied'), 'success'));
    });
  } catch {
    el.innerHTML = `
      <div class="settings-row" style="">
        <div class="settings-row-label"><span>${t('set.sshStatus')}</span></div>
        <div class="settings-row-control" style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:13px;color:var(--text-muted);">${t('set.sshNone')}</span>
          <button class="btn btn-primary btn-sm" id="btn-generate-key">
            <i class="fas fa-key"></i> ${t('set.sshGenerate')}
          </button>
        </div>
      </div>
    `;
    document.getElementById('btn-generate-key')?.addEventListener('click', async () => {
      try {
        await api.generateSSHKey('shipyard');
        showToast(t('set.sshGenerated'), 'success');
        loadSSHKey();
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      }
    });
  }
}

// ============================================================
// Polling Config
// ============================================================
async function loadPollingConfig() {
  const el = document.getElementById('polling-config-content');
  if (!el) return;
  try {
    const cfg = await api.getPollingConfig();

    const pollers = [
      { key: 'info',         label: t('set.pollSysInfo'),      hint: t('set.pollSysInfoHint'),      cfg: cfg.info },
      { key: 'updates',      label: t('set.pollOsUpdates'),    hint: t('set.pollOsUpdatesHint'),    cfg: cfg.updates },
      { key: 'imageUpdates', label: t('set.pollImageUpdates'), hint: t('set.pollImageUpdatesHint'), cfg: cfg.imageUpdates },
      { key: 'customUpdates',label: t('set.pollCustomUpdates'),hint: t('set.pollCustomUpdatesHint'),cfg: cfg.customUpdates },
    ];

    el.innerHTML = pollers.map((p, i) => `
      <div class="settings-row" ${i === pollers.length - 1 ? 'style="border-bottom:none;"' : ''}>
        <div class="settings-row-label">
          <span>${p.label}</span>
          <small>${p.hint}</small>
        </div>
        <div class="settings-row-control" style="display:flex;align-items:center;gap:12px;">
          <label class="toggle-switch">
            <input type="checkbox" class="poll-toggle" data-key="${p.key}" ${p.cfg.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <div style="display:flex;align-items:center;gap:6px;">
            <input class="form-input poll-interval" data-key="${p.key}" type="number" min="1" max="9999"
              value="${p.cfg.intervalMin}" style="width:70px;text-align:center;"
              ${!p.cfg.enabled ? 'disabled' : ''}>
            <span style="font-size:12px;color:var(--text-muted);">min</span>
          </div>
        </div>
      </div>`).join('') + `
      <div class="settings-row" style="border-bottom:none;padding-top:12px;">
        <div class="settings-row-label"></div>
        <div class="settings-row-control">
          <button class="btn btn-primary btn-sm" id="btn-save-polling">
            <i class="fas fa-save"></i> ${t('common.save')}
          </button>
        </div>
      </div>`;

    // Toggle disables interval input
    el.querySelectorAll('.poll-toggle').forEach(tog => {
      tog.addEventListener('change', () => {
        const input = el.querySelector(`.poll-interval[data-key="${tog.dataset.key}"]`);
        if (input) input.disabled = !tog.checked;
      });
    });

    document.getElementById('btn-save-polling')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-save-polling');
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-sm"></span>`;
      try {
        const body = {};
        pollers.forEach(p => {
          const tog = el.querySelector(`.poll-toggle[data-key="${p.key}"]`);
          const inp = el.querySelector(`.poll-interval[data-key="${p.key}"]`);
          body[p.key] = { enabled: tog?.checked ?? true, intervalMin: parseInt(inp?.value) || p.cfg.intervalMin };
        });
        await api.savePollingConfig(body);
        showToast(t('set.pollSaved'), 'success');
      } catch (err) {
        showToast(t('common.errorPrefix', { msg: err.message }), 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-save"></i> ${t('common.save')}`;
      }
    });

  } catch (err) {
    el.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${err.message}</div>`;
  }
}

// ============================================================
// Ansible Status
// ============================================================
async function loadAnsibleStatus() {
  const el = document.getElementById('ansible-status-content');
  if (!el) return;
  try {
    const status = await api.getAnsibleStatus();
    el.innerHTML = `
      <div class="settings-row">
        <div class="settings-row-label"><span>${t('set.ansibleLabel')}</span></div>
        <div class="settings-row-control">
          <span class="badge badge-${status.installed ? 'online' : 'offline'}">
            ${status.installed ? `<i class="fas fa-check"></i> ${t('set.installed')}` : `<i class="fas fa-times"></i> ${t('set.notInstalled')}`}
          </span>
        </div>
      </div>
      ${status.version ? `
      <div class="settings-row">
        <div class="settings-row-label"><span>Version</span></div>
        <div class="settings-row-control" style="font-family:var(--font-mono);font-size:12.5px;">${esc(status.version)}</div>
      </div>` : ''}
      ${!status.installed ? `
      <div class="settings-row" style="">
        <div class="settings-row-label"></div>
        <div class="settings-row-control">
          <div style="padding:10px 14px;background:var(--warning-bg);border-radius:var(--radius);font-size:13px;color:var(--warning);display:inline-block;">
            <i class="fas fa-exclamation-triangle"></i> ${t('set.ansibleInstallHint')}
          </div>
        </div>
      </div>` : ''}
    `;
  } catch (error) {
    el.innerHTML = `<div class="settings-row" style="border-bottom:none;padding:16px 28px;color:var(--offline);font-size:13px;">${error.message}</div>`;
  }
}

// ============================================================
// Danger Zone
// ============================================================
function setupDangerZone() {
  const actions = {
    servers:   { confirmMsg: t('set.confirmServers'),   fn: () => api.resetServers(),   after: 'toast' },
    schedules: { confirmMsg: t('set.confirmSchedules'), fn: () => api.resetSchedules(), after: 'toast' },
    playbooks: { confirmMsg: t('set.confirmPlaybooks'), fn: () => api.resetPlaybooks(), after: 'toast' },
    auth:      { confirmMsg: t('set.confirmAuth'),      fn: () => api.resetAuth(),      after: 'reboot' },
    all:       { confirmMsg: t('set.confirmAll'),       fn: () => api.resetAll(),       after: 'reboot' },
  };

  document.querySelectorAll('[data-dz]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.dz;
      const cfg = actions[key];
      if (!cfg) return;

      const ctrl = document.getElementById(`dz-ctrl-${key}`);
      if (!ctrl) return;

      // Replace button with inline confirm
      ctrl.innerHTML = `
        <div class="dz-confirm">
          <span>${cfg.confirmMsg}</span>
          <button class="btn btn-secondary btn-sm" id="dz-cancel-${key}">${t('common.cancel')}</button>
          <button class="btn btn-danger btn-sm" id="dz-confirm-${key}">${t('common.yes')}, ${t('common.delete')}</button>
        </div>
      `;

      document.getElementById(`dz-cancel-${key}`)?.addEventListener('click', () => {
        ctrl.innerHTML = `<button class="btn btn-danger btn-sm" data-dz="${key}"><i class="fas fa-trash"></i> ${t('common.delete')}</button>`;
        setupDangerZone(); // re-attach listener for this button
      });

      document.getElementById(`dz-confirm-${key}`)?.addEventListener('click', async () => {
        const confirmBtn = document.getElementById(`dz-confirm-${key}`);
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.innerHTML = '<span class="spinner-sm"></span>'; }
        try {
          await cfg.fn();
          if (cfg.after === 'reboot') {
            api.setToken(null);
            showToast(t('set.resetRestarting'), 'success');
            setTimeout(() => location.reload(), 1200);
          } else {
            showToast(t('common.deleted'), 'success');
            ctrl.innerHTML = `<span style="font-size:12px;color:var(--online);"><i class="fas fa-check"></i> ${t('common.deleted')}</span>`;
          }
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
          ctrl.innerHTML = `<button class="btn btn-danger btn-sm" data-dz="${key}"><i class="fas fa-trash"></i> ${t('common.delete')}</button>`;
          setupDangerZone();
        }
      });
    });
  });
}
