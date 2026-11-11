import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';

export interface ReportSettingsStore {
  getReportChannelId(guildId: string): Promise<string | null>;
  setReportChannelId(guildId: string, channelId: string): Promise<void>;
}

export function createReportSettingsStore(
  getDatabase: () => Pick<PrismaClient, 'reputationGuild'> = getReputationDatabase,
): ReportSettingsStore {
  return {
    async getReportChannelId(guildId) {
      const settings = await getDatabase().reputationGuild.findUnique({
        where: { guildId },
        select: { reportChannelId: true },
      });
      return settings?.reportChannelId ?? null;
    },

    async setReportChannelId(guildId, channelId) {
      await getDatabase().reputationGuild.upsert({
        where: { guildId },
        create: { guildId, reportChannelId: channelId },
        update: { reportChannelId: channelId },
      });
    },
  };
}
