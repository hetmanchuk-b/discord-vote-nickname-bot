const assert = require('node:assert/strict');
const { test } = require('node:test');
const { absenceObservationSufficient, MAX_STREAK_GAP_MS, MAX_STREAK_DAILY_GAPS_MS } = require('../dist/reputation/streak-observation.js');
const { kyivDay, nextCalendarDate } = require('../dist/reputation/kyiv-day.js');
const { summarizeDay } = require('../dist/reputation/daily-summary.js');
const MINUTE = 60000, HOUR = 60*MINUTE;
const day = kyivDay('2026-11-11');
const at = offset => new Date(day.start.getTime()+offset);
function coverage(gaps, span=day) {
  const ranges = [];
  let from = span.start;
  for (const [start,end] of gaps) { ranges.push({start:from,end:start});from=end; }
  ranges.push({start:from,end:span.end});
  return ranges;
}
const hourlyGaps = durations => durations.map((ms,i)=>[at((i+1)*HOUR),at((i+1)*HOUR+ms)]);

test('streak outage limits are five minutes each and thirty minutes per Kyiv day', () => {
  assert.equal(MAX_STREAK_GAP_MS,5*MINUTE);
  assert.equal(MAX_STREAK_DAILY_GAPS_MS,30*MINUTE);
});
for (const duration of [1,MINUTE,5*MINUTE-1,5*MINUTE]) {
  test(`a completed ${duration}ms outage is tolerated for absence`, () => {
    assert.equal(absenceObservationSufficient(day,coverage(hourlyGaps([duration]))),true);
  });
}
for (const durations of [[5*MINUTE+1],[6*MINUTE],Array(6).fill(5*MINUTE).concat(1),Array(7).fill(5*MINUTE)]) {
  test(`absence freezes when either outage limit is exceeded: ${durations.join(',')}`, () => {
    assert.equal(absenceObservationSufficient(day,coverage(hourlyGaps(durations))),false);
  });
}

test('six five-minute outages are accepted at the exact daily limit without filling missing time', () => {
  const ranges = coverage(hourlyGaps(Array(6).fill(5*MINUTE)));
  assert.equal(absenceObservationSufficient(day,ranges),true);
  const summary = summarizeDay(day,[{userId:'user',eligibleMs:600000n}],ranges);
  assert.equal(summary.verifiedMs,day.end-day.start-30*MINUTE);
  assert.equal(summary.incomplete,true);
  assert.equal(summary.pointsAwarded,1);
});

test('overlapping, duplicate and unsorted observations do not multiply outage budgets', () => {
  const ranges = coverage(hourlyGaps([5*MINUTE,5*MINUTE]));
  assert.equal(absenceObservationSufficient(day,[...ranges,...ranges].reverse()),true);
  assert.equal(absenceObservationSufficient(day,[...ranges,...ranges,{start:at(0),end:at(30*MINUTE)}]),true);
});

test('touching observations remain continuous, including a checkpoint at midnight', () => {
  assert.equal(absenceObservationSufficient(day,[{start:day.start,end:at(HOUR)},{start:at(HOUR),end:day.end}]),true);
  assert.equal(absenceObservationSufficient(day,[{start:day.start,end:at(24*HOUR-MINUTE)},{start:day.end,end:day.end}]),true);
});

test('unknown leading/trailing outage lengths and fully offline days never prove absence', () => {
  assert.equal(absenceObservationSufficient(day,[]),false);
  assert.equal(absenceObservationSufficient(day,[{start:at(1),end:day.end}]),false);
  assert.equal(absenceObservationSufficient(day,[{start:day.start,end:at(day.end-day.start-1)}]),false);
});

for (const duration of [5*MINUTE,5*MINUTE+1,8*MINUTE]) {
  test(`a midnight-crossing ${duration}ms outage is measured whole on both days`, () => {
    const tomorrow = kyivDay(nextCalendarDate(day.day));
    const start = new Date(day.end.getTime()-Math.floor(duration/2));
    const end = new Date(start.getTime()+duration);
    const ranges = [{start:day.start,end:start},{start:end,end:tomorrow.end}];
    assert.equal(absenceObservationSufficient(day,ranges),duration<=5*MINUTE);
    assert.equal(absenceObservationSufficient(tomorrow,ranges),duration<=5*MINUTE);
  });
}

test('only the part of a crossing outage inside the day consumes its thirty-minute budget', () => {
  const gaps = hourlyGaps([...Array(5).fill(5*MINUTE),2.5*MINUTE]);
  gaps.push([new Date(day.end.getTime()-2.5*MINUTE),new Date(day.end.getTime()+2.5*MINUTE)]);
  const ranges = coverage(gaps,{start:day.start,end:new Date(day.end.getTime()+HOUR)});
  assert.equal(absenceObservationSufficient(day,ranges),true);
  assert.equal(summarizeDay(day,[],ranges).verifiedMs,day.end-day.start-30*MINUTE);
});

for (const date of ['2026-03-29','2026-10-25']) {
  test(`DST day ${date} uses real elapsed gaps, not an assumed 24 hours`, () => {
    const dst = kyivDay(date);
    const gapStart = new Date(dst.start.getTime()+HOUR),gapEnd = new Date(gapStart.getTime()+5*MINUTE);
    assert.equal(absenceObservationSufficient(dst,coverage([[gapStart,gapEnd]],dst)),true);
    assert.equal(summarizeDay(dst,[],coverage([[gapStart,gapEnd]],dst)).verifiedMs,dst.end-dst.start-5*MINUTE);
  });
}

test('invalid day/coverage timestamps fail instead of permitting absence', () => {
  assert.throws(()=>absenceObservationSufficient({start:day.end,end:day.start},[]));
  assert.throws(()=>absenceObservationSufficient(day,[{start:at(HOUR),end:at(0)}]));
  assert.throws(()=>absenceObservationSufficient(day,[{start:new Date(NaN),end:day.end}]));
});
