import { expect, test, type Page } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';

// Test-only self-signed material for the isolated mock Proxmox API below.
// The application is intentionally configured with `insecure: true` for this
// mock; production connections still require an HTTPS endpoint and can opt
// into certificate verification normally.
const PROXMOX_E2E_KEY = Buffer.from('LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2d0lCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktrd2dnU2xBZ0VBQW9JQkFRQ2hJRzdFRWJLOCtNWnAKdzBkWUgvUVVvZVFVTDdQS0drVmF2Y081eGJWeUdmQndzOTIySTRENEpPOW92U2l4dnlVdSt4MlFGdXZyREhwZApkcEp2U3RhdWVjN2lWeFIvNW4rbkVCaGpoRXpjWUw3Ni9mRDNTTVZudEdIR3IxTmdiRitVLzJQMG1HMUlxWjAvCiszYmFaaUZ1ckVuTHlZVVNDeWdkd1NuaXlFR0tLTmJpYnA0U1VOMzIvRWNoNlg4cjBSejkxTnROUkMrdUZPdWkKdlE4UnUrRnN0OXpGQlRxNi9KYWxscDV5M3VEZi8zM3MzSENva1pPQXN3VkhtV0ZCN0Q1U2VCS0p4ck5mUUNtMgpLdzBieWhhSmt0UEl4VzB4czFHeDZkb1dnUXZ6cC8wek9HMCt4UlhSNGFPQXVQZGx1dTJadmFjVU1DZlhpTVNTCmhkSjIzUVlWQWdNQkFBRUNnZ0VBSWplT2ZrSFo2TXFWN0REbHJqKys2RURHL0VoekVGaks0SzNLNm1Fam1yTUsKZmd5Y2FVa1o0dGlKSlArQ3JGaVF6MnpSaHQ5dlEwKzNqckNYQVY1dHY4aXJXQ0t3L2taWFZvV1RBRk5BdFU0dwpVSUhzRWIrWStHQjBvU3ByZE44ZTN6ZnJKSzdZQ21YR3VLY3d3c21Na1FHeWZEM3o3ZlNEbE9vSCtKcVpYSHJmCituS0E5bmxrYWVGaFhOcW1ORlZuYy9pbStBeXdLV1RiTSt5eEZGbi9ES2Z1Tkx3REUzWjh1NlVZWVZJN1BWeEcKME1VUUYrUGJHSk9tUDFvQ2s2ang2c1RCSFkzR0k4aHVaaEYySndnV3FGYUhFeDBnTHZrNU1jcnFWVS9OaXdHNwp5NmF3aHBpMVZydTRqaWc1RHlUYllSbEg2dkJJeDNyRzRja29BaDh3TVFLQmdRRGl2cldCT3I5R3MwOXBVWThHCmJSN1dDaTE5OVR0N1hQb1hPQ2hSVUlwUE1mNE5HMytGSUJ0ZnU0b2ZVbUVUQjJoQlowL3JSTzNxQVgrUzFTYzcKbGlPWkU0b1ZuK3BFenNPenRpcTUyd2poaGlWWG1SRjFLZTZPQjNaYWtWV29KUjFEZTNQUDVhQjFVZHdKM0JnTAo5SUthUEJKTHlPbkpmVUV4bWRDNzBTSWN1UUtCZ1FDMTZtRTZMbHJURVZwUEtjdG10YlY0OHdJTzBOTkJveUlNCk0xTzZLR2JPT21uYXdvL1d2aEVHd1l4VGM1OGRYTEpyYjF2UTQ0SERFenR6cElUa1htcnh5Zm9NSTE5TmFzdWIKZ1c4Wmc1TjUwV0lTdXZZTFV1Mjc3a2xma01GWnV2Y3BrTG9QOTBFb1M3Q0ZxUDM0dFBVMjNYTkZ6a0Z2V0EySQp0elNMaHhLZVBRS0JnUUNZSDd6a2E4YWlwM0NTeDA0KzBIME11eDFVVVhCTHp0QlhQYTBIQ1JNU0dRZEtRZlduCkdpaGpiUTQ0LzJyemVsZSs4WkpUMVJZTmxsM0I1RklERHpMbzQ0d1VBQXNMaVBFUnBCazhRakRPSmRMdDExczQKRVI3a21Tc1Zqa1k2bmxQb3oyMmV3SCtMMXBUYTVKZ1poVDBPUDFsREVST1F4QUUyUnUwYzVTMk91UUtCZ1FDWgpEd1FSTk5GY1IzeHBvT3V2bG5HQ3UwdmU5VnJhSGd6V29SVHdTMi84VW0rZ0RSV0RBOVpGamZHb2dWNitFTEZaCjdZOGVHVjJqcVhuYkdmQnFTUHJJUnoxb214WmpoOWlhRlhSSnprZjJOZkxEZWFUczhEQndiOVF5WVJRZGtFN0gKSFNzL3BiU2YxOWRGRG1QcHJ5K21vdnFMSURnMEc2ei9lODN0RzQvUnJRS0JnUUNRcEpWb3BhVmpoWWJHaENjegpiTzBqNjFKdVpvZTFDVDFFeWFnYlhDdlQ1V3dwVk50U2VUb0U2TDZLNjFXY0Z0cVE0RW0vU3g3SVdjYWM3WnRtCklWSjJLT2dnaS9pZEQ1MkZra0hSUjdjTDIzVk45cGlzbzlMSS93V2RYcUNub3lUWFkvWml0bVZWZHBRQjlLQkEKenFrS0NwbXNJKzZObloxVlpvWFVXci9YK3c9PQotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==', 'base64').toString('utf8');
const PROXMOX_E2E_CERT = Buffer.from('LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURDVENDQWZHZ0F3SUJBZ0lVUWdOSG0zcGJidm54UThvMlRrM0xoallqcThFd0RRWUpLb1pJaHZjTkFRRUwKQlFBd0ZERVNNQkFHQTFVRUF3d0pNVEkzTGpBdU1DNHhNQjRYRFRJMk1EZ3hNVEl5TWpnek5Gb1hEVEkyTURneApNakl5TWpnek5Gb3dGREVTTUJBR0ExVUVBd3dKTVRJM0xqQXVNQzR4TUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGCkFBT0NBUThBTUlJQkNnS0NBUUVBb1NCdXhCR3l2UGpHYWNOSFdCLzBGS0hrRkMrenlocEZXcjNEdWNXMWNobncKY0xQZHRpT0ErQ1R2YUwwb3NiOGxMdnNka0JicjZ3eDZYWGFTYjByV3Jubk80bGNVZitaL3B4QVlZNFJNM0dDKwordjN3OTBqRlo3Umh4cTlUWUd4ZmxQOWo5Smh0U0ttZFAvdDIybVloYnF4Snk4bUZFZ3NvSGNFcDRzaEJpaWpXCjRtNmVFbERkOXZ4SEllbC9LOUVjL2RUYlRVUXZyaFRyb3IwUEVidmhiTGZjeFFVNnV2eVdwWmFlY3Q3ZzMvOTkKN054d3FKR1RnTE1GUjVsaFFldytVbmdTaWNhelgwQXB0aXNORzhvV2laTFR5TVZ0TWJOUnNlbmFGb0VMODZmOQpNemh0UHNVVjBlR2pnTGozWmJydG1iMm5GREFuMTRqRWtvWFNkdDBHRlFJREFRQUJvMU13VVRBZEJnTlZIUTRFCkZnUVVIZDdaRnhQYkdxenhtcHNraUdjZkxUajFadEF3SHdZRFZSMGpCQmd3Rm9BVUhkN1pGeFBiR3F6eG1wc2sKaUdjZkxUajFadEF3RHdZRFZSMFRBUUgvQkFVd0F3RUIvekFOQmdrcWhraUc5dzBCQVFzRkFBT0NBUUVBRkhueAoyWDIrV29rUVQ1Z2ppbW5reGtZNURuV0ZJV2hVeWhNQlY3YkxIdm9TYlJOeU1sS3lMYWtVYis4L3VTS2R4bzlyCjJIVTNzVkJ5a25JNlNESHlHR0VLV3E4R3VGZkpNQzJkdTlsRnhMZUFpMWFtc2lOVFlQRGNDYWhkWDV6NDkyanMKVmpOSC8rNTk3c1pHOFJjcFJCVGkvcFIreVphQ1FzQit6OER0NHV6NEtwc0sxR0U4NUZDZXBXeUo4REhkbXlXRgp1ZHZBSXlsMXRXcVQvcVl3ZXVxUUZYSXU3bEpVUExNMWw5M3JGdldFRVp4c0VKY3hLcC9ZK2hiS2tvcHBxckpUCk1EVHJZdm5Pb05Ma1kyVHNGUXpUV1I0MXY2UytTR1hhTG9KdHgyeDNsT0NCVTRWSEhHanlNZEpvSS9OV3BXMDEKOE04eDFwa0dWZTBHcUlrZzJ3PT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=', 'base64').toString('utf8');

