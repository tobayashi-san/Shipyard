// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

/** @typedef {import('./types').PlanSummary} PlanSummary */

const TOFU_RUN_HISTORY_MAX = Math.max(25, parseInt(process.env.TOFU_RUN_HISTORY_MAX || '250', 10) || 250);

function pruneWorkspaceRuns(db, workspaceId, keep = TOFU_RUN_HISTORY_MAX) {
  const limit = Math.max(1, parseInt(String(keep), 10) || TOFU_RUN_HISTORY_MAX);
  const hasPlanPath = db.db.prepare('PRAGMA table_info(tofu_runs)').all().some(column => column.name === 'plan_path');
  const stalePlans = hasPlanPath ? db.db.prepare(`
    SELECT plan_path FROM tofu_runs
    WHERE workspace_id = ? AND plan_path IS NOT NULL AND id NOT IN (
      SELECT id FROM tofu_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?
    )
  `).all(workspaceId, workspaceId, limit) : [];
  const result = db.db.prepare(`
    DELETE FROM tofu_runs
    WHERE workspace_id = ?
      AND id NOT IN (
        SELECT id
        FROM tofu_runs
        WHERE workspace_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      )
  `).run(workspaceId, workspaceId, limit);
  for (const row of stalePlans) {
    try { if (row.plan_path) fs.unlinkSync(row.plan_path); } catch {}
  }
  return result;
}

function terraformConfigurationHash(workspacePath, env = {}) {
  const hash = createHash('sha256');
  const files = fs.existsSync(workspacePath)
    ? fs.readdirSync(workspacePath).filter(file => file.endsWith('.tf')).sort()
    : [];
  for (const file of files) {
    hash.update(file); hash.update('\0');
    hash.update(fs.readFileSync(path.join(workspacePath, file))); hash.update('\0');
  }
  const relevantEnv = Object.fromEntries(Object.entries(env)
    .filter(([key]) => /^(?:TF_|AWS_|ARM_|AZURE_|GOOGLE_|GCLOUD_|GCP_|CLOUDSDK_|HCLOUD_|DO_|DIGITALOCEAN_|PROXMOX_|VAULT_|CONSUL_|NOMAD_|ALICLOUD_|OCI_|IBM_|SCW_|LINODE_|VULTR_|CLOUDFLARE_|GITHUB_TOKEN$)/i.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
  hash.update(JSON.stringify(relevantEnv));
  return hash.digest('hex');
}

/** @param {any} value @returns {PlanSummary} */
function summarizePlanJson(value) {
  const counts = { create: 0, update: 0, delete: 0, replace: 0, no_op: 0, read: 0 };
  for (const change of Array.isArray(value?.resource_changes) ? value.resource_changes : []) {
    const actions = Array.isArray(change?.change?.actions) ? change.change.actions : [];
    if (actions.includes('delete') && actions.includes('create')) counts.replace++;
    else if (actions.includes('create')) counts.create++;
    else if (actions.includes('delete')) counts.delete++;
    else if (actions.includes('update')) counts.update++;
    else if (actions.includes('read')) counts.read++;
    else counts.no_op++;
  }
  return counts;
}

function redactTofuOutput(value, env = {}) {
  let output = String(value || '');
  const secrets = [...new Set(Object.values(env).filter(item => typeof item === 'string' && item.length >= 6))]
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) output = output.split(secret).join('********');
  return output;
}

function createStreamingRedactor(env, emit) {
  const secrets = [...new Set(Object.values(env).filter(item => typeof item === 'string' && item.length >= 6))];
  const maxSecretLength = Math.max(0, ...secrets.map(item => item.length));
  let pending = '';
  return {
    write(value) {
      pending += String(value || '');
      let safeLength = maxSecretLength ? Math.max(0, pending.length - maxSecretLength + 1) : pending.length;
      for (const secret of secrets) {
        const start = pending.lastIndexOf(secret, safeLength - 1);
        if (start >= 0 && start < safeLength && start + secret.length > safeLength) safeLength = start;
      }
      if (!safeLength) return;
      const chunk = pending.slice(0, safeLength);
      pending = pending.slice(safeLength);
      emit(redactTofuOutput(chunk, env));
    },
    flush() {
      if (!pending) return;
      emit(redactTofuOutput(pending, env));
      pending = '';
    },
  };
}

module.exports = {
  createStreamingRedactor,
  pruneWorkspaceRuns,
  redactTofuOutput,
  summarizePlanJson,
  terraformConfigurationHash,
};
