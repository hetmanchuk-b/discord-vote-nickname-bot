const assert = require('node:assert/strict');
const { test } = require('node:test');
const { settleAttendance } = require('../dist/reputation/attendance-rules.js');

const fresh = { balance: 0, hasParticipated: false, attendanceStreak: 0, absenceStreak: 0 };
const participating = { ...fresh, hasParticipated: true };
const nextState = result => ({ ...result, balance: result.balanceAfter });

for (const [day, bonus] of [[1,0],[2,0],[3,5],[9,5],[10,6],[16,6],[17,7],[23,7],[24,8],[31,9]]) {
  test(`attendance day ${day} adds ${bonus} on top of ordinary voice points`, () => {
    const result = settleAttendance({ ...participating, attendanceStreak: day - 1 }, 600_000, false);
    assert.equal(result.attendanceBonus, bonus);
    assert.equal(result.basePoints, 1);
    assert.equal(result.points, 1 + bonus);
    assert.equal(result.attendanceStreak, day);
    assert.equal(result.absenceStreak, 0);
  });
}
for (const [day, penalty] of [[1,5],[7,5],[8,10],[30,10]]) {
  test(`absence day ${day} costs ${penalty}, including the day-8 escalation`, () => {
    const result = settleAttendance({ ...participating, absenceStreak: day - 1 }, 0, false);
    assert.equal(result.absencePenalty, penalty);
    assert.equal(result.points, -penalty);
    assert.equal(result.absenceStreak, day);
    assert.equal(result.attendanceStreak, 0);
  });
}

test('never-participating members are not enrolled by empty observed days', () => {
  const result = settleAttendance(fresh, 0, false);
  assert.equal(result.points, 0);
  assert.equal(result.hasParticipated, false);
  assert.equal(result.absenceStreak, 0);
});

test('one millisecond qualifies; first two days are not paid retroactively', () => {
  let state = fresh;
  const points = [];
  for (let day = 0; day < 3; day++) {
    const result = settleAttendance(state, 1, false);
    points.push(result.points);
    state = nextState(result);
  }
  assert.deepEqual(points, [0,0,5]);
  assert.equal(state.balance, 5);
  assert.equal(state.hasParticipated, true);
});

test('attendance resets absence and a real missed day resets attendance', () => {
  const absent = settleAttendance({ ...participating, attendanceStreak: 9 }, 0, false);
  assert.equal(absent.attendanceStreak, 0);
  assert.equal(absent.absenceStreak, 1);
  const returned = settleAttendance(nextState(absent), 1, false);
  assert.equal(returned.attendanceStreak, 1);
  assert.equal(returned.absenceStreak, 0);
  assert.equal(returned.attendanceBonus, 0);
});

for (const [attendanceStreak, absenceStreak] of [[9,0],[0,7]]) {
  test(`exempt days freeze streaks ${attendanceStreak}/${absenceStreak}, without losing verified base time`, () => {
    const state = { ...participating, attendanceStreak, absenceStreak };
    for (const eligibleMs of [0, 600_000]) {
      const result = settleAttendance(state, eligibleMs, true);
      assert.equal(result.attendanceStreak, attendanceStreak);
      assert.equal(result.absenceStreak, absenceStreak);
      assert.equal(result.attendanceBonus, 0);
      assert.equal(result.absencePenalty, 0);
      assert.equal(result.points, eligibleMs ? 1 : 0);
    }
  });
}

test('verified participation on an exempt day enrolls the member without advancing a streak', () => {
  const result = settleAttendance(fresh, 1, true);
  assert.equal(result.hasParticipated, true);
  assert.equal(result.attendanceStreak, 0);
});

test('balance clamp stores the actual delta and still advances attendance at the ceiling', () => {
  const near = settleAttendance({ ...participating, balance: 4999, attendanceStreak: 9 }, 600_000, false);
  assert.equal(near.balanceAfter, 5000);
  assert.equal(near.points, 1);
  assert.equal(near.attendanceBonus, 6);
  const capped = settleAttendance(nextState(near), 600_000, false);
  assert.equal(capped.points, 0);
  assert.equal(capped.attendanceStreak, 11);
});

test('balance floor limits the actual penalty without resetting absence escalation', () => {
  const near = settleAttendance({ ...participating, balance: -498, absenceStreak: 7 }, 0, false);
  assert.equal(near.balanceAfter, -500);
  assert.equal(near.absencePenalty, 10);
  assert.equal(near.points, -2);
  const capped = settleAttendance(nextState(near), 0, false);
  assert.equal(capped.points, 0);
  assert.equal(capped.absenceStreak, 9);
});

test('invalid persisted balances/streaks and invalid times fail rather than inventing rewards', () => {
  for (const state of [
    { ...fresh, balance: 5001 }, { ...fresh, balance: -501 },
    { ...participating, attendanceStreak: -1 }, { ...participating, absenceStreak: 0.5 },
    { ...participating, attendanceStreak: 1, absenceStreak: 1 }, { ...fresh, attendanceStreak: 1 },
  ]) assert.throws(() => settleAttendance(state, 1, false));
  for (const value of [-1, NaN, 0.1]) assert.throws(() => settleAttendance(fresh, value, false));
});
