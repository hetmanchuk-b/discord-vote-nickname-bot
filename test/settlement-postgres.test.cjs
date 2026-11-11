const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { createTrackingStore } = require('../dist/reputation/tracking-store.js');
const { createSettlementStore } = require('../dist/reputation/settlement-store.js');
const { kyivDay } = require('../dist/reputation/kyiv-day.js');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.' };
const MINUTE = 60_000;
const john = '111111111111111111';
const nathan = '222222222222222222';

async function fixture(callback) {
  const database = createReputationDatabase(url);
  const guildId = `${Date.now()}${randomInt(100000, 999999)}`;
  const tracking = createTrackingStore(() => database);
  const settlement = createSettlementStore(() => database);
  try {
    await callback({ database, guildId, tracking, settlement });
  } finally {
    try {
      await database.reputationDailyAward.deleteMany({ where: { guildId } });
      await database.reputationSettlement.deleteMany({ where: { guildId } });
      await database.reputationVoiceInterval.deleteMany({ where: { guildId } });
      await database.reputationTrackingRun.deleteMany({ where: { guildId } });
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally {
      await database.$disconnect();
    }
  }
}

async function recordDay(f, date, userIds = [john]) {
  const day = kyivDay(date);
  const { runId } = await f.tracking.openRun(f.guildId, day.start);
  await f.tracking.checkpoint({ guildId: f.guildId, runId, from: day.start, to: day.end, userIds });
  return day;
}

test('settlement aggregates visits, preserves paused earnings, and snapshots balances only once', options, async () => {
  await fixture(async f => {
    const day = kyivDay('2026-11-11');
    const { runId } = await f.tracking.openRun(f.guildId, day.start);
    let cursor = day.start;
    async function checkpoint(to, userIds) {
      await f.tracking.checkpoint({ guildId: f.guildId, runId, from: cursor, to, userIds });
      cursor = to;
    }
    const at = minutes => new Date(day.start.getTime() + minutes * MINUTE);
    await checkpoint(at(6), [john, nathan]);
    await checkpoint(at(9), [nathan]);
    await checkpoint(at(60), []);
    await checkpoint(at(67), [john]);
    await checkpoint(day.end, []);
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: false });
    await f.database.reputationMember.update({ where: { guildId_userId: { guildId: f.guildId, userId: john } }, data: { balance: 10 } });
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, new Date(day.end - 1)), null);
    const result = await f.settlement.settleNextClosedDay(f.guildId, day.end);
    assert.deepEqual(result, { day: day.day, pointsAwarded: 1, incomplete: false });
    const awards = await f.database.reputationDailyAward.findMany({ where: { guildId: f.guildId }, orderBy: { userId: 'asc' } });
    assert.deepEqual(awards.map(row => [row.userId, row.eligibleMs, row.points, row.balanceAfter]), [
      [john, 13 * MINUTE, 1, 11], [nathan, 9 * MINUTE, 0, 0],
    ]);
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, day.end), null);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.balance, 11);
    assert.equal(member.isTracking, false);

    // A later payout changes the live balance, not the previous day's snapshot.
    await f.tracking.setTracking(f.guildId, { userId: john, enabled: true });
    await recordDay(f, '2026-11-12');
    await f.settlement.settleNextClosedDay(f.guildId, kyivDay('2026-11-13').start);
    const frozen = await f.database.reputationDailyAward.findUniqueOrThrow({ where: {
      guildId_userId_day: { guildId: f.guildId, userId: john, day: day.day },
    } });
    assert.equal(frozen.balanceAfter, 11);
    const current = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(current.balance, 155);
  });
});

test('a midnight-spanning interval is split per day and partial blocks never carry over', options, async () => {
  await fixture(async f => {
    const first = kyivDay('2026-11-11');
    const second = kyivDay('2026-11-12');
    const start = new Date(first.end.getTime() - 7 * MINUTE);
    const { runId } = await f.tracking.openRun(f.guildId, start);
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: start,
      to: new Date(first.end.getTime() + 7 * MINUTE), userIds: [john] });
    const now = second.end;
    assert.equal((await f.settlement.settleNextClosedDay(f.guildId, now)).day, first.day);
    assert.equal((await f.settlement.settleNextClosedDay(f.guildId, now)).day, second.day);
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, now), null);
    const rows = await f.database.reputationDailyAward.findMany({ where: { guildId: f.guildId }, orderBy: { day: 'asc' } });
    assert.deepEqual(rows.map(row => [row.eligibleMs, row.points]), [[7 * MINUTE, 0], [7 * MINUTE, 0]]);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 2);
  });
});

