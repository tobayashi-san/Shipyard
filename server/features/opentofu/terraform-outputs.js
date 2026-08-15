// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { escapeRegExp } = require('./core-utils');

const SHIPYARD_OUTPUT_BLOCK_START = '# BEGIN SHIPYARD MANAGED OUTPUT';
const SHIPYARD_OUTPUT_BLOCK_END = '# END SHIPYARD MANAGED OUTPUT';
const SHIPYARD_OUTPUT_GENERATORS = {
  proxmox_virtual_environment_vm: {
    providerTag: 'proxmox',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    // The bpg/proxmox provider returns a nested list and its interface index is
    // not stable. Flatten it so the managed output keeps working for both a
    // single NIC and multi-NIC guests.
    ipExpr: (address) => `try([for ip in flatten(${address}.ipv4_addresses) : ip if !startswith(ip, "127.") && !startswith(ip, "169.254.")][0], null)`,
  },
  hcloud_server: {
    providerTag: 'hcloud',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.ipv4_address, null)`,
  },
  digitalocean_droplet: {
    providerTag: 'digitalocean',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.ipv4_address, null)`,
  },
  aws_instance: {
    providerTag: 'aws',
    sshUser: 'ec2-user',
    nameExpr: (address, name) => `try(${address}.tags["Name"], ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.public_ip, ${address}.private_ip, null)`,
  },
  google_compute_instance: {
    providerTag: 'gcp',
    sshUser: 'root',
    nameExpr: (address, name) => `try(${address}.name, ${JSON.stringify(name)})`,
    ipExpr: (address) => `try(${address}.network_interface[0].access_config[0].nat_ip, ${address}.network_interface[0].network_ip, null)`,
  },
};

function readTerraformFiles(wsPath) {
  if (!fs.existsSync(wsPath)) return [];
  return fs.readdirSync(wsPath)
    .filter(name => name.endsWith('.tf'))
    .sort()
    .map(name => ({
      name,
      path: path.join(wsPath, name),
      content: fs.readFileSync(path.join(wsPath, name), 'utf8'),
    }));
}

function detectTerraformResources(files) {
  const resources = [];
  const seen = new Set();
  const pattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;

  for (const file of files) {
    let match;
    while ((match = pattern.exec(file.content)) !== null) {
      const type = match[1];
      const name = match[2];
      const key = `${type}.${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push({ type, name, address: `${type}.${name}`, file: file.name });
    }
  }

  return resources;
}

function supportedTerraformResources(resources) {
  return resources.filter(resource => !!SHIPYARD_OUTPUT_GENERATORS[resource.type]);
}

function generateShipyardOutputsBlock(resources) {
  const supported = supportedTerraformResources(resources);
  if (supported.length === 0) {
    throw new Error(`No supported VM resources found. Supported types: ${Object.keys(SHIPYARD_OUTPUT_GENERATORS).join(', ')}`);
  }

  const lines = [
    SHIPYARD_OUTPUT_BLOCK_START,
    '# Managed by Shipyard / OpenTofu',
    '# Adjust ssh_user or ssh_port below if your image uses different defaults.',
    'output "shipyard_servers" {',
    '  value = {',
  ];

  for (const resource of supported) {
    const config = SHIPYARD_OUTPUT_GENERATORS[resource.type];
    lines.push(`    ${JSON.stringify(resource.name)} = {`);
    lines.push(`      name       = ${config.nameExpr(resource.address, resource.name)}`);
    lines.push(`      hostname   = ${config.nameExpr(resource.address, resource.name)}`);
    lines.push(`      ip_address = ${config.ipExpr(resource.address)}`);
    lines.push(`      ssh_user   = ${JSON.stringify(config.sshUser)}`);
    lines.push('      ssh_port   = 22');
    lines.push(`      tags       = [${JSON.stringify(config.providerTag)}]`);
    lines.push('    }');
  }

  lines.push('  }');
  lines.push('}');
  lines.push(SHIPYARD_OUTPUT_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

function upsertManagedShipyardOutputs(existingContent, generatedBlock) {
  const markerRe = new RegExp(
    `${escapeRegExp(SHIPYARD_OUTPUT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(SHIPYARD_OUTPUT_BLOCK_END)}\\n?`,
    'm'
  );

  if (markerRe.test(existingContent)) {
    return existingContent.replace(markerRe, generatedBlock);
  }

  const trimmed = existingContent.trimEnd();
  if (!trimmed) return generatedBlock;
  return `${trimmed}\n\n${generatedBlock}`;
}

module.exports = {
  detectTerraformResources,
  generateShipyardOutputsBlock,
  readTerraformFiles,
  supportedTerraformResources,
  upsertManagedShipyardOutputs,
};
