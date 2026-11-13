const assert=require('node:assert/strict');
const {test}=require('node:test');
const process=require('node:process');
const {randomInt,randomUUID}=require('node:crypto');
const {createReputationDatabase}=require('../dist/reputation/database.js');
const {createIntervalRetentionStore,RAW_INTERVAL_RETENTION_MS,INTERVAL_RETENTION_BATCH_SIZE}=require('../dist/reputation/interval-retention.js');
const {createSettlementStore}=require('../dist/reputation/settlement-store.js');
const {createReportStore}=require('../dist/reputation/report-store.js');
const {createMemberStore}=require('../dist/reputation/member-store.js');
const {settleAttendance}=require('../dist/reputation/attendance-rules.js');
const {kyivDay,nextCalendarDate}=require('../dist/reputation/kyiv-day.js');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.'};
const john='111111111111111111',unknown='222222222222222222';
const at=new Date('2026-11-21T12:00:00Z');
const cutoff=new Date(at.getTime()-RAW_INTERVAL_RETENTION_MS);
async function fixture(callback){
  const db=createReputationDatabase(url),guildId=`${Date.now()}${randomInt(100000,999999)}`,runId=randomUUID();
  const store=createIntervalRetentionStore(()=>db);
  try{
    await db.reputationGuild.create({data:{guildId,settledThrough:kyivDay('2026-11-20').end,reportChannelId:'333333333333333333'}});
    let state={balance:0,hasParticipated:false,attendanceStreak:0,absenceStreak:0},date='2026-11-01';
    const days=[],results=[];
    for(let i=0;i<20;i++){
      const day=kyivDay(date),result=settleAttendance(state,600000,false);
      days.push(day);results.push(result);state={...result,balance:result.balanceAfter};date=nextCalendarDate(date);
    }
    await db.reputationMember.createMany({data:[{guildId,userId:john,balance:state.balance,hasParticipated:true,attendanceStreak:state.attendanceStreak},{guildId,userId:unknown}]});
    await db.reputationTrackingRun.create({data:{id:runId,guildId,startedAt:days[0].start,verifiedThrough:at}});
    await db.reputationSettlement.createMany({data:days.map((day,i)=>({guildId,day:day.day,startedAt:day.start,endedAt:day.end,verifiedMs:day.end-day.start,incomplete:false,activityMs:600000n,pointsAwarded:results[i].points}))});
    await db.reputationDailyAward.createMany({data:results.map((result,i)=>({
      guildId,userId:john,day:days[i].day,eligibleMs:result.eligibleMs,points:result.points,balanceAfter:result.balanceAfter,
      basePoints:result.basePoints,attendanceBonus:result.attendanceBonus,absencePenalty:result.absencePenalty,
      attendanceStreak:result.attendanceStreak,absenceStreak:result.absenceStreak,exempt:result.exempt,
    }))});
    const interval=(endedAt,userId=john,startedAt=new Date(endedAt.getTime()-600000))=>db.reputationVoiceInterval.create({data:{guildId,userId,runId,startedAt,endedAt}});
    await callback({db,guildId,runId,store,interval});
  }finally{try{
    await db.reputationReport.deleteMany({where:{guildId}});
    await db.reputationDailyAward.deleteMany({where:{guildId}});
    await db.reputationSettlement.deleteMany({where:{guildId}});
    await db.reputationVoiceInterval.deleteMany({where:{guildId}});
    await db.reputationTrackingRun.deleteMany({where:{guildId}});
    await db.reputationMember.deleteMany({where:{guildId}});
    await db.reputationGuild.deleteMany({where:{guildId}});
  }finally{await db.$disconnect();}}
}
async function history(f){
  return {
    members:await f.db.reputationMember.findMany({where:{guildId:f.guildId},orderBy:{userId:'asc'}}),
    awards:await f.db.reputationDailyAward.findMany({where:{guildId:f.guildId},orderBy:[{userId:'asc'},{day:'asc'}]}),
    settlements:await f.db.reputationSettlement.findMany({where:{guildId:f.guildId},orderBy:{day:'asc'}}),
    reports:await f.db.reputationReport.findMany({where:{guildId:f.guildId},orderBy:{day:'asc'}}),
    entries:await f.db.reputationReportEntry.findMany({where:{guildId:f.guildId},orderBy:[{reportId:'asc'},{position:'asc'}]}),
    runs:await f.db.reputationTrackingRun.findMany({where:{guildId:f.guildId},orderBy:{id:'asc'}}),
  };
}

