const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate } = require('node:timers/promises');
const { createIntervalRetentionStore, RAW_INTERVAL_RETENTION_DAYS, RAW_INTERVAL_RETENTION_MS, INTERVAL_RETENTION_BATCH_SIZE } = require('../dist/reputation/interval-retention.js');
const { SettlementScheduler } = require('../dist/reputation/settlement-scheduler.js');
const { kyivDay } = require('../dist/reputation/kyiv-day.js');
const HOUR=3600000;
const at=new Date('2026-11-21T12:00:00Z');
function fixture({watermark=kyivDay('2026-11-20').end,locked=true,count=1}={}){
  const calls=[];
  const tx={
    reputationGuild:{
      updateMany:async args=>{calls.push(['lock',args]);return {count:locked?1:0};},
      findUniqueOrThrow:async args=>{calls.push(['watermark',args]);return {settledThrough:watermark};},
    },
    reputationVoiceInterval:{
      findMany:async args=>{calls.push(['select',args]);return Array.from({length:count},(_,i)=>({id:BigInt(i+1)}));},
      deleteMany:async args=>{calls.push(['delete',args]);return {count:args.where.id.in.length};},
    },
  };
  const store=createIntervalRetentionStore(()=>({$transaction:async(callback,options)=>{calls.push(['transaction',options]);return callback(tx);}}));
  return {store,calls};
}

test('retention is exactly fourteen elapsed days, with bounded batches and a shared guild lock',async()=>{
  assert.equal(RAW_INTERVAL_RETENTION_DAYS,14);assert.equal(RAW_INTERVAL_RETENTION_MS,336*HOUR);
  const f=fixture();assert.deepEqual(await f.store.prune('guild',at),{deletedCount:1,hasMore:false});
  assert.deepEqual(f.calls.map(call=>call[0]),['transaction','lock','watermark','select','delete']);
  assert.deepEqual(f.calls[0][1],{maxWait:5000,timeout:15000});
  const where={guildId:'guild',endedAt:{lte:new Date(at.getTime()-14*24*HOUR)},member:{hasParticipated:true}};
  assert.deepEqual(f.calls[1][1],{where:{guildId:'guild'},data:{updatedAt:at}});
  assert.deepEqual(f.calls[3][1],{where,orderBy:[{endedAt:'asc'},{id:'asc'}],take:INTERVAL_RETENTION_BATCH_SIZE+1,select:{id:true}});
  assert.deepEqual(f.calls[4][1],{where:{...where,id:{in:[1n]}}});
});

test('settlement lag caps deletion at the committed midnight watermark',async()=>{
  const watermark=kyivDay('2026-11-01').end;
  const f=fixture({watermark});await f.store.prune('guild',at);
  assert.equal(f.calls.find(call=>call[0]==='select')[1].where.endedAt.lte.getTime(),watermark.getTime());
});

for(const setup of [{locked:false},{watermark:null},{count:0}]){
  test(`missing guild, missing settlement or empty batch is a safe no-op: ${JSON.stringify(setup)}`,async()=>{
    const f=fixture(setup);assert.deepEqual(await f.store.prune('guild',at),{deletedCount:0,hasMore:false});
    assert.equal(f.calls.some(call=>call[0]==='delete'),false);
  });
}

test('invalid clocks and malformed settlement watermarks cannot delete data',async()=>{
  const f=fixture();await assert.rejects(f.store.prune('guild',new Date(NaN)));
  assert.deepEqual(f.calls,[]);
  const bad=fixture({watermark:new Date('2026-11-01T12:00:00Z')});
  await assert.rejects(bad.store.prune('guild',at),/Invalid retention settlement watermark/);
  assert.equal(bad.calls.some(call=>call[0]==='delete'),false);
});

test('a backlog deletes no more than one batch and reports whether another batch exists',async()=>{
  const f=fixture({count:INTERVAL_RETENTION_BATCH_SIZE+1});
  assert.deepEqual(await f.store.prune('guild',at),{deletedCount:INTERVAL_RETENTION_BATCH_SIZE,hasMore:true});
  assert.equal(f.calls.find(call=>call[0]==='delete')[1].where.id.in.length,INTERVAL_RETENTION_BATCH_SIZE);
});

