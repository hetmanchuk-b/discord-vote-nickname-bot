import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';

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
  setTracking(guildId: string, change: TrackingChange): Promise<void>;
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

        const ids = [...new Set(userIds)];
        if (ids.length && to > from) {
          await tx.reputationMember.createMany({
            data: ids.map(userId => ({ guildId, userId })), skipDuplicates: true,
          });
          // Recheck persisted opt-outs: stale cached preferences must not earn credit.
          const enabled = await tx.reputationMember.findMany({
            where: { guildId, userId: { in: ids }, isTracking: true }, select: { userId: true },
          });
          if (enabled.length) {
            await tx.reputationVoiceInterval.createMany({
              data: enabled.map(({ userId }) => ({ guildId, userId, runId, startedAt: from, endedAt: to })),
            });
          }
        }
        // Save time BEFORE changing the preference: pausing preserves prior time.
        if (preference) {
          await tx.reputationMember.upsert({
            where: { guildId_userId: { guildId, userId: preference.userId } },
            create: { guildId, userId: preference.userId, isTracking: preference.enabled },
            update: { isTracking: preference.enabled },
          });
        }
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

    async setTracking(guildId, { userId, enabled }) {
      await getDatabase().$transaction(async tx => {
        await tx.reputationGuild.upsert({ where: { guildId }, create: { guildId }, update: {} });
        await tx.reputationMember.upsert({
          where: { guildId_userId: { guildId, userId } },
          create: { guildId, userId, isTracking: enabled }, update: { isTracking: enabled },
        });
      }, transactionOptions);
    },
  };
}
