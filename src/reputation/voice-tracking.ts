import { ChannelType, Events } from 'discord.js';
import type { Client, ClientEvents, Guild, VoiceState } from 'discord.js';
import { createTrackingStore } from './tracking-store.js';
import { CHECKPOINT_INTERVAL_MS, VoiceTracker } from './voice-tracker.js';

export function getTrackingConfiguration(environment: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  guildId?: string;
} {
  const enabled = environment.REPUTATION_TRACKING_ENABLED?.trim() ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('REPUTATION_TRACKING_ENABLED must be true or false.');
  }
  if (enabled === 'false') return { enabled: false };
  const guildId = environment.REPUTATION_GUILD_ID?.trim();
  if (!guildId || !/^\d{17,20}$/.test(guildId)) {
    throw new Error('REPUTATION_GUILD_ID must identify the server before tracking can be enabled.');
  }
  return { enabled: true, guildId };
}

export function eligibleVoiceUserIds(guild: Guild): string[] {
  return [...guild.voiceStates.cache.values()]
    .filter(state => state.member && !state.member.user.bot &&
      state.channel?.type === ChannelType.GuildVoice &&
      state.channelId !== guild.afkChannelId)
    .map(state => state.id);
}

export interface VoiceTrackingRuntime {
  tracker?: VoiceTracker;
  stop(): Promise<void>;
}

export function attachVoiceTracking(client: Client): VoiceTrackingRuntime {
  const config = getTrackingConfiguration();
  if (!config.enabled || !config.guildId) return { stop: async () => {} };
  const guildId = config.guildId;
  let online = false;
  let stopped = false;
  const tracker = new VoiceTracker({
    guildId,
    store: createTrackingStore(),
    presentUserIds: () => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? eligibleVoiceUserIds(guild) : [];
    },
    onStatus: event => {
      // Public, throttled warning messages are added in the reporting stage.
      if (event.status === 'recovered') console.log('Reputation tracking storage recovered.');
      else console.warn(`Reputation tracking ${event.status}: ${event.reason}. Only persisted time is retained.`);
    },
  });

  function run(task: Promise<void>) {
    void task.catch(() => console.error('Reputation tracking operation failed.'));
  }
  function resume() {
    if (stopped) return;
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) {
      console.warn('The configured reputation server is unavailable; tracking has not started.');
      return;
    }
    online = true;
    run(tracker.start());
  }
  function observe() {
    if (online && !stopped) run(tracker.observe());
  }
  function suspend(reason: string) {
    online = false;
    run(tracker.suspend(reason));
  }
  function voiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    if (oldState.guild.id === guildId || newState.guild.id === guildId) observe();
  }
  function guildAvailable(guild: Guild) {
    if (guild.id === guildId && client.isReady()) resume();
  }
  function guildUnavailable(guild: Guild) {
    if (guild.id === guildId) suspend('guild-unavailable');
  }
  function guildUpdate(_oldGuild: Guild, newGuild: Guild) {
    if (newGuild.id === guildId) observe(); // AFK configuration may have changed.
  }
  function channelUpdate(_oldChannel: ClientEvents[Events.ChannelUpdate][0], newChannel: ClientEvents[Events.ChannelUpdate][1]) {
    if ('guild' in newChannel && newChannel.guild.id === guildId) observe();
  }
  function channelDelete(channel: ClientEvents[Events.ChannelDelete][0]) {
    if ('guild' in channel && channel.guild.id === guildId) observe();
  }
  function shardDisconnect(_event: unknown, shardId: number) {
    if (client.guilds.cache.get(guildId)?.shardId === shardId) suspend('gateway');
  }
  function shardReconnecting(shardId: number) {
    if (client.guilds.cache.get(guildId)?.shardId === shardId) suspend('gateway');
  }
  function shardResume(shardId: number) {
    if (client.guilds.cache.get(guildId)?.shardId === shardId) resume();
  }

  client.on(Events.ClientReady, resume);
  client.on(Events.VoiceStateUpdate, voiceStateUpdate);
  client.on(Events.GuildAvailable, guildAvailable);
  client.on(Events.GuildCreate, guildAvailable);
  client.on(Events.GuildUnavailable, guildUnavailable);
  client.on(Events.GuildDelete, guildUnavailable);
  client.on(Events.GuildUpdate, guildUpdate);
  client.on(Events.ChannelUpdate, channelUpdate);
  client.on(Events.ChannelDelete, channelDelete);
  client.on(Events.ShardDisconnect, shardDisconnect);
  client.on(Events.ShardReconnecting, shardReconnecting);
  client.on(Events.ShardResume, shardResume);
  client.on(Events.ShardReady, shardResume);
  const timer = setInterval(() => {
    if (online && !stopped) run(tracker.checkpoint());
  }, CHECKPOINT_INTERVAL_MS);
  timer.unref();
  if (client.isReady()) resume();

  return {
    tracker,
    async stop() {
      if (stopped) return;
      stopped = true;
      online = false;
      clearInterval(timer);
      client.off(Events.ClientReady, resume);
      client.off(Events.VoiceStateUpdate, voiceStateUpdate);
      client.off(Events.GuildAvailable, guildAvailable);
      client.off(Events.GuildCreate, guildAvailable);
      client.off(Events.GuildUnavailable, guildUnavailable);
      client.off(Events.GuildDelete, guildUnavailable);
      client.off(Events.GuildUpdate, guildUpdate);
      client.off(Events.ChannelUpdate, channelUpdate);
      client.off(Events.ChannelDelete, channelDelete);
      client.off(Events.ShardDisconnect, shardDisconnect);
      client.off(Events.ShardReconnecting, shardReconnecting);
      client.off(Events.ShardResume, shardResume);
      client.off(Events.ShardReady, shardResume);
      await tracker.stop();
    },
  };
}
