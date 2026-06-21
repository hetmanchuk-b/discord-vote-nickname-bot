const {SlashCommandBuilder} = require("discord.js");
const fetchAllVariants = require("../../utils/fetch-all-variants.js");

const data = new SlashCommandBuilder()
  .setName("nickname-variants")
  .setDescription("Показати всі варіанти")

module.exports = {
  data,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.channel.isThread()) {
      return interaction.reply("Команду можна використовувати тільки в гілках")
    }
    await interaction.deferReply()

    try {
      const allMessages = await fetchAllVariants(interaction.channel)
      await interaction.editReply(`Всі варіанти: \n${allMessages.map(m => m.content).join(', ')}`)
    } catch (error) {
      console.error(error)
      await interaction.editReply('❌ Помилка при отриманні варіантів.')
    }

  }
}