'use strict';

// Tells the UI when a newer stable Fleet release is published. Only the
// public GitHub release list is contacted; nothing about the installation is sent.
const log = require('../utils/logger').child('release-check');
const { version: RUNNING_VERSION } = require('../package.json');

const REPOSITORY = 'tobayashi-san/Fleet';
const CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
let cached = null;
let pending = null;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/);
  return match ? { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null;
}

/** True when `candidate` is a stable release newer than `current`. */
function isNewerStable(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now || next.prerelease) return false;
  for (let i = 0; i < 3; i++) {
    if (next.parts[i] !== now.parts[i]) return next.parts[i] > now.parts[i];
  }
  // Same numbers: the final release is newer than its release candidates.
  return now.prerelease;
}

async function fetchLatestRelease() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Fleet' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  // /releases/latest never returns drafts or pre-releases.
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GitHub responded with HTTP ${response.status}`);
  const release = await response.json();
  if (typeof release?.tag_name !== 'string') throw new Error('Release tag missing');
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${REPOSITORY}/`) ? release.html_url : `https://github.com/${REPOSITORY}/releases`;
  return { version: release.tag_name.replace(/^v/i, ''), url };
}

async function releaseStatus() {
  const base = { current: RUNNING_VERSION, enabled: process.env.FLEET_UPDATE_CHECK !== '0' };
  if (!base.enabled) return { ...base, latest: null, update_available: false };
  if (!cached || Date.now() > cached.expires) {
    pending ||= fetchLatestRelease()
      .then(latest => { cached = { latest, expires: Date.now() + CACHE_MS }; })
      .catch(error => {
        log.debug({ err: error }, 'Release check failed');
        cached = { latest: cached?.latest || null, expires: Date.now() + RETRY_MS };
      })
      .finally(() => { pending = null; });
    await pending;
  }
  const latest = cached?.latest || null;
  return { ...base, latest: latest?.version || null, url: latest?.url || null, update_available: Boolean(latest && isNewerStable(latest.version, RUNNING_VERSION)) };
}

module.exports = { isNewerStable, releaseStatus };
