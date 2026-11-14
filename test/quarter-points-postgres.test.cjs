const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const {randomInt}=require('node:crypto');
// Deliberately raw: these tests assert actual stored quarter units, not the
// display-point fixture adapter used by the pre-conversion regression suite.
const {createReputationDatabase}=require('../dist/reputation/database.js');
const {createTrackingStore}=require('../dist/reputation/tracking-store.js');
const {createSettlementStore}=require('../dist/reputation/settlement-store.js');
const {createMemberStore}=require('../dist/reputation/member-store.js');
const {createReportStore}=require('../dist/reputation/report-store.js');
const {createVoicePollStore}=require('../dist/reputation/voice-poll-store.js');
const {createIntervalRetentionStore}=require('../dist/reputation/interval-retention.js');
const {renderReport}=require('../dist/reputation/report-render.js');
const {renderVoicePoll}=require('../dist/reputation/voice-poll-render.js');
const {toPointUnits,formatPoints}=require('../dist/reputation/point-units.js');
const {kyivDay}=require('../dist/reputation/kyiv-day.js');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.'};
const a='111111111111111111',b='222222222222222222',caller='333333333333333333',fourth='444444444444444444';
const MINUTE=60000;
async function fixture(callback,date='2026-11-01'){
  const db=createReputationDatabase(url),guildId=`${Date.now()}${randomInt(100000,999999)}`,day=kyivDay(date);
  const tracking=createTrackingStore(()=>db),settlement=createSettlementStore(()=>db),members=createMemberStore(()=>db);
  try{
    const {runId}=await tracking.openRun(guildId,day.start);
    let cursor=day.start;
    const checkpoint=async(to,userIds,soloUserIds=[])=>{await tracking.checkpoint({guildId,runId,from:cursor,to,userIds,soloUserIds});cursor=to;};
    await callback({db,guildId,day,runId,tracking,settlement,members,checkpoint,at:minutes=>new Date(day.start.getTime()+minutes*MINUTE)});
  }finally{try{
    await db.voiceReputationPoll.deleteMany({where:{guildId}});
    await db.reputationReport.deleteMany({where:{guildId}});
    await db.reputationDailyAward.deleteMany({where:{guildId}});
    await db.reputationSettlement.deleteMany({where:{guildId}});
    await db.reputationVoiceInterval.deleteMany({where:{guildId}});
    await db.reputationTrackingRun.deleteMany({where:{guildId}});
    await db.reputationMember.deleteMany({where:{guildId}});
    await db.reputationGuild.deleteMany({where:{guildId}});
  }finally{await db.$disconnect();}}
}
const rawMember=f=>f.db.reputationMember.findUniqueOrThrow({where:{guildId_userId:{guildId:f.guildId,userId:a}}});

test('30 solo minutes plus 10 group minutes persist seven units and display 1.75 points without altering attendance time',options,async()=>fixture(async f=>{
  await f.checkpoint(f.at(30),[a],[a]);await f.checkpoint(f.at(40),[a,b]);
  const today=await f.members.getToday(f.guildId,a,f.at(40));
  assert.equal(today.eligibleMs,40*MINUTE);assert.equal(today.pendingPoints,1.75);
  const intervals=await f.db.reputationVoiceInterval.findMany({where:{guildId:f.guildId,userId:a},orderBy:{startedAt:'asc'}});
  assert.deepEqual(intervals.map(row=>row.earningRate),[1,4]);
  await f.checkpoint(f.day.end,[]);
  const result=await f.settlement.settleNextClosedDay(f.guildId,f.day.end);
  assert.equal(result.pointsAwarded,2.75);assert.equal((await rawMember(f)).balance,7);
  assert.equal(await f.members.getBalance(f.guildId,a),1.75);
  const award=await f.db.reputationDailyAward.findUniqueOrThrow({where:{guildId_userId_day:{guildId:f.guildId,userId:a,day:f.day.day}}});
  assert.equal(award.points,7);assert.equal(award.basePoints,7);assert.equal(award.soloMs,30*MINUTE);
  assert.equal(award.eligibleMs,40*MINUTE);assert.equal(award.attendanceStreak,1);
  await f.db.reputationGuild.update({where:{guildId:f.guildId},data:{reportChannelId:caller}});
  const reports=createReportStore(()=>f.db),[report]=await reports.pending(f.guildId);
  await reports.attachMessage(report.id,caller,fourth);await reports.prepare(report.id);await reports.finish(report.id);
  const snapshot=await reports.snapshot(report.id,0);
  assert.equal(snapshot.entries[0].points,1.75);assert.equal(snapshot.entries[0].balanceAfter,1.75);
  assert.match(renderReport(snapshot).embeds[0].toJSON().fields[0].value,new RegExp(formatPoints(1.75)));
  assert.equal((await f.db.reputationReportEntry.findUniqueOrThrow({where:{reportId_position:{reportId:report.id,position:0}}})).points,7);
  assert.equal(await f.settlement.settleNextClosedDay(f.guildId,f.day.end),null);
  await createIntervalRetentionStore(()=>f.db).prune(f.guildId,new Date(f.day.end.getTime()+15*86400000));
  assert.equal(await f.db.reputationVoiceInterval.count({where:{guildId:f.guildId}}),0);
  assert.deepEqual(await f.db.reputationDailyAward.findUniqueOrThrow({where:{guildId_userId_day:{guildId:f.guildId,userId:a,day:f.day.day}}}),award);
}));

