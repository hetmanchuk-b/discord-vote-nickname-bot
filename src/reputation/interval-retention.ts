import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { kyivDate, kyivDay } from './kyiv-day.js';

export const RAW_INTERVAL_RETENTION_DAYS = 14;
export const RAW_INTERVAL_RETENTION_MS = RAW_INTERVAL_RETENTION_DAYS * 24 * 60 * 60_000;
export const INTERVAL_RETENTION_BATCH_SIZE = 1000;
export interface IntervalRetentionResult { deletedCount: number; hasMore: boolean }
export interface IntervalRetentionStore {
  prune(guildId: string, at: Date): Promise<IntervalRetentionResult>;
}

// Deletes only raw source rows. Settled daily history and observation metadata
// remain intact. The guild lock serializes cleanup with settlement and erasure.
export function createIntervalRetentionStore(getDatabase: () => PrismaClient = getReputationDatabase): IntervalRetentionStore {
  return {
    async prune(guildId, at) {
      const cutoff = new Date(at.getTime() - RAW_INTERVAL_RETENTION_MS);
      if (!Number.isFinite(at.getTime()) || !Number.isFinite(cutoff.getTime())) throw new Error('Invalid retention time.');
      return getDatabase().$transaction(async tx => {
        const locked = await tx.reputationGuild.updateMany({ where: { guildId }, data: { updatedAt: at } });
        if (!locked.count) return { deletedCount: 0, hasMore: false };
        const guild = await tx.reputationGuild.findUniqueOrThrow({ where: { guildId }, select: { settledThrough: true } });
        if (!guild.settledThrough) return { deletedCount: 0, hasMore: false };
        if (kyivDay(kyivDate(guild.settledThrough)).start.getTime() !== guild.settledThrough.getTime()) {
          throw new Error('Invalid retention settlement watermark.');
        }
        const through = new Date(Math.min(cutoff.getTime(), guild.settledThrough.getTime()));
        const where: Prisma.ReputationVoiceIntervalWhereInput = {
          guildId, endedAt: { lte: through }, member: { hasParticipated: true },
        };
        const rows = await tx.reputationVoiceInterval.findMany({
          where, orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
          take: INTERVAL_RETENTION_BATCH_SIZE + 1, select: { id: true },
        });
        if (!rows.length) return { deletedCount: 0, hasMore: false };
        const deleted = await tx.reputationVoiceInterval.deleteMany({
          where: { ...where, id: { in: rows.slice(0, INTERVAL_RETENTION_BATCH_SIZE).map(row => row.id) } },
        });
        return { deletedCount: deleted.count, hasMore: rows.length > INTERVAL_RETENTION_BATCH_SIZE };
      }, { maxWait: 5_000, timeout: 15_000 });
    },
  };
}
