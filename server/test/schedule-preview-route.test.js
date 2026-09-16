const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shipyard-schedule-preview-'));
process.env.DB_PATH=path.join(root,'test.db');
process.env.NODE_ENV='test';
const db=require('../db');
const scheduler=require('../services/scheduler');
const cron=require('node-cron');
const express=require('express');const request=require('supertest');
const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={role:req.headers['x-role']||'admin'};next();});app.use('/schedules',require('../routes/schedules'));
after(()=>{scheduler.shutdown();db.db.close();fs.rmSync(root,{recursive:true,force:true});});
test('preview endpoint uses configured zone, rejects unauthorized requests and creates no stored schedule',async()=>{
 db.settings.set('scheduler_timezone','Europe/Zurich');
 const before=db.db.prepare('SELECT COUNT(*) n FROM schedules').get().n;
 const response=await request(app).get('/schedules/preview?expression=0%203%20*%20*%20*');
 assert.equal(response.status,200);
 assert.equal(response.body.timezone,'Europe/Zurich');
 assert.equal(response.body.runs.length,3);
 assert.equal((await request(app).get('/schedules/preview?expression=bad')).status,400);
 assert.equal((await request(app).get('/schedules/preview?expression=*%20*%20*%20*%20*').set('x-role','unknown')).status,403);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM schedules').get().n,before);
});
test('registered scheduler uses the same DST-correct next-match calculation and cleans up its task',()=>{
 const before=new Set(cron.getTasks().keys());
 scheduler.register({id:'preview-integration',name:'Preview integration',cron_expression:'0 3 * * *',playbook:'never-run.yml',targets:'all'});
 try{
   const tasks=[...cron.getTasks()].filter(([id])=>!before.has(id));
   assert.equal(tasks.length,1);
   const matcher=tasks[0][1].timeMatcher;
   assert.equal(matcher.getNextMatch(new Date('2026-03-28T02:00:00Z')).toISOString(),'2026-03-29T01:00:00.000Z');
 }finally{scheduler.unregister('preview-integration');}
 assert.equal(cron.getTasks().size,before.size);
});

test('impossible schedules are rejected before persistence or registration, including updates and reactivation',async()=>{
 const count=()=>db.db.prepare('SELECT COUNT(*) n FROM schedules').get().n;
 const before=count(); const tasks=cron.getTasks().size;
 const payload={name:'Calendar validation',playbook:'never-run.yml',targets:'all',cronExpression:'0 3 30 2 *'};
 const create=await request(app).post('/schedules').send(payload);
 assert.equal(create.status,400); assert.match(create.body.error,/valid cron expression/i);
 assert.equal(count(),before); assert.equal(cron.getTasks().size,tasks);
 const id=db.schedules.create('Original','never-run.yml','all','0 3 * * *');
 db.schedules.update(id,{enabled:0});
 try {
   for(const expression of ['0 3 30 2 *',123,'* '.repeat(60)]) {
     const update=await request(app).put(`/schedules/${id}`).send({name:'Changed',cronExpression:expression});
     assert.equal(update.status,400);
     assert.equal(db.schedules.getById(id).name,'Original');
     assert.equal(db.schedules.getById(id).cron_expression,'0 3 * * *');
   }
   db.schedules.update(id,{cronExpression:'0 3 30 2 *'});
   assert.equal((await request(app).post(`/schedules/${id}/toggle`)).status,400);
   assert.equal((await request(app).put(`/schedules/${id}`).send({enabled:true})).status,400);
   assert.equal(Boolean(db.schedules.getById(id).enabled),false);
   // Broken legacy schedules can still be paused and renamed to support recovery.
   assert.equal((await request(app).put(`/schedules/${id}`).send({enabled:false,name:'Needs repair'})).status,200);
   assert.equal(cron.getTasks().size,tasks);
 } finally {scheduler.unregister(id);db.schedules.delete(id);}
});