test.describe.configure({ mode: 'serial' });

async function loginForIsolatedTest(page: Page) {
  await page.goto('/login');
  const setupButton = page.getByRole('button', { name: /let'?s go|los geht'?s/i });
  if (await setupButton.isVisible()) {
    await setupButton.click();
    await page.getByLabel(/username|benutzername/i).fill('e2e-admin');
    const passwords = page.locator('input[type="password"]');
    await passwords.nth(0).fill('E2e-password-2026!');
    await passwords.nth(1).fill('E2e-password-2026!');
    await page.getByRole('button', { name: /set password|passwort setzen/i }).click();
    await page.getByRole('button', { name: /skip|überspringen/i }).click();
    await page.getByRole('button', { name: /skip|überspringen/i }).click();
    await page.getByRole('button', { name: /open app|app öffnen|fertig|zur konsole/i }).click();
    await page.goto('/login');
  }
  await page.getByLabel(/username|benutzername/i).fill('e2e-admin');
  await page.getByLabel(/password|passwort/i).fill('E2e-password-2026!');
  await page.getByRole('button', { name: /sign in|anmelden/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openPlatformInventory(page: Page, name: string) {
  await page.goto('/deployments');
  await page.getByRole('button', { name: 'Platform connections' }).click();
  const dialog = page.getByRole('dialog', { name: 'Platform connections' });
  await dialog.getByRole('link', { name, exact: true }).click();
}

test('onboarding is public only until the first admin exists', async ({ page }) => {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: /welcome|willkommen/i })).toBeVisible();

  const token = await page.evaluate(async () => {
    const response = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'e2e-admin', password: 'E2e-password-2026!' }),
    });
    if (!response.ok) throw new Error(`Setup failed: ${response.status}`);
    return (await response.json()).token as string;
  });

  await page.evaluate(() => localStorage.removeItem('shipyard_token'));
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: /sign in|anmelden/i })).toBeVisible();

  await page.evaluate((validToken) => localStorage.setItem('shipyard_token', validToken), token);
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => localStorage.removeItem('shipyard_token'));
});

test('initial setup, login and protected console navigation work end-to-end', async ({ page }) => {
  await page.goto('/login');
  const setupButton = page.getByRole('button', { name: /let'?s go|los geht'?s/i });
  const performedSetup = await setupButton.isVisible();
  if (performedSetup) {
    await expect(page.getByRole('heading', { name: /welcome|willkommen/i })).toBeVisible();
    await setupButton.click();

    await page.getByLabel(/username|benutzername/i).fill('e2e-admin');
    const setupFields = page.locator('input[type="password"]');
    await setupFields.nth(0).fill('E2e-password-2026!');
    await setupFields.nth(1).fill('E2e-password-2026!');
    await page.getByRole('button', { name: /set password|passwort setzen/i }).click();

    await page.getByRole('button', { name: /skip|überspringen/i }).click();
    await page.getByRole('button', { name: /skip|überspringen/i }).click();
    await page.getByRole('button', { name: /open app|app öffnen|fertig|zur konsole/i }).click();
  } else {
    await page.getByLabel(/username|benutzername/i).fill('e2e-admin');
    await page.getByLabel(/password|passwort/i).fill('E2e-password-2026!');
    await page.getByRole('button', { name: /sign in|anmelden/i }).click();
  }

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /operations overview|environment overview|betriebsübersicht|umgebungsübersicht|dashboard/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /current environment status/i })).toBeVisible();
  if (performedSetup) {
    await expect(page.getByRole('heading', { name: /no hosts yet/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /add host/i })).toBeVisible();
  }

  await page.goto('/servers');
  await expect(page).toHaveURL(/\/servers/);

  await page.goto('/networks');
  await expect(page.getByRole('heading', { name: /ip address management|ip-adressverwaltung/i })).toBeVisible();

  await page.goto('/operations');
  await expect(page.getByRole('heading', { name: /operations|betrieb/i })).toBeVisible();
  await page.getByLabel('Operations sections').getByRole('link', { name: 'Maintenance', exact: true }).click();
  await page.getByRole('button', { name: 'Add maintenance window', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: /schedule maintenance window/i })).toBeVisible();
  await page.getByLabel('Name').fill('E2E-Proxmox-Wartung');
  await page.getByLabel('Start').fill('2026-12-01T10:00');
  await page.getByLabel('End').fill('2026-12-01T11:00');
  await page.getByRole('button', { name: 'Schedule maintenance window', exact: true }).click();
  await expect(page.getByRole('row', { name: /E2E-Proxmox-Wartung/ })).toBeVisible();

  await page.getByRole('button', { name: 'Actions for E2E-Proxmox-Wartung' }).click();
  await page.getByRole('menuitem', { name: 'Delete window' }).click();
  await expect(page.getByRole('dialog', { name: /delete maintenance window/i })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('E2E-Proxmox-Wartung', { exact: true })).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /administration/i })).toBeVisible();
  const settingsNavigation = page.getByRole('navigation', { name: 'Administration' });
  await expect(settingsNavigation.getByRole('link', { name: 'Appearance' })).toBeVisible();
  await expect(settingsNavigation.getByRole('link', { name: 'SSH' })).toBeVisible();
  await expect(settingsNavigation.getByRole('link', { name: 'Git Integration' })).toBeVisible();
  await expect(settingsNavigation.getByRole('link', { name: 'System', exact: true })).toBeVisible();
});

test('sidebar keeps an unknown Proxmox inventory in a loading state', async ({ page }) => {
  await loginForIsolatedTest(page);
  let releaseSummary!: () => void;
  const summaryCanFinish = new Promise<void>((resolve) => { releaseSummary = resolve; });
  await page.route('**/api/opentofu/infrastructure-summary?*', async (route) => {
    await summaryCanFinish;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ clusters: [], cached: false, refreshing: false, updated_at: new Date().toISOString() }),
    });
  });

  await page.goto('/infrastructure');
  const sidebar = page.locator('aside');
  await expect(sidebar.getByRole('status').filter({ hasText: 'Infrastructure is loading' })).toBeVisible();
  await expect(sidebar.getByText('Proxmox', { exact: true }).locator('..').getByText('0', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText('Connect Proxmox', { exact: true })).toHaveCount(0);

  releaseSummary();
  await expect(sidebar.getByText('Connect Proxmox', { exact: true })).toBeVisible();
  await page.unroute('**/api/opentofu/infrastructure-summary?*');
});

