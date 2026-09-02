// @ts-check
'use strict';

const net = require('net');

const PROVISION_PLAYBOOK_RE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ya?ml$/;
const DIRECT_IP_KEYS = [
  'shipyard_ip',
  'ip_address',
  'ip',
  'default_ipv4_address',
  'primary_ipv4_address',
  'public_ip',
  'private_ip',
  'ipv4_address',
  'access_ip_v4',
  'main_ip',
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// `tofu destroy -auto-approve` is deliberately used for non-interactive runs.
// Never rely on the browser confirmation alone: the API may be called directly
// or from an outdated client.  A workspace-bound phrase makes the destructive
// operation explicit and prevents a generic accidental POST from deleting an
// entire workspace.
function destroyConfirmationPhrase(workspaceName) {
  return `DESTROY ${String(workspaceName || '').trim()}`;
}

function hasValidDestroyConfirmation(value, workspaceName) {
  return typeof value === 'string' && value === destroyConfirmationPhrase(workspaceName);
}

function destroyVmConfirmationPhrase(workspaceName, vmName) {
  return `DESTROY ${String(workspaceName || '').trim()}/${String(vmName || '').trim()}`;
}

function hasValidDestroyVmConfirmation(value, workspaceName, vmName) {
  return typeof value === 'string' && value === destroyVmConfirmationPhrase(workspaceName, vmName);
}

function normalizePostDeployPlaybooks(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw new Error('Post-deploy playbooks must be provided as a list');
  if (value.length > 12) throw new Error('At most 12 post-deploy playbooks may be selected');
  const unique = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new Error('Invalid post-deploy playbook');
    const playbook = raw.trim();
    if (!PROVISION_PLAYBOOK_RE.test(playbook)) throw new Error(`Invalid playbook name: ${playbook || 'empty'}`);
    if (!unique.includes(playbook)) unique.push(playbook);
  }
  return unique;
}

// Proxmox uses `disk: 0` for QEMU guests when it has no usable guest usage
// measurement. LXC disk usage is host-observable, so a real zero remains valid.
function normalizeProxmoxDiskUsage(resource, guestType) {
  const disk = Number(resource?.disk);
  const maxdisk = Number(resource?.maxdisk) || 0;
  const reported = resource?.disk != null
    && resource.disk !== ''
    && Number.isFinite(disk)
    && !(guestType === 'qemu' && disk === 0 && maxdisk > 0);
  return { disk: reported ? disk : null, maxdisk };
}

function uniqueStrings(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const num = Number.parseInt(value, 10);
    if (Number.isInteger(num) && num >= 1 && num <= 65535) return num;
  }
  return null;
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = trimmed.split('/')[0].trim();
  if (net.isIP(direct)) return direct;

  const match = trimmed.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (match && net.isIP(match[0])) return match[0];

  const ipv6Match = trimmed.match(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/i);
  if (ipv6Match && net.isIP(ipv6Match[0])) return ipv6Match[0];

  return null;
}

function isUsableGuestIp(ip) {
  if (!ip) return false;
  if (net.isIP(ip) === 4) return !ip.startsWith('127.') && !ip.startsWith('169.254.');
  if (net.isIP(ip) === 6) return ip !== '::1' && !ip.toLowerCase().startsWith('fe80:');
  return false;
}

function collectUsableIps(value, output = [], depth = 0) {
  if (depth > 6 || value == null) return output;
  if (typeof value === 'string') {
    const ip = normalizeIp(value);
    if (isUsableGuestIp(ip) && !output.includes(ip)) output.push(ip);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectUsableIps(item, output, depth + 1));
    return output;
  }
  if (isPlainObject(value)) Object.values(value).forEach(item => collectUsableIps(item, output, depth + 1));
  return output;
}

function findFirstIp(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') {
    const ip = normalizeIp(value);
    return isUsableGuestIp(ip) ? ip : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ip = findFirstIp(item, depth + 1);
      if (ip) return ip;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;

  for (const key of DIRECT_IP_KEYS) {
    if (key in value) {
      const ip = findFirstIp(value[key], depth + 1);
      if (ip) return ip;
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (!/ip|addr|address|network/i.test(key)) continue;
    const ip = findFirstIp(nested, depth + 1);
    if (ip) return ip;
  }

  for (const nested of Object.values(value)) {
    const ip = findFirstIp(nested, depth + 1);
    if (ip) return ip;
  }

  return null;
}

function flattenStateResources(moduleNode, out = []) {
  if (!moduleNode || typeof moduleNode !== 'object') return out;
  if (Array.isArray(moduleNode.resources)) out.push(...moduleNode.resources);
  if (Array.isArray(moduleNode.child_modules)) {
    for (const child of moduleNode.child_modules) flattenStateResources(child, out);
  }
  return out;
}

module.exports = {
  collectUsableIps,
  DIRECT_IP_KEYS,
  destroyConfirmationPhrase,
  destroyVmConfirmationPhrase,
  escapeRegExp,
  findFirstIp,
  firstNonEmptyString,
  firstNumber,
  flattenStateResources,
  hasValidDestroyConfirmation,
  hasValidDestroyVmConfirmation,
  isPlainObject,
  isUsableGuestIp,
  normalizeIp,
  normalizePostDeployPlaybooks,
  normalizeProxmoxDiskUsage,
  parseJsonArray,
  sleep,
  uniqueStrings,
};
