import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, VoicePenaltyPoll } from '../generated/prisma/client.js';
import { getReputationDatabase } from './database.js';
import { MIN_REPUTATION, MAX_REPUTATION } from './attendance-rules.js';

export const PENALTY_DURATION_MS = 120_000;
// Scheduling tolerance is NOT additional voting time. Larger delays cancel.
export const PENALTY_DEADLINE_GRACE_MS = 2_000;
export type PenaltyPoll = VoicePenaltyPoll;
export type VoiceVoteKind = 'penalty' | 'reward';
export const penaltyOpen = (poll: PenaltyPoll) => poll.status === 'active' || poll.status === 'creating';
export class PenaltyError extends Error {
  constructor(readonly code: 'not-participated' | 'balance-floor' | 'balance-ceiling' | 'active-poll' | 'invalid' | 'expired' | 'not-ready' | 'not-due') {
    super('Voice penalty request could not be completed.');
  }
}
export interface PenaltyRequest {
  guildId: string; targetId: string; initiatorId: string; voiceChannelId: string; textChannelId: string; amount: number; kind?: VoiceVoteKind;
}
export interface PenaltyVoteRequest {
  id: string; guildId: string; textChannelId: string; messageId: string; userId: string; yes: boolean; interactionId: string; kind?: VoiceVoteKind;
}
export interface PenaltyEvidence { at: Date; userIds: readonly string[] }
export interface PenaltyStore {
  reserve(request: PenaltyRequest): Promise<PenaltyPoll>;
  get(id: string): Promise<PenaltyPoll | null>;
  pending(guildId: string): Promise<PenaltyPoll[]>;
  activate(id: string, messageId: string, startedAt: Date, startEvidence: PenaltyEvidence | null): Promise<PenaltyPoll>;
  cancel(id: string, reason: string): Promise<PenaltyPoll>;
  vote(request: PenaltyVoteRequest): Promise<boolean>;
  finish(id: string, evidence: PenaltyEvidence | null): Promise<PenaltyPoll>;
  noteAttempt(id: string): Promise<void>;
  prepareDelivery(id: string): Promise<PenaltyPoll>;
  delivered(id: string, missing: boolean): Promise<void>;
}
const transaction = { maxWait: 5_000, timeout: 15_000 };
async function clock(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  if (!row) throw new Error('Database clock unavailable.');
  return row.at;
}
async function lock(tx: Prisma.TransactionClient, id: string) {
  const initial = await tx.voicePenaltyPoll.findUnique({ where: { id } });
  if (!initial) throw new PenaltyError('invalid');
  await tx.reputationGuild.update({ where: { guildId: initial.guildId }, data: { updatedAt: new Date() } });
  return tx.voicePenaltyPoll.findUniqueOrThrow({ where: { id } });
}
async function target(tx: Prisma.TransactionClient, guildId: string, userId: string) {
  const member = await tx.reputationMember.findUnique({ where: { guildId_userId: { guildId, userId } } });
  if (!member) return null;
  // First verified visits can precede the first midnight settlement. A personal
  // pause is not erasure, and does not make an existing participant immune.
  if (member.hasParticipated || await tx.reputationVoiceInterval.findFirst({ where: { guildId, userId }, select: { id: true } })) return member;
  return null;
}
async function close(tx: Prisma.TransactionClient, poll: PenaltyPoll, status: string, reason: string | null, data: { actualFine?: number; balanceAfter?: number; balanceBefore?: number; noVoterIds?: string[] } = {}) {
  const updated = await tx.voicePenaltyPoll.update({ where: { id: poll.id }, data: {
    status, reason, closedAt: await clock(tx), messageMissing: !poll.messageId, ...data,
  } });
  await tx.voicePenaltyVote.deleteMany({ where: { pollId: poll.id } });
  return updated;
}
export function createPenaltyStore(getDatabase: () => PrismaClient = getReputationDatabase): PenaltyStore {
  return {
    async reserve(request) {
      const kind = request.kind ?? 'penalty';
      if (!['penalty','reward'].includes(kind) || ![10,50,100].includes(request.amount) || request.targetId === request.initiatorId) throw new PenaltyError('invalid');
      return getDatabase().$transaction(async tx => {
        await tx.reputationGuild.upsert({ where: { guildId: request.guildId }, create: { guildId: request.guildId }, update: { updatedAt: new Date() } });
        const member = await target(tx, request.guildId, request.targetId);
        if (!member) throw new PenaltyError('not-participated');
        if (kind === 'penalty' && member.balance <= MIN_REPUTATION) throw new PenaltyError('balance-floor');
        if (kind === 'reward' && member.balance >= MAX_REPUTATION) throw new PenaltyError('balance-ceiling');
        const existing = await tx.voicePenaltyPoll.findFirst({ where: { guildId: request.guildId, targetId: request.targetId, status: { in: ['creating','active'] } }, select: { id: true } });
        if (existing) throw new PenaltyError('active-poll');
        return tx.voicePenaltyPoll.create({ data: { id: randomUUID(), ...request, kind, createdAt: await clock(tx) } });
      }, transaction);
    },
    get: id => getDatabase().voicePenaltyPoll.findUnique({ where: { id } }),
    async pending(guildId) {
      const db = getDatabase();
      const active = await db.voicePenaltyPoll.findMany({ where: { guildId, status: { in: ['creating','active'] } } });
      const closed = await db.voicePenaltyPoll.findMany({
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
        if (!Number.isFinite(startedAt.getTime()) || startedAt.getTime() > now.getTime() + PENALTY_DEADLINE_GRACE_MS ||
          startedAt.getTime() < poll.createdAt.getTime() - PENALTY_DEADLINE_GRACE_MS) throw new PenaltyError('invalid');
        const endsAt = new Date(startedAt.getTime() + PENALTY_DURATION_MS);
        const humans = new Set(startEvidence?.userIds.filter(id=>/^\d{17,20}$/.test(id)) ?? []);
        const verified = startEvidence && startEvidence.at >= startedAt &&
          startEvidence.at.getTime()-startedAt.getTime() <= PENALTY_DEADLINE_GRACE_MS &&
          humans.size >= 4 && humans.has(poll.targetId) && humans.has(poll.initiatorId);
        return tx.voicePenaltyPoll.update({ where: { id }, data: {
          messageId, startedAt, endsAt, messageMissing: false,
          status: poll.status === 'cancelled' || now >= endsAt || !verified ? 'cancelled' : 'active',
          ...(poll.status !== 'cancelled' && (now >= endsAt || !verified) ? {
            closedAt: now, reason: now >= endsAt ? 'deadline-unverified' : 'start-unverified',
          } : {}),
        } });
      },transaction);
    },
    async cancel(id, reason) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        return penaltyOpen(poll) ? close(tx,poll,'cancelled',reason) : poll;
      },transaction);
    },
    async vote(request) {
      if (!/^\d{17,20}$/.test(request.interactionId)) throw new PenaltyError('invalid');
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,request.id);
        if (poll.kind !== (request.kind ?? 'penalty') || poll.guildId !== request.guildId || poll.textChannelId !== request.textChannelId || poll.messageId !== request.messageId || poll.targetId === request.userId) throw new PenaltyError('invalid');
        if (poll.status === 'creating') throw new PenaltyError('not-ready');
        const updatedAt = await clock(tx);
        if (poll.status !== 'active' || !poll.endsAt || updatedAt >= poll.endsAt) throw new PenaltyError('expired');
        const key = { pollId_userId: { pollId: poll.id, userId: request.userId } };
        const previous = await tx.voicePenaltyVote.findUnique({ where: key });
        // Discord snowflakes order clicks, even when DB/network delays reorder
        // handler completion. A stale Yes must never overwrite a newer No.
        if (previous && BigInt(previous.interactionId) >= BigInt(request.interactionId)) return previous.yes;
        await tx.voicePenaltyVote.upsert({
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
        if (!penaltyOpen(poll)) return poll;
        if (!poll.endsAt || await clock(tx) < poll.endsAt) throw new PenaltyError('not-due');
        if (!evidence || !Number.isFinite(evidence.at.getTime()) || evidence.at < poll.endsAt ||
          evidence.at.getTime() - poll.endsAt.getTime() > PENALTY_DEADLINE_GRACE_MS) return close(tx,poll,'cancelled','deadline-unverified');
        const member = await target(tx,poll.guildId,poll.targetId);
        if (!member) return close(tx,poll,'cancelled','target-untracked');
        const voters = [...new Set(evidence.userIds)].filter(userId => userId !== poll.targetId && /^\d{17,20}$/.test(userId));
        const votes = await tx.voicePenaltyVote.findMany({ where: { pollId: id, userId: { in: voters } } });
        const noVoterIds = votes.filter(vote => !vote.yes).map(vote => vote.userId).sort();
        if (noVoterIds.length || !votes.some(vote => vote.yes)) return close(tx,poll,'failed',null,{ noVoterIds });
        const reward = poll.kind === 'reward';
        // Legacy actualFine stores the positive magnitude for either direction.
        const actualFine = Math.min(poll.amount,reward ? MAX_REPUTATION - member.balance : member.balance - MIN_REPUTATION);
        if (actualFine <= 0) return close(tx,poll,'cancelled',reward ? 'balance-ceiling' : 'balance-floor');
        const balanceAfter = member.balance + (reward ? actualFine : -actualFine);
        await tx.reputationMember.update({ where: { guildId_userId: { guildId: poll.guildId, userId: poll.targetId } }, data: { balance: balanceAfter } });
        return close(tx,poll,'succeeded',null,{ actualFine, balanceAfter, balanceBefore: member.balance });
      },transaction);
    },
    async noteAttempt(id) {
      await getDatabase().voicePenaltyPoll.updateMany({ where: { id, publishedAt: null, messageMissing: false }, data: { lastAttemptAt: new Date() } });
    },
    async prepareDelivery(id) {
      return getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (penaltyOpen(poll) || poll.publishedAt || poll.messageMissing) return poll;
        return tx.voicePenaltyPoll.update({ where: { id }, data: { publishing: true, lastAttemptAt: await clock(tx) } });
      },transaction);
    },
    async delivered(id, missing) {
      await getDatabase().$transaction(async tx => {
        const poll = await lock(tx,id);
        if (penaltyOpen(poll)) throw new PenaltyError('invalid');
        await tx.voicePenaltyPoll.update({ where: { id }, data: { publishing: false,
          ...(missing ? { messageMissing: true } : { publishedAt: await clock(tx) }),
        } });
      },transaction);
    },
  };
}
