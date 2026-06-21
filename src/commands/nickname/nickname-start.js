const {SlashCommandBuilder, PermissionFlagsBits, MessageFlags} = require("discord.js");
const {MAX_VARIANTS_PER_USER} = require("../../utils/constants.js");

const data = new SlashCommandBuilder()
  .setName('nickname-start')
  .setDescription('Почати голосування на вибір нікнейма.')
  .addUserOption((option) => {
    return option.setName('target').setDescription('Кому обирати нікнейм?').setRequired(true)
  })
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)

module.exports = {
  data,
  async execute(interaction) {
    const guild = interaction.guild
    if (!guild) {
      return interaction.reply({
        content: 'Команда доступна лише на сервері',
        flags: MessageFlags.Ephemeral
      })
    }
    const target = interaction.options.getUser('target')
    const channel = interaction.channel
    if (!channel.isTextBased()) {
      return interaction.reply({
        content: 'Не текстовий канал'
      })
    }

    try {
      const newThread = await channel.threads.create({
        name: `${target.username}\'s nickname`,
        autoArchiveDuration: 4320,
        // type: ChannelType.GuildText,
        reason: 'Nickname voting'
      })
      console.log(`Thread channel ${newThread.name}`)

      await newThread.send({
        content: `
Обираємо новий нікнейм для <@${target.id}>

Правила:
- 1 повідомлення = 1 варіант
- Не більше ${MAX_VARIANTS_PER_USER} варіантів від одного
- До 32 символів
- Без емоджі
- Без негативу

Пишіть варінти нижче.
        `
      })
    } catch (error) {
      console.error('Error creating channel', error)
    }

    await interaction.reply(`Обираємо нікнейм для <@${target.id}>`)
  }
}