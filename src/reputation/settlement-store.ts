import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { kyivDate, kyivDay } from './kyiv-day.js';
import { summarizeDay } from './daily-summary.js';
import type { MemberTime } from './daily-summary.js';
import { settleAttendance } from './attendance-rules.js';

export interface SettledDay {
  day: string;
  pointsAwarded: number; // Net actual balance change; can be negative after penalties.
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
          where: { guildId }, select: { settledThrough: true, attendanceStartsAt: true },
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
        const eligibleById = new Map(summary.members.map(member => [member.userId, member.eligibleMs]));
        const members = await tx.reputationMember.findMany({
          where: { guildId, OR: [{ hasParticipated: true }, { userId: { in: [...eligibleById.keys()] } }] },
          select: {
            userId: true, balance: true, hasParticipated: true, attendanceStreak: true, absenceStreak: true,
            pauses: {
              where: {
                startedAt: { lt: day.end },
                OR: [{ endedAt: null }, { AND: [
                  { endedAt: { gt: day.start } },
                  { endedAt: { gt: tx.reputationTrackingPause.fields.startedAt } },
                ] }],
              },
              select: { id: true }, take: 1,
            },
          },
        });
        const memberIds = new Set(members.map(member => member.userId));
        if ([...eligibleById.keys()].some(id => !memberIds.has(id))) {
          throw new Error('Settlement member records changed.');
        }
        const policyActive = !guild.attendanceStartsAt || day.start >= guild.attendanceStartsAt;
        const awards = members.map(member => ({
          userId: member.userId,
          ...settleAttendance(member, eligibleById.get(member.userId) ?? 0,
            !policyActive || summary.incomplete || member.pauses.length > 0),
        }));
        const pointsAwarded = awards.reduce((total, award) => total + award.points, 0);
        if (!Number.isSafeInteger(pointsAwarded) || Math.abs(pointsAwarded) > 2_147_483_647) {
          throw new Error('Daily net point total exceeds storage capacity.');
        }
        await tx.reputationSettlement.create({
          data: {
            guildId, day: day.day, startedAt: day.start, endedAt: day.end, settledAt: at,
            verifiedMs: summary.verifiedMs, incomplete: summary.incomplete,
            activityMs: summary.activityMs, pointsAwarded,
          },
        });

        if (awards.length) {
          const updates = JSON.stringify(awards.map(award => ({
            user_id: award.userId, balance: award.balanceAfter, has_participated: award.hasParticipated,
            attendance_streak: award.attendanceStreak, absence_streak: award.absenceStreak,
          })));
          const balances = await tx.$queryRaw<{ userId: string }[]>(Prisma.sql`
            UPDATE reputation_members AS m
            SET balance = award.balance, has_participated = award.has_participated,
              attendance_streak = award.attendance_streak, absence_streak = award.absence_streak, updated_at = ${at}
            FROM jsonb_to_recordset(${updates}::jsonb) AS award(
              user_id text, balance integer, has_participated boolean, attendance_streak integer, absence_streak integer)
            WHERE m.guild_id = ${guildId} AND m.user_id = award.user_id
            RETURNING m.user_id AS "userId"
          `);
          if (balances.length !== awards.length) throw new Error('Settlement member records changed.');
          await tx.reputationDailyAward.createMany({
            data: awards.map(award => ({
              guildId, day: day.day, userId: award.userId, eligibleMs: award.eligibleMs,
              points: award.points, balanceAfter: award.balanceAfter, basePoints: award.basePoints,
              attendanceBonus: award.attendanceBonus, absencePenalty: award.absencePenalty,
              attendanceStreak: award.attendanceStreak, absenceStreak: award.absenceStreak, exempt: award.exempt,
            })),
          });
        }
        await tx.reputationGuild.update({
          where: { guildId }, data: { settledThrough: day.end },
        });
        return { day: day.day, pointsAwarded, incomplete: summary.incomplete };
      }, { maxWait: 5_000, timeout: 30_000 });
    },
  };
}