test('mobile profile menu and maintenance form remain inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Keep this test independently runnable. A fresh server starts with the
  // setup wizard, whereas the full serial suite already created an account.
  await loginForIsolatedTest(page);

  const mobileEnvironment = await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const response = await fetch('/api/environments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Mobile E2E' }),
    });
    if (!response.ok) throw new Error(`Could not create mobile environment: ${response.status}`);
    return response.json() as Promise<{ id: string }>;
  });
  await page.reload();
  const environmentSelect = page.getByLabel('Environment', { exact: true });
  await expect(environmentSelect).toBeVisible();
  await environmentSelect.selectOption(mobileEnvironment.id);
  await expect(environmentSelect).toHaveValue(mobileEnvironment.id);
  await environmentSelect.selectOption('default');
  await page.evaluate(async (id) => {
    const token = localStorage.getItem('shipyard_token');
    await fetch(`/api/environments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }, mobileEnvironment.id);

  await page.getByRole('button', { name: 'Profile menu' }).click();
  const profileMenu = page.getByText('Account & security').locator('..').locator('..');
  await expect(profileMenu).toBeVisible();
  const profileBox = await profileMenu.boundingBox();
  expect(profileBox).not.toBeNull();
  expect(profileBox!.x).toBeGreaterThanOrEqual(0);
  expect(profileBox!.x + profileBox!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');

  await page.goto('/operations');
  await page.getByLabel('Operations sections').getByRole('link', { name: 'Maintenance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add maintenance window', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Add maintenance window', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /schedule maintenance window/i });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeLessThan(844);
});

test('console themes apply their coordinated light and dark modes immediately', async ({ page }) => {
  await loginForIsolatedTest(page);
  await page.goto('/profile');

  const themeChoices = page.locator('button[aria-label$=" mode"]');
  await expect(themeChoices).toHaveCount(6);

  await page.getByRole('button', { name: 'Paper theme, light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-console-theme', 'paper-light');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expect(page.getByRole('button', { name: 'Paper theme, light mode' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Graphite theme, dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-console-theme', 'graphite-dark');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.getByRole('button', { name: 'Graphite theme, dark mode' })).toHaveAttribute('aria-pressed', 'true');
});

test('agent feature visibility follows the setting immediately', async ({ page }) => {
  await loginForIsolatedTest(page);
  await page.goto('/settings/system');
  const agentToggle = page.getByRole('switch', { name: /agent-feature aktivieren|enable agent feature/i });
  await expect(agentToggle).toHaveAttribute('data-state', 'unchecked');

  const enabledSave = page.waitForResponse(response => response.url().includes('/api/system/settings') && response.request().method() === 'PUT' && response.status() === 200);
  await agentToggle.click();
  await enabledSave;
  const serverId = await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const response = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'agent-visibility-host', hostname: 'agent-visibility-host.local', ip_address: '10.250.0.10' }),
    });
    if (!response.ok) throw new Error(`Could not create test host: ${response.status}`);
    return String((await response.json()).id);
  });
  await expect(agentToggle).toHaveAttribute('data-state', 'checked');
  await page.goto(`/servers/${serverId}`);
  await expect(page.getByRole('tab', { name: 'System', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Access', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /notes/i })).toBeVisible();

  await page.getByRole('tab', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: /open terminal/i }).click();
  const terminalDialog = page.getByRole('dialog', { name: /terminal/i });
  await expect(terminalDialog).toBeVisible();
  await terminalDialog.getByRole('button', { name: /close/i }).click();
  await expect(terminalDialog).toHaveCount(0);

  const hostTools = page.getByRole('button', { name: 'Host tools' });
  await hostTools.click();
  const hostToolsMenu = page.getByRole('menu', { name: 'Host tools' });
  await expect(hostToolsMenu.getByRole('menuitem', { name: /agent/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(page).toHaveURL(/#tab=history$/);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Access', exact: true })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByRole('tab', { name: /overview/i })).toHaveAttribute('data-state', 'active');

  await page.goto('/settings/system');
  const disabledSave = page.waitForResponse(response => response.url().includes('/api/system/settings') && response.request().method() === 'PUT' && response.status() === 200);
  await page.getByRole('switch', { name: /agent-feature aktivieren|enable agent feature/i }).click();
  await disabledSave;
  await page.goto(`/servers/${serverId}`);
  await expect(page.getByRole('button', { name: 'Host tools' })).toHaveCount(0);
  await page.goto('/settings');
  await expect(page.getByText(/agent manifest/i, { exact: true })).toHaveCount(0);
  await page.evaluate(async (id) => {
    const token = localStorage.getItem('shipyard_token');
    await fetch(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }, serverId);
});

test('primary console pages keep their outer layout within a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginForIsolatedTest(page);

  // Wide data remains scrollable inside .table-scroll. The application shell
  // itself must never force a user to pan the whole page horizontally.
  for (const route of ['/', '/infrastructure', '/servers', '/networks', '/operations', '/deployments', '/playbooks', '/settings', '/profile']) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, `${route} creates page-level horizontal overflow`).toBeLessThanOrEqual(390);
  }
});

test('dashboard and deployment failures are never presented as healthy empty states', async ({ page }) => {
  await loginForIsolatedTest(page);

  await page.route('**/api/dashboard', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'dashboard unavailable' }) }));
  await page.route('**/api/opentofu/infrastructure?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'infrastructure unavailable' }) }));
  await page.goto('/');
  await expect(page.getByText('Dashboard data could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready for operation', { exact: true })).toHaveCount(0);
  await expect(page.getByText('All desired states met', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/dashboard');
  await page.unroute('**/api/opentofu/infrastructure?*');

  await page.route('**/api/opentofu/vms?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'virtual machines unavailable' }) }));
  await page.route('**/api/opentofu/legacy-workspaces?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'legacy deployments unavailable' }) }));
  await page.route('**/api/opentofu/vm-templates?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'templates unavailable' }) }));
  await page.goto('/deployments');
  await expect(page.getByText('Virtual machines could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy VM deployments could not be checked', { exact: true })).toBeVisible();
  await expect(page.getByText('VM templates could not be loaded', { exact: true })).toBeVisible();
  await expect(page.getByText(/no managed virtual machines|no templates yet/i)).toHaveCount(0);
});

test('playbook workflows expose safe secrets, explicit targets and one run flow', async ({ page }) => {
  test.setTimeout(60_000);
  await loginForIsolatedTest(page);
  const suffix = Date.now().toString(36);
  const hostName = `playbook-e2e-${suffix}`;
  const filename = `playbook_e2e_${suffix}.yml`;
  const variableKey = `PLAYBOOK_E2E_${suffix.toUpperCase()}`;
  const secretValue = `never-return-${suffix}`;
  const scheduleName = `Playbook E2E ${suffix}`;
  const groupName = `Playbook Group ${suffix}`;

  const groupId = await page.evaluate(async ({ hostName, filename, groupName }) => {
    const token = localStorage.getItem('shipyard_token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const host = await fetch('/api/servers', {
      method: 'POST', headers,
      body: JSON.stringify({ name: hostName, hostname: `${hostName}.local`, ip_address: '10.252.0.20', environment_id: 'default' }),
    });
    if (!host.ok) throw new Error(`Could not create playbook test host: ${host.status}`);
    const hostRow = await host.json() as { id: string };
    const group = await fetch('/api/servers/groups', {
      method: 'POST', headers,
      body: JSON.stringify({ name: groupName, color: '#2563eb', environment_id: 'default' }),
    });
    if (!group.ok) throw new Error(`Could not create playbook host group: ${group.status}`);
    const groupRow = await group.json() as { id: string };
    const assignment = await fetch(`/api/servers/${hostRow.id}/group`, {
      method: 'PUT', headers, body: JSON.stringify({ group_id: groupRow.id }),
    });
    if (!assignment.ok) throw new Error(`Could not assign playbook host group: ${assignment.status}`);
    const playbook = await fetch('/api/playbooks', {
      method: 'POST', headers,
      body: JSON.stringify({ filename, content: '---\n- name: Browser test\n  hosts: all\n  gather_facts: false\n  tasks:\n    - ansible.builtin.debug:\n        msg: browser-test\n' }),
    });
    if (!playbook.ok) throw new Error(`Could not create playbook fixture: ${playbook.status}`);
    return groupRow.id;
  }, { hostName, filename, groupName });

  try {
    await page.goto('/playbooks');
    await expect(page.getByRole('tab', { name: 'Playbooks', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Variables & Secrets', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Schedules', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Templates', exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Variables & Secrets', exact: true }).click();
    await page.getByRole('button', { name: /add variable/i }).click();
    await page.getByLabel('Key', { exact: true }).fill(variableKey);
    await page.getByLabel('Value', { exact: true }).fill(secretValue);
    await page.getByRole('switch', { name: 'Secret value' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(variableKey, { exact: true })).toBeVisible();
    await expect(page.getByText('••••••••', { exact: true })).toBeVisible();
    await expect(page.getByText(secretValue, { exact: true })).toHaveCount(0);

    const returnedSecret = await page.evaluate(async (variableKey) => {
      const token = localStorage.getItem('shipyard_token');
      const response = await fetch('/api/ansible-vars?environment_id=default', { headers: { Authorization: `Bearer ${token}` } });
      const rows = await response.json();
      return rows.find((row: { key: string }) => row.key === variableKey);
    }, variableKey);
    expect(returnedSecret?.value).toBe('');
    expect(returnedSecret?.value_set).toBe(true);

    await page.getByRole('tab', { name: 'Schedules', exact: true }).click();
    await page.getByRole('button', { name: /new schedule/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(scheduleName);
    await dialog.getByLabel('Playbook', { exact: true }).selectOption(filename);

    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(/select at least one target/i)).toBeVisible();
    await dialog.getByLabel('All hosts', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(/confirm the all-(?:host|server) target/i)).toBeVisible();
    await dialog.getByLabel(/run on every host in this environment/i).check();
    await dialog.getByLabel(/extra variables/i).fill('{"release_channel":"stable"}');
    await dialog.getByRole('switch', { name: 'Dry run' }).click();
    await dialog.getByLabel('Parallel hosts').fill('1');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const scheduleRow = page.getByRole('row').filter({ hasText: scheduleName });
    await expect(scheduleRow).toBeVisible();
    await expect(scheduleRow).toContainText(/next/i);
    await expect(scheduleRow).toContainText(/Europe\/Zurich|server timezone/i);

    await page.getByRole('tab', { name: 'Playbooks', exact: true }).click();
    await page.getByRole('button', { name: `Run ${filename}`, exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Runs', exact: true })).toHaveAttribute('data-state', 'active');
    await expect(page.getByLabel('Playbook', { exact: true })).toHaveValue(filename);
    await page.getByLabel('Filter hosts by group').selectOption({ label: groupName });
    await page.getByRole('button', { name: 'Select filtered', exact: true }).click();
    await expect(page.getByText(new RegExp(`Target preview.*1 host`))).toBeVisible();
    await expect(page.getByText(hostName, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Review playbook run' });
    await expect(review).toContainText(hostName);
    await review.getByRole('button', { name: 'Start run', exact: true }).click();
    await expect(page.getByText(/playbook started|run started/i).first()).toBeVisible();
  } finally {
    await page.evaluate(async ({ hostName, filename, variableKey, scheduleName, groupId }) => {
      const token = localStorage.getItem('shipyard_token');
      const auth = { Authorization: `Bearer ${token}` };
      const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };
      const [hostsResponse, variablesResponse, schedulesResponse] = await Promise.all([
        fetch('/api/servers?environment_id=default', { headers: auth }),
        fetch('/api/ansible-vars?environment_id=default', { headers: auth }),
        fetch('/api/schedules?environment_id=default', { headers: auth }),
      ]);
      const hosts = hostsResponse.ok ? await hostsResponse.json() : [];
      const variables = variablesResponse.ok ? await variablesResponse.json() : [];
      const schedules = schedulesResponse.ok ? await schedulesResponse.json() : [];
      await Promise.all([
        ...hosts.filter((row: { name: string }) => row.name === hostName).map((row: { id: string }) => fetch(`/api/servers/${row.id}`, { method: 'DELETE', headers: auth })),
        ...variables.filter((row: { key: string }) => row.key === variableKey).map((row: { id: string }) => fetch(`/api/ansible-vars/${row.id}`, { method: 'DELETE', headers: auth })),
        ...schedules.filter((row: { name: string }) => row.name === scheduleName).map((row: { id: string }) => fetch(`/api/schedules/${row.id}`, { method: 'DELETE', headers: auth })),
      ]);
      await fetch(`/api/servers/groups/${groupId}`, { method: 'DELETE', headers: auth });
      await fetch(`/api/playbooks/${encodeURIComponent(filename)}`, { method: 'DELETE', headers: jsonHeaders });
    }, { hostName, filename, variableKey, scheduleName, groupId });
  }
});

test('a failed host task exposes its cause, duration, and full log', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginForIsolatedTest(page);
  const host = await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const created = await fetch('/api/servers', {
      method: 'POST', headers,
      body: JSON.stringify({ name: `failed-host-${Date.now().toString(36)}`, hostname: '127.0.0.1', ip_address: '127.0.0.1', ssh_port: 1, ssh_user: 'root' }),
    });
    if (!created.ok) throw new Error(`Could not create failed-host fixture: ${created.status}`);
    const row = await created.json() as { id: string; name: string };
    const started = await fetch(`/api/servers/${row.id}/update`, { method: 'POST', headers });
    if (!started.ok) throw new Error(`Could not start failed-host task: ${started.status}`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`/api/servers/${row.id}/history`, { headers: { Authorization: `Bearer ${token}` } });
      const history = response.ok ? await response.json() as Array<{ status: string }> : [];
      if (history.some(item => item.status === 'failed')) return row;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The failed-host task did not finish in time');
  });

  try {
    await page.goto(`/servers/${host.id}`);
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(page.getByText(/Duration: (?:\d+s|\d+m|—)/).first()).toBeVisible();
    const cause = page.getByText(/Cause:/).first();
    await expect(cause).toBeVisible();
    await expect(cause).not.toHaveText(/Cause:\s*—$/);
    await page.getByRole('button', { name: 'View log', exact: true }).first().click();
    const log = page.getByRole('dialog', { name: 'Task log' });
    await expect(log.locator('pre')).not.toHaveText('No log output was recorded.');
    await page.keyboard.press('Escape');

    await page.goto(`/operations?section=tasks&scope=failed&source=Host&q=${encodeURIComponent(host.name)}`);
    await expect(page.getByRole('button', { name: 'Failed 1', exact: true })).toBeVisible();
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/operations/host-') && response.url().endsWith('/acknowledge') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Acknowledge failure', exact: true }).click(),
    ]);
    await expect(page.getByRole('button', { name: 'Failed 0', exact: true })).toBeVisible();
    await expect(page.getByText('There are no entries for this view.', { exact: true })).toBeVisible();
  } finally {
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('shipyard_token');
      await fetch(`/api/servers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    }, host.id);
  }
});

