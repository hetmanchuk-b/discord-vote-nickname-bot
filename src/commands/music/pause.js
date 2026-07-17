const { SlashCommandBuilder } = require('discord.js');
const {useTimeline} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Поставити паузу')

async function execute(interaction) {
  const timeline = useTimeline()
  if (!timeline) {
    return interaction.reply('Зараз нічого не грає')
  }

  const wasPaused = timeline.paused

  wasPaused ? timeline.resume() : timeline.pause()

  return interaction.reply(
    `Плеєр зараз ${wasPaused ? 'грає' : 'на паузі'}.`,
  )
}

module.exports = { data, execute };