const { SlashCommandBuilder } = require('discord.js');
const {useQueue} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Показати чергу')

async function execute(interaction) {
  const queue = useQueue()

  if (!queue) {
    return interaction.reply('На цьому сервері немає черги треків')
  }

  const currentTrack = queue.currentTrack
  const upcomingTracks = queue.tracks.toArray().slice(0, 5)

  const message = [
    currentTrack
      ? `**Зараз грає:** ${currentTrack.title} - ${currentTrack.author}`
      : '**Зараз нічого не грає**',
    '',
    '**Наступні треки:**',
    upcomingTracks.length > 0
      ? upcomingTracks
        .map((track, index) => `${index + 1}. ${track.title} - ${track.author}`)
        .join('\n')
      : 'Немає наступних треків',
  ].join('\n');

  return interaction.reply(message);
}

module.exports = { data, execute };