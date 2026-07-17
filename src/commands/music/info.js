const { SlashCommandBuilder } = require('discord.js');
const {useQueue} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Показати інформацію про трек який зараз грає')

async function execute(interaction) {
  const queue = useQueue()

  if (!queue) return await interaction.reply('В черзі немає треків')

  const currentSong = queue.currentTrack

  if (!currentSong) return interaction.reply('Зараз нічого не грає')

  return interaction.reply(`Зараз грає: ${currentSong.title}`)
}

module.exports = { data, execute };