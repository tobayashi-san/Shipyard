import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-e2e-'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep browser tests isolated from a developer's locally running Shipyard stack.
// Ports can be overridden for parallel local test sessions or CI workers.
const apiPort = process.env.FLEET_E2E_API_PORT || '3011';
const webPort = process.env.FLEET_E2E_WEB_PORT || '5175';
const externalServers = process.env.FLEET_E2E_EXTERNAL_SERVERS === '1';
const workspaceRoot = path.join(runtimeDir, 'workspaces');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // The browser suite intentionally exercises one shared, isolated database.
  // Running spec files in separate workers races first-user onboarding and
  // makes later scenarios authenticate against an account they did not create.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: 'firefox',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: externalServers ? undefined : [
    {
      command: 'node index.js',
      cwd: '../server',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      env: { ...process.env, NODE_ENV: 'test', PORT: apiPort, DB_PATH: path.join(runtimeDir, 'fleet.sqlite'), JWT_SECRET: 'fleet-browser-e2e-secret', SHIPYARD_KEY_SECRET: 'fleet-browser-e2e-key-secret', PLUGINS_DIR: path.join(projectRoot, 'plugins'), OPENTOFU_WORKSPACE_ROOTS: workspaceRoot, OPENTOFU_INTERNAL_VM_ROOT: path.join(workspaceRoot, 'internal', 'vms') },
    },
    {
      command: `VITE_API_TARGET=http://127.0.0.1:${apiPort} vite --host 127.0.0.1 --port ${webPort}`,
      cwd: '.',
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${apiPort}` },
    },
  ],
});
