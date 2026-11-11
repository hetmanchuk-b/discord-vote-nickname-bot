import { ChannelType, DiscordAPIError, Events, PermissionFlagsBits } from 'discord.js';
import type { Client, VoiceState } from 'discord.js';
import { createPenaltyStore, PENALTY_DEADLINE_GRACE_MS } from './voice-penalty-store.js';
import type { PenaltyPoll } from './voice-penalty-store.js';
import { PenaltyRuntime, PenaltyUserError } from './voice-penalty-runtime.js';
import type { PenaltyMessage, PenaltyPresence, PenaltyTransport } from './voice-penalty-runtime.js';
import { penaltyMarker, renderPenalty } from './voice-penalty-render.js';

interface Transition { at: number; id: string; from: string | null; to: string | null; human: boolean | undefined }
export class PenaltyVoicePresence implements PenaltyPresence {
  private connectedAt?: number;
  private transitions: Transition[] = [];
  constructor(private readonly client: Client, private readonly guildId: string | undefined, private readonly now = () => new Date()) {}
  private guild() {
    const guild = this.guildId ? this.client.guilds.cache.get(this.guildId) : undefined;
    if (!guild?.available || !this.client.isReady() || this.connectedAt === undefined) throw new PenaltyUserError('❌ Не вдалося підтвердити стан голосових каналів. Спробуйте після відновлення Discord.');
    return guild;
  }
  online() {
    if (!this.guildId || !this.client.isReady() || !this.client.guilds.cache.get(this.guildId)?.available) return;
    this.connectedAt ??= this.now().getTime();
  }
  offline() { this.connectedAt = undefined; this.transitions = []; }
  observe(oldState: VoiceState, newState: VoiceState) {
    if (newState.guild.id !== this.guildId || oldState.channelId === newState.channelId) return;
    const now = this.now().getTime();
    const member = newState.member ?? oldState.member;
    this.transitions.push({ at: now, id: newState.id, from: oldState.channelId, to: newState.channelId, human: member ? !member.user.bot : undefined });
    this.transitions = this.transitions.filter(item=>item.at >= now - PENALTY_DEADLINE_GRACE_MS);
    if (this.transitions.length > 5000) { this.transitions = []; this.connectedAt = now; }
  }
  channelFor(userId: string) {
    const state = this.guild().voiceStates.cache.get(userId);
    return state?.member && !state.member.user.bot && state.channel?.type === ChannelType.GuildVoice ? state.channelId : null;
  }
  humans(channelId: string): string[] { return this.members(channelId); }
  private members(channelId: string, ignoreUserId?: string): string[] {
    const guild = this.guild();
    const channel = guild.channels.cache.get(channelId);
    if (channel?.type !== ChannelType.GuildVoice) throw new PenaltyUserError('❌ Потрібен звичайний голосовий канал.');
    const me = guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) throw new PenaltyUserError('❌ Боту потрібен View Channel у початковому голосовому каналі.');
    const ids: string[] = [];
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId !== channelId || state.id === ignoreUserId) continue;
      if (!state.member) throw new PenaltyUserError('❌ Дані про учасників каналу ще недоступні.');
      if (!state.member.user.bot) ids.push(state.id);
    }
    return ids;
  }
  evidence(channelId: string, deadline: Date, ignoreUserId?: string) {
    const at = this.now();
    if (this.connectedAt === undefined || this.connectedAt > deadline.getTime() || at < deadline || at.getTime() - deadline.getTime() > PENALTY_DEADLINE_GRACE_MS) return null;
    try {
      const ids = new Set(this.members(channelId,ignoreUserId));
      // Undo observed changes AFTER the deadline, so a late join/leave during
      // normal timer jitter cannot add/remove a decisive voter.
      for (const event of [...this.transitions].reverse()) {
        if (event.at <= deadline.getTime() || event.at > at.getTime() || event.id === ignoreUserId) continue;
        if (event.from !== channelId && event.to !== channelId) continue;
        if (event.human === undefined) return null;
        if (event.human) {
          if (event.to === channelId) ids.delete(event.id);
          if (event.from === channelId) ids.add(event.id);
        }
      }
      return { at, userIds: [...ids] };
    } catch { return null; }
  }
}
class PenaltyMissingMessage extends Error {}
const missing = (error: unknown) => error instanceof PenaltyMissingMessage || error instanceof DiscordAPIError && (error.code === 10003 || error.code === 10008);
export function createPenaltyTransport(client: Client, guildId: string): PenaltyTransport {
  async function channel(poll: PenaltyPoll) {
    if (poll.guildId !== guildId) throw new Error('Penalty server mismatch.');
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) throw new Error('Penalty server unavailable.');
    const channel = await guild.channels.fetch(poll.textChannelId);
    if (!channel) throw new PenaltyMissingMessage();
    if ((channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) || channel.guildId !== guildId) throw new Error('Invalid penalty destination.');
    return channel;
  }
  async function writable(poll: PenaltyPoll) {
    const destination = await channel(poll);
    const me = destination.guild.members.me ?? await destination.guild.members.fetchMe();
    if (!destination.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles])) {
      throw new PenaltyUserError('❌ Боту потрібні View Channel, Send Messages, Embed Links, Read Message History та Attach Files у каналі голосування.');
    }
    return destination;
  }
  const find = async (poll: PenaltyPoll): Promise<PenaltyMessage | null> => {
    const destination = await channel(poll);
    let before: string | undefined;
    for (let page=0;page<2;page++) {
      const messages = await destination.messages.fetch({limit:100,...(before ? {before} : {})});
      const found = messages.find(message=>message.author.id===client.user?.id && message.embeds.some(embed=>embed.footer?.text.startsWith(`VP:${poll.id}:`)));
      if (found) return {id:found.id,at:found.createdAt};
      if (messages.size<100) break;
      before=messages.lastKey();
    }
    return null;
  };
  return {
    find,
    async publish(poll,beforeSend) {
      const destination = await writable(poll);
      const existing = await find(poll);
      if (existing) return existing;
      const guild = destination.guild;
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId !== poll.voiceChannelId || state.member?.user.bot) continue;
        if (!state.member || !destination.permissionsFor(state.member)?.has(PermissionFlagsBits.ViewChannel)) {
          throw new PenaltyUserError('❌ Канал голосування має бути видимим усім людям у початковому голосовому каналі.');
        }
      }
      const payload=renderPenalty(poll);
      beforeSend?.();
      const message=await destination.send({embeds:payload.embeds,components:payload.components,allowedMentions:{parse:[]},nonce:poll.id.replaceAll('-','').slice(0,24),enforceNonce:true});
      return {id:message.id,at:message.createdAt};
    },
    async inspect(poll) {
      if (!poll.messageId) return 'missing';
      try {
        const message=await (await channel(poll)).messages.fetch(poll.messageId);
        if (message.author.id!==client.user?.id) throw new Error('Penalty message author mismatch.');
        if (message.embeds.some(embed=>embed.footer?.text===penaltyMarker(poll.id,true))) return 'final';
        if (message.embeds.some(embed=>embed.footer?.text===penaltyMarker(poll.id,false))) return 'active';
        throw new Error('Penalty message marker mismatch.');
      } catch(error) { if(missing(error))return 'missing';throw error; }
    },
    async edit(poll,payload) {
      if (!poll.messageId) return;
      const destination=await writable(poll);
      const message=await destination.messages.fetch(poll.messageId);
      if(message.author.id!==client.user?.id || !message.embeds.some(embed=>embed.footer?.text.startsWith(`VP:${poll.id}:`))) throw new Error('Penalty message identity mismatch.');
      await destination.messages.edit(poll.messageId,payload);
    },
  };
}