test('IPAM dialogs remain usable inside a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginForIsolatedTest(page);
  await page.goto('/networks');
  await page.getByRole('button', { name: 'Add prefix' }).click();
  const prefixDialog = page.getByRole('dialog', { name: 'Add prefix' });
  await expect(prefixDialog).toBeVisible();
  const prefixBox = await prefixDialog.boundingBox();
  expect(prefixBox).not.toBeNull();
  expect(prefixBox!.x).toBeGreaterThanOrEqual(0);
  expect(prefixBox!.x + prefixBox!.width).toBeLessThanOrEqual(390);
  await prefixDialog.getByLabel('Name').fill('E2E Mobile Prefix');
  await prefixDialog.getByLabel('IPv4 prefix').fill('10.198.0.0/24');
  await prefixDialog.getByRole('button', { name: 'Add prefix', exact: true }).click();
  await page.getByRole('row').filter({ hasText: '10.198.0.0/24' }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Reserve address' }).click();
  const reservationDialog = page.getByRole('dialog', { name: 'Reserve address space' });
  await expect(reservationDialog).toBeVisible();
  const reservationBox = await reservationDialog.boundingBox();
  expect(reservationBox).not.toBeNull();
  expect(reservationBox!.x).toBeGreaterThanOrEqual(0);
  expect(reservationBox!.x + reservationBox!.width).toBeLessThanOrEqual(390);
  await reservationDialog.getByLabel('IP address').fill('10.198.0.10');
  await reservationDialog.getByLabel('Hostname').fill('e2e-mobile-ipam');
  await reservationDialog.getByRole('button', { name: 'Add IP address' }).click();
  await expect(page.getByText('e2e-mobile-ipam', { exact: true }).first()).toBeVisible();
  await page.goto('/networks');
  await page.getByRole('link', { name: 'Sources' }).click();
  await expect(page).toHaveURL(/\/networks\/sources$/);
  const sources = page.locator('[data-ipam-sources]');
  await expect(sources).toBeVisible();
  const sourceBox = await sources.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(sourceBox!.x).toBeGreaterThanOrEqual(0);
  expect(sourceBox!.x + sourceBox!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a Shipyard host can be assigned to a folder through the resource list', async ({ page }) => {
  // Keep the test usable on its own as well as in the full serial suite.
  await loginForIsolatedTest(page);
  await page.goto('/servers');

  const folder = await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const response = await fetch('/api/servers/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'E2E-Move-Ordner', color: '#2563eb' }),
    });
    if (!response.ok) throw new Error(`Folder setup failed (${response.status})`);
    return response.json() as Promise<{ id: string }>;
  });
  // The folder was created through the API to keep the setup deterministic;
  // reload so the resource list deliberately re-fetches its folder inventory
  // before exercising the real move control.
  await page.reload();

  await page.getByRole('button', { name: /host hinzufügen|server hinzufügen|add (?:managed )?(?:host|server)/i }).click();
  const form = page.getByRole('dialog');
  await form.locator('#server-name').fill('e2e-move-host');
  await form.locator('#server-ip-address').fill('10.99.0.11');
  await form.locator('button[type="submit"]').click();

  const row = page.getByRole('row', { name: /e2e-move-host/i });
  await expect(row).toBeVisible();
  await row.getByTitle(/in ordner verschieben|move to folder/i).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/servers/') && response.url().endsWith('/group') && response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'E2E-Move-Ordner', exact: true }).click(),
  ]);
  // The normal resource page intentionally stays a flat inventory. Folder
  // membership is inspected explicitly so the central table does not mirror
  // the navigator tree a second time.
  await page.getByTitle('Resource options').click();
  await page.getByRole('menuitem', { name: /folder view/i }).click();
  await expect(page.getByRole('table').getByText('E2E-Move-Ordner', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('row', { name: /e2e-move-host/i })).toBeVisible();

  // Create the second host through the API only as deterministic fixture; the
  // selection and the multi-move below are exercised through the real UI.
  await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const response = await fetch('/api/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'e2e-bulk-host', hostname: 'e2e-bulk-host', ip_address: '10.99.0.12', ssh_port: 22, ssh_user: 'root', tags: [], services: [] }),
    });
    if (!response.ok) throw new Error(`Second host setup failed (${response.status})`);
  });
  await page.reload();
  // Reload preserves the last chosen view; return to the compact inventory
  // before exercising bulk selection.
  await page.getByTitle('Resource options').click();
  const flatViewToggle = page.getByRole('menuitem', { name: /flat list/i });
  if (await flatViewToggle.isVisible()) await flatViewToggle.click();
  const firstBulkRow = page.getByRole('row', { name: /e2e-move-host/i });
  const secondBulkRow = page.getByRole('row', { name: /e2e-bulk-host/i });
  await firstBulkRow.locator('input[type="checkbox"]').check();
  await secondBulkRow.locator('input[type="checkbox"]').check();
  await page.getByLabel(/move selected hosts to folder|ausgewählte hosts in ordner verschieben/i).selectOption('__root__');
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/servers/group/bulk') && response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Move', exact: true }).click(),
  ]);
  await expect(page.getByText('2 hosts removed from folders.', { exact: true })).toBeVisible();

  await page.evaluate(async ({ groupId }) => {
    const token = localStorage.getItem('shipyard_token');
    await fetch(`/api/servers/groups/${groupId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }, { groupId: folder.id });
});

test('the inventory tree moves a selected Shipyard host without drag and drop', async ({ page }) => {
  await loginForIsolatedTest(page);
  const fixture = await page.evaluate(async () => {
    const token = localStorage.getItem('shipyard_token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const folderResponse = await fetch('/api/servers/groups', { method: 'POST', headers, body: JSON.stringify({ name: 'E2E-Tree-Ordner', color: '#2563eb' }) });
    if (!folderResponse.ok) throw new Error(`Folder fixture failed (${folderResponse.status})`);
    const folder = await folderResponse.json() as { id: string };
    const hostResponse = await fetch('/api/servers', { method: 'POST', headers, body: JSON.stringify({ name: 'e2e-tree-host', hostname: 'e2e-tree-host', ip_address: '10.99.0.23', ssh_port: 22, ssh_user: 'root', tags: [], services: [] }) });
    if (!hostResponse.ok) throw new Error(`Host fixture failed (${hostResponse.status})`);
    const host = await hostResponse.json() as { id: string };
    return { folder, host };
  });
  await page.goto('/infrastructure');
  const sidebar = page.locator('aside');
  // A freshly created test host has no poll result yet, therefore its status
  // is intentionally "Unbekannt". Select it by the stable action label,
  // rather than asserting a transient online/offline label.
  const selectHost = sidebar.getByLabel(/e2e-tree-host (select|auswählen)/i);
  await expect(selectHost).toBeVisible();
  await selectHost.click();
  const move = sidebar.getByLabel(/move selected resources|ausgewählte ressourcen verschieben/i);
  await expect(move).toBeVisible();
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/servers/group/bulk') && response.request().method() === 'PUT'),
    move.selectOption(fixture.folder.id),
  ]);
  await expect(sidebar.getByText(/^(1 host selected|1 host ausgewählt)$/i)).toHaveCount(0);
  await page.evaluate(async ({ folderId, hostId }) => {
    const token = localStorage.getItem('shipyard_token');
    await fetch(`/api/servers/${hostId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    await fetch(`/api/servers/groups/${folderId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }, { folderId: fixture.folder.id, hostId: fixture.host.id });
});

test('IPAM sources can be configured and synced through the browser', async ({ page }) => {
  const inventory = http.createServer((request, response) => {
    expect(request.url).toBe('/api/v2/status/dhcp_server/leases');
    expect(request.headers['x-api-key']).toBe('e2e-pfsense-token');
    expect(request.headers.authorization).toBeUndefined();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'e2e-lease', ip_address: '10.199.0.20', hostname: 'e2e-dhcp', mac_address: '02:00:00:00:00:20' },
      { id: 'e2e-observation', ip_address: '10.199.0.35', hostname: 'e2e-static', mac_address: '02:00:00:00:00:35' },
    ] }));
  });
  await new Promise<void>(resolve => inventory.listen(0, '127.0.0.1', resolve));
  const address = inventory.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind IPAM inventory test server');
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginForIsolatedTest(page);
    await page.goto('/networks');
    await page.getByRole('button', { name: 'Add prefix' }).click();
    const prefixDialog = page.getByRole('dialog', { name: 'Add prefix' });
    await prefixDialog.getByPlaceholder('Production network').fill('E2E DHCP');
    await prefixDialog.getByPlaceholder('10.20.10.0/24').fill('10.199.0.0/24');
    await prefixDialog.getByText('Advanced network configuration', { exact: true }).click();
    await prefixDialog.getByLabel('DHCP start').fill('10.199.0.10');
    await prefixDialog.getByLabel('DHCP end').fill('10.199.0.30');
    await prefixDialog.getByRole('button', { name: 'Add prefix', exact: true }).click();

    await page.getByRole('link', { name: 'Sources' }).click();
    await expect(page).toHaveURL(/\/networks\/sources$/);
    const sources = page.locator('[data-ipam-sources]');
    await sources.getByRole('button', { name: 'Add source' }).click();
    await sources.locator('select').first().selectOption('pfsense');
    await sources.getByPlaceholder('pfSense production').fill('E2E pfSense');
    await sources.getByPlaceholder('https://pfsense.example.local').fill(`http://127.0.0.1:${address.port}`);
    await sources.locator('input[type="password"]').fill('e2e-pfsense-token');
    await sources.getByRole('button', { name: 'Save source' }).click();
    await expect(sources.getByText('E2E pfSense', { exact: true })).toBeVisible();
    const sourceList = sources.locator('[data-ipam-source-list]');
    await expect(sourceList).toBeVisible();
    const sourceWidths = await sourceList.evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    expect(sourceWidths.scrollWidth).toBeLessThanOrEqual(sourceWidths.clientWidth);
    await sources.getByRole('button', { name: 'Test E2E pfSense' }).click();
    const testReport = page.getByRole('dialog', { name: 'Source checked' });
    await expect(testReport).toContainText('E2E pfSense');
    await expect(testReport).toContainText('10.199.0.20');
    await expect(testReport).toContainText(/did not change any IPAM data/i);
    await testReport.getByRole('button', { name: 'Done' }).click();
    await sources.getByRole('button', { name: 'Sync E2E pfSense' }).click();
    const syncConfirmation = page.getByRole('dialog', { name: 'Synchronize source completely?' });
    await expect(syncConfirmation).toContainText(/no longer reported/i);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/sync') && response.request().method() === 'POST'),
      syncConfirmation.getByRole('button', { name: 'Sync now' }).click(),
    ]);
    await expect(sources.getByText('Synchronized', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to IPAM' }).click();
    await expect(page).toHaveURL(/\/networks$/);

    const prefixEntry = page.getByRole('row').filter({ hasText: '10.199.0.0/24' });
    const prefixPositionBefore = await prefixEntry.boundingBox();
    const prefixCheckbox = prefixEntry.getByRole('checkbox', { name: 'Select prefix 10.199.0.0/24' });
    await prefixCheckbox.check();
    await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
    const prefixPositionAfter = await prefixEntry.boundingBox();
    expect(prefixPositionAfter?.y).toBe(prefixPositionBefore?.y);
    await prefixCheckbox.uncheck();
    await prefixEntry.getByRole('link').first().click();
    await expect(page.getByRole('table').getByText('10.199.0.20', { exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByText('e2e-dhcp', { exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByText('02:00:00:00:00:20', { exact: true })).toBeVisible();
    await expect(page.getByText('10.199.0.10 – 10.199.0.30 (21 addresses)', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Source', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Type', exact: true })).toHaveCount(0);
    const allocationRow = page.getByRole('row').filter({ hasText: '10.199.0.20' });
    await expect(allocationRow.getByText('DHCP', { exact: true })).toBeVisible();
    await expect(allocationRow.getByText('Managed by pfSense', { exact: true })).toBeVisible();
    await expect(allocationRow.getByRole('checkbox')).toBeDisabled();
    await expect(page.getByLabel('Edit 10.199.0.20')).toHaveCount(0);
    await expect(page.getByLabel('Release 10.199.0.20')).toHaveCount(0);
    const outsideDhcpRow = page.getByRole('row').filter({ hasText: '10.199.0.35' });
    await expect(outsideDhcpRow.getByText('Active', { exact: true })).toBeVisible();
    await expect(outsideDhcpRow.getByText('DHCP', { exact: true })).toHaveCount(0);

    const addressTable = page.getByRole('table');
    await addressTable.getByRole('button', { name: 'Reserve first IP', exact: true }).first().click();
    const reservationDialog = page.getByRole('dialog', { name: 'Reserve address space' });
    await expect(reservationDialog.getByLabel('IP address')).toHaveValue('10.199.0.1');
    await page.keyboard.press('Escape');

    await addressTable.getByRole('button', { name: 'Reserve range', exact: true }).first().click();
    await expect(reservationDialog.getByLabel('First address')).toHaveValue('10.199.0.1');
    await expect(reservationDialog.getByLabel('Last address')).toHaveValue('10.199.0.19');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Reserve address' }).click();
    await expect(reservationDialog.getByLabel('Status').locator('option[value="dhcp"]')).toHaveCount(0);
    await reservationDialog.getByLabel('IP address').fill('10.199.0.21');
    await reservationDialog.getByLabel('Hostname').fill('e2e-manual');
    await reservationDialog.getByLabel('Description').fill('Manual browser test');
    await reservationDialog.getByRole('button', { name: 'Add IP address' }).click();
    await expect(page.getByRole('table').getByText('10.199.0.21', { exact: true })).toBeVisible();
    const manualAllocationRow = page.getByRole('row').filter({ hasText: '10.199.0.21' });
    await expect(manualAllocationRow.getByText('Manual', { exact: true })).toBeVisible();
    await expect(manualAllocationRow.getByText('DHCP', { exact: true })).toBeVisible();
    await expect(manualAllocationRow.getByRole('checkbox')).toBeEnabled();
    await page.getByLabel('Edit 10.199.0.21').click();
    const editDialog = page.getByRole('dialog', { name: 'Edit IP address' });
    await expect(editDialog).toContainText('This address is shown as DHCP because it lies inside the configured prefix range.');
    await editDialog.getByLabel('Hostname').fill('e2e-manual-edited');
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('table').getByText('e2e-manual-edited', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reserve address' }).click();
    await reservationDialog.getByRole('button', { name: 'Range' }).click();
    await reservationDialog.getByLabel('First address').fill('10.199.0.40');
    await reservationDialog.getByLabel('Last address').fill('10.199.0.42');
    await reservationDialog.getByLabel('Description').fill('E2E reserved range');
    await reservationDialog.getByRole('button', { name: 'Reserve range' }).click();
    await expect(page.getByRole('table').getByText('10.199.0.40 – 10.199.0.42', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /child prefixes/i }).click();
    await expect(page.getByRole('heading', { name: 'Child prefixes' })).toBeVisible();
    await expect(page.getByText('No direct child prefixes.')).toBeVisible();
  } finally {
    await new Promise<void>(resolve => inventory.close(() => resolve()));
  }
});

test('a discovered Proxmox VM can be adopted through the browser without changing its inventory identity', async ({ page }) => {
  const proxmox = https.createServer({ key: PROXMOX_E2E_KEY, cert: PROXMOX_E2E_CERT }, (request, response) => {
    const url = new URL(request.url || '/', 'https://127.0.0.1');
    const send = (data: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data }));
    };
    if (url.pathname === '/api2/json/nodes') return send([{ node: 'e2e-node', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1024, maxmem: 4096, uptime: 3600 }]);
    if (url.pathname === '/api2/json/cluster/resources') return send([{ type: 'qemu', node: 'e2e-node', vmid: 207, name: 'e2e-import-vm', status: 'running', maxcpu: 2, mem: 1024, maxmem: 2048 }]);
    if (url.pathname === '/api2/json/nodes/e2e-node/storage') return send([]);
    if (url.pathname === '/api2/json/nodes/e2e-node/qemu/207/agent/network-get-interfaces') {
      return send({ result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }, { name: 'ens18', 'ip-addresses': [{ 'ip-address': '10.250.0.207', 'ip-address-type': 'ipv4' }] }] });
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ data: null }));
  });
  await new Promise<void>(resolve => proxmox.listen(0, '127.0.0.1', resolve));
  const address = proxmox.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind mock Proxmox API');

  let connectionId = '';
  try {
    await loginForIsolatedTest(page);
    connectionId = await page.evaluate(async (port) => {
      const token = localStorage.getItem('shipyard_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const response = await fetch('/api/opentofu/proxmox-connections', {
        method: 'POST',
        headers,
        body: JSON.stringify({ environment_id: 'default', name: 'E2E Inventory Platform', endpoint: `https://127.0.0.1:${port}`, api_token: 'root@pam!fleet=e2e-import-token', insecure: true }),
      });
      if (!response.ok) throw new Error(`Proxmox test connection failed (${response.status})`);
      return (await response.json() as { id: string }).id;
    }, address.port);

    await openPlatformInventory(page, 'E2E Inventory Platform');
    await expect(page.getByRole('heading', { name: 'E2E Inventory Platform' })).toBeVisible();
    // Adoption is an inventory action. The overview deliberately stays focused
    // on platform capacity and node health.
    await page.getByRole('tab', { name: /virtual machines/i }).click();
    await page.getByRole('button', { name: 'Actions for e2e-import-vm' }).click();
    await page.getByRole('menuitem', { name: 'Adopt as host' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adopt VM as host' });
    await expect(dialog).toBeVisible();
    const inputs = dialog.locator('input');
    await expect(inputs.nth(1)).toHaveValue('10.250.0.207');
    await inputs.nth(2).fill('ubuntu');
    await inputs.nth(3).fill('2222');
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/import-vm') && response.request().method() === 'POST' && response.status() === 201),
      dialog.getByRole('button', { name: 'Adopt as host' }).click(),
    ]);
    await expect(page.getByText('VM adopted as a host.', { exact: true })).toBeVisible();
    const inventoryTree = page.locator('aside');
    await expect(inventoryTree.getByText('e2e-import-vm', { exact: true })).toHaveCount(1);
    const managedVmLink = inventoryTree.getByRole('link').filter({ hasText: 'e2e-import-vm' });
    await expect(managedVmLink).toHaveAttribute('href', /\/servers\//);
    await expect(inventoryTree.getByRole('link', { name: 'Open Proxmox virtual machine e2e-import-vm' })).toHaveAttribute('href', /\/infrastructure\/.*\/vms\/207/);
    await page.goto('/servers');
    const row = page.getByRole('row', { name: /e2e-import-vm/i });
    await expect(row).toBeVisible();
    await expect(row).toContainText('10.250.0.207');
  } finally {
    if (connectionId) {
      await page.evaluate(async (id) => {
        const token = localStorage.getItem('shipyard_token');
        await fetch(`/api/opentofu/proxmox-connections/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      }, connectionId).catch(() => {});
    }
    await new Promise<void>(resolve => proxmox.close(() => resolve()));
  }
});

test('infrastructure overview presents platform nodes and VMs as an operator inventory', async ({ page }) => {
  const proxmox = https.createServer({ key: PROXMOX_E2E_KEY, cert: PROXMOX_E2E_CERT }, (request, response) => {
    const url = new URL(request.url || '/', 'https://127.0.0.1');
    const send = (data: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
    if (url.pathname === '/api2/json/nodes') return send([{ node: 'hierarchy-node', status: 'online', cpu: 0.1, maxcpu: 4, mem: 1024, maxmem: 4096, uptime: 3600 }]);
    if (url.pathname === '/api2/json/nodes/hierarchy-node/status') return send({ pveversion: 'pve-manager/8.4.1', kversion: 'Linux 6.8.12-1-pve', cpuinfo: { model: 'E2E Xeon', sockets: 1 } });
    if (url.pathname === '/api2/json/nodes/hierarchy-node/network') return send([{ iface: 'vmbr0', type: 'bridge', active: 1, address: '10.250.0.10', cidr: 24, gateway: '10.250.0.1' }, { iface: 'enp1s0', type: 'eth', active: 1, address: '10.250.0.11', cidr: 24 }]);
    if (url.pathname === '/api2/json/nodes/hierarchy-node/apt/update') {
      if (request.method === 'POST') return send('UPID:hierarchy-node:apt-update');
      return send([{ Package: 'pve-manager', Title: 'Proxmox VE Manager', Description: 'Proxmox VE management stack', Origin: 'Proxmox', OldVersion: '8.4.1', Version: '8.4.2', Priority: 'optional', Section: 'admin', Arch: 'amd64' }]);
    }
    if (url.pathname === '/api2/json/cluster/resources') return send([
      { type: 'qemu', node: 'hierarchy-node', vmid: 208, name: 'hierarchy-vm', status: 'running', maxcpu: 2, mem: 1024, maxmem: 2048 },
      { type: 'lxc', node: 'hierarchy-node', vmid: 210, name: 'hierarchy-ct', status: 'running', maxcpu: 1, mem: 512, maxmem: 1024 },
    ]);
    if (url.pathname === '/api2/json/nodes/hierarchy-node/storage') return send([]);
    response.statusCode = 404;
    response.end(JSON.stringify({ data: null }));
  });
  await new Promise<void>(resolve => proxmox.listen(0, '127.0.0.1', resolve));
  const address = proxmox.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind mock Proxmox API');

  let connectionId = '';
  let fleetServerId = '';
  try {
    await loginForIsolatedTest(page);
    connectionId = await page.evaluate(async (port) => {
      const token = localStorage.getItem('shipyard_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const response = await fetch('/api/opentofu/proxmox-connections', {
        method: 'POST', headers,
        body: JSON.stringify({ environment_id: 'default', name: 'E2E Hierarchy Platform', endpoint: `https://127.0.0.1:${port}`, api_token: 'root@pam!fleet=e2e-hierarchy-token', insecure: true }),
      });
      if (!response.ok) throw new Error(`Platform setup failed (${response.status})`);
      return (await response.json() as { id: string }).id;
    }, address.port);

    await openPlatformInventory(page, 'E2E Hierarchy Platform');
    await expect(page.getByText('Operational status', { exact: true })).toBeVisible();
    await expect(page.getByText(/^(ready for operation|bereit für betrieb)$/i)).toBeVisible();
    await expect(page.locator('aside').getByRole('link', { name: /E2E Hierarchy Platform/i })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('aside').getByRole('link', { name: /hierarchy-node/i })).toBeVisible();
    await page.getByRole('tab', { name: /updates 1/i }).click();
    const platformUpdatesTable = page.locator('main table').filter({ hasText: 'hierarchy-node' });
    await expect(platformUpdatesTable).toBeVisible();
    const updateTableWidth = await platformUpdatesTable.evaluate((table) => ({
      table: table.getBoundingClientRect().width,
      container: table.parentElement?.getBoundingClientRect().width || 0,
    }));
    expect(updateTableWidth.table).toBeGreaterThanOrEqual(updateTableWidth.container - 2);
    await platformUpdatesTable.getByRole('button', { name: 'Add to Shipyard' }).click();
    const addFleetDialog = page.getByRole('dialog', { name: 'Add host' });
    await expect(addFleetDialog.getByLabel(/(?:host|server) name/i)).toHaveValue('hierarchy-node');
    await expect(addFleetDialog.getByLabel('IP Address')).toHaveValue('10.250.0.10');
    await expect(addFleetDialog.getByLabel('Hostname')).toHaveValue('hierarchy-node');
    const [createdFleetResponse] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/servers') && response.request().method() === 'POST' && response.ok()),
      addFleetDialog.getByRole('button', { name: 'Add', exact: true }).click(),
    ]);
    fleetServerId = ((await createdFleetResponse.json()) as { id: string }).id;
    await expect(platformUpdatesTable.getByText('Ready through Shipyard', { exact: true })).toBeVisible();
    const hierarchyTree = page.locator('aside');
    await expect(hierarchyTree.getByText('hierarchy-node', { exact: true })).toHaveCount(1);
    const managedNodeLink = hierarchyTree.getByRole('link', { name: 'Open managed host hierarchy-node' });
    await expect(managedNodeLink).toBeVisible();
    await managedNodeLink.click();
    await expect(page).toHaveURL(/\/servers\//);
    await expect(page.getByRole('heading', { name: 'hierarchy-node', exact: true })).toBeVisible();
    await expect(page.getByText('Host summary', { exact: true })).toBeVisible();

    await openPlatformInventory(page, 'E2E Hierarchy Platform');
    await page.getByRole('tab', { name: /nodes 1/i }).click();
    await page.locator('main').getByRole('link', { name: 'hierarchy-node', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'hierarchy-node', exact: true })).toBeVisible();
    await expect(page.getByText(/^(primary ZFS datastore|primärer ZFS-datastore)$/i)).toBeVisible();
    // Detail pages use the same object rows on narrow screens: no horizontal
    // table is required just to inspect the first inventory entries.
    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePreviewVm = page.locator('main a').filter({ hasText: 'hierarchy-vm' }).first();
    await mobilePreviewVm.scrollIntoViewIfNeeded();
    await expect(mobilePreviewVm).toBeVisible();
    await expect(page.locator('main table').first()).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await expect(page.getByText('E2E Xeon', { exact: true })).toBeVisible();
    await expect(page.getByText('pve-manager/8.4.1', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'vmbr0', exact: true })).toBeVisible();
    await expect(page.locator('td', { hasText: '10.250.0.10/24' }).first()).toBeVisible();
    await page.getByRole('tab', { name: /updates 1/i }).click();
    await expect(page.getByText('pve-manager', { exact: true })).toBeVisible();
    await expect(page.getByText('8.4.1', { exact: true })).toBeVisible();
    await expect(page.getByText('8.4.2', { exact: true })).toBeVisible();
    const installUpdatesButton = page.getByRole('button', { name: 'Install 1 update' });
    await expect(installUpdatesButton).toBeEnabled();
    await installUpdatesButton.click();
    const updateDialog = page.getByRole('dialog', { name: 'Install updates on hierarchy-node?' });
    await expect(updateDialog.getByText(/services may restart/i)).toBeVisible();
    await updateDialog.getByRole('button', { name: 'Cancel' }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/updates/refresh') && response.request().method() === 'POST' && response.status() === 202),
      page.getByRole('button', { name: 'Refresh catalog' }).click(),
    ]);
    await page.getByRole('tab', { name: /virtual machines/i }).click();
    await expect(page.getByRole('link', { name: 'hierarchy-vm', exact: true })).toBeVisible();
    const ctRow = page.getByRole('row', { name: /hierarchy-ct/i });
    await expect(ctRow).toBeVisible();
    await expect(ctRow).toContainText('CT');
    await expect(ctRow.getByRole('button', { name: 'Actions for hierarchy-ct' })).toBeVisible();
    await page.getByRole('link', { name: 'hierarchy-vm', exact: true }).click();
    await expect(page).toHaveURL(/\/infrastructure\/.*\/nodes\/hierarchy-node\/vms\/208/);
    await expect(page.getByRole('heading', { name: 'hierarchy-vm', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'hierarchy-node', exact: true })).toBeVisible();
  } finally {
    if (fleetServerId) await page.evaluate(async (id) => {
      const token = localStorage.getItem('shipyard_token');
      await fetch(`/api/servers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    }, fleetServerId).catch(() => {});
    if (connectionId) await page.evaluate(async (id) => {
      const token = localStorage.getItem('shipyard_token');
      await fetch(`/api/opentofu/proxmox-connections/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    }, connectionId).catch(() => {});
    await new Promise<void>(resolve => proxmox.close(() => resolve()));
  }
});

