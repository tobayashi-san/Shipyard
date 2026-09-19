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

test('hosts are the home page with five fixed destinations and no platform polling', async ({page}) => {
  await login(page); await inventory(page);
  let platformRequests = 0;
  page.on('request', request => { if (/\/api\/opentofu\/infrastructure/.test(request.url())) platformRequests++; });
  await page.route('**/api/servers?*', route => route.fulfill({json:[{id:'host01',name:'app01',ip_address:'192.0.2.1',status:'online',last_seen:'2026-09-19 12:00:00'}]}));
  await page.goto('/');
  await expect(page).toHaveURL(/\/servers$/);
  await expect(page.locator('main').getByRole('heading',{name:'Hosts',exact:true})).toBeVisible();
  await expect(page.locator('main').getByRole('columnheader')).toHaveText(['Name','Address','Connection','Last successful check','Group']);
  await expect(page.locator('main').getByRole('link',{name:'app01',exact:true})).toBeVisible();
  expect(platformRequests).toBe(0);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    if (width < 1024) await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    const nav = page.getByRole('navigation',{name:'Main navigation'});
    for (const name of ['Hosts','Deployments','Automations','Networks','Jobs']) await expect(nav.getByRole('link',{name,exact:true})).toBeVisible();
    if (width < 1024) await page.getByRole('button',{name:'Close navigation',exact:true}).last().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:path.join(shots, `hosts-${width}.png`),fullPage:true,animations:'disabled'});
  }
  await page.getByRole('button',{name:'Add host',exact:true}).click();
  await page.getByRole('button',{name:'Import from Proxmox',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Import from Proxmox'}).getByRole('button',{name:/vm-app01/})).toBeVisible();
  expect(platformRequests).toBeGreaterThan(0);
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


test('deployment details stay separate from host details and expose a draft action', async ({page}) => {
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
  await page.goto('/deployments/definition01');
  await expect(page).toHaveURL(/\/deployments\/definition01$/);
  await expect(page.locator('main').getByRole('heading',{name:'vm-app01',exact:true})).toBeVisible();
  await expect(page.getByText('Draft — not deployed',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create plan',exact:true})).toBeVisible();
  await page.locator('main').getByRole('tab',{name:'Jobs',exact:true}).click();
  await expect(page.locator('main').getByRole('button',{name:'View logs',exact:true})).toBeVisible();
  await page.screenshot({path:path.join(shots, 'unified-vm-configuration.png'),fullPage:true,animations:'disabled'});
});

test('a host shows host facts and snapshots without VM hardware or inventory requests', async ({page}) => {
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
    let inventoryRequests = 0;
    page.on('request', request => { if (request.url().includes('/api/opentofu/infrastructure?')) inventoryRequests++; });
    await page.goto(`/servers/${host.id}`);
    await expect(page.getByRole('heading',{name:'pve01-canonical',exact:true})).toBeVisible();
    await expect(page.getByRole('tablist',{name:'Host sections'}).getByRole('tab')).toHaveText(['Overview','Snapshots','Jobs','Settings','Updates','Notes','Advanced']);
    await expect(page.getByText('Recent capacity',{exact:true})).toHaveCount(0);
    await expect(page.getByText('Virtual machines',{exact:true})).toHaveCount(0);
    await page.getByRole('tab',{name:'Snapshots',exact:true}).click();
    await expect(page.getByText('Snapshots are available for hosts linked to a Proxmox guest.')).toBeVisible();
    expect(inventoryRequests).toBe(0);
    await page.setViewportSize({width:390,height:844});
    const advanced = page.getByRole('tab',{name:'Advanced',exact:true});
    await advanced.scrollIntoViewIfNeeded();
    await advanced.click();
    await expect(advanced).toHaveAttribute('data-state','active');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({path:path.join(shots,'host-tabs-mobile.png'),fullPage:true,animations:'disabled'});

  } finally {
    await page.evaluate(async id => { await fetch(`/api/servers/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`}}); },host.id);
  }
});

test('a host-only role can open the new home without requesting restricted platform data', async ({page}) => {
  await page.route('**/api/servers?*', route => route.fulfill({json: []}));
  await login(page);
  await page.route('**/api/auth/profile', async route => {
    const response = await route.fetch();
    const profile = await response.json();
    await route.fulfill({json:{...profile,role:'viewer',permissions:{canViewServers:true,servers:'all'}}});
  });
  const restricted: string[] = [];
  page.on('request', request => {if (request.url().includes('/api/opentofu/')) restricted.push(request.url());});
  await page.goto('/');
  await expect(page).toHaveURL(/\/servers$/);
  await expect(page.getByRole('heading',{name:'Hosts',exact:true})).toBeVisible();
  await expect(page.getByText('Add a host to get started.',{exact:true})).toBeVisible();
  expect(restricted).toEqual([]);
});

test('drafts appear in Deployments and never in the host list', async ({page}) => {
  await login(page); await inventory(page);
  await page.route('**/api/opentofu/vms?*', route => route.fulfill({json:[{id:'draft01',name:'vm-draft01',node_name:'pve01',platform:{endpoint:'https://pve.example'}}]}));
  await page.goto('/servers');
  await expect(page.getByText('vm-draft01',{exact:true})).toHaveCount(0);
  await page.goto('/deployments');
  await expect(page.getByRole('row',{name:'Open vm-draft01',exact:true})).toContainText('Draft');
});

test('deployment completion retries connection without another apply and opens the ready host', async ({page}) => {
  await login(page);
  let resumed = false;
  let applyRequests = 0;
  let resumeRequests = 0;
  await page.route('**/api/opentofu/vms/retry-vm**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/apply')) applyRequests++;
    if (path.endsWith('/resume')) { resumed = true; resumeRequests++; return route.fulfill({json:{status:'started',dbRunId:'retry-run'}}); }
    const deployment = {id:'retry-run',action:'apply',status:resumed?'success':'failed',deployment_phase:resumed?'ready':'connect_host',vm_provisioned:1};
    const json = path.endsWith('/runs') ? {items:[deployment]} : path.endsWith('/retry-vm') ? {id:'retry-vm',name:'app-retry',host_id:'ready-host',environment_id:'default',connection_id:'pve',node_name:'pve01',vm_id:123,started:true,cpu_cores:2,memory_mb:4096,disk_size_gb:40,bridge:'vmbr0',ipv4_address:'dhcp',deployment} : path.endsWith('/live') ? {available:true,node_name:'pve01',vm_id:123,cpu_cores:2,memory_mb:4096,disk_size_gb:40,bridge:'vmbr0',ipv4_address:'192.0.2.123'} : {};
    return route.fulfill({json});
  });
  await page.goto('/deployments/retry-vm');
  await expect(page.getByText('VM created · host connection incomplete',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'View failure log',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Retry deployment completion',exact:true}).click();
  await expect(page.getByRole('link',{name:'Open host',exact:true})).toHaveAttribute('href','/servers/ready-host');
  await expect(page.getByText('Ready',{exact:true})).toBeVisible();
  expect(resumeRequests).toBe(1);
  expect(applyRequests).toBe(0);
  await page.screenshot({path:path.join(shots,'deployment-ready.png'),fullPage:true,animations:'disabled'});
});