for (const [date, points] of [['2026-03-29', 138], ['2026-10-25', 150]]) {
  test(`SQL settlement honors the full DST day ${date}`, options, async () => {
    await fixture(async f => {
      const day = await recordDay(f, date);
      const result = await f.settlement.settleNextClosedDay(f.guildId, day.end);
      assert.equal(result.pointsAwarded, points);
      assert.equal(result.incomplete, false);
    });
  });
}

test('concurrent workers and retries cannot award a day twice', options, async () => {
  await fixture(async f => {
    const day = await recordDay(f, '2026-11-11');
    const results = await Promise.all([
      f.settlement.settleNextClosedDay(f.guildId, day.end),
      f.settlement.settleNextClosedDay(f.guildId, day.end),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.balance, 144);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 1);
    // Erasing live awards cannot erase the day ledger and enable replay.
    await f.database.reputationDailyAward.deleteMany({ where: { guildId: f.guildId, userId: john } });
    await f.database.reputationMember.update({ where: { guildId_userId: { guildId: f.guildId, userId: john } }, data: { balance: 0, isTracking: false } });
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, day.end), null);
  });
});

test('failed snapshot insertion rolls back balances, day ledger, and watermark together', options, async () => {
  await fixture(async f => {
    const day = await recordDay(f, '2026-11-11');
    const failing = createSettlementStore(() => ({
      $transaction: (callback, transactionOptions) => f.database.$transaction(tx => callback(new Proxy(tx, {
        get(target, property) {
          if (property === 'reputationDailyAward') return { createMany: async () => { throw new Error('injected failure'); } };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })), transactionOptions),
    }));
    await assert.rejects(failing.settleNextClosedDay(f.guildId, day.end), /injected failure/);
    const member = await f.database.reputationMember.findUniqueOrThrow({ where: { guildId_userId: { guildId: f.guildId, userId: john } } });
    assert.equal(member.balance, 0);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 0);
    const guild = await f.database.reputationGuild.findUniqueOrThrow({ where: { guildId: f.guildId } });
    assert.equal(guild.settledThrough, null);
    assert.equal((await f.settlement.settleNextClosedDay(f.guildId, day.end)).pointsAwarded, 144);
  });
});

test('late checkpoints cannot add activity to a day that is already frozen', options, async () => {
  await fixture(async f => {
    const day = kyivDay('2026-11-11');
    const start = new Date(day.end.getTime() - 5 * MINUTE);
    const { runId } = await f.tracking.openRun(f.guildId, start);
    const settled = await f.settlement.settleNextClosedDay(f.guildId, day.end);
    assert.equal(settled.pointsAwarded, 0);
    await f.tracking.checkpoint({ guildId: f.guildId, runId, from: start,
      to: new Date(day.end.getTime() + 5 * MINUTE), userIds: [john] });
    const row = await f.database.reputationVoiceInterval.findFirstOrThrow({ where: { guildId: f.guildId } });
    assert.equal(row.startedAt.getTime(), day.end.getTime());
    const frozen = await f.database.reputationSettlement.findUniqueOrThrow({ where: { guildId_day: { guildId: f.guildId, day: day.day } } });
    assert.equal(frozen.activityMs, 0n);
    assert.equal(frozen.verifiedMs, 0);
  });
});

test('empty observed days and wholly offline catch-up days are separate from pre-activation history', options, async () => {
  await fixture(async f => {
    await f.database.reputationGuild.create({ data: { guildId: f.guildId } });
    const day = kyivDay('2026-11-11');
    assert.equal(await f.settlement.settleNextClosedDay(f.guildId, day.end), null);
    await recordDay(f, day.day, []);
    const first = await f.settlement.settleNextClosedDay(f.guildId, kyivDay('2026-11-14').start);
    assert.equal(first.incomplete, false);
    const second = await f.settlement.settleNextClosedDay(f.guildId, kyivDay('2026-11-14').start);
    const third = await f.settlement.settleNextClosedDay(f.guildId, kyivDay('2026-11-14').start);
    assert.deepEqual([first.day, second.day, third.day], ['2026-11-11', '2026-11-12', '2026-11-13']);
    assert.equal(second.incomplete, true);
    assert.equal(third.incomplete, true);
    assert.equal(await f.database.reputationDailyAward.count({ where: { guildId: f.guildId } }), 0);
  });
});
