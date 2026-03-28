import { api } from '../api.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

export function showAddServerModal(onSuccess, editServer = null) {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');

  const isEdit = !!editServer;
  const title = isEdit ? `<i class="fas fa-edit"></i> ${t('add.titleEdit')}` : `<i class="fas fa-plus"></i> ${t('add.titleAdd')}`;

  overlay.innerHTML = `
    <div class="modal">
      <h2>${title}</h2>
      <div class="form-body">
        <form id="server-form">
          <div class="form-group">
            <label class="form-label">${t('add.name')}</label>
            <input class="form-input" type="text" id="server-name" placeholder="${t('add.namePlaceholder')}" value="${esc(editServer?.name || '')}" required>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t('add.ip')}</label>
              <input class="form-input" type="text" id="server-ip" placeholder="192.168.1.100" value="${esc(editServer?.ip_address || '')}" required>
            </div>
            <div class="form-group">
              <label class="form-label">${t('add.hostname')}</label>
              <input class="form-input" type="text" id="server-hostname" placeholder="plex-server" value="${esc(editServer?.hostname || '')}">
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${t('add.sshUser')}</label>
              <input class="form-input" type="text" id="server-user" placeholder="root" value="${esc(editServer?.ssh_user || 'root')}">
            </div>
            <div class="form-group">
              <label class="form-label">${t('add.sshPort')}</label>
              <input class="form-input" type="number" id="server-port" placeholder="22" value="${editServer?.ssh_port || 22}">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">${t('add.services')}</label>
            <input class="form-input" type="text" id="server-services" placeholder="Plex, Docker, Nginx" value="${esc((editServer?.services || []).join(', '))}">
            <div class="form-hint">${t('add.servicesHint')}</div>
          </div>

          <div class="form-group">
            <label class="form-label">${t('add.tags')}</label>
            <input class="form-input" type="text" id="server-tags" placeholder="production, media" value="${esc((editServer?.tags || []).join(', '))}">
            <div class="form-hint">${t('add.tagsHint')}</div>
          </div>

          ${!isEdit ? `
            <div class="form-group" style="padding:14px;background:var(--bg-row-alt);border-radius:var(--radius-sm);border:1px solid var(--border);">
              <label class="form-label" style="margin-bottom:6px;"><i class="fas fa-key"></i> ${t('add.sshKeySection')}</label>
              <div class="form-hint" style="margin-bottom:10px;">${t('add.sshKeyHint')}</div>
              <input class="form-input" type="password" id="server-password" placeholder="${t('add.sshPasswordPlaceholder')}">
            </div>
          ` : ''}

          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="btn-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn-primary" id="btn-submit">
              ${isEdit ? t('common.save') : t('common.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Close modal
  document.getElementById('btn-cancel').addEventListener('click', () => {
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    }
  });

  // Submit
  document.getElementById('server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-sm"></span> ${t('add.saving')}`;

    const data = {
      name: document.getElementById('server-name').value.trim(),
      ip_address: document.getElementById('server-ip').value.trim(),
      hostname: document.getElementById('server-hostname').value.trim() || document.getElementById('server-ip').value.trim(),
      ssh_user: document.getElementById('server-user').value.trim() || 'root',
      ssh_port: Math.min(65535, Math.max(1, parseInt(document.getElementById('server-port').value) || 22)),
      services: document.getElementById('server-services').value.split(',').map(s => s.trim()).filter(Boolean),
      tags: document.getElementById('server-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    };

    try {
      let savedServer = null;
      if (isEdit) {
        savedServer = await api.updateServer(editServer.id, data);
        showToast(t('add.saved', { name: data.name }), 'success');
      } else {
        const server = await api.createServer(data);
        savedServer = server;

        // Deploy SSH key if password provided
        const password = document.getElementById('server-password')?.value;
        if (password) {
          try {
            btn.innerHTML = `<span class="spinner-sm"></span> ${t('add.transferring')}`;
            await api.deploySSHKey({
              ip_address: data.ip_address,
              ssh_user: data.ssh_user,
              password: password,
              ssh_port: data.ssh_port,
            });
            showToast(t('add.transferred'), 'success');
          } catch (err) {
            showToast(t('add.transferError', { msg: err.message }), 'warning');
          }
        }

        showToast(t('add.added', { name: data.name }), 'success');
      }

      overlay.classList.add('hidden');
      overlay.innerHTML = '';
      if (onSuccess) await onSuccess(savedServer);
    } catch (error) {
      showToast(t('common.errorPrefix', { msg: error.message }), 'error');
      btn.disabled = false;
      btn.innerHTML = isEdit ? t('common.save') : t('common.add');
    }
  });

  // Focus first field
  setTimeout(() => document.getElementById('server-name')?.focus(), 100);
}
