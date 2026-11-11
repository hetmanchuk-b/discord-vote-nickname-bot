import { createHash } from 'node:crypto';
import { ChannelType, DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import type { Client, TextChannel } from 'discord.js';
import { renderPlaceholder, reportMarker } from './report-render.js';
import type { PublicationPayload } from './report-render.js';
import type { DailyReport } from './report-store.js';

export interface PublicationTransport {
  createPlaceholder(channelId: string, report: DailyReport): Promise<string>;
  inspect(channelId: string, messageId: string, reportId: string): Promise<'pending' | 'published' | 'missing'>;
  edit(channelId: string, messageId: string, payload: PublicationPayload): Promise<void>;
  warning(channelId: string, messageId: string | null, guildId: string, payload: PublicationPayload): Promise<string>;
}

class MissingMessage extends Error {}
const missing = (error: unknown) => error instanceof MissingMessage ||
  error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003);

export function createDiscordPublications(client: Client, guildId: string): PublicationTransport {
  async function channel(id: string): Promise<TextChannel> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Report server unavailable.');
    const result = await guild.channels.fetch(id);
    if (!result) throw new MissingMessage();
    if (result.type !== ChannelType.GuildText || result.guildId !== guildId) throw new Error('Invalid report channel.');
    return result;
  }
  async function requireWritable(destination: TextChannel): Promise<void> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Report server unavailable.');
    const bot = guild.members.me ?? await guild.members.fetchMe();
    if (!destination.permissionsFor(bot)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
    ])) throw new Error('Report channel permissions are incomplete.');
  }
  async function find(destination: TextChannel, marker: string): Promise<string | null> {
    let before: string | undefined;
    // Best-effort recovery outside Discord's short nonce window. Orphaned empty
    // placeholders are possible in very busy channels; never publish user data in them.
    for (let page = 0; page < 2; page++) {
      const messages = await destination.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const match = messages.find(message => message.author.id === client.user?.id &&
        message.embeds.some(embed => embed.footer?.text.startsWith(marker)));
      if (match) return match.id;
      if (messages.size < 100) break;
      before = messages.lastKey();
    }
    return null;
  }
  return {
    async createPlaceholder(channelId, report) {
      const destination = await channel(channelId);
      await requireWritable(destination);
      const found = await find(destination, `REP:${report.id}:`);
      if (found) return found;
      const payload = renderPlaceholder(report);
      const sent = await destination.send({
        embeds: payload.embeds, allowedMentions: { parse: [] },
        nonce: report.id.replaceAll('-', '').slice(0, 24), enforceNonce: true,
      });
      return sent.id;
    },
    async inspect(channelId, messageId, reportId) {
      try {
        const message = await (await channel(channelId)).messages.fetch(messageId);
        if (message.author.id !== client.user?.id) throw new Error('Report message has a different author.');
        if (message.embeds.some(embed => embed.footer?.text.startsWith(reportMarker(reportId, true)))) return 'published';
        if (message.embeds.some(embed => embed.footer?.text === reportMarker(reportId, false))) {
          await requireWritable(await channel(channelId));
          return 'pending';
        }
        throw new Error('Report message marker does not match.');
      } catch (error) {
        if (missing(error)) return 'missing';
        throw error;
      }
    },
    async edit(channelId, messageId, payload) {
      const destination = await channel(channelId);
      await requireWritable(destination);
      await destination.messages.edit(messageId, payload);
    },
    async warning(channelId, messageId, warningGuildId, payload) {
      const destination = await channel(channelId);
      await requireWritable(destination);
      let id = messageId;
      if (id) {
        try {
          await destination.messages.edit(id, payload);
          return id;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      id = await find(destination, `REP-WARN:${warningGuildId}`);
      if (!id) {
        const sent = await destination.send({
          embeds: payload.embeds, allowedMentions: { parse: [] },
          nonce: createHash('sha256').update(warningGuildId).digest('hex').slice(0, 24), enforceNonce: true,
        });
        id = sent.id;
      }
      await destination.messages.edit(id, payload);
      return id;
    },
  };
}
