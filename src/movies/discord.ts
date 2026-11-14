import { ChannelType, ComponentType, DiscordAPIError, Events, PermissionFlagsBits } from 'discord.js';
import type { Client, Message, TextChannel, VoiceChannel } from 'discord.js';
import { createMovieLookup } from './metadata.js';
import { movieButtonRevision, movieMarker, renderMoviePlaceholder } from './render.js';
import { MovieRuntime } from './runtime.js';
import type { MovieTransport } from './runtime.js';
import { createMovieStore } from './store.js';
import { MovieError } from './types.js';

const missing = (error: unknown) => error instanceof DiscordAPIError && [10003, 10004, 10008].includes(Number(error.code));
function messageRevision(message: Message, postId: string): 'pending' | bigint | null {
  for (const row of message.components ?? []) {
    if (row.type !== ComponentType.ActionRow) continue;
    for (const button of row.components) {
      if (button.type !== ComponentType.Button || !button.customId) continue;
      const revision = movieButtonRevision(button.customId, postId);
      if (revision !== null) return revision;
    }
  }
  const footer = message.embeds.find(embed => embed.footer?.text.startsWith(movieMarker(postId)))?.footer?.text;
  const revision = footer?.slice(movieMarker(postId).length).split(' · ')[0];
  if (revision === 'pending') return 'pending';
  return revision && /^\d{1,19}$/.test(revision) ? BigInt(revision) : null;
}
export function createMovieTransport(client: Client): MovieTransport {
  async function destination(guildId: string, channelId: string): Promise<TextChannel | VoiceChannel> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) throw new MovieError('post-missing');
      if ((channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice) || channel.guildId !== guildId) throw new MovieError('invalid-destination');
      return channel;
    } catch (error) {
      if (missing(error)) throw new MovieError('post-missing');
      throw error;
    }
  }
  async function writable(channel: TextChannel | VoiceChannel): Promise<void> {
    const bot = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(bot);
    if (![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]
      .every(permission => permissions?.has(permission))) throw new MovieError('permissions');
  }
  return {
    async check(guildId, channelId) { await writable(await destination(guildId, channelId)); },
    async placeholder(post) {
      const channel = await destination(post.movie.guildId, post.channelId);
      await writable(channel);
      let before: string | undefined;
      for (let page = 0; page < 2; page++) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        const found = messages.find(message => message.author.id === client.user?.id &&
          messageRevision(message, post.id) !== null);
        if (found) return found.id;
        if (messages.size < 100) break;
        before = messages.lastKey();
      }
      const sent = await channel.send({ ...renderMoviePlaceholder(post.id), nonce: post.id.replaceAll('-', '').slice(0, 24), enforceNonce: true });
      return sent.id;
    },
    async inspect(post) {
      try {
        const channel = await destination(post.movie.guildId, post.channelId);
        if (!post.messageId) throw new MovieError('invalid-vote');
        const message = await channel.messages.fetch(post.messageId);
        if (message.author.id !== client.user?.id) throw new MovieError('invalid-vote');
        const revision = messageRevision(message, post.id);
        if (revision !== null) return revision;
        throw new MovieError('invalid-vote');
      } catch (error) {
        if (missing(error) || error instanceof MovieError && error.code === 'post-missing') return 'missing';
        throw error;
      }
    },
    async edit(post, payload) {
      const channel = await destination(post.movie.guildId, post.channelId);
      await writable(channel);
      if (!post.messageId) throw new MovieError('invalid-vote');
      // The worker already inspected this immutable message ID and its author/marker.
      try { await channel.messages.edit(post.messageId, payload); }
      catch (error) {
        if (missing(error)) throw new MovieError('post-missing');
        throw error;
      }
    },
  };
}
export function attachMovies(client: Client) {
  // Share the existing lazy Prisma pool; passive voice tracking need not be enabled.
  const runtime = new MovieRuntime(createMovieStore(), createMovieLookup(), createMovieTransport(client), Boolean(process.env.DATABASE_URL?.trim()));
  const resume = () => { void runtime.start(); };
  client.on(Events.ClientReady, resume);
  client.on(Events.ShardResume, resume);
  client.on(Events.GuildAvailable, resume);
  return {
    runtime,
    async stop() {
      client.off(Events.ClientReady, resume);
      client.off(Events.ShardResume, resume);
      client.off(Events.GuildAvailable, resume);
      await runtime.stop();
    },
  };
}
