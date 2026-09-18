import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.evaluate(async () => {
    const body = JSON.stringify({username:'e2e-admin', password:'E2e-password-2026!'});
    let response = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body});
    if (!response.ok) response = await fetch('/api/auth/setup', {method:'POST', headers:{'Content-Type':'application/json'}, body});
    const data = await response.json();
    if (!data.token) throw new Error('Isolated login failed');
    localStorage.setItem('shipyard_token', data.token);
  });
}
const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-results');
const cluster = {id:'https://pve.example', endpoint:'https://pve.example', status:'online', connections:[{id:'pve', name:'Platform'}], nodes:[{name:'pve01', status:'online', cpu:0.2, maxcpu:8, mem:1024, maxmem:8192}], vms:[{name:'vm-app01',node_name:'pve01',vm_id:101,status:'running',mem:1024,maxmem:4096}], datastores:[]};
async function inventory(page: Page) {
  await page.route('**/api/opentofu/infrastructure?*', route => route.fulfill({json:{clusters:[cluster]}}));
  await page.route('**/api/opentofu/infrastructure-summary?*', route => route.fulfill({json:{clusters:[cluster]}}));
  await page.route('**/api/opentofu/vms?*', route => route.fulfill({json:[]}));
  await page.route('**/api/opentofu/proxmox-connections?*', route => route.fulfill({json:[{id:'pve', name:'Platform', endpoint:'https://pve.example', environment_id:'default'}]}));
  await page.route('**/api/opentofu/proxmox-connections/pve/vm-catalog*', route => route.fulfill({json:{nodes:[{name:'pve01'}], templates:[], datastores:[], bridges:[]}}));
}

