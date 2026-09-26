const { verifyVmIdentity } = require('./vm-identity-safety');
const { registerDeploymentResumeRoutes } = require('./routes/deployment-resume');
const { completeDeployment } = require('./deployment-completion');
const { workspacePath, confinedPath } = require('./workspace-paths');
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const log = require('../../utils/logger').child('features:opentofu');
const ansibleRunner = require('../../services/ansible-runner');
const { getPermissions, can, canAccessEnvironment, canAccessPlaybook } = require('../../utils/permissions');
const cryptoUtil = require('../../utils/crypto');
const {
  destroyConfirmationPhrase,
  destroyVmConfirmationPhrase,
  escapeRegExp,
  hasValidDestroyConfirmation,
  hasValidDestroyVmConfirmation,
  normalizePostDeployPlaybooks,
  normalizeProxmoxDiskUsage,
} = require('./core-utils');
const {
  createStreamingRedactor,
  pruneWorkspaceRuns,
  redactTofuOutput,
  summarizePlanJson,
  terraformConfigurationHash,
  validateIsolatedVmPlan,
} = require('./run-safety');
const {
  detectTerraformResources,
  generateFleetOutputsBlock,
  readTerraformFiles,
  upsertManagedFleetOutputs,
} = require('./terraform-outputs');
const {
  PROXMOX_IDENTIFIER_RE,
  applyFleetProxmoxBlueprintMetadata,
  buildProxmoxNetworkCatalog,
  buildProxmoxProviderFiles,
  buildProxmoxResourceOverview,
  extractProxmoxGuestIpv4,
  extractProxmoxGuestIpv4s,
  extractProxmoxGuestNetworkRecords,
  getProxmoxStateResources,
  normalizeResourceKey,
  normalizeProxmoxVm,
  normalizeProxmoxVmTemplate,
  renderProxmoxVmHcl,
  subnetContainsIpv4,
} = require('./proxmox-blueprints');
const {
  cleanupManagedServersForWorkspace,
  extractManagedServersFromState,
  loadWorkspaceState,
  normalizeServerCandidate,
  reconcileManagedServers,
  removeOrphanedServerMappings,
  waitForManagedServers,
} = require('./managed-servers');
const {
  moveWorkspaceDirectory,
  normalizedWorkspaceName,
  syncAllToGit,
  syncOneToGit,
} = require('./workspace-files');
const { setupOpenTofuDatabase } = require('./schema');
const { collectStorageResults } = require('./storage-inventory');
const { createInfrastructureSummary } = require('./infrastructure-summary');
const { registerFileRoutes } = require('./routes/files');
const { registerStateRoutes } = require('./routes/state');
const { registerPlatformRoutes } = require('./routes/platforms');
const { registerVmRoutes } = require('./routes/vms');
const { registerIsolatedVmRoutes } = require('./routes/isolated-vms');
const { registerLegacyVmMigrationRoutes } = require('./routes/legacy-migration');
const { registerWorkspaceRoutes } = require('./routes/workspaces');
const { registerRunRoutes } = require('./routes/runs');
const { installOpenTofu, VERSION_RE } = require('./installer');

let _gitSync = null;
function getGitSync() {
  if (!_gitSync) {
    try { _gitSync = require('../../services/git-sync'); } catch {}
  }
  return _gitSync;
}

// Map of currently running processes: internal runId -> process context.
// The persisted dbRunId is what the console exposes, so retain both IDs.
const _running = new Map();

const TOFU_STATE_BACKUP_ROOT = path.resolve(process.env.TOFU_STATE_BACKUP_DIR || path.join(__dirname, '..', '..', 'data', 'tofu-state-backups'));
const TOFU_STATE_BACKUP_KEEP = Math.max(3, parseInt(process.env.TOFU_STATE_BACKUP_KEEP || '20', 10) || 20);

const { promisify } = require('util');
const { readSavedProxmoxConnection } = require('./saved-connection');
const execFileAsync = promisify(require('child_process').execFile);
const {
  downloadFile: _downloadFile,
  fetchOpenTofuReleases: _fetchGitHubReleases,
  proxmoxApiUrl,
  readProxmoxConnection,
  requestProxmoxApi,
} = require('./proxmox-client');

