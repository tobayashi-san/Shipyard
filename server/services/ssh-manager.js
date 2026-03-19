const { execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { NodeSSH } = require('node-ssh');
const db = require('../db');

const SSH_DIR = path.join(__dirname, '..', 'data', 'ssh');

class SSHManager {
  constructor() {
    this.connections = new Map();
    this.connecting = new Map(); // pending connect promises
    fs.mkdirSync(SSH_DIR, { recursive: true });
  }

  /**
   * Generate a new SSH key pair for Shipyard
   */
  generateKey(name = 'shipyard') {
    const keyPath = path.join(SSH_DIR, name);
    const pubKeyPath = `${keyPath}.pub`;

    if (fs.existsSync(keyPath)) {
      const publicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
      const existing = db.sshKeys.getFirst();
      if (existing) {
        return { publicKey, privateKeyPath: keyPath, alreadyExists: true };
      }
    }

    // Generate ED25519 key (modern, fast, secure)
    // Use execFileSync with array args – no shell interpolation, no injection risk
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'shipyard'], {
      stdio: 'pipe',
    });

    // Fix permissions
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(pubKeyPath, 0o644);

    const publicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    db.sshKeys.create(name, publicKey, keyPath);

    return { publicKey, privateKeyPath: keyPath, alreadyExists: false };
  }

  /**
   * Get the current SSH key info
   */
  getKeyInfo() {
    const key = db.sshKeys.getFirst();
    if (!key) return null;
    return {
      id: key.id,
      name: key.name,
      publicKey: key.public_key,
      privateKeyPath: key.private_key_path,
      exists: fs.existsSync(key.private_key_path),
    };
  }

  /**
   * Get the private key path
   */
  getPrivateKeyPath() {
    const key = db.sshKeys.getFirst();
    if (!key) {
      // Auto-generate if none exists
      const result = this.generateKey();
      return result.privateKeyPath;
    }
    return key.private_key_path;
  }

  /**
   * Deploy SSH key to a remote server (requires password for first connection)
   */
  async deployKey(serverIp, sshUser, password, sshPort = 22) {
    const keyInfo = this.getKeyInfo();
    if (!keyInfo) {
      this.generateKey();
    }

    const key = db.sshKeys.getFirst();
    const publicKey = key.public_key;

    // Connect with password and add key
    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: serverIp,
        port: sshPort,
        username: sshUser,
        password: password,
        tryKeyboard: true,
      });

      // Ensure .ssh directory exists and add key
      await ssh.execCommand('mkdir -p ~/.ssh && chmod 700 ~/.ssh');
      // Use base64 to safely transfer the key without any shell injection risk
      const b64Key = Buffer.from(publicKey).toString('base64');
      await ssh.execCommand(`echo '${b64Key}' | base64 -d >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);

      // Remove duplicates
      await ssh.execCommand('sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys');

      ssh.dispose();
      return { success: true, message: 'SSH key deployed successfully' };
    } catch (error) {
      ssh.dispose();
      throw new Error(`Failed to deploy SSH key: ${error.message}`);
    }
  }

  /**
   * Get or create an SSH connection to a server
   */
  async getConnection(server) {
    const key = `${server.ip_address}:${server.ssh_port}`;

    if (this.connections.has(key)) {
      const conn = this.connections.get(key);
      if (conn.isConnected()) return conn;
      this.connections.delete(key);
    }

    // If a connect is already in progress, wait for it instead of opening another
    if (this.connecting.has(key)) {
      return this.connecting.get(key);
    }

    const privateKeyPath = this.getPrivateKeyPath();
    const ssh = new NodeSSH();

    const connectPromise = ssh.connect({
      host: server.ip_address,
      port: server.ssh_port || 22,
      username: server.ssh_user || 'root',
      privateKeyPath,
      readyTimeout: 10000,
    }).then(() => {
      this.connections.set(key, ssh);
      this.connecting.delete(key);
      return ssh;
    }).catch(error => {
      this.connecting.delete(key);
      throw new Error(`SSH connection failed to ${server.ip_address}: ${error.message}`);
    });

    this.connecting.set(key, connectPromise);
    return connectPromise;
  }

  /**
   * Execute a command on a remote server
   */
  async execCommand(server, command) {
    const ssh = await this.getConnection(server);
    const result = await ssh.execCommand(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }

  /**
   * Test SSH connectivity to a server
   */
  async testConnection(server) {
    try {
      const result = await this.execCommand(server, 'echo "connected"');
      return result.stdout.trim() === 'connected';
    } catch {
      return false;
    }
  }

  /**
   * Close all connections
   */
  closeAll() {
    for (const [key, conn] of this.connections) {
      try { conn.dispose(); } catch {}
    }
    this.connections.clear();
  }
}

module.exports = new SSHManager();
