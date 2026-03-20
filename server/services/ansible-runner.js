const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const sshManager = require('./ssh-manager');

const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');
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
      // Key is encrypted — write decrypted content to a temp file
      const plaintext = sshManager.getPrivateKey();
      const tmpPath = path.join(os.tmpdir(), `shipyard-key-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmpPath, plaintext, { mode: 0o600 });
      return { keyPath: tmpPath, cleanup: () => { try { fs.unlinkSync(tmpPath); } catch {} } };
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
    const safe = (v) => String(v ?? '').replace(/[\r\n\s=\[\]]/g, '_');

    let inventory = '[all]\n';
    servers.forEach(server => {
      inventory += `${safe(server.name)} ansible_host=${safe(server.ip_address)} ansible_port=${parseInt(server.ssh_port) || 22} ansible_user=${safe(server.ssh_user)} ansible_ssh_private_key_file=${keyPath}\n`;
    });

    // Group servers by tags
    const tagGroups = {};
    servers.forEach(server => {
      const tags = JSON.parse(server.tags || '[]');
      tags.forEach(tag => {
        if (!tagGroups[tag]) tagGroups[tag] = [];
        tagGroups[tag].push(server.name);
      });
    });

    for (const [tag, members] of Object.entries(tagGroups)) {
      inventory += `\n[${safe(tag)}]\n`;
      members.forEach(name => { inventory += `${safe(name)}\n`; });
    }

    const inventoryPath = path.join(DATA_DIR, 'inventory.ini');
    fs.writeFileSync(inventoryPath, inventory);
    return inventoryPath;
  }

  /**
   * List available playbooks in the playbooks directory
   */
  getAvailablePlaybooks() {
    try {
      if (!fs.existsSync(PLAYBOOKS_DIR)) return [];
      const files = fs.readdirSync(PLAYBOOKS_DIR);
      return files
        .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
        .map(file => {
          const content = fs.readFileSync(path.join(PLAYBOOKS_DIR, file), 'utf8');
          // Try to extract name/description from the first play's "name" attribute
          const nameMatch = content.match(/-\s*name:\s*(.+)/);
          const description = nameMatch ? nameMatch[1].trim() : file;
          // Flag internal ones
          const isInternal = file === 'update.yml' || file === 'gather-info.yml' || file === 'gather-docker.yml' || file === 'check-image-updates.yml';
          return { filename: file, description, isInternal };
        });
    } catch (e) {
      console.error('Error listing playbooks:', e);
      return [];
    }
  }

  /**
   * Run an Ansible playbook with live output streaming
   */
  runPlaybook(playbookName, targets = 'all', extraVars = {}, onOutput = null) {
    return new Promise((resolve, reject) => {
      const { keyPath, cleanup } = this._resolveSshKey();
      const inventoryPath = this.generateInventory(keyPath);
      const playbookPath = path.resolve(PLAYBOOKS_DIR, playbookName);

      if (!playbookPath.startsWith(path.resolve(PLAYBOOKS_DIR) + path.sep)) {
        reject(new Error(`Invalid playbook path: ${playbookName}`));
        return;
      }

      if (!fs.existsSync(playbookPath)) {
        reject(new Error(`Playbook not found: ${playbookName}`));
        return;
      }

      const args = [
        '-i', inventoryPath,
        playbookPath,
        '--limit', targets,
        '-v',
      ];

      // Add extra vars
      if (Object.keys(extraVars).length > 0) {
        args.push('-e', JSON.stringify(extraVars));
      }

      const env = {
        ...process.env,
        ANSIBLE_FORCE_COLOR: '0',
        ANSIBLE_NOCOLOR: '1',
        ANSIBLE_PYTHON_INTERPRETER: 'auto_silent',
        // TOFU: accept unknown hosts on first connect, verify on subsequent connects
        ANSIBLE_SSH_ARGS: `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(DATA_DIR, 'known_hosts')}`,
      };

      const child = spawn('ansible-playbook', args, {
        env,
        cwd: path.join(__dirname, '..'),
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (onOutput) onOutput('stdout', text);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (onOutput) onOutput('stderr', text);
      });

      child.on('close', (code) => {
        cleanup();
        resolve({
          code,
          stdout,
          stderr,
          success: code === 0,
        });
      });

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to run ansible-playbook: ${err.message}. Is Ansible installed?`));
      });
    });
  }

  /**
   * Run ad-hoc Ansible command
   */
  runAdHoc(targets, module, args = '', onOutput = null) {
    return new Promise((resolve, reject) => {
      const { keyPath, cleanup } = this._resolveSshKey();
      const inventoryPath = this.generateInventory(keyPath);

      const cmdArgs = [
        '-i', inventoryPath,
        targets,
        '-m', module,
      ];

      if (args) {
        cmdArgs.push('-a', args);
      }

      const env = {
        ...process.env,
        ANSIBLE_FORCE_COLOR: '0',
        ANSIBLE_NOCOLOR: '1',
        ANSIBLE_PYTHON_INTERPRETER: 'auto_silent',
        // TOFU: accept unknown hosts on first connect, verify on subsequent connects
        ANSIBLE_SSH_ARGS: `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(DATA_DIR, 'known_hosts')}`,
      };

      const child = spawn('ansible', cmdArgs, { env });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (onOutput) onOutput('stdout', text);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (onOutput) onOutput('stderr', text);
      });

      child.on('close', (code) => {
        cleanup();
        resolve({ code, stdout, stderr, success: code === 0 });
      });

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to run ansible: ${err.message}. Is Ansible installed?`));
      });
    });
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
