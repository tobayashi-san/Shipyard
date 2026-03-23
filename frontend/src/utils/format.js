import { state } from '../main.js';
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
  return state.whiteLabel?.timeFormat === '12h';
}

/** dd.mm.yyyy hh:mm  (with year) */
export function formatDateTimeFull(dateStr) {
  if (!dateStr) return '—';
  try {
    return toUtcDate(dateStr).toLocaleString(undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: h12(),
    });
  } catch { return String(dateStr); }
}

/** dd.mm. hh:mm  (without year) */
export function formatDateTimeShort(dateStr) {
  if (!dateStr) return '—';
  try {
    return toUtcDate(dateStr).toLocaleString(undefined, {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: h12(),
    });
  } catch { return String(dateStr); }
}

/** current time string */
export function formatCurrentTime() {
  return new Date().toLocaleTimeString(undefined, { hour12: h12() });
}
