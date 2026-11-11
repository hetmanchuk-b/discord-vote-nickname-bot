const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt, randomUUID } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { createTrackingStore } = require('../dist/reputation/tracking-store.js');
const { createSettlementStore } = require('../dist/reputation/settlement-store.js');
const { createReportStore } = require('../dist/reputation/report-store.js');
const { kyivDay, nextCalendarDate } = require('../dist/reputation/kyiv-day.js');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.' };
const john = '111111111111111111';
const nathan = '222222222222222222';

async function fixture(callback) {
  const database = createReputationDatabase(url);
  const guildId = `${Date.now()}${randomInt(100000,999999)}`;
  const tracking = createTrackingStore(() => database);
  const settlement = createSettlementStore(() => database);
  try { await callback({ database, guildId, tracking, settlement }); }
  finally {
    try {
      await database.reputationReport.deleteMany({ where: { guildId } });
      await database.reputationDailyAward.deleteMany({ where: { guildId } });
      await database.reputationSettlement.deleteMany({ where: { guildId } });
      await database.reputationVoiceInterval.deleteMany({ where: { guildId } });
      await database.reputationTrackingRun.deleteMany({ where: { guildId } });
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally { await database.$disconnect(); }
  }
}

// Fixture coverage represents continuous observation, not voice time. Activity
// is seeded separately, in one-millisecond visits unless a duration is supplied.
async function timeline(f, count, activities, date = '2026-11-01') {
  const days = [];
  for (let index = 0; index < count; index++) { days.push(kyivDay(date)); date = nextCalendarDate(date); }
  const { runId } = await f.tracking.openRun(f.guildId, days[0].start);
  await f.tracking.checkpoint({ guildId:f.guildId, runId, from:days[0].start, to:days.at(-1).end, userIds:[] });
  await f.database.reputationMember.createMany({ data:[john,nathan].map(userId => ({ guildId:f.guildId, userId })) });
  if (activities.length) await f.database.reputationVoiceInterval.createMany({ data:activities.map(activity => ({
    guildId:f.guildId, userId:activity.userId ?? john, runId,
    startedAt:new Date(days[activity.day].start.getTime() + 60_000),
    endedAt:new Date(days[activity.day].start.getTime() + 60_000 + (activity.ms ?? 1)),
  })) });
  return { days, runId, at:days.at(-1).end };
}
async function settleAll(f, at) {
  for (let count = 0; count < 100; count++) if (!await f.settlement.settleNextClosedDay(f.guildId,at)) return;
  throw new Error('Catch-up did not finish.');
}
const member = f => f.database.reputationMember.findUniqueOrThrow({ where:{ guildId_userId:{ guildId:f.guildId,userId:john } } });
const awards = f => f.database.reputationDailyAward.findMany({ where:{ guildId:f.guildId,userId:john },orderBy:{ day:'asc' } });

test('chronological catch-up awards day 3/10/17 bonuses for tiny visits, never charging an unknown participant', options, async () => fixture(async f => {
  const t = await timeline(f,17,Array.from({length:17},(_,day)=>({day})));
  await settleAll(f,t.at);
  const rows = await awards(f);
  assert.deepEqual(rows.map(row=>row.attendanceBonus),[0,0,5,5,5,5,5,5,5,6,6,6,6,6,6,6,7]);
  assert.ok(rows.every(row=>row.eligibleMs===1 && row.basePoints===0 && !row.exempt));
  assert.equal((await member(f)).balance,84);
  assert.equal((await member(f)).attendanceStreak,17);
  assert.equal(await f.database.reputationDailyAward.count({where:{guildId:f.guildId,userId:nathan}}),0);
  assert.equal(await f.settlement.settleNextClosedDay(f.guildId,t.at),null);
}));

test('only previous participants receive absence penalties, day 8 escalates, and return resets absence', options, async () => fixture(async f => {
  const t = await timeline(f,12,[{day:0,ms:600_000},{day:10}]);
  await settleAll(f,t.at);
  const rows = await awards(f);
  assert.equal(rows[0].points,1);
  assert.equal(rows[7].absencePenalty,5);
  assert.equal(rows[8].absencePenalty,10);
  assert.equal(rows[9].absenceStreak,9);
  assert.equal(rows[10].absenceStreak,0);
  assert.equal(rows[10].attendanceStreak,1);
  assert.equal(rows[11].absencePenalty,5);
  assert.equal((await member(f)).balance,-59);
}));

test('pause history exempts entire overlapped days even after resuming before delayed settlement', options, async () => fixture(async f => {
  const t = await timeline(f,5,[{day:0},{day:1},{day:2,ms:600_000},{day:4}]);
  const pauseAt = new Date(t.days[2].start.getTime()+12*60*60_000);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:false},pauseAt);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:false},new Date(pauseAt.getTime()+1));
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:true},t.days[4].start);
  assert.equal(await f.database.reputationTrackingPause.count({where:{guildId:f.guildId}}),1);
  await settleAll(f,t.at);
  const rows = await awards(f);
  assert.deepEqual(rows.map(row=>row.attendanceStreak),[1,2,2,2,3]);
  assert.deepEqual(rows.map(row=>row.exempt),[false,false,true,true,false]);
  assert.equal(rows[2].basePoints,1);
  assert.equal(rows[3].absencePenalty,0);
  assert.equal(rows[4].attendanceBonus,5);
}));

