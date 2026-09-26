'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');
const {adminOnly} = require('../middleware/auth');
const {validSession} = require('../utils/auth-sessions');
const backupService = require('../services/database-backup');
const {serverError} = require('../utils/http-error');
const {confirmCurrentUser} = require('../utils/reauth');
const router = express.Router();
let busy = false;
const limiter = rateLimit({windowMs:15*60*1000,max:5,skip:()=>process.env.NODE_ENV==='test',standardHeaders:true,legacyHeaders:false,message:{error:'Too many backup attempts. Try again in 15 minutes.'}});
const readRecord = key => { try { return JSON.parse(db.settings.get(key) || 'null'); } catch { return null; } };
router.get('/status', adminOnly, (req,res) => {
  res.set('Cache-Control','no-store');
  res.json({externalLastSuccess:readRecord('backup_external_success'),databaseExport:readRecord('backup_last_export'),externalBackup:readRecord('backup_external_record'),recoveryTest:readRecord('backup_recovery_test')});
});
router.put('/records/:kind', adminOnly, (req,res) => {
  const key = req.params.kind === 'external' ? 'backup_external_record' : req.params.kind === 'recovery' ? 'backup_recovery_test' : null;
  if (!key) return res.status(404).json({error:'Unknown recovery record type'});
  const {occurredAt,scope,version,result,notes} = req.body || {};
  if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now() + 60000) return res.status(400).json({error:'Enter a valid date in the past'});
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 500 || typeof version !== 'string' || !version.trim() || version.length > 100 || !['passed','failed'].includes(result) || typeof notes !== 'string' || notes.length > 2000) return res.status(400).json({error:'Scope, application version, result and notes (up to 2000 characters) are required'});
  const record = {occurredAt:new Date(occurredAt).toISOString(),scope:scope.trim(),version:version.trim(),result,notes,recordedAt:new Date().toISOString(),recordedBy:req.user.username,source:'manual'};
  db.db.transaction(()=>{db.settings.set(key,JSON.stringify(record));if(req.params.kind === 'external' && result === 'passed' && (!readRecord('backup_external_success') || Date.parse(record.occurredAt) >= Date.parse(readRecord('backup_external_success').occurredAt))) db.settings.set('backup_external_success',JSON.stringify(record));db.auditLog.write('backup.record',`Recorded ${req.params.kind} result: ${result}`,req.ip,true,req.user.username);})();
  res.json(record);
});
router.post('/',adminOnly,limiter,async(req,res)=>{
  const body = req.body || {};
  if (typeof body.passphrase !== 'string' || body.passphrase.length < 12 || Buffer.byteLength(body.passphrase) > 1024) return res.status(400).json({error:'Backup passphrase requires at least 12 characters and at most 1024 UTF-8 bytes',field:'passphrase'});
  if (body.scope !== 'all-environments-database') return res.status(400).json({error:'Confirm the all-environments database scope',field:'scope'});
  const {user,error} = await confirmCurrentUser(req.user.username,{password:body.password,code:body.code});
  if (error) return res.status(error.status).json(error.body);
  if (busy) return res.status(409).json({error:'A database backup is already being prepared. Try again shortly.'});
  busy = true;
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(),'fleet-export-'));
    const archive = path.join(dir,'database.backup');
    const info = await backupService.createEncryptedDatabaseBackup(db.db,archive,body.passphrase);
    await backupService.verifyEncryptedDatabaseBackup(archive,body.passphrase);
    const current = db.users.getById(user.id);
    if (!current || current.disabled || current.role !== 'admin' || current.token_version !== user.token_version || !validSession(req.authPayload,req.headers.authorization.slice(7))) return res.status(403).json({error:'Authorization changed. Sign in again before exporting.'});
    db.auditLog.write('backup.database_export',`Encrypted database archive prepared and verified; scope=all-environments; bytes=${info.bytes}`,req.ip,true,user.username);
    db.settings.set('backup_last_export',JSON.stringify({occurredAt:new Date().toISOString(),scope:'Database · all environments',result:'passed',source:'fleet',bytes:info.bytes}));
    res.set('Cache-Control','no-store');
    res.set('X-Fleet-Backup-Verification','authenticated-decryption-and-sqlite-integrity');
    await new Promise((resolve,reject)=>res.download(archive,`fleet-database-${new Date().toISOString().slice(0,10)}.backup`,error=>error?reject(error):resolve()));
  } catch (error) {
    if (res.headersSent) res.destroy(); else serverError(res,error,'database backup export');
  } finally { try { if(dir)await fs.rm(dir,{recursive:true,force:true}); } finally { busy=false; } }
});
module.exports = router;
