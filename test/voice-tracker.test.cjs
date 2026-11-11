const assert = require('node:assert/strict');
const { test } = require('node:test');
const { VoiceTracker, CHECKPOINT_INTERVAL_MS } = require('../dist/reputation/voice-tracker.js');
const { TrackingLeaseLostError } = require('../dist/reputation/tracking-store.js');

const MINUTE = 60_000;
const origin = Date.parse('2026-11-11T10:00:00Z');

function fixture({ paused = [] } = {}) {
  let time = origin;
  let present = [];
  const intervals = [];
  const runs = [];
  const checkpoints = [];
  const preferences = new Map(paused.map(id => [id, false]));
  const events = [];
  let unavailable = false;
  let loseAcknowledgement = false;
  let leaseLost = false;
  let opens = 0;
  const store = {
    async openRun(_guildId, at) {
      opens++;
      if (unavailable) throw new Error('database unavailable');
      for (const run of runs) if (!run.closedAt) run.closedAt = at;
      const run = { runId: `run-${runs.length + 1}`, startedAt: at, verifiedThrough: at };
      runs.push(run);
      return { runId: run.runId, pausedUserIds: [...preferences].filter(([, on]) => !on).map(([id]) => id) };
    },
    async checkpoint(checkpoint) {
      if (unavailable) throw new Error('database unavailable');
      if (leaseLost) throw new TrackingLeaseLostError();
      const run = runs.find(run => run.runId === checkpoint.runId);
      assert.equal(checkpoint.from.getTime(), run.verifiedThrough.getTime());
      assert.ok(checkpoint.to >= checkpoint.from);
      checkpoints.push(checkpoint);
      for (const userId of checkpoint.userIds) {
        if (checkpoint.to > checkpoint.from && preferences.get(userId) !== false) {
          intervals.push({ userId, from: checkpoint.from, to: checkpoint.to, runId: checkpoint.runId });
        }
      }
      run.verifiedThrough = checkpoint.to;
      if (checkpoint.preference) preferences.set(checkpoint.preference.userId, checkpoint.preference.enabled);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('commit acknowledgement lost');
      }
    },
    async closeRun(_guildId, runId, at, reason) {
      if (unavailable) throw new Error('database unavailable');
      const run = runs.find(run => run.runId === runId);
      run.closedAt = at;
      run.endReason = reason;
    },
    async setTracking(_guildId, { userId, enabled }) {
      if (unavailable) throw new Error('database unavailable');
      preferences.set(userId, enabled);
    },
    async deleteMemberData(_guildId, userId) {
      if (unavailable) throw new Error('database unavailable');
      for (let index = intervals.length - 1; index >= 0; index--) {
        if (intervals[index].userId === userId) intervals.splice(index, 1);
      }
      preferences.set(userId, false);
    },
  };
  const options = {
    guildId: 'guild', store,
    now: () => new Date(time),
    presentUserIds: () => present,
    onStatus: event => events.push(event),
  };
  const tracker = new VoiceTracker(options);
  return {
    tracker, store, intervals, runs, checkpoints, preferences, events, options,
    at(minutes) { time = origin + minutes * MINUTE; },
    present(...ids) { present = ids; },
    outage(value = true) { unavailable = value; },
    loseAcknowledgement() { loseAcknowledgement = true; },
    loseLease() { leaseLost = true; },
    get opens() { return opens; },
    total(userId) { return intervals.filter(row => row.userId === userId).reduce((sum, row) => sum + (row.to - row.from), 0) / MINUTE; },
  };
}

test('checkpoints use the agreed five-minute interval', () => {
  assert.equal(CHECKPOINT_INTERVAL_MS, 5 * MINUTE);
});

test('a member already connected starts earning at activation, not an earlier join', async () => {
  const f = fixture();
  f.present('john');
  await f.tracker.start();
  f.at(5);
  await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  assert.equal(f.intervals[0].from.getTime(), origin);
  assert.equal(f.tracker.status, 'tracking');
});

test('separate visits accumulate without per-visit rounding', async () => {
  const f = fixture();
  await f.tracker.start();
  f.at(1); f.present('john'); await f.tracker.observe();
  f.at(4); f.present(); await f.tracker.observe();
  f.at(5); f.present('john'); await f.tracker.observe();
  f.at(10); await f.tracker.checkpoint();
  f.at(12); f.present(); await f.tracker.observe();
  assert.equal(f.total('john'), 10);
});

test('solo time is full-rate and each member receives only their own observed time', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(2); f.present('john', 'nathan'); await f.tracker.observe();
  f.at(5); f.present('nathan'); await f.tracker.observe();
  f.at(10); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  assert.equal(f.total('nathan'), 8);
});

test('unchanged eligibility does not write on mute, deafen, or normal channel moves', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  for (const minute of [1, 2, 3, 4]) {
    f.at(minute); await f.tracker.observe();
  }
  assert.equal(f.checkpoints.length, 0);
  f.at(5); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  assert.equal(f.checkpoints.length, 1);
});

test('empty-channel checkpoints record coverage without creating activity', async () => {
  const f = fixture();
  await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  assert.deepEqual(f.intervals, []);
  assert.equal(f.runs[0].verifiedThrough.getTime(), origin + 5 * MINUTE);
});

