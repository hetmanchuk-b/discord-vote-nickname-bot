const assert = require('node:assert/strict');
const { test } = require('node:test');
const { kyivDate, kyivDay, nextCalendarDate, nextKyivMidnight } = require('../dist/reputation/kyiv-day.js');
const { pointsForTime, coveredMilliseconds, summarizeDay } = require('../dist/reputation/daily-summary.js');
const { SettlementScheduler } = require('../dist/reputation/settlement-scheduler.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('Kyiv dates change at local midnight, not UTC midnight', () => {
  assert.equal(kyivDate(new Date('2026-11-11T21:59:59.999Z')), '2026-11-11');
  assert.equal(kyivDate(new Date('2026-11-11T22:00:00Z')), '2026-11-12');
  assert.equal(kyivDate(new Date('2026-07-11T21:00:00Z')), '2026-07-12');
  assert.equal(nextKyivMidnight(new Date('2026-11-11T12:00:00Z')).toISOString(), '2026-11-11T22:00:00.000Z');
});

for (const [date, start, end, hours] of [
  ['2026-11-11', '2026-11-10T22:00:00.000Z', '2026-11-11T22:00:00.000Z', 24],
  ['2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z', 23],
  ['2026-10-25', '2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z', 25],
]) {
  test(`Kyiv day ${date} has correct DST-aware boundaries (${hours} hours)`, () => {
    const day = kyivDay(date);
    assert.equal(day.start.toISOString(), start);
    assert.equal(day.end.toISOString(), end);
    assert.equal(day.end - day.start, hours * HOUR);
    assert.equal(kyivDate(day.start), date);
    assert.equal(kyivDate(new Date(day.end - 1)), date);
  });
}

test('calendar arithmetic validates dates and crosses year/leap-day boundaries', () => {
  assert.equal(nextCalendarDate('2026-12-31'), '2027-01-01');
  assert.equal(nextCalendarDate('2028-02-28'), '2028-02-29');
  assert.equal(nextCalendarDate('2028-02-29'), '2028-03-01');
  for (const day of ['2026-02-29', '2026-13-01', '2026-1-1', 'not-a-date']) {
    assert.throws(() => kyivDay(day));
  }
});

test('points are exact quarters with daily rounding down', () => {
  assert.equal(pointsForTime(0), 0);
  assert.equal(pointsForTime(10 * MINUTE - 1), 0.75);
  assert.equal(pointsForTime(10 * MINUTE), 1);
  assert.equal(pointsForTime(29 * MINUTE), 2.75);
  assert.equal(pointsForTime(60 * MINUTE), 6);
  assert.throws(() => pointsForTime(-1));
  assert.throws(() => pointsForTime(0.5));
});

test('daily totals accumulate visits before rounding and do not carry a remainder', () => {
  const day = kyivDay('2026-11-11');
  const summary = summarizeDay(day, [
    { userId: 'john', eligibleMs: BigInt((6 + 7) * MINUTE) },
    { userId: 'nathan', eligibleMs: BigInt(9 * MINUTE) },
  ], [{ start: day.start, end: day.end }]);
  assert.deepEqual(summary.members.map(member => [member.userId, member.points]), [['john', 1.25], ['nathan', 0.75]]);
  assert.equal(summary.activityMs, BigInt(22 * MINUTE));
  assert.equal(summary.pointsAwarded, 2);
  assert.equal(summary.incomplete, false);
  const tomorrow = summarizeDay(kyivDay('2026-11-12'), [{ userId: 'john', eligibleMs: BigInt(7 * MINUTE) }], []);
  assert.equal(tomorrow.pointsAwarded, 0.5);
});

test('coverage merges overlapping runs and clips to the local day', () => {
  const day = kyivDay('2026-11-11');
  const at = hours => new Date(day.start.getTime() + hours * HOUR);
  const ranges = [
    { start: at(-1), end: at(2) }, { start: at(1), end: at(4) },
    { start: at(4), end: at(5) }, { start: at(23), end: at(26) },
  ];
  assert.equal(coveredMilliseconds(day, ranges), 6 * HOUR);
  const summary = summarizeDay(day, [], ranges);
  assert.equal(summary.verifiedMs, 6 * HOUR);
  assert.equal(summary.activityMs, 0n);
  assert.equal(summary.incomplete, true);
});

test('first partial day and wholly unobserved days remain distinguishable from fully observed empty days', () => {
  const day = kyivDay('2026-11-11');
  const partial = summarizeDay(day, [], [{ start: new Date(day.start.getTime() + HOUR), end: day.end }]);
  const unavailable = summarizeDay(day, [], []);
  const empty = summarizeDay(day, [], [{ start: day.start, end: day.end }]);
  assert.equal(partial.verifiedMs, 23 * HOUR);
  assert.equal(partial.incomplete, true);
  assert.equal(unavailable.verifiedMs, 0);
  assert.equal(unavailable.incomplete, true);
  assert.equal(empty.incomplete, false);
  assert.equal(empty.pointsAwarded, 0);
});

