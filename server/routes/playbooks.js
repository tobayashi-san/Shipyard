const express = require('express');
const router = express.Router();
const ansibleRunner = require('../services/ansible-runner');
const fs = require('fs');
const path = require('path');

const PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');

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
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(PLAYBOOKS_DIR, filename);
    if (!filepath.startsWith(PLAYBOOKS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Playbook not found' });
    const content = fs.readFileSync(filepath, 'utf8');
    res.json({ content });
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
    fs.writeFileSync(filepath, content, 'utf8');
    res.json({ success: true, filename: finalFilename });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/playbooks/:filename - Delete a playbook
router.delete('/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const INTERNAL = ['update.yml', 'gather-info.yml', 'gather-docker.yml', 'reboot.yml', 'setup-ssh.yml'];
    if (INTERNAL.includes(filename)) return res.status(403).json({ error: 'Cannot delete internal playbook' });
    const filepath = path.join(PLAYBOOKS_DIR, filename);
    if (!filepath.startsWith(PLAYBOOKS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Playbook not found' });
    fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
