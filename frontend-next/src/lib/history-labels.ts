import type { TFunction } from 'i18next';

/**
 * Translate a backend `update_history.action` string into a human-readable label.
 * Resource names and playbook filenames remain intact; unknown codes become readable labels.
 */
export function actionLabel(t: TFunction, action: string | null | undefined): string {
  if (!action) return '—';

  // Exact matches
  switch (action) {
    case 'system_update':     return t('hist.actSystemUpdate');
    case 'system_update_all': return t('hist.actSystemUpdateAll');
    case 'reboot':            return t('hist.actReboot');
  }

  // Prefix matches
  if (action.startsWith('custom_update:')) {
    return t('hist.actCustomUpdate', { name: action.slice('custom_update:'.length) });
  }
  if (action.startsWith('ansible:')) {
    return t('hist.actAnsible', { name: action.slice('ansible:'.length) });
  }
  if (action.startsWith('restart_docker_')) {
    return t('hist.actDockerRestart', { name: action.slice('restart_docker_'.length) });
  }
  if (action.startsWith('compose_pull_')) {
    return `Pull container images · ${action.slice('compose_pull_'.length)}`;
  }
  if (action.startsWith('compose_up_')) {
    return t('hist.actComposeUp', { name: action.slice('compose_up_'.length) });
  }
  if (action.startsWith('compose_down_')) {
    return t('hist.actComposeDown', { name: action.slice('compose_down_'.length) });
  }
  if (action.startsWith('compose_restart_')) {
    return t('hist.actComposeRestart', { name: action.slice('compose_restart_'.length) });
  }

  if (/\.ya?ml$/i.test(action)) return t('hist.actAnsible', { name: action });
  return action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._:-]+/g, ' ').trim().replace(/^./, letter => letter.toUpperCase());
}

/**
 * Translate a backend `update_history.status` string into a human-readable label.
 */
export function statusLabel(t: TFunction, status: string | null | undefined): string {
  if (!status) return '—';
  switch (status) {
    case 'success': return t('hist.success');
    case 'failed':  return t('hist.failed');
    case 'running': return t('hist.running');
    case 'queued': return 'Queued';
    case 'cancelling': return 'Cancelling';
    case 'skipped': return 'Skipped';
    case 'cancelled':
    case 'canceled': return 'Cancelled';
    case 'unknown': return 'Unknown';
    case 'interrupted': return 'Interrupted';
    case 'pending': return t('hist.pending');
    default:        return status;
  }
}
