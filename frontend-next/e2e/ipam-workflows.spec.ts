import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  const setup = page.getByRole('button', { name: /let'?s go|los geht'?s/i });
  if (await setup.isVisible()) {
    await setup.click();
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

test('IPAM workflows remain usable across desktop and mobile layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 980 });
  await login(page);
  await page.goto('/networks');

  await page.getByRole('button', { name: 'Add prefix' }).click();
  const prefixDialog = page.getByRole('dialog', { name: 'Add prefix' });
  await prefixDialog.getByLabel('Name').fill('Produktionsnetz');
  await prefixDialog.getByLabel('IPv4 prefix').fill('10.20.1.0/24');
  await prefixDialog.getByRole('button', { name: 'Add prefix', exact: true }).click();

  await page.getByRole('button', { name: 'Add prefix' }).click();
  await prefixDialog.getByLabel('Name').fill('Veraltetes Testnetz');
  await prefixDialog.getByLabel('IPv4 prefix').fill('10.20.2.0/24');
  await prefixDialog.getByRole('button', { name: 'Add prefix', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select prefix 10.20.2.0/24' }).check();
  await page.getByRole('button', { name: 'Bulk actions', exact: true }).click();
  await page.getByRole('menu', { name: 'Bulk actions' }).getByRole('menuitem', { name: 'Deprecated', exact: true }).click();

  await page.getByRole('link', { name: 'Sources' }).click();
  const sources = page.locator('[data-ipam-sources]');
  await sources.getByRole('button', { name: 'Add source' }).click();
  await sources.getByPlaceholder('UniFi production').fill('UniFi Produktion');
  await sources.getByPlaceholder('https://unifi.example.local').fill('https://unifi.example.invalid');
  await sources.locator('input[type="password"]').fill('visual-source-token');
  await sources.getByRole('button', { name: 'Save source' }).click();
  await expect(sources.getByText('UniFi Produktion', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to IPAM' }).click();

  await page.getByRole('row').filter({ hasText: '10.20.1.0/24' }).getByRole('link').first().click();
  await expect(page.locator('table').getByText('254 free IPs', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /child prefixes/i }).click();
  await expect(page).toHaveURL(/#tab=children$/);
  await page.reload();
  await expect(page.getByRole('tab', { name: /child prefixes/i })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByRole('tab', { name: /address inventory/i })).toHaveAttribute('data-state', 'active');
  await page.getByRole('button', { name: 'Reserve address' }).click();
  const reservation = page.getByRole('dialog', { name: 'Reserve address' });
  await reservation.getByLabel('IP address').fill('10.20.1.30');
  await reservation.getByLabel('Hostname').fill('app-erp');
  await reservation.getByLabel('MAC address').fill('02:00:00:00:01:30');
  await reservation.getByRole('button', { name: 'Add IP address' }).click();
  await expect(reservation).toBeHidden();
  await expect(page.locator('tbody').getByText('app-erp', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText('29 free IPs', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('02:00:00:00:01:30', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/networks');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('link', { name: 'Sources' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
