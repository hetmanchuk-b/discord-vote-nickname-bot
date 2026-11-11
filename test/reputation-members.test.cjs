const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMemberReputation } = require('../dist/reputation/member-reputation.js');
const { DeletionConfirmations, DELETION_CONFIRMATION_MS } = require('../dist/reputation/deletion-confirmations.js');

const statistics = { day: '2026-11-11', eligibleMs: 600000, pendingPoints: 1, isTracking: true, incomplete: false };

test('today flushes ongoing time but freezes the read instant before database latency', async () => {
  let time = new Date('2026-11-11T12:00:00Z');
  const captured = time;
  let flushes = 0;
  let queryAt;
  const tracker = { status: 'tracking', checkpoint: async () => { flushes++; time = new Date(time.getTime() + 500); } };
  const members = createMemberReputation({
    now: () => time,
    getTracker: () => tracker,
    members: {
      getBalance: async () => 7,
      getToday: async (_guild, _user, at) => { queryAt = at; return statistics; },
    },
  });
  assert.equal(await members.getBalance('guild', 'user'), 7);
  assert.equal(flushes, 0); // Settled balance reads have no tracking side effects.
  assert.deepEqual(await members.getToday('guild', 'user'), { ...statistics, trackingAvailable: true });
  assert.equal(flushes, 1);
  assert.equal(queryAt, captured);
});

test('preferences and deletion go through the active tracker queue', async () => {
  const calls = [];
  const tracker = {
    status: 'tracking',
    setTracking: async (...args) => { calls.push(['preference', ...args]); },
    deleteData: async (...args) => { calls.push(['delete', ...args]); },
  };
  const members = createMemberReputation({ getTracker: () => tracker });
  assert.deepEqual(await members.setTracking('guild', 'user', false), { trackingAvailable: true });
  await members.deleteData('guild', 'user');
  assert.deepEqual(calls, [['preference', 'user', false], ['delete', 'user']]);
});

test('disabled runtime still permits persistent preferences and self-service erasure', async () => {
  const calls = [];
  const at = new Date('2026-11-11T12:00:00Z');
  const members = createMemberReputation({
    now: () => at, getTracker: () => undefined,
    members: { getBalance: async () => 0, getToday: async () => statistics },
    tracking: {
      setTracking: async (...args) => { calls.push(['preference', ...args]); },
      deleteMemberData: async (...args) => { calls.push(['delete', ...args]); },
    },
  });
  assert.deepEqual(await members.setTracking('guild', 'user', false), { trackingAvailable: false });
  await members.deleteData('guild', 'user');
  assert.deepEqual(calls, [
    ['preference', 'guild', { userId: 'user', enabled: false }, at],
    ['delete', 'guild', 'user', at],
  ]);
  assert.equal((await members.getToday('guild', 'user')).trackingAvailable, false);
});

test('storage failures are propagated rather than converted to zero statistics', async () => {
  const members = createMemberReputation({
    getTracker: () => undefined,
    members: { getBalance: async () => { throw new Error('unavailable'); }, getToday: async () => { throw new Error('unavailable'); } },
  });
  await assert.rejects(members.getBalance('guild', 'user'), /unavailable/);
  await assert.rejects(members.getToday('guild', 'user'), /unavailable/);
});

function confirmationsFixture(t) {
  let now = 1000;
  let expired = 0;
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const confirmations = new DeletionConfirmations(() => now);
  confirmations.create({
    messageId: 'message', guildId: 'guild', userId: 'user', expiresAt: now + DELETION_CONFIRMATION_MS,
    onExpire: async () => { expired++; },
  });
  return { confirmations, timers, at(value) { now = value; }, get expired() { return expired; } };
}

test('confirmation expires exactly at 60 seconds and cannot be replayed', t => {
  const f = confirmationsFixture(t);
  assert.equal(f.timers[0].delay, 60000);
  f.at(61000);
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'expired');
  assert.equal(f.expired, 1);
  f.timers[0].callback();
  assert.equal(f.expired, 1);
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'missing');
});

test('consuming before expiry disables the expiry edit and all subsequent clicks', t => {
  const f = confirmationsFixture(t);
  f.at(60999);
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'confirmed');
  f.at(61000); f.timers[0].callback();
  assert.equal(f.expired, 0);
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'missing');
});

test('confirmation ownership includes both server and caller', t => {
  const f = confirmationsFixture(t);
  assert.equal(f.confirmations.consume('message', 'guild', 'attacker'), 'forbidden');
  assert.equal(f.confirmations.consume('message', 'other-guild', 'user'), 'forbidden');
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'confirmed');
});

test('timer expiry edits the prompt once without authorizing any deletion', t => {
  const f = confirmationsFixture(t);
  f.at(61000);
  f.timers[0].callback();
  assert.equal(f.expired, 1);
  assert.equal(f.confirmations.consume('message', 'guild', 'user'), 'missing');
});