test('resuming before the policy boundary credits voice immediately without granting a pre-policy bonus',options,async()=>fixture(async f=>{
  const day = kyivDay('2026-11-01');
  const {runId} = await f.tracking.openRun(f.guildId,day.start);
  const pauseAt = new Date(day.start.getTime()+60_000);
  const resumeAt = new Date(day.start.getTime()+120_000);
  const end = new Date(resumeAt.getTime()+600_000);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:false},pauseAt);
  await f.database.reputationGuild.update({where:{guildId:f.guildId},data:{attendanceStartsAt:day.end}});
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:true},resumeAt);
  await f.tracking.checkpoint({guildId:f.guildId,runId,from:day.start,to:end,userIds:[john]});
  const interval = await f.database.reputationVoiceInterval.findFirstOrThrow({where:{guildId:f.guildId,userId:john}});
  assert.equal(interval.startedAt.getTime(),resumeAt.getTime());
  assert.equal((await member(f)).trackingSince.getTime(),resumeAt.getTime());
  await f.tracking.checkpoint({guildId:f.guildId,runId,from:end,to:day.end,userIds:[]});
  await settleAll(f,day.end);
  const [award] = await awards(f);
  assert.equal(award.basePoints,1);
  assert.equal(award.attendanceBonus,0);
  assert.equal(award.attendanceStreak,0);
}));

test('a zero-duration pause inside a day does not exempt attendance',options,async()=>fixture(async f=>{
  const t = await timeline(f,1,[{day:0}]);
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:john}},data:{hasParticipated:true,attendanceStreak:2}});
  const at = new Date(t.days[0].start.getTime()+60*60_000);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:false},at);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:true},at);
  await settleAll(f,t.at);
  const [award] = await awards(f);
  assert.equal(award.exempt,false);
  assert.equal(award.attendanceBonus,5);
}));

test('pausing exactly at the next midnight cannot erase the preceding active day bonus', options, async () => fixture(async f => {
  const t = await timeline(f,3,[{day:0},{day:1},{day:2}]);
  await f.tracking.setTracking(f.guildId,{userId:john,enabled:false},t.at);
  await settleAll(f,t.at);
  assert.equal((await awards(f))[2].attendanceBonus,5);
  assert.equal((await member(f)).isTracking,false);
}));

for (const observedVisit of [false,true]) {
  test(`incomplete day freezes streaks without penalty or bonus (verified visit: ${observedVisit})`,options,async()=>fixture(async f=>{
    const t = await timeline(f,4,[{day:0},{day:1},...(observedVisit?[{day:2}]:[]),{day:3}]);
    const gap = new Date(t.days[2].start.getTime()+12*60*60_000);
    await f.database.reputationTrackingRun.update({where:{id:t.runId},data:{verifiedThrough:gap,closedAt:gap}});
    await f.database.reputationTrackingRun.create({data:{id:randomUUID(),guildId:f.guildId,
      startedAt:new Date(gap.getTime()+60*60_000),verifiedThrough:t.at}});
    await settleAll(f,t.at);
    const rows = await awards(f);
    assert.equal(rows[2].exempt,true);
    assert.equal(rows[2].attendanceStreak,2);
    assert.equal(rows[2].attendanceBonus,0);
    assert.equal(rows[2].absencePenalty,0);
    assert.equal(rows[3].attendanceBonus,5);
  }));
}

