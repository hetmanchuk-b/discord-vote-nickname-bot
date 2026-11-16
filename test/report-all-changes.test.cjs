const assert = require('node:assert/strict');
const { test } = require('node:test');
const { summarizeReportChanges } = require('../dist/reputation/report-changes.js');
const { renderReport } = require('../dist/reputation/report-render.js');
const { reportPageCount, reportPageSize } = require('../dist/reputation/report-pagination.js');
const at = new Date('2026-11-11T22:00:00Z');
const report = { id: '11111111-1111-4111-8111-111111111111', day: '2026-11-11', formatVersion: 2, pageSize: 15,
  createdAt: at, preparedAt: at, publishedAt: at, endedAt: at, entryCount: 1, pointsAwarded: -5, activityMs: 0n, incomplete: false };
const award = (userId, points, eligibleMs = 0) => ({ userId, points, eligibleMs, soloMs: 0, balanceAfter: 400 });
const totals = (userId, rewards = 0n, penalties = 0n) => ({ userId, rewards, penalties, rewardCount: rewards ? 1n : 0n, penaltyCount: penalties ? 1n : 0n });
test('report summaries include negative daily deltas, vote-only users, and offsetting changes with zero net', () => {
  const result = summarizeReportChanges([award('a', 4, 600000), award('b', -20), award('c', 0), award('d', -40), award('e', 0), award('empty', 0)],
    [totals('a', 200n, 40n), totals('c', 0n, 40n), totals('d', 40n), totals('e', 40n, 40n), totals('erased', 400n)]);
  assert.deepEqual(result.entries.map(row => [row.userId, row.points]), [['a',164],['d',0],['e',0],['b',-20],['c',-40]]);
  assert.equal(result.pointsAwarded,104); assert.equal(result.entries[0].dailyPoints,4); assert.equal(result.entries[0].voteRewards,200);
  assert.equal(result.entries[0].balanceAfter,400); // Never recalculate financial balances.
});
test('quarter units are exact and summary overflow/inconsistent audit totals are rejected', () => {
  assert.equal(summarizeReportChanges([award('a',0)], [totals('a',1n)]).pointsAwarded,1);
  assert.throws(() => summarizeReportChanges([award('a',2147483647)], [totals('a',1n)]), /capacity/);
  assert.throws(() => summarizeReportChanges([award('a',0)], [{ ...totals('a',1n), rewardCount: 0n }]), /Invalid/);
});
test('detailed reports label absence and vote changes separately, use signed net amounts, and distinguish no changes from zero-net activity', () => {
  const entry = { userId:'111111111111111111', position:0, eligibleMs:0, soloMs:0, points:0, balanceAfter:100,
    dailyPoints:-10, voteRewards:10, votePenalties:0, rewardVoteCount:1, penaltyVoteCount:0 };
  const payload = renderReport({ report: { ...report, pointsAwarded:0 }, entries:[entry], page:0 });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.description,/Зміна за день:\*\* 0/); assert.doesNotMatch(embed.description,/немає/);
  assert.match(embed.fields[0].name, /· 0 балів/); assert.match(embed.fields[0].value,/Пропуск дня: \*\*-10/);
  assert.match(embed.fields[0].value,/Голосування — нагороди: \*\*\+10\*\* \(опитувань: 1\)/);
  const fine = renderReport({ report, entries:[{ ...entry, points:-5, dailyPoints:0, voteRewards:0, votePenalties:5, penaltyVoteCount:2 }], page:0 }).embeds[0].toJSON();
  assert.match(fine.fields[0].name, /· -5 балів/); assert.doesNotMatch(fine.fields[0].name,/\+-/);
  assert.match(fine.fields[0].value,/Голосування — штрафи: \*\*−5\*\* \(опитувань: 2\)/);
  const empty = renderReport({ report:{...report, entryCount:0, pointsAwarded:0}, entries:[],page:0 }).embeds[0].toJSON();
  assert.match(empty.description,/Змін репутації за день немає/);
  assert.deepEqual(payload.allowedMentions,{parse:[]});
});
test('fifteen maximal detailed rows fit Discord embed limits and legacy layouts remain ten per page', () => {
  const entries = Array.from({length:15},(_,position)=>({userId:'99999999999999999999',position,eligibleMs:90000000,soloMs:90000000,
    points:-2147483647/4,balanceAfter:-500,dailyPoints:-2147483647/4,voteRewards:2147483647/4,votePenalties:2147483647/4,rewardVoteCount:2147483647,penaltyVoteCount:2147483647}));
  const payload = renderReport({report:{...report,entryCount:16,incomplete:true,pointsAwarded:-2147483647/4},entries,page:0});
  const embed=payload.embeds[0].toJSON();
  assert.equal(embed.fields.length,15); assert.ok(embed.fields.every(field=>field.value.length<=1024));
  assert.ok(embed.title.length+embed.description.length+embed.footer.text.length+embed.fields.reduce((sum,field)=>sum+field.name.length+field.value.length,0)<=6000);
  assert.equal(reportPageSize(report),15); assert.equal(reportPageCount({...report,entryCount:16}),2);
  assert.equal(reportPageCount({pageSize:10,entryCount:11}),2);
  const old=renderReport({report:{...report,formatVersion:1,pageSize:10,entryCount:11,pointsAwarded:1},entries:[{...entries[0],points:1,dailyPoints:null,voteRewards:null,votePenalties:null}],page:1}).embeds[0].toJSON();
  assert.match(old.description,/Зараховано/); assert.match(old.footer.text,/Сторінка 2\/2/); assert.doesNotMatch(old.fields[0].value,/Голосування|Пропуск дня/);
});
