import { pointsForTime } from './daily-summary.js';
import { fromPointUnits, toPointUnits, MIN_POINT_UNITS, MAX_POINT_UNITS } from './point-units.js';

export const MIN_REPUTATION = -500;
export const MAX_REPUTATION = 5_000;
const MAX_STREAK = 2_147_483_647;

export interface AttendanceState {
  balance: number;
  hasParticipated: boolean;
  attendanceStreak: number;
  absenceStreak: number;
}

// One closed Kyiv day. Explicit exemptions (pause, pre-policy, or insufficient
// observation for an absent member) freeze BOTH streaks. Verified attendance
// does not require complete global coverage; never invent missing voice time.
export function settleAttendance(state: AttendanceState, eligibleMs: number, exempt: boolean, soloMs = 0) {
  const { balance } = state;
  if (!Number.isSafeInteger(balance * 4) || balance < MIN_REPUTATION || balance > MAX_REPUTATION ||
    ![state.attendanceStreak, state.absenceStreak].every(value => Number.isInteger(value) && value >= 0 && value <= MAX_STREAK) ||
    (state.attendanceStreak > 0 && state.absenceStreak > 0) ||
    (!state.hasParticipated && (state.attendanceStreak > 0 || state.absenceStreak > 0))) {
    throw new Error('Invalid attendance state.');
  }
  const basePoints = pointsForTime(eligibleMs, soloMs);
  const hasParticipated = state.hasParticipated || eligibleMs > 0;
  let { attendanceStreak, absenceStreak } = state;
  let attendanceBonus = 0;
  let absencePenalty = 0;
  if (!exempt && hasParticipated) {
    if (eligibleMs > 0) {
      attendanceStreak = Math.min(MAX_STREAK, attendanceStreak + 1);
      absenceStreak = 0;
      if (attendanceStreak >= 3) attendanceBonus = 5 + Math.floor((attendanceStreak - 3) / 7);
    } else {
      attendanceStreak = 0;
      absenceStreak = Math.min(MAX_STREAK, absenceStreak + 1);
      absencePenalty = absenceStreak <= 7 ? 5 : 10;
    }
  }
  const balanceAfter = fromPointUnits(Math.max(MIN_POINT_UNITS, Math.min(MAX_POINT_UNITS,
    toPointUnits(balance) + toPointUnits(basePoints) + toPointUnits(attendanceBonus) - toPointUnits(absencePenalty))));
  return {
    hasParticipated, attendanceStreak, absenceStreak, basePoints, attendanceBonus, absencePenalty,
    eligibleMs, soloMs, exempt, balanceAfter, points: balanceAfter - balance,
  };
}
