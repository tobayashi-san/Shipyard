'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

function lineCount(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8').split('\n').length;
}

test('OpenTofu is a core feature with bounded entry points', () => {
  assert.equal(fs.existsSync(path.join(projectRoot, 'plugins', 'opentofu')), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'server', 'features', 'opentofu', 'index.js')), true);
  assert.ok(lineCount('server/features/opentofu/index.js') <= 2000);
});

test('feature route entry points stay orchestration-sized', () => {
  const limits = {
    'frontend-next/src/features/server-detail/ServerDetailPage.tsx': 1000,
    'frontend-next/src/features/playbooks/PlaybooksPage.tsx': 400,
    'frontend-next/src/routes/infrastructure-detail.tsx': 300,
  };
  for (const [file, maximum] of Object.entries(limits)) {
    assert.ok(lineCount(file) <= maximum, `${file} must stay at or below ${maximum} lines`);
  }
});

test('English-only UI does not reintroduce known mixed-language labels', () => {
  const forbidden = /\b(?:Kerne|Datenspeicher|Gesundheit|Infrastruktur|Inventar-VMs|Produktivcluster|Verwaltete Hosts|Letzter Lauf|Arbeitsspeicher)\b/;
  const sourceRoot = path.join(projectRoot, 'frontend-next', 'src');
  const pending = [sourceRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(fullPath, 'utf8'), forbidden, fullPath);
      }
    }
  }
});
