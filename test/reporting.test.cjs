const assert = require('node:assert/strict');
const { test } = require('node:test');
const { structuredClone } = globalThis;
const { setImmediate } = require('node:timers/promises');
const { MessageFlags } = require('discord.js');
const { ReportPublisher } = require('../dist/reputation/report-publisher.js');
const { OperationalWarnings, renderWarning } = require('../dist/reputation/operational-warnings.js');
const { warningHistory, WARNING_HISTORY_LIMIT } = require('../dist/reputation/warning-store.js');
const { renderReport, renderPlaceholder } = require('../dist/reputation/report-render.js');
const { createReportNavigation } = require('../dist/reputation/reporting.js');
const { handleReputationPage } = require('../dist/buttons/reputation-report.js');

const id = '11111111-1111-4111-8111-111111111111';
const origin = Date.parse('2026-11-11T22:00:00Z');
function report(overrides = {}) {
  return { id, guildId: 'guild', day: '2026-11-11', status: 'pending', channelId: null, messageId: null,
    createdAt: new Date(origin), preparedAt: new Date(origin), publishedAt: null,
    activityMs: 600000n, pointsAwarded: 1, entryCount: 1, pageSize: 15, formatVersion: 2, startedAt: new Date(origin - 86400000),
    endedAt: new Date(origin), incomplete: false, verifiedMs: 86400000, ...overrides };
}
const entry = position => ({ userId: `user-${position}`, position, eligibleMs: 600000, soloMs: 0, points: 1, balanceAfter: 100 + position, dailyPoints: 1, voteRewards: 0, votePenalties: 0, rewardVoteCount: 0, penaltyVoteCount: 0 });

function publisherFixture(t, overrides = {}) {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let current = report(overrides);
  let destination = 'channel';
  let displayed = 'pending';
  let loseEdit = false;
  let loseFinish = false;
  const calls = { create: 0, edit: 0, finish: 0, prepare: 0, missing: 0 };
  const health = [];
  const healthDetails = [];
  const store = {
    pending: async () => ['pending', 'publishing'].includes(current.status) ? [structuredClone(current)] : [],
    get: async () => structuredClone(current),
    noteAttempt: async () => {},
    attachMessage: async (_id, channelId, messageId) => { current = { ...current, channelId, messageId }; return structuredClone(current); },
    clearPlaceholder: async () => { current.messageId = null; },
    prepare: async () => { calls.prepare++; current.status = 'publishing'; return structuredClone(current); },
    snapshot: async (_id, page) => ({ report: structuredClone(current), page, entries: [entry(0)] }),
    finish: async () => {
      calls.finish++;
      if (loseFinish) { loseFinish = false; throw new Error('unknown acknowledgement'); }
      current.status = 'published'; current.publishedAt = new Date(origin);
    },
    markMissing: async () => { calls.missing++; current.status = 'missing'; },
  };
  const publisher = new ReportPublisher({
    guildId: 'guild', store,
    settings: { getReportChannelId: async () => destination },
    transport: {
      createPlaceholder: async () => { calls.create++; return 'message'; },
      inspect: async () => displayed,
      edit: async () => {
        assert.equal(current.status, 'publishing'); calls.edit++; displayed = 'published';
        if (loseEdit) { loseEdit = false; throw new Error('unknown edit acknowledgement'); }
      },
    },
    onHealth: (value, details) => { health.push(value); healthDetails.push(details); },
  });
  return { publisher, calls, health, healthDetails, timers, store,
    current: () => current, destination(value) { destination = value; },
    display(value) { displayed = value; },
    loseEdit() { loseEdit = true; }, loseFinish() { loseFinish = true; },
  };
}

test('publisher uses a placeholder, freezes once, and never republishes completed data', async t => {
  const f = publisherFixture(t);
  await f.publisher.start();
  await f.publisher.wake();
  assert.deepEqual(f.calls, { create: 1, edit: 1, finish: 1, prepare: 1, missing: 0 });
  assert.equal(f.current().status, 'published');
  await f.publisher.stop();
});

