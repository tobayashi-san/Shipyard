import { api } from '../api.js';
import { state } from '../main.js';
import { renderSidebar } from './sidebar.js';
import { showToast, showConfirm } from './toast.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

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
  document.documentElement.dataset.theme = localStorage.getItem('theme') || 'auto';
  const logoIcon = document.querySelector('.sidebar-logo-icon');
  if (logoIcon) logoIcon.style.display = wl.showIcon === false ? 'none' : '';
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
      ${state.whiteLabel?.agentEnabled ? `<button class="tab-btn" data-tab="agent-manifest">
        <i class="fas fa-robot"></i> ${t('set.tabAgentManifest')}
      </button>` : ''}
      <button class="tab-btn" data-tab="notifications">
        <i class="fas fa-bell"></i> Notifications
      </button>
      <button class="tab-btn" data-tab="git">
        <i class="fab fa-git-alt"></i> Git
      </button>
      <button class="tab-btn" data-tab="plugins">
        <i class="fas fa-puzzle-piece"></i> ${t('set.tabPlugins')}
      </button>
      <button class="tab-btn" data-tab="users">
        <i class="fas fa-users"></i> Users
      </button>
      <button class="tab-btn" data-tab="roles">
        <i class="fas fa-shield-halved"></i> Roles
      </button>
      <button class="tab-btn" data-tab="audit">
        <i class="fas fa-clipboard-list"></i> ${t('set.tabAudit')}
      </button>
      <button class="tab-btn" data-tab="danger">
        <i class="fas fa-triangle-exclamation"></i> ${t('set.tabDanger')}
      </button>
    </div>

    <div class="page-content" style="overflow-y:auto;flex:1;">

      <!-- Tab: Appearance -->
      <div class="tab-panel active" id="tab-appearance">
        <div class="settings-group-title" style="margin-top:4px;">${t('set.whiteLabel')}</div>
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
            <div class="settings-row-label">
              <span>Sidebar Icon</span>
              <small>Show icon in the sidebar header</small>
            </div>
            <div class="settings-row-control">
              <label class="toggle-switch">
                <input type="checkbox" id="wl-show-icon" ${wl.showIcon !== false ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
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
            <div class="settings-row-control" style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" id="btn-deploy-key">
                <i class="fas fa-key"></i> ${t('set.sshDistributeBtn')}
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-deploy-key-all">
                <i class="fas fa-key"></i> ${t('set.sshDistributeAllBtn')}
              </button>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control" style="font-size:12px;color:var(--text-muted);">
              ${t('set.sshDistributeAllHint')}
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

        <div class="settings-group-title">${t('set.agentFeature')}</div>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px 0;padding:0 4px;">${t('set.agentFeatureHint')}</p>
        <div class="settings-block">
          <div class="settings-row" style="border-bottom:none;">
            <div class="settings-row-label">
              <span>${t('set.agentFeatureToggle')}</span>
            </div>
            <div class="settings-row-control">
              <label class="toggle-switch">
                <input type="checkbox" id="agent-enabled-toggle" ${state.whiteLabel?.agentEnabled ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Agent Manifest -->
      <div class="tab-panel" id="tab-agent-manifest">
        <div id="agent-manifest-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

      <!-- Tab: Notifications -->
      <div class="tab-panel" id="tab-notifications">
        <div class="settings-group-title">${t('set.webhooks')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.webhookUrl')}</span>
              <small>${t('set.webhookUrlHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="url" id="webhook-url" value="${esc(wl.webhookUrl || '')}" placeholder="https://discord.com/api/webhooks/…" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.webhookSecret')}</span>
              <small>${t('set.webhookSecretHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="webhook-secret" value="${esc(wl.webhookSecret || '')}" placeholder="optional" style="max-width:420px;width:100%;" autocomplete="off">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control" style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" id="btn-save-webhook">
                <i class="fas fa-save"></i> ${t('set.webhookSave')}
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-test-webhook">
                <i class="fas fa-paper-plane"></i> ${t('set.webhookTest')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-group-title">${t('set.smtp')}</div>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label"><span>${t('set.smtpHost')}</span></div>
            <div class="settings-row-control" style="display:grid;grid-template-columns:1fr 90px;gap:8px;max-width:420px;width:100%;">
              <input class="form-input" type="text" id="smtp-host" value="${esc(wl.smtpHost || '')}" placeholder="smtp.example.com">
              <input class="form-input" type="number" id="smtp-port" value="${esc(wl.smtpPort || '587')}" placeholder="587">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"><span>${t('set.smtpUser')}</span></div>
            <div class="settings-row-control">
              <input class="form-input" type="text" id="smtp-user" value="${esc(wl.smtpUser || '')}" placeholder="user@example.com" autocomplete="off" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"><span>${t('set.smtpPass')}</span></div>
            <div class="settings-row-control">
              <input class="form-input" type="password" id="smtp-pass" value="" placeholder="••••••••" autocomplete="new-password" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"><span>${t('set.smtpFrom')}</span></div>
            <div class="settings-row-control">
              <input class="form-input" type="email" id="smtp-from" value="${esc(wl.smtpFrom || '')}" placeholder="shipyard@example.com" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label">
              <span>${t('set.smtpTo')}</span>
              <small>${t('set.smtpToHint')}</small>
            </div>
            <div class="settings-row-control">
              <input class="form-input" type="text" id="smtp-to" value="${esc(wl.smtpTo || '')}" placeholder="admin@example.com" style="max-width:420px;width:100%;">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-row-label"></div>
            <div class="settings-row-control" style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" id="btn-save-smtp">
                <i class="fas fa-save"></i> ${t('common.save')}
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-test-smtp">
                <i class="fas fa-paper-plane"></i> ${t('set.webhookTest')}
              </button>
            </div>
          </div>
        </div>

        <div class="settings-group-title" style="margin-top:20px;">Notification Events</div>
        <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px 0;padding:0 4px;">
          Choose which failures trigger a notification. Notifications are sent only if webhook or email is configured above.
        </p>
        <div class="settings-block">
          <div class="settings-row">
            <div class="settings-row-label">
              <span>Playbook failure</span>
              <small>Notify when an Ansible playbook fails</small>
            </div>
            <div class="settings-row-control">
              <label class="toggle-switch">
                <input type="checkbox" id="notif-playbook-failed" ${wl.notifPlaybookFailed !== false ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="settings-row" style="border-bottom:none;">
            <div class="settings-row-label">
              <span>Update failure</span>
              <small>Notify when a system or bulk update fails</small>
            </div>
            <div class="settings-row-control">
              <label class="toggle-switch">
                <input type="checkbox" id="notif-update-failed" ${wl.notifUpdateFailed !== false ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Plugins -->
      <div class="tab-panel" id="tab-plugins">
        <div class="settings-group-title">${t('set.plugins')}</div>
        <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px;">
          ${t('set.pluginsHint')}
        </p>
        <div class="settings-block" id="plugins-list-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" id="btn-reload-plugins">
            <i class="fas fa-rotate"></i> ${t('set.pluginsReload')}
          </button>
        </div>
        <div class="settings-block" style="margin-top:20px;background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius);padding:14px 16px;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <i class="fas fa-triangle-exclamation" style="color:var(--warning);margin-top:2px;flex-shrink:0;"></i>
            <div style="font-size:13px;color:var(--text-secondary);">
              <strong style="color:var(--warning);">${t('set.pluginsWarningTitle')}</strong><br>
              ${t('set.pluginsWarningText')}
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Danger Zone -->
      <div class="tab-panel" id="tab-danger">
        <div class="settings-group-title">
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
              <span>${t('set.resetAll')}</span>
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

      <!-- Tab: Users -->
      <div class="tab-panel" id="tab-users">
        <div id="users-settings-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

      <!-- Tab: Roles -->
      <div class="tab-panel" id="tab-roles">
        <div id="roles-settings-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

      <!-- Tab: Audit -->
      <div class="tab-panel" id="tab-audit">
        <div id="audit-settings-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

      <!-- Tab: Git -->
      <div class="tab-panel" id="tab-git">
        <div id="git-settings-content">
          <div class="loading-state"><div class="loader"></div> ${t('common.loading')}</div>
        </div>
      </div>

    </div>
  `;

  setupTabSwitching();
  loadSSHKey();
  loadAnsibleStatus();
  loadPollingConfig();
  setupAgentToggle();
  setupSettingsEvents(wl);
  setupNotificationsEvents();
  setupDangerZone();
  loadPluginsList();

  // Users tab loads lazily when first clicked
  document.querySelector('.tab-btn[data-tab="users"]')?.addEventListener('click', () => {
    if (!document.getElementById('users-settings-content')?.dataset.loaded) {
      loadUsersTab();
    }
  });

  // Roles tab loads lazily when first clicked
  document.querySelector('.tab-btn[data-tab="roles"]')?.addEventListener('click', () => {
    if (!document.getElementById('roles-settings-content')?.dataset.loaded) {
      loadRolesTab();
    }
  });

  // Audit tab loads lazily when first clicked
  document.querySelector('.tab-btn[data-tab="audit"]')?.addEventListener('click', () => {
    if (!document.getElementById('audit-settings-content')?.dataset.loaded) {
      loadAuditTab();
    }
  });

  // Agent manifest tab loads lazily when first clicked
  document.querySelector('.tab-btn[data-tab="agent-manifest"]')?.addEventListener('click', () => {
    if (!document.getElementById('agent-manifest-content')?.dataset.loaded) {
      loadAgentManifestTab();
    }
  });

  // Git tab loads lazily when first clicked
  document.querySelector('.tab-btn[data-tab="git"]')?.addEventListener('click', () => {
    if (!document.getElementById('git-settings-content')?.dataset.loaded) {
      loadGitSettingsTab();
    }
  });
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
        showIcon:    document.getElementById('wl-show-icon').checked,
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
      await api.saveSettings({ appName: '', appTagline: '', accentColor: '' });
      state.whiteLabel = {};
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent-hover');
      document.documentElement.style.removeProperty('--accent-light');
      document.documentElement.dataset.theme = 'auto'; // Keep this line to reset theme to auto, as it's a default behavior not tied to a specific setting.
      document.title = 'Shipyard';
      document.querySelectorAll('.sidebar-logo-text h1').forEach(el => el.textContent = 'Shipyard');
      document.querySelectorAll('.sidebar-logo-text span').forEach(el => el.textContent = 'Infrastructure');
      document.getElementById('wl-name').value = '';
      document.getElementById('wl-tagline').value = '';
      document.getElementById('wl-color').value = '#3b82f6';
      document.getElementById('wl-color-hex').value = '#3b82f6';
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

  document.getElementById('btn-deploy-key-all')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-deploy-key-all');
    const password = document.getElementById('deploy-password').value;
    if (!password) {
      showToast(t('set.serverPasswordPlaceholder'), 'error');
      return;
    }
    const ok = await showConfirm(t('set.sshDeployAllConfirm'), {
      title: t('set.sshDistributeAllBtn'),
      confirmText: t('set.sshDistributeAllBtn'),
      danger: true,
    });
    if (!ok) return;

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('set.deploying')}`;
    try {
      const result = await api.deploySSHKeyAll({ password });
      showToast(t('set.sshDistributedAllResult', { succeeded: result.succeeded, failed: result.failed }), result.failed ? 'warning' : 'success');
      document.getElementById('deploy-password').value = '';
    } catch (error) {
      showToast(t('common.errorPrefix', { msg: error.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-key"></i> ${t('set.sshDistributeAllBtn')}`;
    }
  });
}

// ============================================================
// Notifications Tab
// ============================================================
function setupNotificationsEvents() {
  document.getElementById('btn-save-webhook')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-webhook');
    btn.disabled = true;
    try {
      await api.saveSettings({
        webhookUrl:    document.getElementById('webhook-url').value.trim(),
        webhookSecret: document.getElementById('webhook-secret').value,
      });
      state.whiteLabel.webhookUrl    = document.getElementById('webhook-url').value.trim();
      state.whiteLabel.webhookSecret = document.getElementById('webhook-secret').value;
      showToast(t('set.webhookSaved'), 'success');
    } catch { showToast(t('set.toastErrorSave'), 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('btn-test-webhook')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-webhook');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span>`;
    try {
      await api.testWebhook();
      showToast(t('set.webhookTestOk'), 'success');
    } catch (e) {
      showToast(t('set.webhookTestFail') + (e.message ? ': ' + e.message : ''), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-paper-plane"></i> ${t('set.webhookTest')}`;
    }
  });

  document.getElementById('btn-save-smtp')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-smtp');
    btn.disabled = true;
    try {
      const pass = document.getElementById('smtp-pass').value;
      await api.saveSettings({
        smtpHost: document.getElementById('smtp-host').value.trim(),
        smtpPort: document.getElementById('smtp-port').value.trim(),
        smtpUser: document.getElementById('smtp-user').value.trim(),
        smtpFrom: document.getElementById('smtp-from').value.trim(),
        smtpTo:   document.getElementById('smtp-to').value.trim(),
        ...(pass ? { smtpPass: pass } : {}),
      });
      showToast(t('set.smtpSaved'), 'success');
    } catch { showToast(t('set.toastErrorSave'), 'error'); }
    finally { btn.disabled = false; }
  });

  document.getElementById('btn-test-smtp')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-smtp');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span>`;
    try {
      await api.testSmtp();
      showToast(t('set.smtpTestOk'), 'success');
    } catch (e) {
      showToast(t('set.smtpTestFail') + (e.message ? ': ' + e.message : ''), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-paper-plane"></i> ${t('set.webhookTest')}`;
    }
  });

  // Notification event toggles — save immediately on change
  ['notif-playbook-failed', 'notif-update-failed'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id === 'notif-playbook-failed' ? 'notifPlaybookFailed' : 'notifUpdateFailed';
      try {
        await api.saveSettings({ [key]: e.target.checked });
      } catch { showToast(t('set.toastErrorSave'), 'error'); e.target.checked = !e.target.checked; }
    });
  });
}

// ============================================================
// ============================================================
// SSH Key
// ============================================================
async function loadSSHKey() {
  const el = document.getElementById('ssh-key-content');
  if (!el) return;
  try {
    const key = await api.getSSHKey();
    const escapedKey = key.publicKey.replace(/'/g, "'\\''");
    const installCmd = `mkdir -p ~/.ssh && echo '${escapedKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
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
            <span style="display:block;padding-right:90px;word-break:break-all;">${esc(installCmd)}</span>
            <button class="copy-btn" id="btn-copy-cmd"><i class="fas fa-copy"></i> ${t('common.copy')}</button>
          </div>
        </div>
      </div>
      <div class="settings-row" style="align-items:flex-start;">
        <div class="settings-row-label">
          <span>Manage Key</span>
          <small>Export or Import Private Key</small>
        </div>
        <div class="settings-row-control" style="flex:1;min-width:0;display:flex;gap:10px;">
          <button class="btn btn-secondary btn-sm" id="btn-export-key" title="Download private key"><i class="fas fa-download"></i> Export Key</button>
          <button class="btn btn-secondary btn-sm" id="btn-import-key" title="Upload private key"><i class="fas fa-upload"></i> Import Key</button>
        </div>
      </div>
    `;
    document.getElementById('btn-copy-key')?.addEventListener('click', () => {
      navigator.clipboard.writeText(key.publicKey).then(() => showToast(t('set.keyCopied'), 'success'));
    });
    document.getElementById('btn-copy-cmd')?.addEventListener('click', () => {
      navigator.clipboard.writeText(installCmd).then(() => showToast(t('set.cmdCopied'), 'success'));
    });

    document.getElementById('btn-export-key')?.addEventListener('click', () => {
      // Show passphrase dialog
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay active';
      overlay.innerHTML = `
        <div class="modal" style="max-width:380px;">
          <div class="modal-header"><h3>${t('set.exportKeyTitle')}</h3></div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;">
            <p style="margin:0;font-size:13px;color:var(--text-muted);">${t('set.exportKeyHint')}</p>
            <input type="password" id="export-key-pass" class="form-input" placeholder="${t('set.exportKeyPlaceholder')}" autocomplete="new-password">
            <input type="password" id="export-key-pass2" class="form-input" placeholder="${t('set.exportKeyConfirm')}" autocomplete="new-password">
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="export-key-cancel">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="export-key-ok"><i class="fas fa-download"></i> ${t('set.exportKeyBtn')}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input1 = overlay.querySelector('#export-key-pass');
      const input2 = overlay.querySelector('#export-key-pass2');
      input1.focus();
      const close = () => document.body.removeChild(overlay);
      overlay.querySelector('#export-key-cancel').addEventListener('click', close);
      overlay.querySelector('#export-key-ok').addEventListener('click', async () => {
        const pass = input1.value;
        if (pass !== input2.value) {
          showToast(t('set.exportKeyMismatch'), 'error');
          return;
        }
        try {
          const { privateKey } = await api.exportSSHKey(pass);
          const blob = new Blob([privateKey], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'shipyard_id_ed25519';
          a.click();
          URL.revokeObjectURL(a.href);
          close();
        } catch (err) {
          showToast(t('common.errorPrefix', { msg: err.message }), 'error');
        }
      });
      input2.addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#export-key-ok').click(); });
    });

    const doImport = (fileContent) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay active';
      overlay.innerHTML = `
        <div class="modal" style="max-width:380px;">
          <div class="modal-header"><h3>${t('set.importKeyTitle')}</h3></div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;">
            <p style="margin:0;font-size:13px;color:var(--text-muted);">${t('set.importKeyHint')}</p>
            <input type="password" id="import-key-pass" class="form-input" placeholder="${t('set.importKeyPlaceholder')}" autocomplete="current-password">
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="import-key-cancel">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="import-key-ok"><i class="fas fa-upload"></i> ${t('set.importKeyBtn')}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const passInput = overlay.querySelector('#import-key-pass');
      passInput.focus();
      const close = () => document.body.removeChild(overlay);
      overlay.querySelector('#import-key-cancel').addEventListener('click', close);
      overlay.querySelector('#import-key-ok').addEventListener('click', async () => {
        try {
          await api.importSSHKey(fileContent, passInput.value);
          showToast(t('set.importKeySuccess'), 'success');
          close();
          loadSSHKey();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#import-key-ok').click(); });
    };

    const handleImport = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (rev) => doImport(rev.target.result);
      reader.readAsText(file);
    };

    document.getElementById('btn-import-key')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '*';
      input.onchange = handleImport;
      input.click();
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
          <button class="btn btn-secondary btn-sm" id="btn-empty-import-key">
            <i class="fas fa-upload"></i> Import Key
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

    document.getElementById('btn-empty-import-key')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '*';
      input.onchange = handleImport;
      input.click();
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
    el.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(err.message)}</div>`;
  }
}

// ============================================================
// Agent Feature Toggle
// ============================================================
function setupAgentToggle() {
  const toggle = document.getElementById('agent-enabled-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', async () => {
    try {
      await api.saveSettings({ agentEnabled: toggle.checked });
      state.whiteLabel = { ...state.whiteLabel, agentEnabled: toggle.checked };
      showToast(t('set.agentFeatureSaved'), 'success');
    } catch (e) {
      toggle.checked = !toggle.checked;
      showToast(e.message, 'error');
    }
  });
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
    el.innerHTML = `<div class="settings-row" style="border-bottom:none;padding:16px 28px;color:var(--offline);font-size:13px;">${esc(error.message)}</div>`;
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
          <span>${esc(cfg.confirmMsg)}</span>
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

// ============================================================
// Plugins Tab
// ============================================================
async function loadPluginsList() {
  const el = document.getElementById('plugins-list-content');
  if (!el) return;

  async function render(plugins) {
    if (!plugins.length) {
      el.innerHTML = `
        <div class="settings-row" style="border-bottom:none;">
          <div style="padding:20px 0;color:var(--text-muted);font-size:13px;text-align:center;width:100%;">
            <i class="fas fa-puzzle-piece" style="opacity:.4;font-size:1.5rem;margin-bottom:8px;display:block;"></i>
            ${t('set.pluginsEmpty')}
          </div>
        </div>`;
      return;
    }

    el.innerHTML = plugins.map((p, i) => `
      <div class="settings-row" ${i === plugins.length - 1 ? 'style="border-bottom:none;"' : ''}>
        <div class="settings-row-label">
          <span>${esc(p.name)}${p.version ? ` <small style="color:var(--text-muted);font-weight:400;">v${esc(String(p.version))}</small>` : ''}</span>
          ${p.description ? `<small>${esc(p.description)}</small>` : ''}
          ${!p.loaded ? `<small style="color:var(--offline);"><i class="fas fa-circle-exclamation"></i> ${esc(p.error || t('set.pluginsLoadError'))}</small>` : ''}
        </div>
        <div class="settings-row-control" style="display:flex;align-items:center;gap:10px;">
          <label class="toggle-switch" ${!p.loaded ? 'title="' + t('set.pluginsCannotEnable') + '"' : ''}>
            <input type="checkbox" class="plugin-toggle" data-id="${esc(p.id)}"
              ${p.enabled ? 'checked' : ''} ${!p.loaded ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
          <span style="font-size:12px;color:var(--text-muted);">${p.enabled ? t('set.pluginsEnabled') : t('set.pluginsDisabled')}</span>
        </div>
      </div>`).join('');

    // Attach toggle listeners
    el.querySelectorAll('.plugin-toggle').forEach(tog => {
      tog.addEventListener('change', async () => {
        const id      = tog.dataset.id;
        const enable  = tog.checked;
        const plugin  = plugins.find(p => p.id === id);
        tog.disabled  = true;

        // Warn before enabling for the first time
        if (enable) {
          const confirmed = await showConfirm(
            t('set.pluginsEnableWarning', { name: plugin?.name || id }),
            { title: t('set.pluginsEnableTitle'), confirmText: t('set.pluginsEnableConfirm'), danger: true, html: true }
          );
          if (!confirmed) {
            tog.checked  = false;
            tog.disabled = false;
            return;
          }
        }

        try {
          if (enable) {
            await api.enablePlugin(id);
            state.plugins = await api.getPlugins().catch(() => state.plugins);
          } else {
            await api.disablePlugin(id);
            state.plugins = await api.getPlugins().catch(() => state.plugins);
          }
          showToast(enable ? t('set.pluginsEnabledToast', { name: plugin?.name || id }) : t('set.pluginsDisabledToast', { name: plugin?.name || id }), 'success');
          // Re-render with updated list
          await render(state.plugins);
          // Update sidebar
          renderSidebar();
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
          tog.checked  = !enable;
          tog.disabled = false;
        }
      });
    });
  }

  try {
    const plugins = await api.getPlugins();
    state.plugins  = plugins;
    await render(plugins);
  } catch (e) {
    el.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(e.message)}</div>`;
  }

  // Reload button
  document.getElementById('btn-reload-plugins')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-reload-plugins');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span>`;
    try {
      const result = await api.reloadPlugins();
      state.plugins = result.plugins || await api.getPlugins();
      await render(state.plugins);
      showToast(t('set.pluginsReloaded'), 'success');
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-rotate"></i> ${t('set.pluginsReload')}`;
    }
  });
}

// ============================================================
// Roles Tab
// ============================================================
async function loadRolesTab() {
  const content = document.getElementById('roles-settings-content');
  if (!content) return;
  content.dataset.loaded = '1';

  async function renderRoles() {
    let roles = [], servers = [], groups = [], plugins = [], playbooks = [];
    try {
      [roles, servers, groups, plugins, playbooks] = await Promise.all([
        api.getRoles(),
        api.getServers(),
        api.getServerGroups(),
        api.getPlugins(),
        api.getPlaybooks(),
      ]);
    } catch (e) {
      content.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(e.message)}</div>`;
      return;
    }

    const customRoles = roles.filter(r => !r.is_system);

    content.innerHTML = `
      <div class="settings-group-title">Role Management</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Roles control what servers, playbooks, and features each user can access.
        The built-in <strong>Admin</strong> and <strong>User</strong> roles cannot be changed.
      </div>

      <!-- Built-in roles -->
      <div class="settings-block" style="margin-bottom:16px;">
        ${roles.filter(r => r.is_system).map((r, i, arr) => `
          <div class="settings-row" ${i === arr.length - 1 ? 'style="border-bottom:none;"' : ''}>
            <div class="settings-row-label">
              <span><i class="fas fa-lock" style="font-size:11px;color:var(--text-muted);margin-right:6px;"></i>${esc(r.name)}</span>
              <small>${r.id === 'admin' ? 'Full access to everything' : 'Default access — all servers, playbooks and features'}</small>
            </div>
            <div class="settings-row-control">
              <span class="badge badge-muted">Built-in</span>
            </div>
          </div>`).join('')}
      </div>

      <!-- Custom roles -->
      <div class="settings-group-title" style="margin-top:16px;">Custom Roles</div>
      <div class="settings-block" id="roles-list">
        ${customRoles.length === 0 ? `
          <div class="settings-row" style="border-bottom:none;">
            <div style="padding:20px 0;color:var(--text-muted);font-size:13px;text-align:center;width:100%;">
              <i class="fas fa-shield-halved" style="opacity:.4;font-size:1.5rem;margin-bottom:8px;display:block;"></i>
              No custom roles yet. Create one to restrict user access.
            </div>
          </div>` :
          customRoles.map((r, i) => {
            const p = r.permissions || {};
            const serverSummary = p.servers === 'all' ? 'All servers'
              : `${(p.servers?.groups || []).length} group(s), ${(p.servers?.servers || []).length} server(s)`;
            const playbookSummary = p.playbooks === 'all' ? 'All playbooks' : `${(p.playbooks || []).length} playbook(s)`;
            const pluginSummary  = p.plugins  === 'all' ? 'All plugins'  : `${(p.plugins  || []).length} plugin(s)`;
            return `
            <div class="settings-row" ${i === customRoles.length - 1 ? 'style="border-bottom:none;"' : ''}>
              <div class="settings-row-label">
                <span>${esc(r.name)}</span>
                <small>${serverSummary} · ${playbookSummary} · ${pluginSummary}</small>
              </div>
              <div class="settings-row-control" style="gap:8px;">
                <button class="btn btn-secondary btn-sm btn-edit-role" data-id="${esc(r.id)}"><i class="fas fa-edit"></i> Edit</button>
                <button class="btn btn-danger btn-sm btn-del-role" data-id="${esc(r.id)}" data-name="${esc(r.name)}"><i class="fas fa-trash"></i></button>
              </div>
            </div>`;
          }).join('')
        }
      </div>

      <div style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="btn-add-role">
          <i class="fas fa-plus"></i> New Role
        </button>
      </div>
      <div id="roles-form-area" style="margin-top:16px;"></div>
    `;

    // Store for form use
    content._meta = { servers, groups, plugins, playbooks };

    document.getElementById('btn-add-role')?.addEventListener('click', () => showRoleForm(null));

    content.querySelectorAll('.btn-edit-role').forEach(btn => {
      btn.addEventListener('click', () => {
        const role = roles.find(r => r.id === btn.dataset.id);
        if (role) showRoleForm(role);
      });
    });

    content.querySelectorAll('.btn-del-role').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete role "${btn.dataset.name}"?`)) return;
        try {
          await api.deleteRole(btn.dataset.id);
          showToast(t('role.deleted'), 'success');
          await renderRoles();
        } catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
      });
    });
  }

  function showRoleForm(role) {
    const isEdit = !!role;
    const area   = document.getElementById('roles-form-area');
    if (!area) return;
    const { servers = [], groups = [], plugins = [], playbooks = [] } = content._meta || {};
    const p = role?.permissions || {};

    const serversRestricted   = p.servers   !== 'all' && p.servers != null;
    const playbooksRestricted = p.playbooks !== 'all' && p.playbooks != null;
    const pluginsRestricted   = p.plugins   !== 'all' && p.plugins  != null;

    const checkedGroups  = serversRestricted  ? (p.servers?.groups   || []) : [];
    const checkedServers = serversRestricted  ? (p.servers?.servers  || []) : [];
    const checkedPbooks  = playbooksRestricted ? (p.playbooks || []) : [];
    const checkedPlugins = pluginsRestricted   ? (p.plugins   || []) : [];

    // Helper: section header with select-all toggle
    function sectionHead(label, icon, cls) {
      return `
        <div class="rf-section-head" data-cls="${cls}">
          <span><i class="fas ${icon}" style="color:var(--accent);margin-right:6px;font-size:11px;"></i>${label}</span>
          <button type="button" class="btn-link rf-select-all" data-cls="${cls}" style="font-size:11px;">Select all</button>
        </div>`;
    }

    // Helper: checkbox grid
    function capGrid(caps, defaults) {
      return `<div class="rf-cap-grid">${caps.map(c => `
        <label class="rf-cap-label">
          <input type="checkbox" class="rf-cap-chk" value="${esc(c.key)}" ${defaults[c.key] !== false ? 'checked' : ''}>
          <span>${c.label}</span>
        </label>`).join('')}</div>`;
    }

    // Access restriction picker (servers)
    function serverPicker() {
      return `
        <div class="rf-access-row">
          <label class="rf-radio-label">
            <input type="radio" name="rf-servers" value="all" ${!serversRestricted ? 'checked' : ''}> All servers
          </label>
          <label class="rf-radio-label">
            <input type="radio" name="rf-servers" value="restricted" ${serversRestricted ? 'checked' : ''}> Restrict access
          </label>
        </div>
        <div id="rf-servers-detail" class="rf-picker-detail" style="display:${serversRestricted ? 'block' : 'none'};">
          ${groups.length > 0 ? `
            <div class="rf-picker-label">Server Groups</div>
            <div class="rf-picker-list">
              ${groups.map(g => `
                <label class="rf-cap-label">
                  <input type="checkbox" class="rf-group-chk" value="${esc(g.id)}" ${checkedGroups.includes(g.id) ? 'checked' : ''}>
                  <span style="width:8px;height:8px;border-radius:2px;background:${esc(g.color||'#6366f1')};display:inline-block;flex-shrink:0;"></span>
                  <span>${esc(g.name)}</span>
                </label>`).join('')}
            </div>` : ''}
          ${servers.length > 0 ? `
            <div class="rf-picker-label" style="margin-top:8px;">Individual Servers</div>
            <div class="rf-picker-list">
              ${servers.map(s => `
                <label class="rf-cap-label">
                  <input type="checkbox" class="rf-server-chk" value="${esc(s.id)}" ${checkedServers.includes(s.id) ? 'checked' : ''}>
                  <span class="status-dot ${s.status === 'online' ? 'online' : s.status === 'offline' ? 'offline' : 'unknown'}"></span>
                  <span>${esc(s.name)}</span>
                  <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${esc(s.ip_address)}</span>
                </label>`).join('')}
            </div>` : ''}
        </div>`;
    }

    function playbookPicker() {
      return `
        <div class="rf-access-row">
          <label class="rf-radio-label"><input type="radio" name="rf-playbooks" value="all" ${!playbooksRestricted ? 'checked' : ''}> All playbooks</label>
          <label class="rf-radio-label"><input type="radio" name="rf-playbooks" value="restricted" ${playbooksRestricted ? 'checked' : ''}> Restrict access</label>
        </div>
        <div id="rf-playbooks-detail" class="rf-picker-detail" style="display:${playbooksRestricted ? 'block' : 'none'};">
          <div class="rf-picker-list">
            ${playbooks.map(pb => `
              <label class="rf-cap-label">
                <input type="checkbox" class="rf-pb-chk" value="${esc(pb.filename)}" ${checkedPbooks.includes(pb.filename) ? 'checked' : ''}>
                <i class="fas fa-file-code" style="font-size:10px;color:var(--text-muted);"></i>
                <span>${esc(pb.filename)}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }

    function pluginPicker() {
      const sidebarPlugins = plugins.filter(pl => pl.sidebar);
      if (!sidebarPlugins.length) return '<p style="font-size:12px;color:var(--text-muted);margin:0;">No plugins with UI installed.</p>';
      return `
        <div class="rf-access-row">
          <label class="rf-radio-label"><input type="radio" name="rf-plugins" value="all" ${!pluginsRestricted ? 'checked' : ''}> All plugins</label>
          <label class="rf-radio-label"><input type="radio" name="rf-plugins" value="restricted" ${pluginsRestricted ? 'checked' : ''}> Restrict access</label>
        </div>
        <div id="rf-plugins-detail" class="rf-picker-detail" style="display:${pluginsRestricted ? 'block' : 'none'};">
          <div class="rf-picker-list">
            ${sidebarPlugins.map(pl => `
              <label class="rf-cap-label">
                <input type="checkbox" class="rf-plugin-chk" value="${esc(pl.id)}" ${checkedPlugins.includes(pl.id) ? 'checked' : ''}>
                <i class="${esc(pl.sidebar?.icon || 'fas fa-puzzle-piece')}" style="font-size:10px;color:var(--text-muted);"></i>
                <span>${esc(pl.sidebar?.label || pl.name || pl.id)}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }

    area.innerHTML = `
      <div class="rf-form-card">
        <div class="rf-form-title">${isEdit ? `<i class="fas fa-shield-halved"></i> Edit: ${esc(role.name)}` : '<i class="fas fa-plus"></i> New Role'}</div>

        <div class="form-group" style="margin-bottom:20px;">
          <label class="form-label">Role Name</label>
          <input class="form-input" type="text" id="rf-name" value="${esc(role?.name || '')}" style="max-width:280px;" placeholder="e.g. Ops Team">
        </div>

        <!-- Servers -->
        <div class="rf-section">
          ${sectionHead('Servers', 'fa-server', 'rf-servers-caps')}
          ${serverPicker()}
          ${capGrid([
            { key: 'canViewServers',         label: 'View' },
            { key: 'canAddServers',          label: 'Add' },
            { key: 'canEditServers',         label: 'Edit' },
            { key: 'canDeleteServers',       label: 'Delete' },
            { key: 'canUseTerminal',         label: 'SSH Terminal' },
            { key: 'canExportImportServers', label: 'Export / Import' },
          ], p)}
          <div class="rf-subsection-label">Docker</div>
          ${capGrid([
            { key: 'canViewDocker',          label: 'View containers & logs' },
            { key: 'canPullDocker',          label: 'Pull & check updates' },
            { key: 'canRestartDocker',       label: 'Restart containers' },
            { key: 'canManageDockerCompose', label: 'Manage Compose stacks' },
          ], p)}
        </div>

        <!-- Updates -->
        <div class="rf-section">
          ${sectionHead('Updates', 'fa-arrow-up', 'rf-updates-caps')}
          ${capGrid([
            { key: 'canViewUpdates',        label: 'View updates' },
            { key: 'canRunUpdates',         label: 'Run update' },
            { key: 'canRebootServers',      label: 'Reboot servers' },
            { key: 'canViewCustomUpdates',  label: 'View custom tasks' },
            { key: 'canRunCustomUpdates',   label: 'Run / check custom tasks' },
            { key: 'canEditCustomUpdates',  label: 'Add / edit custom tasks' },
            { key: 'canDeleteCustomUpdates',label: 'Delete custom tasks' },
          ], p)}
        </div>

        <!-- Playbooks -->
        <div class="rf-section">
          ${sectionHead('Playbooks', 'fa-terminal', 'rf-playbooks-caps')}
          ${playbookPicker()}
          ${capGrid([
            { key: 'canViewPlaybooks',   label: 'View' },
            { key: 'canEditPlaybooks',   label: 'Create / Edit' },
            { key: 'canDeletePlaybooks', label: 'Delete' },
            { key: 'canRunPlaybooks',    label: 'Run & ad-hoc' },
          ], p)}
        </div>

        <!-- Schedules -->
        <div class="rf-section">
          ${sectionHead('Schedules', 'fa-clock', 'rf-schedules-caps')}
          ${capGrid([
            { key: 'canViewSchedules',   label: 'View' },
            { key: 'canAddSchedules',    label: 'Add' },
            { key: 'canEditSchedules',   label: 'Edit' },
            { key: 'canDeleteSchedules', label: 'Delete' },
            { key: 'canToggleSchedules', label: 'Enable / Disable' },
          ], p)}
        </div>

        <!-- Variables -->
        <div class="rf-section">
          ${sectionHead('Variables', 'fa-sliders-h', 'rf-vars-caps')}
          ${capGrid([
            { key: 'canViewVars',   label: 'View' },
            { key: 'canAddVars',    label: 'Add' },
            { key: 'canEditVars',   label: 'Edit' },
            { key: 'canDeleteVars', label: 'Delete' },
          ], p)}
        </div>

        <!-- Plugins -->
        <div class="rf-section">
          ${sectionHead('Plugins', 'fa-puzzle-piece', 'rf-plugins-caps')}
          ${pluginPicker()}
        </div>

        <!-- Other -->
        <div class="rf-section" style="border-bottom:none;">
          ${sectionHead('Other', 'fa-ellipsis-h', 'rf-other-caps')}
          ${capGrid([
            { key: 'canViewAudit', label: 'View audit log' },
          ], p)}
        </div>

        <div style="display:flex;gap:8px;padding:16px 0 4px;">
          <button class="btn btn-primary btn-sm" id="rf-save"><i class="fas fa-save"></i> ${isEdit ? 'Save' : 'Create Role'}</button>
          <button class="btn btn-secondary btn-sm" id="rf-cancel">Cancel</button>
        </div>
        <p class="login-error hidden" id="rf-error"></p>
      </div>
    `;

    // Scroll form into view
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Access restriction toggles
    area.querySelectorAll('input[name="rf-servers"]').forEach(r =>
      r.addEventListener('change', () => {
        const el = document.getElementById('rf-servers-detail');
        if (el) el.style.display = r.value === 'restricted' ? 'block' : 'none';
      }));
    area.querySelectorAll('input[name="rf-playbooks"]').forEach(r =>
      r.addEventListener('change', () => {
        const el = document.getElementById('rf-playbooks-detail');
        if (el) el.style.display = r.value === 'restricted' ? 'block' : 'none';
      }));
    area.querySelectorAll('input[name="rf-plugins"]').forEach(r =>
      r.addEventListener('change', () => {
        const el = document.getElementById('rf-plugins-detail');
        if (el) el.style.display = r.value === 'restricted' ? 'block' : 'none';
      }));

    // Select-all toggles per section
    area.querySelectorAll('.rf-select-all').forEach(btn => {
      btn.addEventListener('click', () => {
        const checkboxes = area.querySelectorAll(`.rf-cap-chk`);
        // scope to nearest rf-section
        const section = btn.closest('.rf-section');
        const sectionChks = section ? section.querySelectorAll('.rf-cap-chk') : checkboxes;
        const allChecked = [...sectionChks].every(c => c.checked);
        sectionChks.forEach(c => { c.checked = !allChecked; });
        btn.textContent = allChecked ? 'Select all' : 'Deselect all';
      });
    });

    document.getElementById('rf-cancel')?.addEventListener('click', () => { area.innerHTML = ''; });
    document.getElementById('rf-save')?.addEventListener('click', async () => {
      const btn   = document.getElementById('rf-save');
      const errEl = document.getElementById('rf-error');
      errEl.classList.add('hidden');

      const name = document.getElementById('rf-name').value.trim();
      if (!name) { errEl.textContent = 'Name required'; errEl.classList.remove('hidden'); return; }

      const serversMode   = area.querySelector('input[name="rf-servers"]:checked')?.value;
      const playbooksMode = area.querySelector('input[name="rf-playbooks"]:checked')?.value;
      const pluginsMode   = area.querySelector('input[name="rf-plugins"]') ? area.querySelector('input[name="rf-plugins"]:checked')?.value : 'all';

      const permissions = {};
      if (serversMode === 'all' || !serversMode) {
        permissions.servers = 'all';
      } else {
        permissions.servers = {
          groups:  [...area.querySelectorAll('.rf-group-chk:checked')].map(c => c.value),
          servers: [...area.querySelectorAll('.rf-server-chk:checked')].map(c => c.value),
        };
      }
      permissions.playbooks = (!playbooksMode || playbooksMode === 'all') ? 'all'
        : [...area.querySelectorAll('.rf-pb-chk:checked')].map(c => c.value);
      permissions.plugins = (!pluginsMode || pluginsMode === 'all') ? 'all'
        : [...area.querySelectorAll('.rf-plugin-chk:checked')].map(c => c.value);

      area.querySelectorAll('.rf-cap-chk').forEach(chk => { permissions[chk.value] = chk.checked; });

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-sm"></span>';
      try {
        if (isEdit) {
          await api.updateRole(role.id, { name, permissions });
          showToast(t('role.updated'), 'success');
        } else {
          await api.createRole({ name, permissions });
          showToast(t('role.created'), 'success');
        }
        area.innerHTML = '';
        await renderRoles();
      } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-save"></i> ${isEdit ? 'Save' : 'Create Role'}`;
      }
    });
  }

  await renderRoles();
}

