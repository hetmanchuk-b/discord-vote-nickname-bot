const assert = require('node:assert/strict');
const process = require('node:process');
const { test } = require('node:test');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('./helpers/point-test-database.cjs');
const { createReportSettingsStore } = require('../dist/reputation/report-settings.js');
const { createTrackingStore, TrackingLeaseLostError } = require('../dist/reputation/tracking-store.js');

// Apply ALL checked-in migrations to the disposable database before opting in.
// Explicit opt-in only. Never defaults to the user's real DATABASE_URL.
const url = process.env.REPUTATION_TEST_DATABASE_URL;

test('PostgreSQL persists settings and default tracking preferences across connections', {
  skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.',
}, async () => {
  const guildId = `${Date.now()}${randomInt(100000, 999999)}`;
  const userId = '111111111111111111';
  let database = createReputationDatabase(url);
  try {
    const settings = createReportSettingsStore(() => database.raw);
    await settings.setReportChannelId(guildId, '222222222222222222');
    const member = await database.reputationMember.create({ data: { guildId, userId } });
    assert.equal(member.isTracking, true);
    assert.equal(member.balance, 0);
    await database.reputationMember.update({
      where: { guildId_userId: { guildId, userId } },
      data: { isTracking: false },
    });
    await database.$disconnect();
    database = createReputationDatabase(url);
    assert.equal(await settings.getReportChannelId(guildId), '222222222222222222');
    const persisted = await database.reputationMember.findUniqueOrThrow({
      where: { guildId_userId: { guildId, userId } },
    });
    assert.equal(persisted.isTracking, false);
    await settings.setReportChannelId(guildId, '333333333333333333');
    assert.equal(await settings.getReportChannelId(guildId), '333333333333333333');
  } finally {
    try {
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally {
      await database.$disconnect();
    }
  }
});

test('PostgreSQL checkpoints are atomic, fenced, and exclude persisted opt-outs', {
  skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.',
}, async () => {
  const guildId = `${Date.now()}${randomInt(100000, 999999)}`;
  const database = createReputationDatabase(url);
  const store = createTrackingStore(() => database.raw);
  const john = '111111111111111111';
  const nathan = '222222222222222222';
  const at = minute => new Date(Date.UTC(2026, 10, 11, 0, minute));
  try {
    const { runId } = await store.openRun(guildId, at(0));
    await store.checkpoint({ guildId, runId, from: at(0), to: at(5), userIds: [john, nathan],
      preference: { userId: john, enabled: false } });
    await store.checkpoint({ guildId, runId, from: at(5), to: at(10), userIds: [john, nathan] });
    const intervals = await database.reputationVoiceInterval.findMany({ where: { guildId } });
    assert.equal(intervals.filter(row => row.userId === john).length, 1);
    assert.equal(intervals.filter(row => row.userId === nathan).length, 2);
    // Stale/replayed checkpoints cannot duplicate intervals.
    await assert.rejects(store.checkpoint({
      guildId, runId, from: at(0), to: at(5), userIds: [john, nathan],
    }), TrackingLeaseLostError);
    assert.equal(await database.reputationVoiceInterval.count({ where: { guildId } }), 3);

    // A bad preference forces rollback of the coverage update AND interval inserts.
    await assert.rejects(store.checkpoint({
      guildId, runId, from: at(10), to: at(11), userIds: [nathan],
      preference: { userId: 'x'.repeat(30), enabled: false },
    }));
    const run = await database.reputationTrackingRun.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.verifiedThrough.getTime(), at(10).getTime());
    assert.equal(await database.reputationVoiceInterval.count({ where: { guildId } }), 3);

    const replacement = await store.openRun(guildId, at(12));
    assert.deepEqual(replacement.pausedUserIds, [john]);
    await assert.rejects(store.checkpoint({
      guildId, runId, from: at(10), to: at(15), userIds: [nathan],
    }), TrackingLeaseLostError);
    await store.checkpoint({
      guildId, runId: replacement.runId, from: at(12), to: at(17), userIds: [nathan],
    });
    await store.closeRun(guildId, replacement.runId, at(17), 'shutdown');
    assert.equal(await database.reputationVoiceInterval.count({ where: { guildId } }), 4);
  } finally {
    try {
      await database.reputationVoiceInterval.deleteMany({ where: { guildId } });
      await database.reputationTrackingRun.deleteMany({ where: { guildId } });
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally {
      await database.$disconnect();
    }
  }
});
