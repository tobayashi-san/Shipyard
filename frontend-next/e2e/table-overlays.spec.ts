import { test, expect } from '@playwright/test';

test('table menus overlay rows without moving the page', async ({ page }, testInfo) => {
  await page.goto('/login');
  await page.evaluate(async () => {
    const body = JSON.stringify({ username: 'e2e-admin', password: 'E2e-password-2026!' });
    let r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) r = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = await r.json();
    if (!data.token) throw new Error('Authentication failed');
    localStorage.setItem('shipyard_token', data.token);
  });
  await page.route('**/api/schedules?*', route => route.fulfill({ json: Array.from({ length: 40 }, (_, i) => ({
    id: String(i), name: `Workflow ${i}`, playbook: 'ping.yml', targets: ['host'], enabled: false, cron_expression: '0 1 * * *', timezone: 'Europe/Zurich',
  })) }));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/playbooks#tab=schedules');
    const trigger = page.getByRole('button', { name: 'Actions for Workflow 0', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const before = await trigger.boundingBox();
    const main = page.locator('main');
    const scrollBefore = await main.evaluate(el => el.scrollTop);
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Workflow 0' });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(el => el.closest('table') === null)).toBe(true);
    expect(await trigger.boundingBox()).toEqual(before);
    expect(await main.evaluate(el => el.scrollTop)).toBe(scrollBefore);
    const bounds = await menu.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`table-overlay-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`table-scroll-${width}.png`), fullPage: true });
  }
  await page.route('**/api/servers?*', route => route.fulfill({ json: [{ id: 'host-first', name: 'Managed host', ip_address: '192.0.2.1', environment_id: 'default' }] }));
  const inventory = { clusters: [{ id: 'platform', status: 'online', endpoint: 'https://example.invalid', connections: [{id:'platform',name:'Lab platform'}], nodes: [{name:'node',status:'online'}], vms: [{vm_id:101,name:'Platform VM',node_name:'node',status:'running',fleet_server_id:'host-first'}] }] };
  await page.route('**/api/opentofu/infrastructure?*', route => route.fulfill({ json: inventory }));
  await page.goto('/infrastructure');
  const vmLink = page.locator('main').getByRole('link', {name:'Platform VM',exact:true});
  await expect(vmLink).toBeHidden();
  await expect(page.locator('main').getByRole('link',{name:'Managed host',exact:true})).toBeVisible();
  await expect(page.locator('main').getByRole('link',{name:'Managed host',exact:true})).toHaveAttribute('href','/servers/host-first');
  await page.screenshot({path:testInfo.outputPath('host-first-mobile.png')});
  await page.goto('/settings/notifications');
  await page.locator('summary').filter({hasText:'Email (SMTP)'}).click();
  await page.getByRole('button',{name:'Help: SMTP transport',exact:true}).click();
  await expect(page.getByRole('tooltip')).toContainText('STARTTLS');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});