test('both balance bounds store actual deltas, preserve theoretical components, and keep advancing streaks',options,async()=>fixture(async f=>{
  const t = await timeline(f,2,[{day:0,ms:600_000},{day:1,ms:600_000}]);
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:john}},data:{balance:4999,hasParticipated:true,attendanceStreak:9}});
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:nathan}},data:{balance:-498,hasParticipated:true,absenceStreak:7}});
  const first = await f.settlement.settleNextClosedDay(f.guildId,t.at);
  assert.equal(first.pointsAwarded,-1);
  await settleAll(f,t.at);
  const rows = await f.database.reputationDailyAward.findMany({where:{guildId:f.guildId},orderBy:[{userId:'asc'},{day:'asc'}]});
  assert.deepEqual(rows.map(row=>[row.points,row.balanceAfter]),[[1,5000],[0,5000],[-2,-500],[0,-500]]);
  assert.equal(rows[0].attendanceBonus,6);
  assert.equal(rows[2].absencePenalty,10);
  assert.equal(rows[3].absenceStreak,9);
}));

test('failed daily insertion rolls back streak changes; concurrent retries pay a milestone once',options,async()=>fixture(async f=>{
  const t = await timeline(f,1,[{day:0}]);
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:john}},data:{hasParticipated:true,attendanceStreak:2}});
  const failing = createSettlementStore(()=>({$transaction:(callback,settings)=>f.database.$transaction(tx=>callback(new Proxy(tx,{
    get(target,key){if(key==='reputationDailyAward')return{createMany:async()=>{throw new Error('injected attendance failure');}};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;},
  })),settings)}));
  await assert.rejects(failing.settleNextClosedDay(f.guildId,t.at),/injected attendance failure/);
  assert.equal((await member(f)).attendanceStreak,2);
  assert.equal((await member(f)).balance,0);
  const results = await Promise.all([f.settlement.settleNextClosedDay(f.guildId,t.at),f.settlement.settleNextClosedDay(f.guildId,t.at)]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal((await member(f)).balance,5);
  assert.equal((await member(f)).attendanceStreak,3);
}));

test('positive bonus reports support sub-ten-minute visits and negative balances; deletion resets participation/streaks',options,async()=>fixture(async f=>{
  const t = await timeline(f,1,[{day:0}]);
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:john}},data:{balance:-20,hasParticipated:true,attendanceStreak:2}});
  await settleAll(f,t.at);
  await f.database.reputationGuild.update({where:{guildId:f.guildId},data:{reportChannelId:'333333333333333333'}});
  const reports = createReportStore(()=>f.database);
  const [report] = await reports.pending(f.guildId);
  await reports.attachMessage(report.id,'333333333333333333',f.guildId);
  await reports.prepare(report.id);
  const snapshot = await reports.snapshot(report.id,0);
  assert.equal(snapshot.entries[0].points,5);
  assert.equal(snapshot.entries[0].eligibleMs,1);
  assert.equal(snapshot.entries[0].balanceAfter,-15);
  await reports.finish(report.id);
  await f.tracking.deleteMemberData(f.guildId,john,t.at);
  const erased = await member(f);
  assert.equal(erased.balance,0);
  assert.equal(erased.hasParticipated,false);
  assert.equal(erased.attendanceStreak,0);
  assert.equal(erased.absenceStreak,0);
  assert.equal(erased.isTracking,false);
  assert.equal(await f.database.reputationTrackingPause.count({where:{guildId:f.guildId,userId:john,endedAt:null}}),1);
  assert.equal((await reports.snapshot(report.id,0)).entries[0].points,5);
}));

test('policy boundary prevents retroactive streak progression, bonuses, and absence charges',options,async()=>fixture(async f=>{
  const t = await timeline(f,5,Array.from({length:5},(_,day)=>({day,ms:600_000})));
  await f.database.reputationGuild.update({where:{guildId:f.guildId},data:{attendanceStartsAt:t.days[2].start}});
  await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:nathan}},data:{hasParticipated:true}});
  await settleAll(f,t.at);
  const rows = await awards(f);
  assert.deepEqual(rows.map(row=>row.attendanceStreak),[0,0,1,2,3]);
  assert.deepEqual(rows.map(row=>row.points),[1,1,1,1,6]);
  const absent = await f.database.reputationDailyAward.findMany({where:{guildId:f.guildId,userId:nathan},orderBy:{day:'asc'}});
  assert.deepEqual(absent.map(row=>row.points),[0,0,-5,-5,-5]);
}));

for (const date of ['2026-03-29','2026-10-25']) {
  test(`attendance honors complete coverage on DST day ${date}`,options,async()=>fixture(async f=>{
    const t = await timeline(f,1,[{day:0}],date);
    await f.database.reputationMember.update({where:{guildId_userId:{guildId:f.guildId,userId:john}},data:{hasParticipated:true,attendanceStreak:2}});
    const result = await f.settlement.settleNextClosedDay(f.guildId,t.at);
    assert.equal(result.incomplete,false);
    assert.equal(result.pointsAwarded,5);
  }));
}
