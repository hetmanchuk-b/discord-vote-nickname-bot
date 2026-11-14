const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('./helpers/point-test-database.cjs');
const { createTrackingStore } = require('../dist/reputation/tracking-store.js');
const { createMemberStore } = require('../dist/reputation/member-store.js');
const { createSettlementStore } = require('../dist/reputation/settlement-store.js');
const { kyivDay } = require('../dist/reputation/kyiv-day.js');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.' };
const MINUTE = 60000;
const john = '111111111111111111';
const nathan = '222222222222222222';

async function fixture(callback) {
  const database = createReputationDatabase(url);
  const guildId = `${Date.now()}${randomInt(100000, 999999)}`;
  const tracking = createTrackingStore(() => database.raw);
  const members = createMemberStore(() => database.raw);
  const settlement = createSettlementStore(() => database.raw);
  try {
    await callback({ database, guildId, tracking, members, settlement });
  } finally {
    try {
      await database.reputationDailyAward.deleteMany({ where: { guildId } });
      await database.reputationSettlement.deleteMany({ where: { guildId } });
      await database.reputationVoiceInterval.deleteMany({ where: { guildId } });
      await database.reputationTrackingRun.deleteMany({ where: { guildId } });
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally { await database.$disconnect(); }
  }
}

async function recordedDay(f) {
  const day = kyivDay('2026-11-11');
  const { runId } = await f.tracking.openRun(f.guildId, day.start);
  const ten = new Date(day.start.getTime() + 10 * MINUTE);
  await f.tracking.checkpoint({ guildId: f.guildId, runId, from: day.start, to: ten, userIds: [john, nathan] });
  await f.tracking.checkpoint({ guildId: f.guildId, runId, from: ten, to: day.end, userIds: [] });
  return { day, runId };
}

test('all balances include paused, zero, negative and unsettled participants but exclude never-participated and erased identities', options, async () => {
  await fixture(async f => {
    const leader = '333333333333333333', unsettled = '444444444444444444';
    const waiting = '555555555555555555', erased = '666666666666666666';
    assert.deepEqual(await f.members.getAll(f.guildId),[]);
    assert.equal(await f.database.reputationGuild.count({where:{guildId:f.guildId}}),0);
    await f.database.reputationGuild.create({data:{guildId:f.guildId}});
    await f.database.reputationMember.createMany({data:[
      {guildId:f.guildId,userId:john,balance:-5,hasParticipated:true,isTracking:false},
      {guildId:f.guildId,userId:nathan,balance:0,hasParticipated:true},
      {guildId:f.guildId,userId:leader,balance:100,hasParticipated:true},
      {guildId:f.guildId,userId:unsettled,balance:0},
      {guildId:f.guildId,userId:waiting,balance:0},
      {guildId:f.guildId,userId:erased,balance:25,hasParticipated:true},
    ]});
    const from = new Date('2026-11-11T10:00:00Z'), to = new Date(from.getTime()+1000);
    const {runId} = await f.tracking.openRun(f.guildId,from);
    await f.database.reputationVoiceInterval.create({data:{guildId:f.guildId,userId:unsettled,runId,startedAt:from,endedAt:to}});
    await f.tracking.deleteMemberData(f.guildId,erased,to);
    assert.deepEqual(await f.members.getAll(f.guildId),[
      {userId:leader,balance:100},{userId:nathan,balance:0},{userId:unsettled,balance:0},{userId:john,balance:-5},
    ]);
    assert.deepEqual(await f.members.getAll(`${f.guildId}0`),[]);
    assert.equal(await f.database.reputationMember.count({where:{guildId:f.guildId}}),6);
  });
});

test('unknown-member statistics are default-on and read-only, without fabricating complete coverage', options, async () => {
  await fixture(async f => {
    assert.equal(await f.members.getBalance(f.guildId, john), 0);
    const stats = await f.members.getToday(f.guildId, john, new Date('2026-11-11T12:00:00Z'));
    assert.deepEqual(stats, { day: '2026-11-11', eligibleMs: 0, pendingPoints: 0, isTracking: true, incomplete: true, attendanceStreak: 0, absenceStreak: 0 });
    assert.equal(await f.database.reputationMember.count({ where: { guildId: f.guildId } }), 0);
    assert.equal(await f.database.reputationGuild.count({ where: { guildId: f.guildId } }), 0);
  });
});

test('today queries clip cross-midnight sessions at the query instant and respect persisted pause status', options, async () => {
  await fixture(async f => {
    const day = kyivDay('2026-11-11');
    const from = new Date(day.start.getTime() - 7 * MINUTE);
    const to = new Date(day.start.getTime() + 7 * MINUTE);
    const { runId } = await f.tracking.openRun(f.guildId, from);
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from, to, userIds: [john] });
    const at = new Date(day.start.getTime() + 4 * MINUTE);
    const current = await f.members.getToday(f.guildId, john, at);
    assert.equal(current.eligibleMs, 4 * MINUTE);
    assert.equal(current.pendingPoints, 0.25);
    assert.equal(current.incomplete, false);
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: false }, to);
    const paused = await f.members.getToday(f.guildId, john, new Date(to.getTime() + MINUTE));
    assert.equal(paused.eligibleMs, 7 * MINUTE);
    assert.equal(paused.isTracking, false);
    assert.equal(paused.incomplete, true);
    assert.equal(await f.members.getBalance(f.guildId, john), 0); // Pending is not settled.
  });
});

