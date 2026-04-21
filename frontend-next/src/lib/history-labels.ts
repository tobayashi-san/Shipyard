import type { TFunction } from 'i18next';

/**
 * Translate a backend `update_history.action` string into a human-readable label.
 * Unknown actions are returned verbatim so the UI never silently drops information.
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
  if (action.startsWith('compose_up_')) {
    return t('hist.actComposeUp', { name: action.slice('compose_up_'.length) });
  }
  if (action.startsWith('compose_down_')) {
    return t('hist.actComposeDown', { name: action.slice('compose_down_'.length) });
  }
  if (action.startsWith('compose_restart_')) {
    return t('hist.actComposeRestart', { name: action.slice('compose_restart_'.length) });
  }

  // Fallback: raw action string
  return action;
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
    case 'pending': return t('hist.pending');
    default:        return status;
  }
}
