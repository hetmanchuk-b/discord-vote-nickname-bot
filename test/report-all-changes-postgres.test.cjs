const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt, randomUUID } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { createReportStore } = require('../dist/reputation/report-store.js');
const { createTrackingStore } = require('../dist/reputation/tracking-store.js');
const { kyivDay } = require('../dist/reputation/kyiv-day.js');
const url=process.env.REPUTATION_TEST_DATABASE_URL;
const options={skip:!url&&'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated database.'};
const users=Array.from({length:9},(_,i)=>`71000000000000000${i}`);
async function fixture(callback,date='2026-11-11'){
 const db=createReputationDatabase(url),guildId=`${Date.now()}${randomInt(100000,999999)}`,day=kyivDay(date),store=createReportStore(()=>db);
 try{
  await db.reputationGuild.create({data:{guildId,reportChannelId:'720000000000000001'}});
  await db.reputationMember.createMany({data:users.map(userId=>({guildId,userId,balance:400,hasParticipated:true,createdAt:new Date(day.start.getTime()-2*86400000)}))});
  await db.reputationSettlement.create({data:{guildId,day:day.day,startedAt:day.start,endedAt:day.end,verifiedMs:day.end-day.start,incomplete:false,activityMs:600000n,pointsAwarded:0}});
  const points=[4,-20,0,-40,0,0,0,0,0];
  await db.reputationDailyAward.createMany({data:users.map((userId,i)=>({guildId,userId,day:day.day,eligibleMs:i===0?600000:0,soloMs:i===0?200000:0,points:points[i],balanceAfter:i===0?564:i===1?380:i===2?360:i===6?20000:400,absencePenalty:points[i]<0?-points[i]:0,exempt:i===2}))});
  async function poll(index,kind,applied,closedAt=new Date(day.start.getTime()+3600000),extra={}){
   const before=applied===1&&kind==='reward'?19999:400;
   return db.voiceReputationPoll.create({data:{id:randomUUID(),guildId,targetId:users[index],initiatorId:'799999999999999999',voiceChannelId:'730000000000000001',textChannelId:'720000000000000001',
    kind,amount:applied>40?200:40,status:'succeeded',appliedAmount:applied,balanceBefore:before,balanceAfter:before+(kind==='reward'?applied:-applied),
    createdAt:new Date(closedAt.getTime()-120000),closedAt,proposalReason:'Public result',...extra}});
  }
  async function prepare(){const[report]=await store.pending(guildId);await store.attachMessage(report.id,'720000000000000001','740000000000000001');await store.prepare(report.id);return store.snapshot(report.id,0);}
  await callback({db,guildId,day,store,poll,prepare});
 }finally{try{
  await db.reputationReport.deleteMany({where:{guildId}});await db.voiceReputationPoll.deleteMany({where:{guildId}});
  await db.reputationDailyAward.deleteMany({where:{guildId}});await db.reputationSettlement.deleteMany({where:{guildId}});
  await db.reputationTrackingPause.deleteMany({where:{guildId}});await db.reputationMember.deleteMany({where:{guildId}});await db.reputationGuild.deleteMany({where:{guildId}});
 }finally{await db.$disconnect();}}
}
test('all daily changes include actual absence fines, vote-only paused users, zero-net movements, and capped quarter rewards',options,async()=>fixture(async f=>{
 await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:users[2]}},data:{isTracking:false}});
 await f.poll(0,'reward',200);await f.poll(0,'penalty',40);
 await f.poll(2,'penalty',40);await f.poll(3,'reward',40);await f.poll(4,'reward',40);await f.poll(4,'penalty',40);await f.poll(6,'reward',1);
 const before=await f.db.reputationMember.findMany({where:{guildId:f.guildId},orderBy:{userId:'asc'}});
 const snapshot=await f.prepare();
 assert.equal(snapshot.report.formatVersion,2);assert.equal(snapshot.report.pageSize,15);
 assert.deepEqual(snapshot.entries.map(row=>[row.userId,row.points]),[[users[0],41],[users[6],0.25],[users[3],0],[users[4],0],[users[1],-5],[users[2],-10]]);
 assert.equal(snapshot.report.pointsAwarded,26.25);
 assert.equal(snapshot.entries[0].dailyPoints,1);assert.equal(snapshot.entries[0].voteRewards,50);assert.equal(snapshot.entries[0].votePenalties,10);
 assert.equal(snapshot.entries[0].balanceAfter,141);assert.equal(snapshot.entries[0].soloMs,200000);
 assert.equal(snapshot.entries[5].eligibleMs,0);assert.equal(snapshot.entries[5].votePenalties,10);
 assert.deepEqual(await f.db.reputationMember.findMany({where:{guildId:f.guildId},orderBy:{userId:'asc'}}),before);
 assert.equal((await f.db.reputationReportEntry.findMany({where:{reportId:snapshot.report.id},orderBy:{position:'asc'}}))[0].voteRewards,200);
 await f.store.finish(snapshot.report.id);await createTrackingStore(()=>f.db).deleteMemberData(f.guildId,users[0],new Date());
 const restarted=createReportStore(()=>f.db);assert.deepEqual((await restarted.snapshot(snapshot.report.id,0)).entries,snapshot.entries);
}));
test('unfrozen legacy reports upgrade to fifteen per page, but freezing remains exactly once',options,async()=>fixture(async f=>{
 const [report]=await f.store.pending(f.guildId);
 await f.db.reputationReport.update({where:{id:report.id},data:{pageSize:10,formatVersion:1}});
 await f.store.attachMessage(report.id,'720000000000000001','740000000000000001');
 await f.store.prepare(report.id);
 const first=await f.store.snapshot(report.id,0);
 assert.equal(first.report.pageSize,15);assert.equal(first.report.formatVersion,2);
 await f.poll(0,'reward',200); // Later history cannot mutate a frozen report.
 await f.store.prepare(report.id);
 assert.deepEqual((await f.store.snapshot(report.id,0)).entries,first.entries);
}));
for(const date of ['2026-03-29','2026-10-25'])test(`vote day attribution uses half-open Kyiv boundaries on ${date}, not proposal/deadline/publication`,options,async()=>fixture(async f=>{
 await f.poll(0,'reward',40,f.day.start,{publishedAt:new Date(f.day.end.getTime()+3600000),endsAt:new Date(f.day.start.getTime()-1)});
 await f.poll(0,'reward',40,new Date(f.day.start.getTime()-1));await f.poll(0,'reward',40,f.day.end);
 await f.poll(0,'reward',40,new Date(f.day.start.getTime()+3600000),{status:'failed',appliedAmount:0,balanceBefore:null,balanceAfter:null});
 const snapshot=await f.prepare(),entry=snapshot.entries.find(row=>row.userId===users[0]);
 assert.equal(entry.voteRewards,10);assert.equal(entry.rewardVoteCount,1);assert.equal(entry.points,11);
 assert.equal(snapshot.report.pointsAwarded,-4); // +1 automatic -5 absence -10 absence +10 vote.
},date));
test('retained votes cannot resurrect erased daily rows or an earlier identity after re-enrollment',options,async()=>fixture(async f=>{
 const old=await f.poll(8,'reward',200,new Date(f.day.start.getTime()+7200001),{publishedAt:new Date(f.day.start.getTime()+7200002)});
 const eraseAt=new Date(f.day.start.getTime()+7200000);
 await createTrackingStore(()=>f.db).deleteMemberData(f.guildId,users[8],eraseAt);
 await f.db.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:users[8]}},data:{hasParticipated:true,isTracking:true}});
 await f.db.reputationDailyAward.create({data:{guildId:f.guildId,userId:users[8],day:f.day.day,eligibleMs:0,points:0,balanceAfter:40}});
 await f.poll(8,'reward',40,new Date(eraseAt.getTime()+3600000));
 await f.poll(7,'reward',200);await f.db.reputationDailyAward.delete({where:{guildId_userId_day:{guildId:f.guildId,userId:users[7],day:f.day.day}}});
 const snapshot=await f.prepare(),entry=snapshot.entries.find(row=>row.userId===users[8]);
 assert.equal(entry.voteRewards,10);assert.equal(entry.rewardVoteCount,1);assert.ok(!snapshot.entries.some(row=>row.userId===users[7]));
 assert.equal((await f.db.voiceReputationPoll.findUniqueOrThrow({where:{id:old.id}})).appliedAmount,200);
}));
