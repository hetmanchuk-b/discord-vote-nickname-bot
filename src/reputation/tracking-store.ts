import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { saveTrackingPreference } from './tracking-preference.js';
import { PublicationPendingError } from './report-errors.js';

export class TrackingLeaseLostError extends Error {
  constructor() { super('Another tracking run owns this server.'); }
}

export interface TrackingChange {
  userId: string;
  enabled: boolean;
}

export interface TrackingCheckpoint {
  guildId: string;
  runId: string;
  from: Date;
  to: Date;
  userIds: readonly string[];
  preference?: TrackingChange;
}

export interface TrackingStore {
  openRun(guildId: string, at: Date): Promise<{ runId: string; pausedUserIds: string[] }>;
  checkpoint(checkpoint: TrackingCheckpoint): Promise<void>;
  closeRun(guildId: string, runId: string, at: Date, reason: string): Promise<void>;
  setTracking(guildId: string, change: TrackingChange, at: Date): Promise<void>;
  deleteMemberData(guildId: string, userId: string, at: Date): Promise<void>;
}

const transactionOptions = { maxWait: 5_000, timeout: 15_000 };

export function createTrackingStore(getDatabase: () => PrismaClient = getReputationDatabase): TrackingStore {
  return {
    async openRun(guildId, at) {
      const runId = randomUUID();
      return getDatabase().$transaction(async tx => {
        // Upsert locks this server row, serializing run replacement and checkpoints.
        await tx.reputationGuild.upsert({
          where: { guildId }, create: { guildId, trackingRunId: runId },
          update: { trackingRunId: runId },
        });
        const latest = await tx.reputationTrackingRun.findFirst({
          where: { guildId }, orderBy: { verifiedThrough: 'desc' },
          select: { verifiedThrough: true },
        });
        if (latest && latest.verifiedThrough > at) {
          throw new Error('Clock is behind the last recorded checkpoint.');
        }
        await tx.reputationTrackingRun.updateMany({
          where: { guildId, closedAt: null }, data: { closedAt: at, endReason: 'replaced' },
        });
        await tx.reputationTrackingRun.create({
          data: { id: runId, guildId, startedAt: at, verifiedThrough: at },
        });
        const paused = await tx.reputationMember.findMany({
          where: { guildId, isTracking: false }, select: { userId: true },
        });
        return { runId, pausedUserIds: paused.map(member => member.userId) };
      }, transactionOptions);
    },

    async checkpoint({ guildId, runId, from, to, userIds, preference }) {
      if (to < from) throw new Error('A tracking checkpoint cannot move backwards.');
      await getDatabase().$transaction(async tx => {
        const owner = await tx.reputationGuild.updateMany({
          where: { guildId, trackingRunId: runId }, data: { trackingRunId: runId },
        });
        if (owner.count !== 1) throw new TrackingLeaseLostError();
        const advanced = await tx.reputationTrackingRun.updateMany({
          where: { id: runId, guildId, verifiedThrough: from, closedAt: null },
          data: { verifiedThrough: to },
        });
        if (advanced.count !== 1) throw new TrackingLeaseLostError();

        const guild = await tx.reputationGuild.findUniqueOrThrow({
          where: { guildId }, select: { settledThrough: true },
        });
        // A delayed checkpoint must not introduce new earnings into a frozen day.
        const effectiveFrom = guild.settledThrough && guild.settledThrough > from ? guild.settledThrough : from;
        const ids = [...new Set(userIds)];
        if (ids.length && to > effectiveFrom) {
          await tx.reputationMember.createMany({
            data: ids.map(userId => ({ guildId, userId })), skipDuplicates: true,
          });
          // Recheck persisted opt-outs: stale cached preferences must not earn credit.
          const enabled = await tx.reputationMember.findMany({
            where: { guildId, userId: { in: ids }, isTracking: true }, select: { userId: true, trackingSince: true },
          });
          const intervals = enabled.map(({ userId, trackingSince }) => ({
            guildId, userId, runId, endedAt: to,
            startedAt: trackingSince && trackingSince > effectiveFrom ? trackingSince : effectiveFrom,
          })).filter(interval => interval.startedAt < to);
          if (intervals.length) await tx.reputationVoiceInterval.createMany({ data: intervals });
        }
        // Save time BEFORE changing the preference: pausing preserves prior time.
        if (preference) await saveTrackingPreference(tx, guildId, preference, to);
      }, transactionOptions);
    },

    async closeRun(guildId, runId, at, reason) {
      await getDatabase().$transaction(async tx => {
        const owner = await tx.reputationGuild.updateMany({
          where: { guildId, trackingRunId: runId }, data: { trackingRunId: null },
        });
        if (owner.count !== 1) throw new TrackingLeaseLostError();
        await tx.reputationTrackingRun.updateMany({
          where: { id: runId, guildId, closedAt: null },
          data: { closedAt: at, endReason: reason },
        });
      }, transactionOptions);
    },

    async setTracking(guildId, change, at) {
      await getDatabase().$transaction(async tx => {
        await tx.reputationGuild.upsert({
          where: { guildId }, create: { guildId }, update: { updatedAt: at },
        });
        await saveTrackingPreference(tx, guildId, change, at);
      }, transactionOptions);
    },

    async deleteMemberData(guildId, userId, at) {
      await getDatabase().$transaction(async tx => {
        // Same lock as checkpoints and settlement: delete and payout cannot race.
        await tx.reputationGuild.upsert({
          where: { guildId }, create: { guildId }, update: { updatedAt: at },
        });
        const publishing = await tx.reputationReportEntry.findFirst({
          where: { guildId, userId, report: { status: 'publishing' } }, select: { reportId: true },
        });
        const penaltyPublishing = await tx.voicePenaltyPoll.findFirst({
          where: { guildId, publishing: true, publishedAt: null, messageMissing: false,
            OR: [{ targetId: userId }, { noVoterIds: { has: userId } }] }, select: { id: true },
        });
        if (publishing || penaltyPublishing) throw new PublicationPendingError();
        // Cancel target polls before erasing enrollment. Re-enrollment cannot
        // resurrect them. Published outcomes remain immutable public history.
        await tx.voicePenaltyPoll.updateMany({
          where: { guildId, targetId: userId, publishedAt: null, publishing: false },
          data: { status: 'cancelled', reason: 'target-erased', actualFine: 0, balanceAfter: null, noVoterIds: [], closedAt: at },
        });
        await tx.voicePenaltyPoll.updateMany({
          where: { guildId, targetId: userId, messageId: null }, data: { messageMissing: true },
        });
        await tx.voicePenaltyVote.deleteMany({ where: { OR: [
          { userId, poll: { guildId } }, { poll: { guildId, targetId: userId, status: 'cancelled', publishedAt: null } },
        ] } });
        await tx.$executeRaw`UPDATE voice_penalty_polls SET no_voter_ids = array_remove(no_voter_ids, ${userId})
          WHERE guild_id = ${guildId} AND published_at IS NULL AND NOT publishing`;
        await tx.reputationReportEntry.deleteMany({
          where: { guildId, userId, report: { status: { in: ['pending', 'missing'] } } },
        });
        await tx.reputationVoiceInterval.deleteMany({ where: { guildId, userId } });
        await tx.reputationDailyAward.deleteMany({ where: { guildId, userId } });
        const existing = await tx.reputationMember.findUnique({
          where: { guildId_userId: { guildId, userId } },
          select: { trackingSince: true, pauses: { orderBy: { startedAt: 'desc' }, take: 1 } },
        });
        const lastPause = existing?.pauses[0];
        const since = new Date(Math.max(at.getTime(), existing?.trackingSince?.getTime() ?? -Infinity,
          lastPause?.startedAt.getTime() ?? -Infinity, lastPause?.endedAt?.getTime() ?? -Infinity));
        await tx.reputationTrackingPause.deleteMany({ where: { guildId, userId } });
        // Keep only the disabled identity/cutoff. Day ledgers and published report
        // snapshots are not member-owned rows; backups are not touched.
        await tx.reputationMember.upsert({
          where: { guildId_userId: { guildId, userId } },
          create: { guildId, userId, isTracking: false, trackingSince: since, createdAt: at, updatedAt: at },
          update: {
            balance: 0, hasParticipated: false, attendanceStreak: 0, absenceStreak: 0,
            isTracking: false, trackingSince: since, createdAt: at, updatedAt: at,
          },
        });
        await tx.reputationTrackingPause.create({ data: { guildId, userId, startedAt: since } });
      }, transactionOptions);
    },
  };
}