// ============================================================
// Users Tab
// ============================================================
async function loadUsersTab() {
  const content = document.getElementById('users-settings-content');
  if (!content) return;
  content.dataset.loaded = '1';
  let _allRoles = [];
  try { _allRoles = await api.getRoles(); } catch {}
  content._allRoles = _allRoles;

  async function renderUsers() {
    let users = [];
    try {
      users = await api.getUsers();
    } catch (e) {
      content.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(e.message)}</div>`;
      return;
    }

    content.innerHTML = `
      <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>User Management</span>
        <button class="btn btn-primary btn-sm" id="btn-add-user">
          <i class="fas fa-user-plus"></i> Add User
        </button>
      </div>
      <div class="settings-block" id="users-list">
        ${users.length === 0 ? `
          <div class="settings-row" style="border-bottom:none;">
            <div style="padding:20px 0;color:var(--text-muted);font-size:13px;text-align:center;width:100%;">
              <i class="fas fa-users" style="opacity:.4;font-size:1.5rem;margin-bottom:8px;display:block;"></i>
              No users found.
            </div>
          </div>` :
          users.map((u, i) => {
            const roleName = esc((_allRoles.find(r => r.id === u.role) || {}).name || u.role);
            const displayName = u.display_name || '';
            const shownName = displayName || u.username;
            const initial = esc((shownName || '?')[0].toUpperCase());
            const isSelf = u.id === (window.__currentUserId || '');
            return `
            <div class="settings-row user-row" ${i === users.length - 1 ? 'style="border-bottom:none;"' : ''} data-user-id="${esc(u.id)}">
              <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
                <div class="user-avatar-circle">${initial}</div>
                <div style="min-width:0;">
                  <div style="font-size:13px;font-weight:500;color:var(--text-primary);">${esc(shownName)}</div>
                  <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">@${esc(u.username)}</div>
                </div>
              </div>
              <span class="badge ${u.role === 'admin' ? 'badge-accent' : 'badge-muted'}" style="flex-shrink:0;">${roleName}</span>
              <div style="display:flex;gap:4px;flex-shrink:0;">
                <button class="btn btn-secondary btn-sm btn-edit-user" data-id="${esc(u.id)}" data-username="${esc(u.username)}" data-display-name="${esc(displayName)}" data-email="${esc(u.email || '')}" data-role="${esc(u.role)}" title="Edit">
                  <i class="fas fa-pen"></i>
                </button>
                <button class="btn btn-secondary btn-sm btn-reset-pw" data-id="${esc(u.id)}" data-username="${esc(u.username)}" title="Reset Password">
                  <i class="fas fa-key"></i>
                </button>
                <button class="btn btn-secondary btn-sm btn-disable-2fa" data-id="${esc(u.id)}" data-username="${esc(u.username)}" title="Disable 2FA" ${u.totp_enabled ? '' : 'disabled'}>
                  <i class="fas fa-shield-xmark"></i>
                </button>
                <button class="btn btn-danger btn-sm btn-del-user" data-id="${esc(u.id)}" data-username="${esc(u.username)}" title="Delete" ${isSelf ? 'style="visibility:hidden;"' : ''}>
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>`;
          }).join('')
        }
      </div>
      <div id="users-form-area" style="margin-top:12px;"></div>
    `;

    // Add user button
    document.getElementById('btn-add-user')?.addEventListener('click', () => showUserForm(null));

    // Edit buttons
    content.querySelectorAll('.btn-edit-user').forEach(btn => {
      btn.addEventListener('click', () => {
        showUserForm({ id: btn.dataset.id, username: btn.dataset.username, displayName: btn.dataset.displayName || '', email: btn.dataset.email, role: btn.dataset.role });
      });
    });

    // Reset password buttons
    content.querySelectorAll('.btn-reset-pw').forEach(btn => {
      btn.addEventListener('click', () => showResetPasswordForm(btn.dataset.id, btn.dataset.username));
    });

    // Disable 2FA buttons
    content.querySelectorAll('.btn-disable-2fa').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm(`Disable 2FA for \"${btn.dataset.username}\"?`, {
          title: 'Disable 2FA',
          confirmText: 'Disable',
          danger: true,
        })) return;
        try {
          await api.disableUserTotp(btn.dataset.id);
          showToast('2FA disabled for user', 'success');
          await renderUsers();
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
        }
      });
    });

    // Delete buttons
    content.querySelectorAll('.btn-del-user').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${btn.dataset.username}"? This cannot be undone.`)) return;
        try {
          await api.deleteUser(btn.dataset.id);
          showToast(t('user.deleted'), 'success');
          await renderUsers();
        } catch (e) {
          showToast(t('common.errorPrefix', { msg: e.message }), 'error');
        }
      });
    });
  }

  function showUserForm(user) {
    const isEdit = !!user;
    const area = document.getElementById('users-form-area');
    if (!area) return;
    area.innerHTML = `
      <div class="settings-block" style="border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">${isEdit ? 'Edit User' : 'Add User'}</div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Username <span style="font-weight:400;color:var(--text-muted);font-size:11px;">(Login-ID)</span></label>
          <input class="form-input" type="text" id="uf-username" value="${esc(user?.username || '')}" style="max-width:300px;" autocomplete="off">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Display Name <span style="font-weight:400;color:var(--text-muted);font-size:11px;">(shown in UI)</span></label>
          <input class="form-input" type="text" id="uf-display-name" value="${esc(user?.displayName || '')}" placeholder="${esc(user?.username || '')}" style="max-width:300px;" autocomplete="off">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Email</label>
          <input class="form-input" type="email" id="uf-email" value="${esc(user?.email || '')}" style="max-width:300px;" autocomplete="off">
        </div>
        ${!isEdit ? `
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">Password</label>
          <input class="form-input" type="password" id="uf-password" placeholder="Min 12 characters" style="max-width:300px;" autocomplete="new-password">
        </div>` : ''}
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label">Role</label>
          <select class="form-input" id="uf-role" style="max-width:200px;">
            ${(content._allRoles || []).map(r => `<option value="${esc(r.id)}" ${(user?.role || 'user') === r.id ? 'selected' : ''}>${esc(r.name)}${r.is_system ? '' : ' (custom)'}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" id="uf-save"><i class="fas fa-save"></i> ${isEdit ? 'Save' : 'Create'}</button>
          <button class="btn btn-secondary btn-sm" id="uf-cancel">Cancel</button>
        </div>
        <p class="login-error hidden" id="uf-error" style="margin-top:8px;"></p>
      </div>
    `;

    document.getElementById('uf-cancel')?.addEventListener('click', () => { area.innerHTML = ''; });
    document.getElementById('uf-save')?.addEventListener('click', async () => {
      const btn = document.getElementById('uf-save');
      const errEl = document.getElementById('uf-error');
      errEl.classList.add('hidden');
      const username    = document.getElementById('uf-username').value.trim();
      const displayName = document.getElementById('uf-display-name').value.trim();
      const email       = document.getElementById('uf-email').value.trim();
      const role        = document.getElementById('uf-role').value;
      const password    = isEdit ? null : document.getElementById('uf-password')?.value;

      if (!username) { errEl.textContent = 'Username required'; errEl.classList.remove('hidden'); return; }
      if (!isEdit && (!password || password.length < 12)) {
        errEl.textContent = 'Password must be at least 12 characters';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-sm"></span>';
      try {
        if (isEdit) {
          await api.updateUser(user.id, { username, displayName, email, role });
          showToast(t('user.updated'), 'success');
        } else {
          await api.createUser({ username, displayName, email, password, role });
          showToast(t('user.created'), 'success');
        }
        area.innerHTML = '';
        await renderUsers();
      } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-save"></i> ${isEdit ? 'Save' : 'Create'}`;
      }
    });
  }

  function showResetPasswordForm(userId, username) {
    const area = document.getElementById('users-form-area');
    if (!area) return;
    area.innerHTML = `
      <div class="settings-block" style="border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">Reset Password for <em>${esc(username)}</em></div>
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">New Password</label>
          <input class="form-input" type="password" id="rp-password" placeholder="Min 12 characters" style="max-width:300px;" autocomplete="new-password">
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" id="rp-save"><i class="fas fa-key"></i> Reset Password</button>
          <button class="btn btn-secondary btn-sm" id="rp-cancel">Cancel</button>
        </div>
        <p class="login-error hidden" id="rp-error" style="margin-top:8px;"></p>
      </div>
    `;
    document.getElementById('rp-cancel')?.addEventListener('click', () => { area.innerHTML = ''; });
    document.getElementById('rp-save')?.addEventListener('click', async () => {
      const btn = document.getElementById('rp-save');
      const errEl = document.getElementById('rp-error');
      errEl.classList.add('hidden');
      const password = document.getElementById('rp-password').value;
      if (!password || password.length < 12) {
        errEl.textContent = 'Password must be at least 12 characters';
        errEl.classList.remove('hidden');
        return;
      }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-sm"></span>';
      try {
        await api.resetUserPassword(userId, password);
        showToast(t('user.pwReset'), 'success');
        area.innerHTML = '';
      } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-key"></i> Reset Password';
      }
    });
  }

  await renderUsers();
}