function schedulerFixture(t,store,retention){
  const timers=[],events=[],states=[];
  let now=new Date('2026-11-11T22:00:00Z');
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const scheduler=new SettlementScheduler({guildId:'guild',store,retention,now:()=>new Date(now),
    beforeSettlement:async()=>events.push('flush'),onSettled:()=>events.push('settled'),
    onUnavailable:()=>states.push('unavailable'),onRecovered:()=>states.push('recovered')});
  return {scheduler,timers,events,states,at:value=>{now=new Date(value);}};
}

test('cleanup runs after catch-up, drains in bounded wakes, then sleeps until midnight',async t=>{
  let days=2,cleanups=0;
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>days-->0?{day:String(days),pointsAwarded:1,incomplete:false}:null},
    {prune:async(guildId,time)=>{assert.equal(guildId,'guild');assert.equal(time.toISOString(),'2026-11-11T22:00:00.000Z');f.events.push('cleanup');return {deletedCount:++cleanups===1?1000:5,hasMore:cleanups===1};}});
  await f.scheduler.start();assert.deepEqual(f.events,['flush','settled','settled','cleanup']);
  assert.equal(f.timers.at(-1).delay,1000);
  await f.scheduler.runDue();assert.equal(cleanups,2);assert.equal(f.timers.at(-1).delay,24*HOUR);
  assert.equal(f.events.filter(event=>event==='flush').length,1); // No raw-row amplification while draining.
  await f.scheduler.stop();await f.scheduler.runDue();assert.equal(cleanups,2);
});

test('a cleanup backlog crossing Kyiv midnight flushes and checks the newly closed day',async t=>{
  let checks=0,cleanups=0;
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>{checks++;return null;}},
    {prune:async()=>({deletedCount:1,hasMore:++cleanups===1})});
  await f.scheduler.start();assert.equal(checks,1);
  f.at('2026-11-12T22:00:00Z');await f.scheduler.runDue();
  assert.equal(checks,2);assert.equal(cleanups,2);
  assert.equal(f.events.filter(event=>event==='flush').length,2);
  await f.scheduler.stop();
});

test('cleanup waits while a large settlement backlog is still being processed',async t=>{
  let days=32,cleanups=0;
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>days-->0?{day:String(days),pointsAwarded:0,incomplete:true}:null},
    {prune:async()=>{cleanups++;return {deletedCount:0,hasMore:false};}});
  await f.scheduler.start();assert.equal(cleanups,0);
  await f.scheduler.runDue();assert.equal(cleanups,1);
  await f.scheduler.stop();
});

test('settlement failure prevents cleanup and preserves normal accounting health reporting',async t=>{
  let cleanups=0;
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>{throw new Error('failure');}},
    {prune:async()=>{cleanups++;return {deletedCount:0,hasMore:false};}});
  await f.scheduler.start();assert.equal(cleanups,0);assert.deepEqual(f.states,['unavailable']);
  await f.scheduler.stop();
});

test('cleanup failures retry independently, keep accounting healthy, and never log raw secrets',async t=>{
  const warnings=t.mock.method(console,'warn',()=>{}),logs=t.mock.method(console,'log',()=>{});
  let down=true;
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>null},
    {prune:async()=>{if(down)throw new Error('postgres://private:secret@host');return {deletedCount:0,hasMore:false};}});
  await f.scheduler.start();assert.equal(f.scheduler.healthy,true);assert.equal(f.timers.at(-1).delay,60000);
  await f.scheduler.runDue();assert.equal(f.timers.at(-1).delay,120000);
  await f.scheduler.runDue();await f.scheduler.runDue();assert.equal(f.timers.at(-1).delay,300000);
  assert.deepEqual(f.states,[]);assert.equal(warnings.mock.calls.length,1);
  down=false;await f.scheduler.runDue();assert.equal(f.timers.at(-1).delay,24*HOUR);
  assert.equal(logs.mock.calls.length,1);
  assert.doesNotMatch(JSON.stringify([...warnings.mock.calls,...logs.mock.calls].map(call=>call.arguments)),/secret|postgres:/);
  await f.scheduler.stop();
});

test('shutdown waits for in-flight cleanup and does not leave a new timer behind',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const f=schedulerFixture(t,{settleNextClosedDay:async()=>null},{prune:async()=>{await gate;return {deletedCount:1,hasMore:true};}});
  const running=f.scheduler.start();await setImmediate();
  const stopping=f.scheduler.stop();release();await Promise.all([running,stopping]);
  assert.equal(f.timers.length,0);
});