test('a Proxmox VM keeps configuration and tasks in distinct object tabs', async ({ page }) => {
  const proxmox = https.createServer({ key: PROXMOX_E2E_KEY, cert: PROXMOX_E2E_CERT }, (request, response) => {
    const url = new URL(request.url || '/', 'https://127.0.0.1');
    const send = (data: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data })); };
    if (url.pathname === '/api2/json/nodes') return send([{ node: 'object-node', status: 'online', cpu: 0.2, maxcpu: 4, mem: 1024, maxmem: 4096, uptime: 3600 }]);
    if (url.pathname === '/api2/json/cluster/resources') return send([{ type: 'qemu', node: 'object-node', vmid: 209, name: 'object-vm', status: 'running', cpu: 0.2, maxcpu: 2, mem: 1024, maxmem: 2048, disk: 2048, maxdisk: 4096 }]);
    if (url.pathname === '/api2/json/nodes/object-node/storage') return send([]);
    if (url.pathname === '/api2/json/nodes/object-node/qemu/209/config') return send({ sockets: 1, cores: 2, memory: 2048, ostype: 'l26', agent: 1, bios: 'ovmf', machine: 'q35', boot: 'order=scsi0', scsi0: 'local-lvm:vm-209-disk-0,size=4G,discard=on', net0: 'virtio=00:00:00:00:02:09,bridge=vmbr0,tag=10' });
    if (url.pathname === '/api2/json/nodes/object-node/qemu/209/snapshot') return send([]);
    if (url.pathname === '/api2/json/nodes/object-node/qemu/209/agent/network-get-interfaces') return send({ result: [] });
    response.statusCode = 404;
    response.end(JSON.stringify({ data: null }));
  });
  await new Promise<void>(resolve => proxmox.listen(0, '127.0.0.1', resolve));
  const address = proxmox.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind mock Proxmox API');

  let connectionId = '';
  try {
    await loginForIsolatedTest(page);
    connectionId = await page.evaluate(async (port) => {
      const token = localStorage.getItem('shipyard_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const response = await fetch('/api/opentofu/proxmox-connections', { method: 'POST', headers, body: JSON.stringify({ environment_id: 'default', name: 'E2E Object Platform', endpoint: `https://127.0.0.1:${port}`, api_token: 'root@pam!fleet=e2e-object-token', insecure: true }) });
      if (!response.ok) throw new Error(`Platform setup failed (${response.status})`);
      return (await response.json() as { id: string }).id;
    }, address.port);

    await openPlatformInventory(page, 'E2E Object Platform');
    await page.getByRole('tab', { name: /virtual machines/i }).click();
    await page.getByRole('link', { name: 'object-vm', exact: true }).click();
    await expect(page.getByText('Virtual machine', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /configuration/i })).toBeVisible();
    await page.getByRole('tab', { name: /configuration/i }).click();
    await expect(page.getByText('Hardware & virtual machine', { exact: true })).toBeVisible();
    await expect(page.getByText(/^(BIOS \/ machine|BIOS \/ Maschine)$/i)).toBeVisible();
    await page.getByRole('tab', { name: /tasks/i }).click();
    await expect(page.getByText('No direct Proxmox actions have been recorded for this VM yet.')).toBeVisible();
  } finally {
    if (connectionId) await page.evaluate(async (id) => {
      const token = localStorage.getItem('shipyard_token');
      await fetch(`/api/opentofu/proxmox-connections/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    }, connectionId).catch(() => {});
    await new Promise<void>(resolve => proxmox.close(() => resolve()));
  }
});

test('an isolated VM uses a platform source and guards Destroy with an exact phrase', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginForIsolatedTest(page);
  const suffix = Date.now().toString(36);
  const vmName = `e2e-isolated-${suffix}`;

  const connection = await page.evaluate(async (uniqueSuffix) => {
    const token = localStorage.getItem('shipyard_token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const response = await fetch('/api/opentofu/proxmox-connections', {
      method: 'POST', headers,
      body: JSON.stringify({ environment_id: 'default', name: `E2E Deployment Platform ${uniqueSuffix}`, endpoint: 'https://pve.e2e.invalid:8006', api_token: 'root@pam!fleet=e2e-token', insecure: true }),
    });
    if (!response.ok) throw new Error(`Platform setup failed (${response.status})`);
    return response.json() as Promise<{ id: string }>;
  }, suffix);

  let vmId = '';
  try {
    vmId = await page.evaluate(async ({ connectionId, name }) => {
      const token = localStorage.getItem('shipyard_token');
      const response = await fetch('/api/opentofu/vms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          environment_id: 'default', connection_id: connectionId,
          name, node_name: 'pve-e2e',
          clone_vm_id: 9000, disk_datastore: 'local-lvm', bridge: 'vmbr0',
        }),
      });
      if (!response.ok) throw new Error(`VM setup failed (${response.status})`);
      return String((await response.json() as { id: string }).id);
    }, { connectionId: connection.id, name: vmName });

    await page.goto(`/deployments/${vmId}`);
    await expect(page.getByRole('heading', { name: vmName })).toBeVisible();
    await page.getByRole('button', { name: 'Destroy VM' }).click();
    const destroyDialog = page.getByRole('dialog', { name: 'Destroy VM in Proxmox?' });
    const destroyButton = destroyDialog.getByRole('button', { name: 'Destroy VM' });
    const confirmInput = destroyDialog.getByLabel('Type to confirm');
    const phrase = await confirmInput.getAttribute('placeholder');
    expect(phrase).toBeTruthy();
    await expect(destroyButton).toBeDisabled();
    await confirmInput.fill(`${phrase} wrong`);
    await expect(destroyButton).toBeDisabled();
    await confirmInput.fill('');
    await confirmInput.pressSequentially(phrase!);
    await expect(confirmInput).toHaveValue(phrase!);
    expect(await destroyButton.isEnabled(), `Destroy guard: input=${JSON.stringify(await confirmInput.inputValue())}, phrase=${JSON.stringify(phrase)}`).toBe(true);
    await destroyDialog.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    // Every Playwright run has its own temporary database. Do not let cleanup
    // call the OpenTofu runtime from the browser: it can wait on an external
    // process after the destructive-action assertion has already completed.
    // The complete temporary database is removed when the isolated server exits.
    void connection;
    void vmId;
  }
});