test('retention deletes only fully ended expired raw rows; daily graphs, balances, streaks, reports and other guilds survive',options,async()=>fixture(async f=>fixture(async other=>{
  const old=await f.interval(new Date(cutoff.getTime()-1));
  const exact=await f.interval(cutoff);
  const crossing=await f.interval(new Date(cutoff.getTime()+1),john,new Date(cutoff.getTime()-600000));
  const today=await f.interval(at);
  const unenrolled=await f.interval(new Date(cutoff.getTime()-1),unknown);
  const foreign=await other.interval(new Date(cutoff.getTime()-1));
  const reports=createReportStore(()=>f.db),[report]=await reports.pending(f.guildId);
  await reports.attachMessage(report.id,'333333333333333333','444444444444444444');
  await reports.prepare(report.id);await reports.finish(report.id);
  const before=await history(f),list=await createMemberStore(()=>f.db).getAll(f.guildId);
  assert.deepEqual(await f.store.prune(f.guildId,at),{deletedCount:2,hasMore:false});
  assert.equal(await f.db.reputationVoiceInterval.count({where:{id:{in:[old.id,exact.id]}}}),0);
  assert.deepEqual((await f.db.reputationVoiceInterval.findMany({where:{guildId:f.guildId},orderBy:{id:'asc'}})).map(row=>row.id),[crossing.id,today.id,unenrolled.id]);
  assert.ok(await other.db.reputationVoiceInterval.findUnique({where:{id:foreign.id}}));
  assert.deepEqual(await history(f),before);
  assert.deepEqual(await createMemberStore(()=>f.db).getAll(f.guildId),list);
  assert.equal((await f.db.reputationVoiceInterval.findUniqueOrThrow({where:{id:crossing.id}})).startedAt.getTime(),crossing.startedAt.getTime());
  assert.equal(await createSettlementStore(()=>f.db).settleNextClosedDay(f.guildId,at),null);
})));

test('retention never deletes old but unsettled time, including an interval crossing the settlement watermark',options,async()=>fixture(async f=>{
  const watermark=kyivDay('2026-11-01').end;
  await f.db.reputationGuild.update({where:{guildId:f.guildId},data:{settledThrough:watermark}});
  const settled=await f.interval(watermark);
  const crossing=await f.interval(new Date(watermark.getTime()+1),john,new Date(watermark.getTime()-600000));
  const unsettled=await f.interval(new Date(watermark.getTime()+600000));
  assert.deepEqual(await f.store.prune(f.guildId,at),{deletedCount:1,hasMore:false});
  assert.equal(await f.db.reputationVoiceInterval.findUnique({where:{id:settled.id}}),null);
  assert.equal(await f.db.reputationVoiceInterval.count({where:{id:{in:[crossing.id,unsettled.id]}}}),2);
}));

test('no watermark or a malformed watermark never permits retention deletion',options,async()=>fixture(async f=>{
  const row=await f.interval(new Date(cutoff.getTime()-1));
  await f.db.reputationGuild.update({where:{guildId:f.guildId},data:{settledThrough:null}});
  assert.deepEqual(await f.store.prune(f.guildId,at),{deletedCount:0,hasMore:false});
  await f.db.reputationGuild.update({where:{guildId:f.guildId},data:{settledThrough:new Date('2026-11-02T12:00:00Z')}});
  await assert.rejects(f.store.prune(f.guildId,at),/Invalid retention settlement watermark/);
  assert.ok(await f.db.reputationVoiceInterval.findUnique({where:{id:row.id}}));
}));

test('concurrent cleanup drains bounded batches and restarts idempotently',options,async()=>fixture(async f=>{
  const count=INTERVAL_RETENTION_BATCH_SIZE+7;
  await f.db.reputationVoiceInterval.createMany({data:Array.from({length:count},()=>({guildId:f.guildId,userId:john,runId:f.runId,startedAt:new Date(cutoff.getTime()-600000),endedAt:cutoff}))});
  const results=await Promise.all([f.store.prune(f.guildId,at),createIntervalRetentionStore(()=>f.db).prune(f.guildId,at)]);
  assert.deepEqual(results.map(result=>result.deletedCount).sort((a,b)=>a-b),[7,INTERVAL_RETENTION_BATCH_SIZE]);
  assert.equal(results.filter(result=>result.hasMore).length,1);
  assert.equal(await f.db.reputationVoiceInterval.count({where:{guildId:f.guildId}}),0);
  assert.deepEqual(await createIntervalRetentionStore(()=>f.db).prune(f.guildId,at),{deletedCount:0,hasMore:false});
}));

test('a failed cleanup transaction rolls back deletions and retries without altering daily history',options,async()=>fixture(async f=>{
  const row=await f.interval(cutoff),before=await history(f);
  const failing=createIntervalRetentionStore(()=>({$transaction:(callback,settings)=>f.db.$transaction(tx=>callback(new Proxy(tx,{
    get(object,key){
      if(key==='reputationVoiceInterval')return{
        findMany:args=>object.reputationVoiceInterval.findMany(args),
        deleteMany:async args=>{await object.reputationVoiceInterval.deleteMany(args);throw new Error('injected retention rollback');},
      };
      const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;
    },
  })),settings)}));
  await assert.rejects(failing.prune(f.guildId,at),/injected retention rollback/);
  assert.ok(await f.db.reputationVoiceInterval.findUnique({where:{id:row.id}}));assert.deepEqual(await history(f),before);
  assert.equal((await f.store.prune(f.guildId,at)).deletedCount,1);
  assert.deepEqual(await history(f),before);
}));