test('fixed navigation, host hierarchy and contextual creation work on desktop and mobile', async ({page}) => {
  await login(page); await inventory(page); await page.goto('/');
  await expect(page).toHaveURL(/\/infrastructure$/);
  const main = page.locator('main');
  await expect(main.getByRole('heading', {name:'Infrastructure', exact:true})).toBeVisible();
  await expect(main.getByRole('link', {name:'vm-app01',exact:true})).toBeHidden();
  await main.locator('summary').filter({hasText:'1 virtual machine'}).click();
  await expect(main.getByRole('link',{name:'vm-app01',exact:true})).toBeVisible();
  await main.getByRole('button',{name:'Create VM',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', {name:/node/i}).first()).toHaveValue('pve01');
  await page.keyboard.press('Escape');
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    if (width < 1024) await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    const nav = page.getByRole('navigation',{name:'Main navigation'});
    for (const name of ['Infrastructure','Automations','Networks','Jobs']) await expect(nav.getByRole('link',{name,exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Operations',exact:true})).toHaveCount(0);
    if (width < 1024) await page.getByRole('button',{name:'Close navigation',exact:true}).last().click();
    await expect(page.getByRole('combobox',{name:'Environment',exact:true})).toBeVisible({visible:width < 1024});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:path.join(shots, `unified-infrastructure-${width}.png`),fullPage:true,animations:'disabled'});
  }
});

test('settings have four groups and preserve legacy entry points', async ({page}) => {
  await login(page); await page.goto('/settings');
  const nav = page.getByRole('navigation',{name:'Settings',exact:true});
  await expect(nav.getByRole('link')).toHaveText(['General','Access','Connections','Advanced']);
  await nav.getByRole('link',{name:'Advanced',exact:true}).click();
  await expect(page.locator('summary').filter({hasText:'Adaptive collection'})).toBeVisible();
  await expect(page.locator('main').getByText('Save polling settings',{exact:true})).toBeHidden();
  await page.goto('/settings/collection');
  await expect(page.locator('main').getByText('Save polling settings',{exact:true})).toBeVisible();
  await page.screenshot({path:path.join(shots, 'unified-settings.png'),fullPage:true,animations:'disabled'});
});

test('automation selections transfer to scheduling without executing a playbook', async ({page}) => {
  await login(page);
  await page.route('**/api/playbooks', route => route.fulfill({json:[{filename:'deploy.yml',description:'Deploy application'}]}));
  await page.route('**/api/servers?*', route => route.fulfill({json:[{id:'host01',name:'app01',environment_id:'default',status:'online',ip_address:'192.0.2.1'},{id:'host02',name:'app02',environment_id:'default',status:'online',ip_address:'192.0.2.2'}]}));
  await page.goto('/playbooks');
  await page.getByLabel('1. Choose action').selectOption('deploy.yml');
  await page.locator('label').filter({hasText:'app01'}).getByRole('checkbox').check();
  await page.locator('label').filter({hasText:'app02'}).getByRole('checkbox').check();
  await page.locator('summary').filter({hasText:'Variables and execution options'}).click();
  await page.getByRole('button',{name:'Add variable',exact:true}).click();
  await page.getByRole('textbox',{name:'Variable 1 key',exact:true}).fill('retries');
  await page.getByRole('combobox',{name:'Variable 1 type',exact:true}).selectOption('number');
  await page.getByRole('textbox',{name:'Variable 1 value',exact:true}).fill('3');
  await page.getByRole('button',{name:'Schedule',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Playbook',{exact:true})).toHaveValue('deploy.yml');
  await expect(dialog.locator('label').filter({hasText:'app01'}).getByRole('checkbox')).toBeChecked();
  await expect(dialog.locator('label').filter({hasText:'app02'}).getByRole('checkbox')).toBeChecked();
  await dialog.locator('summary').filter({hasText:'Variables and execution options'}).click();
  expect(JSON.parse(await dialog.getByLabel('Extra variables', {exact:false}).inputValue())).toEqual({retries:3});
  await page.screenshot({path:path.join(shots, 'unified-automation-schedule.png'),fullPage:true,animations:'disabled'});
});


test('VM configuration deep links include the deployment definition and jobs', async ({page}) => {
  await login(page); await inventory(page);
  await page.route('**/api/opentofu/proxmox-connections/pve/vms/pve01/101/context', route => route.fulfill({json:{deployments:[{definition_id:'definition01',workspace_id:'workspace01',workspace_name:'Application',vm_name:'vm-app01'}]}}));
  await page.route('**/api/opentofu/proxmox-connections/pve/vms/pve01/101/configuration', route => route.fulfill({json:{hardware:{cores:2,memory_mb:4096},networks:[],disks:[]}}));
  await page.route('**/api/opentofu/proxmox-connections/pve/vms/pve01/101/tasks?*', route => route.fulfill({json:{tasks:[],total:0,offset:0,limit:20}}));
  await page.route('**/api/opentofu/proxmox-connections/pve/vms/pve01/101/audit?*', route => route.fulfill({json:{events:[],total:0}}));
  await page.route('**/api/opentofu/vms/definition01', route => route.fulfill({json:{id:'definition01',name:'vm-app01',environment_id:'default',connection_id:'pve',node_name:'pve01',vm_id:101,cpu_cores:2,memory_mb:4096,disk_size_gb:40,bridge:'vmbr0',ipv4_address:'dhcp',platform:{endpoint:'https://pve.example',name:'Platform'}}}));
  await page.route('**/api/opentofu/vms/definition01/*', route => {
    const suffix = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({json:suffix === 'runs' ? {items:[{id:'run01',action:'plan',status:'success'}]} : suffix === 'live' ? {available:true,node_name:'pve01',vm_id:101,cpu_cores:2,memory_mb:4096} : {}});
  });
  await page.goto('/infrastructure/https%3A%2F%2Fpve.example/nodes/pve01/vms/101#tab=configuration');
  await expect(page.locator('main').getByRole('heading',{name:'Deployment definition',exact:true})).toBeVisible();
  await expect(page.locator('main').getByRole('tab')).toHaveText(['Overview','Configuration','Jobs']);
  await page.locator('main').getByRole('tab',{name:'Jobs',exact:true}).click();
  await expect(page.locator('main').getByRole('button',{name:'View logs',exact:true})).toBeVisible();
  await page.goto('/deployments/definition01');
  await expect(page).toHaveURL(/infrastructure.*101#tab=configuration/);
  await expect(page.locator('main').getByRole('heading',{name:'Deployment definition',exact:true})).toBeVisible();
  await page.screenshot({path:path.join(shots, 'unified-vm-configuration.png'),fullPage:true,animations:'disabled'});
});

test('an adopted Proxmox node has one host page and retains advanced node functions', async ({page}) => {
  await login(page);
  const host = await page.evaluate(async () => {
    const response = await fetch('/api/servers', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`},body:JSON.stringify({name:'pve01-canonical',hostname:'pve.example',ip_address:'192.0.2.20'})});
    if (!response.ok) throw new Error('Could not create isolated host');
    return response.json();
  });
  try {
    await inventory(page);
    const adopted = {...cluster,nodes:[{...cluster.nodes[0],fleet_server_id:host.id}]};
    await page.route('**/api/opentofu/infrastructure?*', route => route.fulfill({json:{clusters:[adopted]}}));
    await page.route('**/api/opentofu/proxmox-connections/pve/audit?*', route => route.fulfill({json:{events:[],total:0,offset:0,limit:20}}));
    await page.goto('/infrastructure/https%3A%2F%2Fpve.example/nodes/pve01');
    await expect(page).toHaveURL(new RegExp(`/servers/${host.id}#tab=overview$`));
    await expect(page.getByRole('heading',{name:'pve01-canonical',exact:true})).toBeVisible();
    await expect(page.locator('main').getByRole('tab')).toHaveText(['Overview','Configuration','Jobs']);
    await page.getByRole('button',{name:'More host sections',exact:true}).click();
    await page.getByRole('menuitem',{name:'Advanced · Proxmox node',exact:true}).click();
    await page.getByRole('tablist',{name:'Node sections',exact:true}).getByRole('tab',{name:'Configuration',exact:true}).click();
    await expect(page).toHaveURL(/#tab=node&nodeTab=configuration$/);
    await page.reload();
    await expect(page.getByRole('tablist',{name:'Node sections',exact:true}).getByRole('tab',{name:'Configuration',exact:true})).toHaveAttribute('data-state','active');
  } finally {
    await page.evaluate(async id => { await fetch(`/api/servers/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`}}); },host.id);
  }
});

test('a host-only role can open the new home without requesting restricted platform data', async ({page}) => {
  await login(page);
  await page.route('**/api/auth/profile', async route => {
    const response = await route.fetch();
    const profile = await response.json();
    await route.fulfill({json:{...profile,role:'viewer',permissions:{canViewServers:true,servers:'all'}}});
  });
  const restricted: string[] = [];
  page.on('request', request => {if (request.url().includes('/api/opentofu/')) restricted.push(request.url());});
  await page.goto('/');
  await expect(page).toHaveURL(/\/infrastructure$/);
  await expect(page.getByRole('heading',{name:'Infrastructure',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'No infrastructure connected yet'})).toBeVisible();
  expect(restricted).toEqual([]);
});

test('saved VM definitions appear beneath their host before deployment', async ({page}) => {
  await login(page); await inventory(page);
  await page.route('**/api/opentofu/vms?*', route => route.fulfill({json:[{id:'draft01',name:'vm-draft01',node_name:'pve01',platform:{endpoint:'https://pve.example'}}]}));
  await page.goto('/infrastructure');
  await page.locator('main summary').filter({hasText:'2 virtual machines'}).click();
  const draft = page.locator('main').getByRole('link',{name:'vm-draft01 Defined',exact:true});
  await expect(draft).toBeVisible();
  await expect(draft).toHaveAttribute('href','/deployments/draft01');
  await expect(page.getByText('VM definitions without host inventory',{exact:true})).toBeHidden();
});