function register({ router, db, broadcast }) {

  setupOpenTofuDatabase(db.db);

  syncPathsFile();

  // ── Register git sync hook so tofu files are included in push/status ─────
  const gs = getGitSync();
  if (gs?.registerSyncHook) {
    gs.registerSyncHook(() => syncAllToGit(getAllWorkspaces()));
  }

  // ── Binary detection (cached) ────────────────────────────────────────────
  let _cachedBinary  = undefined;
  let _cachedVersion = undefined;
  let _installing = false;

  const TOFU_INSTALL_PATH = path.resolve(
    process.env.OPENTOFU_INSTALL_PATH || path.join(__dirname, '..', '..', 'data', 'bin', 'tofu')
  );

  function findBinary() {
    if (_cachedBinary !== undefined) return _cachedBinary;
    if (fs.existsSync(TOFU_INSTALL_PATH)) {
      _cachedBinary = TOFU_INSTALL_PATH;
      return TOFU_INSTALL_PATH;
    }
    for (const bin of ['tofu', 'opentofu', 'terraform']) {
      try { execFileSync('which', [bin], { stdio: 'ignore' }); _cachedBinary = bin; return bin; } catch {}
    }
    _cachedBinary = null; return null;
  }

  function getVersion(bin) {
    if (_cachedVersion !== undefined) return _cachedVersion;
    try {
      const raw = execFileSync(bin, ['version', '-json'], { encoding: 'utf8', timeout: 5000 });
      const parsed = JSON.parse(raw);
      _cachedVersion = parsed.terraform_version || parsed.tofu_version || null;
    } catch {
      try { _cachedVersion = execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim(); }
      catch { _cachedVersion = null; }
    }
    return _cachedVersion;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const PATHS_FILE = '/app/server/data/tofu-workspace-paths.txt';
  function syncPathsFile() {
    try {
      const rows = db.db.prepare('SELECT path FROM tofu_workspaces').all();
      fs.writeFileSync(PATHS_FILE, rows.filter(r => isAllowedPath(r.path)).map(r => r.path).join('\n'), 'utf8');
    } catch {}
  }

  // Allowlist prefixes for environment variables passed to OpenTofu/Terraform
  const ALLOWED_ENV_PREFIXES = [
    'TF_VAR_', 'TF_CLI_', 'TF_LOG', 'TF_INPUT', 'TF_IN_AUTOMATION',
    'AWS_', 'ARM_', 'AZURE_', 'GOOGLE_', 'GCLOUD_', 'GCP_', 'CLOUDSDK_',
    'HCLOUD_', 'DO_', 'DIGITALOCEAN_', 'PROXMOX_',
    'VAULT_', 'CONSUL_', 'NOMAD_',
    'ALICLOUD_', 'OCI_', 'IBM_',
    'SCW_', 'LINODE_', 'VULTR_',
    'CLOUDFLARE_', 'GITHUB_TOKEN',
  ];

  const ALLOWED_PATH_ROOTS = String(process.env.OPENTOFU_WORKSPACE_ROOTS || '/workspaces')
    .split(',')
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => path.resolve(root));
  const INTERNAL_VM_ROOT = path.resolve(process.env.OPENTOFU_INTERNAL_VM_ROOT || path.join(ALLOWED_PATH_ROOTS[0] || '/workspaces', 'internal', 'vms'));
  const WORKSPACE_PATH_ERROR = `Path must be under configured OpenTofu workspace roots: ${ALLOWED_PATH_ROOTS.join(', ') || '/workspaces'}`;

  function isAllowedPath(p) {
    try { workspacePath(p, ALLOWED_PATH_ROOTS); return true; } catch { return false; }
  }

  const PROVIDER_CONFIGS = {
    aws: {
      providers_tf: `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
`,
      extra_variables: `
variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "eu-central-1"
}
`,
    },
    azurerm: {
      providers_tf: `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`,
      extra_variables: '',
    },
    google: {
      providers_tf: `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}
`,
      extra_variables: `
variable "gcp_project" {
  type        = string
  description = "GCP project ID"
}

variable "gcp_region" {
  type        = string
  description = "GCP region"
  default     = "europe-west3"
}
`,
    },
    hcloud: {
      providers_tf: `terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
`,
      extra_variables: `
variable "hcloud_token" {
  type        = string
  description = "Hetzner Cloud API token"
  sensitive   = true
}
`,
    },
    digitalocean: {
      providers_tf: `terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}
`,
      extra_variables: `
variable "do_token" {
  type        = string
  description = "DigitalOcean API token"
  sensitive   = true
}
`,
    },
    kubernetes: {
      providers_tf: `terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

provider "kubernetes" {
  config_path = "~/.kube/config"
}
`,
      extra_variables: '',
    },
    proxmox: {
      providers_tf: `terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  insecure  = var.proxmox_insecure
}
`,
      extra_variables: `
variable "proxmox_endpoint" {
  type        = string
  description = "Proxmox API endpoint, e.g. https://pve.example.com:8006/"
}

variable "proxmox_api_token" {
  type        = string
  description = "Proxmox API token, e.g. root@pam!terraform=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  sensitive   = true
}

variable "proxmox_insecure" {
  type        = bool
  description = "Skip TLS verification (self-signed certificates)"
  default     = false
}
`,
    },
  };

  function scaffoldWorkspace(wsPath, provider) {
    fs.mkdirSync(wsPath, { recursive: true });

    const providerCfg = PROVIDER_CONFIGS[provider];

    const mainTf = `# ${provider ? `${provider.toUpperCase()} ` : ''}Infrastructure
# Managed by Fleet / OpenTofu

# Add your resources here
`;

    const variablesTf = `# Input variables
${providerCfg?.extra_variables || ''}`;

    const outputsTf = `# Outputs
# output "example" {
#   value       = resource.type.name.attribute
#   description = "An example output"
# }
`;

    const gitignore = `# Secret variable files — never commit these
*.tfvars
*.tfvars.json
*.auto.tfvars

# OpenTofu / Terraform state and cache
.local/
.terraform/
*.tfstate
*.tfstate.backup
*.tfstate.*.backup
crash.log
override.tf
override.tf.json
`;

    fs.writeFileSync(path.join(wsPath, '.gitignore'), gitignore);
    fs.writeFileSync(path.join(wsPath, 'main.tf'), mainTf);
    fs.writeFileSync(path.join(wsPath, 'variables.tf'), variablesTf);
    fs.writeFileSync(path.join(wsPath, 'outputs.tf'), outputsTf);

    if (providerCfg) {
      fs.writeFileSync(path.join(wsPath, 'providers.tf'), providerCfg.providers_tf);
    }
  }

  function sanitizeEnvVars(vars) {
    if (!vars || typeof vars !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'string') continue;
      const upper = k.toUpperCase();
      if (ALLOWED_ENV_PREFIXES.some(prefix => upper.startsWith(prefix) || upper === prefix.replace(/_$/, ''))) {
        clean[k] = v;
      }
    }
    return clean;
  }

  function parseWorkspaceEnvVars(value) {
    const stored = String(value || '{}');
    const plaintext = stored.startsWith('enc:') ? cryptoUtil.decrypt(stored) : stored;
    if (!plaintext || plaintext.startsWith('enc:')) return {};
    try { return sanitizeEnvVars(JSON.parse(plaintext)); } catch { return {}; }
  }

  function serializeWorkspaceEnvVars(value) {
    const clean = sanitizeEnvVars(value);
    if (Object.keys(clean).length && !cryptoUtil.isEncryptionAvailable()) {
      const error = new Error('FLEET_KEY_SECRET is required before deployment secrets can be stored.');
      error.status = 503;
      throw error;
    }
    const plaintext = JSON.stringify(clean);
    return Object.keys(clean).length ? cryptoUtil.encrypt(plaintext) : plaintext;
  }

  function getWorkspaceRow(id) {
    const row = db.db.prepare('SELECT * FROM tofu_workspaces WHERE id = ?').get(id);
    return row || null;
  }

  function getWorkspace(id) {
    const row = getWorkspaceRow(id);
    if (!row) return null;
    if (!isAllowedPath(row.path)) return null;
    const envVars = parseWorkspaceEnvVars(row.env_vars);
    if (cryptoUtil.isEncryptionAvailable() && Object.keys(envVars).length && !String(row.env_vars || '').startsWith('enc:')) {
      try { db.db.prepare('UPDATE tofu_workspaces SET env_vars = ? WHERE id = ?').run(serializeWorkspaceEnvVars(envVars), row.id); } catch {}
    }
    const workspace = { ...row, env_vars: envVars };
    if (!workspace.proxmox_connection_id) return workspace;
    const source = db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE id = ? AND environment_id = ?')
      .get(workspace.proxmox_connection_id, workspace.environment_id || 'default');
    if (!source) return workspace;
    try {
      const connection = readSavedProxmoxConnection(source);
      const sshPublicKey = cryptoUtil.decrypt(String(source.ssh_public_key || ''));
      return {
        ...workspace,
        proxmox_connection: publicProxmoxConnection(source),
        env_vars: {
          ...workspace.env_vars,
          TF_VAR_proxmox_endpoint: connection.base.toString(),
          TF_VAR_proxmox_api_token: connection.apiToken,
          TF_VAR_proxmox_insecure: connection.insecure ? 'true' : 'false',
          ...(sshPublicKey && !String(sshPublicKey).startsWith('enc:') ? { TF_VAR_ssh_public_key: sshPublicKey } : {}),
        },
      };
    } catch (error) {
      log.warn({ err: error, workspace: workspace.name }, 'Could not resolve Proxmox connection source');
      return workspace;
    }
  }

  function workspaceBackendType(workspace) {
    if (!fs.existsSync(workspace.path)) return 'local';
    for (const file of fs.readdirSync(workspace.path).filter(name => name.endsWith('.tf'))) {
      const content = fs.readFileSync(path.join(workspace.path, file), 'utf8');
      const match = content.match(/backend\s+"([A-Za-z0-9_-]+)"\s*\{/);
      if (match) return match[1].toLowerCase();
    }
    return 'local';
  }

  function stateBackupDirectory(workspace) {
    return path.join(TOFU_STATE_BACKUP_ROOT, workspace.id);
  }

  function ensureStateSafety(workspace) {
    const backend = workspaceBackendType(workspace);
    if (backend !== 'local') return { backend, mode: 'remote', locking: true };
    if (!cryptoUtil.isEncryptionAvailable()) {
      const error = new Error('FLEET_KEY_SECRET is required for encrypted local state backups. Alternatively, configure a remote backend.');
      error.status = 503;
      throw error;
    }
    const dir = stateBackupDirectory(workspace);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return { backend, mode: 'encrypted-backup', locking: false, backup_directory: dir };
  }

  function backupLocalState(workspace, reason) {
    const safety = ensureStateSafety(workspace);
    if (safety.mode === 'remote') return null;
    const statePath = path.join(workspace.path, 'terraform.tfstate');
    if (!fs.existsSync(statePath)) return null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}-${String(reason || 'run').replace(/[^a-z0-9_-]/gi, '-')}.tfstate.enc`;
    const target = path.join(stateBackupDirectory(workspace), filename);
    fs.writeFileSync(target, cryptoUtil.encrypt(fs.readFileSync(statePath, 'utf8')), { encoding: 'utf8', mode: 0o600 });
    const backups = fs.readdirSync(stateBackupDirectory(workspace)).filter(name => name.endsWith('.tfstate.enc')).sort().reverse();
    for (const old of backups.slice(TOFU_STATE_BACKUP_KEEP)) fs.unlinkSync(path.join(stateBackupDirectory(workspace), old));
    return filename;
  }

  function listStateBackups(workspace) {
    const dir = stateBackupDirectory(workspace);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.tfstate.enc')).sort().reverse().map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, created_at: stat.mtime.toISOString(), size: stat.size };
    });
  }

  function getProxmoxVms(workspaceId) {
    return db.db.prepare('SELECT * FROM tofu_proxmox_vms WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(workspaceId)
      .map(row => {
        try {
          // Older form entries accepted a bare static address. Normalizing on
          // read repairs those definitions when the generated files are next
          // written, without requiring users to recreate their VM.
          return { ...normalizeProxmoxVm(JSON.parse(row.config)), id: row.id, created_at: row.created_at, updated_at: row.updated_at };
        }
        catch { return null; }
      })
      .filter(Boolean);
  }

  function getProxmoxVmTemplates(workspaceId) {
    return db.db.prepare('SELECT * FROM tofu_proxmox_vm_templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(workspaceId)
      .map(row => {
        try {
          return {
            id: row.id,
            name: row.name,
            config: normalizeProxmoxVm(JSON.parse(row.config)),
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
        } catch { return null; }
      })
      .filter(Boolean);
  }

  function validatePostDeployPlaybookAccess(playbooks, req) {
    if (!playbooks.length) return;
    const permissions = getPermissions(req.user);
    if (!can(permissions, 'canRunPlaybooks')) {
      throw new Error('Your role is not allowed to run playbooks.');
    }
    const available = new Set(ansibleRunner.getAvailablePlaybooks().map(playbook => playbook.filename));
    for (const playbook of playbooks) {
      if (!available.has(playbook)) throw new Error(`Playbook not found: ${playbook}`);
      if (!canAccessPlaybook(permissions, playbook)) throw new Error(`Playbook not allowed: ${playbook}`);
    }
  }

  function pendingPostDeployJobs(workspace, syncedServers, { onlyVmId = null, onlyPlaybook = null, force = false } = {}) {
    const syncedByResource = new Map((Array.isArray(syncedServers) ? syncedServers : [])
      .map(server => [server.resource_key, server])
      .filter(([resourceKey]) => Boolean(resourceKey)));
    const completed = new Set(db.db.prepare(`
      SELECT vm_id, playbook FROM tofu_proxmox_playbook_runs
      WHERE workspace_id = ? AND status = 'success'
    `).all(workspace.id).map(row => `${row.vm_id}\u0000${row.playbook}`));

    return getProxmoxVms(workspace.id).flatMap(vm => {
      if (onlyVmId && vm.id !== onlyVmId) return [];
      const server = syncedByResource.get(`resource:proxmox_virtual_environment_vm.${vm.name}`);
      if (!server || !Array.isArray(vm.post_deploy_playbooks)) return [];
      return vm.post_deploy_playbooks
        .filter(playbook => (!onlyPlaybook || playbook === onlyPlaybook) && (force || !completed.has(`${vm.id}\u0000${playbook}`)))
        .map(playbook => ({ vm, server, playbook }));
    });
  }

  async function runPostDeployPlaybooks({ workspace, syncedServers, logMeta, emitMeta, onlyVmId = null, onlyPlaybook = null, force = false }) {
    const jobs = pendingPostDeployJobs(workspace, syncedServers, { onlyVmId, onlyPlaybook, force });
    if (!jobs.length) return { started: 0, succeeded: 0, failed: 0 };

    // Ensure that the selected Fleet playbooks reflect the configured Git
    // source immediately before provisioning starts.
    await getGitSync()?.autoPull?.();
    const available = new Set(ansibleRunner.getAvailablePlaybooks().map(playbook => playbook.filename));
    const mappingByResource = new Map(db.db.prepare(
      'SELECT resource_key, server_id FROM tofu_managed_servers WHERE workspace_id = ?'
    ).all(workspace.id).map(row => [row.resource_key, row.server_id]));
    const serverById = new Map(db.servers.getAll().map(server => [server.id, server]));
    const saveResult = db.db.prepare(`
      INSERT INTO tofu_proxmox_playbook_runs (workspace_id, vm_id, playbook, status, output, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'success' THEN datetime('now') ELSE NULL END, datetime('now'))
      ON CONFLICT(workspace_id, vm_id, playbook) DO UPDATE SET
        status = excluded.status, output = excluded.output,
        completed_at = excluded.completed_at, updated_at = datetime('now')
    `);
    const result = { started: 0, succeeded: 0, failed: 0 };

    for (const job of jobs) {
      const target = serverById.get(mappingByResource.get(job.server.resource_key));
      if (!target) {
        const output = `[Fleet] The target server for post-deploy playbook "${job.playbook}" is not available yet.`;
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        emitMeta(`${output}\n`);
        result.failed++;
        return result;
      }
      result.started++;
      const historyId = db.updateHistory.create(target.id, `ansible:${job.playbook}`, logMeta.user || null);
      const scheduleHistoryId = db.scheduleHistory.create(null, `OpenTofu ${workspace.name}`, job.playbook, target.name, {
        environmentId: workspace.environment_id || 'default',
        triggeredBy: logMeta.user || null,
      });
      if (!available.has(job.playbook)) {
        const output = `[Fleet] Playbook not found: ${job.playbook}`;
        db.updateHistory.updateStatus(historyId, 'failed', output);
        db.scheduleHistory.complete(scheduleHistoryId, 'failed', output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        emitMeta(`${output}\n`);
        result.failed++;
        return result;
      }

      emitMeta(`[Fleet] Running post-deploy playbook "${job.playbook}" on ${target.name}.\n`);
      try {
        const run = await ansibleRunner.runPlaybook(job.playbook, target.name, {
          ...(job.vm.playbook_variables || {}),
          fleet_workspace: workspace.name,
          fleet_vm: job.vm.name,
        }, (stream, data) => emitMeta(`[${job.playbook}/${stream}] ${data}`), {
          environmentId: workspace.environment_id || 'default',
          runId: scheduleHistoryId,
        });
        const output = `${run.stdout || ''}${run.stderr || ''}`;
        const status = run.success ? 'success' : 'failed';
        db.updateHistory.updateStatus(historyId, status, output);
        db.scheduleHistory.complete(scheduleHistoryId, status, output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, status, output, status);
        db.auditLog.write('tofu.post_deploy_playbook', `workspace=${workspace.name} vm=${job.vm.name} playbook=${job.playbook} status=${status}`, logMeta.ip || null, run.success, logMeta.user || null);
        if (run.success) {
          result.succeeded++;
          emitMeta(`[Fleet] Post-deploy playbook "${job.playbook}" completed successfully.\n`);
        } else {
          result.failed++;
          emitMeta(`[Fleet] Post-deploy playbook "${job.playbook}" failed and will be retried during a later apply.\n`);
        }
      } catch (error) {
        const output = error.message || String(error);
        db.updateHistory.updateStatus(historyId, 'failed', output);
        db.scheduleHistory.complete(scheduleHistoryId, 'failed', output);
        saveResult.run(workspace.id, job.vm.id, job.playbook, 'failed', output, 'failed');
        db.auditLog.write('tofu.post_deploy_playbook', `workspace=${workspace.name} vm=${job.vm.name} playbook=${job.playbook} error=${output}`, logMeta.ip || null, false, logMeta.user || null);
        result.failed++;
        emitMeta(`[Fleet] Post-deploy playbook "${job.playbook}" could not be started: ${output}\n`);
      }
      if (result.failed) return result;
    }
    return result;
  }

  async function runPreDeployPlaybooks({ workspace, logMeta, emitMeta }) {
    const jobs = getProxmoxVms(workspace.id).flatMap(vm =>
      (vm.pre_deploy_playbooks || []).map(playbook => ({
        vm,
        playbook,
        serverId: String(vm.pre_deploy_target_server_id || '').trim(),
      })),
    );
    if (!jobs.length) return { started: 0, succeeded: 0 };
    await getGitSync()?.autoPull?.();
    const available = new Set(ansibleRunner.getAvailablePlaybooks().map(playbook => playbook.filename));
    const serverById = new Map(db.servers.getAll().map(server => [String(server.id), server]));
    let succeeded = 0;
    for (const job of jobs) {
      const target = serverById.get(job.serverId);
      if (!target || String(target.environment_id || 'default') !== String(workspace.environment_id || 'default')) {
        throw new Error(`Pre-deploy target for ${job.vm.name} is unavailable in this environment.`);
      }
      if (!available.has(job.playbook)) throw new Error(`Pre-deploy playbook not found: ${job.playbook}`);
      const historyId = db.updateHistory.create(target.id, `ansible:${job.playbook}`, logMeta.user || null);
      const scheduleHistoryId = db.scheduleHistory.create(null, `Pre-deploy ${workspace.name}`, job.playbook, target.name, {
        environmentId: workspace.environment_id || 'default',
        triggeredBy: logMeta.user || null,
      });
      emitMeta(`[Fleet] Running pre-deploy playbook "${job.playbook}" on ${target.name}.`);
      try {
        const run = await ansibleRunner.runPlaybook(job.playbook, target.name, {
          ...(job.vm.playbook_variables || {}),
          fleet_workspace: workspace.name,
          fleet_vm: job.vm.name,
          fleet_phase: 'pre_deploy',
        }, (stream, data) => emitMeta(`[pre-deploy/${job.playbook}/${stream}] ${data}`), {
          environmentId: workspace.environment_id || 'default',
          runId: scheduleHistoryId,
        });
        const output = `${run.stdout || ''}${run.stderr || ''}`;
        const status = run.success ? 'success' : 'failed';
        db.updateHistory.updateStatus(historyId, status, output);
        db.scheduleHistory.complete(scheduleHistoryId, status, output);
        db.auditLog.write('tofu.pre_deploy_playbook', `workspace=${workspace.name} vm=${job.vm.name} playbook=${job.playbook} status=${status}`, logMeta.ip || null, run.success, logMeta.user || null);
        if (!run.success) throw new Error(`Pre-deploy playbook "${job.playbook}" failed. OpenTofu was not started.`);
        succeeded++;
      } catch (error) {
        db.updateHistory.updateStatus(historyId, 'failed', error.message || String(error));
        db.scheduleHistory.complete(scheduleHistoryId, 'failed', error.message || String(error));
        throw error;
      }
    }
    return { started: jobs.length, succeeded };
  }

  function getPostDeployOverview(workspaceId) {
    const statusByKey = new Map(db.db.prepare(`
      SELECT vm_id, playbook, status, output, completed_at, updated_at
      FROM tofu_proxmox_playbook_runs WHERE workspace_id = ?
    `).all(workspaceId).map(row => [`${row.vm_id}\u0000${row.playbook}`, row]));
    const entries = getProxmoxVms(workspaceId).flatMap(vm => (vm.post_deploy_playbooks || []).map((playbook, position) => {
      const current = statusByKey.get(`${vm.id}\u0000${playbook}`);
      return {
        vm_id: vm.id,
        vm_name: vm.name,
        playbook,
        position: position + 1,
        status: current?.status || 'pending',
        output: current?.output || '',
        completed_at: current?.completed_at || null,
        updated_at: current?.updated_at || null,
      };
    }));
    const counts = entries.reduce((result, entry) => {
      result[entry.status] = (result[entry.status] || 0) + 1;
      return result;
    }, { pending: 0, running: 0, success: 0, failed: 0 });
    return { entries, counts };
  }

  function writeFleetProxmoxFiles(workspace, configuredVms = null) {
    const vms = configuredVms || getProxmoxVms(workspace.id);
    const files = buildProxmoxProviderFiles(vms);
    fs.mkdirSync(workspace.path, { recursive: true });
    const handWrittenTerraform = readTerraformFiles(workspace.path)
      .filter(file => !file.name.startsWith('fleet-proxmox-'))
      .map(file => file.content)
      .join('\n');
    const hasProvider = /provider\s+"proxmox"\s*\{/.test(handWrittenTerraform);
    const hasVariable = name => new RegExp(`variable\\s+"${escapeRegExp(name)}"\\s*\\{`).test(handWrittenTerraform);
    const missingVariables = [
      ['proxmox_endpoint', 'type = string'],
      ['proxmox_api_token', 'type = string\n  sensitive = true'],
      ['proxmox_insecure', 'type = bool\n  default = false'],
      ...[...new Set(vms.map(vm => vm.ssh_public_key_variable).filter(Boolean))].map(name => [name, 'type = string\n  sensitive = true']),
    ].filter(([name]) => !hasVariable(name));
    const providerPath = path.join(workspace.path, 'fleet-proxmox-provider.tf');
    const variablesPath = path.join(workspace.path, 'fleet-proxmox-variables.tf');
    const vmPath = path.join(workspace.path, 'fleet-proxmox-vms.tf');
    fs.writeFileSync(providerPath, hasProvider
      ? '# Fleet uses the existing Proxmox provider configuration in this workspace.\n'
      : files.provider, 'utf8');
    fs.writeFileSync(variablesPath, missingVariables.length
      ? `# Generated by Fleet. Secret values are never written to this file.\n${missingVariables.map(([name, body]) => `\nvariable "${name}" {\n  ${body.replace(/\n/g, '\n  ')}\n}\n`).join('')}`
      : '# This workspace already declares the variables required by Fleet Proxmox VMs.\n', 'utf8');
    fs.writeFileSync(vmPath, files.vms, 'utf8');
    return { files: ['fleet-proxmox-provider.tf', 'fleet-proxmox-variables.tf', 'fleet-proxmox-vms.tf'], vms };
  }

  function syncFleetWorkspace(workspace, message) {
    const gs = getGitSync();
    if (gs?.isConfigured()) {
      syncOneToGit(workspace.name, workspace.path);
      gs.autoPush(message).catch(error => log.warn({ err: error, workspace: workspace.name }, 'Could not auto-push Proxmox workspace'));
    }
  }

  async function loadProxmoxCatalog(workspace, requestedNode = '') {
    const connection = readProxmoxConnection(workspace.env_vars);
    const nodesResponse = await requestProxmoxApi(connection, '/nodes');
    const nodes = (Array.isArray(nodesResponse) ? nodesResponse : [])
      .map(node => ({
        name: String(node?.node || '').trim(),
        status: String(node?.status || '').trim(),
        online: String(node?.status || '').toLowerCase() === 'online',
      }))
      .filter(node => node.name && PROXMOX_IDENTIFIER_RE.test(node.name));
    if (!nodes.length) throw new Error('No nodes were found in Proxmox.');

    const wantedNode = String(requestedNode || '').trim();
    const nodeName = nodes.some(node => node.name === wantedNode)
      ? wantedNode
      : (nodes.find(node => node.online) || nodes[0]).name;
    const safeNode = encodeURIComponent(nodeName);
    const [nextIdResponse, templatesResponse, storageResponse, networkResponse, zonesResult, vnetsResult] = await Promise.all([
      requestProxmoxApi(connection, '/cluster/nextid'),
      requestProxmoxApi(connection, `/nodes/${safeNode}/qemu?full=1`),
      requestProxmoxApi(connection, `/nodes/${safeNode}/storage`),
      requestProxmoxApi(connection, `/nodes/${safeNode}/network`),
      requestProxmoxApi(connection, '/cluster/sdn/zones').then(value => ({ value })).catch(error => ({ error })),
      requestProxmoxApi(connection, '/cluster/sdn/vnets').then(value => ({ value })).catch(error => ({ error })),
    ]);
    const nextVmId = Number.parseInt(String(nextIdResponse?.vmid ?? nextIdResponse ?? ''), 10);
    const templates = (Array.isArray(templatesResponse) ? templatesResponse : [])
      .filter(item => item && (item.template === 1 || item.template === '1' || item.template === true))
      .map(item => ({ vm_id: Number(item.vmid), name: String(item.name || `VM ${item.vmid}`), node_name: nodeName }))
      .filter(item => Number.isInteger(item.vm_id) && item.vm_id > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const datastores = (Array.isArray(storageResponse) ? storageResponse : [])
      .filter(item => item && item.storage)
      .map(item => ({
        id: String(item.storage),
        type: String(item.type || ''),
        content: Array.isArray(item.content) ? item.content : String(item.content || '').split(',').filter(Boolean),
      }))
      .filter(item => item.content.length === 0 || item.content.includes('images'))
      .sort((a, b) => {
        const aZfs = /zfs/i.test(`${a.type} ${a.id}`) ? 1 : 0;
        const bZfs = /zfs/i.test(`${b.type} ${b.id}`) ? 1 : 0;
        return bZfs - aZfs || a.id.localeCompare(b.id, 'de');
      });
    const networkCatalog = buildProxmoxNetworkCatalog(
      networkResponse,
      zonesResult.value,
      vnetsResult.value,
      nodeName
    );
    const sdnWarnings = [zonesResult.error, vnetsResult.error]
      .filter(Boolean)
      .map(error => String(error.message || 'SDN catalog unavailable'));
    if (sdnWarnings.length) log.warn(`Could not load the complete Proxmox SDN catalog: ${sdnWarnings.join('; ')}`);

    return {
      nodes,
      node: nodeName,
      next_vm_id: Number.isInteger(nextVmId) && nextVmId > 0 ? nextVmId : null,
      templates,
      datastores,
      ...networkCatalog,
      sdn_warnings: sdnWarnings,
    };
  }

  async function resolveFleetProxmoxServers({ workspace, state, servers }) {
    const vms = getProxmoxVms(workspace.id);
    const resourceKeys = new Set(getProxmoxStateResources(state).map(normalizeResourceKey));
    const matchingVms = vms.filter(vm => resourceKeys.has(`resource:proxmox_virtual_environment_vm.${vm.name}`));
    if (!matchingVms.length) return { servers, pending: false };

    let connection;
    try {
      connection = readProxmoxConnection(workspace.env_vars);
    } catch (error) {
      // OpenTofu state remains a useful fallback for old workspaces that do
      // not have API credentials configured in the Fleet form yet.
      log.warn({ err: error, workspace: workspace.name }, 'Could not enrich Fleet Proxmox server details');
      return { ...applyFleetProxmoxBlueprintMetadata({ servers, state, vms }), pending: false };
    }

    const resourceByKey = new Map(
      getProxmoxStateResources(state)
        .map(resource => [normalizeResourceKey(resource), resource])
        .filter(([key]) => key)
    );
    const guestIps = new Map();
    const settled = await Promise.allSettled(matchingVms.map(async vm => {
      const resourceKey = `resource:proxmox_virtual_environment_vm.${vm.name}`;
      const resource = resourceByKey.get(resourceKey);
      const vmId = Number.parseInt(String(resource?.values?.vm_id ?? vm.vm_id ?? ''), 10);
      const nodeName = String(resource?.values?.node_name || vm.node_name || '').trim();
      if (!Number.isInteger(vmId) || vmId <= 0 || !nodeName) return { resourceKey, queried: false };
      const data = await requestProxmoxApi(
        connection,
        `/nodes/${encodeURIComponent(nodeName)}/qemu/${vmId}/agent/network-get-interfaces`
      );
      const ip = extractProxmoxGuestIpv4(data);
      if (ip) guestIps.set(resourceKey, ip);
      return { resourceKey, queried: true };
    }));
    const failed = settled.filter(result => result.status === 'rejected');
    if (failed.length) {
      log.warn({ workspace: workspace.name, count: failed.length }, 'Could not read one or more Proxmox guest IP addresses');
    }

    const enriched = applyFleetProxmoxBlueprintMetadata({ servers, state, vms, guestIps });
    return {
      servers: enriched.servers,
      // An unavailable guest agent is still pending while the VM boots.
      pending: enriched.pendingDhcpResourceKeys.length > 0,
    };
  }

  async function registerIdentifiedHost({ workspace, binary, env, dbRunId, logMeta, emitMeta }) {
    await verifyVmIdentity({ workspace, vms: getProxmoxVms(workspace.id), state: await loadWorkspaceState({ binary, workspace, env }), checkConfiguration: false });
    db.db.prepare("UPDATE tofu_runs SET deployment_phase = 'register_host' WHERE id = ?").run(dbRunId);
    if (workspace.workspace_kind === 'isolated_vm') {
      const state = await loadWorkspaceState({ binary, workspace, env });
      const resources = new Map(getProxmoxStateResources(state).map(resource => [normalizeResourceKey(resource), resource]));
      const vm = getProxmoxVms(workspace.id)[0];
      const resourceKey = vm && `resource:proxmox_virtual_environment_vm.${vm.name}`;
      if (vm && resources.has(resourceKey)) {
        const mapping = db.db.prepare('SELECT server_id FROM tofu_managed_servers WHERE workspace_id = ? AND resource_key = ?').get(workspace.id, resourceKey);
        const existing = mapping ? db.servers.getById(mapping.server_id) : null;
        await reconcileManagedServers({ db, workspace, logMeta, desiredServers: [{
          resource_key: resourceKey, name: vm.name, hostname: vm.name,
          ip_address: existing?.ip_address || '', ssh_user: vm.username, ssh_port: vm.ssh_port || 22,
        }] });
        emitMeta('[Fleet] Host registered. Waiting for its address and SSH connection.');
      }
    }
  }

  async function finishHostDeployment({ workspace, binary, env, dbRunId, logMeta, emitMeta }) {
    await registerIdentifiedHost({ workspace, binary, env, dbRunId, logMeta, emitMeta });
    await verifyVmIdentity({ workspace, vms: getProxmoxVms(workspace.id), state: await loadWorkspaceState({ binary, workspace, env }) });
    return completeDeployment({
      allowEmpty: getProxmoxVms(workspace.id).length === 0,
      phase: value => db.db.prepare('UPDATE tofu_runs SET deployment_phase = ? WHERE id = ?').run(value, dbRunId),
      log: message => emitMeta(`[Fleet] ${message}`),
      discover: () => waitForManagedServers({
        loadState: () => loadWorkspaceState({ binary, workspace, env }),
        workspaceName: workspace.name,
        hydrateServers: ({ state, servers }) => resolveFleetProxmoxServers({ workspace, state, servers }),
      }),
      register: async sync => {
        await reconcileManagedServers({ db, workspace, desiredServers: sync.servers, logMeta });
        // Persist provider-assigned IDs for snapshots and future deployment runs.
        for (const resource of getProxmoxStateResources(sync.state)) {
          const vm = getProxmoxVms(workspace.id).find(vm => normalizeResourceKey(resource) === `resource:proxmox_virtual_environment_vm.${vm.name}`);
          const assigned = Number(resource.values?.vm_id);
          if (vm && Number.isInteger(assigned) && assigned > 0 && vm.vm_id !== assigned) {
            db.db.prepare('UPDATE tofu_proxmox_vms SET config = ?, vm_numeric_id = ? WHERE id = ?').run(JSON.stringify({ ...vm, vm_id: assigned }), assigned, vm.id);
          }
        }
        const mappings = db.db.prepare('SELECT resource_key, server_id FROM tofu_managed_servers WHERE workspace_id = ?').all(workspace.id);
        return sync.servers.map(server => db.servers.getById(mappings.find(mapping => mapping.resource_key === server.resource_key)?.server_id)).filter(Boolean);
      },
      connect: async host => {
        const connected = await require('../../services/ssh-manager').testConnection(host);
        db.servers.updateStatus(host.id, connected ? 'online' : 'offline');
        return connected;
      },
      postDeploy: syncedServers => runPostDeployPlaybooks({ workspace, syncedServers, logMeta, emitMeta }),
    });
  }

  function getWorkspaceRows(environmentId = null) {
    const rows = environmentId
      ? db.db.prepare('SELECT * FROM tofu_workspaces WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
      : db.db.prepare('SELECT * FROM tofu_workspaces ORDER BY name COLLATE NOCASE').all();
    return rows.filter(workspace => isAllowedPath(workspace.path));
  }

  function validateUniqueWorkspaceName(value, exceptId = null) {
    const name = normalizedWorkspaceName(value);
    const existing = exceptId
      ? db.db.prepare('SELECT id FROM tofu_workspaces WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId)
      : db.db.prepare('SELECT id FROM tofu_workspaces WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) throw new Error('A deployment with this name already exists. Names must be globally unique because they are stored in Git.');
    return name;
  }

  function validateUniqueWorkspacePath(value, exceptId = null) {
    const resolved = path.resolve(String(value || '').trim());
    const collision = getWorkspaceRows().find(workspace => workspace.id !== exceptId && path.resolve(workspace.path) === resolved);
    if (collision) throw new Error(`The workspace path is already used by "${collision.name}".`);
    return String(value || '').trim();
  }

  function getAllWorkspaces(environmentId = null) {
    return getWorkspaceRows(environmentId).map(workspace => ({ id: workspace.id, name: workspace.name, path: workspace.path }));
  }

  function listProxmoxConnectionRows(environmentId = null) {
    return environmentId
      ? db.db.prepare('SELECT * FROM tofu_proxmox_connections WHERE environment_id = ? ORDER BY name COLLATE NOCASE').all(environmentId)
      : db.db.prepare('SELECT * FROM tofu_proxmox_connections ORDER BY name COLLATE NOCASE').all();
  }

  function publicProxmoxConnection(row) {
    return {
      id: row.id,
      environment_id: row.environment_id,
      name: row.name,
      endpoint: row.endpoint,
      insecure: Boolean(row.insecure),
      api_token_configured: Boolean(row.api_token),
      ssh_public_key_configured: Boolean(row.ssh_public_key),
      ca_certificate_configured: Boolean(row.ca_certificate),
      auto_sync_ipam: row.auto_sync_ipam === undefined ? true : Boolean(row.auto_sync_ipam),
      sync_interval_min: Math.min(1440, Math.max(5, Number.parseInt(row.sync_interval_min, 10) || 15)),
      last_ipam_synced_at: row.last_ipam_synced_at || null,
      last_ipam_status: row.last_ipam_status || '',
      last_ipam_error: row.last_ipam_error || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }


  function collectProxmoxInfrastructureGroups(environmentId) {
    const grouped = new Map();
    const warnings = [];
    for (const row of listProxmoxConnectionRows(environmentId)) {
      try {
        const connection = readSavedProxmoxConnection(row);
        const key = `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}`;
        const group = grouped.get(key) || { key, connection, environmentId: row.environment_id || 'default', workspaces: [], connections: [] };
        group.connections.push({ id: row.id, name: row.name });
        grouped.set(key, group);
      } catch (error) {
        warnings.push(error.message || 'A Proxmox connection is incomplete.');
      }
    }
    for (const row of getAllWorkspaces(environmentId)) {
      const workspace = getWorkspace(row.id);
      if (!workspace) continue;
      try {
        const connection = readProxmoxConnection(workspace.env_vars);
        const key = `${connection.base.origin}${connection.base.pathname.replace(/\/+$/, '')}`;
        const group = grouped.get(key) || { key, connection, environmentId: workspace.environment_id || 'default', workspaces: [], connections: [] };
        group.workspaces.push({ id: workspace.id, name: workspace.name });
        grouped.set(key, group);
      } catch {
        // A regular OpenTofu workspace does not need to be a Proxmox source.
      }
    }
    return { grouped, warnings };
  }

  // Build a read-only inventory from environment connections first, then use
  // legacy deployment credentials as a compatibility fallback. This keeps
  // infrastructure independent from individual OpenTofu workspaces.
  async function loadProxmoxInfrastructure(environmentId = null) {
    // Also clean during a live inventory refresh, so an already-running
    // process stops exposing stale links without requiring a restart.
    removeOrphanedServerMappings(db);
    const { grouped, warnings } = collectProxmoxInfrastructureGroups(environmentId);

    const settled = await Promise.allSettled([...grouped.values()].map(async group => {
      const nodesResponse = await requestProxmoxApi(group.connection, '/nodes');
      const nodes = (Array.isArray(nodesResponse) ? nodesResponse : [])
        .map(node => ({
          name: String(node?.node || '').trim(),
          status: String(node?.status || '').toLowerCase() || 'unknown',
          cpu: Number(node?.cpu) || 0,
          maxcpu: Number(node?.maxcpu) || 0,
          mem: Number(node?.mem) || 0,
          maxmem: Number(node?.maxmem) || 0,
          disk: Number(node?.disk) || 0,
          maxdisk: Number(node?.maxdisk) || 0,
          uptime: Number(node?.uptime) || 0,
          datastores: [],
        }))
        .filter(node => node.name && PROXMOX_IDENTIFIER_RE.test(node.name));
      const [resourcesResponse, storageResults, statusResults, networkResults, updateResults] = await Promise.all([
        requestProxmoxApi(group.connection, '/cluster/resources?type=vm'),
        Promise.allSettled(nodes.map(node => requestProxmoxApi(group.connection, `/nodes/${encodeURIComponent(node.name)}/storage`))),
        // Node status is informative, not required for inventory.  Some API
        // tokens intentionally only expose inventory endpoints, so retain the
        // platform even when detailed host facts cannot be read.
        Promise.allSettled(nodes.map(node => requestProxmoxApi(group.connection, `/nodes/${encodeURIComponent(node.name)}/status`))),
        // The raw Proxmox network endpoint contains every physical NIC.  The
        // console deliberately retains only bridge interfaces here: these are
        // the operator-relevant networks VMs are attached to.
        Promise.allSettled(nodes.map(node => requestProxmoxApi(group.connection, `/nodes/${encodeURIComponent(node.name)}/network`))),
        // Package inventory requires Sys.Modify in Proxmox. Keep it optional
        // so read-only API tokens still provide the rest of the platform.
        Promise.allSettled(nodes.map(node => requestProxmoxApi(group.connection, `/nodes/${encodeURIComponent(node.name)}/apt/update`))),
      ]);
      const datastores = collectStorageResults(nodes, storageResults);
      statusResults.forEach((result, index) => {
        if (result.status !== 'fulfilled' || !result.value || typeof result.value !== 'object') return;
        const node = nodes[index];
        const details = result.value;
        node.platform_version = typeof details.pveversion === 'string' ? details.pveversion : null;
        node.kernel_version = typeof details.kversion === 'string' ? details.kversion : null;
        node.cpu_model = typeof details.cpuinfo?.model === 'string' ? details.cpuinfo.model : null;
        node.cpu_sockets = Number(details.cpuinfo?.sockets) || null;
      });
      networkResults.forEach((result, index) => {
        const node = nodes[index];
        node.network_checked_at = new Date().toISOString();
        node.network_status = result.status === 'fulfilled' && Array.isArray(result.value) ? 'available' : 'unavailable';
        if (node.network_status !== 'available') return;
        node.network_interfaces = result.value
          .filter(item => item && item.iface)
          .map(item => ({
            name: String(item.iface),
            type: String(item.type || ''),
            active: [1, '1', true].includes(item.active) ? true : [0, '0', false].includes(item.active) ? false : null,
            address: typeof item.address === 'string' && item.address.trim() ? item.address.trim() : null,
            cidr: (typeof item.cidr === 'number' || (typeof item.cidr === 'string' && /^\d+$/.test(item.cidr))) && Number.isInteger(Number(item.cidr)) && Number(item.cidr) >= 0 && Number(item.cidr) <= 32 ? Number(item.cidr) : null,
            gateway: typeof item.gateway === 'string' && item.gateway.trim() ? item.gateway.trim() : null,
            address6: typeof item.address6 === 'string' && item.address6.trim() ? item.address6.trim() : null,
            cidr6: (typeof item.cidr6 === 'number' || (typeof item.cidr6 === 'string' && /^\d+$/.test(item.cidr6))) && Number.isInteger(Number(item.cidr6)) && Number(item.cidr6) >= 0 && Number(item.cidr6) <= 128 ? Number(item.cidr6) : null,
            gateway6: typeof item.gateway6 === 'string' && item.gateway6.trim() ? item.gateway6.trim() : null,
          }));
        node.bridges = node.network_interfaces.filter(item => item.type.toLowerCase() === 'bridge' || /^vmbr/i.test(item.name));
      });
      const fleetServers = db.servers.getAll().filter(server =>
        String(server.environment_id || 'default') === String(group.environmentId || 'default'));
      const normalizedHost = value => String(value || '').trim().toLowerCase().replace(/\.$/, '');
      const shortHost = value => normalizedHost(value).split('.')[0];
      updateResults.forEach((result, index) => {
        const node = nodes[index];
        const packages = result.status === 'fulfilled' && Array.isArray(result.value)
          ? result.value.map(item => ({
            package: String(item?.Package || ''),
            title: String(item?.Title || item?.Package || ''),
            description: String(item?.Description || ''),
            origin: String(item?.Origin || ''),
            current_version: String(item?.OldVersion || ''),
            available_version: String(item?.Version || ''),
            priority: String(item?.Priority || ''),
            section: String(item?.Section || ''),
          })).filter(item => item.package)
          : [];
        const nodeHost = normalizedHost(node.name);
        const nodeAddresses = new Set((node.bridges || []).map(bridge => normalizedHost(bridge.address)).filter(Boolean));
        const fleetServer = fleetServers.find(server => {
          const candidates = [server.hostname, server.name].map(normalizedHost).filter(Boolean);
          return candidates.some(candidate => candidate === nodeHost || shortHost(candidate) === shortHost(nodeHost))
            || nodeAddresses.has(normalizedHost(server.ip_address));
        });
        node.available_updates = packages;
        node.update_count = packages.length;
        node.update_status = result.status === 'fulfilled' ? (packages.length ? 'available' : 'current') : 'unavailable';
        node.update_error = result.status === 'rejected' ? String(result.reason?.message || 'Update catalog unavailable') : null;
        node.fleet_server_id = fleetServer?.id || null;
      });
      const sourceIds = group.connections.map(connection => connection.id).filter(Boolean);
      const adoptedByVm = new Map();
      if (sourceIds.length) {
        const placeholders = sourceIds.map(() => '?').join(', ');
        const adopted = db.db.prepare(`
          SELECT inventory.server_id, inventory.connection_id, inventory.node_name, inventory.vm_id, inventory.guest_type
          FROM proxmox_inventory_servers inventory
          JOIN servers ON servers.id = inventory.server_id
          WHERE inventory.connection_id IN (${placeholders})
        `).all(...sourceIds);
        for (const item of adopted) {
          adoptedByVm.set(`${item.connection_id}:${item.node_name}:${item.vm_id}:${item.guest_type || 'qemu'}`, {
            serverId: item.server_id,
            connectionId: item.connection_id,
          });
        }
      }
      const vms = (Array.isArray(resourcesResponse) ? resourcesResponse : [])
        .filter(resource => ['qemu', 'lxc'].includes(String(resource?.type || '').toLowerCase()))
        .map(resource => {
          const nodeName = String(resource?.node || '').trim();
          const vmId = Number(resource?.vmid) || null;
          const guestType = String(resource?.type || '').toLowerCase();
          const adopted = sourceIds.map(sourceId => adoptedByVm.get(`${sourceId}:${nodeName}:${vmId}:${guestType}`)).find(Boolean) || null;
          const { disk, maxdisk } = normalizeProxmoxDiskUsage(resource, guestType);
          return {
            name: String(resource?.name || `${guestType === 'lxc' ? 'CT' : 'VM'} ${resource?.vmid || '?'}`),
            guest_type: guestType,
            node_name: nodeName,
            vm_id: vmId,
            status: String(resource?.status || '').toLowerCase() || 'unknown',
            cpu: Number(resource?.cpu) || 0,
            maxcpu: Number(resource?.maxcpu) || 0,
            mem: Number(resource?.mem) || 0,
            maxmem: Number(resource?.maxmem) || 0,
            disk,
            maxdisk,
            fleet_server_id: adopted?.serverId || null,
            // A cluster can combine equivalent platform connections. Keep the
            // exact source that adopted this VM so its detail view resolves
            // the correct Fleet-host mapping instead of guessing the first
            // connection in the group.
            fleet_connection_id: adopted?.connectionId || null,
          };
        })
        .filter(vm => vm.node_name && Number.isInteger(vm.vm_id));
      return {
        id: group.key,
        endpoint: group.connection.base.host,
        status: nodes.some(node => node.status === 'online') ? 'online' : 'offline',
        connections: group.connections,
        deployments: group.workspaces,
        nodes,
        vms,
        datastores,
      };
    }));

    const clusters = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') clusters.push(result.value);
      else warnings.push(result.reason?.message || 'A Proxmox connection could not be queried.');
    }
    return { clusters, warnings };
  }

  const getInfrastructureSummary = createInfrastructureSummary({
    db,
    log,
    collectProxmoxInfrastructureGroups,
    removeOrphanedServerMappings,
    requestProxmoxApi,
  });

  function ensureWorkspacePath(workspace) {
    if (fs.existsSync(workspace.path)) return null;
    try { fs.mkdirSync(workspace.path, { recursive: true }); return null; }
    catch (e) { return e; }
  }

  function permissionError(e, wsPath) {
    return e.code === 'EACCES'
      ? `Workspace is not writable: ${wsPath}. Restart Fleet so the container can repair mounted workspace ownership. If the error remains, verify that the mount is not read-only and does not use root-squash.`
      : e.message;
  }

  function safePath(wsPath, relPath) {
    try {
      const root = workspacePath(wsPath, ALLOWED_PATH_ROOTS);
      return confinedPath(root, path.resolve(root, relPath), true);
    } catch { return null; }
  }

  function isEditableTerraformPath(relPath) {
    const value = String(relPath || '').replace(/\\/g, '/');
    return Boolean(value) && !value.startsWith('/') && !value.split('/').includes('..') && value.endsWith('.tf');
  }

  function walkDir(dir, rel, depth) {
    if (depth > 5) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const result = [];
    for (const e of entries) {
      if (e.name === '.terraform' || e.name === '.git' || e.name === '.fleet') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const children = walkDir(path.join(dir, e.name), childRel, depth + 1);
        if (children.length) result.push({ type: 'dir', name: e.name, path: childRel, children });
      } else if (isEditableTerraformPath(childRel)) {
        result.push({ type: 'file', name: e.name, path: childRel });
      }
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function getLastRun(workspaceId) {
    return db.db.prepare(
      'SELECT * FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(workspaceId) || null;
  }

  // ── Routes: Status & Workspaces ───────────────────────────────────────────

  function deploymentCapability(req) {
    const pathname = req.path || '/';
    if (pathname === '/install') return 'canManageDeploymentPlatforms';
    if (/^\/proxmox-connections\/[^/]+\/(?:vm-catalog|vm-id-check)$/.test(pathname)) return 'canViewDeployments';
    if (/^\/proxmox-connections(?:\/[^/]+)?$/.test(pathname) && req.method !== 'GET') return 'canManageDeploymentPlatforms';
    if (pathname === '/infrastructure' || pathname === '/infrastructure-summary') return 'canViewInfrastructure';
    if (/^\/proxmox-connections(?:\/|$)/.test(pathname)) return 'canViewInfrastructure';
    // Node/VM operational actions have their own server/update/power guards.
    if (/^\/managed-servers\//.test(pathname)) return 'canViewServers';
    if (/\/promote-proxmox-connection$/.test(pathname)) return 'canManageDeploymentPlatforms';
    if (/\/proxmox-connection$/.test(pathname) && req.method !== 'GET') return 'canManageDeploymentPlatforms';
    if (/\/resume$/.test(pathname)) return 'canApplyDeployments';
    if (/\/post-deploy\/retry$/.test(pathname)) return 'canApplyDeployments';
    if (/^\/vms\/[^/]+\/apply$/.test(pathname)) return 'canApplyDeployments';
    if (/^\/vms\/[^/]+\/destroy$/.test(pathname)) return 'canDestroyDeployments';
    if (/^\/vms\/[^/]+\/(?:plan|check-drift)$/.test(pathname)) return 'canPlanDeployments';
    if (/^\/vms\/[^/]+\/forget$/.test(pathname)) return 'canEditDeployments';
    if (/\/state-backups\/restore$/.test(pathname)) return 'canDestroyDeployments';
    if (/\/cancel\//.test(pathname)) {
      const run = db.db.prepare('SELECT action FROM tofu_runs WHERE id = ?').get(pathname.split('/').pop());
      if (run?.action === 'apply') return 'canApplyDeployments';
      if (run?.action === 'destroy') return 'canDestroyDeployments';
      return 'canPlanDeployments';
    }
    if (/\/run$/.test(pathname) && req.method === 'POST') {
      if (req.body?.action === 'apply') return 'canApplyDeployments';
      if (req.body?.action === 'destroy' || req.body?.action === 'destroy_vm') return 'canDestroyDeployments';
      return 'canPlanDeployments';
    }
    if (req.method === 'GET') return 'canViewDeployments';
    return 'canEditDeployments';
  }

  function requestedDeploymentEnvironment(req) {
    const pathname = req.path || '/';
    if (pathname === '/proxmox-connections/test') return String(req.body?.environment_id || '').trim() || undefined;
    const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)/);
    if (workspaceMatch) {
      const workspace = getWorkspaceRow(decodeURIComponent(workspaceMatch[1]));
      return workspace ? String(workspace.environment_id || 'default') : null;
    }
    const vmMatch = pathname.match(/^\/vms\/([^/]+)/);
    if (vmMatch) {
      const row = db.db.prepare(`
        SELECT workspace.environment_id
        FROM tofu_proxmox_vms vm
        JOIN tofu_workspaces workspace ON workspace.id = vm.workspace_id
        WHERE vm.id = ? AND vm.is_isolated = 1
      `).get(decodeURIComponent(vmMatch[1]));
      return row ? String(row.environment_id || 'default') : null;
    }
    const legacyMatch = pathname.match(/^\/legacy-workspaces\/([^/]+)/);
    if (legacyMatch) {
      const row = getWorkspaceRow(decodeURIComponent(legacyMatch[1]));
      return row ? String(row.environment_id || 'default') : null;
    }
    const templateMatch = pathname.match(/^\/vm-templates\/([^/]+)/);
    if (templateMatch) {
      const row = db.db.prepare('SELECT environment_id FROM tofu_proxmox_vm_templates WHERE id = ?').get(decodeURIComponent(templateMatch[1]));
      return row ? String(row.environment_id || 'default') : null;
    }
    const connectionMatch = pathname.match(/^\/proxmox-connections\/([^/]+)/);
    if (connectionMatch) {
      const source = db.db.prepare('SELECT environment_id FROM tofu_proxmox_connections WHERE id = ?')
        .get(decodeURIComponent(connectionMatch[1]));
      return source ? String(source.environment_id || 'default') : null;
    }
    const managedServerMatch = pathname.match(/^\/managed-servers\/([^/]+)/);
    if (managedServerMatch) {
      const server = db.servers.getById(decodeURIComponent(managedServerMatch[1]));
      return server ? String(server.environment_id || 'default') : null;
    }
    if (pathname === '/workspaces' || pathname === '/vms' || pathname === '/vm-templates' || pathname === '/legacy-workspaces' || pathname === '/proxmox-connections') {
      return String(req.method === 'GET' ? req.query.environment_id || '' : req.body?.environment_id || '').trim() || undefined;
    }
    if (pathname === '/infrastructure' || pathname === '/infrastructure-summary') return String(req.query.environment_id || '').trim() || undefined;
    return null;
  }

  router.use((req, res, next) => {
    const permissions = getPermissions(req.user);
    const capability = deploymentCapability(req);
    if (!can(permissions, capability)) {
      return res.status(403).json({ error: 'OpenTofu access denied.', capability });
    }
    let environmentId;
    try { environmentId = requestedDeploymentEnvironment(req); }
    catch { return res.status(400).json({ error: 'Invalid resource ID.' }); }
    if (environmentId === undefined) return res.status(400).json({ error: 'environment_id is required' });
    if (environmentId && req.environmentId && environmentId !== req.environmentId) {
      return res.status(404).json({ error: 'Deployment resource not found.' });
    }
    if (environmentId && !canAccessEnvironment(permissions, environmentId)) {
      return res.status(404).json({ error: 'Deployment resource not found.' });
    }
    next();
  });


  // Environment-level Proxmox sources. They are deliberately independent of
  // a workspace so a cluster can be shown even when no OpenTofu deployment is
  // attached to it yet.
  registerPlatformRoutes({
    db,
    router,
    listProxmoxConnectionRows,
    publicProxmoxConnection,
    readSavedProxmoxConnection,
    getProxmoxVms,
    getLastRun,
  });

  registerIsolatedVmRoutes({
    db,
    router,
    backupLocalState,
    ensureWorkspacePath,
    findBinary,
    getPostDeployOverview,
    getWorkspace,
    internalVmRoot: INTERNAL_VM_ROOT,
    isAllowedPath,
    loadProxmoxCatalog,
    normalizeProxmoxVm,
    normalizeProxmoxVmTemplate,
    readSavedProxmoxConnection,
    syncPathsFile,
    validatePostDeployPlaybookAccess,
    writeFleetProxmoxFiles,
  });

  registerLegacyVmMigrationRoutes({
    db,
    router,
    backupLocalState,
    findBinary,
    getProxmoxVms,
    getWorkspace,
    internalVmRoot: INTERNAL_VM_ROOT,
    isAllowedPath,
    syncPathsFile,
    workspaceBackendType,
  });

  registerWorkspaceRoutes({
    db,
    router,
    activeRuns: _running,
    findBinary,
    getLastRun,
    getVersion,
    getInstallState: () => _installing,
    getWorkspace,
    getWorkspaceRow,
    getWorkspaceRows,
    isAllowedPath,
    parseWorkspaceEnvVars,
    permissionError,
    publicProxmoxConnection,
    scaffoldWorkspace,
    serializeWorkspaceEnvVars,
    syncPathsFile,
    validateUniqueWorkspaceName,
    validateUniqueWorkspacePath,
    WORKSPACE_PATH_ERROR,
  });

  registerDeploymentResumeRoutes({router, db, getWorkspace, getProxmoxVms, validatePostDeployPlaybookAccess, findBinary, redactTofuOutput, finishHostDeployment});

  registerRunRoutes({
    router,
    db,
    broadcast,
    activeRuns: _running,
    getGitSync,
    getWorkspace,
    getProxmoxVms,
    validatePostDeployPlaybookAccess,
    findBinary,
    ensureWorkspacePath,
    writeFleetProxmoxFiles,
    permissionError,
    ensureStateSafety,
    backupLocalState,
    runPreDeployPlaybooks,
    registerIdentifiedHost,
    finishHostDeployment,
    syncFleetWorkspace,
  });

  registerFileRoutes({
    router,
    ensureWorkspacePath,
    getWorkspace,
    isEditableTerraformPath,
    permissionError,
    safePath,
    walkDir,
  });

  registerVmRoutes({
    db,
    router,
    ensureWorkspacePath,
    findBinary,
    getPostDeployOverview,
    getProxmoxVmTemplates,
    getProxmoxVms,
    getWorkspace,
    getInfrastructureSummary,
    listProxmoxConnectionRows,
    loadProxmoxCatalog,
    loadProxmoxInfrastructure,
    permissionError,
    readSavedProxmoxConnection,
    runPostDeployPlaybooks,
    syncFleetWorkspace,
    validatePostDeployPlaybookAccess,
    writeFleetProxmoxFiles,
  });

  registerStateRoutes({
    db,
    router,
    backupLocalState,
    ensureStateSafety,
    ensureWorkspacePath,
    findBinary,
    getWorkspace,
    listStateBackups,
    stateBackupDirectory,
    workspaceBackendType,
  });

  // ── Routes: Install ───────────────────────────────────────────────────────

  router.get('/releases', async (req, res) => {
    try {
      const releases = await _fetchGitHubReleases();
      res.json({ releases });
    } catch (e) {
      res.status(502).json({ error: `OpenTofu release service unavailable: ${e.message}` });
    }
  });

  router.post('/install', async (req, res) => {
    const version = String(req.body?.version || '').trim();
    if (!VERSION_RE.test(version)) {
      return res.status(400).json({ error: 'Invalid version' });
    }
    if (_installing) return res.status(409).json({ error: 'An OpenTofu installation is already running.' });

    _installing = true;
    try {
      const releases = await _fetchGitHubReleases();
      const installedVersion = await installOpenTofu({
        version,
        architecture: process.arch,
        installPath: TOFU_INSTALL_PATH,
        releases,
        downloadFile: _downloadFile,
        execFile: execFileAsync,
      });
      _cachedBinary  = undefined;
      _cachedVersion = undefined;
      const bin = findBinary();
      const ver = bin ? getVersion(bin) : null;
      if (ver !== installedVersion) throw new Error('OpenTofu could not be started after installation.');
      db.auditLog.write('opentofu.install', `version=${ver} path=${TOFU_INSTALL_PATH}`, req.ip, true, req.user?.username || null);
      res.json({ success: true, binary: bin, version: ver });
    } catch (e) {
      db.auditLog.write('opentofu.install', `version=${version} error=${String(e.message || 'installation failed').slice(0, 200)}`, req.ip, false, req.user?.username || null);
      res.status(e.status || 500).json({ error: e.message || 'OpenTofu installation failed.' });
    } finally {
      _installing = false;
    }
  });

}

module.exports = {
  register,
  _test: {
    extractManagedServersFromState,
    reconcileManagedServers,
    cleanupManagedServersForWorkspace,
    normalizeServerCandidate,
    waitForManagedServers,
    detectTerraformResources,
    generateFleetOutputsBlock,
    upsertManagedFleetOutputs,
    normalizeProxmoxVm,
    normalizeProxmoxVmTemplate,
    normalizePostDeployPlaybooks,
    renderProxmoxVmHcl,
    readProxmoxConnection,
    proxmoxApiUrl,
    buildProxmoxProviderFiles,
    buildProxmoxNetworkCatalog,
    buildProxmoxResourceOverview,
    applyFleetProxmoxBlueprintMetadata,
    extractProxmoxGuestIpv4,
    extractProxmoxGuestIpv4s,
    extractProxmoxGuestNetworkRecords,
    subnetContainsIpv4,
    pruneWorkspaceRuns,
    moveWorkspaceDirectory,
    destroyConfirmationPhrase,
    hasValidDestroyConfirmation,
    destroyVmConfirmationPhrase,
    hasValidDestroyVmConfirmation,
    normalizedWorkspaceName,
    terraformConfigurationHash,
    summarizePlanJson,
    validateIsolatedVmPlan,
    redactTofuOutput,
    createStreamingRedactor,
  },
};