test('pause preserves prior time, resume starts now, and paused time is never backfilled', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(3); await f.tracker.setTracking('john', false);
  f.at(5); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 3);
  assert.equal(f.preferences.get('john'), false);
  f.at(8); await f.tracker.setTracking('john', true);
  f.at(13); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 8);
  assert.equal(f.preferences.get('john'), true);
});

test('persisted opt-out is honored at startup and on rejoin', async () => {
  const f = fixture({ paused: ['john'] });
  f.present('john', 'nathan'); await f.tracker.start();
  f.at(2); f.present('nathan'); await f.tracker.observe();
  f.at(3); f.present('john', 'nathan'); await f.tracker.observe();
  f.at(5); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 0);
  assert.equal(f.total('nathan'), 5);
});

test('database outage discards unsaved time and resumes from a fresh baseline', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.outage(); f.at(10); await f.tracker.checkpoint();
  assert.equal(f.tracker.status, 'unavailable');
  const opens = f.opens;
  await f.tracker.checkpoint(); // Backoff prevents repeated immediate requests.
  assert.equal(f.opens, opens);
  f.outage(false); f.at(12); await f.tracker.checkpoint();
  f.at(17); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 10);
  assert.deepEqual(f.events.map(event => event.status), ['unavailable', 'recovered']);
  assert.equal(f.runs[1].startedAt.getTime(), origin + 12 * MINUTE);
});

test('a committed write with a lost acknowledgement is not duplicated on recovery', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.loseAcknowledgement(); f.at(5); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  f.at(6); await f.tracker.checkpoint(); // New run; no retry of the uncertain batch.
  f.at(11); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 10);
});

test('gateway disconnect excludes the unsaved tail and reconnect gap', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.at(7); await f.tracker.suspend();
  f.at(10); await f.tracker.checkpoint();
  assert.equal(f.tracker.status, 'suspended');
  assert.equal(f.total('john'), 5);
  f.at(12); await f.tracker.start();
  f.at(17); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 10);
});

test('restart never stretches an old session across process downtime', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.at(15);
  const restarted = new VoiceTracker(f.options);
  await restarted.start();
  f.at(20); await restarted.checkpoint();
  assert.equal(f.total('john'), 10);
  assert.equal(f.runs.length, 2);
});

test('a delayed heartbeat does not award an unobserved event-loop suspension', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.at(60); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  assert.equal(f.runs[0].endReason, 'observation-gap');
  f.at(65); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 10);
});

test('stale timestamps cannot move recorded time backwards or double-credit', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.at(4); await f.tracker.checkpoint();
  f.at(10); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 10);
});

test('another tracking owner fences out this process instead of competing for credit', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.loseLease(); f.at(5); await f.tracker.checkpoint();
  f.at(10); await f.tracker.start(); await f.tracker.checkpoint();
  assert.equal(f.tracker.status, 'lease-lost');
  assert.equal(f.opens, 1);
  assert.equal(f.total('john'), 0);
});

test('graceful shutdown flushes the final observed tail and closes coverage', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(3); await f.tracker.stop();
  assert.equal(f.total('john'), 3);
  assert.equal(f.runs[0].endReason, 'shutdown');
  assert.equal(f.tracker.status, 'suspended');
});

test('pause persistence failure is not reported as success', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.outage(); f.at(3);
  await assert.rejects(f.tracker.setTracking('john', false), /unavailable/);
  assert.equal(f.preferences.has('john'), false);
});

test('concurrent observations retain their captured join and leave timestamps', async () => {
  const f = fixture();
  await f.tracker.start();
  f.at(1); f.present('john'); const joined = f.tracker.observe();
  f.at(3); f.present(); const left = f.tracker.observe();
  await Promise.all([joined, left]);
  assert.equal(f.total('john'), 2);
});

test('deletion erases one member, preserves others, and queued work cannot restore erased time', async () => {
  const f = fixture();
  f.present('john', 'nathan'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.at(7); const deleted = f.tracker.deleteData('john');
  f.at(8); const queued = f.tracker.checkpoint();
  await Promise.all([deleted, queued]);
  assert.equal(f.total('john'), 0);
  assert.equal(f.total('nathan'), 8);
  assert.equal(f.preferences.get('john'), false);
  f.at(10); await f.tracker.setTracking('john', true);
  f.at(15); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 5);
  assert.equal(f.total('nathan'), 15);
});

test('deletion failures do not claim success and force persisted-state recovery', async () => {
  const f = fixture();
  f.present('john'); await f.tracker.start();
  f.at(5); await f.tracker.checkpoint();
  f.outage(); f.at(6);
  await assert.rejects(f.tracker.deleteData('john'), /Could not confirm deletion/);
  assert.equal(f.total('john'), 5);
  assert.equal(f.tracker.status, 'unavailable');
});

test('intervals retain millisecond precision and may span Kyiv midnight for later settlement', async () => {
  const f = fixture();
  f.at(719.5); f.present('john'); await f.tracker.start();
  f.at(720.5); await f.tracker.checkpoint();
  assert.equal(f.total('john'), 1);
  assert.equal(f.intervals[0].from.toISOString(), '2026-11-11T21:59:30.000Z');
  assert.equal(f.intervals[0].to.toISOString(), '2026-11-11T22:00:30.000Z');
});
