import type { TimeRange } from './daily-summary.js';

export const MAX_STREAK_GAP_MS = 5 * 60_000;
export const MAX_STREAK_DAILY_GAPS_MS = 30 * 60_000;

// Only decides whether absence can be counted. Never fills coverage or earns
// voice time. Neighboring observations preserve the full length of a gap that
// crosses midnight; only its overlap counts against this day's total budget.
export function absenceObservationSufficient(day: TimeRange, ranges: readonly TimeRange[]): boolean {
  const start = day.start.getTime(), end = day.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid streak day.');
  const ordered = ranges.map(range => ({ start: range.start.getTime(), end: range.end.getTime() }))
    .sort((a, b) => a.start - b.start);
  if (ordered.some(range => !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end < range.start)) {
    throw new Error('Invalid tracking coverage.');
  }
  // No observation before the first covered moment: the outage length is unknown.
  const [first] = ordered;
  if (!first || first.start > start) return false;
  let through = first.end;
  let missingMs = 0;
  for (const range of ordered.slice(1)) {
    const missing = Math.max(0, Math.min(end, range.start) - Math.max(start, through));
    if (missing > 0) {
      if (range.start - through > MAX_STREAK_GAP_MS) return false;
      missingMs += missing;
      if (missingMs > MAX_STREAK_DAILY_GAPS_MS) return false;
    }
    through = Math.max(through, range.end);
  }
  // A trailing outage with no resumed observation is not yet proven short.
  return through >= end;
}
