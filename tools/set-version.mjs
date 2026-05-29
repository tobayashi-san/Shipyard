#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
  console.error('Usage: node tools/set-version.mjs <version>');
  console.error('Version must look like 1.2.3 or 1.2.3-rc.1.');
  process.exit(1);
}

const root = process.cwd();
const packageFiles = [
  'package.json',
  'package-lock.json',
  'server/package.json',
  'server/package-lock.json',
  'frontend-next/package.json',
  'frontend-next/package-lock.json',
];

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relativePath}`);
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeJson(relativePath, data) {
  const fullPath = path.join(root, relativePath);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
}

for (const relativePath of packageFiles) {
  const data = readJson(relativePath);
  data.version = version;
  if (data.packages?.['']) {
    data.packages[''].version = version;
  }
  writeJson(relativePath, data);
  console.log(`Updated ${relativePath} to ${version}`);
}
