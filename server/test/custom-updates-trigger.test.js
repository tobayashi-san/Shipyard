'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(os.tmpdir(), `lab_test_custom_updates_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-jwt-secret-custom-updates';
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const scheduler = require('../services/scheduler');
const sshManager = require('../services/ssh-manager');

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch {}
  }
});

test('trigger custom update task marks update when command output matches trigger output exactly', async () => {
  const server = db.servers.create({ name: 'truenas', hostname: 'truenas.local', ip_address: '10.0.0.70' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'TrueNAS',
    type: 'trigger',
    check_command: 'midclt call update.check_available',
    trigger_output: 'AVAILABLE',
    update_command: '',
  });

  const original = sshManager.execCommand;
  sshManager.execCommand = async () => ({ code: 0, stdout: 'AVAILABLE\n' });
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = original;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, 'AVAILABLE');
  assert.equal(updated.last_version, 'AVAILABLE');
  assert.equal(updated.has_update, 1);
});

test('trigger custom update task stays clear when output does not match trigger output', async () => {
  const server = db.servers.create({ name: 'truenas-2', hostname: 'truenas-2.local', ip_address: '10.0.0.71' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'TrueNAS',
    type: 'trigger',
    check_command: 'midclt call update.check_available',
    trigger_output: 'AVAILABLE',
    update_command: '',
  });

  const original = sshManager.execCommand;
  sshManager.execCommand = async () => ({ code: 0, stdout: 'UNAVAILABLE\n' });
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = original;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, 'UNAVAILABLE');
  assert.equal(updated.last_version, 'AVAILABLE');
  assert.equal(updated.has_update, 0);
});

test('script custom update task compares an SSH-derived desired and installed version', async () => {
  const server = db.servers.create({ name: 'app-server', hostname: 'app-server.local', ip_address: '10.0.0.73' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'My App', type: 'script', check_command: '/opt/my-app --version',
    latest_command: 'cat /etc/my-app/desired-version', update_command: '',
  });

  const original = sshManager.execCommand;
  sshManager.execCommand = async (_server, command) => ({ code: 0, stdout: command.includes('desired') ? '2.4.0\n' : '2.3.0\n' });
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = original;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, '2.3.0');
  assert.equal(updated.last_version, '2.4.0');
  assert.equal(updated.has_update, 1);
});

test('GitHub custom update task compares the latest release to the version read over SSH', async () => {
  const server = db.servers.create({ name: 'release-server', hostname: 'release-server.local', ip_address: '10.0.0.74' });
  const task = db.customUpdateTasks.create(server.id, {
    name: 'Release App', type: 'github', github_repo: 'owner/release-app',
    check_command: '/opt/release-app --version', update_command: '',
  });

  const originalExec = sshManager.execCommand;
  const originalFetch = global.fetch;
  sshManager.execCommand = async () => ({ code: 0, stdout: 'v1.0.0\n' });
  global.fetch = async (url, options) => {
    assert.equal(url.toString(), 'https://api.github.com/repos/owner/release-app/releases/latest');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ tag_name: 'v1.1.0' }) };
  };
  try {
    await scheduler.checkCustomTask(server, task);
  } finally {
    sshManager.execCommand = originalExec;
    global.fetch = originalFetch;
  }

  const updated = db.customUpdateTasks.getById(task.id);
  assert.equal(updated.current_version, '1.0.0');
  assert.equal(updated.last_version, '1.1.0');
  assert.equal(updated.has_update, 1);
});

test('trigger comparison preserves a leading v and ignores an inactive latest command', async () => {
 const server=db.servers.create({name:'literal-trigger',hostname:'literal',ip_address:'192.0.2.91'});
 const task=db.customUpdateTasks.create(server.id,{name:'Literal',type:'trigger',check_command:'check',trigger_output:'version available',latest_command:'must-not-run'});
 const original=sshManager.execCommand;
 const commands=[];
 sshManager.execCommand=async(_server,command)=>{commands.push(command);return {code:0,stdout:'version available\n'}};
 try { await scheduler.checkCustomTask(server,task); } finally { sshManager.execCommand=original; }
 assert.deepEqual(commands,['check']);
 assert.equal(db.customUpdateTasks.getById(task.id).has_update,1);
});

