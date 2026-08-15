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

test('capture populated IPAM pages for visual review', async ({ page }) => {
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
  const deprecatedRow = page.getByRole('row').filter({ hasText: '10.20.2.0/24' });
  await deprecatedRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Deprecated', exact: true }).click();

  await page.screenshot({ path: 'test-results/visual-review/ipam-overview-populated.png', fullPage: true });

  await page.getByRole('button', { name: 'Sources' }).click();
  const sources = page.getByRole('dialog', { name: 'IPAM sources' });
  await sources.getByRole('button', { name: 'Add source' }).click();
  await sources.getByPlaceholder('UniFi Produktion').fill('UniFi Produktion');
  await sources.getByPlaceholder('https://unifi.example.local').fill('https://unifi.example.invalid');
  await sources.locator('input[type="password"]').fill('visual-source-token');
  await sources.getByRole('button', { name: 'Save source' }).click();
  await expect(sources.getByText('UniFi Produktion', { exact: true })).toBeVisible();
  await sources.screenshot({ path: 'test-results/visual-review/ipam-sources-dialog.png' });
  await sources.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('link', { name: /10\.20\.1\.0\/24/i }).first().click();
  await page.getByRole('tab', { name: /child prefixes/i }).click();
  await expect(page).toHaveURL(/#tab=children$/);
  await page.reload();
  await expect(page.getByRole('tab', { name: /child prefixes/i })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByRole('tab', { name: /address inventory/i })).toHaveAttribute('data-state', 'active');
  await page.getByRole('button', { name: 'Reserve address' }).click();
  const reservation = page.getByRole('dialog', { name: 'Reserve address space' });
  await reservation.getByLabel('IP address').fill('10.20.1.30');
  await reservation.getByLabel('Hostname').fill('app-erp');
  await reservation.getByRole('button', { name: 'Add IP address' }).click();
  await expect(reservation).toBeHidden();
  await expect(page.locator('tbody').getByText('app-erp', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/visual-review/ipam-prefix-populated.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/networks');
  await page.screenshot({ path: 'test-results/visual-review/ipam-overview-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Sources' }).click();
  await page.getByRole('dialog', { name: 'IPAM sources' }).screenshot({ path: 'test-results/visual-review/ipam-sources-mobile.png' });
});
