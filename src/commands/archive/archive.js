const {SlashCommandBuilder, MessageFlags, EmbedBuilder} = require("discord.js");
const {ARCHIVE_NOTES_THREAD_ID} = require("../../utils/constants.js");

const data = new SlashCommandBuilder()
  .setName('archive')
  .setDescription('Додати запис в архів')
  .addStringOption((option) => {
    return option.setName('note').setDescription('Запис').setRequired(true)
  })
  .addStringOption((option) => {
    return option
      .setName('importance')
      .setDescription('Важливість запису')
      .setRequired(true)
      .addChoices(
        { name: '🔵 Інформація', value: 'info' },
        { name: '⚫ Критично', value: 'critical' },
        { name: '🟢 Звичайна', value: 'normal' },
        { name: '🟡 Середня', value: 'medium' },
        { name: '🔴 Важлива', value: 'high' },
      )
  })

async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) {
    return interaction.reply({
      content: '❌ Команда доступна лише на сервері',
      flags: MessageFlags.Ephemeral
    })
  }

  const note = interaction.options.getString('note')
  const thread = await guild.channels.fetch(ARCHIVE_NOTES_THREAD_ID).catch(() => null)

  if (!thread || !thread.isThread()) {
    return interaction.reply({
      content: '❌ Архівний тред не знайдено.',
      flags: MessageFlags.Ephemeral
    })
  }

  const importance = interaction.options.getString('importance') ?? 'normal'

  const colors = {
    info: 0x699BF5,
    critical: 0x1E1E24,
    normal: 0x57F287,
    medium: 0xFEE75C,
    high: 0xED4245,
  }

  const messageTitles = {
    info: 'Інформація 🔵',
    critical: 'Критична ⚫',
    normal: 'Звичайна 🟢',
    medium: 'Середня 🟡',
    high: 'Важлива 🔴',
  }

  const now = new Date()
  const date = now.toLocaleDateString('uk-UA', {
    timeZone: 'Europe/Kiev',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const embed = new EmbedBuilder()
    .setColor(colors[importance])
    .setTitle(note)
    .setDescription(`Новий запис. Важливість ${messageTitles[importance]}`)
    .addFields(
      {
        name: 'Автор',
        value: `${interaction.user}`,
        inline: true
      },
      {
        name: '📅 Дата',
        value: date,
        inline: true,
      }
    )
    // .setFooter({
    //   text: `ID автора: ${interaction.user.id}`,
    // })
    .setTimestamp()

  await thread.send({
    embeds: [embed],
  })

  await interaction.reply({
    content: `Запис додано ➡️ ${thread.url}.`,
    embeds: [embed],
  });
}

module.exports = {data, execute}