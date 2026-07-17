const { SlashCommandBuilder } = require('discord.js');
const {useQueue} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Перемішати треки в черзі')

async function execute(interaction) {
  const queue = useQueue()

  if (!queue) {
    return interaction.reply('На цьому сервері немає черги треків')
  }

  if (queue.tracks.size < 2) {
    return interaction.reply('В черзі зараз недостаньо треків щоб перемішати')
  }

  queue.tracks.shuffle()

  return interaction.reply(`Перемішано ${queue.tracks.size} треків`)
}

module.exports = { data, execute };