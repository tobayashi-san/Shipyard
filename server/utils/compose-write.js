const fs = require('fs');
const os = require('os');
const path = require('path');

function createComposeTempFile(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-compose-'));
  const tmpFile = path.join(tmpDir, 'docker-compose.yml');
  fs.writeFileSync(tmpFile, content, { encoding: 'utf8', mode: 0o600 });
  return {
    tmpDir,
    tmpFile,
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function buildComposeWriteOperations(remoteDir, localFile) {
  return {
    ensureDir: {
      module: 'file',
      args: `path=${remoteDir} state=directory mode=0755`,
    },
    copyFile: {
      module: 'copy',
      args: `src=${localFile} dest=${remoteDir}/docker-compose.yml mode=0644`,
    },
  };
}

module.exports = {
  createComposeTempFile,
  buildComposeWriteOperations,
};
