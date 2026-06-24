const { SlashCommandBuilder, MessageFlags} = require('discord.js');
const fetchAllVariants = require('../../utils/fetch-all-variants.js');
const getUniqueVariants = require('../../utils/get-unique-variants.js');
const {buildButtons, renderContent} = require('../../utils/shuffle-session.js');

const data = new SlashCommandBuilder()
  .setName('nickname-end')
  .setDescription('Дістати випадковий варіант')

async function execute(interaction) {
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
    const variants = getUniqueVariants(messages)

    if (variants.length < 2) return interaction.editReply('❌ Потрібно щонайменше 2 варіанта.')

    const reply = await interaction.editReply({
      content: renderContent([]),
      components: buildButtons(0),
      fetchReply: true
    })

    interaction.client.shuffleSessions.set(reply.id, {
      availableVariants: [...variants],
      selectedVariants: [],
      threadId: interaction.channel.id,
    })

  } catch (error) {
    console.error(error)
    await interaction.editReply('❌ Помилка')
  }
}

module.exports = {data, execute}