for (const lost of ['loseEdit', 'loseFinish']) {
  test(`${lost}: restart/retry adopts the published marker instead of duplicating delivery`, async t => {
    const f = publisherFixture(t);
    f[lost]();
    await f.publisher.start();
    assert.equal(f.current().status, 'publishing');
    assert.equal(f.timers.at(-1).delay, 60000);
    await f.publisher.wake();
    assert.equal(f.current().status, 'published');
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.edit, 1);
    assert.equal(f.calls.prepare, 1);
    assert.deepEqual(f.health, [false, true]);
    await f.publisher.stop();
  });
}

test('missing configuration queues the report until a channel is configured', async t => {
  const f = publisherFixture(t);
  f.destination(null);
  await f.publisher.start();
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.prepare, 0);
  assert.deepEqual(f.healthDetails[0], ['report-channel-unconfigured']);
  f.destination('new-channel');
  await f.publisher.wake();
  assert.equal(f.current().channelId, 'new-channel');
  assert.equal(f.current().status, 'published');
  await f.publisher.stop();
});

test('a deleted in-flight message becomes terminal missing instead of republishing user data', async t => {
  const f = publisherFixture(t, { status: 'publishing', channelId: 'channel', messageId: 'message' });
  f.display('missing');
  await f.publisher.start(); await f.publisher.wake();
  assert.equal(f.calls.missing, 1);
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.edit, 0);
  await f.publisher.stop();
});

test('changing configuration does not relocate an in-flight frozen report', async t => {
  const f = publisherFixture(t, { status: 'publishing', channelId: 'old-channel', messageId: 'message' });
  f.destination('new-channel');
  await f.publisher.start();
  assert.equal(f.current().channelId, 'old-channel');
  assert.equal(f.calls.create, 0);
  await f.publisher.stop();
});

test('a wake-up arriving during publication is coalesced into a follow-up scan', async t => {
  const f = publisherFixture(t);
  const pending = f.store.pending;
  let scans = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.store.pending = async (...args) => { scans++; if (scans === 1) await gate; return pending(...args); };
  const first = f.publisher.start();
  const second = f.publisher.wake();
  release(); await Promise.all([first, second]); await setImmediate();
  assert.equal(scans, 2);
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.edit, 1);
  await f.publisher.stop();
});

test('report rendering is fifteen per page with frozen balances and disabled edge buttons', () => {
  const first = renderReport({ report: report({ entryCount: 16 }), entries: Array.from({ length: 15 }, (_, i) => entry(i)), page: 0 });
  assert.equal(first.embeds[0].toJSON().fields.length, 15);
  assert.match(first.embeds[0].toJSON().footer.text, /Сторінка 1\/2/);
  assert.match(first.embeds[0].toJSON().fields[0].value, /100/);
  const buttons = first.components[0].toJSON().components;
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false);
  const last = renderReport({ report: report({ entryCount: 16 }), entries: [entry(15)], page: 1 });
  assert.match(last.embeds[0].toJSON().footer.text, /Сторінка 2\/2/);
  assert.match(last.embeds[0].toJSON().fields[0].name, /#16/);
  assert.equal(last.embeds[0].toJSON().fields.length, 1);
  assert.equal(last.components[0].toJSON().components[1].disabled, true);
  assert.deepEqual(first.allowedMentions, { parse: [] });
  assert.ok(buttons.every(button => button.custom_id.length <= 100));
});

for (const count of [1, 5, 10, 15]) {
  test(`${count} report entries fit on a single page without navigation buttons`, () => {
    const payload = renderReport({ report: report({ entryCount: count }), entries: Array.from({ length: count }, (_, i) => entry(i)), page: 0 });
    assert.equal(payload.embeds[0].toJSON().fields.length, count);
    assert.match(payload.embeds[0].toJSON().footer.text, /Сторінка 1\/1/);
    assert.deepEqual(payload.components, []);
  });
}

