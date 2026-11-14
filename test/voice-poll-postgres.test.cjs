const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const {randomInt,randomUUID}=require('node:crypto');
const {createReputationDatabase}=require('./helpers/point-test-database.cjs');
const {createVoicePollStore,VoicePollError}=require('../dist/reputation/voice-poll-store.js');
const {createTrackingStore}=require('../dist/reputation/tracking-store.js');
const {PublicationPendingError}=require('../dist/reputation/report-errors.js');
const {createSettlementStore}=require('../dist/reputation/settlement-store.js');
const {kyivDay,kyivDate}=require('../dist/reputation/kyiv-day.js');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.'};
const target='111111111111111111',caller='222222222222222222',other='333333333333333333',fourth='444444444444444444';
async function fixture(callback){
  const db=createReputationDatabase(url);const guildId=`${Date.now()}${randomInt(100000,999999)}`;
  const store=createVoicePollStore(()=>db.raw),tracking=createTrackingStore(()=>db.raw);
  try{
    await db.reputationGuild.create({data:{guildId}});
    await db.reputationMember.create({data:{guildId,userId:target,hasParticipated:true,balance:100}});
    const request={guildId,targetId:target,initiatorId:caller,voiceChannelId:'555555555555555555',textChannelId:'666666666666666666',amount:50,proposalReason:'Тестова причина'};
    await callback({db,guildId,store,tracking,request});
  }finally{try{
    await db.voiceReputationPoll.deleteMany({where:{guildId}});
    await db.reputationDailyAward.deleteMany({where:{guildId}});
    await db.reputationSettlement.deleteMany({where:{guildId}});
    await db.reputationVoiceInterval.deleteMany({where:{guildId}});
    await db.reputationTrackingRun.deleteMany({where:{guildId}});
    await db.reputationMember.deleteMany({where:{guildId}});
    await db.reputationGuild.deleteMany({where:{guildId}});
  }finally{await db.$disconnect();}}
}
async function active(f,amount=50,kind='penalty'){
  const poll=await f.store.reserve({...f.request,amount,kind});
  const at=new Date();
  return f.store.activate(poll.id,f.guildId,at,{at,userIds:[target,caller,other,fourth]});
}
let sequence=100000000000000000n;
const vote=(f,poll,userId,yes)=>f.store.vote({interactionId:String(++sequence),kind:poll.kind,id:poll.id,guildId:f.guildId,textChannelId:poll.textChannelId,messageId:poll.messageId,userId,yes});
async function expire(f,poll,userIds){
  const endsAt=new Date(Date.now()-100);
  await f.db.voiceReputationPoll.update({where:{id:poll.id},data:{startedAt:new Date(endsAt.getTime()-120000),endsAt}});
  return {at:new Date(),userIds};
}
const balance=f=>f.db.reputationMember.findUniqueOrThrow({where:{guildId_userId:{guildId:f.guildId,userId:target}}}).then(row=>row.balance);

test('publication cannot activate without verified four-person start evidence',options,async()=>fixture(async f=>{
  for(const [index,ids] of [null,[target,caller,other],[caller,other,fourth,'777777777777777777']].entries()){
    const poll=await f.store.reserve(f.request);const at=new Date();
    const result=await f.store.activate(poll.id,String(BigInt(f.guildId)+BigInt(index)),at,ids?{at,userIds:ids}:null);
    assert.equal(result.status,'cancelled');assert.equal(result.reason,'start-unverified');
  }
  assert.equal(await balance(f),100);
}));

test('one eligible Yes applies once, target may leave, and concurrent retries cannot double fine',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);
  const evidence=await expire(f,poll,[caller]);
  const results=await Promise.all([f.store.finish(poll.id,evidence),f.store.finish(poll.id,evidence)]);
  assert.ok(results.every(result=>result.status==='succeeded'&&result.appliedAmount===50));
  assert.equal(await balance(f),50);
  assert.equal(await f.db.voiceReputationVote.count({where:{pollId:poll.id}}),0);
  const next=await f.store.reserve(f.request); // No cooldown after closure.
  assert.equal(next.status,'creating');
}));

test('any eligible No vetoes, only No identities are frozen, and choices can change',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);await vote(f,poll,other,true);await vote(f,poll,other,false);
  assert.equal(await f.db.voiceReputationVote.count({where:{pollId:poll.id}}),2);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller,other,fourth]));
  assert.equal(result.status,'failed');assert.deepEqual(result.noVoterIds,[other]);assert.equal(await balance(f),100);
}));