// ============================================================
// Agent Manifest Tab
// ============================================================
async function loadAgentManifestTab() {
  const content = document.getElementById('agent-manifest-content');
  if (!content) return;
  content.dataset.loaded = '1';

  async function renderManifest() {
    let manifest = null;
    let history = [];
    try {
      const [latest, list] = await Promise.all([
        api.getAgentManifest(),
        api.getAgentManifestHistory(30),
      ]);
      manifest = latest;
      history = Array.isArray(list) ? list : [];
    } catch (e) {
      content.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(t('set.agentManifestLoadError'))}: ${esc(e.message)}</div>`;
      return;
    }

    const jsonStr = JSON.stringify(manifest?.content || {}, null, 2);
    content.innerHTML = `
      <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>${t('set.agentManifestTitle')}</span>
        <button class="btn btn-secondary btn-sm" id="btn-agent-manifest-reload"><i class="fas fa-rotate"></i> ${t('set.agentManifestReload')}</button>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px 0;">${t('set.agentManifestHint')}</p>
      <div class="settings-block">
        <div class="settings-row">
          <div class="settings-row-label"><span>${t('set.agentManifestVersion', { version: manifest?.version || 1 })}</span></div>
          <div class="settings-row-control"></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>JSON</span>
          </div>
          <div class="settings-row-control">
            <textarea id="agent-manifest-json" class="form-input" rows="16" style="width:100%;max-width:900px;font-family:var(--font-mono);font-size:12px;line-height:1.4;white-space:pre;">${esc(jsonStr)}</textarea>
          </div>
        </div>
        <div class="settings-row" style="border-bottom:none;">
          <div class="settings-row-label">
            <span>${t('set.agentManifestChangelog')}</span>
          </div>
          <div class="settings-row-control" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input id="agent-manifest-changelog" class="form-input" type="text" placeholder="${t('set.agentManifestChangelogPlaceholder')}" style="max-width:420px;width:100%;">
            <button class="btn btn-primary btn-sm" id="btn-agent-manifest-save"><i class="fas fa-save"></i> ${t('set.agentManifestSave')}</button>
          </div>
        </div>
      </div>

      <div class="settings-group-title" style="margin-top:20px;">${t('set.agentManifestHistory')}</div>
      <div class="settings-block" id="agent-manifest-history">
        ${history.length ? history.map((h, i) => `
          <div class="settings-row" ${i === history.length - 1 ? 'style="border-bottom:none;"' : ''}>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;">v${esc(String(h.version))}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${esc(h.changelog || '—')}</div>
            </div>
            <div style="font-size:11px;color:var(--text-muted);flex-shrink:0;">${esc(h.created_at || '')}</div>
          </div>
        `).join('') : `
          <div class="settings-row" style="border-bottom:none;">
            <div style="padding:14px 0;color:var(--text-muted);font-size:13px;">${t('set.agentManifestNoHistory')}</div>
          </div>
        `}
      </div>
    `;

    document.getElementById('btn-agent-manifest-reload')?.addEventListener('click', renderManifest);
    document.getElementById('btn-agent-manifest-save')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-agent-manifest-save');
      const raw = document.getElementById('agent-manifest-json')?.value || '{}';
      const changelog = document.getElementById('agent-manifest-changelog')?.value || '';
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        showToast(t('set.agentManifestInvalidJson'), 'error');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-sm"></span> ${t('set.saving')}`;
      try {
        await api.saveAgentManifest(parsed, changelog);
        showToast(t('set.agentManifestSaved'), 'success');
        await renderManifest();
      } catch (e) {
        showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-save"></i> ${t('set.agentManifestSave')}`;
      }
    });
  }

  await renderManifest();
}

