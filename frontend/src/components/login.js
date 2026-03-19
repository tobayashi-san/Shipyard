import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Renders the full-screen login or first-time-setup screen.
 * Calls onSuccess() after a valid token is obtained.
 */
export async function renderLogin(onSuccess) {
  const status = await api.getAuthStatus();
  const isSetup = !status.configured;

  document.body.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <div class="sidebar-logo-icon">
            <i class="fas fa-ship"></i>
          </div>
          <div>
            <div class="login-title">Shipyard</div>
            <div class="login-sub">${isSetup ? t('login.setup') : t('login.signin')}</div>
          </div>
        </div>

        ${isSetup ? `
          <p class="login-hint">
            ${t('login.hint')}
          </p>
        ` : ''}

        <form id="login-form" autocomplete="on">
          <div class="form-group">
            <label class="form-label">${isSetup ? t('login.newPassword') : t('login.password')}</label>
            <input
              class="form-input"
              type="password"
              id="login-password"
              placeholder="${isSetup ? t('login.minChars') : t('login.password')}"
              autocomplete="${isSetup ? 'new-password' : 'current-password'}"
              autofocus
            >
          </div>
          ${isSetup ? `
          <div class="form-group">
            <label class="form-label">${t('login.confirmPassword')}</label>
            <input
              class="form-input"
              type="password"
              id="login-password2"
              placeholder="${t('login.repeatPassword')}"
              autocomplete="new-password"
            >
          </div>
          ` : ''}
          <p class="login-error hidden" id="login-error"></p>
          <button class="btn btn-primary" type="submit" id="login-btn" style="width:100%;margin-top:4px;">
            ${isSetup ? `<i class="fas fa-lock"></i> ${t('login.setPassword')}` : `<i class="fas fa-sign-in-alt"></i> ${t('login.loginBtn')}`}
          </button>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const pw = document.getElementById('login-password').value;
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    if (isSetup) {
      const pw2 = document.getElementById('login-password2').value;
      if (pw.length < 8) {
        errorEl.textContent = t('login.errorShort');
        errorEl.classList.remove('hidden');
        return;
      }
      if (pw !== pw2) {
        errorEl.textContent = t('login.errorMismatch');
        errorEl.classList.remove('hidden');
        return;
      }
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> …';

    try {
      const result = isSetup ? await api.authSetup(pw) : await api.authLogin(pw);
      api.setToken(result.token);
      location.reload();
    } catch (err) {
      errorEl.textContent = err.message || t('login.errorGeneral');
      errorEl.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = isSetup
        ? `<i class="fas fa-lock"></i> ${t('login.setPassword')}`
        : `<i class="fas fa-sign-in-alt"></i> ${t('login.loginBtn')}`;
      document.getElementById('login-password').focus();
    }
  });
}
