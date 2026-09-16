'use strict';
const fs = require('node:fs');
const path = require('node:path');

function workspaceRoots() {
  return String(process.env.OPENTOFU_WORKSPACE_ROOTS || '/workspaces').split(',').map(root => root.trim()).filter(Boolean).map(root => path.resolve(root));
}

// A configured root is trusted. Paths beneath it may come from API input or a
// Git checkout, and must never traverse a symlink into another directory.
function confinedPath(root, value, allowRoot = false) {
  root = path.resolve(root);
  const target = path.resolve(value);
  if (!(allowRoot && target === root) && !target.startsWith(root + path.sep)) throw new Error('Path is outside the configured workspace root.');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Workspace paths must not traverse symbolic links.');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function workspacePath(value, roots = workspaceRoots()) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim())) throw new Error('An absolute workspace path is required.');
  const target = path.resolve(value.trim());
  const root = roots.find(root => target.startsWith(path.resolve(root) + path.sep));
  if (!root) throw new Error('Path is outside the configured workspace roots.');
  return confinedPath(root, target);
}
module.exports = { confinedPath, workspacePath, workspaceRoots };
