const { execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { NodeSSH } = require('node-ssh');
const db = require('../db');
const log = require('../utils/logger').child('ssh-manager');

const MAX_CONNECTIONS  = 20;
const IDLE_TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 60 * 1000;     // check every minute

const SSH_DIR = path.join(__dirname, '..', 'data', 'ssh');
const KNOWN_HOSTS_PATH = path.join(__dirname, '..', 'data', 'known_hosts');
const ALGORITHM = 'aes-256-gcm';

function getMasterKey() {
  const secret = process.env.SHIPYARD_KEY_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptKey(plaintext) {
  const masterKey = getMasterKey();
  if (!masterKey) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptKey(b64) {
  const masterKey = getMasterKey();
  if (!masterKey) throw new Error('SHIPYARD_KEY_SECRET is not set — cannot decrypt SSH key');
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Read the private key content for a given base path.
 * If a .enc file exists (encrypted at rest), decrypt it in memory.
 * If SHIPYARD_KEY_SECRET is set and only the plaintext exists, encrypt it now.
 * Returns the plaintext key content as a string.
 */
function readPrivateKey(keyPath) {
  const encPath = keyPath + '.enc';
  if (fs.existsSync(encPath)) {
    return decryptKey(fs.readFileSync(encPath, 'utf8'));
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error(`SSH private key not found: ${keyPath}`);
  }
  const plaintext = fs.readFileSync(keyPath, 'utf8');
  // Auto-encrypt if master key is now configured
  const encrypted = encryptKey(plaintext);
  if (encrypted) {
    fs.writeFileSync(encPath, encrypted, { mode: 0o600 });
    fs.unlinkSync(keyPath);
  }
  return plaintext;
}

class SSHManager {
  constructor() {
    this.connections = new Map(); // key → NodeSSH
    this.lastUsed    = new Map(); // key → timestamp
    this.connecting  = new Map(); // key → pending connect promise
    fs.mkdirSync(SSH_DIR, { recursive: true });

    this._cleanupTimer = setInterval(() => this._evictIdle(), CLEANUP_INTERVAL);
    // Allow the process to exit even if this timer is still running
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /** Close connections that have been idle longer than IDLE_TIMEOUT_MS */
  _evictIdle() {
    const now = Date.now();
    for (const [key, ts] of this.lastUsed) {
      if (now - ts > IDLE_TIMEOUT_MS) {
        const conn = this.connections.get(key);
        if (conn) {
          try { conn.dispose(); } catch {}
          log.debug({ key }, 'Evicted idle SSH connection');
        }
        this.connections.delete(key);
        this.lastUsed.delete(key);
      }
    }
  }

  /** Evict the least-recently-used connection to make room */
  _evictLRU() {
    let oldestKey = null;
    let oldestTs  = Infinity;
    for (const [key, ts] of this.lastUsed) {
      if (ts < oldestTs) { oldestTs = ts; oldestKey = key; }
    }
    if (oldestKey) {
      const conn = this.connections.get(oldestKey);
      if (conn) {
        try { conn.dispose(); } catch {}
        log.debug({ key: oldestKey }, 'Evicted LRU SSH connection');
      }
      this.connections.delete(oldestKey);
      this.lastUsed.delete(oldestKey);
    }
  }

  /**
   * Generate a new SSH key pair for Shipyard
   */
  generateKey(name = 'shipyard') {
    const keyPath = path.join(SSH_DIR, name);
    const pubKeyPath = `${keyPath}.pub`;

    if (fs.existsSync(keyPath) || fs.existsSync(keyPath + '.enc')) {
      const publicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
      const existing = db.sshKeys.getFirst();
      if (!existing) {
        // Key exists on disk but not in DB — re-create the DB record
        db.sshKeys.create(name, publicKey, keyPath);
      }
      return { publicKey, privateKeyPath: keyPath, alreadyExists: true };
    }

    // Generate ED25519 key (modern, fast, secure)
    // Use execFileSync with array args – no shell interpolation, no injection risk
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'shipyard'], {
      stdio: 'pipe',
    });

    // Fix permissions
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(pubKeyPath, 0o644);

    // Encrypt at rest if SHIPYARD_KEY_SECRET is configured
    const plaintext = fs.readFileSync(keyPath, 'utf8');
    const encrypted = encryptKey(plaintext);
    if (encrypted) {
      fs.writeFileSync(keyPath + '.enc', encrypted, { mode: 0o600 });
      fs.unlinkSync(keyPath);
    }

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
    const p = key.private_key_path;
    return {
      id: key.id,
      name: key.name,
      publicKey: key.public_key,
      privateKeyPath: p,
      exists: fs.existsSync(p) || fs.existsSync(p + '.enc'),
      encrypted: fs.existsSync(p + '.enc'),
    };
  }

  /**
   * Get the private key base path (without .enc suffix)
   */
  getPrivateKeyPath() {
    const key = db.sshKeys.getFirst();
    if (!key) {
      const result = this.generateKey();
      return result.privateKeyPath;
    }
    return key.private_key_path;
  }

  /**
   * Get the decrypted private key content as a string.
   * Use this instead of getPrivateKeyPath() + readFileSync everywhere.
   */
  getPrivateKey() {
    return readPrivateKey(this.getPrivateKeyPath());
  }

  getKnownHostsPath() {
    return KNOWN_HOSTS_PATH;
  }

  removeKnownHostEntries(hosts = []) {
    const hostList = [...new Set(
      (Array.isArray(hosts) ? hosts : [hosts])
        .filter(h => typeof h === 'string')
        .map(h => h.trim())
        .filter(Boolean)
    )];

    if (hostList.length === 0) return { removed: [], missing: [] };
    if (!fs.existsSync(KNOWN_HOSTS_PATH)) {
      return { removed: [], missing: hostList };
    }

    const removed = [];
    const missing = [];

    for (const host of hostList) {
      try {
        const out = execFileSync('ssh-keygen', ['-F', host, '-f', KNOWN_HOSTS_PATH], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!String(out || '').trim()) {
          missing.push(host);
          continue;
        }
      } catch {
        missing.push(host);
        continue;
      }

      execFileSync('ssh-keygen', ['-R', host, '-f', KNOWN_HOSTS_PATH], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      removed.push(host);
    }

    return { removed, missing };
  }

  /**
   * Get the private key for export, optionally protected with a passphrase.
   * If passphrase is non-empty, a passphrase-encrypted copy is returned.
   */
  getPrivateKeyExport(passphrase = '') {
    const plaintext = this.getPrivateKey();
    if (!passphrase) return plaintext;

    const tmpFile = path.join(os.tmpdir(), `shipyard_export_${crypto.randomBytes(8).toString('hex')}`);
    try {
      fs.writeFileSync(tmpFile, plaintext, { mode: 0o600 });
      // Add passphrase: change from empty ('') to the given passphrase
      execFileSync('ssh-keygen', ['-p', '-P', '', '-N', passphrase, '-f', tmpFile], { stdio: 'pipe' });
      return fs.readFileSync(tmpFile, 'utf8');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Import an existing SSH private key
   */
  importKey(privateKeyContent, name = 'shipyard_imported', passphrase = '') {
    const keyPath = path.join(SSH_DIR, name);
    const pubKeyPath = `${keyPath}.pub`;

    // Write private key
    fs.writeFileSync(keyPath, privateKeyContent, { mode: 0o600 });

    // Generate public key (pass -P to handle passphrase-protected keys)
    let publicKey;
    try {
      const args = passphrase
        ? ['-y', '-f', keyPath, '-P', passphrase]
        : ['-y', '-f', keyPath];
      publicKey = execFileSync('ssh-keygen', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      throw new Error('Invalid SSH private key or wrong passphrase.');
    }
    fs.writeFileSync(pubKeyPath, publicKey, { mode: 0o644 });

    // Strip passphrase so we can store/use the key without it (we encrypt at rest ourselves)
    if (passphrase) {
      try {
        execFileSync('ssh-keygen', ['-p', '-P', passphrase, '-N', '', '-f', keyPath], { stdio: 'pipe' });
      } catch (e) {
        if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
        throw new Error('Failed to strip passphrase from key.');
      }
    }

    // Encrypt at rest if SHIPYARD_KEY_SECRET is configured
    const encrypted = encryptKey(privateKeyContent);
    if (encrypted) {
      fs.writeFileSync(keyPath + '.enc', encrypted, { mode: 0o600 });
      fs.unlinkSync(keyPath);
    }

    // Remove old key files, then replace DB record
    for (const old of db.sshKeys.getAll()) {
      const p = old.private_key_path;
      if (p && p !== keyPath) {
        try { fs.unlinkSync(p); } catch {}
        try { fs.unlinkSync(p + '.enc'); } catch {}
        try { fs.unlinkSync(p + '.pub'); } catch {}
      }
    }
    db.sshKeys.replace(name, publicKey, keyPath);

    return { publicKey, privateKeyPath: keyPath, alreadyExists: false };
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

      // Ensure .ssh directory exists with correct permissions
      await ssh.execCommand('mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys');

      // Read existing authorized_keys via SFTP, append key, write back — no shell interpolation
      const sftp = await ssh.requestSFTP();
      const remoteFile = `${(await ssh.execCommand('echo -n $HOME')).stdout}/.ssh/authorized_keys`;
      let existing = '';
      try {
        existing = await new Promise((resolve, reject) => {
          let data = '';
          const stream = sftp.createReadStream(remoteFile);
          stream.on('data', chunk => { data += chunk; });
          stream.on('end', () => resolve(data));
          stream.on('error', () => resolve(''));
        });
      } catch { existing = ''; }

      if (!existing.split('\n').some(line => line.trim() === publicKey.trim())) {
        const updated = (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + publicKey + '\n';
        await new Promise((resolve, reject) => {
          const stream = sftp.createWriteStream(remoteFile);
          stream.on('close', resolve);
          stream.on('error', reject);
          stream.end(updated);
        });
      }

      ssh.dispose();
      return { success: true, message: 'SSH key deployed successfully' };
    } catch (error) {
      ssh.dispose();
      throw new Error(`Failed to deploy SSH key: ${error.message}`);
    }
  }

  /**
   * Get or create an SSH connection to a server.
   * Enforces MAX_CONNECTIONS via LRU eviction.
   */
  async getConnection(server) {
    const key = `${server.ssh_user || 'root'}@${server.ip_address}:${server.ssh_port}`;

    if (this.connections.has(key)) {
      const conn = this.connections.get(key);
      if (conn.isConnected()) {
        this.lastUsed.set(key, Date.now());
        return conn;
      }
      this.connections.delete(key);
      this.lastUsed.delete(key);
    }

    // If a connect is already in progress, wait for it instead of opening another
    if (this.connecting.has(key)) {
      return this.connecting.get(key);
    }

    // Enforce connection cap before opening a new one
    if (this.connections.size >= MAX_CONNECTIONS) {
      this._evictLRU();
    }

    const privateKey = readPrivateKey(this.getPrivateKeyPath());
    const ssh = new NodeSSH();

    const connectPromise = ssh.connect({
      host: server.ip_address,
      port: server.ssh_port || 22,
      username: server.ssh_user || 'root',
      privateKey,
      readyTimeout: 10000,
    }).then(() => {
      this.connections.set(key, ssh);
      this.lastUsed.set(key, Date.now());
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
    const key = `${server.ssh_user || 'root'}@${server.ip_address}:${server.ssh_port}`;
    const result = await ssh.execCommand(command);
    this.lastUsed.set(key, Date.now());
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }

  /**
   * Execute a command with streaming stdout/stderr callbacks
   */
  async execStream(server, command, onData) {
    const ssh = await this.getConnection(server);
    return new Promise((resolve, reject) => {
      ssh.connection.exec(command, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', chunk => onData(chunk.toString()));
        stream.stderr.on('data', chunk => onData(chunk.toString()));
        stream.on('close', code => resolve(code));
      });
    });
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
   * Close all connections and stop the cleanup timer
   */
  closeAll() {
    clearInterval(this._cleanupTimer);
    for (const [, conn] of this.connections) {
      try { conn.dispose(); } catch {}
    }
    this.connections.clear();
    this.lastUsed.clear();
  }
}

module.exports = new SSHManager();
