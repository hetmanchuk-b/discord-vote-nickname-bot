import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import MediaDownloader from 'media-downloader-ez';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('dw')
  .setDescription('Download video')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Video link')
      .setRequired(true)
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: '❌ Команда доступна лише на сервері',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.channel?.isThread()) {
    return interaction.reply({
      content: '❌ Команда недоступна в гілках',
      flags: MessageFlags.Ephemeral,
    });
  }

  const url = interaction.options.getString('url', true);

  if (!MediaDownloader.isVideoLink(url)) {
    return interaction.reply({
      content: 'Please specify a video URL from Instagram, X, TikTok, Facebook...',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (url.includes('youtube') || url.includes('youtu.be')) {
    return interaction.reply({
      content: 'Cannot download YouTube videos',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  try {
    const attachment = await MediaDownloader(url, { autocrop: false });

    await interaction.editReply({
      content: `Downloaded by: ${interaction.user}`,
      files: [attachment],
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    try {
      await interaction.editReply({ content: `❌ Error downloading: ${message}` });
    } catch (e) {
      console.error('Failed to edit reply:', e);
    }
    scheduleDelete(await interaction.fetchReply().catch(() => null), 3000);
  }
}

function scheduleDelete(message: Message | null, delay = 3000) {
  if (!message) return;
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

export default { data, execute } satisfies Command;