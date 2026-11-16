// This internal accounting interface uses integer quarter-point units throughout.
// It summarizes committed history only: never mutates/recalculates any balance.
export interface ReportDayAward {
  userId: string; eligibleMs: number; soloMs: number; points: number; balanceAfter: number;
}
export interface ReportVoteTotals {
  userId: string; rewards: bigint; penalties: bigint; rewardCount: bigint; penaltyCount: bigint;
}
function integer(value: bigint): number {
  if (value < -2147483648n || value > 2147483647n) throw new Error('Report change total exceeds storage capacity.');
  return Number(value);
}
export function summarizeReportChanges(awards: readonly ReportDayAward[], votes: readonly ReportVoteTotals[]) {
  const byUser = new Map(votes.map(vote => [vote.userId, vote]));
  const entries = awards.flatMap(award => {
    const vote = byUser.get(award.userId);
    const voteRewards = integer(vote?.rewards ?? 0n), votePenalties = integer(vote?.penalties ?? 0n);
    const rewardVoteCount = integer(vote?.rewardCount ?? 0n), penaltyVoteCount = integer(vote?.penaltyCount ?? 0n);
    if ([voteRewards, votePenalties, rewardVoteCount, penaltyVoteCount].some(value => value < 0) ||
      (voteRewards === 0) !== (rewardVoteCount === 0) || (votePenalties === 0) !== (penaltyVoteCount === 0)) throw new Error('Invalid report vote totals.');
    if (!award.points && !voteRewards && !votePenalties) return [];
    return [{ userId: award.userId, eligibleMs: award.eligibleMs, soloMs: award.soloMs, balanceAfter: award.balanceAfter,
      dailyPoints: award.points, voteRewards, votePenalties, rewardVoteCount, penaltyVoteCount,
      points: integer(BigInt(award.points) + BigInt(voteRewards) - BigInt(votePenalties)) }];
  });
  entries.sort((a,b) => b.points - a.points || b.eligibleMs - a.eligibleMs || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return { entries, pointsAwarded: integer(entries.reduce((total, entry) => total + BigInt(entry.points), 0n)) };
}
