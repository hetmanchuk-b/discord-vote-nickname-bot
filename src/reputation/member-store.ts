import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { coveredMilliseconds, pointsForTime } from './daily-summary.js';
import { kyivDate, kyivDay } from './kyiv-day.js';

export interface TodayStatistics {
  day: string;
  eligibleMs: number;
  pendingPoints: number;
  isTracking: boolean;
  incomplete: boolean;
  attendanceStreak: number;
  absenceStreak: number;
}

export interface MemberStore {
  getBalance(guildId: string, userId: string): Promise<number>;
  getToday(guildId: string, userId: string, at: Date): Promise<TodayStatistics>;
}

export function createMemberStore(getDatabase: () => PrismaClient = getReputationDatabase): MemberStore {
  return {
    async getBalance(guildId, userId) {
      const member = await getDatabase().reputationMember.findUnique({
        where: { guildId_userId: { guildId, userId } }, select: { balance: true },
      });
      return member?.balance ?? 0;
    },

    async getToday(guildId, userId, at) {
      const day = kyivDay(kyivDate(at));
      return getDatabase().$transaction(async tx => {
        const member = await tx.reputationMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          select: { isTracking: true, attendanceStreak: true, absenceStreak: true },
        });
        const [total] = await tx.$queryRaw<{ eligibleMs: bigint }[]>(Prisma.sql`
          SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
            LEAST(ended_at, ${at}::timestamptz) - GREATEST(started_at, ${day.start}::timestamptz)
          )) * 1000), 0)::bigint AS "eligibleMs"
          FROM reputation_voice_intervals
          WHERE guild_id = ${guildId} AND user_id = ${userId}
            AND started_at < ${at} AND ended_at > ${day.start}
        `);
        const eligibleMs = Number(total?.eligibleMs ?? 0n);
        if (!Number.isSafeInteger(eligibleMs) || eligibleMs < 0 || eligibleMs > at.getTime() - day.start.getTime()) {
          throw new Error('Invalid recorded voice time.');
        }
        const runs = await tx.reputationTrackingRun.findMany({
          where: { guildId, startedAt: { lt: at }, verifiedThrough: { gt: day.start } },
          select: { startedAt: true, verifiedThrough: true },
        });
        const coverage = coveredMilliseconds({ start: day.start, end: at }, runs.map(run => ({
          start: run.startedAt, end: run.verifiedThrough,
        })));
        return {
          day: day.day, eligibleMs, pendingPoints: pointsForTime(eligibleMs),
          isTracking: member?.isTracking ?? true,
          incomplete: coverage < at.getTime() - day.start.getTime(),
          attendanceStreak: member?.attendanceStreak ?? 0, absenceStreak: member?.absenceStreak ?? 0,
        };
      }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 15_000 });
    },
  };
}
