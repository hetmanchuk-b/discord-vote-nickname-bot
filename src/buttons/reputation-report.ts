import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../types.js';

const queues = new Map<string, Promise<unknown>>();

export const handleReputationPage: ButtonHandler = async interaction => {
  const match = /^reputation:page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,10})$/.exec(interaction.customId);
  if (!match || !interaction.guildId) {
    return interaction.reply({ content: '❌ Некоректна сторінка звіту.', flags: MessageFlags.Ephemeral });
  }
  const guildId = interaction.guildId;
  await interaction.deferUpdate(); // Acknowledge immediately, before queued DB/network work.
  const key = interaction.message.id;
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const payload = await interaction.client.reputationReports.page({
      reportId: match[1], page: Number(match[2]), guildId,
      channelId: interaction.channelId, messageId: key,
    });
    if (!payload) return interaction.followUp({ content: '⌛ Ця сторінка звіту недоступна.', flags: MessageFlags.Ephemeral });
    return interaction.editReply(payload);
  });
  queues.set(key, operation);
  try { return await operation; }
  finally { if (queues.get(key) === operation) queues.delete(key); }
};