for (const [overrides, text] of [
  [{ entryCount: 0, activityMs: 0n }, 'No activity recorded'],
  [{ entryCount: 0, activityMs: 540000n }, 'No reputation earned today'],
  [{ entryCount: 0, activityMs: 0n, incomplete: true }, 'No verified activity recorded'],
]) {
  test(`empty report distinguishes: ${text}`, () => {
    const payload = renderReport({ report: report({ ...overrides, formatVersion: 1, pageSize: 10 }), entries: [], page: 0 });
    assert.match(payload.embeds[0].toJSON().description, new RegExp(text));
    assert.deepEqual(payload.components, []);
  });
}

test('report warns about partial coverage and labels delayed original-day results', () => {
  const payload = renderReport({ report: report({ incomplete: true, preparedAt: new Date(origin + 86400000) }), entries: [entry(0)], page: 0 });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /2026-11-11/);
  assert.match(embed.description, /неповним/);
  assert.match(embed.description, /затримкою/);
  assert.equal(renderPlaceholder(report()).embeds[0].toJSON().fields, undefined);
  const delayedDelivery = renderReport({ report: report(), entries: [entry(0)], page: 0 }, new Date(origin + 86400000));
  assert.match(delayedDelivery.embeds[0].toJSON().description, /затримкою/);
});

test('navigation validates report status and exact guild/channel/message before reading entries', async () => {
  let reads = 0;
  const current = report({ status: 'published', channelId: 'channel', messageId: 'message', entryCount: 16 });
  const navigation = createReportNavigation(async () => {}, {
    get: async () => current,
    snapshot: async (_id, page) => { reads++; return { report: current, entries: [entry(page * 15)], page }; },
  });
  const request = { reportId: id, page: 1, guildId: 'guild', channelId: 'channel', messageId: 'message' };
  for (const change of [{ guildId: 'other' }, { channelId: 'other' }, { messageId: 'other' }, { page: -1 }, { page: 2 }]) {
    assert.equal(await navigation.page({ ...request, ...change }), null);
  }
  assert.equal(reads, 0);
  assert.ok(await navigation.page(request));
  assert.equal(reads, 1);
  current.entryCount = 15;
  assert.equal(await navigation.page(request), null);
  assert.equal(reads, 1);
  current.status = 'publishing';
  assert.equal(await navigation.page(request), null);
});

test('pagination acknowledges immediately and serializes shared message edits in click order', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const interaction = page => ({
    customId: `reputation:page:${id}:${page}`, guildId: 'guild', channelId: 'channel', message: { id: 'message' },
    deferUpdate: async () => { calls.push(`ack-${page}`); },
    client: { reputationReports: { page: async request => {
      calls.push(`read-${request.page}`); if (request.page === 0) await gate;
      return { content: String(request.page) };
    } } },
    editReply: async payload => { calls.push(`edit-${payload.content}`); },
  });
  const first = handleReputationPage(interaction(0));
  const second = handleReputationPage(interaction(1));
  await setImmediate();
  assert.deepEqual(calls, ['ack-0', 'ack-1', 'read-0']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls.slice(-3), ['edit-0', 'read-1', 'edit-1']);
});

test('invalid pagination IDs return a private error without database work', async () => {
  let response;
  await handleReputationPage({ customId: 'reputation:page:invalid:-1', guildId: 'guild', reply: async payload => { response = payload; } });
  assert.equal(response.flags, MessageFlags.Ephemeral);
});

function warningFixture(t, saved = null) {
  let at = origin;
  let stored = saved ? structuredClone(saved) : null;
  let unavailable = false;
  let loadUnavailable = false;
  let loseAck = false;
  const delivered = new Map();
  const updates = [];
  const timers = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const store = {
    load: async () => { if (loadUnavailable) throw new Error('offline'); return { destination: 'channel', state: stored ? structuredClone(stored) : null }; },
    save: async (_id, value) => { if (unavailable) throw new Error('offline'); stored = structuredClone(value); },
  };
  const warnings = new OperationalWarnings({ guildId: 'guild', store, now: () => new Date(at),
    transport: { warning: async (channel, message, _guild, payload) => {
      const id = message ?? delivered.get(channel) ?? `message-${updates.length + 1}`;
      delivered.set(channel, id);
      updates.push({ channel, message: id, payload, at });
      if (loseAck) { loseAck = false; throw new Error('warning acknowledgement lost'); }
      return id;
    } },
  });
  return { warnings, updates, timers, store,
    at(minutes) { at = origin + minutes * 60000; },
    dbDown(value) { unavailable = value; }, loadDown(value) { loadUnavailable = value; },
    saved: () => stored, loseAck() { loseAck = true; },
  };
}