test('out-of-order handler completion cannot overwrite a newer selection',options,async()=>fixture(async f=>{
  const poll=await active(f);
  const request={id:poll.id,guildId:f.guildId,textChannelId:poll.textChannelId,messageId:poll.messageId,userId:caller};
  assert.equal(await f.store.vote({...request,yes:false,interactionId:'200000000000000002'}),false);
  assert.equal(await f.store.vote({...request,yes:true,interactionId:'200000000000000001'}),false);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));
  assert.equal(result.status,'failed');assert.deepEqual(result.noVoterIds,[caller]);
}));

test('No can change to Yes without leaving a stale veto',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,false);await vote(f,poll,caller,true);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));assert.equal(result.status,'succeeded');
}));

for(const mode of ['no-votes','yes-left','no-left'])test(`deadline eligibility: ${mode}`,options,async()=>fixture(async f=>{
  const poll=await active(f);
  if(mode!=='no-votes')await vote(f,poll,caller,true);
  if(mode==='no-left')await vote(f,poll,other,false);
  const ids=mode==='yes-left'?[]:[caller];
  const result=await f.store.finish(poll.id,await expire(f,poll,ids));
  assert.equal(result.status,mode==='no-left'?'succeeded':'failed');
  assert.deepEqual(result.noVoterIds,[]);
}));

test('paused participants are eligible, bounds clamp actual fines, and floor targets are rejected',options,async()=>fixture(async f=>{
  await f.tracking.setTracking(f.guildId,{userId:target,enabled:false},new Date());
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:-480}});
  const poll=await active(f,100);await vote(f,poll,caller,true);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));
  assert.equal(result.appliedAmount,20);assert.equal(result.balanceAfter,-500);
  await assert.rejects(f.store.reserve(f.request),error=>error instanceof VoicePollError&&error.code==='balance-floor');
}));

test('never-participated and erased users are rejected; verified unsettled visits count as participation',options,async()=>fixture(async f=>{
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{hasParticipated:false}});
  await assert.rejects(f.store.reserve(f.request),error=>error.code==='not-participated');
  const now=new Date();const runId=randomUUID();const from=new Date(now.getTime()-1000);
  await f.db.reputationTrackingRun.create({data:{id:runId,guildId:f.guildId,startedAt:from,verifiedThrough:now}});
  await f.db.reputationVoiceInterval.create({data:{guildId:f.guildId,userId:target,runId,startedAt:from,endedAt:now}});
  const poll=await f.store.reserve(f.request);assert.equal(poll.status,'creating');
  await f.tracking.deleteMemberData(f.guildId,target,new Date());
  assert.equal((await f.store.get(poll.id)).status,'cancelled');
  await assert.rejects(f.store.reserve(f.request),error=>error.code==='not-participated');
}));

test('concurrent initiators reserve only one active poll per target',options,async()=>fixture(async f=>{
  const outcomes=await Promise.allSettled([f.store.reserve(f.request),f.store.reserve({...f.request,initiatorId:other})]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const failed=outcomes.find(result=>result.status==='rejected');assert.equal(failed.reason.code,'active-poll');
}));

test('target, copied-message, cross-server, late votes and early fines are rejected',options,async()=>fixture(async f=>{
  const poll=await active(f);
  await assert.rejects(vote(f,poll,target,true),error=>error.code==='invalid');
  await assert.rejects(f.store.vote({id:poll.id,guildId:'777777777777777777',textChannelId:poll.textChannelId,messageId:poll.messageId,userId:caller,yes:true}),error=>error.code==='invalid');
  await assert.rejects(f.store.vote({id:poll.id,guildId:f.guildId,textChannelId:poll.textChannelId,messageId:'888888888888888888',userId:caller,yes:true}),error=>error.code==='invalid');
  await assert.rejects(f.store.finish(poll.id,{at:new Date(),userIds:[caller]}),error=>error.code==='not-due');
  await expire(f,poll,[]);
  await assert.rejects(vote(f,poll,caller,true),error=>error.code==='expired');assert.equal(await balance(f),100);
}));

for(const unverified of [null,'late'])test(`unverified deadline ${unverified} cancels without a fine`,options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  if(unverified==='late')evidence.at=new Date(Date.now()+10000);
  const result=await f.store.finish(poll.id,unverified===null?null:evidence);
  assert.equal(result.status,'cancelled');assert.equal(await balance(f),100);
}));

test('floor reached while voting cancels rather than claiming a zero-point deduction',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:-500}});
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));assert.equal(result.reason,'balance-floor');assert.equal(result.appliedAmount,0);
}));