test('persisted eligibility floor excludes pause/deletion gaps even for stale queued checkpoints', options, async () => {
  await fixture(async f => {
    const day = kyivDay('2026-11-11');
    const at = minutes => new Date(day.start.getTime() + minutes * MINUTE);
    const { runId } = await f.tracking.openRun(f.guildId, at(0));
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: at(0), to: at(5), userIds: [john] });
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: false }, at(6));
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: true }, at(10));
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: at(5), to: at(15), userIds: [john] });
    let rows = await f.database.reputationVoiceInterval.findMany({ where: { guildId: f.guildId }, orderBy: { startedAt: 'asc' } });
    assert.deepEqual(rows.map(row => [row.startedAt.getTime(), row.endedAt.getTime()]), [[at(0).getTime(), at(5).getTime()], [at(10).getTime(), at(15).getTime()]]);
    await f.tracking.deleteMemberData(f.guildId, john, at(16));
    // An old resume command cannot move the cutoff back before erasure.
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: true }, at(14));
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: at(15), to: at(20), userIds: [john] });
    rows = await f.database.reputationVoiceInterval.findMany({ where: { guildId: f.guildId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].startedAt.getTime(), at(16).getTime());
    const fresh = await f.members.getToday(f.guildId, john, at(20));
    assert.equal(fresh.eligibleMs, 4 * MINUTE);
    assert.equal(fresh.pendingPoints, 0.25);
    assert.equal(await f.members.getBalance(f.guildId, john), 0);
  });
});

test('erasure resets live data and pending report entries, keeps a disabled identity, and preserves other members and day ledgers', options, async () => {
  await fixture(async f => {
    const { day, runId } = await recordedDay(f);
    await f.settlement.settleNextClosedDay(f.guildId, day.end);
    const five = new Date(day.end.getTime() + 5 * MINUTE);
    const erasedAt = new Date(day.end.getTime() + 6 * MINUTE);
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: day.end, to: five, userIds: [john, nathan] });
    await f.tracking.deleteMemberData(f.guildId, john, erasedAt);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.balance, 0);
    assert.equal(member.isTracking, false);
    assert.equal(member.trackingSince.getTime(), erasedAt.getTime());
    assert.equal(member.createdAt.getTime(), erasedAt.getTime());
    assert.equal(await f.database.reputationVoiceInterval.count({ where: { guildId: f.guildId, userId: john } }), 0);
    assert.equal(await f.database.reputationDailyAward.count({ where: { guildId: f.guildId, userId: john } }), 0);
    assert.equal(await f.members.getBalance(f.guildId, nathan), 1);
    assert.equal(await f.database.reputationVoiceInterval.count({ where: { guildId: f.guildId, userId: nathan } }), 2);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 1);
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, erasedAt), null);
    const stats = await f.members.getToday(f.guildId, john, erasedAt);
    assert.equal(stats.eligibleMs, 0);
    assert.equal(stats.isTracking, false);
  });
});

test('concurrent erasure and settlement cannot leave a deleted balance or restore deleted daily results', options, async () => {
  await fixture(async f => {
    const { day } = await recordedDay(f);
    await Promise.all([
      f.settlement.settleNextClosedDay(f.guildId, day.end),
      f.tracking.deleteMemberData(f.guildId, john, day.end),
    ]);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.balance, 0);
    assert.equal(member.isTracking, false);
    assert.equal(await f.database.reputationDailyAward.count({ where: { guildId: f.guildId, userId: john } }), 0);
    assert.equal(await f.members.getBalance(f.guildId, nathan), 1);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 1);
  });
});

test('failed erasure rolls back interval deletion, awards, balance, and preference together', options, async () => {
  await fixture(async f => {
    const { day } = await recordedDay(f);
    await f.settlement.settleNextClosedDay(f.guildId, day.end);
    const failing = createTrackingStore(() => ({
      $transaction: (callback, transactionOptions) => f.database.$transaction(tx => callback(new Proxy(tx, {
        get(target, property) {
          if (property === 'reputationMember') return new Proxy(target.reputationMember, {
            get(delegate, method) {
              if (method === 'upsert') return async () => { throw new Error('injected erasure failure'); };
              const value = Reflect.get(delegate, method);
              return typeof value === 'function' ? value.bind(delegate) : value;
            },
          });
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })), transactionOptions),
    }));
    await assert.rejects(failing.deleteMemberData(f.guildId, john, day.end), /injected erasure failure/);
    assert.equal(await f.members.getBalance(f.guildId, john), 1);
    assert.equal(await f.database.reputationVoiceInterval.count({ where: { guildId: f.guildId, userId: john } }), 1);
    assert.equal(await f.database.reputationDailyAward.count({ where: { guildId: f.guildId, userId: john } }), 1);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.isTracking, true);
  });
});