test('warnings reuse one message: immediate alert, hourly updates, final recovery only after all issues clear', async t => {
  const f = warningFixture(t);
  await f.warnings.start();
  assert.equal(f.updates.length, 0);
  await f.warnings.setIssue('tracking', true);
  f.at(10); await f.warnings.setIssue('settlement', true);
  assert.equal(f.updates.length, 1);
  f.at(60); await f.warnings.start();
  assert.equal(f.updates.length, 2);
  assert.equal(f.updates[0].message, f.updates[1].message);
  f.at(61); await f.warnings.setIssue('tracking', false);
  assert.equal(f.updates.length, 2);
  f.at(62); await f.warnings.setIssue('settlement', false);
  assert.equal(f.updates.length, 3);
  assert.equal(f.updates[2].message, f.updates[0].message);
  assert.match(f.updates[2].payload.embeds[0].toJSON().title, /відновлено/);
  const description = f.updates[2].payload.embeds[0].toJSON().description;
  for (const time of ['00:00','00:10','01:00','01:01','01:02']) assert.ok(description.includes(time));
  assert.match(description, /Відстеження голосових каналів/);
  assert.match(description, /Щоденне зарахування/);
  assert.match(description, /✅ Усі відомі проблеми усунено/);
  assert.equal(f.saved().history.length, 5);
  assert.deepEqual(f.updates[0].payload.allowedMentions, { parse: [] });
  await f.warnings.stop();
});

test('warning restart restores the saved message and hourly throttle', async t => {
  const saved = { channelId: 'channel', messageId: 'existing', reasons: ['tracking'], activeSince: new Date(origin),
    lastSeenAt: new Date(origin), lastEditedAt: new Date(origin), displayedActive: true };
  const f = warningFixture(t, saved);
  f.at(30); await f.warnings.start();
  assert.equal(f.updates.length, 0);
  f.at(60); await f.warnings.start();
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].message, 'existing');
  assert.equal(f.saved().history.length, 2); // Latest legacy state plus the new hourly update.
  assert.match(f.updates[0].payload.embeds[0].toJSON().description, /00:00/);
  assert.match(f.updates[0].payload.embeds[0].toJSON().description, /01:00/);
  await f.warnings.stop();
});

test('database failure after delivery does not repeatedly resend the warning', async t => {
  const f = warningFixture(t);
  await f.warnings.start(); f.dbDown(true);
  await f.warnings.setIssue('tracking', true);
  assert.equal(f.updates.length, 1);
  assert.equal(f.timers.at(-1).delay, 5 * 60000);
  f.at(5); await f.warnings.start();
  assert.equal(f.updates.length, 1);
  f.dbDown(false); await f.warnings.setIssue('tracking', false);
  assert.equal(f.updates.length, 2);
  assert.equal(f.saved().displayedActive, false);
  await f.warnings.stop();
});

test('cold-start database outage never guesses a channel; alert is delivered after recovery', async t => {
  const f = warningFixture(t);
  f.loadDown(true);
  await f.warnings.setIssue('tracking', true);
  assert.equal(f.updates.length, 0);
  f.loadDown(false); await f.warnings.start();
  assert.equal(f.updates.length, 1);
  await f.warnings.stop();
});

