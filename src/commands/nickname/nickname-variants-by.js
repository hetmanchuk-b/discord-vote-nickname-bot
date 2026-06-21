const {SlashCommandBuilder} = require("discord.js");
const fetchAllVariants = require("../../utils/fetch-all-variants.js");
const groupMessages = require("../../utils/group-messages.js");
const {MAX_VARIANTS_PER_USER} = require("../../utils/constants.js");

const data = new SlashCommandBuilder()
  .setName('nickname-variants-by')
  .setDescription('Показати варіанти по користувачах')

module.exports = {
  data,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.channel.isThread()) {
      return interaction.reply('Команду можна використовувати тільки в гілках')
    }

    await interaction.deferReply()

    try {
      const allMessages = await fetchAllVariants(interaction.channel)
      const grouped = groupMessages(allMessages)

      const output = [...grouped.entries()]
        .map(([user, variants]) => {
          return `
${variants.length > MAX_VARIANTS_PER_USER ? '(_дег._) ' : ''}**${user} (${variants.length})**: ${variants.join(', ')}
          `
        })
        .join('\n')

      await interaction.editReply(output || 'Варіанти не знайдено')
    } catch (error) {
      console.error(error)
      await interaction.editReply("❌ Помилка при отриманні варіантів.");
    }
  }
}