// ============================================================
// Audit Tab
// ============================================================
async function loadAuditTab() {
  const content = document.getElementById('audit-settings-content');
  if (!content) return;
  content.dataset.loaded = '1';

  let meta = { actions: [], users: [], count: 0 };
  let filters = { action: '', user: '', success: '', from: '', to: '', limit: 100, offset: 0 };
  let allRows = [];

  try { meta = await api.getAuditMeta(); } catch {}

  async function fetchRows(append = false) {
    if (!append) filters.offset = 0;
    const rows = await api.getAuditLog(filters);
    if (append) { allRows = allRows.concat(rows); } else { allRows = rows; }
    return rows.length;
  }

  function renderRows() {
    const list = document.getElementById('audit-list');
    if (!list) return;
    if (allRows.length === 0) {
      list.innerHTML = `
        <div class="settings-row" style="border-bottom:none;">
          <div style="padding:20px 0;color:var(--text-muted);font-size:13px;text-align:center;width:100%;">
            <i class="fas fa-clipboard-list" style="opacity:.4;font-size:1.5rem;margin-bottom:8px;display:block;"></i>
            ${t('set.auditEmpty')}
          </div>
        </div>`;
      return;
    }
    list.innerHTML = allRows.map((r, i) => `
      <div class="settings-row" ${i === allRows.length - 1 ? 'style="border-bottom:none;"' : ''}>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-primary);font-family:var(--font-mono);">${esc(r.action || '')}</span>
            ${r.user ? `<span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--bg-tertiary);color:var(--text-secondary);">${esc(r.user)}</span>` : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;white-space:pre-wrap;word-break:break-word;">${esc(r.detail || '—')}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${t('set.auditIp')}: ${esc(r.ip || '—')}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <span style="font-size:11px;padding:2px 8px;border-radius:999px;${r.success ? 'background:rgba(34,197,94,.14);color:#22c55e;' : 'background:rgba(239,68,68,.14);color:#ef4444;'}">${r.success ? t('set.auditStatusOk') : t('set.auditStatusFailed')}</span>
          <span style="font-size:11px;color:var(--text-muted);">${esc(r.created_at || '')}</span>
        </div>
      </div>
    `).join('');
  }

  async function renderAudit() {
    try {
      await fetchRows();
    } catch (e) {
      content.innerHTML = `<div style="padding:16px;color:var(--offline);font-size:13px;">${esc(t('set.auditLoadError'))}: ${esc(e.message)}</div>`;
      return;
    }

    const actionOpts = meta.actions.map(a => `<option value="${esc(a)}" ${filters.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('');
    const userOpts = meta.users.map(u => `<option value="${esc(u)}" ${filters.user === u ? 'selected' : ''}>${esc(u)}</option>`).join('');

    content.innerHTML = `
      <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <span>${t('set.auditTitle')}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:11px;color:var(--text-muted);">${t('set.auditTotal', { n: meta.count })} · ${t('set.auditRetention')}</span>
          <button class="btn btn-secondary btn-sm" id="btn-refresh-audit"><i class="fas fa-rotate"></i> ${t('set.auditRefresh')}</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;padding:8px 0 12px;">
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${t('set.auditFilterAction')}</label>
          <select id="audit-f-action" class="form-input" style="font-size:12px;min-width:140px;padding:4px 6px;">
            <option value="">${t('set.auditFilterAll')}</option>
            ${actionOpts}
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${t('set.auditFilterUser')}</label>
          <select id="audit-f-user" class="form-input" style="font-size:12px;min-width:120px;padding:4px 6px;">
            <option value="">${t('set.auditFilterAll')}</option>
            ${userOpts}
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${t('set.auditFilterStatus')}</label>
          <select id="audit-f-success" class="form-input" style="font-size:12px;min-width:100px;padding:4px 6px;">
            <option value="">${t('set.auditFilterAll')}</option>
            <option value="1" ${filters.success === '1' ? 'selected' : ''}>${t('set.auditStatusOk')}</option>
            <option value="0" ${filters.success === '0' ? 'selected' : ''}>${t('set.auditStatusFailed')}</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${t('set.auditFilterFrom')}</label>
          <input id="audit-f-from" type="date" class="form-input" style="font-size:12px;padding:4px 6px;" value="${esc(filters.from)}">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${t('set.auditFilterTo')}</label>
          <input id="audit-f-to" type="date" class="form-input" style="font-size:12px;padding:4px 6px;" value="${esc(filters.to)}">
        </div>
        <button class="btn btn-secondary btn-sm" id="audit-f-reset" style="padding:4px 8px;font-size:11px;">${t('set.auditFilterReset')}</button>
      </div>
      <div class="settings-block" id="audit-list"></div>
      <div style="text-align:center;padding:8px 0;" id="audit-more-wrap"></div>
    `;

    renderRows();
    updateMoreBtn();

    const applyFilter = async () => {
      filters.action = document.getElementById('audit-f-action')?.value || '';
      filters.user = document.getElementById('audit-f-user')?.value || '';
      filters.success = document.getElementById('audit-f-success')?.value ?? '';
      filters.from = document.getElementById('audit-f-from')?.value || '';
      filters.to = document.getElementById('audit-f-to')?.value || '';
      try { await fetchRows(); renderRows(); updateMoreBtn(); } catch {}
    };

    ['audit-f-action', 'audit-f-user', 'audit-f-success', 'audit-f-from', 'audit-f-to'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', applyFilter);
    });

    document.getElementById('audit-f-reset')?.addEventListener('click', () => {
      filters = { action: '', user: '', success: '', from: '', to: '', limit: 100, offset: 0 };
      renderAudit();
    });

    document.getElementById('btn-refresh-audit')?.addEventListener('click', async () => {
      try { meta = await api.getAuditMeta(); } catch {}
      renderAudit();
    });

    document.getElementById('btn-audit-more')?.addEventListener('click', loadMore);
  }

  function updateMoreBtn() {
    const wrap = document.getElementById('audit-more-wrap');
    if (!wrap) return;
    wrap.innerHTML = allRows.length >= filters.offset + filters.limit
      ? `<button class="btn btn-secondary btn-sm" id="btn-audit-more">${t('set.auditShowMore')}</button>`
      : '';
    document.getElementById('btn-audit-more')?.addEventListener('click', loadMore);
  }

  async function loadMore() {
    filters.offset = allRows.length;
    try {
      await fetchRows(true);
      renderRows();
      updateMoreBtn();
    } catch {}
  }

  await renderAudit();
}

