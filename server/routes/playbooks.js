const express = require('express');
const router = express.Router();
const ansibleRunner = require('../services/ansible-runner');
const fs = require('fs');
const path = require('path');
const gitSync = require('../services/git-sync');

const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');
const MAX_BACKUPS = 5;
const RESOLVED_PLAYBOOKS_DIR = path.resolve(PLAYBOOKS_DIR);

// Validate filename and resolve safe path; returns { filename, filepath } or null
function resolvePlaybookPath(raw) {
  const filename = path.basename(raw);
  if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) return null;
  const filepath = path.join(PLAYBOOKS_DIR, filename);
  if (!filepath.startsWith(RESOLVED_PLAYBOOKS_DIR + path.sep)) return null;
  return { filename, filepath };
}

function rotateBak(filepath) {
  if (!fs.existsSync(filepath)) return;
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const src = `${filepath}.bak.${i}`;
    const dst = `${filepath}.bak.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  fs.copyFileSync(filepath, `${filepath}.bak.1`);
}

// GET /api/playbooks - List all available playbooks
router.get('/', (req, res) => {
  try {
    const playbooks = ansibleRunner.getAvailablePlaybooks();
    res.json(playbooks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/playbooks/:filename - Read a playbook's content
router.get('/:filename', (req, res) => {
  try {
    const resolved = resolvePlaybookPath(req.params.filename);
    if (!resolved) return res.status(400).json({ error: 'Invalid filename' });
    const { filepath } = resolved;
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Playbook not found' });
    res.json({ content: fs.readFileSync(filepath, 'utf8') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/playbooks - Create or update a playbook
router.post('/', (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || !content) return res.status(400).json({ error: 'filename and content are required' });
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const finalFilename = safeFilename.endsWith('.yml') || safeFilename.endsWith('.yaml') ? safeFilename : safeFilename + '.yml';
    const filepath = path.join(PLAYBOOKS_DIR, finalFilename);
    if (!filepath.startsWith(path.resolve(PLAYBOOKS_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (content.length > 512 * 1024) return res.status(400).json({ error: 'Playbook too large (max 512 KB)' });
    rotateBak(filepath);
    fs.writeFileSync(filepath, content, 'utf8');
    res.json({ success: true, filename: finalFilename });
    // Auto-push to git in background (non-blocking)
    gitSync.autoPush(`Update ${finalFilename}`).catch(() => {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/playbooks/:filename/history - List backup versions
router.get('/:filename/history', (req, res) => {
  try {
    const resolved = resolvePlaybookPath(req.params.filename);
    if (!resolved) return res.status(400).json({ error: 'Invalid filename' });
    const { filepath } = resolved;
    const versions = [];
    for (let i = 1; i <= MAX_BACKUPS; i++) {
      const bakPath = `${filepath}.bak.${i}`;
      if (fs.existsSync(bakPath)) {
        const stat = fs.statSync(bakPath);
        versions.push({ version: i, modifiedAt: stat.mtime.toISOString() });
      }
    }
    res.json(versions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/playbooks/:filename/history/:version - Preview a backup version
router.get('/:filename/history/:version', (req, res) => {
  try {
    const resolved = resolvePlaybookPath(req.params.filename);
    if (!resolved) return res.status(400).json({ error: 'Invalid filename' });
    const version  = parseInt(req.params.version);
    if (!version || version < 1 || version > MAX_BACKUPS) {
      return res.status(400).json({ error: 'Invalid version' });
    }
    const { filepath } = resolved;
    const bakPath = `${filepath}.bak.${version}`;
    if (!fs.existsSync(bakPath)) return res.status(404).json({ error: 'Backup not found' });
    res.json({ content: fs.readFileSync(bakPath, 'utf8') });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/playbooks/:filename/restore/:version - Restore a backup version
router.post('/:filename/restore/:version', (req, res) => {
  try {
    const resolved = resolvePlaybookPath(req.params.filename);
    if (!resolved) return res.status(400).json({ error: 'Invalid filename' });
    const version  = parseInt(req.params.version);
    if (!version || version < 1 || version > MAX_BACKUPS) {
      return res.status(400).json({ error: 'Invalid version' });
    }
    const { filepath } = resolved;
    const bakPath = `${filepath}.bak.${version}`;
    if (!fs.existsSync(bakPath)) return res.status(404).json({ error: 'Backup not found' });
    const content = fs.readFileSync(bakPath, 'utf8');
    rotateBak(filepath);
    fs.writeFileSync(filepath, content, 'utf8');
    // rotateBak shifted every backup up by 1, so the file we just restored
    // from is now also sitting at .bak.(version+1) — remove the duplicate.
    const dupPath = `${filepath}.bak.${version + 1}`;
    if (fs.existsSync(dupPath)) fs.unlinkSync(dupPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/playbooks/:filename - Delete a playbook
router.delete('/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const INTERNAL = ['update.yml', 'gather-docker.yml', 'check-image-updates.yml', 'reboot.yml', 'setup-ssh.yml'];
    if (INTERNAL.includes(filename)) return res.status(403).json({ error: 'Cannot delete internal playbook' });
    const filepath = path.join(PLAYBOOKS_DIR, filename);
    if (!filepath.startsWith(RESOLVED_PLAYBOOKS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Playbook not found' });
    fs.unlinkSync(filepath);
    res.json({ success: true });
    gitSync.autoPush(`Delete ${filename}`).catch(() => {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