test('reloading old warning metadata after an outage does not discard a newly delivered message ID', async t => {
  const f = warningFixture(t);
  f.loadDown(true);
  await f.warnings.channelChanged('channel');
  await f.warnings.setIssue('tracking', true);
  assert.equal(f.updates.length, 1);
  f.loadDown(false); await f.warnings.start();
  assert.equal(f.updates.length, 1);
  assert.equal(f.saved().messageId, f.updates[0].message);
  await f.warnings.stop();
});

test('an uncertain alert is reconciled to a recovery edit even if no message ID was acknowledged', async t => {
  const f = warningFixture(t);
  await f.warnings.start();
  f.loseAck(); await f.warnings.setIssue('tracking', true);
  assert.equal(f.saved().deliveryUncertain, true);
  await f.warnings.setIssue('tracking', false);
  assert.equal(f.updates.length, 2);
  assert.equal(f.updates[0].message, f.updates[1].message);
  assert.match(f.updates[1].payload.embeds[0].toJSON().title, /відновлено/);
  assert.equal(f.saved().deliveryUncertain, false);
  await f.warnings.stop();
});

test('active warnings follow a changed configured channel without repeated pings', async t => {
  const f = warningFixture(t);
  await f.warnings.setIssue('reports', true);
  await f.warnings.channelChanged('new-channel');
  assert.equal(f.updates.at(-1).channel, 'new-channel');
  assert.notEqual(f.updates[0].message, f.updates[1].message);
  assert.match(f.updates[1].payload.embeds[0].toJSON().description, /00:00/);
  await f.warnings.stop();
});

test('warning restart preserves earlier incidents while appending a new hourly timestamp', async t => {
  const history = [
    { id:'old-incident', at:new Date(origin-60*60000).toISOString(), reasons:['reports'] },
    { id:'current-incident', at:new Date(origin).toISOString(), reasons:['tracking'] },
  ];
  const f = warningFixture(t,{ channelId:'channel',messageId:'existing',reasons:['tracking'],history,
    activeSince:new Date(origin),lastSeenAt:new Date(origin),lastEditedAt:new Date(origin),
    displayedActive:true,deliveryUncertain:false });
  f.at(60); await f.warnings.start();
  assert.equal(f.saved().history.length,3);
  assert.equal(f.saved().history[0].id,'old-incident');
  const description = f.updates[0].payload.embeds[0].toJSON().description;
  assert.match(description,/23:00/);
  assert.match(description,/00:00/);
  assert.match(description,/01:00/);
  assert.match(description,/Доставка щоденних звітів/);
  await f.warnings.stop();
});

test('uncertain delivery retries reuse the history entry rather than appending duplicates', async t => {
  const f = warningFixture(t);
  await f.warnings.start();
  f.loseAck(); await f.warnings.setIssue('tracking',true);
  const firstId = f.saved().history[0].id;
  f.at(5); await f.warnings.start();
  assert.equal(f.updates.length,2);
  assert.equal(f.saved().history.length,1);
  assert.equal(f.saved().history[0].id,firstId);
  f.at(6); await f.warnings.setIssue('tracking',false);
  assert.equal(f.saved().history.length,2);
  assert.match(f.updates.at(-1).payload.embeds[0].toJSON().description,/00:06/);
  await f.warnings.stop();
});

test('recovering database access merges old persisted history with new locally delivered incidents', async t => {
  const history = [{id:'persisted-before-outage',at:new Date(origin-60*60000).toISOString(),reasons:['reports']}];
  const f = warningFixture(t,{channelId:'channel',messageId:'old',reasons:['reports'],history,
    activeSince:new Date(origin-60*60000),lastSeenAt:new Date(origin-60*60000),
    lastEditedAt:new Date(origin-60*60000),displayedActive:true,deliveryUncertain:false});
  f.loadDown(true);
  await f.warnings.channelChanged('channel');
  await f.warnings.setIssue('tracking',true);
  const localMessage = f.updates[0].message;
  f.loadDown(false); f.at(5); await f.warnings.start();
  assert.equal(f.saved().messageId,localMessage);
  assert.equal(f.saved().history.length,2);
  assert.equal(f.saved().history[0].id,'persisted-before-outage');
  assert.deepEqual(f.saved().history[1].reasons,['tracking']);
  await f.warnings.stop();
});