test('reputation deletion cancels active polls and cannot resurrect a fine after re-enrollment',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  await f.tracking.deleteMemberData(f.guildId,target,new Date());
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{isTracking:true,hasParticipated:true}});
  const result=await f.store.finish(poll.id,evidence);assert.equal(result.reason,'target-erased');assert.equal(await balance(f),0);
}));

test('uncertain outcome publication blocks erasure; published No identities survive and private votes are erased',options,async()=>fixture(async f=>{
  await f.db.reputationMember.create({data:{guildId:f.guildId,userId:other,hasParticipated:true}});
  const poll=await active(f);await vote(f,poll,caller,true);await vote(f,poll,other,false);
  await f.store.finish(poll.id,await expire(f,poll,[caller,other]));await f.store.prepareDelivery(poll.id);
  await assert.rejects(f.tracking.deleteMemberData(f.guildId,other,new Date()),PublicationPendingError);
  await f.store.delivered(poll.id,false);await f.tracking.deleteMemberData(f.guildId,other,new Date());
  assert.deepEqual((await f.store.get(poll.id)).noVoterIds,[other]);
}));

test('unpublished veto identities and a member’s pending choices are removed on erasure',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);await vote(f,poll,other,false);
  await f.store.finish(poll.id,await expire(f,poll,[caller,other]));
  await f.tracking.deleteMemberData(f.guildId,other,new Date());assert.deepEqual((await f.store.get(poll.id)).noVoterIds,[]);
}));

test('a failed finalization rolls back balance, status, and vote removal together',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  const failing=createVoicePollStore(()=>({$transaction:(callback,settings)=>f.db.$transaction(tx=>callback(new Proxy(tx,{
    get(object,key){
      if(key==='voiceReputationVote')return {findMany:args=>object.voiceReputationVote.findMany(args),deleteMany:async()=>{throw new Error('injected rollback');}};
      const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;
    },
  })),settings)}));
  await assert.rejects(failing.finish(poll.id,evidence),/injected rollback/);
  assert.equal(await balance(f),100);assert.equal((await f.store.get(poll.id)).status,'active');
  assert.equal(await f.db.voiceReputationVote.count({where:{pollId:poll.id}}),1);
  await f.store.finish(poll.id,evidence);assert.equal(await balance(f),50);
}));

test('daily settlement and a fine serialize without losing either balance change',options,async()=>fixture(async f=>{
  const day=kyivDay(kyivDate(new Date(Date.now()-2*86400000)));const runId=randomUUID();
  await f.db.reputationTrackingRun.create({data:{id:runId,guildId:f.guildId,startedAt:day.start,verifiedThrough:day.end}});
  await f.db.reputationVoiceInterval.create({data:{guildId:f.guildId,userId:target,runId,startedAt:day.start,endedAt:new Date(day.start.getTime()+600000)}});
  const poll=await active(f);await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  await Promise.all([createSettlementStore(()=>f.db.raw).settleNextClosedDay(f.guildId,new Date()),f.store.finish(poll.id,evidence)]);
  assert.equal(await balance(f),51);
}));

test('reward unanimity credits once, permits paused targets, and records the actual ceiling-limited amount',options,async()=>fixture(async f=>{
  await f.tracking.setTracking(f.guildId,{userId:target,enabled:false},new Date());
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:4980}});
  const poll=await active(f,100,'reward');await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  const results=await Promise.all([f.store.finish(poll.id,evidence),f.store.finish(poll.id,evidence)]);
  assert.ok(results.every(result=>result.kind==='reward'&&result.appliedAmount===20&&result.balanceAfter===5000));
  assert.equal(await balance(f),5000);
  await assert.rejects(f.store.reserve({...f.request,kind:'reward'}),error=>error.code==='balance-ceiling');
  const recovered=await createVoicePollStore(()=>f.db.raw).finish(poll.id,null);assert.equal(recovered.appliedAmount,20);assert.equal(await balance(f),5000);
}));

test('database rejects legacy penalty-style processing of a reward and rolls back the debit',options,async()=>fixture(async f=>{
  const poll=await active(f,50,'reward');await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  await assert.rejects(f.db.$transaction(async tx=>{
    await tx.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:50}});
    await tx.voiceReputationPoll.update({where:{id:poll.id},data:{status:'succeeded',appliedAmount:50,balanceAfter:50}});
  }));
  assert.equal(await balance(f),100);assert.equal((await f.store.get(poll.id)).status,'active');
  const result=await f.store.finish(poll.id,evidence);assert.equal(result.balanceBefore,100);assert.equal(result.balanceAfter,150);
}));

