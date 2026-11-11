import type { PenaltyEvidence, PenaltyPoll, PenaltyStore, PenaltyVoteRequest } from './voice-penalty-store.js';
import { PenaltyError, penaltyOpen } from './voice-penalty-store.js';
import { renderPenalty } from './voice-penalty-render.js';
import type { PenaltyPayload } from './voice-penalty-render.js';

export interface PenaltyPresence {
  channelFor(userId: string): string | null;
  humans(channelId: string): readonly string[];
  evidence(channelId: string, deadline: Date, ignoreUserId?: string): PenaltyEvidence | null;
}
export interface PenaltyMessage { id: string; at: Date }
export interface PenaltyTransport {
  publish(poll: PenaltyPoll, beforeSend?: () => void): Promise<PenaltyMessage>;
  find(poll: PenaltyPoll): Promise<PenaltyMessage | null>;
  inspect(poll: PenaltyPoll): Promise<'active' | 'final' | 'missing'>;
  edit(poll: PenaltyPoll, payload: PenaltyPayload): Promise<void>;
}
export class PenaltyUserError extends Error {
  constructor(readonly publicMessage: string) { super('Voice penalty validation failed.'); }
}
export interface StartPenalty {
  guildId: string; initiatorId: string; targetId: string; textChannelId: string; amount: number;
}
export interface VoicePenalties {
  create(request: StartPenalty): Promise<PenaltyPoll>;
  vote(request: PenaltyVoteRequest): Promise<boolean>;
}
interface Options {
  guildId?: string; store: PenaltyStore; presence: PenaltyPresence; transport: PenaltyTransport; now?: () => Date;
  beforeCreate?: () => Promise<void>;
}

export class PenaltyRuntime implements VoicePenalties {
  private readonly now: () => Date;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly observations = new Map<string, PenaltyEvidence | null>();
  private readonly failures = new Map<string, number>();
  private stopped = false;
  constructor(private readonly options: Options) { this.now = options.now ?? (() => new Date()); }

