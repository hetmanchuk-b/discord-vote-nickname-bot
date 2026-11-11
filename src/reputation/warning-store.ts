import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';

export type WarningIssue = 'tracking' | 'settlement' | 'reports';
export interface WarningState {
  channelId: string | null;
  messageId: string | null;
  reasons: string[];
  activeSince: Date | null;
  lastSeenAt: Date;
  lastEditedAt: Date | null;
  displayedActive: boolean;
  deliveryUncertain: boolean;
}
export interface WarningStore {
  load(guildId: string): Promise<{ destination: string | null; state: WarningState | null }>;
  save(guildId: string, state: WarningState): Promise<void>;
}

export function createWarningStore(getDatabase: () => PrismaClient = getReputationDatabase): WarningStore {
  return {
    async load(guildId) {
      const guild = await getDatabase().reputationGuild.findUnique({
        where: { guildId }, select: { reportChannelId: true, warning: { select: {
          channelId: true, messageId: true, reasons: true, activeSince: true,
          lastSeenAt: true, lastEditedAt: true, displayedActive: true, deliveryUncertain: true,
        } } },
      });
      return { destination: guild?.reportChannelId ?? null, state: guild?.warning ?? null };
    },
    async save(guildId, state) {
      await getDatabase().reputationGuild.upsert({ where: { guildId }, create: { guildId }, update: {} });
      await getDatabase().reputationWarning.upsert({
        where: { guildId }, create: { guildId, ...state }, update: state,
      });
    },
  };
}
