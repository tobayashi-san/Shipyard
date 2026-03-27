import { showToast } from './toast.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { esc } from '../utils/format.js';

export function setupComposeModal() {
  const overlay = document.getElementById('compose-modal-overlay');
  const closeBtn = document.getElementById('close-compose-modal');
  const cancelBtn = document.getElementById('cancel-compose-btn');
  const form = document.getElementById('compose-form');

  const titleEl = document.getElementById('compose-modal-title');
  const pathInput = document.getElementById('compose-path');
  const editor = document.getElementById('compose-editor');
  const loading = document.getElementById('compose-loading');
  const saveBtn = document.getElementById('save-compose-btn');

  let currentServerId = null;

  function closeModal() {
    overlay.classList.add('hidden');
    setTimeout(() => {
      pathInput.value = '';
      editor.value = '';
      currentServerId = null;
    }, 300);
  }

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('open-compose-modal', async (e) => {
    const { serverId, project, dir, isNew } = e.detail;
    currentServerId = serverId;

    titleEl.innerHTML = isNew
      ? `<i class="fas fa-plus-circle"></i> ${t('compose.newStack')}`
      : `<i class="fas fa-edit"></i> ${t('compose.edit', { project: esc(project) })}`;
    pathInput.value = dir;
    pathInput.disabled = !isNew;

    overlay.classList.remove('hidden');

    if (isNew) {
      editor.value = "services:\n  app:\n    image: nginx:latest\n    ports:\n      - \"8080:80\"";
      editor.classList.remove('hidden');
      loading.classList.add('hidden');
      saveBtn.disabled = false;
    } else {
      editor.classList.add('hidden');
      loading.classList.remove('hidden');
      saveBtn.disabled = true;

      try {
        const res = await api.getDockerCompose(serverId, dir);
        editor.value = res.content;
      } catch (err) {
        showToast(t('compose.loadError', { msg: err.message }), 'error');
        closeModal();
        return;
      } finally {
        loading.classList.add('hidden');
        editor.classList.remove('hidden');
        saveBtn.disabled = false;
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentServerId) return;

    const path = pathInput.value.trim();
    const content = editor.value;

    if (!path || !content) {
      showToast(t('compose.emptyError'), 'warning');
      return;
    }

    const originalBtnHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="spinner-sm"></span> ${t('compose.saving')}`;

    try {
      await api.writeDockerCompose(currentServerId, path, content);
      if (!pathInput.disabled) {
        showToast(t('compose.savedStarting'), 'success');
        await api.runDockerComposeAction(currentServerId, path, 'up');
      } else {
        showToast(t('compose.saved'), 'success');
      }
      closeModal();
    } catch (err) {
      showToast(t('compose.saveError', { msg: err.message }), 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtnHtml;
    }
  });
}