test('rewards can raise a floor balance and do not change attendance/absence streaks',options,async()=>fixture(async f=>{
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:-500,absenceStreak:8}});
  const poll=await active(f,50,'reward');await vote(f,poll,caller,true);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));assert.equal(result.appliedAmount,50);assert.equal(await balance(f),-450);
  const member=await f.db.reputationMember.findUniqueOrThrow({where:{guildId_userId:{guildId:f.guildId,userId:target}}});assert.equal(member.absenceStreak,8);
}));

test('an eligible No vetoes a reward and only eligible No identities are frozen',options,async()=>fixture(async f=>{
  const poll=await active(f,50,'reward');await vote(f,poll,caller,true);await vote(f,poll,other,false);
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller,other]));assert.equal(result.status,'failed');assert.deepEqual(result.noVoterIds,[other]);assert.equal(await balance(f),100);
}));

test('a reward with no eligible Yes fails; missing deadline evidence cancels it',options,async()=>fixture(async f=>{
  const poll=await active(f,10,'reward');await vote(f,poll,caller,true);
  const result=await f.store.finish(poll.id,await expire(f,poll,[]));assert.equal(result.status,'failed');assert.equal(await balance(f),100);
  const next=await f.store.reserve({...f.request,kind:'reward'});const at=new Date();
  const pending=await f.store.activate(next.id,String(BigInt(f.guildId)+1n),at,{at,userIds:[target,caller,other,fourth]});
  await vote(f,pending,caller,true);await expire(f,pending,[caller]);
  assert.equal((await f.store.finish(pending.id,null)).status,'cancelled');assert.equal(await balance(f),100);
}));

test('penalty and reward reservations share one active-target limit without cooldown',options,async()=>fixture(async f=>{
  const reward=await f.store.reserve({...f.request,kind:'reward'});
  await assert.rejects(f.store.reserve(f.request),error=>error.code==='active-poll');
  await f.store.cancel(reward.id,'test');const penalty=await f.store.reserve(f.request);assert.equal(penalty.kind,'penalty');
  await assert.rejects(f.store.reserve({...f.request,kind:'reward'}),error=>error.code==='active-poll');
}));

test('wrong-kind buttons cannot cast a vote against the same saved message',options,async()=>fixture(async f=>{
  const poll=await active(f,50,'reward');
  await assert.rejects(f.store.vote({id:poll.id,guildId:f.guildId,textChannelId:poll.textChannelId,messageId:poll.messageId,userId:caller,
    yes:true,interactionId:'200000000000000001',kind:'penalty'}),error=>error.code==='invalid');
  assert.equal(await f.db.voiceReputationVote.count({where:{pollId:poll.id}}),0);
}));

test('ceiling reached during reward voting cancels rather than claiming a zero-point award',options,async()=>fixture(async f=>{
  const poll=await active(f,50,'reward');await vote(f,poll,caller,true);
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{balance:5000}});
  const result=await f.store.finish(poll.id,await expire(f,poll,[caller]));assert.equal(result.reason,'balance-ceiling');assert.equal(result.appliedAmount,0);
}));

test('erasure cancels a reward, and daily settlement serializes with a reward without losing either credit',options,async()=>fixture(async f=>{
  const poll=await active(f,50,'reward');await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  await f.tracking.deleteMemberData(f.guildId,target,new Date());assert.equal((await f.store.finish(poll.id,evidence)).status,'cancelled');assert.equal(await balance(f),0);
  await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:target}},data:{isTracking:true,hasParticipated:true}});
  const day=kyivDay(kyivDate(new Date(Date.now()-2*86400000))),runId=randomUUID();
  await f.db.reputationTrackingRun.create({data:{id:runId,guildId:f.guildId,startedAt:day.start,verifiedThrough:day.end}});
  await f.db.reputationVoiceInterval.create({data:{guildId:f.guildId,userId:target,runId,startedAt:day.start,endedAt:new Date(day.start.getTime()+600000)}});
  const reserved=await f.store.reserve({...f.request,kind:'reward'});const at=new Date();
  const next=await f.store.activate(reserved.id,String(BigInt(f.guildId)+1n),at,{at,userIds:[target,caller,other,fourth]});await vote(f,next,caller,true);
  const snapshot=await expire(f,next,[caller]);await Promise.all([f.store.finish(next.id,snapshot),createSettlementStore(()=>f.db.raw).settleNextClosedDay(f.guildId,new Date())]);
  assert.equal(await balance(f),51);
}));

