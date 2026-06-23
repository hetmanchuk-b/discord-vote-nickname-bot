const {SlashCommandBuilder, MessageFlags} = require("discord.js")
const fetchAllVariants = require("../../utils/fetch-all-variants.js")
const shuffle = require("../../utils/shuffle.js")
const {FINALISTS_COUNT} = require("../../utils/constants.js")

const data = new SlashCommandBuilder()
  .setName('nickname-end')
  .setDescription('Завершити збір варіантів та створити голосування.')

module.exports = {
  data,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return

    if (!interaction.channel.isThread()) {
      return interaction.reply({
        content: '❌ Команду можна використовувати тільки в гілках',
        flags: MessageFlags.Ephemeral
      })
    }

    await interaction.deferReply()

    try {
      const messages = await fetchAllVariants(interaction.channel)
      const variants = [...new Set(messages.map(m => m.content.trim()).filter(Boolean))]

      if (variants.length < 2) {
        return interaction.editReply('❌ Потрібно щонайменше 2 варіанти для голосування.')
      }

      const finalists = shuffle([...variants]).slice(0, Math.min(FINALISTS_COUNT, variants.length))

      await interaction.channel.send({
        poll: {
          question: {
            text: '🏆 Оберіть найкращий варіант нікнейму'
          },
          answers: finalists.map(variant => ({text: variant})),
          allowMultiselect: false,
          duration: 24
        }
      })

      await interaction.editReply(
        [
          "✅ Голосування створено",
          "",
          "Фіналісти:",
          ...finalists.map(v => `• ${v}`)
        ].join("\n")
      )
      await interaction.channel.setLocked(true)
    } catch (error) {
      console.error(error)

      await interaction.editReply('❌ Помилка при створенні голосування.')
    }
  }
}