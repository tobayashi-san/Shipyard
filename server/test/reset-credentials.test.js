'use strict';
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shipyard-reset-credentials-'));
process.env.DB_PATH=path.join(root,'test.db');process.env.SHIPYARD_PLAYBOOKS_DIR=path.join(root,'playbooks');process.env.JWT_SECRET='synthetic-reset-jwt';process.env.SHIPYARD_KEY_SECRET='synthetic-reset-key';process.env.NODE_ENV='test';
const db=require('../db');const bcrypt=require('bcryptjs');const jwt=require('jsonwebtoken');const otplib=require('otplib');const express=require('express');const request=require('supertest');
const {createSession}=require('../utils/auth-sessions');const credentials=require('../middleware/reset-credentials');
const password='Synthetic-reset-password';const hash=bcrypt.hashSync(password,4);
const user=db.users.create('admin',null,hash,'admin');const sid=createSession(user);
const token=jwt.sign({userId:user.id,tv:0,sid},process.env.JWT_SECRET,{expiresIn:'1h'});
const app=express();app.use(express.json());app.use(require('../middleware/auth'));app.use('/reset',require('../routes/reset'));app.post('/probe',credentials,(_req,res)=>res.json({authorized:true}));
const host=db.servers.create({name:'Keep',hostname:'keep',ip_address:'192.0.2.1'});
const phrases={servers:'DELETE HOSTS',schedules:'DELETE SCHEDULES',playbooks:'DELETE PLAYBOOKS',auth:'RESET ALL ACCOUNTS',all:'RESET HOSTS SCHEDULES AND ACCOUNTS'};
const reset=(action,body={})=>request(app).delete(`/reset/${action}`).set('Authorization',`Bearer ${token}`).send({confirmation:phrases[action],scope:['servers','schedules'].includes(action)?'default':'all-environments',...body});
after(()=>{db.db.close();fs.rmSync(root,{recursive:true,force:true});});

test('every reset requires current credentials even with a valid authenticated admin session and phrase',async()=>{
 for(const action of Object.keys(phrases)){
  const result=await reset(action);assert.equal(result.status,400);assert.equal(result.body.field,'password');
 }
 assert.ok(db.servers.getById(host.id));assert.equal(db.users.count(),1);
 assert.equal(db.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'reset.%'").get().n,0);
});

test('incorrect current password prevents reset before any data changes',async()=>{
 const result=await reset('servers',{password:'wrong'});assert.equal(result.status,403);assert.equal(result.body.field,'password');assert.ok(db.servers.getById(host.id));
});

test('enabled MFA is mandatory and a current code permits the confirmed reset',async(t)=>{
 // Backup verification may cross a TOTP time boundary under parallel test load.
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
 db.db.prepare('UPDATE users SET totp_enabled=1,totp_secret=? WHERE id=?').run(require('../utils/crypto').encrypt(secret),user.id);
 for(const code of [undefined,'invalid']){
  const result=await reset('servers',{password,code});assert.equal(result.status,403);assert.equal(result.body.field,'code');assert.ok(db.servers.getById(host.id));
 }
 const code=otplib.generateSync({secret});
 const backupApproval=await require('./fixtures/reset-approval')({app,database:db.db,action:'servers',password,code,headers:{Authorization:`Bearer ${token}`}});
 const result=await reset('servers',{password,code,backupApproval});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(db.servers.getById(host.id),undefined);
 const audit=JSON.stringify(db.db.prepare("SELECT * FROM audit_log WHERE action='reset.servers'").all());assert.equal(audit.includes(password),false);assert.equal(audit.includes(secret),false);
 db.db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(user.id);
});

test('role, password, token-version or session changes during password comparison deny reset authorization',async()=>{
 const compare=bcrypt.compare;
 for(const mutation of [
  ()=>db.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(user.id),
  ()=>db.db.prepare("UPDATE users SET password_hash='changed' WHERE id=?").run(user.id),
  ()=>db.db.prepare('UPDATE users SET token_version=1 WHERE id=?').run(user.id),
  ()=>db.db.prepare('UPDATE auth_sessions SET revoked_at=1 WHERE id=?').run(sid),
 ]){
  bcrypt.compare=async()=>{mutation();return true;};
  try{
   const result=await request(app).post('/probe').set('Authorization',`Bearer ${token}`).send({password});assert.equal(result.status,403);assert.match(result.body.error,/Authorization changed/);
  }finally{
   bcrypt.compare=compare;
   db.db.prepare("UPDATE users SET role='admin',password_hash=?,token_version=0 WHERE id=?").run(hash,user.id);
   db.db.prepare('UPDATE auth_sessions SET revoked_at=NULL WHERE id=?').run(sid);
  }
 }
});
