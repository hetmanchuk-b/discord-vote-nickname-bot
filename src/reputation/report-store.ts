import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { fromPointUnits } from './point-units.js';
import { getReputationDatabase } from './database.js';
import { REPORT_PAGE_SIZE, reportPageCount, reportPageSize } from './report-pagination.js';
import { summarizeReportChanges } from './report-changes.js';
import type { ReportVoteTotals } from './report-changes.js';

const include = { settlement: true } as const;
type StoredReport = Prisma.ReputationReportGetPayload<{ include: typeof include }>;
export type DailyReport = ReturnType<typeof view>;
export interface ReportEntry {
  userId: string; position: number; eligibleMs: number; soloMs: number | null; points: number; balanceAfter: number;
  dailyPoints: number | null; voteRewards: number | null; votePenalties: number | null;
  rewardVoteCount: number | null; penaltyVoteCount: number | null;
}
export interface ReportSnapshot { report: DailyReport; entries: ReportEntry[]; page: number }

function view(row: StoredReport) {
  return {
    id: row.id, guildId: row.guildId, day: row.day, status: row.status,
    channelId: row.channelId, messageId: row.messageId,
    createdAt: row.createdAt, preparedAt: row.preparedAt, publishedAt: row.publishedAt,
    activityMs: row.activityMs, pointsAwarded: fromPointUnits(row.pointsAwarded), entryCount: row.entryCount,
    pageSize: row.pageSize, formatVersion: row.formatVersion,
    startedAt: row.settlement.startedAt, endedAt: row.settlement.endedAt,
    incomplete: row.settlement.incomplete, verifiedMs: row.settlement.verifiedMs,
  };
}

export interface ReportStore {
  pending(guildId: string): Promise<DailyReport[]>;
  get(id: string): Promise<DailyReport | null>;
  noteAttempt(id: string): Promise<void>;
  attachMessage(id: string, channelId: string, messageId: string): Promise<DailyReport>;
  clearPlaceholder(id: string, messageId: string): Promise<void>;
  prepare(id: string): Promise<DailyReport>;
  finish(id: string): Promise<void>;
  markMissing(id: string): Promise<void>;
  snapshot(id: string, page: number): Promise<ReportSnapshot>;
}

async function lockReport(tx: Prisma.TransactionClient, id: string) {
  const initial = await tx.reputationReport.findUniqueOrThrow({ where: { id } });
  await tx.reputationGuild.update({ where: { guildId: initial.guildId }, data: { updatedAt: new Date() } });
  return tx.reputationReport.findUniqueOrThrow({ where: { id }, include });
}