test('full DST days have no artificial one-hour coverage gap', () => {
  for (const date of ['2026-03-29', '2026-10-25']) {
    const day = kyivDay(date);
    const summary = summarizeDay(day, [{ userId: 'john', eligibleMs: BigInt(day.end - day.start) }], [day]);
    assert.equal(summary.incomplete, false);
    assert.equal(summary.pointsAwarded, (day.end - day.start) / (10 * MINUTE));
  }
});

test('invalid member totals fail rather than silently overpay', () => {
  const day = kyivDay('2026-11-11');
  assert.throws(() => summarizeDay(day, [{ userId: 'john', eligibleMs: -1n }], []));
  assert.throws(() => summarizeDay(day, [{ userId: 'john', eligibleMs: BigInt(25 * HOUR) }], []));
  assert.throws(() => summarizeDay(day, [
    { userId: 'john', eligibleMs: 1n }, { userId: 'john', eligibleMs: 1n },
  ], []));
});

function schedulerFixture(t, store) {
  let now = new Date('2026-11-11T22:00:00Z');
  const timers = [];
  const statuses = [];
  const days = [];
  let flushes = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const scheduler = new SettlementScheduler({
    guildId: 'guild', store,
    now: () => now,
    beforeSettlement: async () => { flushes++; },
    onSettled: day => days.push(day.day),
    onUnavailable: () => statuses.push('unavailable'),
    onRecovered: () => statuses.push('recovered'),
  });
  return { scheduler, timers, statuses, days,
    at(date) { now = new Date(date); },
    get flushes() { return flushes; },
  };
}

test('scheduler flushes, catches up in order, then sleeps until the next Kyiv midnight', async t => {
  const pending = ['2026-11-10', '2026-11-11'];
  const f = schedulerFixture(t, { settleNextClosedDay: async () => {
    assert.equal(f.flushes, 1);
    return pending.length ? { day: pending.shift(), pointsAwarded: 1, incomplete: false } : null;
  } });
  await f.scheduler.start();
  assert.deepEqual(f.days, ['2026-11-10', '2026-11-11']);
  assert.equal(f.timers.at(-1).delay, 24 * HOUR);
  await f.scheduler.start(); // Idempotent; reconnects don't poll the DB again.
  assert.equal(f.flushes, 1);
  await f.scheduler.stop();
});

test('scheduler uses the DST-adjusted next-midnight delay', async t => {
  const f = schedulerFixture(t, { settleNextClosedDay: async () => null });
  f.at('2026-03-28T22:00:00Z');
  await f.scheduler.start();
  assert.equal(f.timers.at(-1).delay, 23 * HOUR);
  await f.scheduler.stop();
});

test('a job crossing midnight promptly rechecks the newly closed day', async t => {
  const f = schedulerFixture(t, { settleNextClosedDay: async (_guildId, at) => {
    assert.equal(at.toISOString(), '2026-11-11T21:59:59.000Z');
    f.at('2026-11-11T22:00:01Z');
    return null;
  } });
  f.at('2026-11-11T21:59:59Z');
  await f.scheduler.start();
  assert.equal(f.timers.at(-1).delay, 1_000);
  await f.scheduler.stop();
});

test('settlement outages use bounded retries and notify once until recovery', async t => {
  let unavailable = true;
  const f = schedulerFixture(t, { settleNextClosedDay: async () => {
    if (unavailable) throw new Error('database unavailable');
    return null;
  } });
  await f.scheduler.start();
  assert.equal(f.timers.at(-1).delay, MINUTE);
  await f.scheduler.runDue();
  assert.equal(f.timers.at(-1).delay, 2 * MINUTE);
  await f.scheduler.runDue();
  await f.scheduler.runDue();
  assert.equal(f.timers.at(-1).delay, 5 * MINUTE);
  assert.deepEqual(f.statuses, ['unavailable']);
  unavailable = false;
  await f.scheduler.runDue();
  assert.deepEqual(f.statuses, ['unavailable', 'recovered']);
  await f.scheduler.stop();
});

test('large catch-up queues yield after 31 days without skipping any dates', async t => {
  let remaining = 40;
  const f = schedulerFixture(t, { settleNextClosedDay: async () => remaining-- > 0 ? {
    day: `day-${remaining}`, pointsAwarded: 0, incomplete: true,
  } : null });
  await f.scheduler.start();
  assert.equal(f.days.length, 31);
  assert.equal(f.timers.at(-1).delay, 1_000);
  await f.scheduler.runDue();
  assert.equal(f.days.length, 40);
  assert.equal(f.timers.at(-1).delay, 24 * HOUR);
  await f.scheduler.stop();
});

test('concurrent settlement triggers share one in-flight job', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = schedulerFixture(t, { settleNextClosedDay: async () => { calls++; await gate; return null; } });
  const first = f.scheduler.start();
  const second = f.scheduler.runDue();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await f.scheduler.stop();
  await f.scheduler.runDue();
  assert.equal(calls, 1);
});
