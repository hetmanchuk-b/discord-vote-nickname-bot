import type { KyivDay } from './kyiv-day.js';

const POINT_INTERVAL_MS = 10 * 60_000;

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface MemberTime {
  userId: string;
  eligibleMs: bigint;
}

export function pointsForTime(eligibleMs: number): number {
  if (!Number.isSafeInteger(eligibleMs) || eligibleMs < 0) throw new Error('Invalid eligible time.');
  return Math.floor(eligibleMs / POINT_INTERVAL_MS);
}

export function coveredMilliseconds(day: TimeRange, ranges: readonly TimeRange[]): number {
  const clipped = ranges.map(range => ({
    start: Math.max(day.start.getTime(), range.start.getTime()),
    end: Math.min(day.end.getTime(), range.end.getTime()),
  })).filter(range => range.end > range.start).sort((a, b) => a.start - b.start);
  let covered = 0;
  let through = day.start.getTime();
  for (const range of clipped) {
    covered += Math.max(0, range.end - Math.max(through, range.start));
    through = Math.max(through, range.end);
  }
  return covered;
}

export function summarizeDay(day: KyivDay, totals: readonly MemberTime[], coverage: readonly TimeRange[]) {
  const duration = day.end.getTime() - day.start.getTime();
  if (duration <= 0) throw new Error('Invalid accounting day.');
  const seen = new Set<string>();
  const members = totals.map(({ userId, eligibleMs }) => {
    if (seen.has(userId)) throw new Error('Duplicate member total.');
    seen.add(userId);
    const milliseconds = Number(eligibleMs);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > duration) {
      throw new Error('Member time exceeds the accounting day.');
    }
    return { userId, eligibleMs: milliseconds, points: pointsForTime(milliseconds) };
  }).filter(member => member.eligibleMs > 0);
  const verifiedMs = coveredMilliseconds(day, coverage);
  const pointsAwarded = members.reduce((total, member) => total + member.points, 0);
  if (pointsAwarded > 2_147_483_647) throw new Error('Daily point total exceeds storage capacity.');
  return {
    members,
    verifiedMs,
    incomplete: verifiedMs < duration,
    activityMs: members.reduce((total, member) => total + BigInt(member.eligibleMs), 0n),
    pointsAwarded,
  };
}
