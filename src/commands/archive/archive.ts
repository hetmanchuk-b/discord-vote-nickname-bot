import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { ARCHIVE_NOTES_THREAD_ID } from '../../utils/constants.js';
import type { Command } from '../../types.js';

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
      .setRequired(false)
      .addChoices(
        { name: 'Інформація 🔵', value: 'info' },
        { name: 'Критично ⚫', value: 'critical' },
        { name: 'Звичайна 🟢', value: 'normal' },
        { name: 'Середня 🟡', value: 'medium' },
        { name: 'Важлива 🔴', value: 'high' },
      )
  })
  .addStringOption((option) => {
    return option.setName('cite-author').setDescription('Автор цитати?').setRequired(false)
  })
  .addStringOption((option) => {
    return option
      .setName('image-url')
      .setDescription('URL изображения для архива.')
      .setRequired(false)
  })

async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild
  if (!guild) {
    return interaction.reply({
      content: '❌ Команда доступна лише на сервері',
      flags: MessageFlags.Ephemeral
    })
  }

  const note = interaction.options.getString('note', true)
  const thread = await guild.channels.fetch(ARCHIVE_NOTES_THREAD_ID).catch(() => null)

  if (!thread || !thread.isThread()) {
    return interaction.reply({
      content: '❌ Архівний тред не знайдено.',
      flags: MessageFlags.Ephemeral
    })
  }

  const requestedImportance = interaction.options.getString('importance') ?? 'normal'
  const importance = isImportance(requestedImportance) ? requestedImportance : 'normal'
  const citeAuthor = interaction.options.getString('cite-author') ?? null
  const imageUrl = interaction.options.getString('image-url') ?? null

  const colors = {
    info: 0x699BF5,
    critical: 0x1E1E24,
    normal: 0x57F287,
    medium: 0xFEE75C,
    high: 0xED4245,
  }

  const messageTitles = {
    info: '🔵 Інформація',
    critical: '⚫ Критично',
    normal: '🟢 Звичайний',
    medium: '🟡 Середній',
    high: '🔴 Важливо',
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
    .setTitle(`${note} ${citeAuthor ? `© ${citeAuthor}` : ''}`)
    .setDescription(`📝 ${messageTitles[importance]}`)
    .setImage(imageUrl)
    .addFields(
      {
        name: 'Автор запису',
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

type Importance = 'info' | 'critical' | 'normal' | 'medium' | 'high';

function isImportance(value: string): value is Importance {
  return ['info', 'critical', 'normal', 'medium', 'high'].includes(value);
}

export default { data, execute } satisfies Command;