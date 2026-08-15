const MAX_EMAIL_LENGTH = 254;

function isValidEmail(value) {
  if (value.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain.includes('.')) return false;
  if (local.startsWith('.') || local.endsWith('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

// Empty mail addresses are valid for accounts that do not use notifications.
// Other values are normalised once at the HTTP boundary before persistence.
function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return { error: 'email must be a string' };
  const normalized = value.trim().toLowerCase();
  if (normalized && !isValidEmail(normalized)) return { error: 'Invalid email address' };
  return normalized;
}

module.exports = { MAX_EMAIL_LENGTH, isValidEmail, normalizeEmail };