test('mixed sub-quarter solo and group time combine before the single daily rounding',options,async()=>fixture(async f=>{
  await f.checkpoint(f.at(5),[a],[a]);await f.checkpoint(f.at(6.25),[a,b]);await f.checkpoint(f.day.end,[]);
  await f.settlement.settleNextClosedDay(f.guildId,f.day.end);
  assert.equal((await rawMember(f)).balance,1);assert.equal(await f.members.getBalance(f.guildId,a),0.25);
}));

for(const date of ['2026-03-29','2026-10-25']){
  test(`solo/group settlement respects the actual DST day ${date}`,options,async()=>fixture(async f=>{
    await f.checkpoint(f.at(30),[a],[a]);await f.checkpoint(f.at(40),[a,b]);await f.checkpoint(f.day.end,[]);
    assert.equal((await f.settlement.settleNextClosedDay(f.guildId,f.day.end)).incomplete,false);
    assert.equal((await rawMember(f)).balance,7);
  },date));
}

test('a solo interval crossing midnight is clipped into separate days without carrying sub-quarter remainders',options,async()=>fixture(async f=>{
  const tomorrow=kyivDay('2026-11-02');
  await f.checkpoint(new Date(f.day.end.getTime()-9*MINUTE),[]);
  await f.checkpoint(new Date(f.day.end.getTime()+9*MINUTE),[a],[a]);
  await f.checkpoint(tomorrow.end,[]);
  await f.settlement.settleNextClosedDay(f.guildId,tomorrow.end);
  await f.settlement.settleNextClosedDay(f.guildId,tomorrow.end);
  const rows=await f.db.reputationDailyAward.findMany({where:{guildId:f.guildId,userId:a},orderBy:{day:'asc'}});
  assert.deepEqual(rows.map(row=>[row.eligibleMs,row.soloMs,row.points]),[[9*MINUTE,9*MINUTE,0],[9*MINUTE,9*MINUTE,0]]);
  assert.equal((await rawMember(f)).balance,0);assert.equal((await rawMember(f)).attendanceStreak,2);
}));

test('persisted opt-outs still block solo earnings while stored group time keeps its rate',options,async()=>fixture(async f=>{
  await f.checkpoint(f.at(10),[a],[a]);
  await f.tracking.setTracking(f.guildId,{userId:a,enabled:false},f.at(10));
  await f.checkpoint(f.at(20),[a,b]);
  await f.tracking.setTracking(f.guildId,{userId:a,enabled:true},f.at(20));
  await f.checkpoint(f.at(30),[a,b]);await f.checkpoint(f.day.end,[]);
  await f.settlement.settleNextClosedDay(f.guildId,f.day.end);
  const award=await f.db.reputationDailyAward.findUniqueOrThrow({where:{guildId_userId_day:{guildId:f.guildId,userId:a,day:f.day.day}}});
  assert.equal(award.eligibleMs,20*MINUTE);assert.equal(award.soloMs,10*MINUTE);assert.equal(award.basePoints,5);
  assert.equal(award.exempt,true);assert.equal(award.attendanceBonus,0);
}));

for(const kind of ['penalty','reward']){
  test(`${kind} applies an exact quarter at the balance bound, preserving displayed choices and exactly-once audit`,options,async()=>fixture(async f=>{
    await f.db.reputationMember.create({data:{guildId:f.guildId,userId:a,hasParticipated:true,isTracking:false,
      balance:toPointUnits(kind==='penalty'?-499.75:4999.75),attendanceStreak:7}});
    const store=createVoicePollStore(()=>f.db);
    const reserved=await store.reserve({guildId:f.guildId,targetId:a,initiatorId:caller,voiceChannelId:caller,textChannelId:fourth,amount:50,kind,proposalReason:'Перевірка чверті бала'});
    assert.equal(reserved.amount,50);
    const startedAt=new Date(),poll=await store.activate(reserved.id,f.guildId,startedAt,{at:startedAt,userIds:[a,b,caller,fourth]});
    await store.vote({id:poll.id,guildId:f.guildId,textChannelId:fourth,messageId:poll.messageId,userId:caller,kind,yes:true,interactionId:'200000000000000001'});
    const end=new Date(Date.now()-100);
    await f.db.voiceReputationPoll.update({where:{id:poll.id},data:{startedAt:new Date(end.getTime()-120000),endsAt:end}});
    const result=await store.finish(poll.id,{at:new Date(),userIds:[caller]});
    assert.equal(result.appliedAmount,0.25);assert.equal(result.balanceAfter,kind==='penalty'?-500:5000);
    assert.equal((await rawMember(f)).balance,kind==='penalty'?-2000:20000);
    assert.equal((await rawMember(f)).attendanceStreak,7);
    const saved=await f.db.voiceReputationPoll.findUniqueOrThrow({where:{id:poll.id}});
    assert.equal(saved.amount,200);assert.equal(saved.appliedAmount,1);
    assert.equal((await createVoicePollStore(()=>f.db).finish(poll.id,null)).appliedAmount,0.25);
    assert.match(renderVoicePoll(result).embeds[0].toJSON().description,new RegExp(formatPoints(0.25)));
  }));
}

test('raw-unit bounds and allowed earning rates are enforced by PostgreSQL',options,async()=>fixture(async f=>{
  await f.checkpoint(f.at(10),[a],[a]);
  for(const balance of [-2001,20001])await assert.rejects(f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:a}},data:{balance}}));
  const row=await f.db.reputationVoiceInterval.findFirstOrThrow({where:{guildId:f.guildId}});
  await assert.rejects(f.db.reputationVoiceInterval.update({where:{id:row.id},data:{earningRate:2}}));
  await assert.rejects(f.db.$executeRawUnsafe(`UPDATE reputation_members SET balance=100 WHERE guild_id='${f.guildId}'`));
  assert.equal((await rawMember(f)).balance,0);
}));
