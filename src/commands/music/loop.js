const { SlashCommandBuilder } = require('discord.js');
const {useQueue, QueueRepeatMode} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Вибрати режим зациклення треків')
  .addNumberOption((option) =>
    option
      .setName('mode')
      .setDescription('Режим зациклення')
      .setRequired(true)
      .addChoices(
        {
          name: 'Вимкнуто',
          value: QueueRepeatMode.OFF,
        },
        {
          name: 'Один трек',
          value: QueueRepeatMode.TRACK,
        },
        {
          name: 'Черга',
          value: QueueRepeatMode.QUEUE,
        },
        {
          name: 'Автоматичний',
          value: QueueRepeatMode.AUTOPLAY,
        },
      )
  )

async function execute(interaction) {
  const queue = useQueue()

  if (!queue) {
    return interaction.reply('На цьому сервері немає черги треків')
  }

  const loopMode = interaction.options.getNumber('mode')
  queue.setRepeatMode(loopMode)
  return interaction.reply(`Режим зациклення встановлено на ${QueueRepeatMode[loopMode]}`)
}

module.exports = { data, execute };