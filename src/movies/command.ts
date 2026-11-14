import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.js';
import { movieFeedback } from './types.js';

export const movieCommand: Command = {
  data: new SlashCommandBuilder().setName('movie').setDescription('Опублікувати фільм з IMDb та оцінити його разом')
    .setDMPermission(false)
    .addStringOption(option => option.setName('imdb').setDescription('Посилання IMDb на фільм').setRequired(true).setMaxLength(2048)),
  cooldown: 10,
  async execute(interaction) {
    let deferred = false;
    try {
      if (!interaction.guildId || interaction.user.bot) return await interaction.reply({ content: '❌ Команда доступна людям на сервері.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      deferred = true;
      const post = await interaction.client.movies.create({ guildId: interaction.guildId, channelId: interaction.channelId,
        interactionId: interaction.id, link: interaction.options.getString('imdb', true) });
      const content = post.status === 'missing' ? '❌ Повідомлення фільму більше не доступне.' : post.messageId && post.deliveredRevision !== null ?
        `🎬 Картку фільму опубліковано: https://discord.com/channels/${interaction.guildId}/${post.channelId}/${post.messageId}` :
        '🎬 Запит збережено. Картка з’явиться в цьому каналі автоматично.';
      return await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      try {
        const response = { content: movieFeedback(error), allowedMentions: { parse: [] } };
        if (deferred || interaction.deferred || interaction.replied) return await interaction.editReply(response);
        return await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
      } catch { console.warn('Could not deliver movie command feedback.'); }
    }
  },
};