for(const kind of ['penalty','reward']){
  test(`${kind} reason is normalized, durable across restart, and retained with an exactly-once success`,options,async()=>fixture(async f=>{
    f.request.proposalReason='  Допомога команді\nз поясненням  ';
    const poll=await active(f,50,kind);await vote(f,poll,caller,true);
    const restarted=createVoicePollStore(()=>f.db.raw);
    assert.equal((await restarted.get(poll.id)).proposalReason,'Допомога команді\nз поясненням');
    const evidence=await expire(f,poll,[caller]);
    const result=await restarted.finish(poll.id,evidence);
    assert.equal(result.proposalReason,'Допомога команді\nз поясненням');
    assert.equal(result.status,'succeeded');
    assert.equal((await restarted.finish(poll.id,null)).proposalReason,result.proposalReason);
    assert.equal(await balance(f),kind==='penalty'?50:150);
  }));
  test(`${kind} failure discards the proposal reason but retains eligible veto identities`,options,async()=>fixture(async f=>{
    const poll=await active(f,50,kind);await vote(f,poll,caller,true);await vote(f,poll,other,false);
    const result=await f.store.finish(poll.id,await expire(f,poll,[caller,other]));
    assert.equal(result.status,'failed');assert.equal(result.proposalReason,null);
    assert.deepEqual(result.noVoterIds,[other]);assert.equal(await balance(f),100);
  }));
}

test('missing/blank/oversized reasons cannot reserve polls or change balances',options,async()=>fixture(async f=>{
  for(const proposalReason of [null,undefined,'',' \t\n','x'.repeat(1001)]){
    await assert.rejects(f.store.reserve({...f.request,proposalReason}),error=>error.code==='invalid-reason');
  }
  assert.equal(await f.db.voiceReputationPoll.count({where:{guildId:f.guildId}}),0);
  assert.equal(await balance(f),100);
}));

test('the database rejects empty or whitespace-only reasons and accepts the Unicode maximum',options,async()=>fixture(async f=>{
  const poll=await f.store.reserve({...f.request,proposalReason:'🙂'.repeat(1000)});
  assert.equal(poll.proposalReason,'🙂'.repeat(1000));
  for(const proposalReason of ['',' \t\n','x'.repeat(1001)]){
    await assert.rejects(f.db.voiceReputationPoll.update({where:{id:poll.id},data:{proposalReason}}));
  }
  assert.equal((await f.store.get(poll.id)).proposalReason,poll.proposalReason);
}));

test('cancellation and an unverified start clear reasons without overwriting cancellation codes',options,async()=>fixture(async f=>{
  const reserved=await f.store.reserve(f.request);
  const cancelled=await f.store.cancel(reserved.id,'message-missing');
  assert.equal(cancelled.proposalReason,null);assert.equal(cancelled.reason,'message-missing');
  const next=await f.store.reserve(f.request),at=new Date();
  const invalid=await f.store.activate(next.id,f.guildId,at,{at,userIds:[target,caller,other]});
  assert.equal(invalid.proposalReason,null);assert.equal(invalid.reason,'start-unverified');
}));

test('author erasure clears reasons awaiting final publication without cancelling others’ votes',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,other,true);
  await f.tracking.deleteMemberData(f.guildId,caller,new Date());
  assert.equal((await f.store.get(poll.id)).proposalReason,null);
  const result=await f.store.finish(poll.id,await expire(f,poll,[other]));
  assert.equal(result.status,'succeeded');assert.equal(result.proposalReason,null);
}));

test('uncertain successful reason delivery blocks author erasure; published reasons remain public history',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);
  await f.store.finish(poll.id,await expire(f,poll,[caller]));await f.store.prepareDelivery(poll.id);
  await assert.rejects(f.tracking.deleteMemberData(f.guildId,caller,new Date()),PublicationPendingError);
  await f.store.delivered(poll.id,false);await f.tracking.deleteMemberData(f.guildId,caller,new Date());
  assert.equal((await f.store.get(poll.id)).proposalReason,f.request.proposalReason);
}));

test('lost final transaction acknowledgement/restart returns the durable result without reapplying money',options,async()=>fixture(async f=>{
  const poll=await active(f);await vote(f,poll,caller,true);const evidence=await expire(f,poll,[caller]);
  const first=await f.store.finish(poll.id,evidence);
  const restarted=createVoicePollStore(()=>f.db.raw);const again=await restarted.finish(poll.id,null);
  assert.equal(again.appliedAmount,first.appliedAmount);assert.equal(await balance(f),50);
  assert.ok((await restarted.pending(f.guildId)).some(row=>row.id===poll.id));
  await restarted.delivered(poll.id,true);assert.equal((await restarted.pending(f.guildId)).length,0);
}));
