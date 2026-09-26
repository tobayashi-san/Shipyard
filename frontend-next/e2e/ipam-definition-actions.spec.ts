import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.evaluate(async () => {
    const body = JSON.stringify({username:'e2e-admin', password:'E2e-password-2026!'});
    let response = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body});
    if (!response.ok) response = await fetch('/api/auth/setup', {method:'POST', headers:{'Content-Type':'application/json'}, body});
    localStorage.setItem('fleet_token', (await response.json()).token);
  });
}

test('Proxmox connections are visible directly in Settings and editing loads the selected connection', async ({page}) => {
  await login(page);
  await page.route('**/api/opentofu/proxmox-connections?*', route => route.fulfill({json:[{id:'pve', name:'Production PVE', environment_id:'default', endpoint:'https://pve.example.test:8006', api_token_configured:true, auto_sync_ipam:true, sync_interval_min:15}]}));
  await page.goto('/settings/connections');
  const connections = page.getByRole('region', {name:'Proxmox connections'});
  await expect(connections.getByText('Production PVE')).toBeVisible();
  await connections.getByRole('button', {name:'Edit', exact:true}).click();
  await expect(page.getByRole('dialog').locator('input[value="Production PVE"]')).toBeVisible();
});

test('VM definition deletion keeps errors reviewable and removes the selected definition on retry', async ({page}) => {
  await login(page);
  let deleted = false;
  let attempts = 0;
  await page.route('**/api/opentofu/vms?*', route => route.fulfill({json:deleted ? [] : [{id:'draft-1',name:'test33'}]}));
  await page.route('**/api/opentofu/legacy-workspaces?*', route => route.fulfill({json:[]}));
  await page.route('**/api/opentofu/vm-templates?*', route => route.fulfill({json:{templates:[]}}));
  await page.route('**/api/opentofu/vms/draft-1/forget', route => {
    expect(route.request().postDataJSON()).toEqual({confirmation:'FORGET test33'});
    expect(route.request().headers()['x-fleet-environment']).toBe('default');
    attempts++;
    if (attempts === 1) return route.fulfill({status:409,json:{error:'An operation is still running.'}});
    deleted = true;
    return route.fulfill({json:{success:true,infrastructure_kept:true}});
  });
  await page.goto('/deployments');
  await page.getByRole('button', {name:'Actions for test33'}).click();
  await page.getByRole('menuitem', {name:'Delete definition'}).click();
  const dialog = page.getByRole('dialog', {name:'Delete VM definition?'});
  await dialog.getByLabel('Type to confirm').fill('test33');
  await dialog.getByRole('button', {name:'Delete definition',exact:true}).click();
  await expect(dialog.getByText('An operation is still running.')).toBeVisible();
  await dialog.getByRole('button', {name:'Delete definition',exact:true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', {name:'Actions for test33'})).toHaveCount(0);
});

test('IPAM selects synchronized and manual addresses while release targets only manual allocations', async ({page}) => {
  await login(page);
  await page.route('**/api/ipam/subnets/selection', route => route.fulfill({json:{id:'selection',environment_id:'default',name:'Selection network',cidr:'10.20.1.0/24', reservations:[],children:[]}}));
  await page.route('**/api/ipam/subnets/selection/allocations?*', route => route.fulfill({json:{items:[
    {id:'manual',kind:'address',start_address:'10.20.1.10',end_address:'10.20.1.10',address:'10.20.1.10',address_count:1,status:'active',source_type:'manual'},
    {id:'synced',kind:'address',start_address:'10.20.1.11',end_address:'10.20.1.11',address:'10.20.1.11',address_count:1,status:'active',source_type:'proxmox'},
  ],total:2,page:1,page_size:50}}));
  const released: string[] = [];
  await page.route('**/api/ipam/reservations/*', route => { released.push(route.request().url().split('/').pop()!); return route.fulfill({json:{success:true}}); });
  await page.goto('/networks/selection');
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    const synced = page.getByRole('checkbox', {name:'Select 10.20.1.11',exact:true});
    await synced.check();
    await expect(synced).toBeChecked();
    await expect(page.getByText(/selected addresses are managed/)).toBeVisible();
    await page.getByRole('button', {name:'Bulk actions',exact:true}).click();
    await expect(page.getByRole('menuitem', {name:'Release 0'})).toBeDisabled();
    await page.keyboard.press('Escape');
    const manual = page.getByRole('checkbox', {name:'Select 10.20.1.10',exact:true});
    await manual.check();
    await page.getByRole('button', {name:'Bulk actions',exact:true}).click();
    await expect(page.getByRole('menuitem', {name:'Release 1'})).toBeEnabled();
    await page.keyboard.press('Escape');
    await synced.uncheck(); await manual.uncheck();
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('checkbox', {name:'Select all visible address-space records'}).check();
  await page.getByRole('button', {name:'Bulk actions',exact:true}).click();
  await page.getByRole('menuitem', {name:'Release 1'}).click();
  await page.getByRole('dialog').getByRole('button', {name:'Release',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(released).toEqual(['manual']);
});
