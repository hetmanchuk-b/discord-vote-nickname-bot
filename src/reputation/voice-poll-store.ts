import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VoiceReputationPoll } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { MIN_REPUTATION, MAX_REPUTATION } from './attendance-rules.js';

export const VOICE_POLL_DURATION_MS = 120_000;
export const VOICE_POLL_REASON_LIMIT = 1000;
// Scheduling tolerance is NOT additional voting time. Larger delays cancel.
export const VOICE_POLL_DEADLINE_GRACE_MS = 2_000;
export type VoicePoll = VoiceReputationPoll;
export type VoicePollKind = 'penalty' | 'reward';
export const voicePollOpen = (poll: VoicePoll) => poll.status === 'active' || poll.status === 'creating';
export class VoicePollError extends Error {
  constructor(readonly code: 'not-participated' | 'balance-floor' | 'balance-ceiling' | 'active-poll' | 'invalid' | 'expired' | 'not-ready' | 'not-due' | 'invalid-reason') {
    super('Voice poll request could not be completed.');
  }
}
export function normalizeVoicePollReason(value: unknown): string {
  if (typeof value !== 'string') throw new VoicePollError('invalid-reason');
  const reason = value.trim();
  if (!reason || Array.from(reason).length > VOICE_POLL_REASON_LIMIT) throw new VoicePollError('invalid-reason');
  return reason;
}
export interface VoicePollRequest {
  guildId: string; targetId: string; initiatorId: string; voiceChannelId: string; textChannelId: string; amount: number; proposalReason: string; kind?: VoicePollKind;
}
export interface VoicePollVoteRequest {
  id: string; guildId: string; textChannelId: string; messageId: string; userId: string; yes: boolean; interactionId: string; kind?: VoicePollKind;
}
export interface VoicePollEvidence { at: Date; userIds: readonly string[] }
export interface VoicePollStore {
  reserve(request: VoicePollRequest): Promise<VoicePoll>;
  get(id: string): Promise<VoicePoll | null>;
  pending(guildId: string): Promise<VoicePoll[]>;
  activate(id: string, messageId: string, startedAt: Date, startEvidence: VoicePollEvidence | null): Promise<VoicePoll>;
  cancel(id: string, reason: string): Promise<VoicePoll>;
  vote(request: VoicePollVoteRequest): Promise<boolean>;
  finish(id: string, evidence: VoicePollEvidence | null): Promise<VoicePoll>;
  noteAttempt(id: string): Promise<void>;
  prepareDelivery(id: string): Promise<VoicePoll>;
  delivered(id: string, missing: boolean): Promise<void>;
}
const transaction = { maxWait: 5_000, timeout: 15_000 };
async function clock(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  if (!row) throw new Error('Database clock unavailable.');
  return row.at;
}
async function lock(tx: Prisma.TransactionClient, id: string) {
  const initial = await tx.voiceReputationPoll.findUnique({ where: { id } });
  if (!initial) throw new VoicePollError('invalid');
  await tx.reputationGuild.update({ where: { guildId: initial.guildId }, data: { updatedAt: new Date() } });
  return tx.voiceReputationPoll.findUniqueOrThrow({ where: { id } });
}
async function target(tx: Prisma.TransactionClient, guildId: string, userId: string) {
  const member = await tx.reputationMember.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (!member) return null;
  // First verified visits can precede the first midnight settlement. A personal
  // pause is not erasure, and does not make an existing participant immune.
  if (member.hasParticipated || await tx.reputationVoiceInterval.findFirst({ where: { guildId, userId }, select: { id: true } })) return member;
  return null;
}
async function close(tx: Prisma.TransactionClient, poll: VoicePoll, status: string, reason: string | null, data: { appliedAmount?: number; balanceAfter?: number; balanceBefore?: number; noVoterIds?: string[] } = {}) {
  const updated = await tx.voiceReputationPoll.update({ where: { id: poll.id }, data: {
    status, reason, closedAt: await clock(tx), messageMissing: !poll.messageId,
    ...(status !== 'succeeded' ? { proposalReason: null } : {}), ...data,
  } });
  await tx.voiceReputationVote.deleteMany({ where: { pollId: poll.id } });
  return updated;
}
export function createVoicePollStore(getDatabase: () => PrismaClient = getReputationDatabase): VoicePollStore {
  return {
    async reserve(request) {
      const proposalReason = normalizeVoicePollReason(request.proposalReason);
      const kind = request.kind ?? 'penalty';
      if (!['penalty','reward'].includes(kind) || ![10,50,100].includes(request.amount) || request.targetId === request.initiatorId) throw new VoicePollError('invalid');
      return getDatabase().$transaction(async tx => {
        await tx.reputationGuild.upsert({ where: { guildId: request.guildId }, create: { guildId: request.guildId }, update: { updatedAt: new Date() } });
        const member = await target(tx, request.guildId, request.targetId);
        if (!member) throw new VoicePollError('not-participated');
        if (kind === 'penalty' && member.balance <= MIN_REPUTATION) throw new VoicePollError('balance-floor');
        if (kind === 'reward' && member.balance >= MAX_REPUTATION) throw new VoicePollError('balance-ceiling');
        const existing = await tx.voiceReputationPoll.findFirst({ where: { guildId: request.guildId, targetId: request.targetId, status: { in: ['creating','active'] } }, select: { id: true } });
        if (existing) throw new VoicePollError('active-poll');
        return tx.voiceReputationPoll.create({ data: { id: randomUUID(), ...request, kind, proposalReason, createdAt: await clock(tx) } });
      }, transaction);
    },
    get: id => getDatabase().voiceReputationPoll.findUnique({ where: { id } }),
    async pending(guildId) {
      const db = getDatabase();
      const active = await db.voiceReputationPoll.findMany({ where: { guildId, status: { in: ['creating','active'] } } });
      const closed = await db.voiceReputationPoll.findMany({
        where: { guildId, status: { notIn: ['creating','active'] }, publishedAt: null, messageMissing: false },
        orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }], take: 100,
      });
      return [...active, ...closed];
    },
    async activate(id, messageId, startedAt, startEvidence) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (poll.status !== 'creating' && !(poll.status === 'cancelled' && !poll.messageId)) return poll;
        const now = await clock(tx);
        if (!Number.isFinite(startedAt.getTime()) || startedAt.getTime() > now.getTime() + VOICE_POLL_DEADLINE_GRACE_MS ||
          startedAt.getTime() < poll.createdAt.getTime() - VOICE_POLL_DEADLINE_GRACE_MS) throw new VoicePollError('invalid');
        const endsAt = new Date(startedAt.getTime() + VOICE_POLL_DURATION_MS);
        const humans = new Set(startEvidence?.userIds.filter(id=>/^\d{17,20}$/.test(id)) ?? []);
        const verified = startEvidence && startEvidence.at >= startedAt &&
          startEvidence.at.getTime()-startedAt.getTime() <= VOICE_POLL_DEADLINE_GRACE_MS &&
          humans.size >= 4 && humans.has(poll.targetId) && humans.has(poll.initiatorId);
        const cancelled = poll.status === 'cancelled' || now >= endsAt || !verified;
        return tx.voiceReputationPoll.update({ where: { id }, data: {
          messageId, startedAt, endsAt, messageMissing: false,
          status: cancelled ? 'cancelled' : 'active',
          ...(cancelled ? { proposalReason: null } : {}),
          ...(poll.status !== 'cancelled' && (now >= endsAt || !verified) ? {
            closedAt: now, reason: now >= endsAt ? 'deadline-unverified' : 'start-unverified',
          } : {}),
        } });
      },transaction);
    },
    async cancel(id, reason) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        return voicePollOpen(poll) ? close(tx,poll,'cancelled',reason) : poll;
      },transaction);
    },
    async vote(request) {
      if (!/^\d{17,20}$/.test(request.interactionId)) throw new VoicePollError('invalid');
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,request.id);
        if (poll.kind !== (request.kind ?? 'penalty') || poll.guildId !== request.guildId || poll.textChannelId !== request.textChannelId || poll.messageId !== request.messageId || poll.targetId === request.userId) throw new VoicePollError('invalid');
        if (poll.status === 'creating') throw new VoicePollError('not-ready');
        const updatedAt = await clock(tx);
        if (poll.status !== 'active' || !poll.endsAt || updatedAt >= poll.endsAt) throw new VoicePollError('expired');
        const key = { pollId_userId: { pollId: poll.id, userId: request.userId } };
        const previous = await tx.voiceReputationVote.findUnique({ where: key });
        // Discord snowflakes order clicks, even when DB/network delays reorder
        // handler completion. A stale Yes must never overwrite a newer No.
        if (previous && BigInt(previous.interactionId) >= BigInt(request.interactionId)) return previous.yes;
        await tx.voiceReputationVote.upsert({
          where: key,
          create: { pollId: poll.id, userId: request.userId, yes: request.yes, interactionId: request.interactionId, updatedAt },
          update: { yes: request.yes, interactionId: request.interactionId, updatedAt },
        });
        return request.yes;
      },transaction);
    },
    async finish(id, evidence) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (!voicePollOpen(poll)) return poll;
        if (!poll.endsAt || await clock(tx) < poll.endsAt) throw new VoicePollError('not-due');
        if (!evidence || !Number.isFinite(evidence.at.getTime()) || evidence.at < poll.endsAt ||
          evidence.at.getTime() - poll.endsAt.getTime() > VOICE_POLL_DEADLINE_GRACE_MS) return close(tx,poll,'cancelled','deadline-unverified');
        const member = await target(tx,poll.guildId,poll.targetId);
        if (!member) return close(tx,poll,'cancelled','target-untracked');
        const voters = [...new Set(evidence.userIds)].filter(userId => userId !== poll.targetId && /^\d{17,20}$/.test(userId));
        const votes = await tx.voiceReputationVote.findMany({ where: { pollId: id, userId: { in: voters } } });
        const noVoterIds = votes.filter(vote => !vote.yes).map(vote => vote.userId).sort();
        if (noVoterIds.length || !votes.some(vote => vote.yes)) return close(tx,poll,'failed',null,{ noVoterIds });
        const reward = poll.kind === 'reward';
        // Applied amount is a positive magnitude; kind determines its direction.
        const appliedAmount = Math.min(poll.amount,reward ? MAX_REPUTATION - member.balance : member.balance - MIN_REPUTATION);
        if (appliedAmount <= 0) return close(tx,poll,'cancelled',reward ? 'balance-ceiling' : 'balance-floor');
        const balanceAfter = member.balance + (reward ? appliedAmount : -appliedAmount);
        await tx.reputationMember.update({ where: { guildId_userId: { guildId: poll.guildId, userId: poll.targetId } }, data: { balance: balanceAfter } });
        return close(tx,poll,'succeeded',null,{ appliedAmount, balanceAfter, balanceBefore: member.balance });
      },transaction);
    },
    async noteAttempt(id) {
      await getDatabase().voiceReputationPoll.updateMany({ where: { id, publishedAt: null, messageMissing: false }, data: { lastAttemptAt: new Date() } });
    },
    async prepareDelivery(id) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (voicePollOpen(poll) || poll.publishedAt || poll.messageMissing) return poll;
        return tx.voiceReputationPoll.update({ where: { id }, data: { publishing: true, lastAttemptAt: await clock(tx) } });
      },transaction);
    },
    async delivered(id, missing) {
      await getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (voicePollOpen(poll)) throw new VoicePollError('invalid');
        await tx.voiceReputationPoll.update({ where: { id }, data: { publishing: false,
          ...(missing ? { messageMissing: true } : { publishedAt: await clock(tx) }),
        } });
      },transaction);
    },
  };
}
