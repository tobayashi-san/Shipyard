'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolated DB per test file
const tmpDb = path.join(os.tmpdir(), `shipyard-git-validate-${process.pid}.db`);
try { fs.unlinkSync(tmpDb); } catch {}
process.env.DB_PATH = tmpDb;
process.env.SHIPYARD_KEY_SECRET = 'test-secret-for-git-validation';

const { validateGitUrl, validateBranchName } = require('../services/git-sync');

test('validateGitUrl accepts https URLs', () => {
  assert.equal(validateGitUrl('https://github.com/user/repo.git').ok, true);
  assert.equal(validateGitUrl('http://gitea.local/u/r').ok, true);
});

test('validateGitUrl accepts ssh:// URLs', () => {
  assert.equal(validateGitUrl('ssh://git@github.com:22/user/repo.git').ok, true);
});

test('validateGitUrl accepts SCP-like URLs', () => {
  assert.equal(validateGitUrl('git@github.com:user/repo.git').ok, true);
  assert.equal(validateGitUrl('deploy@host.example.com:path/to/repo').ok, true);
});

test('validateGitUrl rejects file:// scheme', () => {
  const r = validateGitUrl('file:///etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error, /scheme/i);
});

test('validateGitUrl rejects unknown schemes', () => {
  assert.equal(validateGitUrl('ftp://example.com/repo').ok, false);
  assert.equal(validateGitUrl('javascript:alert(1)').ok, false);
});

test('validateGitUrl rejects URLs starting with hyphen (CVE-2017-1000117 class)', () => {
  const r = validateGitUrl('-uHelpful https://example.com');
  assert.equal(r.ok, false);
});

test('validateGitUrl rejects hosts starting with hyphen', () => {
  assert.equal(validateGitUrl('https://-malicious/repo.git').ok, false);
  assert.equal(validateGitUrl('git@-oProxyCommand=bad:repo.git').ok, false);
  assert.equal(validateGitUrl('ssh://git@-x/repo').ok, false);
});

test('validateGitUrl rejects whitespace and control chars', () => {
  assert.equal(validateGitUrl('https://example.com/repo with space').ok, false);
  assert.equal(validateGitUrl('https://example.com/\nrepo').ok, false);
  assert.equal(validateGitUrl('https://example.com/\x00repo').ok, false);
});

test('validateGitUrl rejects embedded credentials in https URLs', () => {
  const r = validateGitUrl('https://user:token@github.com/u/r.git');
  assert.equal(r.ok, false);
  assert.match(r.error, /authToken/);
});

test('validateGitUrl rejects empty/missing input', () => {
  assert.equal(validateGitUrl('').ok, false);
  assert.equal(validateGitUrl(null).ok, false);
  assert.equal(validateGitUrl(undefined).ok, false);
  assert.equal(validateGitUrl('   ').ok, false);
});

test('validateGitUrl rejects overly long URLs', () => {
  const url = 'https://example.com/' + 'a'.repeat(3000);
  assert.equal(validateGitUrl(url).ok, false);
});

test('validateBranchName accepts standard branch names', () => {
  assert.equal(validateBranchName('main'), true);
  assert.equal(validateBranchName('feature/foo-bar'), true);
  assert.equal(validateBranchName('release-1.2.3'), true);
});

test('validateBranchName rejects names starting with hyphen', () => {
  assert.equal(validateBranchName('-rf'), false);
  assert.equal(validateBranchName('--upload-pack=evil'), false);
});

test('validateBranchName rejects names with traversal-like patterns', () => {
  assert.equal(validateBranchName('foo..bar'), false);
  assert.equal(validateBranchName('.hidden'), false);
  assert.equal(validateBranchName('foo/'), false);
  assert.equal(validateBranchName('foo.lock'), false);
});

test('validateBranchName rejects empty/non-strings', () => {
  assert.equal(validateBranchName(''), false);
  assert.equal(validateBranchName(null), false);
  assert.equal(validateBranchName(123), false);
});

test('validateBranchName rejects shell metacharacters', () => {
  assert.equal(validateBranchName('foo;rm -rf /'), false);
  assert.equal(validateBranchName('foo bar'), false);
  assert.equal(validateBranchName('foo$bar'), false);
});
