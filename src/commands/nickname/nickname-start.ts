import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { Command } from '../../types.js';

const data = new SlashCommandBuilder()
  .setName('nickname-start')
  .setDescription('Почати голосування на вибір нікнейма.')
  .addUserOption((option) => {
    return option.setName('target').setDescription('Кому обирати нікнейм?').setRequired(true)
  })

export default {
  data,
  async execute(interaction) {
    const guild = interaction.guild
    if (!guild) {
      return interaction.reply({
        content: '❌ Команда доступна лише на сервері',
        flags: MessageFlags.Ephemeral
      })
    }
    if (interaction.channel?.isThread()) {
      return interaction.reply({
        content: "❌ Команда недоступна в гілках",
        flags: MessageFlags.Ephemeral
      })
    }
    const target = interaction.options.getUser('target', true)
    const channel = interaction.channel
    if (!channel || !('threads' in channel)) {
      return interaction.reply({
        content: '❌ Команда доступна лише в текстовому каналі'
      })
    }

    try {
      const newThread = await channel.threads.create({
        name: `Нікнейм для ${target.displayName}`,
        autoArchiveDuration: 4320,
        // type: ChannelType.GuildText,
        reason: 'Nickname voting'
      })

      await newThread.send({
        content: `
Обираємо новий нікнейм для <@${target.id}>

Правила:
- 1 повідомлення = 1 варіант
- До 32 символів
- Без емоджі
- Без негативу
- Кожна реакція збільшує шанс варіанта потрапити до фіналу (❁´◡\`❁)

Пишіть варінти нижче.
        `
      })
      const infoMessage = await newThread.send({
        content: `USER_ID:${target.id}`
      })
      await infoMessage.pin()
    } catch (error) {
      console.error('Error creating channel', error)
    }

    await interaction.reply(`Обираємо нікнейм для <@${target.id}>`)
  }
} satisfies Command;