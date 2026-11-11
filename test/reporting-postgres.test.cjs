const assert = require('node:assert/strict');
const { test } = require('node:test');
const process = require('node:process');
const { randomInt } = require('node:crypto');
const { createReputationDatabase } = require('../dist/reputation/database.js');
const { createReportStore } = require('../dist/reputation/report-store.js');
const { createTrackingStore } = require('../dist/reputation/tracking-store.js');
const { createWarningStore } = require('../dist/reputation/warning-store.js');
const { PublicationPendingError } = require('../dist/reputation/report-errors.js');
const { createReportNavigation } = require('../dist/reputation/reporting.js');
const { ReportPublisher } = require('../dist/reputation/report-publisher.js');
const { kyivDay, nextCalendarDate } = require('../dist/reputation/kyiv-day.js');

const url = process.env.REPUTATION_TEST_DATABASE_URL;
const options = { skip: !url && 'Set REPUTATION_TEST_DATABASE_URL to a disposable migrated test database.' };
const channelId = '222222222222222222';
const messageId = '333333333333333333';
const users = Array.from({ length: 7 }, (_, index) => `11111111111111111${index}`);

async function fixture(callback) {
  const database = createReputationDatabase(url);
  const guildId = `${Date.now()}${randomInt(100000, 999999)}`;
  const day = kyivDay('2026-11-11');
  const store = createReportStore(() => database);
  const tracking = createTrackingStore(() => database);
  try {
    await database.reputationGuild.create({ data: { guildId, reportChannelId: channelId } });
    await database.reputationMember.createMany({ data: users.map(userId => ({ guildId, userId, balance: 900 })) });
    const values = users.map((userId, index) => ({
      guildId, userId, day: day.day, points: index === 6 ? 0 : index < 2 ? 2 : 1,
      eligibleMs: (index === 6 ? 9 : index === 0 ? 29 : index === 1 ? 22 : 10 + index) * 60000,
      balanceAfter: 100 + index,
    }));
    await database.reputationSettlement.create({ data: {
      guildId, day: day.day, startedAt: day.start, endedAt: day.end,
      verifiedMs: day.end - day.start, incomplete: false,
      activityMs: values.reduce((sum, row) => sum + BigInt(row.eligibleMs), 0n),
      pointsAwarded: values.reduce((sum, row) => sum + row.points, 0),
    } });
    await database.reputationDailyAward.createMany({ data: values });
    const queued = await store.pending(guildId);
    assert.equal(queued.length, 1);
    const report = await store.attachMessage(queued[0].id, channelId, messageId);
    await callback({ database, guildId, day, store, tracking, report });
  } finally {
    try {
      await database.reputationReport.deleteMany({ where: { guildId } }); // Cascades entries only.
      await database.reputationWarning.deleteMany({ where: { guildId } });
      await database.reputationDailyAward.deleteMany({ where: { guildId } });
      await database.reputationSettlement.deleteMany({ where: { guildId } });
      await database.reputationVoiceInterval.deleteMany({ where: { guildId } });
      await database.reputationTrackingRun.deleteMany({ where: { guildId } });
      await database.reputationMember.deleteMany({ where: { guildId } });
      await database.reputationGuild.deleteMany({ where: { guildId } });
    } finally { await database.$disconnect(); }
  }
}