export function createReportStore(getDatabase: () => PrismaClient = getReputationDatabase): ReportStore {
  const transaction = { maxWait: 5_000, timeout: 15_000 };
  return {
    async pending(guildId) {
      const db = getDatabase();
      const unqueued = await db.reputationSettlement.findMany({
        where: { guildId, report: { is: null } }, orderBy: { day: 'asc' }, take: 31,
        select: { day: true },
      });
      if (unqueued.length) await db.reputationReport.createMany({
        data: unqueued.map(({ day }) => ({ id: randomUUID(), guildId, day })), skipDuplicates: true,
      });
      return (await db.reputationReport.findMany({
        where: { guildId, status: { in: ['pending', 'publishing'] } },
        orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { day: 'asc' }], take: 31, include,
      })).map(view);
    },
    async get(id) {
      const row = await getDatabase().reputationReport.findUnique({ where: { id }, include });
      return row ? view(row) : null;
    },
    async noteAttempt(id) {
      await getDatabase().reputationReport.updateMany({
        where: { id, status: { in: ['pending', 'publishing'] } }, data: { lastAttemptAt: new Date() },
      });
    },
    async attachMessage(id, channelId, messageId) {
      return getDatabase().$transaction(async tx => {
        const row = await lockReport(tx, id);
        if (row.status !== 'pending') return view(row);
        const guild = await tx.reputationGuild.findUniqueOrThrow({ where: { guildId: row.guildId } });
        if (guild.reportChannelId !== channelId) throw new Error('Report destination changed.');
        if (row.channelId === channelId && row.messageId) return view(row);
        return view(await tx.reputationReport.update({ where: { id }, data: { channelId, messageId }, include }));
      }, transaction);
    },
    async clearPlaceholder(id, messageId) {
      await getDatabase().$transaction(async tx => {
        await lockReport(tx, id);
        await tx.reputationReport.updateMany({
          where: { id, status: 'pending', messageId }, data: { channelId: null, messageId: null },
        });
      }, transaction);
    },
    async prepare(id) {
      return getDatabase().$transaction(async tx => {
        const row = await lockReport(tx, id);
        if (row.status !== 'pending') return view(row);
        if (!row.messageId || !row.channelId) throw new Error('Report placeholder is required.');
        const guild = await tx.reputationGuild.findUniqueOrThrow({ where: { guildId: row.guildId } });
        if (guild.reportChannelId !== row.channelId) throw new Error('Report destination changed.');
        const awards = await tx.reputationDailyAward.findMany({
          where: { guildId: row.guildId, day: row.day },
          orderBy: [{ points: 'desc' }, { eligibleMs: 'desc' }, { userId: 'asc' }],
        });
        // Recorded financial application time, not deadline/proposal/publication time, determines
        // the Kyiv day. Current daily rows + identity creation cutoffs prevent
        // retained public poll history from resurrecting erased member data.
        const votes = await tx.$queryRaw<ReportVoteTotals[]>`
          SELECT p.target_id AS "userId",
            COALESCE(SUM(p.applied_amount_units) FILTER (WHERE p.kind='reward'),0)::bigint AS rewards,
            COALESCE(SUM(p.applied_amount_units) FILTER (WHERE p.kind='penalty'),0)::bigint AS penalties,
            COUNT(*) FILTER (WHERE p.kind='reward') AS "rewardCount",
            COUNT(*) FILTER (WHERE p.kind='penalty') AS "penaltyCount"
          FROM voice_reputation_polls p
          JOIN reputation_members m ON m.guild_id=p.guild_id AND m.user_id=p.target_id
          JOIN reputation_daily_awards a ON a.guild_id=p.guild_id AND a.user_id=p.target_id AND a.day=${row.day}
          WHERE p.guild_id=${row.guildId} AND p.status='succeeded' AND p.applied_amount_units>0
            AND p.kind IN ('reward','penalty') AND p.created_at>=m.created_at
            AND p.closed_at>=${row.settlement.startedAt} AND p.closed_at<${row.settlement.endedAt}
          GROUP BY p.target_id`;
        const changes = summarizeReportChanges(awards, votes);
        if (changes.entries.length) await tx.reputationReportEntry.createMany({
          data: changes.entries.map((entry, position) => ({ ...entry, reportId: id, guildId: row.guildId, position })),
        });
        return view(await tx.reputationReport.update({
          where: { id }, include,
          data: {
            status: 'publishing', preparedAt: new Date(), entryCount: changes.entries.length,
            pageSize: REPORT_PAGE_SIZE, formatVersion: 2,
            activityMs: awards.reduce((total, award) => total + BigInt(award.eligibleMs), 0n),
            pointsAwarded: changes.pointsAwarded,
          },
        }));
      }, transaction);
    },
    async finish(id) {
      await getDatabase().$transaction(async tx => {
        await lockReport(tx, id);
        await tx.reputationReport.updateMany({
          where: { id, status: 'publishing' }, data: { status: 'published', publishedAt: new Date() },
        });
      }, transaction);
    },
    async markMissing(id) {
      await getDatabase().$transaction(async tx => {
        const row = await lockReport(tx, id);
        if (row.status !== 'publishing') return;
        await tx.reputationReportEntry.deleteMany({ where: { reportId: id } });
        await tx.reputationReport.update({ where: { id }, data: { status: 'missing', entryCount: 0 } });
      }, transaction);
    },
    async snapshot(id, page) {
      const row = await getDatabase().reputationReport.findUniqueOrThrow({ where: { id }, include });
      if (!Number.isSafeInteger(page) || page < 0 || page >= reportPageCount(row)) {
        throw new Error('Invalid report page.');
      }
      const entries = await getDatabase().reputationReportEntry.findMany({
        where: { reportId: id }, orderBy: { position: 'asc' }, skip: page * reportPageSize(row), take: reportPageSize(row),
        select: { userId: true, position: true, eligibleMs: true, soloMs: true, points: true, balanceAfter: true,
          dailyPoints: true, voteRewards: true, votePenalties: true, rewardVoteCount: true, penaltyVoteCount: true },
      });
      return { report: view(row), entries: entries.map(entry => ({ ...entry,
        points: fromPointUnits(entry.points), balanceAfter: fromPointUnits(entry.balanceAfter),
        dailyPoints: entry.dailyPoints === null ? null : fromPointUnits(entry.dailyPoints),
        voteRewards: entry.voteRewards === null ? null : fromPointUnits(entry.voteRewards),
        votePenalties: entry.votePenalties === null ? null : fromPointUnits(entry.votePenalties),
      })), page };
    },
  };
}
