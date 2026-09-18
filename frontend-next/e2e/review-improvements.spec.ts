import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/review-regressions');
async function signIn(page: Page) {
  await page.goto('/login');
  await page.evaluate(async () => {
    const credentials = {username: 'e2e-admin', password: 'E2e-password-2026!'};
    let response = await fetch('/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(credentials)});
    if (!response.ok) response = await fetch('/api/auth/setup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(credentials)});
    const data = await response.json();
    if (!response.ok || !data.token) throw new Error('Isolated review login failed');
    localStorage.setItem('shipyard_token', data.token);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Infrastructure', exact: true})).toBeVisible();
}
async function capture(page: Page, name: string) {
  fs.mkdirSync(shots, {recursive:true});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path:path.join(shots, `${name}.png`), fullPage:true, animations:'disabled'});
}

test('infrastructure home, host layout, themes and recovery are understandable', async ({page}) => {
  await page.setViewportSize({width:1280,height:800});
  await signIn(page);
  const host = await page.evaluate(async () => {
    const response = await fetch('/api/servers', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`},body:JSON.stringify({name:'hr01-edge-newt-admin01',hostname:'review-host',ip_address:'192.0.2.201'})});
    if(!response.ok) throw new Error('Could not create isolated review host');
    return response.json();
  });
  try {
    await page.goto('/');
    const hostEntry = page.locator('main').getByRole('link', {name:'hr01-edge-newt-admin01',exact:true});
    await expect(hostEntry).toBeVisible();
    await expect(hostEntry).toHaveAttribute('href', `/servers/${host.id}`);
    await expect(page.locator('main')).toContainText('192.0.2.201');
    await capture(page,'infrastructure-1280');
    await page.goto('/profile');
    await page.getByRole('button', {name: 'More themes'}).click();
    await page.getByRole('button', {name: 'Graphite theme, dark mode'}).click();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-console-theme', 'graphite-dark');
    await expect(hostEntry).toBeVisible();
    await capture(page,'infrastructure-dark-1280');
    await page.goto('/profile');
    await page.getByRole('button', {name: 'More themes'}).click();
    await page.getByRole('button', {name: 'Cloud theme, light mode'}).click();
    await page.goto('/servers');
    const hostLink=page.getByRole('link',{name:'hr01-edge-newt-admin01',exact:true});
    await expect(hostLink).toBeVisible();
    expect(await hostLink.evaluate(node=>node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight))).toBeLessThanOrEqual(2.1);
    await capture(page,'hosts-1280');
    await page.goto('/settings/notifications');await page.locator('summary').filter({hasText:'Notification events'}).click();
    await expect(page.getByText('Resource monitoring alerts are unavailable in this build.')).toHaveCount(0);
    await expect(page.getByRole('switch',{name:'Monitoring alerts'})).toHaveCount(0);
    await capture(page,'monitoring-status');
    await page.goto('/settings/backup');
    await expect(page.getByText('Shipyard application data. Infrastructure backups are managed externally.')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Encrypted database backup'})).toBeVisible();
    await capture(page,'backup-recovery');
    await page.goto(`/servers/${host.id}#tab=notes`);
    await expect(page.getByRole('button',{name:'Create host notes'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Save notes'})).toHaveCount(0);
    await capture(page,'empty-notes');
    await page.setViewportSize({width:390,height:844});
    await page.goto('/servers');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
    await capture(page,'hosts-mobile');
  } finally {
    await page.evaluate(async id=>{await fetch(`/api/servers/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`}});},host.id);
  }
});

test('execution results expose failing hosts and preserve multiline log context',async({page})=>{
 await signIn(page);
 await page.route('**/api/operations/workflow-review/details',route=>route.fulfill({json:{id:'workflow-review',execution_id:'review',source:'Workflow',name:'Review workflow',target:'2 hosts',target_detail:'media,edge',initiator:'Test',status:'failed',duration_seconds:3,summary:'',output:'TASK [Install]\nfatal: [edge]: FAILED! => {\n "msg": "package locked"\n}\nok: [media] => {}',host_results:[{name:'edge',server_id:null,status:'failed',ok:0,changed:0,failed:1,unreachable:0,duration_seconds:2},{name:'media',server_id:null,status:'success',ok:1,changed:1,failed:0,unreachable:0,duration_seconds:1}]}}));
 await page.goto('/operations/executions/workflow-review');
 await expect(page.getByRole('region',{name:'Host results'})).toBeVisible();
 await page.getByRole('row',{name:/edge Failed/}).getByRole('button',{name:'Filter log'}).click();
 const log=page.getByRole('region',{name:'Execution log'}).locator('pre');
 await expect(log).toContainText('package locked');
 await expect(log).toContainText('TASK [Install]');
 await expect(log).not.toContainText('[media]');
 await page.getByRole('textbox',{name:'Search execution log'}).fill('locked');
 await expect(log).toContainText('fatal: [edge]');
 await capture(page,'host-execution-results');
});

test('search ranks literal names, limits groups and highlights their matches',async({page})=>{
 await signIn(page);
 const hosts=Array.from({length:9},(_,i)=>({id:`search-${i}`,name:i===0?'media':`hr01-media-${i}`,status:'online',ip_address:`192.0.2.${i+1}`}));
 await page.route('**/api/servers?*',route=>route.fulfill({json:hosts}));
 await page.route('**/api/servers',route=>route.fulfill({json:hosts}));
 await page.route('**/api/opentofu/infrastructure-summary?*',route=>route.fulfill({json:{clusters:[{id:'review-platform',connections:[{name:'Production'}],nodes:[],vms:[{vm_id:101,name:'hr01-iot-ha',node_name:'pve'}]}]}}));
 await page.reload();
 await page.keyboard.press('Control+k');
 await page.getByRole('combobox').fill('media');
 await expect(page.getByRole('option',{name:/hr01-iot-ha/})).toHaveCount(0);
 await expect(page.getByRole('option',{name:/media/})).toHaveCount(5);
 await expect(page.locator('[cmdk-item] mark').first()).toHaveText('media');
 await page.getByRole('option',{name:'Show all 9 matching hosts'}).click();
 await expect(page.getByRole('option',{name:/media/})).toHaveCount(9);
 await capture(page,'search-ranked');
});

test('connection credentials and disabled TLS have separate status and edit action',async({page})=>{
 await signIn(page);
 await page.route('**/api/opentofu/proxmox-connections?*',route=>route.fulfill({json:[{id:'review',name:'Review platform',endpoint:'https://192.0.2.99:8006',api_token_configured:true,insecure:true,auto_sync:false}]}));
 await page.goto('/deployments');
 await page.getByRole('button',{name:'Platform connections'}).click();
 const dialog=page.getByRole('dialog',{name:'Platform connections'});
 await expect(dialog.getByRole('table').getByText('Token stored',{exact:true})).toBeVisible();
 const warning=dialog.getByRole('button',{name:'Certificate verification off'});
 await expect(warning).toBeVisible();
 await expect(warning).toHaveClass(/text-warning/);
 await capture(page,'tls-status');
 await warning.click();
 await expect(page.getByRole('dialog').last()).toContainText(/Edit|Update/);
});

test('secondary text remains readable on light and dark card surfaces',async({page})=>{
 await signIn(page);
 const ratios=await page.evaluate(()=>{
  const root=document.documentElement;
  const original=root.dataset.consoleTheme;
  const originalDark=root.classList.contains('dark');
  const luminance=(rgb:number[])=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
  return ['cloud-light','graphite-dark'].map(theme=>{
   root.dataset.consoleTheme=theme;root.classList.toggle('dark', theme.endsWith('-dark'));
   const probe=document.createElement('span');probe.textContent='Secondary data';probe.style.color='hsl(var(--muted-foreground))';probe.style.backgroundColor='hsl(var(--card))';root.append(probe);
   const styles=getComputedStyle(probe);
   const a=luminance(styles.color.match(/[\d.]+/g)!.map(Number));const b=luminance(styles.backgroundColor.match(/[\d.]+/g)!.map(Number));
   probe.remove();root.dataset.consoleTheme=original;root.classList.toggle('dark',originalDark);
   return {theme,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
  });
 });
 for(const result of ratios)expect(result.ratio,`${result.theme} secondary text contrast`).toBeGreaterThanOrEqual(4.5);
});


test('network search exposes later pages and metadata matches', async ({page}) => {
 await signIn(page);
 const results = Array.from({length:25}, (_,i) => ({id:`network-${i}`,kind:'prefix',label:`10.${i}.0.0/16`,secondary:'Production',subnet_id:`subnet-${i}`,subnet_cidr:`10.${i}.0.0/16`,description:'media archive'}));
 await page.route('**/api/ipam/search?*', route => {
  const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'));
  return route.fulfill({json:{items:results.slice((pageNumber-1)*20,pageNumber*20),page:pageNumber,total_pages:2,total:25}});
 });
 await page.keyboard.press('Control+k');
 await page.getByRole('combobox').fill('media');
 await expect(page.getByRole('option', {name:/10\.\d+\.0\.0\/16/})).toHaveCount(5);
 await expect(page.getByRole('option', {name:/10\.0\.0\.0\/16/})).toContainText('Match: media archive');
 await page.getByRole('option', {name:'Show 20 loaded network results'}).click();
 await expect(page.getByRole('option', {name:/10\.\d+\.0\.0\/16/})).toHaveCount(20);
 await page.getByRole('option', {name:'Load more networks (20 of 25)'}).click();
 await expect(page.getByRole('option', {name:/10\.\d+\.0\.0\/16/})).toHaveCount(25);
 await expect(page.getByRole('option', {name:/Load more networks/})).toHaveCount(0);
});

test('VM state and recovery points refresh when an apply finishes', async ({page}) => {
 await signIn(page);
 let finished=false;
 await page.route('**/api/opentofu/vms/review-state**',route=>{
  const pathname=new URL(route.request().url()).pathname;
  let json:unknown={id:'review-state',name:'Review state refresh',environment_id:'default',connection_id:'test',node_name:'pve',vm_id:105,cpu_cores:1,memory_mb:1024,disk_size_gb:40,bridge:'vmbr0',ipv4_address:'dhcp',started:false};
  if(pathname.endsWith('/runs')) json={items:[{id:'review-apply',action:'apply',status:finished?'success':'running'}]};
  else if(pathname.endsWith('/state')) json=finished?{resources:[{address:'proxmox_virtual_environment_vm.review',type:'proxmox_virtual_environment_vm',name:'review'}]}:{resources:[],error:'No state file was found'};
  else if(pathname.endsWith('/live')) json={available:false,reason:'Test VM stopped'};
  else if(pathname.endsWith('/actual')) json={actual:{resources:[]}};
  else if(pathname.endsWith('/state-safety')) json={mode:'encrypted-backup',backend:'local'};
  else if(pathname.endsWith('/state-backups')) json={items:finished?[{name:'after-apply.tfstate.enc',created_at:'2026-09-15T20:00:00Z',size:100}]:[]};
  return route.fulfill({json});
 });
 await page.goto('/deployments/review-state#definitionTab=configuration');
 await page.locator('summary').filter({hasText:/^Advanced$/}).click();
 await expect(page.getByText('No state file was found',{exact:true})).toBeVisible();
 finished=true;
 await expect(page.getByText('No state file was found',{exact:true})).toHaveCount(0,{timeout:10000});
 await expect(page.getByText('Independent state',{exact:true})).toBeVisible();
 await page.getByText('Recovery options',{exact:true}).click();await expect(page.getByRole('combobox',{name:'Recovery point'}).locator('option')).toHaveCount(2);
});
