'use strict';

const fs = require('fs');
const path = require('path');
const {
  detectTerraformResources,
  generateShipyardOutputsBlock,
  readTerraformFiles,
  supportedTerraformResources,
  upsertManagedShipyardOutputs,
} = require('../terraform-outputs');
const { syncOneToGit } = require('../workspace-files');

let gitSync;
function getGitSync() {
  if (!gitSync) {
    try { gitSync = require('../../../services/git-sync'); } catch {}
  }
  return gitSync;
}

/** Register the Terraform configuration editor endpoints. */
function registerFileRoutes({ router, ensureWorkspacePath, getWorkspace, isEditableTerraformPath, permissionError, safePath, walkDir }) {
  // ── Routes: Files ─────────────────────────────────────────────────────────
  
  router.get('/workspaces/:id/check', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    res.json({ pathExists: fs.existsSync(workspace.path) });
  });
  
  router.get('/workspaces/:id/files', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    ensureWorkspacePath(workspace);
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });
    res.json({ tree: walkDir(workspace.path, '', 0) });
  });
  
  router.get('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!isEditableTerraformPath(req.query.path)) return res.status(400).json({ error: 'Only .tf configuration files are available in the editor.' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try { res.json({ content: fs.readFileSync(fp, 'utf8') }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  router.put('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!isEditableTerraformPath(req.query.path)) return res.status(400).json({ error: 'Only .tf configuration files can be edited.' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.writeFileSync(fp, req.body.content ?? '', 'utf8');
      res.json({ success: true });
      // Auto-push to git after file save
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Update tofu/${workspace.name}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });
  
  router.post('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!isEditableTerraformPath(req.body.path)) return res.status(400).json({ error: 'Only .tf configuration files can be created.' });
    const fp = safePath(workspace.path, req.body.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    if (fs.existsSync(fp)) return res.status(409).json({ error: 'File already exists' });
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });
  
  router.delete('/workspaces/:id/file', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!isEditableTerraformPath(req.query.path)) return res.status(400).json({ error: 'Only .tf configuration files can be deleted.' });
    const fp = safePath(workspace.path, req.query.path || '');
    if (!fp) return res.status(400).json({ error: 'Invalid path' });
    try {
      fs.unlinkSync(fp);
      res.json({ success: true });
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Delete tofu/${workspace.name}/${req.query.path}`).catch(() => {});
      }
    } catch (e) {
      res.status(500).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });
  
  router.post('/workspaces/:id/generate-shipyard-output', (req, res) => {
    const workspace = getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  
    const mkdirErr = ensureWorkspacePath(workspace);
    if (mkdirErr) return res.status(400).json({ error: `Path "${workspace.path}" could not be created: ${mkdirErr.message}` });
    if (!fs.existsSync(workspace.path)) return res.status(400).json({ error: 'Path not found in container' });
  
    try {
      const files = readTerraformFiles(workspace.path);
      const resources = detectTerraformResources(files);
      const supported = supportedTerraformResources(resources);
      const outputPath = path.join(workspace.path, 'outputs.tf');
      const generatedBlock = generateShipyardOutputsBlock(resources);
      const existingContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
      const nextContent = upsertManagedShipyardOutputs(existingContent, generatedBlock);
      fs.writeFileSync(outputPath, nextContent, 'utf8');
  
      res.json({
        success: true,
        path: 'outputs.tf',
        resources: supported,
        content: generatedBlock,
      });
  
      const gs = getGitSync();
      if (gs && gs.isConfigured()) {
        syncOneToGit(workspace.name, workspace.path);
        gs.autoPush(`Generate tofu/${workspace.name}/outputs.tf shipyard output`).catch(() => {});
      }
    } catch (e) {
      res.status(400).json({ error: permissionError(e, workspace.path), code: e.code });
    }
  });
  
  
}

module.exports = { registerFileRoutes };

