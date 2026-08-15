// @ts-check
'use strict';

const https = require('https');
const http  = require('http');

/** @typedef {import('./types').ProxmoxConnection} ProxmoxConnection */

function _downloadFile(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'shipyard-lab-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        _downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = require('fs').createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function _fetchGitHubReleases() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/opentofu/opentofu/releases?per_page=15',
      headers: { 'User-Agent': 'shipyard-lab-manager' },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          if (!Array.isArray(list)) { reject(new Error(list.message || 'GitHub API error')); return; }
          const versions = list
            .filter(r => !r.prerelease && !r.draft)
            .map(r => r.tag_name.replace(/^v/, ''))
            .filter(v => /^\d+\.\d+\.\d+$/.test(v));
          resolve(versions);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/** @returns {ProxmoxConnection} */
function createProxmoxConnection(endpointInput, apiTokenInput, insecureInput = false) {
  const endpoint = String(endpointInput || '').trim();
  const apiToken = String(apiTokenInput || '').trim();
  const insecureRaw = String(insecureInput || '').trim().toLowerCase();
  if (!endpoint || !apiToken) {
    throw new Error('The Proxmox API endpoint or API token is not configured.');
  }
  let base;
  try { base = new URL(endpoint); }
  catch { throw new Error('The Proxmox API URL is invalid.'); }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('The Proxmox API must use an HTTPS URL without embedded credentials.');
  }
  return {
    base,
    apiToken,
    insecure: insecureInput === true || ['1', 'true', 'yes', 'on'].includes(insecureRaw),
  };
}

function readProxmoxConnection(envVars = {}) {
  return createProxmoxConnection(
    envVars.TF_VAR_proxmox_endpoint || envVars.PROXMOX_ENDPOINT,
    envVars.TF_VAR_proxmox_api_token || envVars.PROXMOX_API_TOKEN,
    envVars.TF_VAR_proxmox_insecure || envVars.PROXMOX_INSECURE,
  );
}

/** @param {ProxmoxConnection} connection @param {string} apiPath */
function proxmoxApiUrl(connection, apiPath) {
  const url = new URL(connection.base.toString());
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/api2\/json$/, '');
  const [resourcePath, query = ''] = String(apiPath).split('?', 2);
  url.pathname = `${basePath}/api2/json/${resourcePath.replace(/^\/+/, '')}`;
  url.search = query ? `?${query}` : '';
  return url;
}

/**
 * @param {ProxmoxConnection} connection
 * @param {string} apiPath
 * @param {{method?: string, payload?: Record<string, unknown> | null}} [options]
 */
function requestProxmoxApi(connection, apiPath, { method = 'GET', payload = null } = {}) {
  const url = proxmoxApiUrl(connection, apiPath);
  const body = payload && typeof payload === 'object'
    ? new URLSearchParams(Object.entries(payload)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])).toString()
    : '';
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `PVEAPIToken=${connection.apiToken}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      rejectUnauthorized: !connection.insecure,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`The Proxmox API responded with HTTP ${response.statusCode}.`));
          return;
        }
        try {
          const payload = JSON.parse(body || '{}');
          if (payload?.errors) throw new Error('The Proxmox API rejected the request.');
          resolve(payload?.data);
        } catch (error) {
          reject(error.message ? error : new Error('Invalid response from the Proxmox API.'));
        }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('The Proxmox API request timed out.')));
    request.on('error', error => reject(new Error(/** @type {NodeJS.ErrnoException} */ (error).code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
      ? 'The Proxmox certificate is not trusted. Set TF_VAR_proxmox_insecure=true or use a valid certificate.'
      : 'The Proxmox API is unreachable.')));
    if (body) request.write(body);
    request.end();
  });
}

module.exports = {
  createProxmoxConnection,
  downloadFile: _downloadFile,
  fetchOpenTofuReleases: _fetchGitHubReleases,
  proxmoxApiUrl,
  readProxmoxConnection,
  requestProxmoxApi,
};
