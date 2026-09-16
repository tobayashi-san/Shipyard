const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-probe-test-'));
process.env.DB_PATH = path.join(root, 'test.db');
let seen;
let fail = false;
mock.method(require('node:child_process'), 'execFile', (command, args, options, callback) => {
  seen = { command, args, options };
  if (fail) return callback(new Error('sensitive token in transport error'));
  callback(null, 'ref: refs/heads/main\tHEAD\nabc123\trefs/heads/main\nabc124\trefs/heads/release/stable\n', '');
});
const { testConnection } = require('../services/git-connection-test');
const db = require('../db');
after(() => { mock.restoreAll(); db.db.close(); fs.rmSync(root, {recursive:true,force:true}); });
test('probe reads branches without persisting credentials and removes temporary directory', async () => {
  db.settings.set('git_repo_url', 'https://original.invalid/repo');
  const result = await testConnection({repoUrl:'https://example.invalid/repo',authToken:'private-token',branch:'main'});
  assert.deepEqual(result.branches, ['main','release/stable']);
  assert.equal(result.branchExists, true);
  assert.equal(result.defaultBranch, 'main');
  assert.equal(db.settings.get('git_repo_url'), 'https://original.invalid/repo');
  assert.equal(seen.command, 'git');
  assert.ok(seen.args.includes('ls-remote'));
  assert.equal(seen.args[seen.args.indexOf('--')+1], 'https://example.invalid/repo');
  assert.ok(!JSON.stringify(seen.args).includes('private-token'));
  assert.ok(!fs.existsSync(seen.options.cwd));
  assert.equal(seen.options.timeout, 15000);
});
test('missing branch differs from an unreachable repository and errors exclude transport secrets', async () => {
  assert.equal((await testConnection({repoUrl:'https://example.invalid/repo',branch:'missing'})).branchExists, false);
  fail = true;
  await assert.rejects(testConnection({repoUrl:'https://example.invalid/repo'}), error => error.status === 502 && !error.message.includes('sensitive'));
  assert.ok(!fs.existsSync(seen.options.cwd));
  fail = false;
});
test('probe rejects invalid URLs, branches and ambiguous credentials before executing', async () => {
  await assert.rejects(testConnection({repoUrl:'file:///etc/passwd'}), {status:400});
  await assert.rejects(testConnection({repoUrl:'https://example.invalid/repo',branch:'--bad'}), {status:400});
  await assert.rejects(testConnection({repoUrl:'https://example.invalid/repo',authToken:'x',sshKey:'y'}), {status:400});
});
test('connection-test endpoint requires administrator access and preserves saved config', async () => {
  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: req.headers['x-role'] || 'viewer' }; next(); });
  app.use('/git', require('../routes/git-playbooks'));
  assert.equal((await request(app).post('/git/test').send({repoUrl:'https://example.invalid/repo'})).status, 403);
  const response = await request(app).post('/git/test').set('x-role','admin').send({repoUrl:'https://example.invalid/repo'});
  assert.equal(response.status, 200);
  assert.equal(response.body.branchExists, true);
  assert.equal(db.settings.get('git_repo_url'), 'https://original.invalid/repo');
});

test('probe rejects incompatible SSH credentials before launching Git', async () => {
 seen = null;
 await assert.rejects(testConnection({repoUrl:'https://example.invalid/repo',sshKey:'private-key'}), {status:400});
 assert.equal(seen,null);
});

test('probe rejects SSH option injection and encoded userinfo without running Git',async()=>{
 for (const repoUrl of ['--upload-pack=evil','ssh://-oProxyCommand=evil@example.invalid/repo','ssh://%2doProxyCommand%3devil@example.invalid/repo','ssh://git@%2dexample.invalid/repo','ssh://git%ZZ@example.invalid/repo','ext::evil']) {
  seen=null;await assert.rejects(testConnection({repoUrl}),{status:400});assert.equal(seen,null);
 }
});