// ============================================================
// Git Settings Tab
// ============================================================
export async function loadGitSettingsTab() {
  const content = document.getElementById('git-settings-content');
  if (!content) return;
  content.dataset.loaded = '1';

  let cfg = {};
  try { cfg = await api.request('/playbooks-git/config'); } catch (e) { cfg = {}; }

  const configured = cfg && cfg.repoUrl;
  const panel = content.parentElement; // tab-git
  content.innerHTML = configured ? renderGitDashboardPanel(cfg) : renderGitSetupPanel();

  if (configured) {
    _setupGitDashboardEvents(content);
    _loadGitLog(content);
    _loadGitBranches(content, cfg.branch);
  } else {
    _setupGitSetupEvents(content);
  }
}

function renderGitSetupPanel() {
  return `
    <div class="settings-group-title"><i class="fab fa-git-alt"></i> Git Sync</div>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px 0;">
      Connect a remote Git repository to sync playbooks and OpenTofu workspaces automatically.
    </p>

    <form id="git-setup-form">
      <div class="settings-block">
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Repository URL</span>
            <small>HTTPS or SSH remote URL</small>
          </div>
          <div class="settings-row-control">
            <input class="form-input" type="text" id="git-repo-url"
              style="max-width:420px;width:100%;"
              placeholder="https://github.com/user/repo.git">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Auth Token</span>
            <small>HTTPS only — personal access token</small>
          </div>
          <div class="settings-row-control">
            <input class="form-input" type="password" id="git-auth-token"
              style="max-width:420px;width:100%;"
              placeholder="ghp_xxxxxxxxxxxx" autocomplete="off">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>SSH Private Key</span>
            <small>SSH only — paste private key</small>
          </div>
          <div class="settings-row-control">
            <textarea class="form-input" id="git-ssh-key" rows="5"
              style="max-width:420px;width:100%;font-family:var(--font-mono);font-size:11px;resize:vertical;"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Git User Name</span>
            <small>Used for commits</small>
          </div>
          <div class="settings-row-control">
            <input class="form-input" type="text" id="git-user-name"
              style="max-width:220px;width:100%;" placeholder="Shipyard Bot">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Git User Email</span>
            <small>Used for commits</small>
          </div>
          <div class="settings-row-control">
            <input class="form-input" type="email" id="git-user-email"
              style="max-width:280px;width:100%;" placeholder="bot@example.com">
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Auto-pull</span>
            <small>Pull before each run</small>
          </div>
          <div class="settings-row-control">
            <label class="toggle-switch">
              <input type="checkbox" id="git-auto-pull" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span>Auto-push</span>
            <small>Push after every save</small>
          </div>
          <div class="settings-row-control">
            <label class="toggle-switch">
              <input type="checkbox" id="git-auto-push" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label"></div>
          <div class="settings-row-control">
            <button type="submit" class="btn btn-primary btn-sm">
              <i class="fas fa-plug"></i> Connect Repository
            </button>
          </div>
        </div>
      </div>
    </form>`;
}

