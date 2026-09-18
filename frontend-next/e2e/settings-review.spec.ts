import {test,expect,type Page} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const shots=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../test-results/settings-regressions');
async function signIn(page:Page){
 await page.goto('/login');
 await page.evaluate(async()=>{const credentials={username:'e2e-admin',password:'E2e-password-2026!'};let response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});if(!response.ok)response=await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});const result=await response.json();if(!result.token)throw new Error('Isolated login failed');localStorage.setItem('shipyard_token',result.token);});
 await page.goto('/settings');
}
async function api(page:Page,url:string,body?:unknown,method=body?'PUT':'GET'){
 return page.evaluate(async({url,body,method})=>{const response=await fetch(`/api${url}`,{method,headers:{Authorization:`Bearer ${localStorage.getItem('shipyard_token')}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error(`${url}: ${response.status}`);return response.json();},{url,body,method});
}
async function shot(page:Page,name:string){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,`${name}.png`),fullPage:true,animations:'disabled'});}

test('SSH manual setup stays collapsed and agent endpoints are retired',async({page})=>{
 await signIn(page);await page.goto('/settings/ssh');
 const manual=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Advanced: manual SSH setup and recovery'})}).last();
 await expect(manual).not.toHaveAttribute('open','');
 await manual.locator('summary').first().click();await expect(manual).toHaveAttribute('open','');
 const status=await page.evaluate(async()=> (await fetch('/api/v1/agent/report',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status);
 expect(status).toBe(410);await shot(page,'ssh-manual-recovery');
});

test('settings drafts, explicit SMTP modes, application data and personal navigation',async({page})=>{
 await signIn(page);await page.goto('/settings/notifications');await page.locator('summary').filter({hasText:'Notification events'}).click();
 const events=page.getByRole('switch',{name:'Playbook failures',exact:true});await expect(events).toBeVisible();const saved=await api(page,'/system/settings');await events.click();expect((await api(page,'/system/settings')).notifPlaybookFailed).toBe(saved.notifPlaybookFailed);
 await page.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(events).toHaveAttribute('aria-checked',String(saved.notifPlaybookFailed));
 await events.click();await page.getByRole('button',{name:'Save notification preferences'}).click();await expect(page.getByRole('button',{name:'Save notification preferences'})).toBeDisabled();expect((await api(page,'/system/settings')).notifPlaybookFailed).toBe(!saved.notifPlaybookFailed);
 await page.locator('summary').filter({hasText:'Email (SMTP)'}).click();await page.getByRole('combobox',{name:'SMTP transport',exact:true}).selectOption('starttls');await page.getByRole('textbox',{name:'SMTP Host',exact:true}).fill('smtp.example.invalid');await page.getByRole('button',{name:'Save email settings'}).click();await expect(page.getByRole('button',{name:'Save email settings'})).toBeDisabled();expect((await api(page,'/system/settings')).smtpSecurity).toBe('starttls');
 await shot(page,'notifications-desktop');
 await page.goto('/settings/appearance');await expect(page.getByRole('switch',{name:'Show VM IDs in infrastructure tree'})).toHaveCount(0);await page.goto('/profile');await expect(page.getByRole('switch',{name:'Show VM IDs in infrastructure tree'})).toBeVisible();
 await page.goto('/settings/backup');await expect(page.getByText('Record an external backup or recovery test',{exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Encrypted database backup'})).toBeVisible();await shot(page,'application-data-desktop');
 await page.setViewportSize({width:390,height:844});await page.goto('/settings/notifications');await page.locator('summary').filter({hasText:'Email (SMTP)'}).click();await expect(page.getByRole('combobox',{name:'SMTP transport',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);await shot(page,'notifications-mobile');await page.goto('/settings/backup');await expect(page.getByRole('heading',{name:'Encrypted database backup',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);await shot(page,'recovery-mobile');
});

test('settings structure retains direct routes and separates playbook Git work',async({page})=>{
 await signIn(page);await expect(page.getByRole('navigation',{name:'Settings',exact:true}).getByRole('link')).toHaveText(['General','Access','Connections','Advanced']);await expect(page.getByRole('link',{name:'Danger Zone',exact:true})).toHaveCount(0);
 await page.goto('/settings/danger');await expect(page.getByRole('button',{name:'Reset hosts, schedules, accounts and user playbooks',exact:true})).toBeVisible();
 await page.route('**/api/opentofu/status',route=>route.fulfill({json:{installed:true,version:'1.12.6',binary:'/isolated/bin/tofu',installing:false}}));await page.route('**/api/opentofu/releases',route=>route.fulfill({json:{releases:['1.13.0','1.12.6','1.9.0']}}));
 await page.goto('/settings/collection');await page.getByText('Advanced: version management',{exact:true}).click();await expect(page.getByRole('combobox',{name:'Available version',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Available version',exact:true}).selectOption('1.9.0');await expect(page.getByRole('button',{name:'Downgrade OpenTofu',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Available version',exact:true}).selectOption('1.12.6');await expect(page.getByRole('button',{name:'Reinstall OpenTofu',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Available version',exact:true}).selectOption('1.13.0');await expect(page.getByRole('button',{name:'Upgrade OpenTofu',exact:true})).toBeVisible();await shot(page,'system-desktop');
 await page.goto('/playbooks#tab=git');await expect(page).toHaveURL(/#tab=git$/);await expect(page.getByRole('link',{name:'Playbook Git settings',exact:true})).toBeVisible();
 await page.goto('/settings');await expect(page.getByRole('link',{name:'Plugins',exact:true})).toHaveCount(0);
 for(const tab of ['appearance','ssh','users-roles','git','collection']){await page.goto(`/settings/${tab}`);await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();await shot(page,`${tab}-desktop`);}
});