  private guild(guildId: string) {
    if (!this.options.guildId || guildId !== this.options.guildId) throw new PenaltyUserError('❌ Команда доступна лише на налаштованому сервері репутації.');
    if (this.stopped) throw new PenaltyUserError('⌛ Бот завершує роботу. Спробуйте пізніше.');
  }
  private startChannel(request: StartPenalty): string {
    if (request.targetId === request.initiatorId || ![10,50,100].includes(request.amount)) throw new PenaltyError('invalid');
    const channel = this.options.presence.channelFor(request.initiatorId);
    if (!channel || this.options.presence.channelFor(request.targetId) !== channel) throw new PenaltyUserError('❌ Ви та адресат повинні бути в одному звичайному голосовому каналі.');
    const humans = new Set(this.options.presence.humans(channel));
    if (!humans.has(request.initiatorId) || !humans.has(request.targetId) || humans.size < 4) throw new PenaltyUserError('❌ На початку в каналі мають бути щонайменше чотири людини, включно з вами та адресатом.');
    return channel;
  }
  async create(request: StartPenalty): Promise<PenaltyPoll> {
    this.guild(request.guildId);
    const voiceChannelId = this.startChannel(request);
    await this.options.beforeCreate?.(); // Persist a first ongoing verified visit before checking enrollment.
    const poll = await this.options.store.reserve({ ...request, voiceChannelId });
    try {
      await this.exclusive(poll.id,async()=>{
        if (this.startChannel(request) !== voiceChannelId) {
          await this.options.store.cancel(poll.id,'start-invalid');
          throw new PenaltyError('invalid');
        }
        const message = await this.options.transport.publish(poll,()=>{
          if (this.startChannel(request) !== voiceChannelId) throw new PenaltyUserError('❌ Початковий голосовий канал змінився.');
        });
        const active = await this.options.store.activate(poll.id,message.id,message.at,
          this.options.presence.evidence(voiceChannelId,message.at));
        this.watch(active);
      });
    } catch (error) {
      // Unknown Discord acknowledgements keep the durable reservation. Recovery
      // searches for the same marker; it never blindly creates another poll.
      if (error instanceof PenaltyUserError) {
        try { await this.options.store.cancel(poll.id,'start-invalid'); }
        catch { this.retry(poll.id); }
      } else this.retry(poll.id);
      throw error;
    }
    const saved = await this.options.store.get(poll.id);
    if (!saved?.messageId) throw new PenaltyError('not-ready');
    return saved;
  }
  async vote(request: PenaltyVoteRequest): Promise<boolean> {
    this.guild(request.guildId);
    const poll = await this.options.store.get(request.id);
    if (!poll || poll.guildId !== request.guildId || poll.messageId !== request.messageId || poll.textChannelId !== request.textChannelId) throw new PenaltyError('invalid');
    if (poll.targetId === request.userId) throw new PenaltyUserError('❌ Адресат штрафу не може голосувати у власному голосуванні.');
    if (this.options.presence.channelFor(request.userId) !== poll.voiceChannelId ||
      !this.options.presence.humans(poll.voiceChannelId).includes(request.userId)) throw new PenaltyUserError('❌ Голосувати можуть лише люди в початковому голосовому каналі.');
    return this.options.store.vote(request);
  }
  async refresh(): Promise<void> {
    if (this.stopped || !this.options.guildId) return;
    try {
      const polls = await this.options.store.pending(this.options.guildId);
      for (const poll of polls) this.watch(poll);
      if (polls.filter(p=>!penaltyOpen(p)).length === 100) this.later('refresh',60_000,()=>{void this.refresh();});
      this.failures.delete('refresh');
    } catch { this.retry('refresh'); }
  }
  private later(key: string, delay: number, action: () => void) {
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    if (this.stopped) return;
    const timer = setTimeout(()=>{ this.timers.delete(key); if (!this.stopped) action(); },Math.max(1,delay));
    timer.unref(); this.timers.set(key,timer);
  }
  private watch(poll: PenaltyPoll) {
    if (this.stopped || poll.publishedAt || poll.messageMissing) return;
    if (poll.status === 'creating') {
      const age = this.now().getTime()-poll.createdAt.getTime();
      if (age >= 0 && age < 5000) { this.later(poll.id,5000-age,()=>this.drive(poll.id)); return; }
    }
    if (poll.status === 'active' && poll.endsAt) {
      if (poll.endsAt > this.now()) {
        const retry = this.timers.get(poll.id);
        if (retry) clearTimeout(retry);
        this.timers.delete(poll.id);
        this.later(`deadline:${poll.id}`,poll.endsAt.getTime()-this.now().getTime(),()=>{
          // Capture BEFORE any database/network await. Preserve this exact
          // evidence through DB outages; retries must not recheck a later roster.
          this.capture(poll);
          this.drive(poll.id);
        });
        return;
      }
      this.capture(poll);
    }
    this.drive(poll.id);
  }
  private capture(poll: PenaltyPoll) {
    if (this.observations.has(poll.id) || !poll.endsAt) return;
    try { this.observations.set(poll.id,this.options.presence.evidence(poll.voiceChannelId,poll.endsAt,poll.targetId)); }
    catch { this.observations.set(poll.id,null); }
  }
  private retry(id: string) {
    if (this.stopped) return;
    const failures = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id,failures);
    console.warn('Could not confirm a voice penalty operation; retrying safely.');
    this.later(id,Math.min(5000*2**Math.min(failures-1,4),60_000),()=>{
      if (id === 'refresh') void this.refresh(); else this.drive(id);
    });
  }
  private drive(id: string) {
    if (this.jobs.has(id)) { this.dirty.add(id); return; }
    void this.exclusive(id,async()=>{
      let poll = await this.options.store.get(id);
      if (!poll) { this.forget(id); return; }
      if (poll.status === 'creating') {
        if (this.now().getTime()-poll.createdAt.getTime() > 122_000) poll = await this.options.store.cancel(id,'creation-unconfirmed');
        else {
          const message = await this.options.transport.find(poll);
          poll = message ? await this.options.store.activate(id,message.id,message.at,
            this.options.presence.evidence(poll.voiceChannelId,message.at)) : await this.options.store.cancel(id,'creation-unconfirmed');
        }
      }
      if (poll.status === 'active') {
        if (poll.endsAt && poll.endsAt > this.now()) { this.watch(poll); return; }
        // A restart AFTER the deadline has no verified evidence. The presence
        // adapter rejects that deadline rather than inventing attendance.
        this.capture(poll);
        if (await this.options.transport.inspect(poll) === 'missing') {
          await this.options.store.cancel(id,'message-missing');
          await this.options.store.delivered(id,true);
          this.forget(id); return;
        }
        try { poll = await this.options.store.finish(id,this.observations.get(id) ?? null); }
        catch (error) {
          if (error instanceof PenaltyError && error.code === 'not-due') {
            this.observations.delete(id);
            this.later(id,250,()=>this.drive(id)); return;
          }
          throw error;
        }
      }
      if (penaltyOpen(poll) || poll.publishedAt || poll.messageMissing) { this.forget(id); return; }
      await this.options.store.noteAttempt(id);
      const state = await this.options.transport.inspect(poll);
      if (state !== 'active') await this.options.store.delivered(id,state === 'missing');
      else {
        const frozen = await this.options.store.prepareDelivery(id);
        if (frozen.publishedAt || frozen.messageMissing || penaltyOpen(frozen)) { this.forget(id); return; }
        await this.options.transport.edit(frozen,renderPenalty(frozen));
        await this.options.store.delivered(id,false);
      }
      this.forget(id);
    }).catch(()=>this.retry(id));
  }
  private forget(id: string) {
    this.observations.delete(id); this.failures.delete(id);
    for (const key of [id,`deadline:${id}`]) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
  }
  private async exclusive(id: string, operation: () => Promise<void>) {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const task = operation(); this.jobs.set(id,task);
    try { await task; } finally {
      if (this.jobs.get(id) === task) this.jobs.delete(id);
      if (this.dirty.delete(id) && !this.stopped) void Promise.resolve().then(()=>this.drive(id));
    }
  }
  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.jobs.values()]);
    this.observations.clear();
  }
}
