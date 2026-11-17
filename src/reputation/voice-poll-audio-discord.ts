import { createReadStream, statSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import path from 'node:path';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import type { Client, VoiceState } from 'discord.js';
import type { VoiceAnnouncementDriver } from './voice-poll-audio.js';

const loadDefaultVoice = () => import('@discordjs/voice');

export function createDiscordVoiceAnnouncementDriver(client: Client,
  file = path.join(__dirname, '..', 'assets', 'voting.ogg'),
  loadVoice: typeof loadDefaultVoice = loadDefaultVoice): VoiceAnnouncementDriver {
  return {
    async open(request, signal, ended) {
      // Lazy loading keeps missing/unsupported native voice dependencies from
      // preventing the bot's ordinary commands and financial voting from starting.
      const voice = await loadVoice();
      if (signal.aborted) return null;
      const guild = client.guilds.cache.get(request.guildId);
      const channel = guild?.channels.cache.get(request.voiceChannelId);
      const me = guild?.members.me;
      if (!client.isReady() || !guild?.available || channel?.type !== ChannelType.GuildVoice || !me) return null;
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]) ||
        channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) return null;
      // Never steal/reuse a connection owned by another voice feature.
      if (voice.getVoiceConnection(guild.id)) return null;
      if (!statSync(file).isFile() || signal.aborted) return null;
      const connection = voice.joinVoiceChannel({ guildId: guild.id, channelId: channel.id,
        adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
      let player: ReturnType<typeof voice.createAudioPlayer> | undefined;
      let subscription: ReturnType<typeof connection.subscribe>;
      let input: ReadStream | undefined;
      let closed = false;
      const moved = (_old: VoiceState, next: VoiceState) => {
        if (next.guild.id === guild.id && next.id === client.user?.id &&
          (next.channelId !== channel.id || next.serverMute === true)) ended();
      };
      const idle = () => ended();
      const failed = () => ended(true);
      const stateChanged = (_old: unknown, next: { status: string }) => {
        if (next.status === voice.VoiceConnectionStatus.Disconnected || next.status === voice.VoiceConnectionStatus.Destroyed) failed();
      };
      const close = () => {
        if (closed) return; closed = true;
        client.off(Events.VoiceStateUpdate, moved);
        connection.off('stateChange', stateChanged);
        player?.off(voice.AudioPlayerStatus.Idle, idle);
        // Keep error handlers installed through teardown so late stream/network
        // errors are consumed. Destroyed objects become unreachable afterwards.
        for (const cleanup of [() => player?.stop(true), () => subscription?.unsubscribe(), () => input?.destroy(), () => {
          if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy();
        }]) {
          try { cleanup(); } catch { /* Always attempt the remaining cleanup, especially disconnect. */ }
        }
      };
      try {
        connection.on('error', failed); connection.on('stateChange', stateChanged);
        client.on(Events.VoiceStateUpdate, moved);
        player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Stop } });
        player.on('error', failed); player.on(voice.AudioPlayerStatus.Idle, idle);
        subscription = connection.subscribe(player);
        if (!subscription) throw new Error('Voice audio subscription unavailable.');
        const ready = voice.entersState(connection, voice.VoiceConnectionStatus.Ready,
          AbortSignal.any([signal, AbortSignal.timeout(5000)])).then(() => {});
        return {
          ready, close,
          play() {
            if (closed || signal.aborted) return;
            input = createReadStream(file); input.on('error', failed);
            player!.play(voice.createAudioResource(input, { inputType: voice.StreamType.OggOpus }));
          },
        };
      } catch { close(); throw new Error('Voice announcement setup unavailable.'); }
    },
  };
}
