import type { Prisma } from '../generated/prisma/client.js';
import type { TrackingChange } from './tracking-store.js';

// Caller must hold the server-row lock. Never move the eligibility floor back:
// a queued resume/checkpoint from before deletion cannot resurrect erased time.
export async function saveTrackingPreference(
  tx: Prisma.TransactionClient, guildId: string, change: TrackingChange, at: Date,
): Promise<void> {
  const existing = await tx.reputationMember.findUnique({
    where: { guildId_userId: { guildId, userId: change.userId } },
    select: {
      trackingSince: true, isTracking: true,
      pauses: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true, endedAt: true } },
    },
  });
  const lastPause = existing?.pauses[0];
  const since = new Date(Math.max(at.getTime(), existing?.trackingSince?.getTime() ?? -Infinity,
    lastPause?.startedAt.getTime() ?? -Infinity, lastPause?.endedAt?.getTime() ?? -Infinity));
  await tx.reputationMember.upsert({
    where: { guildId_userId: { guildId, userId: change.userId } },
    create: { guildId, userId: change.userId, isTracking: change.enabled, trackingSince: since },
    update: { isTracking: change.enabled, ...(change.enabled ? { trackingSince: since } : {}) },
  });
  if (!change.enabled && existing?.isTracking !== false) {
    await tx.reputationTrackingPause.create({ data: { guildId, userId: change.userId, startedAt: since } });
  } else if (change.enabled && existing?.isTracking === false) {
    await tx.reputationTrackingPause.updateMany({
      where: { guildId, userId: change.userId, endedAt: null }, data: { endedAt: since },
    });
  }
}