export function attachVoicePenalties(client: Client, beforeCreate?: () => Promise<void>) {
  const configured=process.env.REPUTATION_GUILD_ID?.trim();
  const guildId=configured && /^\d{17,20}$/.test(configured) ? configured : undefined;
  const presence=new PenaltyVoicePresence(client,guildId);
  const runtime=new PenaltyRuntime({guildId,presence,beforeCreate,store:createPenaltyStore(),transport:createPenaltyTransport(client,guildId ?? '')});
  const resume=()=>{presence.online();void runtime.refresh();};
  const observe=(oldState: VoiceState,newState: VoiceState)=>presence.observe(oldState,newState);
  const offline=(_event:unknown,shardId:number)=>{if(guildId && client.guilds.cache.get(guildId)?.shardId===shardId)presence.offline();};
  const shardReady=(shardId:number)=>{if(guildId && client.guilds.cache.get(guildId)?.shardId===shardId)resume();};
  const unavailable=(guild: { id: string })=>{if(guild.id===guildId)presence.offline();};
  const available=(guild: { id: string })=>{if(guild.id===guildId)resume();};
  client.on(Events.ClientReady,resume);client.on(Events.VoiceStateUpdate,observe);
  client.on(Events.ShardDisconnect,offline);
  const reconnecting=(id:number)=>{if(guildId && client.guilds.cache.get(guildId)?.shardId===id)presence.offline();};
  client.on(Events.ShardReconnecting,reconnecting);
  client.on(Events.ShardResume,shardReady);client.on(Events.ShardReady,shardReady);
  client.on(Events.GuildUnavailable,unavailable);client.on(Events.GuildDelete,unavailable);
  client.on(Events.GuildAvailable,available);client.on(Events.GuildCreate,available);
  if(client.isReady())resume();
  return { runtime, async stop(){
    presence.offline();
    client.off(Events.ClientReady,resume);client.off(Events.VoiceStateUpdate,observe);
    client.off(Events.ShardDisconnect,offline);client.off(Events.ShardReconnecting,reconnecting);
    client.off(Events.ShardResume,shardReady);client.off(Events.ShardReady,shardReady);
    client.off(Events.GuildUnavailable,unavailable);client.off(Events.GuildDelete,unavailable);
    client.off(Events.GuildAvailable,available);client.off(Events.GuildCreate,available);
    await runtime.stop();
  }};
}
