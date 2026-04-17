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

/**
 * Compute the SSH host-key fingerprint in the OpenSSH-style "SHA256:<base64>" form
 * (no padding), matching what `ssh-keygen -lf` prints.
 */
function fingerprintHostKey(keyBuf) {
  const digest = crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * Build a hostVerifier callback for ssh2/node-ssh that implements
 * trust-on-first-use against the per-server host_fingerprint stored in DB.
 *
 * Behaviour:
 *   - If no fingerprint is stored yet, accept the connection AND persist the
 *     learned fingerprint (TOFU). The captured fingerprint is also returned via
 *     the `out.fingerprint` field for callers that want to react.
 *   - If a fingerprint is stored and matches, accept.
 *   - If a fingerprint is stored and does NOT match, refuse — this is the
 *     critical security guarantee. Operator must explicitly run reset-host-key.
 *
 * `serverId` may be null (e.g. deployKey before the server row is saved); in
 * that case we do not persist but still return the fingerprint for the caller
 * to optionally store it.
 */
function makeHostVerifier({ serverId, expectedFingerprint, out, hostLabel }) {
  return (key, verify) => {
    let fp;
    try { fp = fingerprintHostKey(key); }
    catch (e) {
      log.warn({ err: e, serverId }, 'Failed to compute host key fingerprint');
      return verify(false);
    }
    if (out) out.fingerprint = fp;
    const stored = expectedFingerprint || (serverId ? db.servers.getHostFingerprint(serverId) : '');
    if (!stored) {
      // TOFU: accept and persist
      if (serverId) {
        try { db.servers.setHostFingerprint(serverId, fp); }
        catch (e) { log.warn({ err: e, serverId }, 'Failed to persist host fingerprint'); }
        log.info({ serverId, host: hostLabel, fingerprint: fp }, 'Trusted SSH host key on first use');
      }
      return verify(true);
    }
    if (stored === fp) return verify(true);
    log.error(
      { serverId, host: hostLabel, expected: stored, got: fp },
      'SSH host key MISMATCH — refusing connection'
    );
    return verify(false);
  };
}

class HostKeyMismatchError extends Error {
  constructor(host) {
    super(`SSH host key verification failed for ${host}. The remote host key does not match the trusted fingerprint. If the host was reinstalled, run "Reset host key" for this server.`);
    this.code = 'HOST_KEY_MISMATCH';
  }
}

class SSHManager {
  constructor() {
    this.connections = new Map(); // key → NodeSSH
    this.lastUsed    = new Map(); // key → timestamp
    this.connecting  = new Map(); // key → pending connect promise
    this.refCounts   = new Map(); // key → number of in-flight users (eviction-safe)
    fs.mkdirSync(SSH_DIR, { recursive: true });

    this._cleanupTimer = setInterval(() => this._evictIdle(), CLEANUP_INTERVAL);
    // Allow the process to exit even if this timer is still running
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _refInc(key) {
    this.refCounts.set(key, (this.refCounts.get(key) || 0) + 1);
  }

  _refDec(key) {
    const n = (this.refCounts.get(key) || 0) - 1;
    if (n <= 0) this.refCounts.delete(key);
    else this.refCounts.set(key, n);
    this.lastUsed.set(key, Date.now());
  }

  _isInUse(key) {
    return (this.refCounts.get(key) || 0) > 0;
  }

  /** Close connections that have been idle longer than IDLE_TIMEOUT_MS */
  _evictIdle() {
    const now = Date.now();
    for (const [key, ts] of this.lastUsed) {
      if (this._isInUse(key)) continue;
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

  /** Evict the least-recently-used IDLE connection to make room. Skips in-use ones. */
  _evictLRU() {
    let oldestKey = null;
    let oldestTs  = Infinity;
    for (const [key, ts] of this.lastUsed) {
      if (this._isInUse(key)) continue;
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
      return true;
    }
    return false;
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
    // Re-read the key from disk: if a passphrase was stripped above, the file
    // now contains the unprotected key — not the original privateKeyContent.
    const strippedKeyContent = fs.readFileSync(keyPath, 'utf8');
    const encrypted = encryptKey(strippedKeyContent);
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
   * Deploy SSH key to a remote server (requires password for first connection).
   * If `serverId` is given, the learned host fingerprint is persisted (TOFU).
   */
  async deployKey(serverIp, sshUser, password, sshPort = 22, opts = {}) {
    const { serverId = null } = opts;
    const keyInfo = this.getKeyInfo();
    if (!keyInfo) {
      this.generateKey();
    }

    const key = db.sshKeys.getFirst();
    const publicKey = key.public_key;

    // Connect with password and add key
    const ssh = new NodeSSH();
    const out = { fingerprint: null };
    try {
      await ssh.connect({
        host: serverIp,
        port: sshPort,
        username: sshUser,
        password: password,
        tryKeyboard: true,
        hostVerifier: makeHostVerifier({ serverId, out, hostLabel: serverIp }),
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
      return { success: true, message: 'SSH key deployed successfully', fingerprint: out.fingerprint };
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
    const key = this._connectionKey(server);

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

    // Enforce connection cap before opening a new one. Only IDLE connections
    // are evicted; if all slots are in-use, refuse rather than break a stream.
    if (this.connections.size >= MAX_CONNECTIONS) {
      const evicted = this._evictLRU();
      if (!evicted) {
        throw new Error(`SSH connection pool exhausted (${MAX_CONNECTIONS} active). Try again later.`);
      }
    }

    const privateKey = readPrivateKey(this.getPrivateKeyPath());
    const ssh = new NodeSSH();
    const host = server.ip_address;

    const connectPromise = ssh.connect({
      host,
      port: server.ssh_port || 22,
      username: server.ssh_user || 'root',
      privateKey,
      readyTimeout: 10000,
      hostVerifier: makeHostVerifier({ serverId: server.id, hostLabel: host }),
    }).then(() => {
      this.connections.set(key, ssh);
      this.lastUsed.set(key, Date.now());
      this.connecting.delete(key);
      return ssh;
    }).catch(error => {
      this.connecting.delete(key);
      // ssh2 surfaces a hostVerifier rejection as a "Handshake failed" / "All
      // configured authentication methods failed" style error. Detect by checking
      // the stored fingerprint vs none-collected (verifier rejected before auth).
      const stored = db.servers.getHostFingerprint(server.id);
      if (stored && /handshake|host key|verification|All configured/i.test(error.message || '')) {
        throw new HostKeyMismatchError(host);
      }
      throw new Error(`SSH connection failed to ${host}: ${error.message}`);
    });

    this.connecting.set(key, connectPromise);
    return connectPromise;
  }

  _connectionKey(server) {
    return `${server.ssh_user || 'root'}@${server.ip_address}:${server.ssh_port}`;
  }

  /**
   * Execute a command on a remote server
   */
  async execCommand(server, command) {
    const key = this._connectionKey(server);
    const ssh = await this.getConnection(server);
    this._refInc(key);
    try {
      const result = await ssh.execCommand(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      };
    } finally {
      this._refDec(key);
    }
  }

  /**
   * Execute a command with streaming stdout/stderr callbacks.
   * The connection is reference-counted for the duration of the stream so it
   * cannot be evicted by the cleanup timer or by another caller's _evictLRU.
   */
  async execStream(server, command, onData) {
    const key = this._connectionKey(server);
    const ssh = await this.getConnection(server);
    this._refInc(key);
    return new Promise((resolve, reject) => {
      ssh.connection.exec(command, (err, stream) => {
        if (err) {
          this._refDec(key);
          return reject(err);
        }
        const bump = () => this.lastUsed.set(key, Date.now());
        stream.on('data', chunk => { bump(); onData(chunk.toString()); });
        stream.stderr.on('data', chunk => { bump(); onData(chunk.toString()); });
        stream.on('close', code => {
          this._refDec(key);
          resolve(code);
        });
        stream.on('error', e => {
          this._refDec(key);
          reject(e);
        });
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
    this.refCounts.clear();
  }
}

module.exports = new SSHManager();
module.exports.makeHostVerifier = makeHostVerifier;
module.exports.HostKeyMismatchError = HostKeyMismatchError;
module.exports.fingerprintHostKey = fingerprintHostKey;