test('failed version checks retain prior values and successful-check timestamp', async () => {
 const server=db.servers.create({name:'failed-check',hostname:'failed',ip_address:'192.0.2.92'});
 const task=db.customUpdateTasks.create(server.id,{name:'Failure',type:'script',check_command:'installed',latest_command:'latest'});
 db.customUpdateTasks.setVersionInfo(task.id,'1','2',true);
 const before=db.customUpdateTasks.getById(task.id);
 const original=sshManager.execCommand;
 try {
   for(const failure of [{code:1,stdout:'secret output'},{code:0,stdout:''}]) {
     sshManager.execCommand=async(_server,command)=>command==='latest'?{code:0,stdout:'3'}:failure;
     await assert.rejects(scheduler.checkCustomTask(server,before),/Installed-version check failed/);
     const failed=db.customUpdateTasks.getById(task.id);
     for(const field of ['current_version','last_version','has_update','last_checked_at']) assert.equal(failed[field],before[field]);
     assert.ok(failed.last_attempted_at);
     assert.match(failed.last_check_error,/Check failed/);
     assert.equal(failed.last_check_error.includes('secret output'),false);
   }
   sshManager.execCommand=async()=>({code:0,stdout:'3'});
   await scheduler.checkCustomTask(server,db.customUpdateTasks.getById(task.id));
   assert.equal(db.customUpdateTasks.getById(task.id).last_check_error,null);
 } finally { sshManager.execCommand=original; }
});

test('editing check rules clears old results and rejects late results from the previous rule', async () => {
 const server=db.servers.create({name:'edited-check',hostname:'edited',ip_address:'192.0.2.93'});
 const task=db.customUpdateTasks.create(server.id,{name:'Edited',type:'trigger',check_command:'old-check',trigger_output:'yes'});
 db.customUpdateTasks.setVersionInfo(task.id,'yes','yes',true);
 const originalState=db.customUpdateTasks.getById(task.id);
 const renamed=db.customUpdateTasks.update(task.id,{...originalState,name:'Renamed'});
 assert.equal(renamed.last_checked_at,originalState.last_checked_at);
 assert.equal(renamed.has_update,1);
 const original=sshManager.execCommand;
 sshManager.execCommand=async()=>{
   db.customUpdateTasks.update(task.id,{...renamed,check_command:'new-check'});
   return {code:0,stdout:'yes'};
 };
 try { await scheduler.checkCustomTask(server,renamed); } finally { sshManager.execCommand=original; }
 const changed=db.customUpdateTasks.getById(task.id);
 assert.equal(changed.check_command,'new-check');
 assert.equal(changed.last_checked_at,null);
 assert.equal(changed.current_version,null);
 assert.equal(changed.has_update,0);
 db.customUpdateTasks.setCheckFailure(task.id,renamed);
 assert.equal(db.customUpdateTasks.getById(task.id).last_check_error,null);
});


test('GitHub release checks reject malformed persisted repositories before network access', async () => {
  const server = db.servers.create({ name: 'invalid-repo', hostname: 'invalid-repo', ip_address: '192.0.2.94' });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('Unexpected network access'); };
  try {
    for (const repo of ['../owner', 'owner/..', 'https://example.test/repo', 'owner/repo?redirect=elsewhere', 'owner/repo#fragment', 'owner/%2e%2e']) {
      const task = db.customUpdateTasks.create(server.id, { name: 'Invalid', type: 'github', github_repo: repo, check_command: 'version' });
      await assert.rejects(scheduler.checkCustomTask(server, task), /GitHub release check failed/);
    }
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});
