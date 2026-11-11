import type { Prisma } from '../generated/prisma/client.js';
import type { TrackingChange } from './tracking-store.js';

// Caller must hold the server-row lock. Never move the eligibility floor back:
// a queued resume/checkpoint from before deletion cannot resurrect erased time.
export async function saveTrackingPreference(
  tx: Prisma.TransactionClient, guildId: string, change: TrackingChange, at: Date,
): Promise<void> {
  const existing = await tx.reputationMember.findUnique({
    where: { guildId_userId: { guildId, userId: change.userId } },
    select: { trackingSince: true },
  });
  const since = existing?.trackingSince && existing.trackingSince > at ? existing.trackingSince : at;
  await tx.reputationMember.upsert({
    where: { guildId_userId: { guildId, userId: change.userId } },
    create: { guildId, userId: change.userId, isTracking: change.enabled, trackingSince: since },
    update: { isTracking: change.enabled, ...(change.enabled ? { trackingSince: since } : {}) },
  });
}
