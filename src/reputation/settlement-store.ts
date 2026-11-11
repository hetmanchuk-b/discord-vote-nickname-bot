import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { kyivDate, kyivDay } from './kyiv-day.js';
import { summarizeDay } from './daily-summary.js';
import type { MemberTime } from './daily-summary.js';

export interface SettledDay {
  day: string;
  pointsAwarded: number;
  incomplete: boolean;
}

export interface SettlementStore {
  // Settles at most one closed day, in chronological order. Null means caught up
  // or tracking has never begun. A transaction owns all balance/ledger changes.
  settleNextClosedDay(guildId: string, at: Date): Promise<SettledDay | null>;
}

export function createSettlementStore(getDatabase: () => PrismaClient = getReputationDatabase): SettlementStore {
  return {
    async settleNextClosedDay(guildId, at) {
      if (!Number.isFinite(at.getTime())) throw new Error('Invalid settlement time.');
      return getDatabase().$transaction(async tx => {
        // Same server-row lock used by tracking. Concurrent workers cannot award
        // one day twice, and checkpoints cannot race the final accounting cutoff.
        const locked = await tx.reputationGuild.updateMany({
          where: { guildId }, data: { updatedAt: at },
        });
        if (!locked.count) return null;
        const guild = await tx.reputationGuild.findUniqueOrThrow({
          where: { guildId }, select: { settledThrough: true },
        });
        let next = guild.settledThrough;
        if (!next) {
          const first = await tx.reputationTrackingRun.findFirst({
            where: { guildId }, orderBy: { startedAt: 'asc' }, select: { startedAt: true },
          });
          if (!first) return null; // Do not manufacture reports before activation.
          next = first.startedAt;
        }
        const day = kyivDay(kyivDate(next));
        if (guild.settledThrough && day.start.getTime() !== guild.settledThrough.getTime()) {
          throw new Error('Invalid settlement watermark.');
        }
        if (day.end > at) return null; // Never pay out an open Kyiv calendar day.

        // Aggregate clipped half-open intervals in PostgreSQL, not one query per
        // member. TIMESTAMPTZ(3) preserves exact whole-millisecond precision.
        const totals = await tx.$queryRaw<MemberTime[]>(Prisma.sql`
          SELECT user_id AS "userId",
            SUM(EXTRACT(EPOCH FROM (
              LEAST(ended_at, ${day.end}::timestamptz) - GREATEST(started_at, ${day.start}::timestamptz)
            )) * 1000)::bigint AS "eligibleMs"
          FROM reputation_voice_intervals
          WHERE guild_id = ${guildId} AND started_at < ${day.end} AND ended_at > ${day.start}
          GROUP BY user_id
        `);
        const runs = await tx.reputationTrackingRun.findMany({
          where: { guildId, startedAt: { lt: day.end }, verifiedThrough: { gt: day.start } },
          select: { startedAt: true, verifiedThrough: true },
        });
        const summary = summarizeDay(day, totals, runs.map(run => ({
          start: run.startedAt, end: run.verifiedThrough,
        })));
        await tx.reputationSettlement.create({
          data: {
            guildId, day: day.day, startedAt: day.start, endedAt: day.end, settledAt: at,
            verifiedMs: summary.verifiedMs, incomplete: summary.incomplete,
            activityMs: summary.activityMs, pointsAwarded: summary.pointsAwarded,
          },
        });

        if (summary.members.length) {
          const awards = JSON.stringify(summary.members.map(member => ({ user_id: member.userId, points: member.points })));
          const balances = await tx.$queryRaw<{ userId: string; balanceAfter: number }[]>(Prisma.sql`
            UPDATE reputation_members AS m
            SET balance = m.balance + award.points, updated_at = ${at}
            FROM jsonb_to_recordset(${awards}::jsonb) AS award(user_id text, points integer)
            WHERE m.guild_id = ${guildId} AND m.user_id = award.user_id
            RETURNING m.user_id AS "userId", m.balance AS "balanceAfter"
          `);
          const balanceById = new Map(balances.map(member => [member.userId, member.balanceAfter]));
          if (balanceById.size !== summary.members.length) throw new Error('Settlement member records changed.');
          await tx.reputationDailyAward.createMany({
            data: summary.members.map(member => {
              const balanceAfter = balanceById.get(member.userId);
              if (balanceAfter === undefined) throw new Error('Settlement balance is missing.');
              return { guildId, day: day.day, ...member, balanceAfter };
            }),
          });
        }
        await tx.reputationGuild.update({
          where: { guildId }, data: { settledThrough: day.end },
        });
        return { day: day.day, pointsAwarded: summary.pointsAwarded, incomplete: summary.incomplete };
      }, { maxWait: 5_000, timeout: 30_000 });
    },
  };
}
