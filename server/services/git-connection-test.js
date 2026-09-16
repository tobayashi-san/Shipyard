const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const execFile = (command, args, options) => new Promise((resolve, reject) => {
  childProcess.execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }));
});
const { validateGitUrl, validateBranchName, validateCredentials } = require('./git-sync');

// Uses only submitted credentials in a temporary directory. Never saves settings,
// fetches into the active workspace or returns transport output containing secrets.
async function testConnection({ repoUrl, authToken = '', sshKey = '', branch = 'main' }) {
  const validation = validateGitUrl(repoUrl);
  if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
  if (!validateBranchName(branch)) throw Object.assign(new Error('Invalid branch name'), { status: 400 });
  const credentials = validateCredentials(repoUrl, authToken, sshKey);
  if (!credentials.ok) throw Object.assign(new Error(credentials.error), { status: 400 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipyard-git-test-'));
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
    if (authToken) {
      if (!/^https?:\/\//.test(repoUrl)) throw Object.assign(new Error('HTTPS tokens require an HTTP(S) repository URL.'), { status: 400 });
      env.GIT_CONFIG_COUNT = '2';
      env.GIT_CONFIG_KEY_1 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from('oauth2:' + authToken).toString('base64')}`;
    }
    if (/^(?:ssh:\/\/|[\w.-]+@)/.test(repoUrl)) {
      const key = path.join(dir, 'key');
      if (sshKey) await fs.writeFile(key, sshKey, { mode: 0o600 });
      const quotedKey = "'" + key.replace(/'/g, "'\\''") + "'";
      env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes${sshKey ? ` -o IdentitiesOnly=yes -i ${quotedKey}` : ''}`;
    }
    let result;
    try {
      result = await execFile('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'ls-remote', '--symref', '--', repoUrl.trim(), 'HEAD', 'refs/heads/*'], { cwd: dir, env, timeout: 15000, maxBuffer: 1024 * 1024 });
    } catch {
      throw Object.assign(new Error('Repository check failed. Verify the URL, read permission and network access. SSH also requires a trusted host key on the server.'), { status: 502 });
    }
    const branches = [...new Set(result.stdout.split('\n').map(line => /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(line)?.[1]).filter(Boolean))].sort();
    const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(result.stdout)?.[1] || null;
    return { reachable: true, branches, defaultBranch, branchExists: branches.includes(branch), checkedAt: new Date().toISOString() };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
module.exports = { testConnection };