function renderGitDashboardPanel(cfg) {
  return `
    <div class="settings-group-title"><i class="fab fa-git-alt"></i> Git Sync</div>

    <div class="settings-block">
      <div class="settings-row">
        <div class="settings-row-label">
          <span>Repository</span>
          <small>Connected remote</small>
        </div>
        <div class="settings-row-control" style="gap:12px;">
          <code style="font-size:12px;color:var(--text-muted);word-break:break-all;">${esc(cfg.repoUrl || '')}</code>
          <button id="btn-git-disconnect" class="btn btn-danger btn-sm" style="flex-shrink:0;margin-left:auto;">
            <i class="fas fa-unlink"></i> Disconnect
          </button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          <span>Branch</span>
          <small>Active branch</small>
        </div>
        <div class="settings-row-control" style="gap:8px;">
          <select id="git-branch-select" class="form-input" style="max-width:200px;width:100%;"></select>
          <button id="btn-git-checkout" class="btn btn-secondary btn-sm">Switch</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          <span>Sync</span>
          <small>Manual operations</small>
        </div>
        <div class="settings-row-control" style="gap:8px;flex-wrap:wrap;">
          <button id="btn-git-pull" class="btn btn-secondary btn-sm">
            <i class="fas fa-arrow-down"></i> Pull
          </button>
          <button id="btn-git-push" class="btn btn-secondary btn-sm">
            <i class="fas fa-arrow-up"></i> Push
          </button>
          <span id="git-status-msg" style="font-size:12px;color:var(--text-muted);margin-left:4px;"></span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          <span>Auto-pull</span>
          <small>Pull before each run</small>
        </div>
        <div class="settings-row-control">
          <label class="toggle-switch">
            <input type="checkbox" id="git-auto-pull" ${cfg.autoPull !== false ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          <span>Auto-push</span>
          <small>Push after every save</small>
        </div>
        <div class="settings-row-control">
          <label class="toggle-switch">
            <input type="checkbox" id="git-auto-push" ${cfg.autoPush !== false ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"></div>
        <div class="settings-row-control">
          <button id="btn-git-save-settings" class="btn btn-primary btn-sm">
            <i class="fas fa-save"></i> Save Settings
          </button>
        </div>
      </div>
    </div>

    <div class="settings-group-title" style="margin-top:24px;">Recent Commits</div>
    <div class="settings-block">
      <div class="settings-row" style="justify-content:flex-end;padding:8px 16px;">
        <button id="btn-git-refresh-log" class="btn btn-secondary btn-sm">
          <i class="fas fa-rotate"></i> Refresh
        </button>
      </div>
      <div id="git-log-list" style="padding:0 20px 12px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);line-height:1.8;">
        <div class="loading-state" style="padding:16px;"><div class="loader"></div></div>
      </div>
    </div>`;
}

