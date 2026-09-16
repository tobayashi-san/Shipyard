const {test}=require('node:test');
const assert=require('node:assert/strict');
const cron=require('node-cron');
const {previewSchedule}=require('../utils/schedule-preview');
test('preview produces three future instants without leaving registered tasks',()=>{
 const before=cron.getTasks().size;
 const result=previewSchedule('0 3 * * *','Europe/Zurich',new Date('2026-09-09T00:00:00Z'));
 assert.deepEqual(result.runs,['2026-09-09T01:00:00.000Z','2026-09-10T01:00:00.000Z','2026-09-11T01:00:00.000Z']);
 assert.equal(cron.getTasks().size,before);
});
test('preview follows scheduler timezone across daylight saving transition',()=>{
 const result=previewSchedule('0 3 * * *','Europe/Zurich',new Date('2026-03-28T00:00:00Z'));
 assert.deepEqual(result.runs,['2026-03-28T02:00:00.000Z','2026-03-29T01:00:00.000Z','2026-03-30T01:00:00.000Z']);
});
test('invalid expressions are rejected without leaving registered tasks',()=>{
 const before=cron.getTasks().size;
 for(const expression of ['bad','99 * * * *','* * * * * *']) assert.throws(()=>previewSchedule(expression,'UTC'));
 assert.equal(cron.getTasks().size,before);
});
test('repeated DST hour includes both occurrences and missing spring hour is skipped',()=>{
 assert.deepEqual(previewSchedule('30 2 * * *','Europe/Zurich',new Date('2026-10-25T00:00:00Z')).runs,['2026-10-25T00:30:00.000Z','2026-10-25T01:30:00.000Z','2026-10-26T01:30:00.000Z']);
 assert.deepEqual(previewSchedule('30 2 * * *','Europe/Zurich',new Date('2026-03-28T23:00:00Z')).runs,['2026-03-30T00:30:00.000Z','2026-03-31T00:30:00.000Z','2026-04-01T00:30:00.000Z']);
});
test('minute schedules stay chronological and impossible dates fail without task leaks',()=>{
 const runs=previewSchedule('* * * * *','UTC',new Date('2026-01-01T12:00:20Z')).runs;
 assert.deepEqual(runs,['2026-01-01T12:01:00.000Z','2026-01-01T12:02:00.000Z','2026-01-01T12:03:00.000Z']);
 const before=cron.getTasks().size;
 assert.throws(()=>previewSchedule('0 0 30 2 *','UTC',new Date('2026-01-01')),/valid five-field cron expression/);
 assert.equal(cron.getTasks().size,before);
});

test('execution validation accepts sparse leap days and existing six-field cron syntax without task leaks',()=>{
 const {validateExecutableSchedule}=require('../utils/schedule-preview');
 const before=cron.getTasks().size;
 validateExecutableSchedule('0 0 29 2 *','Europe/Zurich',new Date('2026-01-01T00:00:00Z'));
 validateExecutableSchedule('30 0 3 * * *','Europe/Zurich',new Date('2026-01-01T00:00:00Z'));
 assert.throws(()=>validateExecutableSchedule('0 0 31 4 *','Europe/Zurich'),/valid cron expression/);
 assert.equal(cron.getTasks().size,before);
});
