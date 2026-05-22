'use strict';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

function normalizeUsername(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!username) return 'username required';
  if (!USERNAME_RE.test(username)) return 'Username must be 3-32 characters (letters, digits, . _ -)';
  return null;
}

module.exports = { normalizeUsername, validateUsername };