async function _loadGitLog(panel) {
  const el = panel.querySelector('#git-log-list');
  if (!el) return;
  try {
    const commits = await api.request('/playbooks-git/log');
    if (!Array.isArray(commits) || !commits.length) { el.textContent = 'No commits yet.'; return; }
    el.innerHTML = commits.slice(0, 20).map(c => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
        <code style="color:var(--accent);flex-shrink:0;font-size:11px;">${esc(c.hash)}</code>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--text-primary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.message)}</div>
          <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">
            <i class="fas fa-user" style="font-size:9px;"></i> ${esc(c.author)} &nbsp;·&nbsp; ${esc(c.date)}
          </div>
        </div>
      </div>`).join('');
  } catch (e) {
    el.textContent = 'Could not load log: ' + e.message;
  }
}

async function _loadGitBranches(panel, currentBranch) {
  const sel = panel.querySelector('#git-branch-select');
  if (!sel) return;
  try {
    const data = await api.getGitBranches();
    const all = [...new Set([...(data.local || []), ...(data.remote || []).map(b => b.replace(/^origin\//, ''))])];
    sel.innerHTML = all.map(b => `<option value="${esc(b)}" ${b === currentBranch ? 'selected' : ''}>${esc(b)}</option>`).join('');
  } catch (e) {
    sel.innerHTML = `<option>main</option>`;
  }
}

function _setupGitSetupEvents(panel) {
  panel.querySelector('#git-setup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = panel.querySelector('[type=submit]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> Connecting…`;
    try {
      await api.request('/playbooks-git/setup', {
        method: 'POST',
        body: {
          repoUrl:   panel.querySelector('#git-repo-url').value.trim(),
          authToken: panel.querySelector('#git-auth-token').value.trim(),
          sshKey:    panel.querySelector('#git-ssh-key').value.trim(),
          userName:  panel.querySelector('#git-user-name').value.trim(),
          userEmail: panel.querySelector('#git-user-email').value.trim(),
          autoPull:  panel.querySelector('#git-auto-pull').checked,
          autoPush:  panel.querySelector('#git-auto-push').checked,
        },
      });
      showToast(t('git.connected'), 'success');
      await loadGitSettingsTab();
    } catch (e) {
      showToast(t('common.errorPrefix', { msg: e.message }), 'error');
      btn.disabled = false;
      btn.innerHTML = `<i class="fas fa-plug"></i> Connect Repository`;
    }
  });
}

