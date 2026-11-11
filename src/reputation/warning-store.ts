import type { PrismaClient } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';

export type WarningIssue = 'tracking' | 'settlement' | 'reports';
export const WARNING_HISTORY_LIMIT = 100;
export interface WarningHistoryEntry {
  id: string;
  at: string;
  reasons: WarningIssue[];
}

// Only controlled categories may reach Discord. Ignore malformed/unknown JSON
// instead of rendering arbitrary stored strings or sensitive driver errors.
export function warningHistory(value: unknown): WarningHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: WarningHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 64 || seen.has(entry.id) ||
      typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || !Array.isArray(entry.reasons)) continue;
    const reasons = entry.reasons.filter((reason): reason is WarningIssue =>
      reason === 'tracking' || reason === 'settlement' || reason === 'reports');
    if (reasons.length !== entry.reasons.length) continue;
    seen.add(entry.id);
    entries.push({ id: entry.id, at: new Date(entry.at).toISOString(), reasons: [...new Set(reasons)].sort() });
  }
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-WARNING_HISTORY_LIMIT);
}
export interface WarningState {
  channelId: string | null;
  messageId: string | null;
  reasons: string[];
  history: WarningHistoryEntry[];
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
          channelId: true, messageId: true, reasons: true, history: true, activeSince: true,
          lastSeenAt: true, lastEditedAt: true, displayedActive: true, deliveryUncertain: true,
        } } },
      });
      const row = guild?.warning;
      return { destination: guild?.reportChannelId ?? null, state: row ? { ...row, history: warningHistory(row.history) } : null };
    },
    async save(guildId, state) {
      await getDatabase().reputationGuild.upsert({ where: { guildId }, create: { guildId }, update: {} });
      const data = { ...state, history: warningHistory(state.history).map(entry => ({ ...entry })) };
      await getDatabase().reputationWarning.upsert({
        where: { guildId }, create: { guildId, ...data }, update: data,
      });
    },
  };
}
