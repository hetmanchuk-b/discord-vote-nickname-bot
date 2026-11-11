const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyWarning, safeWarningDetails, SafeOperationalError, WARNING_DETAIL_LABELS } = require('../dist/reputation/warning-details.js');
const { warningHistory } = require('../dist/reputation/warning-store.js');
const { renderWarning } = require('../dist/reputation/operational-warnings.js');
const { VoiceTracker } = require('../dist/reputation/voice-tracker.js');
const { SettlementScheduler } = require('../dist/reputation/settlement-scheduler.js');

for (const [code,context,expected] of [
  ['P1002','database','database-timeout'],['ETIMEDOUT','database','database-timeout'],
  ['ECONNREFUSED','database','database-unavailable'],['28P01','database','database-authentication'],
  ['P2021','database','database-schema'],['53300','database','database-connections'],
  ['42501','database','database-access'],
  ['40001','database','database-conflict'],['57014','database','database-cancelled'],
  [50013,'discord','discord-permissions'],[50001,'discord','discord-access'],
  [10003,'discord','report-channel-missing'],[10008,'discord','discord-message-missing'],
  [429,'discord','discord-rate-limit'],['ETIMEDOUT','discord','discord-timeout'],
  ['ECONNRESET','discord','discord-unavailable'],[503,'discord','discord-unavailable'],
  [40001,'discord','report-failure'],
]) test(`safe diagnostic classification: ${context}/${code}`,()=>{
  assert.deepEqual(classifyWarning({code,message:'private password',stack:'private path'},context),[expected]);
});

test('Prisma adapter causes expose only safe codes, never host/port/SQL metadata',()=>{
  const error={code:'P2010',meta:{driverAdapterError:{cause:{kind:'SocketTimeout',host:'private-host',port:5432,sql:'private SQL'}}}};
  const details=classifyWarning(error,'database');
  assert.deepEqual(details,['database-timeout']);
  assert.doesNotMatch(JSON.stringify(details),/private/);
  assert.deepEqual(classifyWarning({cause:{kind:'TlsConnectionError'}},'database'),['database-tls']);
  assert.deepEqual(classifyWarning({cause:{originalCode:'42P01'}},'database'),['database-schema']);
});

test('classification never reads raw message/stack getters and safely bounds cyclic/hostile causes',()=>{
  const error={code:'ETIMEDOUT'};
  Object.defineProperty(error,'message',{get(){throw new Error('raw message read');}});
  Object.defineProperty(error,'stack',{get(){throw new Error('raw stack read');}});
  assert.deepEqual(classifyWarning(error,'database'),['database-timeout']);
  const cyclic={};cyclic.cause=cyclic;
  assert.deepEqual(classifyWarning(cyclic,'database'),['database-failure']);
  assert.deepEqual(classifyWarning('postgres://private:password@host','discord'),['report-failure']);
  assert.deepEqual(classifyWarning(new Proxy({},{get(){throw new Error('hostile getter');}}),'database'),['database-failure']);
});

test('allowlisting rejects arbitrary summaries, limits detail counts, and sanitizes persisted/rendered history',()=>{
  const raw='postgres://private:password@host';
  const details=safeWarningDetails([raw,'database-timeout','database-timeout']);
  assert.deepEqual(details,['database-timeout']);
  assert.equal(safeWarningDetails(Object.keys(WARNING_DETAIL_LABELS)).length,4);
  const history=warningHistory([{id:'safe',at:'2026-11-11T12:34:00.000Z',reasons:['tracking'],
    details:{tracking:[raw,'database-timeout'],reports:['discord-access'],private:raw}}]);
  assert.deepEqual(history[0].details,{tracking:['database-timeout']});
  const description=renderWarning('guild',{reasons:['tracking'],history,details:history[0].details},new Date('2026-11-11T12:34:00Z')).embeds[0].toJSON().description;
  assert.match(description,/час очікування відповіді бази даних/);
  assert.doesNotMatch(description,/private|password|postgres:\/\//);
  assert.match(description,/14:34/);
  assert.ok(description.length<=4096);
  assert.deepEqual(classifyWarning(new SafeOperationalError(['discord-send-messages']),'database'),['discord-send-messages']);
});

test('verbose safe summaries keep the newest complete history entries inside the Discord limit',()=>{
  const reasons=['reports','settlement','tracking'];
  const codes=['report-channel-unconfigured','tracking-ownership','report-message-mismatch','observation-gap'];
  const details=Object.fromEntries(reasons.map(reason=>[reason,codes]));
  const origin=Date.parse('2026-11-11T12:00:00Z');
  const history=Array.from({length:100},(_,index)=>({id:`event-${index}`,at:new Date(origin+index*60000).toISOString(),reasons,details}));
  const description=renderWarning('guild',{reasons,details,history},new Date(origin)).embeds[0].toJSON().description;
  assert.ok(description.length<=4096);
  assert.match(description,/15:39/);
  assert.match(description,/Показано останні події/);
  assert.match(description.split('\n').at(-1),/15:39/);
});

test('tracking reports changed safe causes during an outage without repeating identical causes',async()=>{
  let time=0;let code='ETIMEDOUT';const events=[];
  const tracker=new VoiceTracker({guildId:'guild',now:()=>new Date(time),presentUserIds:()=>[],
    store:{openRun:async()=>{throw Object.assign(new Error('private database URL'),{code});}},onStatus:event=>events.push(event)});
  await tracker.start();
  time=6000;await tracker.start(); // Same timeout: no duplicate event.
  code='28P01';time=20000;await tracker.start();
  assert.deepEqual(events.map(event=>event.details),[['database-timeout'],['database-authentication']]);
  assert.doesNotMatch(JSON.stringify(events),/private/);
  await tracker.stop();
});

test('settlement passes safe causes to warnings, reports changes once, and recovers without leaking errors',async()=>{
  const events=[];let code='P2024';
  const scheduler=new SettlementScheduler({guildId:'guild',now:()=>new Date('2026-11-11T12:00:00Z'),
    beforeSettlement:async()=>{if(code)throw Object.assign(new Error('private SQL'),{code});},
    store:{settleNextClosedDay:async()=>null},onUnavailable:details=>events.push(details),onRecovered:()=>events.push('recovered')});
  try{
    await scheduler.start();await scheduler.runDue();code='P2021';await scheduler.runDue();
    code=null;await scheduler.runDue();
    assert.deepEqual(events,[['database-timeout'],['database-schema'],'recovered']);
    assert.doesNotMatch(JSON.stringify(events),/private/);
  }finally{await scheduler.stop();}
});
