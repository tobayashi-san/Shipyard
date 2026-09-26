'use strict';

// Decrypt a saved platform connection. Every caller must honour the stored CA
// certificate, or a platform with a private CA works in one view and fails in another.
const cryptoUtil = require('../../utils/crypto');
const { createProxmoxConnection } = require('./proxmox-client');

function readSavedProxmoxConnection(row) {
  const token = cryptoUtil.decrypt(String(row?.api_token || ''));
  if (!token || String(token).startsWith('enc:')) throw new Error(`Credentials for Proxmox connection "${row?.name || 'unknown'}" cannot be read.`);
  const caCertificate = row.ca_certificate ? cryptoUtil.decrypt(String(row.ca_certificate)) : '';
  return createProxmoxConnection(row.endpoint, token, Boolean(row.insecure), caCertificate);
}

module.exports = { readSavedProxmoxConnection };
