import { createMemberStore } from './member-store.js';
import type { MemberStore, TodayStatistics } from './member-store.js';
import { createTrackingStore } from './tracking-store.js';
import type { TrackingStore } from './tracking-store.js';
import type { VoiceTracker } from './voice-tracker.js';

export interface ReputationMembers {
  getBalance(guildId: string, userId: string): Promise<number>;
  getToday(guildId: string, userId: string): Promise<TodayStatistics & { trackingAvailable: boolean }>;
  setTracking(guildId: string, userId: string, enabled: boolean): Promise<{ trackingAvailable: boolean }>;
  deleteData(guildId: string, userId: string): Promise<void>;
}

interface MemberReputationOptions {
  getTracker(guildId: string): VoiceTracker | undefined;
  members?: MemberStore;
  tracking?: TrackingStore;
  now?: () => Date;
}

export function createMemberReputation(options: MemberReputationOptions): ReputationMembers {
  const members = options.members ?? createMemberStore();
  const tracking = options.tracking ?? createTrackingStore();
  const now = options.now ?? (() => new Date());
  return {
    getBalance: (guildId, userId) => members.getBalance(guildId, userId),

    async getToday(guildId, userId) {
      // Freeze the query instant before flushing. Otherwise normal DB latency
      // would look like a tracking outage between the flush and the query time.
      const at = now();
      const tracker = options.getTracker(guildId);
      if (tracker) await tracker.checkpoint();
      const statistics = await members.getToday(guildId, userId, at);
      return { ...statistics, trackingAvailable: tracker?.status === 'tracking' };
    },

    async setTracking(guildId, userId, enabled) {
      const tracker = options.getTracker(guildId);
      if (tracker) await tracker.setTracking(userId, enabled);
      else await tracking.setTracking(guildId, { userId, enabled }, now());
      return { trackingAvailable: tracker?.status === 'tracking' };
    },

    async deleteData(guildId, userId) {
      const tracker = options.getTracker(guildId);
      if (tracker) await tracker.deleteData(userId);
      else await tracking.deleteMemberData(guildId, userId, now());
    },
  };
}
