const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderReport } = require('../dist/reputation/report-render.js');
const at = new Date('2026-11-11T22:00:00Z');
const report = { id: '11111111-1111-4111-8111-111111111111', guildId: 'guild', day: '2026-11-11', status: 'published',
  createdAt: at, preparedAt: at, publishedAt: at, endedAt: at, startedAt: new Date(at.getTime() - 86400000),
  entryCount: 1, pointsAwarded: 3.25, activityMs: 2700000n, incomplete: false, verifiedMs: 86400000 };
const entry = { userId: '111111111111111111', position: 0, eligibleMs: 2700000, soloMs: 755000, points: 3.25, balanceAfter: 103.25 };
test('midnight reports add actual solo time beneath total time without changing points or frozen balances', () => {
  const payload = renderReport({ report, entries: [entry], page: 0 });
  const field = payload.embeds[0].toJSON().fields[0];
  assert.match(field.value, /0 год 45 хв 0 с/);
  assert.match(field.value, /\nНаодинці: \*\*0 год 12 хв 35 с\*\*/);
  assert.match(field.name, /3,25/); assert.match(field.value, /103,25/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});
test('sub-second solo visits are indicated without displaying a misleading zero duration', () => {
  const field = renderReport({ report, entries: [{ ...entry, soloMs: 500 }], page: 0 }).embeds[0].toJSON().fields[0];
  assert.match(field.value, /Наодинці: \*\*менше 1 с\*\*/);
});
test('zero/unknown historical solo duration adds no line or claim of company', () => {
  for (const soloMs of [0, null, undefined]) {
    const field = renderReport({ report, entries: [{ ...entry, soloMs }], page: 0 }).embeds[0].toJSON().fields[0];
    assert.doesNotMatch(field.value, /Наодинці|разом|компанії/);
  }
});
test('solo labels preserve ten-person pagination and support full 25-hour DST days', () => {
  const entries = Array.from({ length: 10 }, (_, position) => ({ ...entry, position, eligibleMs: 90000000, soloMs: position === 0 ? 90000000 : 0 }));
  const payload = renderReport({ report: { ...report, entryCount: 11 }, entries, page: 0 });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.fields.length, 10); assert.match(embed.fields[0].value, /Наодинці: \*\*25 год 0 хв 0 с/);
  assert.doesNotMatch(embed.fields[1].value, /Наодинці/); assert.equal(payload.components.length, 1);
});