test('history retains at most 100 events and Discord shows whole newest entries within 4096 characters', () => {
  const history = Array.from({length:120},(_,index)=>({
    id:`entry-${index}`,at:new Date(origin+index*60000).toISOString(),reasons:['reports','settlement','tracking'],
  }));
  const normalized = warningHistory(history);
  assert.equal(normalized.length,WARNING_HISTORY_LIMIT);
  assert.equal(normalized[0].id,'entry-20');
  const payload = renderWarning('guild',{reasons:['tracking'],history},new Date(origin));
  const description = payload.embeds[0].toJSON().description;
  assert.ok(description.length<=4096);
  assert.match(description,/Показано останні події/);
  assert.match(description,/01:59/);
  assert.doesNotMatch(description,/00:00/);
  assert.match(description.split('\n').at(-1),/^\*\*.*01:59\*\* — ⚠️/);
  assert.equal(history.length,120); // Rendering must not mutate the caller's data.
  assert.deepEqual(payload.allowedMentions,{parse:[]});
});

test('history rejects unknown reasons, malformed dates, and duplicate IDs without exposing raw strings', () => {
  const history = [
    {id:'safe',at:new Date(origin).toISOString(),reasons:['tracking']},
    {id:'safe',at:new Date(origin).toISOString(),reasons:[]},
    {id:'bad-reason',at:new Date(origin).toISOString(),reasons:['postgres://private-secret']},
    {id:'bad-date',at:'private-secret',reasons:['tracking']},
    null,42,
  ];
  assert.equal(warningHistory(history).length,1);
  const description = renderWarning('guild',{reasons:[],history},new Date(origin)).embeds[0].toJSON().description;
  assert.doesNotMatch(description,/private-secret/);
  assert.match(description,/Відстеження голосових каналів/);
});

test('warning timestamps use Kyiv DST offsets, not the machine timezone', () => {
  for (const [at,expected] of [['2026-01-01T12:34:00.000Z','14:34'],['2026-07-01T12:34:00.000Z','15:34']]) {
    const description = renderWarning('guild',{reasons:['tracking'],history:[{id:'event',at,reasons:['tracking']}]},new Date(at))
      .embeds[0].toJSON().description;
    assert.ok(description.includes(expected));
    assert.match(description,/Europe\/Kyiv/);
  }
});

test('specific causes change within a category, survive generic refreshes, and remain in recovery history',async t=>{
  const f=warningFixture(t);
  await f.warnings.start();
  await f.warnings.setIssue('tracking',true,['database-timeout']);
  f.at(10);await f.warnings.setIssue('tracking',true,['database-authentication']);
  assert.equal(f.updates.length,1); // Preserve hourly throttling.
  assert.equal(f.saved().history.length,2);
  f.at(11);await f.warnings.setIssue('tracking',true);
  assert.deepEqual(f.saved().details.tracking,['database-authentication']);
  assert.equal(f.saved().history.length,2);
  f.at(60);await f.warnings.start();
  const description=f.updates.at(-1).payload.embeds[0].toJSON().description;
  assert.match(description,/час очікування відповіді бази даних/);
  assert.match(description,/відхилила автентифікацію/);
  f.at(62);await f.warnings.setIssue('tracking',false);
  const recovered=f.updates.at(-1).payload.embeds[0].toJSON().description;
  assert.match(recovered,/✅ Усі відомі проблеми усунено/);
  assert.match(recovered,/відхилила автентифікацію/);
  assert.deepEqual(f.saved().details,{});
  await f.warnings.stop();
});

test('report publication forwards safe database diagnostics rather than raw errors',async t=>{
  const f=publisherFixture(t);
  f.store.pending=async()=>{throw {code:'P2021',message:'private connection string'};};
  await f.publisher.start();
  assert.deepEqual(f.healthDetails[0],['database-schema']);
  assert.doesNotMatch(JSON.stringify(f.healthDetails),/private/);
  await f.publisher.stop();
});