test('snapshot ranking, five-person pages, and settled balance values survive erasure and restart', options, async () => {
  await fixture(async f => {
    await f.store.prepare(f.report.id);
    await f.store.finish(f.report.id);
    const first = await f.store.snapshot(f.report.id, 0);
    const last = await f.store.snapshot(f.report.id, 1);
    assert.equal(first.report.entryCount, 6);
    assert.equal(first.entries.length, 5);
    assert.equal(last.entries.length, 1);
    assert.deepEqual(first.entries.slice(0, 2).map(entry => entry.userId), users.slice(0, 2));
    assert.deepEqual(first.entries.slice(2).map(entry => entry.userId), [users[5], users[4], users[3]]);
    assert.equal(last.entries[0].userId, users[2]);
    assert.equal(first.entries[0].balanceAfter, 100); // Not the current live 900.
    await f.tracking.deleteMemberData(f.guildId, users[0], new Date());
    assert.equal(await f.database.reputationDailyAward.count({ where: { guildId: f.guildId, userId: users[0] } }), 0);
    const restarted = createReportStore(() => f.database);
    assert.deepEqual((await restarted.snapshot(f.report.id, 0)).entries, first.entries);
    const navigation = createReportNavigation(async () => {}, restarted);
    const page = await navigation.page({ reportId: f.report.id, page: 0, guildId: f.guildId, channelId, messageId });
    assert.match(page.embeds[0].toJSON().fields[0].value, /100/);
    assert.equal((await restarted.pending(f.guildId)).length, 0);
    assert.equal(await f.database.reputationMember.findUniqueOrThrow({ where: {
      guildId_userId: { guildId: f.guildId, userId: users[0] },
    } }).then(member => member.balance), 0);
  });
});

test('deleting before publication excludes the user and recalculates unpublished report summaries', options, async () => {
  await fixture(async f => {
    await f.tracking.deleteMemberData(f.guildId, users[0], new Date());
    const prepared = await f.store.prepare(f.report.id);
    assert.equal(prepared.entryCount, 5);
    assert.equal(prepared.pointsAwarded, 6);
    const snapshot = await f.store.snapshot(f.report.id, 0);
    assert.equal(snapshot.entries.some(entry => entry.userId === users[0]), false);
    assert.equal(await f.database.reputationSettlement.count({ where: { guildId: f.guildId } }), 1);
    await f.store.finish(f.report.id);
  });
});

test('an ambiguous in-flight publication blocks erasure only until delivery is reconciled', options, async () => {
  await fixture(async f => {
    await f.store.prepare(f.report.id);
    await assert.rejects(f.tracking.deleteMemberData(f.guildId, users[0], new Date()), PublicationPendingError);
    assert.equal(await f.database.reputationMember.findUniqueOrThrow({ where: {
      guildId_userId: { guildId: f.guildId, userId: users[0] },
    } }).then(member => member.balance), 900);
    await f.store.finish(f.report.id);
    await f.tracking.deleteMemberData(f.guildId, users[0], new Date());
    assert.equal((await f.store.snapshot(f.report.id, 0)).entries[0].userId, users[0]);
  });
});

test('snapshot creation and erasure share a lock: no successful deletion can enter a future report', options, async () => {
  await fixture(async f => {
    const [publication, deletion] = await Promise.allSettled([
      f.store.prepare(f.report.id), f.tracking.deleteMemberData(f.guildId, users[0], new Date()),
    ]);
    assert.equal(publication.status, 'fulfilled');
    const snapshot = await f.store.snapshot(f.report.id, 0);
    if (deletion.status === 'fulfilled') assert.equal(snapshot.entries.some(entry => entry.userId === users[0]), false);
    else assert.ok(deletion.reason instanceof PublicationPendingError);
    await f.store.finish(f.report.id);
  });
});

test('lost Discord edit acknowledgement recovers from the same message without changing balances', options, async () => {
  await fixture(async f => {
    let displayed = 'pending';
    let edits = 0;
    let fail = true;
    const publisher = new ReportPublisher({
      guildId: f.guildId, store: f.store, settings: { getReportChannelId: async () => channelId },
      onHealth: () => {},
      transport: {
        inspect: async () => displayed,
        createPlaceholder: async () => { throw new Error('Existing placeholder must be reused'); },
        edit: async () => {
          assert.equal((await f.store.get(f.report.id)).status, 'publishing');
          edits++; displayed = 'published';
          if (fail) { fail = false; throw new Error('lost acknowledgement'); }
        },
      },
    });
    try {
      await publisher.start();
      assert.equal((await f.store.get(f.report.id)).status, 'publishing');
      await publisher.wake();
      assert.equal((await f.store.get(f.report.id)).status, 'published');
      assert.equal(edits, 1);
      const members = await f.database.reputationMember.findMany({ where: { guildId: f.guildId } });
      assert.ok(members.every(member => member.balance === 900));
    } finally { await publisher.stop(); }
  });
});

