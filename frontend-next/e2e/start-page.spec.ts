import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
async function login(page:Page) {
  await page.goto('/login');
  await page.evaluate(async()=>{
    const body=JSON.stringify({username:'e2e-admin',password:'E2e-password-2026!'});
    let result=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!result.ok) result=await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body});
    localStorage.setItem('fleet_token',(await result.json()).token);
  });
}
async function fixture(page:Page) {
  await page.route('**/api/servers?*',route=>route.fulfill({json:Array.from({length:8},(_,i)=>({id:`host${i}`,name:`Host ${i}`,status:i<2?'online':'offline',ip_address:`192.0.2.${i+1}`,updates_count:i===0?3:0,image_updates_count:i===0?1:0,reboot_required:i===1}))}));
  await page.route('**/api/opentofu/vms?*',route=>route.fulfill({json:[{id:'vm1',name:'Application',last_run:{status:'success'},deployment:{status:'failed',deployment_phase:'connect_host'}}]}));
  await page.route('**/api/operations?*',route=>{
    const scope=new URL(route.request().url()).searchParams.get('scope');
    const items=Array.from({length:scope==='active'?1:5},(_,i)=>({id:`${scope}-${i}`,name:scope==='active'?'Deploying VM':`Job ${i}`,source:scope==='active'?'Deployment':'Host',target:`Host ${i}`,status:scope==='active'?'running':scope==='failed'?'failed':'success',time:'2026-09-19T12:00:00Z',href:scope==='active'?'/deployments/$id':'/servers/$id',params:{id:scope==='active'?'vm2':`host${i}`}}));
    return route.fulfill({json:{items,total:items.length}});
  });
  await page.route('**/api/schedules?*',route=>route.fulfill({json:[{id:'schedule1',name:'Nightly updates',enabled:true,cron_expression:'0 23 * * *',playbook:'updates.yml',target_type:'all',target_id:null,next_run:new Date(Date.now()+3600000).toISOString()}]}));
}
test('start is compact, links to objects and jobs, and never requests live infrastructure',async({page})=>{
  await login(page); await fixture(page);
  const forbidden:string[]=[];
  page.on('request',request=>{if(/\/api\/opentofu\/(infrastructure|.*\/live|.*\/catalog)|\/api\/servers\/[^/]+\/(info|test)/.test(request.url())) forbidden.push(request.url());});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Start',exact:true})).toBeVisible();
  await expect(page.getByText('8 hosts · 2 connected · 6 unreachable')).toBeVisible();
  const attention=page.getByRole('region',{name:'Needs attention'});
  await expect(attention.getByRole('listitem')).toHaveCount(5);
  await expect(attention.getByRole('link',{name:'Open deployment'})).toHaveAttribute('href','/deployments/vm1');
  await expect(attention.getByText('1 host has updates',{exact:true})).toBeVisible();
  await expect(attention.getByText('4 updates waiting',{exact:false})).toBeVisible();
  await expect(attention.getByText('1 host needs a reboot',{exact:true})).toBeVisible();
  const current=page.getByRole('region',{name:'Current & upcoming'});
  await expect(current.getByText('Nightly updates')).toBeVisible();
  await expect(current.getByRole('link',{name:'Open deployment'})).toHaveAttribute('href','/deployments/vm2');
  await expect(current.getByRole('link',{name:'Open automation'})).toHaveAttribute('href',/schedule=schedule1/);
  await expect(page.getByRole('region',{name:'Last 7 days'})).toContainText('5 jobs · none failed');
  await expect(page.getByRole('region',{name:'Last 7 days'}).getByRole('link',{name:'All jobs'})).toHaveAttribute('href',/operations\?from=/);
  await expect(page.getByRole('region',{name:'Quick access'})).toHaveCount(0);
  await expect(page.locator('main table')).toHaveCount(0);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
    await page.screenshot({path:path.join(process.env.FLEET_E2E_ARTIFACT_DIR!, `start-${width}.png`),fullPage:true,animations:'disabled'});
  }
  expect(forbidden).toEqual([]);
});
test('start presents fetch failures without claiming everything is healthy',async({page})=>{
  await login(page);await fixture(page);
  await page.route('**/api/servers?*',route=>route.fulfill({status:503,json:{error:'Stored host status unavailable'}}));
  await page.goto('/');
  await expect(page.getByText('Hosts could not be loaded')).toBeVisible();
  await expect(page.getByText('Add your first host.')).toHaveCount(0);
  await expect(page.getByText('Nothing needs your attention.')).toHaveCount(0);
});
test('empty start provides an add-host action and opens the form',async({page})=>{
  await login(page);await fixture(page);
  await page.route('**/api/servers?*',route=>route.fulfill({json:[]}));
  await page.route('**/api/opentofu/vms?*',route=>route.fulfill({json:[]}));
  await page.route('**/api/schedules?*',route=>route.fulfill({json:[]}));
  await page.route('**/api/operations?*',route=>route.fulfill({json:{items:[],total:0}}));
  await page.goto('/');
  await expect(page.getByText('Add your first host.')).toBeVisible();
  await expect(page.getByRole('region',{name:'Needs attention'})).toHaveCount(0);
  await page.getByRole('button',{name:'Add host',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('switching environment replaces home data without showing the previous hosts',async({page})=>{
  await login(page);await fixture(page);
  await page.route('**/api/environments',route=>route.fulfill({json:[{id:'default',name:'Production'},{id:'lab',name:'Lab'}]}));
  await page.route('**/api/servers?*',route=>route.fulfill({json:route.request().headers()['x-fleet-environment']==='lab'?[{id:'lab-host',name:'Lab host',status:'offline'}]:[{id:'prod-host',name:'Production host',status:'offline'}]}));
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('region',{name:'Needs attention'}).getByText('Production host')).toBeVisible();
  await page.getByRole('combobox',{name:'Environment',exact:true}).selectOption('lab');
  await expect(page.getByRole('region',{name:'Needs attention'}).getByText('Lab host')).toBeVisible();
  await expect(page.getByText('Production host',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Environment: Lab',{exact:true})).toBeVisible();
});

test('a schedule-only role opens its automation without requesting playbooks or hosts',async({page})=>{
  await login(page);await fixture(page);
  await page.route('**/api/auth/profile',async route=>{const response=await route.fetch();const profile=await response.json();await route.fulfill({json:{...profile,role:'viewer',permissions:{canViewSchedules:true,servers:'all',playbooks:'all'}}});});
  const denied:string[]=[];
  page.on('request',request=>{if(/\/api\/(servers|opentofu|playbooks|ansible-vars)(?:[/?]|$)/.test(request.url())) denied.push(request.url());});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Create VM',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Add host',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Open automation',exact:true}).click();
  await expect(page.locator('#schedule-schedule1')).toHaveAttribute('aria-current','true');
  await expect(page.getByRole('tab',{name:'Playbooks',exact:true})).toHaveCount(0);
  expect(denied).toEqual([]);
});
