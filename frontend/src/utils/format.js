import DOMPurify from 'dompurify';

/** Escape HTML special characters to prevent XSS (Fallback für kleine Strings) */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Sanitize an entire block of HTML before inserting it into the DOM */
export function sanitizeHTML(htmlText) {
  return DOMPurify.sanitize(htmlText);
}

function toUtcDate(s) {
  if (!s) return new Date(NaN);
  const str = String(s);
  return new Date(!str.endsWith('Z') ? str.replace(' ', 'T') + 'Z' : str);
}

function h12() {
  return (localStorage.getItem('timeFormat') || '24h') === '12h';
}

/** 15. Jan 2025, 14:30  (with year) */
export function formatDateTimeFull(dateStr) {
  if (!dateStr) return '—';
  try {
    return toUtcDate(dateStr).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: h12(),
    });
  } catch { return String(dateStr); }
}

/** 15. Jan, 14:30  (without year) */
export function formatDateTimeShort(dateStr) {
  if (!dateStr) return '—';
  try {
    return toUtcDate(dateStr).toLocaleString(undefined, {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: h12(),
    });
  } catch { return String(dateStr); }
}

/** current time string */
export function formatCurrentTime() {
  return new Date().toLocaleTimeString(undefined, { hour12: h12() });
}
