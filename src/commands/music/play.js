const { SlashCommandBuilder, PermissionsBitField} = require('discord.js');
const {useMainPlayer} = require('discord-player')

const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Слухати музику з SoundCloud в голосовому каналі")
  .addStringOption((option) =>
    option
      .setName("song")
      .setDescription('URL трека')
      .setRequired(true)
  )

async function execute(interaction) {
  const player = useMainPlayer()
  const query = interaction.options.getString("song", true)

  const voiceChannel = interaction.member.voice.channel

  if (!voiceChannel) {
    return interaction.reply("Потрібно знаходитись в голосовому каналі")
  }

  if (
    interaction.guild.members.me.voice.channel &&
    interaction.guild.members.me.voice.channel !== voiceChannel
  ) {
    return interaction.reply('Музика вже грає в іншому каналі')
  }

  if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.Connect)) {
    return interaction.reply('Немає дозволу для приєднання в голосовий канал')
  }

  if (!interaction.guild.members.me.permissionsIn(voiceChannel).has(PermissionsBitField.Flags.Speak)) {
    return interaction.reply('Бот не має дозволу говорити в цьому голосовому каналі')
  }

  try {
    const result = await player.play(voiceChannel, query, {
      nodeOptions: {
        metadata: {channel: interaction.channel}
      }
    })

    // console.log({
    //   title: result.track.title,
    //   duration: result.track.duration,
    //   durationMS: result.track.durationMS,
    //   source: result.track.source,
    //   url: result.track.url,
    //   live: result.track.live
    // });

    return interaction.reply(`${result.track.title} додано до черги`)
  } catch (error) {
    console.error(error)
    return interaction.reply('Сталася помилка під час запуску трека')
  }

}

module.exports = { data, execute };