test('VM ID conflicts and automatic IPAM network selection', async ({page}) => {
  await login(page); await inventory(page);
  await page.route('**/api/opentofu/proxmox-connections/pve/vm-catalog*', route => route.fulfill({json:{ssh_public_key_configured:true,node:'pve01',nodes:[{name:'pve01'},{name:'pve02'}],next_vm_id:201,templates:[{name:'Ubuntu',vm_id:9000}],datastores:[{id:'local-lvm'}],bridges:[{name:'vmbr0',source:'node',available_on_node:true},{name:'apps',alias:'Applications',zone:'prod',source:'sdn',available_on_node:!route.request().url().includes('pve02')},{name:'other',source:'sdn',available_on_node:false}]}}));
  await page.route('**/api/opentofu/proxmox-connections/pve/vm-id-check?*', route => route.fulfill({json:{available:new URL(route.request().url()).searchParams.get('id') !== '101',occupied:[]}}));
  await page.route('**/api/ipam/subnets*', route => route.fulfill({json:[{id:'mapped',name:'Application network',cidr:'10.1.0.0/24',environment_id:'default',status:'active',bridge:'apps',proxmox_connection_id:'pve'},{id:'unmapped',name:'Unmapped network',cidr:'10.2.0.0/24',environment_id:'default',status:'active',bridge:'vmbr0'}]}));
  await page.goto('/deployments');
  await page.getByRole('button',{name:'Create VM',exact:true}).first().click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton',{name:'Target VM ID'}).fill('101');
  await expect(dialog.getByText('This VM ID is occupied. Choose a free ID.')).toBeVisible();
  await dialog.getByRole('spinbutton',{name:'Target VM ID'}).fill('201');
  await expect(dialog.getByText('VM ID is available. It will be checked again before deployment.')).toBeVisible();
  await page.getByRole('navigation',{name:'VM setup steps'}).getByRole('button').nth(2).click();
  await dialog.getByLabel('IPAM prefix').selectOption('mapped');
  const bridge = dialog.getByRole('combobox',{name:'Bridge / SDN VNet',exact:true});
  await expect(bridge).toHaveValue('apps');
  await expect(dialog.locator('optgroup[label="SDN VNets"] option[value="other"]')).toBeDisabled();
  await dialog.getByRole('textbox',{name:'Search bridges and VNets'}).fill('Applications');
  await expect(dialog.locator('optgroup[label="SDN VNets"] option[value="apps"]')).toHaveCount(1);
  await dialog.getByRole('textbox',{name:'Search bridges and VNets'}).fill('');
  await page.screenshot({path:path.join(shots,'vm-network-mapping.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('navigation',{name:'VM setup steps'}).getByRole('button').nth(0).click();
  await dialog.getByRole('combobox',{name:'Proxmox node',exact:true}).selectOption('pve02');
  await page.getByRole('navigation',{name:'VM setup steps'}).getByRole('button').nth(2).click();
  await expect(dialog.getByText('The selected bridge or VNet is unavailable on this node. Select another network.')).toBeVisible();
  await dialog.getByLabel('IPAM prefix').selectOption('unmapped');
  await expect(bridge).toHaveValue('');
  await expect(dialog.getByText(/no unique, available mapping/)).toBeVisible();
});