test('vanished in-flight messages release erasure guards and are not recreated automatically', options, async () => {
  await fixture(async f => {
    await f.store.prepare(f.report.id);
    await f.store.markMissing(f.report.id);
    await f.tracking.deleteMemberData(f.guildId, users[0], new Date());
    assert.equal((await f.store.get(f.report.id)).status, 'missing');
    assert.equal((await f.store.pending(f.guildId)).length, 0);
    assert.equal(await f.database.reputationReportEntry.count({ where: { reportId: f.report.id } }), 0);
  });
});

test('changing destination relocates only pending placeholders, not frozen reports', options, async () => {
  await fixture(async f => {
    const destination = '444444444444444444';
    await f.database.reputationGuild.update({ where: { guildId: f.guildId }, data: { reportChannelId: destination } });
    await f.store.attachMessage(f.report.id, destination, '555555555555555555');
    await f.store.prepare(f.report.id);
    await f.database.reputationGuild.update({ where: { guildId: f.guildId }, data: { reportChannelId: channelId } });
    const current = await f.store.attachMessage(f.report.id, channelId, messageId);
    assert.equal(current.channelId, destination);
    await f.store.finish(f.report.id);
  });
});

test('a backlog of failing reports does not starve newer undelivered dates', options, async () => {
  await fixture(async f => {
    const days = [];
    let date = '2026-10-01';
    for (let index = 0; index < 35; index++) {
      const day = kyivDay(date);
      days.push({ guildId: f.guildId, day: date, startedAt: day.start, endedAt: day.end,
        verifiedMs: 0, incomplete: true, activityMs: 0n, pointsAwarded: 0 });
      date = nextCalendarDate(date);
    }
    await f.database.reputationSettlement.createMany({ data: days });
    const first = await f.store.pending(f.guildId);
    assert.equal(first.length, 31);
    const attempted = new Set(first.map(report => report.id));
    for (const report of first) await f.store.noteAttempt(report.id);
    const next = await f.store.pending(f.guildId);
    assert.ok(next.some(report => report.day === f.day.day));
    assert.ok(next.slice(0, 5).every(report => !attempted.has(report.id)));
  });
});

test('warning message identity, issue groups, and hourly timestamp persist independently of members', options, async () => {
  await fixture(async f => {
    const warnings = createWarningStore(() => f.database);
    const at = new Date();
    const details = { tracking: ['database-timeout'], reports: ['discord-send-messages'] };
    const history = [{ id: 'first-warning', at: at.toISOString(), reasons: ['reports', 'tracking'], details }];
    await warnings.save(f.guildId, {
      channelId, messageId, reasons: ['tracking', 'reports'], history, activeSince: at,
      lastSeenAt: at, lastEditedAt: at, displayedActive: true,
    });
    const reloaded = await createWarningStore(() => f.database).load(f.guildId);
    assert.equal(reloaded.destination, channelId);
    assert.equal(reloaded.state.messageId, messageId);
    assert.equal(reloaded.state.lastEditedAt.getTime(), at.getTime());
    assert.deepEqual(reloaded.state.history, history);
    assert.deepEqual(reloaded.state.details, details);
    await f.tracking.deleteMemberData(f.guildId, users[0], at);
    assert.deepEqual((await warnings.load(f.guildId)).state.reasons, ['tracking', 'reports']);
    assert.deepEqual((await warnings.load(f.guildId)).state.history, history);
  });
});

test('legacy warning rows default to empty history and database rejects non-array history',options,async()=>{
  await fixture(async f=>{
    await f.database.reputationWarning.create({data:{guildId:f.guildId,lastSeenAt:new Date(),reasons:['tracking']}});
    const loaded = await createWarningStore(()=>f.database).load(f.guildId);
    assert.deepEqual(loaded.state.history,[]);
    await assert.rejects(f.database.reputationWarning.update({where:{guildId:f.guildId},data:{history:{invalid:true}}}));
    assert.deepEqual((await f.database.reputationWarning.findUniqueOrThrow({where:{guildId:f.guildId}})).history,[]);
  });
});
