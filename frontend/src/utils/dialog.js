const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const dialogStack = [];

function isVisible(element) {
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => isVisible(element));
}

export function activateDialog({ dialog, initialFocus = null, onClose = null, labelledBy = '', label = '' }) {
  if (!dialog) return () => {};

  const previousActiveElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
  if (label) dialog.setAttribute('aria-label', label);
  if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;

  const focusDialog = () => {
    let target = null;

    if (typeof initialFocus === 'function') {
      target = initialFocus();
    } else if (typeof initialFocus === 'string') {
      target = dialog.querySelector(initialFocus);
    } else {
      target = initialFocus;
    }

    if (!(target instanceof HTMLElement) || !dialog.contains(target) || !isVisible(target)) {
      target = getFocusableElements(dialog)[0] || dialog;
    }

    window.requestAnimationFrame(() => {
      target.focus();
    });
  };

  const onKeyDown = (event) => {
    if (!document.body.contains(dialog)) return;
    if (dialogStack[dialogStack.length - 1] !== dialog) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey) {
      if (activeElement === first || !dialog.contains(activeElement)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (activeElement === last || !dialog.contains(activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  dialogStack.push(dialog);
  document.addEventListener('keydown', onKeyDown);
  focusDialog();

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    const index = dialogStack.lastIndexOf(dialog);
    if (index !== -1) dialogStack.splice(index, 1);
    if (previousActiveElement && document.contains(previousActiveElement)) {
      previousActiveElement.focus();
    }
  };
}
