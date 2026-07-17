const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const MediaDownloader = require('media-downloader-ez');

const data = new SlashCommandBuilder()
  .setName('dw')
  .setDescription('Download media')
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Media link')
      .setRequired(true)
  );

async function execute(interaction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: '❌ Команда доступна лише на сервері',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.channel.isThread()) {
    return interaction.reply({
      content: '❌ Команда недоступна в гілках',
      flags: MessageFlags.Ephemeral,
    });
  }

  const url = interaction.options.getString('url', true);

  if (!MediaDownloader.isVideoLink(url)) {
    return interaction.reply({
      content: 'Please specify a video URL from Instagram, YouTube, X, TikTok, Facebook...',
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
    try {
      await interaction.editReply({ content: '❌ Error downloading' });
    } catch (e) {
      console.error('Failed to edit reply:', e);
    }
    scheduleDelete(await interaction.fetchReply().catch(() => null), 3000);
  }
}

function scheduleDelete(message, delay = 3000) {
  if (!message) return;
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

module.exports = { data, execute };