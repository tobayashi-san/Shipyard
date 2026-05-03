const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../utils/logger').child('ansible');
const db = require('../db');
const sshManager = require('./ssh-manager');

const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');
const BUNDLED_PLAYBOOKS_DIR = path.join(__dirname, '..', '..', 'bundled-playbooks');
const DATA_DIR = path.join(__dirname, '..', 'data');

class AnsibleRunner {
  constructor() {
    fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  /**
   * If the SSH key is encrypted at rest, decrypt it to a temp file and return
   * { keyPath, cleanup }. Otherwise return { keyPath, cleanup: () => {} }.
   */
  _resolveSshKey() {
    const keyInfo = sshManager.getKeyInfo();
    const baseKeyPath = keyInfo?.privateKeyPath || sshManager.getPrivateKeyPath();
    const encPath = baseKeyPath + '.enc';

    if (fs.existsSync(encPath)) {
      // Key is encrypted — write decrypted content to a secure temp directory
      const plaintext = sshManager.getPrivateKey();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-key-'));
      const tmpPath = path.join(tmpDir, 'key');
      fs.writeFileSync(tmpPath, plaintext, { mode: 0o600 });
      return { keyPath: tmpPath, cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} } };
    }

    return { keyPath: baseKeyPath, cleanup: () => {} };
  }

  /**
   * Generate Ansible inventory from database
   */
  generateInventory(keyPath) {
    const servers = db.servers.getAll();
    if (!keyPath) {
      const keyInfo = sshManager.getKeyInfo();
      keyPath = keyInfo?.privateKeyPath || sshManager.getPrivateKeyPath();
    }

    // Strip any characters that could break Ansible INI format or inject extra lines
    const safe = (v) => String(v ?? '').replace(/[\r\n\s=\[\]#;]/g, '_');
    const safeGroup = (v) => {
      const normalized = String(v ?? '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
      return normalized || 'group';
    };

    let inventory = '[all]\n';
    servers.forEach(server => {
      inventory += `${safe(server.name)} ansible_host=${safe(server.ip_address)} ansible_port=${parseInt(server.ssh_port, 10) || 22} ansible_user=${safe(server.ssh_user)} ansible_ssh_private_key_file=${keyPath}\n`;
    });

    // Group servers by tags
    const tagGroups = {};
    servers.forEach(server => {
      let tags = [];
      try { tags = JSON.parse(server.tags || '[]'); } catch {}
      tags.forEach(tag => {
        const group = safeGroup(tag);
        if (!tagGroups[group]) tagGroups[group] = new Set();
        tagGroups[group].add(server.name);
      });
    });

    for (const [tag, members] of Object.entries(tagGroups)) {
      inventory += `\n[${safe(tag)}]\n`;
      [...members].sort().forEach(name => { inventory += `${safe(name)}\n`; });
    }

    const inventoryPath = path.join(DATA_DIR, `inventory-${crypto.randomUUID()}.ini`);
    fs.writeFileSync(inventoryPath, inventory);
    return inventoryPath;
  }

  /**
   * List available playbooks.
   * User playbooks come from PLAYBOOKS_DIR (bind-mounted ./playbooks).
   * System/internal playbooks come exclusively from BUNDLED_PLAYBOOKS_DIR.
   */
  getAvailablePlaybooks() {
    try {
      const out = [];
      const seen = new Set();

      const readMeta = (fullPath, relPath) => {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').slice(0, 6);
        const nameMatch = content.match(/-\s*name:\s*(.+)/);
        const description = nameMatch ? nameMatch[1].trim() : relPath;
        const catLine = lines.find(l => /^#\s*category:/i.test(l));
        const category = catLine ? catLine.replace(/^#\s*category:\s*/i, '').trim() : null;
        return { description, category };
      };

      // 1) User playbooks: root-level .yml files in PLAYBOOKS_DIR only (no subdirs)
      if (fs.existsSync(PLAYBOOKS_DIR)) {
        for (const ent of fs.readdirSync(PLAYBOOKS_DIR, { withFileTypes: true })) {
          if (ent.isDirectory() || ent.name.startsWith('.')) continue;
          if (!ent.name.endsWith('.yml') && !ent.name.endsWith('.yaml')) continue;
          const fullPath = path.join(PLAYBOOKS_DIR, ent.name);
          const { description, category } = readMeta(fullPath, ent.name);
          seen.add(ent.name);
          out.push({ filename: ent.name, description, isInternal: false, category });
        }
      }

      // 2) System playbooks: everything in BUNDLED_PLAYBOOKS_DIR
      if (fs.existsSync(BUNDLED_PLAYBOOKS_DIR)) {
        const walk = (dir, prefix = '') => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.name.startsWith('.')) continue;
            const fullPath = path.join(dir, ent.name);
            const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
            if (ent.isDirectory()) { walk(fullPath, relPath); continue; }
            if (!relPath.endsWith('.yml') && !relPath.endsWith('.yaml')) continue;
            if (seen.has(relPath)) continue;
            const { description, category } = readMeta(fullPath, relPath);
            seen.add(relPath);
            out.push({ filename: relPath, description, isInternal: true, category });
          }
        };
        walk(BUNDLED_PLAYBOOKS_DIR, '');
      }

      out.sort((a, b) => a.filename.localeCompare(b.filename));
      return out;
    } catch (e) {
      log.error({ err: e }, 'Error listing playbooks');
      return [];
    }
  }

  get _ansibleEnv() {
    return {
      ...process.env,
      ANSIBLE_FORCE_COLOR: '0',
      ANSIBLE_NOCOLOR: '1',
      ANSIBLE_PYTHON_INTERPRETER: 'auto_silent',
      ANSIBLE_TIMEOUT: '60',
      ANSIBLE_PIPELINING: 'True',
      // Accept unknown hosts on first connect, verify on subsequent connects
      ANSIBLE_SSH_ARGS: `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(DATA_DIR, 'known_hosts')} -o ServerAliveInterval=30 -o ServerAliveCountMax=6`,
    };
  }

  _spawnProcess(binary, args, onOutput, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env: this._ansibleEnv, ...opts });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { const t = d.toString(); stdout += t; onOutput?.('stdout', t); });
      child.stderr.on('data', d => { const t = d.toString(); stderr += t; onOutput?.('stderr', t); });
      child.on('close', code => resolve({ code, stdout, stderr, success: code === 0 }));
      child.on('error', err => reject(new Error(`Failed to run ${binary}: ${err.message}. Is Ansible installed?`)));
    });
  }

  /**
   * Run an Ansible playbook with live output streaming.
   * System playbooks (system/*) resolve from BUNDLED_PLAYBOOKS_DIR only.
   * User playbooks resolve from PLAYBOOKS_DIR first, then BUNDLED_PLAYBOOKS_DIR.
   */
  async runPlaybook(playbookName, targets = 'all', extraVars = {}, onOutput = null) {
    const { keyPath, cleanup } = this._resolveSshKey();
    let inventoryPath;
    try {
      inventoryPath = this.generateInventory(keyPath);

      let resolvedPlaybook;
      const isSystem = playbookName.startsWith('system/');

      if (isSystem) {
        // System playbooks live exclusively in bundled-playbooks
        const bundledBase = path.resolve(BUNDLED_PLAYBOOKS_DIR);
        const bundledPath = path.resolve(bundledBase, playbookName);
        if (!bundledPath.startsWith(bundledBase + path.sep) || !fs.existsSync(bundledPath)) {
          throw new Error(`System playbook not found: ${playbookName}`);
        }
        resolvedPlaybook = bundledPath;
      } else {
        // User playbooks: try user dir first, then bundled fallback
        const userBase = path.resolve(PLAYBOOKS_DIR);
        const userPath = path.resolve(userBase, playbookName);
        if (!userPath.startsWith(userBase + path.sep)) {
          throw new Error(`Invalid playbook path: ${playbookName}`);
        }
        if (fs.existsSync(userPath)) {
          resolvedPlaybook = userPath;
        } else {
          const bundledBase = path.resolve(BUNDLED_PLAYBOOKS_DIR);
          const bundledPath = path.resolve(bundledBase, playbookName);
          if (bundledPath.startsWith(bundledBase + path.sep) && fs.existsSync(bundledPath)) {
            resolvedPlaybook = bundledPath;
          } else {
            throw new Error(`Playbook not found: ${playbookName}`);
          }
        }
      }

      const args = ['-i', inventoryPath, resolvedPlaybook, '--limit', targets, '-v'];
      if (Object.keys(extraVars).length > 0) args.push('-e', JSON.stringify(extraVars));

      return await this._spawnProcess('ansible-playbook', args, onOutput,
        { cwd: path.join(__dirname, '..') });
    } finally {
      cleanup();
      if (inventoryPath) try { fs.unlinkSync(inventoryPath); } catch {}
    }
  }

  /**
   * Run ad-hoc Ansible command
   */
  async runAdHoc(targets, module, args = '', onOutput = null, options = {}) {
    const { keyPath, cleanup } = this._resolveSshKey();
    let inventoryPath;
    try {
      inventoryPath = this.generateInventory(keyPath);
      const cmdArgs = ['-i', inventoryPath, targets, '-m', module];
      if (args) cmdArgs.push('-a', args);
      if (options.become) cmdArgs.push('--become');
      return await this._spawnProcess('ansible', cmdArgs, onOutput);
    } finally {
      cleanup();
      if (inventoryPath) try { fs.unlinkSync(inventoryPath); } catch {}
    }
  }

  /**
   * Find ansible-playbook binary path
   */
  _findBinary(name) {
    // Direct filesystem check first (most reliable)
    const commonPaths = [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `${process.env.HOME}/.local/bin/${name}`,
    ];

    for (const p of commonPaths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }

    // Fallback: shell lookup (no shell interpolation – args passed as array)
    try {
      const result = execFileSync('which', [name], { stdio: 'pipe' }).toString().trim();
      if (result) return result;
    } catch {}

    return null;
  }

  /**
   * Check if Ansible is installed
   */
  isInstalled() {
    return !!this._findBinary('ansible-playbook');
  }

  /**
   * Get Ansible version
   */
  getVersion() {
    try {
      const bin = this._findBinary('ansible');
      if (!bin) return null;
      const result = execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 10000 }).toString();
      const match = result.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : 'unknown';
    } catch(e) {
      return null;
    }
  }
}

module.exports = new AnsibleRunner();
