import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';
import { renderBrandMark } from './settings.js';

const STEPS = 5;

export async function renderOnboarding() {
  let currentStep = 0;
  let branding = { appName: 'Shipyard', appTagline: 'Infrastructure', accentColor: '#3b82f6', showIcon: true, logoIcon: 'fa-ship' };

  try {
    const status = await api.getAuthStatus();
    branding = {
      appName: status.appName || 'Shipyard',
      appTagline: status.appTagline || 'Infrastructure',
      accentColor: status.accentColor || '#3b82f6',
      showIcon: status.showIcon !== false,
      logoIcon: status.logoIcon || 'fa-ship',
    };
  } catch {
    // Keep defaults if branding is unavailable before auth
  }

  document.title = branding.appName;
  document.documentElement.style.setProperty('--accent', branding.accentColor);

  function stepBar() {
    return `
      <div class="onboarding-steps-bar">
        ${Array.from({ length: STEPS }, (_, i) => `
          <div class="onboarding-step-dot ${i < currentStep ? 'done' : i === currentStep ? 'active' : ''}"></div>
        `).join('')}
      </div>`;
  }

  function logo() {
    return `
      <div class="onboarding-logo">
        ${renderBrandMark(branding, 'fa-ship', 'Onboarding logo')}
        <div>
          <div class="login-title">${branding.appName}</div>
          <div class="login-sub">${branding.appTagline}</div>
        </div>
      </div>`;
  }

  function renderStep() {
    switch (currentStep) {

      case 0: return `
        ${logo()}${stepBar()}
        <h3 style="margin:0 0 10px;font-size:20px;">${t('ob.welcome')}</h3>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin:0 0 8px;">
          ${t('ob.welcomeDesc')}
        </p>
        <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin:0;">
          ${t('ob.setupHelper')}
        </p>
        <div class="onboarding-nav">
          <button class="btn btn-primary" id="ob-next">${t('ob.letsGo')} <i class="fas fa-arrow-right"></i></button>
        </div>`;

      case 1: return `
        ${logo()}${stepBar()}
        <h3 style="margin:0 0 6px;font-size:18px;">${t('ob.passwordStep')}</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0 0 20px;">
          ${t('ob.passwordHint')}
        </p>
        <div class="form-group">
          <label class="form-label">${t('ob.username')} <span style="font-size:11px;font-weight:400;color:var(--text-muted);">(${t('ob.usernameHint')})</span></label>
          <input class="form-input" type="text" id="ob-username" placeholder="admin" autocomplete="username" autofocus>
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('ob.displayName')} <span style="font-size:11px;font-weight:400;color:var(--text-muted);">(${t('ob.displayNameHint')})</span></label>
          <input class="form-input" type="text" id="ob-display-name" placeholder="${t('ob.displayNamePlaceholder')}" autocomplete="name">
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('login.password')}</label>
          <input class="form-input" type="password" id="ob-pw1" placeholder="${t('login.minChars')}"
            autocomplete="new-password">
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('login.confirmPassword')}</label>
          <input class="form-input" type="password" id="ob-pw2" placeholder="${t('login.repeatPassword')}"
            autocomplete="new-password">
        </div>
        <p class="login-error hidden" id="ob-error"></p>
        <div class="onboarding-nav">
          <button class="btn btn-secondary" id="ob-prev"><i class="fas fa-arrow-left"></i> ${t('ob.prev')}</button>
          <button class="btn btn-primary" id="ob-next">${t('login.setPassword')} <i class="fas fa-arrow-right"></i></button>
        </div>`;

      case 2: return `
        ${logo()}${stepBar()}
        <h3 style="margin:0 0 6px;font-size:18px;">${t('ob.appearance')}</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0 0 20px;">
          ${t('ob.appearanceHint')}
        </p>
        <div class="form-group">
          <label class="form-label">${t('set.appName')}</label>
          <input class="form-input" type="text" id="ob-name" placeholder="Shipyard" value="${esc(branding.appName === 'Shipyard' ? '' : branding.appName)}">
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('set.tagline')}</label>
          <input class="form-input" type="text" id="ob-tagline" placeholder="Infrastructure" value="${esc(branding.appTagline === 'Infrastructure' ? '' : branding.appTagline)}">
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('set.accentColor')}</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;align-items:center;">
            ${['#3b82f6','#6366f1','#8b5cf6','#ec4899','#14b8a6','#22c55e'].map(c => `
              <button class="ob-color-swatch" data-color="${c}" title="${c === '#3b82f6' ? c + ' (default)' : c}"
                style="width:28px;height:28px;border-radius:50%;background:${c};border:2px solid ${c === branding.accentColor ? 'rgba(255,255,255,0.9)' : 'transparent'};cursor:pointer;transition:border .15s;outline:none;">
              </button>`).join('')}
            <input type="color" id="ob-color-picker" value="${branding.accentColor}" title="${t('common.customColor')}"
              style="width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,0.12);cursor:pointer;padding:2px;background:none;">
          </div>
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="form-label">${t('set.theme')}</label>
          <div class="theme-toggle" id="ob-theme-toggle" style="display:inline-flex;">
            <button class="theme-btn" data-value="light"><i class="fas fa-sun"></i> ${t('set.light')}</button>
            <button class="theme-btn active" data-value="auto"><i class="fas fa-circle-half-stroke"></i> ${t('set.auto')}</button>
            <button class="theme-btn" data-value="dark"><i class="fas fa-moon"></i> ${t('set.dark')}</button>
          </div>
        </div>
        <div class="onboarding-nav">
          <button class="btn btn-secondary" id="ob-prev"><i class="fas fa-arrow-left"></i> ${t('ob.prev')}</button>
          <button class="btn btn-secondary" id="ob-skip">${t('common.skip')}</button>
          <button class="btn btn-primary" id="ob-next">${t('ob.saveNext')} <i class="fas fa-arrow-right"></i></button>
        </div>`;

      case 3: return `
        ${logo()}${stepBar()}
        <h3 style="margin:0 0 6px;font-size:18px;">${t('ob.sshStep')}</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin:0 0 20px;">
          ${t('ob.sshDesc')}
        </p>
        <div id="ob-ssh-status" style="margin-bottom:16px;">
          <div class="loading-state"><div class="loader"></div> ${t('ob.checkingKey')}</div>
        </div>
        <div class="onboarding-nav">
          <button class="btn btn-secondary" id="ob-prev"><i class="fas fa-arrow-left"></i> ${t('ob.prev')}</button>
          <button class="btn btn-secondary" id="ob-skip">${t('common.skip')}</button>
          <button class="btn btn-primary" id="ob-ssh-gen" style="display:none;">
            <i class="fas fa-key"></i> ${t('ob.generateKey')}
          </button>
          <button class="btn btn-primary" id="ob-next" style="display:none;">
            ${t('ob.next')} <i class="fas fa-arrow-right"></i>
          </button>
        </div>`;

      case 4: return `
        ${logo()}${stepBar()}
        <div style="text-align:center;padding:12px 0 24px;">
          <div style="font-size:48px;margin-bottom:16px;">🎉</div>
          <h3 style="margin:0 0 10px;font-size:20px;">${t('ob.done')}</h3>
          <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin:0;">
            ${t('ob.doneDesc')}
          </p>
        </div>
        <div class="onboarding-nav" style="justify-content:center;">
          <button class="btn btn-primary" id="ob-finish" style="min-width:180px;">
            <i class="fas fa-rocket"></i> ${t('ob.openApp')}
          </button>
        </div>`;
    }
  }

  function render() {
    document.body.innerHTML = `
      <div class="onboarding-overlay">
        <div class="onboarding-card">
          ${renderStep()}
        </div>
      </div>`;
    attachEvents();
  }

  function setStep(n) {
    currentStep = n;
    render();
  }

  function attachEvents() {
    document.getElementById('ob-prev')?.addEventListener('click', () => setStep(currentStep - 1));
    document.getElementById('ob-skip')?.addEventListener('click', () => setStep(currentStep + 1));

    if (currentStep === 0) {
      document.getElementById('ob-next')?.addEventListener('click', () => setStep(1));
    }

    if (currentStep === 1) {
      const next = document.getElementById('ob-next');
      next?.addEventListener('click', handlePasswordStep);
      document.getElementById('ob-pw2')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') handlePasswordStep();
      });
    }

    if (currentStep === 2) {
      document.querySelectorAll('.ob-color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.ob-color-swatch').forEach(b => b.style.borderColor = 'transparent');
          btn.style.borderColor = 'rgba(255,255,255,0.9)';
          const picker = document.getElementById('ob-color-picker');
          if (picker) picker.value = btn.dataset.color;
        });
      });
      document.querySelectorAll('#ob-theme-toggle .theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#ob-theme-toggle .theme-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          document.documentElement.dataset.theme = btn.dataset.value;
        });
      });
      document.getElementById('ob-next')?.addEventListener('click', handleAppearanceStep);
    }

    if (currentStep === 3) {
      loadSSHStep();
      document.getElementById('ob-ssh-gen')?.addEventListener('click', generateSSHKey);
      document.getElementById('ob-next')?.addEventListener('click', () => setStep(4));
    }

    if (currentStep === 4) {
      document.getElementById('ob-finish')?.addEventListener('click', handleFinish);
    }
  }

  // ── Step handlers ──────────────────────────────────────────

  async function handlePasswordStep() {
    const usernameRaw = document.getElementById('ob-username').value.trim();
    const displayName = document.getElementById('ob-display-name').value.trim();
    const pw1 = document.getElementById('ob-pw1').value;
    const pw2 = document.getElementById('ob-pw2').value;
    const err = document.getElementById('ob-error');
    err.classList.add('hidden');
    err.textContent = '';

    const username = usernameRaw || 'admin';
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      err.textContent = t('ob.usernameInvalid');
      err.classList.remove('hidden');
      return;
    }
    if (pw1.length < 12) {
      err.textContent = t('login.errorShort');
      err.classList.remove('hidden');
      return;
    }
    if (pw1 !== pw2) {
      err.textContent = t('login.errorMismatch');
      err.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('ob-next');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.loading')}`;

    try {
      const result = await api.authSetup(username, pw1);
      api.setToken(result.token);
      // Save display name if provided
      if (displayName) {
        try { await api.updateProfile({ displayName }); } catch {}
      }
      setStep(2);
    } catch (e) {
      err.textContent = e.message || t('login.errorGeneral');
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = `${t('login.setPassword')} <i class="fas fa-arrow-right"></i>`;
    }
  }

  async function handleAppearanceStep() {
    const name    = document.getElementById('ob-name')?.value.trim() || '';
    const tagline = document.getElementById('ob-tagline')?.value.trim() || '';
    const color   = document.getElementById('ob-color-picker')?.value || '#3b82f6';
    const theme   = document.querySelector('#ob-theme-toggle .theme-btn.active')?.dataset.value || 'auto';

    const btn = document.getElementById('ob-next');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('common.save')}…`;

    try {
      await api.saveSettings({ appName: name, appTagline: tagline, accentColor: color, logoIcon: branding.logoIcon, showIcon: branding.showIcon, theme });
    } catch { /* nicht kritisch */ }

    setStep(3);
  }

  async function loadSSHStep() {
    const statusEl = document.getElementById('ob-ssh-status');
    if (!statusEl) return;
    try {
      const key = await api.getSSHKey();
      if (key?.exists) {
        statusEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;
            background:rgba(22,163,74,0.1);border-radius:var(--radius);border:1px solid rgba(22,163,74,0.3);">
            <i class="fas fa-check-circle" style="color:var(--online);font-size:18px;flex-shrink:0;"></i>
            <div>
              <div style="font-size:13px;font-weight:500;color:var(--online);">${t('ob.keyExists')}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:2px;word-break:break-all;">
                ${esc(key.publicKey?.substring(0, 64))}…
              </div>
            </div>
          </div>`;
        document.getElementById('ob-next').style.display = '';
      } else {
        statusEl.innerHTML = `
          <div style="padding:12px 14px;background:rgba(217,119,6,0.1);border-radius:var(--radius);
            border:1px solid rgba(217,119,6,0.3);font-size:13px;color:var(--warning);">
            <i class="fas fa-exclamation-triangle"></i> ${t('ob.noKey')}
          </div>`;
        document.getElementById('ob-ssh-gen').style.display = '';
      }
    } catch {
      statusEl.innerHTML = `<div style="font-size:13px;color:var(--text-muted);">${t('ob.checkFailed')}</div>`;
      document.getElementById('ob-next').style.display = '';
    }
  }

  async function generateSSHKey() {
    const btn = document.getElementById('ob-ssh-gen');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('ob.generating')}`;
    try {
      await api.generateSSHKey('shipyard');
      await loadSSHStep();
      btn.style.display = 'none';
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-key"></i> ${t('ob.generateKey')}`;
    }
  }

  async function handleFinish() {
    const btn = document.getElementById('ob-finish');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('ob.launching')}`;
    try { await api.markOnboardingDone(); } catch { /* nicht kritisch */ }
    location.reload();
  }

  render();
}
