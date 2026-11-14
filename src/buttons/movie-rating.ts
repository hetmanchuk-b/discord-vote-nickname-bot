import { MessageFlags } from 'discord.js';
import type { ButtonHandler } from '../types.js';
import { parseMovieButton } from '../movies/render.js';
import { movieFeedback } from '../movies/types.js';

export const handleMovieRating: ButtonHandler = async interaction => {
  const parsed = parseMovieButton(interaction.customId);
  if (!parsed || !interaction.guildId || interaction.user.bot) {
    return interaction.reply({ content: '❌ Некоректна оцінка або повідомлення фільму.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const score = await interaction.client.movies.vote({ ...parsed, guildId: interaction.guildId, channelId: interaction.channelId,
      messageId: interaction.message.id, userId: interaction.user.id, interactionId: interaction.id });
    return await interaction.editReply({ content: `✅ Ваша поточна оцінка: **${score}/10**. Її можна змінити іншим натисканням.`, allowedMentions: { parse: [] } });
  } catch (error) {
    return interaction.editReply({ content: movieFeedback(error), allowedMentions: { parse: [] } });
  }
};
