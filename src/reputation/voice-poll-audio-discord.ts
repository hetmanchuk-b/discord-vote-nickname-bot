import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import path from 'node:path';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import type { Client, VoiceState } from 'discord.js';
import { VoicePollAudioError } from './voice-poll-audio.js';
import type { VoiceAnnouncementDriver } from './voice-poll-audio.js';

const loadDefaultVoice = () => import('@discordjs/voice');

export function createDiscordVoiceAnnouncementDriver(client: Client,
  file = path.join(__dirname, '..', 'assets', 'voting.ogg'),
  loadVoice: typeof loadDefaultVoice = loadDefaultVoice): VoiceAnnouncementDriver {
  return {
    async open(request, signal, ended) {
      // Lazy loading keeps missing/unsupported native voice dependencies from
      // preventing the bot's ordinary commands and financial voting from starting.
      if (signal.aborted) return null;
      const guild = client.guilds.cache.get(request.guildId);
      const channel = guild?.channels.cache.get(request.voiceChannelId);
      const me = guild?.members.me;
      if (!client.isReady() || !guild?.available) throw new VoicePollAudioError('guild-unavailable');
      if (channel?.type !== ChannelType.GuildVoice) throw new VoicePollAudioError('channel-invalid');
      if (!me) throw new VoicePollAudioError('bot-member-unavailable');
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel)) throw new VoicePollAudioError('missing-view');
      if (!permissions.has(PermissionFlagsBits.Connect)) throw new VoicePollAudioError('missing-connect');
      if (!permissions.has(PermissionFlagsBits.Speak)) throw new VoicePollAudioError('missing-speak');
      if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) throw new VoicePollAudioError('room-full');
      try {
        if (!statSync(file).isFile()) throw new VoicePollAudioError('audio-file-missing');
        accessSync(file, constants.R_OK);
      } catch (error) {
        if (error instanceof VoicePollAudioError) throw error;
        const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
        throw new VoicePollAudioError(missing ? 'audio-file-missing' : 'audio-file-unreadable');
      }
      const voice = await loadVoice().catch(() => { throw new VoicePollAudioError('voice-module-unavailable'); });
      if (signal.aborted) return null;
      // Never steal/reuse a connection owned by another voice feature.
      if (voice.getVoiceConnection(guild.id)) throw new VoicePollAudioError('connection-in-use');
      let connection: ReturnType<typeof voice.joinVoiceChannel>;
      try {
        connection = voice.joinVoiceChannel({ guildId: guild.id, channelId: channel.id,
          adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
      } catch { throw new VoicePollAudioError('connection-setup-failed'); }
      let player: ReturnType<typeof voice.createAudioPlayer> | undefined;
      let subscription: ReturnType<typeof connection.subscribe>;
      let input: ReadStream | undefined;
      let closed = false;
      const moved = (_old: VoiceState, next: VoiceState) => {
        if (next.guild.id === guild.id && next.id === client.user?.id &&
          (next.channelId !== channel.id || next.serverMute === true)) ended();
      };
      const idle = () => ended();
      const failed = () => ended('voice-error');
      const stateChanged = (_old: unknown, next: { status: string }) => {
        if (next.status === voice.VoiceConnectionStatus.Disconnected || next.status === voice.VoiceConnectionStatus.Destroyed) ended('connection-disconnected');
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
        player.on('error', () => ended('playback-error')); player.on(voice.AudioPlayerStatus.Idle, idle);
        subscription = connection.subscribe(player);
        if (!subscription) throw new VoicePollAudioError('connection-setup-failed');
        const ready = voice.entersState(connection, voice.VoiceConnectionStatus.Ready,
          AbortSignal.any([signal, AbortSignal.timeout(5000)])).then(() => {});
        return {
          ready, close,
          play() {
            if (closed || signal.aborted) return;
            input = createReadStream(file); input.on('error', () => ended('audio-file-unreadable'));
            player!.play(voice.createAudioResource(input, { inputType: voice.StreamType.OggOpus }));
          },
        };
      } catch { close(); throw new VoicePollAudioError('connection-setup-failed'); }
    },
  };
}
