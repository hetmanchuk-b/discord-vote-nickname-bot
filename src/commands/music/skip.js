const { SlashCommandBuilder } = require('discord.js');
const {useQueue} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Пропустити трек')

async function execute(interaction) {
  const queue = useQueue()
  if (!queue || !queue.isPlaying()) return interaction.reply('Зараз нічого не грає')

  queue.node.skip()
  return interaction.reply('Трек скіпнуто')
}

module.exports = { data, execute };