function _setupGitDashboardEvents(panel) {
  panel.querySelector('#btn-git-disconnect')?.addEventListener('click', async () => {
    if (!await showConfirm('Disconnect Git? This will not delete your remote repository.')) return;
    await api.request('/playbooks-git/disconnect', { method: 'POST' });
    showToast(t('git.disconnected'), 'success');
    await loadGitSettingsTab();
  });

  panel.querySelector('#btn-git-pull')?.addEventListener('click', async () => {
    const msg = panel.querySelector('#git-status-msg');
    msg.textContent = 'Pulling…';
    try {
      await api.request('/playbooks-git/pull', { method: 'POST' });
      msg.textContent = 'Pull successful.';
      await _loadGitLog(panel);
    } catch (e) { msg.textContent = 'Pull failed: ' + e.message; }
  });

  panel.querySelector('#btn-git-push')?.addEventListener('click', async () => {
    const msg = panel.querySelector('#git-status-msg');
    msg.textContent = 'Pushing…';
    try {
      await api.request('/playbooks-git/push', { method: 'POST' });
      msg.textContent = 'Pushed to git.';
      _loadGitLog(panel);
    } catch (e) { msg.textContent = 'Push failed: ' + e.message; }
  });

  panel.querySelector('#btn-git-checkout')?.addEventListener('click', async () => {
    const sel = panel.querySelector('#git-branch-select');
    const branch = sel?.value;
    if (!branch) return;
    const msg = panel.querySelector('#git-status-msg');
    msg.textContent = `Switching to ${branch}…`;
    try {
      await api.gitCheckout(branch);
      msg.textContent = `Switched to ${branch}.`;
    } catch (e) { msg.textContent = 'Checkout failed: ' + e.message; }
  });

  panel.querySelector('#btn-git-refresh-log')?.addEventListener('click', () => _loadGitLog(panel));

  panel.querySelector('#btn-git-save-settings')?.addEventListener('click', async () => {
    try {
      await api.request('/playbooks-git/settings', {
        method: 'POST',
        body: {
          autoPull: panel.querySelector('#git-auto-pull').checked,
          autoPush: panel.querySelector('#git-auto-push').checked,
        },
      });
      showToast(t('git.saved'), 'success');
    } catch (e) { showToast(t('common.errorPrefix', { msg: e.message }), 'error'); }
  });
}
