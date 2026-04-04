import { api } from '../api.js';
import { t } from '../i18n.js';

/**
 * Renders the full-screen login or first-time-setup screen.
 * Calls onSuccess() after a valid token is obtained.
 */
export async function renderLogin(onSuccess) {
  let status;
  try {
    status = await api.getAuthStatus();
  } catch {
    // If the status check fails, assume configured (show login, not setup wizard)
    status = { configured: true };
  }
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
            <label class="form-label">${t('set.username')}</label>
            <input
              class="form-input"
              type="text"
              id="login-username"
              placeholder="${isSetup ? 'admin' : t('set.username')}"
              value="${isSetup ? 'admin' : ''}"
              autocomplete="username"
              ${isSetup ? '' : 'autofocus'}
            >
          </div>
          <div class="form-group">
            <label class="form-label">${isSetup ? t('login.newPassword') : t('login.password')}</label>
            <input
              class="form-input"
              type="password"
              id="login-password"
              placeholder="${isSetup ? t('login.minChars') : t('login.password')}"
              autocomplete="${isSetup ? 'new-password' : 'current-password'}"
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
        <div class="login-footer">Infrastructure Control Plane</div>
      </div>
    </div>
  `;

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const uname = (document.getElementById('login-username')?.value || '').trim();
    const pw = document.getElementById('login-password').value;
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    if (isSetup) {
      const pw2 = document.getElementById('login-password2').value;
      if (pw.length < 12) {
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
      const result = isSetup
        ? await api.authSetup(uname || 'admin', pw)
        : await api.authLogin(uname, pw);
      if (result.requires2FA) {
        renderTotp(result.tempToken, onSuccess);
        return;
      }
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

function renderTotp(tempToken, onSuccess) {
  document.body.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">
          <div class="sidebar-logo-icon"><i class="fas fa-shield-alt"></i></div>
          <div>
            <div class="login-title">Shipyard</div>
            <div class="login-sub">${t('login.totpTitle')}</div>
          </div>
        </div>
        <p class="login-hint">${t('login.totpHint')}</p>
        <form id="totp-form" autocomplete="off">
          <div class="form-group" style="margin-bottom:16px;">
            <input class="form-input totp-code-input" id="totp-code"
              type="text" inputmode="numeric" pattern="[0-9 ]*"
              maxlength="7" autocomplete="one-time-code" autofocus
              placeholder="000 000">
          </div>
          <p class="login-error hidden" id="totp-error"></p>
          <button class="btn btn-primary" type="submit" id="totp-btn" style="width:100%;margin-top:4px;">
            <i class="fas fa-check"></i> ${t('login.totpBtn')}
          </button>
          <button type="button" id="totp-back" class="btn btn-secondary" style="width:100%;margin-top:8px;">
            ${t('login.totpBack')}
          </button>
        </form>
        <div class="login-footer">Infrastructure Control Plane</div>
      </div>
    </div>
  `;

  document.getElementById('totp-back').addEventListener('click', () => renderLogin(onSuccess));

  const codeInput = document.getElementById('totp-code');

  // Strip non-digits on every input (allow space as visual separator)
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/[^0-9]/g, '').slice(0, 6);
    // Format as "000 000" while typing
    codeInput.value = digits.length > 3 ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits;
  });

  setTimeout(() => codeInput.focus(), 100);

  document.getElementById('totp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = codeInput.value.replace(/[^0-9]/g, '');
    if (code.length < 6) return;

    const btn = document.getElementById('totp-btn');
    const errEl = document.getElementById('totp-error');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> …';

    try {
      const result = await api.totpLogin(tempToken, code);
      api.setToken(result.token);
      location.reload();
    } catch (err) {
      errEl.textContent = err.message || t('login.totpInvalid');
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-check"></i> ${t('login.totpBtn')}`;
      codeInput.value = '';
      codeInput.focus();
    }
  });
}
